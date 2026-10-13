import { z } from 'zod';
import type { Message, Usage } from '@patch/shared';
import type { ToolCallSummary, ToolDisplay } from '../tools/types.js';

export const SESSION_FORMAT_VERSION = 1;

/**
 * User messages that carry the output of a `!` command start with this tag
 * (`<user-shell-command>\n$ cmd\n...\n</user-shell-command>`). Session titles skip them.
 */
export const USER_SHELL_CONTEXT_TAG = '<user-shell-command>';

/**
 * Text blocks telling the model that the working directory changed (a session resumed from another
 * directory of the project) start with this tag. They are sent as a note of the user's turn (see
 * `UserTurn.notes`): a text block before the user's text in the same message. Older sessions
 * stored them as user messages of their own. Session titles and transcripts skip them.
 */
export const WORKING_DIRECTORY_TAG = '<working-directory-update>';

/**
 * Text blocks carrying the output of the user's hooks start with this tag
 * (`<hook-output event="SessionStart">...</hook-output>`): context from SessionStart and
 * UserPromptSubmit hooks, sent as notes of the user's turn, and the instruction of a Stop hook
 * that asked the model to continue, sent as a message of its own. Session titles and transcripts
 * skip them.
 */
export const HOOK_OUTPUT_TAG = '<hook-output';

/**
 * Text telling the model whether plan mode is on starts with this tag
 * (`<plan-mode state="on">...</plan-mode>`): notes sent with the user's turn when the mode changed
 * since the model last heard, and present_plan results. Session titles and transcripts skip the
 * notes.
 */
export const PLAN_MODE_TAG = '<plan-mode';

/** Text of the user message appended when the user interrupts a turn. Session titles skip it. */
export const INTERRUPTED_MARKER = '[The user interrupted this response.]';

/** Prefix of the synthetic user message that carries a compaction summary. */
export const COMPACTION_SUMMARY_PREFIX =
  'This session was compacted. Summary of the earlier conversation:';

/** First line of every session file. */
export interface SessionMeta {
  type: 'meta';
  v: typeof SESSION_FORMAT_VERSION;
  id: string;
  createdAt: string;
  /** Directory Patch was started in. */
  cwd: string;
  projectRoot: string;
  isGit: boolean;
  branch: string | null;
  provider: string;
  /** Model at session start (later changes are `model` entries). */
  model: string;
  patchVersion: string;
  /**
   * The exact system prompt used for every request in this session. Frozen so the prompt prefix
   * stays byte-identical (prompt caching, and providers that bind reasoning to the prefix).
   */
  system: string;
}

/** A conversation message in the provider-neutral protocol (what the model sees). */
export interface MessageEntry {
  type: 'message';
  ts: string;
  message: Message;
}

/** UI record of a finished tool call, for re-rendering the transcript on resume. */
export interface ToolEntry {
  type: 'tool';
  ts: string;
  callId: string;
  name: string;
  summary: ToolCallSummary;
  isError: boolean;
  denied?: boolean;
  display?: ToolDisplay;
  durationMs: number;
}

/** History before this point is replaced by `summary` when building model context. */
export interface CompactionEntry {
  type: 'compaction';
  ts: string;
  summary: string;
  /** Number of messages that were summarized. */
  messagesCompacted: number;
  /** Prompt tokens of the last request before compaction, when known. */
  tokensBefore?: number;
  auto: boolean;
}

export interface ModelChangeEntry {
  type: 'model';
  ts: string;
  model: string;
}

export interface UsageEntry {
  type: 'usage';
  ts: string;
  model: string;
  /**
   * `summary` for compaction requests, whose size says nothing about the conversation's context
   * (context accounting skips them, see `usageSinceCompaction`). Absent for agent requests.
   * Entries are recorded for summary requests that produced no usable summary too, so costs
   * include them.
   */
  purpose?: 'agent' | 'summary';
  /**
   * Usage of the attempt that served the request (for an agent request, what is now in context).
   * A summary entry sums every summary request of one compaction, including a retry.
   */
  usage: Usage;
  /** Tokens billed across all attempts when it differs from `usage` (server-side fallbacks). */
  billed?: Usage;
}

export interface NoticeEntry {
  type: 'notice';
  ts: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}

/** A command the user ran with `!`. Its output also becomes context via a message entry. */
export interface ShellEntry {
  type: 'shell';
  ts: string;
  command: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
}

export type SessionEntry =
  | SessionMeta
  | MessageEntry
  | ToolEntry
  | CompactionEntry
  | ModelChangeEntry
  | UsageEntry
  | NoticeEntry
  | ShellEntry;

/** Entries a caller may append (everything except meta; `ts` is filled in if omitted). */
export type AppendableEntry =
  | Omit<MessageEntry, 'ts'>
  | Omit<ToolEntry, 'ts'>
  | Omit<CompactionEntry, 'ts'>
  | Omit<ModelChangeEntry, 'ts'>
  | Omit<UsageEntry, 'ts'>
  | Omit<NoticeEntry, 'ts'>
  | Omit<ShellEntry, 'ts'>;

/**
 * Runtime validation for entries read from disk. Unknown entry types and malformed lines are
 * skipped by the reader (forward compatibility, crash tolerance) — never fatal.
 */
export const SessionMetaSchema = z.looseObject({
  type: z.literal('meta'),
  v: z.literal(SESSION_FORMAT_VERSION),
  id: z.string().min(1),
  createdAt: z.string(),
  cwd: z.string(),
  projectRoot: z.string(),
  isGit: z.boolean(),
  branch: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  patchVersion: z.string(),
  system: z.string(),
});
