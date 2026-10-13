import { z } from 'zod';
import { IMAGE_MEDIA_TYPES, oneLine, type Message } from '@patch/shared';
import {
  COMPACTION_SUMMARY_PREFIX,
  HOOK_OUTPUT_TAG,
  INTERRUPTED_MARKER,
  PLAN_MODE_TAG,
  SESSION_FORMAT_VERSION,
  SessionMetaSchema,
  USER_SHELL_CONTEXT_TAG,
  WORKING_DIRECTORY_TAG,
  type SessionEntry,
  type SessionMeta,
} from './schema.js';

/** Title of a session that has no title-worthy user message. */
export const NO_MESSAGES_TITLE = '(no messages)';
const TITLE_MAX_CHARS = 80;
/** Notes sent with a user turn start with one of these (see UserTurn.notes). */
const NOTE_TAGS = [WORKING_DIRECTORY_TAG, HOOK_OUTPUT_TAG, PLAN_MODE_TAG];

/**
 * Line prefixes produced by `serializeEntry` (which always writes `type` as the first key). They
 * let `scanSessionFile` classify lines without parsing them.
 */
const MESSAGE_LINE_PREFIX = '{"type":"message",';
const MODEL_LINE_PREFIX = '{"type":"model",';

const TextBlockSchema = z.looseObject({ type: z.literal('text'), text: z.string() });
/** Images are stored inline (base64), so a session file replays without the original files. */
const ImageBlockSchema = z.looseObject({
  type: z.literal('image'),
  mediaType: z.enum(IMAGE_MEDIA_TYPES),
  data: z.string(),
  label: z.string().optional(),
});
const ToolCallBlockSchema = z.looseObject({
  type: z.literal('tool_call'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});
const ToolResultBlockSchema = z.looseObject({
  type: z.literal('tool_result'),
  toolCallId: z.string(),
  content: z.string(),
  // Absent in sessions written before tools could return images.
  images: z.array(ImageBlockSchema).optional(),
});
const ProviderBlockSchema = z.looseObject({
  type: z.literal('provider'),
  provider: z.string(),
  kind: z.string(),
});
const MessageSchema = z.looseObject({
  role: z.enum(['user', 'assistant']),
  content: z.array(
    z.discriminatedUnion('type', [
      TextBlockSchema,
      ImageBlockSchema,
      ToolCallBlockSchema,
      ToolResultBlockSchema,
      ProviderBlockSchema,
    ]),
  ),
});
const UsageSchema = z.looseObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
});

/**
 * Structural validation of the entry types this version understands. Validation only gates
 * entries; the stored objects are used as parsed so replayed content stays byte-identical.
 */
const ENTRY_SCHEMAS: Record<Exclude<SessionEntry['type'], 'meta'>, z.ZodType> = {
  message: z.looseObject({ ts: z.string(), message: MessageSchema }),
  tool: z.looseObject({
    ts: z.string(),
    callId: z.string(),
    name: z.string(),
    summary: z.looseObject({ verb: z.string(), target: z.string() }),
    isError: z.boolean(),
    durationMs: z.number(),
  }),
  compaction: z.looseObject({
    ts: z.string(),
    summary: z.string(),
    messagesCompacted: z.number(),
    auto: z.boolean(),
  }),
  model: z.looseObject({ ts: z.string(), model: z.string().min(1) }),
  usage: z.looseObject({
    ts: z.string(),
    model: z.string(),
    // Any string: an entry from a newer version with another purpose still counts toward costs.
    purpose: z.string().optional(),
    usage: UsageSchema,
    billed: UsageSchema.optional(),
  }),
  notice: z.looseObject({
    ts: z.string(),
    level: z.enum(['info', 'warn', 'error']),
    text: z.string(),
  }),
  shell: z.looseObject({
    ts: z.string(),
    command: z.string(),
    exitCode: z.number().nullable(),
    output: z.string(),
    durationMs: z.number(),
  }),
};

export function serializeEntry(entry: SessionEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Validates a parsed non-meta line. Unknown types and malformed entries yield undefined. */
function toSessionEntry(value: unknown): SessionEntry | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  if (!Object.hasOwn(ENTRY_SCHEMAS, value.type)) return undefined;
  const schema = ENTRY_SCHEMAS[value.type as keyof typeof ENTRY_SCHEMAS];
  return schema.safeParse(value).success ? (value as unknown as SessionEntry) : undefined;
}

type MetaCheck = { meta: SessionMeta } | { problem: string };

function checkMeta(line: string, expectedId: string): MetaCheck {
  const value = parseJsonLine(line);
  if (value === undefined) return { problem: 'its first line is not valid JSON' };
  if (!isRecord(value) || value.type !== 'meta') {
    return { problem: 'its first line is not session metadata' };
  }
  if (typeof value.v === 'number' && value.v > SESSION_FORMAT_VERSION) {
    return {
      problem: `it was written by a newer version of Patch (session format v${value.v})`,
    };
  }
  const result = SessionMetaSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.join('.') || 'metadata';
    return { problem: `its metadata is invalid (${field}: ${issue?.message ?? 'invalid'})` };
  }
  // Case-insensitive: file names are on Windows and macOS, so `load('ABC…')` finds `abc….jsonl`.
  if (result.data.id.toLowerCase() !== expectedId.toLowerCase()) {
    return { problem: `its metadata belongs to a different session (${result.data.id})` };
  }
  return { meta: value as unknown as SessionMeta };
}

function splitContent(content: string): string[] {
  const withoutBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  return withoutBom.split('\n');
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** Locates and validates the meta line (the first non-blank line). */
function readMeta(
  lines: readonly string[],
  expectedId: string,
): { meta: SessionMeta; index: number } | { problem: string } {
  const index = lines.findIndex((line) => !isBlank(line));
  if (index === -1) return { problem: 'the file is empty' };
  const check = checkMeta(lines[index]!, expectedId);
  return 'problem' in check ? check : { meta: check.meta, index };
}

export interface ParsedSessionFile {
  meta: SessionMeta;
  /** Meta first, then every valid entry in file order. */
  entries: SessionEntry[];
  /** True when the file does not end with a newline (e.g. a write cut short by a crash). */
  unterminated: boolean;
}

/**
 * Parses a whole session file. Blank lines, corrupt lines (including a truncated last line) and
 * entries of unknown types are skipped; only an invalid meta line makes the file unloadable.
 */
export function parseSessionFile(
  content: string,
  expectedId: string,
): ParsedSessionFile | { problem: string } {
  const lines = splitContent(content);
  const located = readMeta(lines, expectedId);
  if ('problem' in located) return located;
  const entries: SessionEntry[] = [located.meta];
  for (let i = located.index + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (isBlank(line)) continue;
    const entry = toSessionEntry(parseJsonLine(line));
    if (entry) entries.push(entry);
  }
  return { meta: located.meta, entries, unterminated: content !== '' && !content.endsWith('\n') };
}

export interface SessionFileScan {
  meta: SessionMeta;
  title: string;
  /** Current model (last `model` entry, else meta.model). */
  model: string;
  messageCount: number;
  hasUserMessage: boolean;
  /** `ts` of the last valid entry after the meta line, if any. */
  lastTimestamp?: string;
}

/**
 * Summarizes a session file cheaply for listings: only the meta line, `model` lines, the user
 * messages needed to find a title and the last valid line are parsed. Message lines are counted
 * by prefix. Returns undefined when the meta line is invalid or `accept(meta)` is false (so
 * filtered-out sessions cost a single parse).
 */
export function scanSessionFile(
  content: string,
  expectedId: string,
  accept: (meta: SessionMeta) => boolean,
): SessionFileScan | undefined {
  const lines = splitContent(content);
  const located = readMeta(lines, expectedId);
  if ('problem' in located || !accept(located.meta)) return undefined;

  const { meta, index: metaIndex } = located;
  let title: string | undefined;
  let model = meta.model;
  let messageCount = 0;
  let hasUserMessage = false;
  for (let i = metaIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith(MESSAGE_LINE_PREFIX)) {
      if (!line.trimEnd().endsWith('}')) continue;
      messageCount++;
      if (title !== undefined) continue;
      const entry = toSessionEntry(parseJsonLine(line));
      if (entry?.type === 'message' && entry.message.role === 'user') {
        hasUserMessage = true;
        title = titleFromMessage(entry.message);
      }
    } else if (line.startsWith(MODEL_LINE_PREFIX)) {
      const entry = toSessionEntry(parseJsonLine(line));
      if (entry?.type === 'model') model = entry.model;
    }
  }
  return {
    meta,
    title: title ?? NO_MESSAGES_TITLE,
    model,
    messageCount,
    hasUserMessage,
    lastTimestamp: findLastTimestamp(lines, metaIndex),
  };
}

function findLastTimestamp(lines: readonly string[], metaIndex: number): string | undefined {
  for (let i = lines.length - 1; i > metaIndex; i--) {
    const line = lines[i]!;
    if (isBlank(line)) continue;
    const value = parseJsonLine(line);
    if (isRecord(value) && typeof value.ts === 'string' && !Number.isNaN(Date.parse(value.ts))) {
      return value.ts;
    }
  }
  return undefined;
}

/**
 * Title text of a user message: its first text block that is not a note sent with the turn (a
 * working-directory update, hook output or plan mode change, which come before the user's
 * text). Undefined when the message is not title-worthy: no such text block, a `!` command
 * transcript, the interruption marker, a compaction summary, or blank text.
 */
export function titleFromMessage(message: Message): string | undefined {
  if (message.role !== 'user') return undefined;
  const block = message.content.find(
    (b) => b.type === 'text' && !NOTE_TAGS.some((tag) => b.text.trimStart().startsWith(tag)),
  );
  if (block?.type !== 'text') return undefined;
  const text = block.text.trimStart();
  if (
    text.startsWith(USER_SHELL_CONTEXT_TAG) ||
    text.startsWith(COMPACTION_SUMMARY_PREFIX) ||
    text.trimEnd() === INTERRUPTED_MARKER
  ) {
    return undefined;
  }
  const title = oneLine(text, TITLE_MAX_CHARS);
  return title === '' ? undefined : title;
}

/** The synthetic user message that stands in for everything before a compaction. */
export function compactionSummaryMessage(summary: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text: `${COMPACTION_SUMMARY_PREFIX}\n\n${summary}` }],
  };
}
