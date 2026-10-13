import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  MAX_HOOK_MATCHER_LENGTH,
  MAX_HOOK_TIMEOUT_SECONDS,
  isValidHookMatcher,
  resolveHooks,
  type HooksConfig,
} from '../hooks/definitions.js';
import { parseMcpServers, type McpServerConfig } from '../mcp/config.js';
import { parseLeniently } from './validation.js';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** One hook: a shell command, with a timeout in seconds. */
const HookSchema = z.looseObject({
  command: z.string().refine((value) => value.trim() !== '', 'must not be empty'),
  timeout: z.number().positive().max(MAX_HOOK_TIMEOUT_SECONDS).optional(),
});

/** A hook of a tool event: `matcher` is a regular expression for the tool name. */
const ToolHookSchema = z.looseObject({
  ...HookSchema.shape,
  matcher: z
    .string()
    .refine(
      isValidHookMatcher,
      `must be a valid regular expression of at most ${MAX_HOOK_MATCHER_LENGTH} characters`,
    )
    .optional(),
});

/** Schema of ~/.patch/config.json. Unknown keys are tolerated (with a warning) for forward compat. */
export const ConfigFileSchema = z.looseObject({
  /** Default model id, e.g. "claude-opus-5-5". */
  model: z.string().min(1).optional(),
  /** Reasoning effort for models that support it. */
  effort: z.enum(EFFORT_LEVELS).optional(),
  anthropic: z
    .looseObject({
      apiKey: z.string().min(1).optional(),
      baseUrl: z.string().url().optional(),
      /** Workspace for API keys that belong to a whole organization ("wrkspc_..."). */
      workspaceId: z.string().min(1).optional(),
    })
    .optional(),
  permissions: z
    .looseObject({
      /** Rules such as "edit" or "bash:pnpm test". */
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  /** Absolute path of the shell used for commands (overrides detection). */
  shell: z.string().min(1).optional(),
  /** Automatically compact when the context window is nearly full. Default true. */
  autoCompact: z.boolean().optional(),
  /** Safety limit on model round-trips per user message. Default 200. */
  maxStepsPerTurn: z.number().int().positive().max(10_000).optional(),
  /**
   * Shell commands run on agent events (see hooks/definitions.ts). Only this file, the user's
   * own configuration, can define them: nothing in a repository runs commands on its own.
   */
  hooks: z
    .looseObject({
      PreToolUse: z.array(ToolHookSchema).optional(),
      PostToolUse: z.array(ToolHookSchema).optional(),
      UserPromptSubmit: z.array(HookSchema).optional(),
      Stop: z.array(HookSchema).optional(),
      SessionStart: z.array(HookSchema).optional(),
    })
    .optional(),
  /** Web search and web fetch, run by the model provider. Both default to true. */
  web: z
    .looseObject({
      search: z.boolean().optional(),
      fetch: z.boolean().optional(),
      /** Only these domains (subdomains included), e.g. "docs.python.org". */
      allowedDomains: z.array(z.string().min(1)).optional(),
      /** Never these domains. Cannot be combined with allowedDomains. */
      blockedDomains: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  /**
   * MCP servers the user runs in every project, by name (validated by parseMcpServers). They
   * start without asking; servers from a project's .mcp.json need approval.
   */
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export interface PatchPaths {
  /** ~/.patch (or $PATCH_HOME). */
  home: string;
  /** ~/.patch/config.json */
  configFile: string;
  /** ~/.patch/sessions */
  sessionsDir: string;
  /** ~/.patch/logs */
  logsDir: string;
  /** ~/.patch/PATCH.md — personal instructions applied to every project. */
  userInstructions: string;
  /** ~/.patch/commands — personal custom slash commands (Markdown prompts). */
  commandsDir: string;
  /** ~/.patch/mcp-approvals.json — project MCP servers the user approved for good. */
  mcpApprovals: string;
}

export type ValueSource = 'flag' | 'env' | 'config' | 'default';

/**
 * Web search and web fetch. Decided by the user's config file and environment only (never by
 * repository files), once per process; sessions keep what they started with.
 */
export interface WebConfig {
  search: boolean;
  fetch: boolean;
  /** Normalized domains; at most one of the two lists is non-empty. */
  allowedDomains: string[];
  blockedDomains: string[];
  /** PATCH_NO_WEB turned both off. */
  disabledByEnv: boolean;
}

export interface ResolvedConfig {
  model: string;
  modelSource: ValueSource;
  effort?: Effort;
  effortSource: ValueSource;
  /** Credentials. Never logged. */
  anthropic: {
    apiKey?: string;
    authToken?: string;
    baseUrl?: string;
    /** Sent as anthropic-workspace-id, for keys not scoped to a workspace. */
    workspaceId?: string;
    /** Where the credential came from, for display (never the value). */
    credentialSource?: 'env:ANTHROPIC_API_KEY' | 'env:ANTHROPIC_AUTH_TOKEN' | 'config';
  };
  permissions: { allow: string[]; deny: string[] };
  shell?: string;
  autoCompact: boolean;
  maxStepsPerTurn: number;
  /** Hooks from the user's config file (empty lists when none are configured). */
  hooks: HooksConfig;
  web: WebConfig;
  /** The user's MCP servers (the valid entries of "mcpServers"; empty when none). */
  mcpServers: McpServerConfig[];
  debug: boolean;
  paths: PatchPaths;
  /** Problems found while loading (invalid JSON, unknown keys, bad values). Never fatal. */
  warnings: string[];
}

export interface LoadConfigOptions {
  env: NodeJS.ProcessEnv;
  /** Provider default model, e.g. "claude-opus-5-5". Keeps core provider-agnostic. */
  defaultModel: string;
  flags?: { model?: string; debug?: boolean };
  /** Defaults to os.homedir(). */
  homeDir?: string;
}

const PATCH_DIR_NAME = '.patch';
const DEFAULT_MAX_STEPS_PER_TURN = 200;
/** The config file can hold an API key: keep it private to the user. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes']);
const FALSY_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);
/** A bare domain (ASCII, no scheme, port or wildcard), optionally followed by a path. */
const DOMAIN_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?$/;

/**
 * Resolves Patch's directories. `PATCH_HOME` overrides the base directory (used by tests);
 * otherwise `<home>/.patch` on every platform. A relative `PATCH_HOME` resolves against the
 * current directory; a leading `~` expands to the home directory.
 */
export function resolvePatchPaths(env: NodeJS.ProcessEnv, homeDir?: string): PatchPaths {
  const userHome = homeDir ?? homedir();
  const override = envValue(env, 'PATCH_HOME');
  const home =
    override === undefined
      ? join(userHome, PATCH_DIR_NAME)
      : resolve(expandHome(override, userHome));
  return {
    home,
    configFile: join(home, 'config.json'),
    sessionsDir: join(home, 'sessions'),
    logsDir: join(home, 'logs'),
    userInstructions: join(home, 'PATCH.md'),
    commandsDir: join(home, 'commands'),
    mcpApprovals: join(home, 'mcp-approvals.json'),
  };
}

/**
 * Loads configuration. Precedence (highest first):
 *   model:  --model flag > PATCH_MODEL > config.model > defaultModel
 *   effort: PATCH_EFFORT > config.effort > undefined (provider default)
 *   credentials: ANTHROPIC_API_KEY > ANTHROPIC_AUTH_TOKEN > config.anthropic.apiKey
 *   base URL: ANTHROPIC_BASE_URL > config.anthropic.baseUrl
 *   web: PATCH_NO_WEB (any value but 0/false/no/off) turns search and fetch off > config.web
 *        > on
 *   debug: --debug flag or PATCH_DEBUG in {1,true,yes}
 * A missing config file is normal. An unreadable/invalid file produces a warning and defaults.
 * Never throws for user-caused problems.
 *
 * Environment variables that are empty or whitespace-only count as unset; values are trimmed.
 * Exactly one credential is resolved, so a provider never receives two competing ones.
 */
export function loadConfig(options: LoadConfigOptions): ResolvedConfig {
  const { env, flags = {} } = options;
  const homeDir = options.homeDir ?? homedir();
  const paths = resolvePatchPaths(env, homeDir);
  const warnings: string[] = [];
  const configDisplay = displayPath(paths.configFile, homeDir);
  const file = readConfigFile(paths.configFile, configDisplay, warnings);
  const model = resolveModel(options, file);
  const effort = resolveEffort(env, file, warnings);
  const debugEnv = envValue(env, 'PATCH_DEBUG')?.toLowerCase();
  return {
    model: model.value,
    modelSource: model.source,
    effort: effort.value,
    effortSource: effort.source,
    anthropic: resolveAnthropic(env, file, warnings),
    permissions: { allow: file.permissions?.allow ?? [], deny: file.permissions?.deny ?? [] },
    shell: file.shell,
    autoCompact: file.autoCompact ?? true,
    maxStepsPerTurn: file.maxStepsPerTurn ?? DEFAULT_MAX_STEPS_PER_TURN,
    hooks: resolveHooks(file.hooks),
    web: resolveWeb(env, file, configDisplay, warnings),
    mcpServers: parseMcpServers(
      file.mcpServers,
      { origin: 'user', source: configDisplay },
      warnings,
    ),
    debug: flags.debug === true || (debugEnv !== undefined && TRUTHY_ENV_VALUES.has(debugEnv)),
    paths,
    warnings,
  };
}

/**
 * Writes `model` into ~/.patch/config.json, preserving other keys. Creates the file if needed.
 * Throws an Error with a user-presentable message when the existing file is not a valid JSON
 * object (it is never overwritten then) or cannot be read or written. The file is replaced
 * atomically and is readable by its owner only.
 */
export function saveDefaultModel(paths: PatchPaths, model: string): void {
  const value = model.trim();
  if (value === '') throw new Error('Cannot save the default model: the model id is empty.');
  const display = displayPath(paths.configFile, homedir());
  const config = readConfigForUpdate(paths.configFile, display);
  config.model = value;
  try {
    mkdirSync(dirname(paths.configFile), { recursive: true, mode: DIR_MODE });
    writeFileAtomic(paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
  } catch (error) {
    throw new Error(
      `Cannot save the default model: could not write ${display} (${describeFsError(error)}).`,
      { cause: error },
    );
  }
}

interface Resolved<T> {
  value: T;
  source: ValueSource;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function expandHome(path: string, userHome: string): string {
  if (path === '~') return userHome;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(userHome, path.slice(2));
  return path;
}

function resolveModel(options: LoadConfigOptions, file: ConfigFile): Resolved<string> {
  const fromFlag = options.flags?.model?.trim();
  if (fromFlag) return { value: fromFlag, source: 'flag' };
  const fromEnv = envValue(options.env, 'PATCH_MODEL');
  if (fromEnv !== undefined) return { value: fromEnv, source: 'env' };
  const fromConfig = file.model?.trim();
  if (fromConfig) return { value: fromConfig, source: 'config' };
  return { value: options.defaultModel, source: 'default' };
}

function isEffort(value: string): value is Effort {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

function resolveEffort(
  env: NodeJS.ProcessEnv,
  file: ConfigFile,
  warnings: string[],
): Resolved<Effort | undefined> {
  const fromEnv = envValue(env, 'PATCH_EFFORT');
  if (fromEnv !== undefined) {
    const normalized = fromEnv.toLowerCase();
    if (isEffort(normalized)) return { value: normalized, source: 'env' };
    warnings.push(
      `Ignoring PATCH_EFFORT="${fromEnv}": expected one of ${EFFORT_LEVELS.join(', ')}.`,
    );
  }
  if (file.effort !== undefined) return { value: file.effort, source: 'config' };
  return { value: undefined, source: 'default' };
}

function resolveAnthropic(
  env: NodeJS.ProcessEnv,
  file: ConfigFile,
  warnings: string[],
): ResolvedConfig['anthropic'] {
  const anthropic: ResolvedConfig['anthropic'] = {};
  const apiKey = envValue(env, 'ANTHROPIC_API_KEY');
  const authToken = envValue(env, 'ANTHROPIC_AUTH_TOKEN');
  const configKey = file.anthropic?.apiKey?.trim();
  if (apiKey !== undefined) {
    anthropic.apiKey = apiKey;
    anthropic.credentialSource = 'env:ANTHROPIC_API_KEY';
  } else if (authToken !== undefined) {
    anthropic.authToken = authToken;
    anthropic.credentialSource = 'env:ANTHROPIC_AUTH_TOKEN';
  } else if (configKey) {
    anthropic.apiKey = configKey;
    anthropic.credentialSource = 'config';
  }
  const baseUrl = resolveBaseUrl(env, file, warnings);
  if (baseUrl !== undefined) anthropic.baseUrl = baseUrl;
  const workspaceId =
    envValue(env, 'ANTHROPIC_WORKSPACE_ID') ?? file.anthropic?.workspaceId?.trim();
  if (workspaceId) {
    anthropic.workspaceId = workspaceId;
    if (!/^wrkspc_[A-Za-z0-9]+$/.test(workspaceId)) {
      warnings.push(
        'The Anthropic workspace ID does not look like one (it should start with wrkspc_).',
      );
    }
  }
  return anthropic;
}

function resolveBaseUrl(
  env: NodeJS.ProcessEnv,
  file: ConfigFile,
  warnings: string[],
): string | undefined {
  const fromEnv = envValue(env, 'ANTHROPIC_BASE_URL');
  if (fromEnv !== undefined) {
    if (isHttpUrl(fromEnv)) return fromEnv;
    // The value is not echoed: URLs can embed credentials.
    warnings.push('Ignoring ANTHROPIC_BASE_URL: expected an http:// or https:// URL.');
  }
  return file.anthropic?.baseUrl;
}

/**
 * Web settings. Invalid domain entries are dropped with a warning; an allow list without a usable
 * entry turns web search and fetch off instead of leaving them unrestricted.
 */
function resolveWeb(
  env: NodeJS.ProcessEnv,
  file: ConfigFile,
  source: string,
  warnings: string[],
): WebConfig {
  const noWeb = envValue(env, 'PATCH_NO_WEB')?.toLowerCase();
  const disabledByEnv = noWeb !== undefined && !FALSY_ENV_VALUES.has(noWeb);
  const configured = file.web ?? {};
  const allowedDomains = webDomains(
    configured.allowedDomains,
    'web.allowedDomains',
    source,
    warnings,
  );
  let blockedDomains = webDomains(
    configured.blockedDomains,
    'web.blockedDomains',
    source,
    warnings,
  );
  if (allowedDomains.length > 0 && blockedDomains.length > 0) {
    warnings.push(
      `"web.allowedDomains" and "web.blockedDomains" in ${source} cannot be combined. Using "web.allowedDomains" only.`,
    );
    blockedDomains = [];
  }
  const unusableAllowList =
    (configured.allowedDomains?.length ?? 0) > 0 && allowedDomains.length === 0;
  if (unusableAllowList) {
    warnings.push(
      `"web.allowedDomains" in ${source} has no valid domain. Web search and fetch are off.`,
    );
  }
  const enabled = !disabledByEnv && !unusableAllowList;
  return {
    search: enabled && (configured.search ?? true),
    fetch: enabled && (configured.fetch ?? true),
    allowedDomains,
    blockedDomains,
    disabledByEnv,
  };
}

/** Normalized domains ("https://Docs.Example.com/" → "docs.example.com"), invalid ones dropped. */
function webDomains(
  entries: readonly string[] | undefined,
  setting: string,
  source: string,
  warnings: string[],
): string[] {
  const domains: string[] = [];
  const invalid: number[] = [];
  (entries ?? []).forEach((entry, index) => {
    const domain = entry
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
    if (!DOMAIN_PATTERN.test(domain)) invalid.push(index + 1);
    else if (!domains.includes(domain)) domains.push(domain);
  });
  if (invalid.length > 0) {
    const items = invalid.length === 1 ? 'item' : 'items';
    warnings.push(
      `Invalid ${items} ${invalid.join(', ')} of "${setting}" in ${source}: expected a domain such as "docs.example.com" (no wildcards in the domain). Ignoring ${invalid.length === 1 ? 'it' : 'them'}.`,
    );
  }
  return domains;
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === 'http:' || protocol === 'https:';
}

function readConfigFile(path: string, display: string, warnings: string[]): ConfigFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (!isMissingFileError(error)) {
      warnings.push(`Could not read ${display}: ${describeFsError(error)}. Using defaults.`);
    }
    return {};
  }
  const parsed = parseJsonObject(text);
  if ('error' in parsed) {
    warnings.push(`Could not parse ${display}: ${parsed.error}. Using defaults.`);
    return {};
  }
  return parseLeniently(ConfigFileSchema, parsed.value, display, warnings) ?? {};
}

function readConfigForUpdate(path: string, display: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw new Error(
      `Cannot save the default model: could not read ${display} (${describeFsError(error)}).`,
      { cause: error },
    );
  }
  const parsed = parseJsonObject(text);
  if ('error' in parsed) {
    throw new Error(
      `Cannot save the default model: ${display} is not a valid JSON object (${parsed.error}). ` +
        'Fix or delete the file, then try again.',
    );
  }
  return parsed.value;
}

/** Parses a config document. A blank file is an empty config. */
function parseJsonObject(text: string): { value: Record<string, unknown> } | { error: string } {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === '') return { value: {} };
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    return { error: (error instanceof Error ? error.message : String(error)).replace(/\.$/, '') };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: `expected a JSON object, found ${describeJsonValue(value)}` };
  }
  return { value: value as Record<string, unknown> };
}

function describeJsonValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * Writes via a temporary file and a rename so a crash never leaves a half-written file. The file
 * is readable by its owner only.
 */
export function writeFileAtomic(path: string, content: string): void {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, content, { mode: FILE_MODE, flag: 'wx' });
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The original error is the one worth reporting.
    }
    throw error;
  }
}

/** `~/…` for paths inside the user's home directory, otherwise the path itself. */
function displayPath(path: string, userHome: string): string {
  const rel = relative(userHome, path);
  if (rel === '') return '~';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return path;
  return `~/${rel.split(sep).join('/')}`;
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function describeFsError(error: unknown): string {
  switch ((error as NodeJS.ErrnoException | undefined)?.code) {
    case 'EACCES':
    case 'EPERM':
      return 'permission denied';
    case 'EISDIR':
      return 'it is a directory';
    case 'EROFS':
      return 'the file system is read-only';
    case 'ENOSPC':
      return 'no space left on the device';
    default:
      return error instanceof Error ? error.message : String(error);
  }
}
