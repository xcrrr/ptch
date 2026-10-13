import type { ToolCallBlock, ToolResultBlock } from '@patch/shared';
import type { ToolEntry } from '../session/schema.js';
import type { Session } from '../session/store.js';

/**
 * Result given to an unfinished tool call (see `unfinishedToolCalls`) for which nothing was
 * recorded: the call may not have started, or may have run partly or completely.
 */
export const UNFINISHED_TOOL_MESSAGE =
  'Outcome unknown: the session ended before this tool call finished, so it may not have run, or may have run partly or completely. Check the current state before repeating it.';
/** Result given to an unfinished tool call recorded as finished without an error. */
export const LOST_OUTPUT_TOOL_MESSAGE =
  'This tool call finished successfully, but the session ended before its output was recorded, so the output is lost. Any changes it made have taken effect: check the current state instead of repeating it.';
/** Result given to an unfinished tool call recorded as finished with an error. */
export const LOST_ERROR_TOOL_MESSAGE =
  'This tool call ended with an error, but the session ended before the error was recorded, so its output is lost. It may have made changes before it failed: check the current state before repeating it.';
/** Result given to an unfinished tool call recorded as declined (it never ran). */
export const DECLINED_UNFINISHED_TOOL_MESSAGE =
  'Not run: this action was declined. The session ended before the full result was recorded.';

/** What is known about an unfinished tool call from the `tool` entries recorded for it. */
export type UnfinishedCallOutcome =
  /** Declined by the user or a rule: it never ran. */
  | 'declined'
  /** Finished; only its output was lost. */
  | 'succeeded'
  | 'failed'
  /** Nothing recorded: it was running or had not started. */
  | 'unknown';

export interface AnsweredToolCall {
  call: ToolCallBlock;
  outcome: UnfinishedCallOutcome;
}

/**
 * Tool calls that can never be answered by the turn that made them: the last message of the
 * model context is an assistant message with tool calls. A turn stores that message before it
 * runs the calls and their results after, so this happens when the process stopped in between
 * (crash, kill, closed terminal, power loss).
 */
export function unfinishedToolCalls(session: Session): ToolCallBlock[] {
  const last = session.history().at(-1);
  if (last?.role !== 'assistant') return [];
  return last.content.filter((block): block is ToolCallBlock => block.type === 'tool_call');
}

/**
 * Answers unfinished tool calls (see `unfinishedToolCalls`) so the session can continue:
 * providers reject every request in which a tool call is not answered by the next message.
 * Append-only, like every history change: one user message with an error result per call, the
 * same shape a turn stores for calls it could not run. Call it before appending anything else to
 * the conversation. Returns the calls it answered (none when the history was valid).
 *
 * Each call is described by what was recorded for it: a turn writes a `tool` entry as soon as a
 * call settles (synchronously, so it survives a hard kill) but stores the results only once the
 * whole batch has settled. A call with such an entry finished, or was declined, and only its
 * output was lost; the model is never told it did not run when it did, since it might then
 * repeat a change that already took effect. Results stay errors either way: the real output is
 * gone.
 */
export function answerUnfinishedToolCalls(session: Session): AnsweredToolCall[] {
  const calls = unfinishedToolCalls(session);
  if (calls.length === 0) return [];
  const recorded = recordedToolEntries(session);
  const answered = calls.map((call) => ({ call, outcome: outcomeOf(recorded.get(call.id)) }));
  const results: ToolResultBlock[] = answered.map(({ call, outcome }) => ({
    type: 'tool_result',
    toolCallId: call.id,
    content: OUTCOME_MESSAGES[outcome],
    isError: true,
  }));
  session.append({ type: 'message', message: { role: 'user', content: results } });
  return answered;
}

const OUTCOME_MESSAGES: Record<UnfinishedCallOutcome, string> = {
  declined: DECLINED_UNFINISHED_TOOL_MESSAGE,
  succeeded: LOST_OUTPUT_TOOL_MESSAGE,
  failed: LOST_ERROR_TOOL_MESSAGE,
  unknown: UNFINISHED_TOOL_MESSAGE,
};

/** `tool` entries written after the last stored message (the calls' own), by call id. */
function recordedToolEntries(session: Session): Map<string, ToolEntry> {
  const entries = session.entries();
  const recorded = new Map<string, ToolEntry>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type === 'message' || entry.type === 'compaction') break;
    if (entry.type === 'tool' && !recorded.has(entry.callId)) recorded.set(entry.callId, entry);
  }
  return recorded;
}

function outcomeOf(entry: ToolEntry | undefined): UnfinishedCallOutcome {
  if (!entry) return 'unknown';
  if (entry.denied) return 'declined';
  return entry.isError ? 'failed' : 'succeeded';
}
