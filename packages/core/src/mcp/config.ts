import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describeFsError, isMissingError } from '../fs/fs-errors.js';

/**
 * MCP server definitions, in the shapes Claude Code uses:
 *
 *   { "<name>": { "command": "npx", "args": ["-y", "pkg"], "env": { ... } } }       stdio
 *   { "<name>": { "type": "http", "url": "https://...", "headers": { ... } } }      streamable HTTP
 *
 * They come from "mcpServers" in ~/.patch/config.json (the user's own servers) and in .mcp.json
 * at the project root (servers a repository proposes; they need the user's approval before
 * anything starts). Values are used as written: `${VAR}` placeholders are not expanded.
 *
 * Environment variables and headers often hold credentials: problems name their keys, never
 * their values, and nothing here logs or displays a value.
 */

/** Server names become part of tool names (mcp__<server>__<tool>) and permission rules. */
export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;
/** The project's MCP configuration, at the project root. */
export const PROJECT_MCP_FILE = '.mcp.json';
/** Largest .mcp.json read; a larger file is skipped with a warning. */
const MAX_PROJECT_FILE_BYTES = 1024 * 1024;
/** Characters of an invalid server name quoted in a warning. */
const MAX_QUOTED_NAME_CHARS = 60;

const STDIO_KEYS = new Set(['type', 'command', 'args', 'env']);
const HTTP_KEYS = new Set(['type', 'url', 'headers']);

/** Where a definition came from: the user's configuration or the project's .mcp.json. */
export type McpServerOrigin = 'user' | 'project';

interface McpServerBase {
  name: string;
  origin: McpServerOrigin;
}

export interface McpStdioServer extends McpServerBase {
  transport: 'stdio';
  command: string;
  args: string[];
  /** Added to the minimal environment servers get (see McpStdioTransport). */
  env: Record<string, string>;
}

export interface McpHttpServer extends McpServerBase {
  transport: 'http';
  url: string;
  headers: Record<string, string>;
}

export type McpServerConfig = McpStdioServer | McpHttpServer;

export interface ParseMcpServersOptions {
  origin: McpServerOrigin;
  /** The file for messages, e.g. "~/.patch/config.json" or ".mcp.json". */
  source: string;
}

/**
 * Validates an "mcpServers" object. Invalid entries are skipped with a warning (unknown keys only
 * warn); the valid ones are returned in the order they appear. Never throws.
 */
export function parseMcpServers(
  raw: unknown,
  options: ParseMcpServersOptions,
  warnings: string[],
): McpServerConfig[] {
  if (raw === undefined) return [];
  const { source } = options;
  if (!isRecord(raw)) {
    warnings.push(`"mcpServers" in ${source} must be an object of servers. Ignoring it.`);
    return [];
  }
  const servers: McpServerConfig[] = [];
  for (const [name, entry] of Object.entries(raw)) {
    if (!MCP_SERVER_NAME.test(name)) {
      warnings.push(
        `Invalid MCP server name ${quoteName(name)} in ${source}: use letters, digits, "_" and "-". Skipping it.`,
      );
      continue;
    }
    const parsed = parseServer(name, entry, options);
    if ('problem' in parsed) {
      warnings.push(`MCP server "${name}" in ${source}: ${parsed.problem}. Skipping it.`);
      continue;
    }
    for (const note of parsed.notes) warnings.push(`MCP server "${name}" in ${source}: ${note}.`);
    servers.push(parsed.server);
  }
  return servers;
}

type ParsedServer = { server: McpServerConfig; notes: string[] } | { problem: string };

function parseServer(name: string, entry: unknown, options: ParseMcpServersOptions): ParsedServer {
  if (!isRecord(entry)) return { problem: 'expected an object' };
  const type = entry['type'];
  if (type !== undefined && type !== 'stdio' && type !== 'http') {
    if (type === 'sse') {
      return {
        problem: 'the "sse" transport is not supported; use "type": "http" (streamable HTTP)',
      };
    }
    return { problem: '"type" must be "stdio" or "http"' };
  }
  // Without a type, a "url" and no "command" means HTTP, as in Claude Code.
  const transport: 'stdio' | 'http' =
    type === 'stdio' || type === 'http'
      ? type
      : entry['url'] !== undefined && entry['command'] === undefined
        ? 'http'
        : 'stdio';
  const known = transport === 'stdio' ? STDIO_KEYS : HTTP_KEYS;
  const notes = Object.keys(entry)
    .filter((key) => !known.has(key))
    .map((key) => `ignoring unknown setting "${key}"`);
  const base = { name, origin: options.origin };

  if (transport === 'http') {
    const url = entry['url'];
    // The URL is not echoed: it can embed credentials.
    if (typeof url !== 'string' || !isHttpUrl(url.trim())) {
      return { problem: '"url" must be an http:// or https:// URL' };
    }
    const headers = stringMap(entry['headers'], 'headers');
    if ('problem' in headers) return headers;
    const server: McpHttpServer = {
      ...base,
      transport: 'http',
      url: url.trim(),
      headers: headers.map,
    };
    return { server, notes: [...notes, ...placeholderNotes(server)] };
  }

  const command = entry['command'];
  if (typeof command !== 'string' || command.trim() === '') {
    return { problem: '"command" must be a non-empty string' };
  }
  const args = entry['args'] ?? [];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    return { problem: '"args" must be a list of strings' };
  }
  const env = stringMap(entry['env'], 'env');
  if ('problem' in env) return env;
  const server: McpStdioServer = {
    ...base,
    transport: 'stdio',
    command: command.trim(),
    args: args as string[],
    env: env.map,
  };
  return { server, notes: [...notes, ...placeholderNotes(server)] };
}

/** An object of string values (env, headers). Problems name the key, never the value. */
function stringMap(
  value: unknown,
  setting: string,
): { map: Record<string, string> } | { problem: string } {
  if (value === undefined) return { map: {} };
  if (!isRecord(value)) return { problem: `"${setting}" must be an object of strings` };
  const map: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      return { problem: `"${setting}.${key}" must be a string` };
    }
    map[key] = item;
  }
  return { map };
}

/** Patch does not expand `${VAR}` (a repository could otherwise read the user's environment). */
function placeholderNotes(server: McpServerConfig): string[] {
  const values =
    server.transport === 'stdio'
      ? [server.command, ...server.args, ...Object.values(server.env)]
      : [server.url, ...Object.values(server.headers)];
  return values.some((value) => /\$\{[^}]*\}/.test(value))
    ? ['${...} placeholders are not expanded; the values are used as written']
    : [];
}

export interface LoadProjectMcpServersResult {
  servers: McpServerConfig[];
  /** The file, when it exists. */
  file?: string;
}

/**
 * Reads the project's .mcp.json (`{ "mcpServers": { ... } }`). A missing file means no servers;
 * an unreadable or invalid one adds a warning. Never throws. Nothing in it starts until the user
 * approves it (see McpApprovalStore).
 */
export function loadProjectMcpServers(
  projectRoot: string,
  warnings: string[],
): LoadProjectMcpServersResult {
  const file = path.join(projectRoot, PROJECT_MCP_FILE);
  let text: string;
  try {
    const stats = statSync(file);
    if (!stats.isFile()) {
      warnings.push(`${PROJECT_MCP_FILE} is not a regular file. Ignoring it.`);
      return { servers: [], file };
    }
    if (stats.size > MAX_PROJECT_FILE_BYTES) {
      warnings.push(`${PROJECT_MCP_FILE} is larger than 1 MB. Ignoring it.`);
      return { servers: [], file };
    }
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (!isMissingError(error)) {
      warnings.push(`Could not read ${PROJECT_MCP_FILE}: ${describeFsError(error)}.`);
    }
    return { servers: [] };
  }
  let value: unknown;
  try {
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    value = body.trim() === '' ? {} : JSON.parse(body);
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');
    warnings.push(`Could not parse ${PROJECT_MCP_FILE}: ${reason}. Ignoring it.`);
    return { servers: [], file };
  }
  if (!isRecord(value)) {
    warnings.push(`${PROJECT_MCP_FILE} must be a JSON object. Ignoring it.`);
    return { servers: [], file };
  }
  const servers = parseMcpServers(
    value['mcpServers'],
    { origin: 'project', source: PROJECT_MCP_FILE },
    warnings,
  );
  return { servers, file };
}

/**
 * Combines the user's servers with the project's. A project server named like one of the user's
 * is left out (with a warning): names carry permission rules ("mcp:<server>"), so a repository
 * must never stand in for a server the user configured.
 */
export function mergeMcpServers(
  user: readonly McpServerConfig[],
  project: readonly McpServerConfig[],
  warnings: string[],
): McpServerConfig[] {
  const names = new Set(user.map((server) => server.name));
  const merged = [...user];
  for (const server of project) {
    if (names.has(server.name)) {
      warnings.push(
        `The MCP server "${server.name}" in ${PROJECT_MCP_FILE} has the name of one in your configuration; using yours.`,
      );
      continue;
    }
    names.add(server.name);
    merged.push(server);
  }
  return merged;
}

/**
 * The server as shown to the user: its command line, or its URL without credentials, query or
 * fragment. Never environment variables or headers.
 */
export function describeMcpServer(server: McpServerConfig): string {
  if (server.transport === 'http') return displayUrl(server.url);
  return [server.command, ...server.args].map(quoteArgument).join(' ');
}

/** "https://host/path", with "?…" when the URL has a query (which may hold a token). */
export function displayUrl(url: string): string {
  if (!URL.canParse(url)) return '(invalid URL)';
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search ? '?…' : ''}`;
}

/**
 * A digest of everything that defines what a server runs or where it connects (including env and
 * header values), for remembered approvals: any change asks again. Only the digest is stored.
 */
export function mcpServerFingerprint(server: McpServerConfig): string {
  const definition =
    server.transport === 'stdio'
      ? { transport: 'stdio', command: server.command, args: server.args, env: sorted(server.env) }
      : { transport: 'http', url: server.url, headers: sorted(server.headers) };
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

/**
 * Removes what may be secret in a server's definition from `text` (an error message or the
 * server's own output), for display and logs: the values of its environment variables and
 * headers (and the token after "Bearer " and the like), and the credentials and query values of
 * its URL.
 */
export function redactServerSecrets(server: McpServerConfig, text: string): string {
  const secrets = new Set<string>();
  const add = (value: string, minLength: number) => {
    if (value.length >= minLength) secrets.add(value);
  };
  const values = Object.values(server.transport === 'stdio' ? server.env : server.headers);
  for (const value of values) {
    add(value, 4);
    for (const part of value.split(/\s+/)) add(part, 8);
  }
  if (server.transport === 'http' && URL.canParse(server.url)) {
    const url = new URL(server.url);
    add(url.password, 4);
    try {
      add(decodeURIComponent(url.password), 4);
    } catch {
      // Not valid percent-encoding: the raw form is redacted already.
    }
    for (const value of url.searchParams.values()) add(value, 4);
  }
  let result = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join('[REDACTED]');
  }
  return result;
}

function sorted(map: Record<string, string>): Array<[string, string]> {
  return Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Quotes arguments with spaces or quotes, for display only. */
function quoteArgument(arg: string): string {
  return arg === '' || /[\s"']/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function quoteName(name: string): string {
  const shown =
    name.length > MAX_QUOTED_NAME_CHARS ? `${name.slice(0, MAX_QUOTED_NAME_CHARS)}…` : name;
  return JSON.stringify(shown);
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === 'http:' || protocol === 'https:';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
