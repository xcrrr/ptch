/**
 * Hooks: shell commands the user configures (only in ~/.patch/config.json, never in a repository)
 * to run on agent events. See HookRunner for how they run.
 */

export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SessionStart',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Events whose hooks can have a `matcher` (they run for tool calls). */
export const TOOL_HOOK_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse'];

export const DEFAULT_HOOK_TIMEOUT_SECONDS = 60;
export const MAX_HOOK_TIMEOUT_SECONDS = 3_600;
/**
 * Longest matcher accepted. Matchers are regular expressions run against tool names, which are
 * short, so a length cap is enough to keep a badly written pattern from stalling a turn.
 */
export const MAX_HOOK_MATCHER_LENGTH = 200;
/** Matchers that select every tool besides an absent one. */
const MATCH_ALL = new Set(['', '*']);

export interface HookDefinition {
  event: HookEvent;
  /** Shell command, run in the project root with the detected shell. */
  command: string;
  /**
   * Tool events: a regular expression matched against the whole tool name ("bash|edit_file").
   * Undefined (or "*") matches every tool.
   */
  matcher?: string;
  timeoutMs: number;
}

export type HooksConfig = Readonly<Record<HookEvent, readonly HookDefinition[]>>;

/** A hook entry as validated by the config schema (ConfigFileSchema.hooks). */
export interface HookEntry {
  command: string;
  /** Tool events only. */
  matcher?: string;
  /** Seconds. */
  timeout?: number;
}

export type HookEntries = Partial<Record<HookEvent, HookEntry[]>>;

export function emptyHooks(): HooksConfig {
  return { PreToolUse: [], PostToolUse: [], UserPromptSubmit: [], Stop: [], SessionStart: [] };
}

/** Turns validated config entries into hook definitions (timeouts in ms, "*" as no matcher). */
export function resolveHooks(entries: HookEntries | undefined): HooksConfig {
  const hooks = emptyHooks() as Record<HookEvent, HookDefinition[]>;
  if (!entries) return hooks;
  for (const event of HOOK_EVENTS) {
    for (const entry of entries[event] ?? []) {
      const matcher = TOOL_HOOK_EVENTS.includes(event) ? entry.matcher?.trim() : undefined;
      hooks[event].push({
        event,
        command: entry.command.trim(),
        ...(matcher !== undefined && !MATCH_ALL.has(matcher) ? { matcher } : {}),
        timeoutMs: Math.round((entry.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS) * 1_000),
      });
    }
  }
  return hooks;
}

/** Number of configured hooks. */
export function countHooks(hooks: HooksConfig): number {
  return HOOK_EVENTS.reduce((sum, event) => sum + hooks[event].length, 0);
}

/** True when `matcher` is usable: "*", empty, or a regular expression of reasonable length. */
export function isValidHookMatcher(matcher: string): boolean {
  if (MATCH_ALL.has(matcher.trim())) return true;
  if (matcher.length > MAX_HOOK_MATCHER_LENGTH) return false;
  return compileHookMatcher(matcher) !== undefined;
}

/** The matcher as a regular expression over the whole tool name; undefined when invalid. */
export function compileHookMatcher(matcher: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${matcher.trim()})$`);
  } catch {
    return undefined;
  }
}
