import { oneLine, truncateMiddle } from '@patch/shared';
import type { Logger } from '../logging/logger.js';
import { HOOK_OUTPUT_TAG } from '../session/schema.js';
import { runCommand, type CommandResult } from '../shell/process.js';
import type { ShellInfo } from '../shell/shell.js';
import {
  TOOL_HOOK_EVENTS,
  compileHookMatcher,
  type HookDefinition,
  type HookEvent,
  type HooksConfig,
} from './definitions.js';

/** Characters of a hook's stdout kept as context for the model. */
const MAX_OUTPUT_CHARS = 10_000;
/** Characters of a blocking hook's stderr passed on to the model or the user. */
const MAX_MESSAGE_CHARS = 4_000;
/** Bytes of each output stream retained while a hook runs. */
const MAX_BUFFER_BYTES = 1024 * 1024;
/** Characters of output written to the debug log per stream. */
const MAX_LOGGED_CHARS = 2_000;
/** Longest tool name matched against a matcher (tool names are short identifiers). */
const MAX_TOOL_NAME_CHARS = 128;

export interface HookRunnerOptions {
  hooks: HooksConfig;
  shell: ShellInfo;
  /** Hooks run in this directory, which is also PATCH_PROJECT_DIR. */
  projectRoot: string;
  /** The directory Patch was started in (`cwd` in the event). */
  cwd: string;
  logger: Logger;
}

export interface HookToolCall {
  name: string;
  /** The validated tool input. */
  input: unknown;
  /** Absolute path of the file a file tool works on (PATCH_FILE). */
  file?: string;
}

export interface HookInvocation {
  event: HookEvent;
  sessionId: string;
  /** Stops the running hook (its process tree is killed) and skips the remaining ones. */
  signal: AbortSignal;
  /** Tool events: the call. Hooks whose matcher does not match its name do not run. */
  tool?: HookToolCall;
  /** Event-specific fields of the JSON event (`prompt`, `source`, `outcome`, ...). */
  fields?: Record<string, unknown>;
}

export interface HookFailure {
  hook: HookDefinition;
  /** "exit 1", "timed out after 60s", "Could not start shell ...". */
  reason: string;
  /** First line of the hook's output, if any. */
  detail?: string;
}

export interface HookRunResult {
  /**
   * A hook exited with code 2: its stderr (trimmed, possibly empty). Later hooks of the event
   * did not run.
   */
  blocked?: { hook: HookDefinition; message: string };
  /** Trimmed, non-empty stdout of the hooks that exited with code 0, in order. */
  outputs: string[];
  /** Hooks that exited with another code, timed out, or could not start. */
  failures: HookFailure[];
  /** The signal fired: the running hook was stopped and later ones skipped. */
  aborted: boolean;
}

type HookOutcome =
  | { type: 'ok'; output: string }
  | { type: 'blocked'; message: string }
  | { type: 'failed'; failure: HookFailure }
  | { type: 'aborted' };

/**
 * Runs the user's hooks: shell commands configured in ~/.patch/config.json for agent events.
 * Each hook runs through runCommand (the shell the bash tool uses, the process tree killed on
 * timeout or abort) in the project root, one after the other in configuration order. It reads
 * the event as one JSON object on stdin (`event`, `sessionId`, `cwd`, `projectDir`; for tool
 * events `tool`, `input` and `file`; plus event-specific fields) and gets PATCH_HOOK_EVENT,
 * PATCH_TOOL_NAME, PATCH_FILE and PATCH_PROJECT_DIR in its environment.
 *
 * Exit code 0 continues (stdout is collected), 2 blocks (stderr says why; later hooks are
 * skipped), anything else, a timeout or a failure to start is reported as a failure and the
 * remaining hooks still run. What a block means depends on the event; callers decide. Hooks never
 * take part in permission decisions.
 */
export class HookRunner {
  private readonly options: HookRunnerOptions;
  private readonly logger: Logger;
  /** Matcher results by hook and tool name (tool names are a small, fixed set). */
  private readonly matchCache = new Map<HookDefinition, Map<string, boolean>>();

  constructor(options: HookRunnerOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  /** The configured hooks. */
  get hooks(): HooksConfig {
    return this.options.hooks;
  }

  /** The hooks that run for `event` (for tool events, those whose matcher matches `toolName`). */
  hooksFor(event: HookEvent, toolName = ''): HookDefinition[] {
    const hooks = this.options.hooks[event];
    if (!TOOL_HOOK_EVENTS.includes(event)) return [...hooks];
    return hooks.filter((hook) => this.matches(hook, toolName));
  }

  /** True when at least one hook runs for `event` (and `toolName`, for tool events). */
  has(event: HookEvent, toolName?: string): boolean {
    return this.hooksFor(event, toolName).length > 0;
  }

  /** Runs the hooks of an event. Never throws. */
  async run(invocation: HookInvocation): Promise<HookRunResult> {
    const result: HookRunResult = { outputs: [], failures: [], aborted: false };
    const hooks = this.hooksFor(invocation.event, invocation.tool?.name);
    if (hooks.length === 0) return result;
    const input = JSON.stringify(this.payload(invocation));
    const env = this.environment(invocation);
    for (const hook of hooks) {
      const outcome = invocation.signal.aborted
        ? ({ type: 'aborted' } as const)
        : await this.runHook(hook, input, env, invocation.signal);
      switch (outcome.type) {
        case 'ok':
          if (outcome.output !== '') result.outputs.push(outcome.output);
          break;
        case 'failed':
          result.failures.push(outcome.failure);
          break;
        case 'blocked':
          result.blocked = { hook, message: outcome.message };
          return result;
        case 'aborted':
          result.aborted = true;
          return result;
      }
    }
    return result;
  }

  private matches(hook: HookDefinition, toolName: string): boolean {
    if (hook.matcher === undefined) return true;
    let cache = this.matchCache.get(hook);
    if (!cache) {
      cache = new Map();
      this.matchCache.set(hook, cache);
    }
    const cached = cache.get(toolName);
    if (cached !== undefined) return cached;
    const matched =
      toolName.length <= MAX_TOOL_NAME_CHARS &&
      (compileHookMatcher(hook.matcher)?.test(toolName) ?? false);
    cache.set(toolName, matched);
    return matched;
  }

  private payload(invocation: HookInvocation): Record<string, unknown> {
    const { tool } = invocation;
    return {
      event: invocation.event,
      sessionId: invocation.sessionId,
      cwd: this.options.cwd,
      projectDir: this.options.projectRoot,
      ...(tool
        ? { tool: tool.name, input: tool.input, ...(tool.file ? { file: tool.file } : {}) }
        : {}),
      ...invocation.fields,
    };
  }

  private environment(invocation: HookInvocation): Record<string, string> {
    // Always set, so values inherited from Patch's own environment never leak into a hook.
    return {
      PATCH_HOOK_EVENT: invocation.event,
      PATCH_TOOL_NAME: invocation.tool?.name ?? '',
      PATCH_FILE: invocation.tool?.file ?? '',
      PATCH_PROJECT_DIR: this.options.projectRoot,
    };
  }

  private async runHook(
    hook: HookDefinition,
    input: string,
    env: Record<string, string>,
    signal: AbortSignal,
  ): Promise<HookOutcome> {
    let result: CommandResult;
    try {
      result = await runCommand(hook.command, {
        shell: this.options.shell,
        cwd: this.options.projectRoot,
        timeoutMs: hook.timeoutMs,
        signal,
        env,
        input,
        maxBufferBytes: MAX_BUFFER_BYTES,
      });
    } catch (error) {
      this.logger.warn(`${hook.event} hook could not start`, error);
      return { type: 'failed', failure: { hook, reason: messageOf(error) } };
    }
    this.logger.debug(`${hook.event} hook finished`, {
      command: oneLine(hook.command, 200),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      aborted: result.aborted,
      durationMs: result.durationMs,
      stdout: capped(result.stdout, MAX_LOGGED_CHARS),
      stderr: capped(result.stderr, MAX_LOGGED_CHARS),
    });
    if (result.aborted) return { type: 'aborted' };
    if (result.timedOut) {
      const seconds = Math.round(hook.timeoutMs / 100) / 10;
      return { type: 'failed', failure: { hook, reason: `timed out after ${seconds}s` } };
    }
    if (result.exitCode === 0) {
      return { type: 'ok', output: capped(result.stdout, MAX_OUTPUT_CHARS) };
    }
    if (result.exitCode === 2) {
      return { type: 'blocked', message: capped(result.stderr, MAX_MESSAGE_CHARS) };
    }
    const detail = firstLine(result.stderr) ?? firstLine(result.stdout);
    return {
      type: 'failed',
      failure: {
        hook,
        reason: result.exitCode === null ? 'terminated' : `exit ${result.exitCode}`,
        ...(detail ? { detail } : {}),
      },
    };
  }
}

/**
 * Text for a hook that failed, e.g. `PostToolUse hook failed (exit 1): pnpm prettier --write …`,
 * with the first line of its output as the hint.
 */
export function describeHookFailure(failure: HookFailure): { text: string; hint?: string } {
  const { hook, reason, detail } = failure;
  return {
    text: `${hook.event} hook failed (${reason}): ${oneLine(hook.command, 80)}`,
    ...(detail ? { hint: detail } : {}),
  };
}

/**
 * Hook output for the model, as a note of the user's turn (see UserTurn.notes) or a message of
 * its own: `<hook-output event="...">`, a line saying what it is, then the text.
 */
export function formatHookOutput(event: HookEvent, intro: string, text: string): string {
  return [`${HOOK_OUTPUT_TAG} event="${event}">`, intro, text, '</hook-output>'].join('\n');
}

function capped(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return truncateMiddle(trimmed, { maxLines: Number.MAX_SAFE_INTEGER, maxChars }).text;
}

function firstLine(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((candidate) => candidate.trim())
    .find(Boolean);
  return line ? oneLine(line, 200) : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
