import {
  addUsage,
  normalizeNewlines,
  textOf,
  truncateLine,
  truncateMiddle,
  type ContentBlock,
  type HostedToolActivity,
  type Message,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type ToolCallBlock,
  type Usage,
} from '@patch/shared';
import type { SessionEntry } from '../session/schema.js';
import { streamModel } from './abort.js';

export const COMPACTION_SYSTEM_PROMPT = `You summarize a coding session between a developer and Patch, a coding agent, so the work can continue in a fresh context. The summary replaces the conversation: anything you leave out is lost. Be precise and concrete; do not add commentary or pleasantries.`;

export const COMPACTION_INSTRUCTIONS = `Write a summary of the session above for continuing the work. Use these sections, omitting any that are empty:

## Goal
What the user is trying to achieve, including constraints and preferences they stated.

## Current state
What has been done so far and what is true now. Be specific about files changed (paths) and what changed in each.

## Key findings
Important facts discovered about the codebase: relevant files and functions (path:line where known), architecture, conventions, commands that build/test the project and their current results, errors encountered and their causes.

## Decisions
Choices made and why, including approaches that were tried and rejected.

## Open work
Remaining steps, unresolved questions, and anything the user asked for that is not done yet.

Quote exact identifiers, paths, commands, and error messages. Do not invent anything that is not in the transcript.`;

/** Max characters of a single tool input/result kept in the compaction transcript. */
export const COMPACTION_TOOL_INPUT_CHARS = 1_500;
export const COMPACTION_TOOL_RESULT_CHARS = 2_500;

/** Output token cap for the summary request. */
export const COMPACTION_MAX_OUTPUT_TOKENS = 8_000;
/** Output token cap for the one retry of a summary cut off at COMPACTION_MAX_OUTPUT_TOKENS. */
export const COMPACTION_RETRY_MAX_OUTPUT_TOKENS = 16_000;

/** Share of a truncated tool result kept from its head; the rest comes from its tail. */
const RESULT_HEAD_RATIO = 0.6;

/** Stands in for an image in the transcript (the summary request carries text only). */
const IMAGE_PLACEHOLDER = '[image]';

/**
 * Serializes model context into a plain-text transcript for summarization:
 *   "User:\n...", "Patch:\n...", "[tool call read_file {json}]", "[tool result (error)] ...",
 *   "[web search: query]", "[web search result] 8 results".
 * Long tool inputs/results are truncated with explicit markers; images become "[image]"; other
 * provider blocks are skipped except for their `displayText` (rendered as "[progress] ...").
 */
export function renderTranscript(messages: Message[]): string {
  const sections: string[] = [];
  for (const message of messages) {
    const parts = message.content
      .map(renderBlock)
      .filter((part): part is string => part !== undefined);
    if (parts.length === 0) continue;
    sections.push(`${message.role === 'user' ? 'User' : 'Patch'}:\n${parts.join('\n')}`);
  }
  return sections.join('\n\n');
}

function renderBlock(block: ContentBlock): string | undefined {
  switch (block.type) {
    case 'text': {
      const text = normalizeNewlines(block.text).trim();
      return text === '' ? undefined : text;
    }
    case 'image':
      return IMAGE_PLACEHOLDER;
    case 'tool_call':
      return renderToolCall(block);
    case 'tool_result': {
      const images = (block.images ?? []).map(() => ` ${IMAGE_PLACEHOLDER}`).join('');
      return `[tool result${block.isError ? ' (error)' : ''}] ${clipToolResult(block.content)}${images}`;
    }
    case 'provider': {
      if (block.hostedTool) return renderHostedTool(block.hostedTool);
      const text = block.displayText?.trim();
      return text ? `[progress] ${text}` : undefined;
    }
  }
}

/** The page contents are not kept: the summary records what was looked up and the outcome. */
function renderHostedTool(activity: HostedToolActivity): string {
  const name = activity.kind === 'web_search' ? 'web search' : 'web fetch';
  if (activity.phase === 'call') {
    return `[${name}: ${truncateLine(activity.detail, COMPACTION_TOOL_INPUT_CHARS)}]`;
  }
  return `[${name} result${activity.isError ? ' (error)' : ''}] ${activity.summary}`;
}

function renderToolCall(block: ToolCallBlock): string {
  if (block.inputError !== undefined) {
    const raw = truncateLine(block.rawInput ?? '', COMPACTION_TOOL_INPUT_CHARS);
    return `[tool call ${block.name} (invalid JSON input: ${block.inputError}) ${raw}]`;
  }
  return `[tool call ${block.name} ${truncateLine(JSON.stringify(block.input), COMPACTION_TOOL_INPUT_CHARS)}]`;
}

/** Keeps the head and tail of long results: errors and summaries tend to sit at the end. */
function clipToolResult(content: string): string {
  const text = normalizeNewlines(content).trimEnd();
  if (text.length <= COMPACTION_TOOL_RESULT_CHARS) return text;
  return truncateMiddle(text, {
    maxLines: Number.MAX_SAFE_INTEGER,
    maxChars: COMPACTION_TOOL_RESULT_CHARS,
    headRatio: RESULT_HEAD_RATIO,
  }).text;
}

/** The single user message of a summary request: transcript, instructions, optional focus. */
export function buildCompactionPrompt(transcript: string, instructions?: string): string {
  const focus = instructions?.trim();
  const extra = focus ? `\n\nAdditional focus from the user: ${focus}` : '';
  return `${transcript}\n\n${COMPACTION_INSTRUCTIONS}${extra}`;
}

export interface SummarizeOptions {
  provider: ModelProvider;
  model: string;
  /** Model context to summarize (Session.history()). */
  messages: Message[];
  instructions?: string;
  maxOutputTokens: number;
  /**
   * When the summary is cut off at `maxOutputTokens`, it is requested once more with this cap
   * (no retry unless it is larger).
   */
  retryMaxOutputTokens?: number;
  signal: AbortSignal;
  /**
   * Called with the usage of every summary response as it arrives, including one that is then
   * rejected (cut off, declined or empty) and the first of a retried pair when the retry fails.
   * Such requests are billed although no summary comes of them, so callers record them from here.
   */
  onResponse?: (spent: SummaryUsage) => void;
}

/** Tokens spent on summary requests. */
export interface SummaryUsage {
  /** Model that served the (last) summary response. */
  model: string;
  /** Usage of the attempts that produced the responses. */
  usage: Usage;
  /** Tokens billed, including declined attempts a server-side fallback replaced. */
  billed: Usage;
}

/** A summary, with the usage of every summary request made for it (including a retried one). */
export interface ConversationSummary extends SummaryUsage {
  summary: string;
}

/**
 * The model answered a summary request without a usable summary: it declined, the summary was
 * cut off, or it was empty. Asking again with the same conversation is likely to fail the same way.
 */
export class SummaryRejectedError extends Error {
  override readonly name = 'SummaryRejectedError';
}

type MessageEnd = Extract<ModelEvent, { type: 'message_end' }>;

/**
 * Asks the model for a summary of `messages`. Provider failures propagate as ProviderError
 * (kind 'aborted' when the signal fires); an empty, declined or incomplete summary is a
 * SummaryRejectedError. The summary replaces the conversation for good, so one cut off at the
 * output limit (it would silently lose its last sections, such as the open work) is never
 * returned: it is requested again with `retryMaxOutputTokens`, and rejected if it is cut off again.
 */
export async function summarizeConversation(
  options: SummarizeOptions,
): Promise<ConversationSummary> {
  const { provider, model, messages, instructions, maxOutputTokens, signal } = options;
  const prompt = buildCompactionPrompt(renderTranscript(messages), instructions);
  const request = (cap: number): ModelRequest => ({
    model,
    system: COMPACTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    tools: [],
    maxOutputTokens: cap,
    purpose: 'summary',
  });
  const ask = async (cap: number): Promise<{ end: MessageEnd; spent: SummaryUsage }> => {
    const end = await requestSummary(provider, request(cap), signal);
    const spent = summaryUsageOf(end);
    options.onResponse?.(spent);
    return { end, spent };
  };

  let { end, spent } = await ask(maxOutputTokens);
  const retryCap = options.retryMaxOutputTokens ?? 0;
  if (end.stopReason === 'max_tokens' && retryCap > maxOutputTokens) {
    const retry = await ask(retryCap);
    end = retry.end;
    spent = addSummaryUsage(spent, retry.spent);
  }
  if (end.stopReason === 'refusal') {
    throw new SummaryRejectedError('The model declined to summarize this conversation.');
  }
  if (end.stopReason === 'max_tokens') {
    throw new SummaryRejectedError(
      'The summary was cut off at the output token limit before it was complete.',
    );
  }
  if (end.stopReason === 'context_window_exceeded') {
    throw new SummaryRejectedError(
      "The summary was cut off because the conversation filled the model's context window.",
    );
  }
  const summary = textOf(end.message).trim();
  if (summary === '') throw new SummaryRejectedError('Compaction produced an empty summary.');
  return { summary, ...spent };
}

function summaryUsageOf(end: MessageEnd): SummaryUsage {
  return { model: end.model, usage: end.usage, billed: end.billedUsage ?? end.usage };
}

/** Totals of two summary requests; the model is the later one's. */
export function addSummaryUsage(a: SummaryUsage, b: SummaryUsage): SummaryUsage {
  return {
    model: b.model,
    usage: addUsage(a.usage, b.usage),
    billed: addUsage(a.billed, b.billed),
  };
}

async function requestSummary(
  provider: ModelProvider,
  request: ModelRequest,
  signal: AbortSignal,
): Promise<MessageEnd> {
  for await (const event of streamModel(provider, request, signal)) {
    if (event.type === 'message_end') return event;
  }
  throw new Error('The summary response ended without a final message.');
}

/**
 * Usage of the most recent agent request whose context is still current, or undefined when nothing
 * was sent yet or a compaction happened since. Summary requests (usage entries with purpose
 * 'summary', recorded also when a compaction failed) send a transcript instead of the context, so
 * their size never counts as the size of the context.
 */
export function usageSinceCompaction(entries: readonly SessionEntry[]): Usage | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === 'usage' && (entry.purpose === undefined || entry.purpose === 'agent')) {
      return entry.usage;
    }
    if (entry.type === 'compaction') return undefined;
  }
  return undefined;
}
