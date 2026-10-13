import type {
  BetaRawContentBlockDelta,
  BetaRawContentBlockStartEvent,
  BetaRawMessageStreamEvent,
  BetaRefusalStopDetails,
  BetaStopReason,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  ProviderError,
  type ContentBlock,
  type HostedToolActivity,
  type ModelEvent,
  type ProviderBlock,
  type RefusalInfo,
  type StopReason,
  type TextBlock,
  type ToolCallBlock,
  type Usage,
} from '@patch/shared';
import { PROVIDER_ID } from './errors.js';
import { activityText, hostedCallActivity, hostedResultActivity } from './hosted-tools.js';

/** Text the API puts in a progress block that was cut short (kept for replay, never displayed). */
export const INTERRUPTED_PROGRESS_TEXT =
  'This part of the response was interrupted before it finished.';

/**
 * The `message_end` event this provider emits. `usage` is the attempt that produced the returned
 * message (what the conversation now holds, so it drives context-size accounting).
 * `billedUsage` is the sum over every attempt the API reports in `usage.iterations`; it is set
 * only when it differs from `usage`, e.g. when a server-side fallback continued after a
 * declined attempt that was billed too. Consumers totalling spend use `billedUsage ?? usage`.
 */
export type MessageEndEvent = Extract<ModelEvent, { type: 'message_end' }> & {
  billedUsage?: Usage;
};

export interface StreamAccumulatorOptions {
  /**
   * The request asked for `thinking.display: 'updates'`, so non-empty thinking text is a
   * model-authored progress note and is surfaced. Otherwise thinking text is reasoning (e.g. the
   * summaries Opus 4.6 / Sonnet 4.6 return by default): kept for replay, never displayed.
   * Default false.
   */
  progressUpdates?: boolean;
  /**
   * Hosted tool calls already in the conversation, by id. A call made alongside client tools gets
   * its result at the start of the next response; this names what that result belongs to.
   */
  priorCalls?: ReadonlyMap<string, HostedToolActivity>;
}

/** Token counts as the API reports them, at the top level of `usage` or per iteration. */
interface ApiUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

/** Per-attempt (iteration) usage summed into billed totals. */
function sumIterations(iterations: readonly ApiUsage[]): Usage {
  const total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const iteration of iterations) {
    total.inputTokens += iteration.input_tokens ?? 0;
    total.outputTokens += iteration.output_tokens ?? 0;
    total.cacheReadTokens += iteration.cache_read_input_tokens ?? 0;
    total.cacheWriteTokens += iteration.cache_creation_input_tokens ?? 0;
  }
  return total;
}

function sameUsage(a: Usage, b: Usage): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens
  );
}

type BlockState =
  /** `citations` are kept verbatim: web search citations must be sent back. */
  | { type: 'text'; text: string; citations: unknown[] }
  | { type: 'thinking'; raw: Record<string, unknown>; thinking: string; signature: string }
  | { type: 'tool_use'; id: string; name: string; json: string; bytes: number; initial: unknown }
  /** Any other block (redacted_thinking, fallback, server tool blocks, ...) kept verbatim. */
  | { type: 'opaque'; raw: Record<string, unknown>; json: string };

interface Slot {
  state: BlockState;
  /** Set once the block has stopped. */
  block?: ContentBlock;
}

const STOP_REASONS: Record<BetaStopReason, StopReason> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  stop_sequence: 'stop_sequence',
  refusal: 'refusal',
  pause_turn: 'pause',
  model_context_window_exceeded: 'context_window_exceeded',
  compaction: 'unknown',
};

const TRUNCATED_INPUT_ERROR =
  'The tool input was cut off because the response reached the output token limit.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeJsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/** Strictly parses streamed tool input; anything but a JSON object is reported, not coerced. */
export function parseToolInput(
  raw: string,
): { input: Record<string, unknown> } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unparseable';
    return { error: `The tool input is not valid JSON (${reason}).` };
  }
  if (!isRecord(value)) {
    return {
      error: `The tool input must be a JSON object, but it was ${describeJsonType(value)}.`,
    };
  }
  return { input: value };
}

function providerBlock(
  kind: string,
  data: unknown,
  displayText?: string,
  hostedTool?: HostedToolActivity,
): ProviderBlock {
  return {
    type: 'provider',
    provider: PROVIDER_ID,
    kind,
    data,
    ...(displayText !== undefined ? { displayText } : {}),
    ...(hostedTool ? { hostedTool } : {}),
  };
}

function hostedEvents(
  activity: HostedToolActivity,
  priorCalls: ReadonlyMap<string, HostedToolActivity>,
  started: Set<string>,
): ModelEvent[] {
  if (activity.phase === 'call') {
    started.add(activity.id);
    return [
      { type: 'hosted_tool_start', id: activity.id, kind: activity.kind, detail: activity.detail },
    ];
  }
  const events: ModelEvent[] = [];
  if (!started.has(activity.id)) {
    // The call was made in an earlier response (or not reported): announce it now.
    const call = priorCalls.get(activity.id);
    const detail = call?.phase === 'call' ? call.detail : '';
    events.push({ type: 'hosted_tool_start', id: activity.id, kind: activity.kind, detail });
  }
  events.push({
    type: 'hosted_tool_end',
    id: activity.id,
    kind: activity.kind,
    summary: activity.summary,
    isError: activity.isError,
  });
  return events;
}

function isKind(block: ContentBlock, ...kinds: string[]): block is ProviderBlock {
  return block.type === 'provider' && kinds.includes(block.kind);
}

function fallbackModels(block: ProviderBlock): { from: string; to: string } | undefined {
  const data = block.data;
  if (!isRecord(data) || !isRecord(data['from']) || !isRecord(data['to'])) return undefined;
  const from = data['from']['model'];
  const to = data['to']['model'];
  return typeof from === 'string' && typeof to === 'string' ? { from, to } : undefined;
}

/** True for server-tool call blocks (server_tool_use, mcp_tool_use, ...) that expect a result. */
function serverToolUseId(block: ContentBlock): string | undefined {
  if (block.type !== 'provider' || !block.kind.endsWith('tool_use')) return undefined;
  const id = isRecord(block.data) ? block.data['id'] : undefined;
  return typeof id === 'string' ? id : undefined;
}

function resultToolUseId(block: ContentBlock): string | undefined {
  if (block.type !== 'provider' || !isRecord(block.data)) return undefined;
  const id = block.data['tool_use_id'];
  return typeof id === 'string' ? id : undefined;
}

/**
 * API echo rules after a mid-output fallback: thinking, redacted_thinking and tool_use blocks
 * (and server tool calls without their result) produced before the last fallback block belong
 * to a declined attempt and must not be sent back. Text and the fallback blocks themselves stay.
 */
export function applyFallbackEchoRules(blocks: ContentBlock[]): ContentBlock[] {
  let lastFallback = -1;
  blocks.forEach((block, index) => {
    if (isKind(block, 'fallback')) lastFallback = index;
  });
  if (lastFallback < 0) return blocks;

  const before = blocks.slice(0, lastFallback);
  const pairedResults = new Set(
    before.map(resultToolUseId).filter((id): id is string => id !== undefined),
  );
  const kept = before.filter((block) => {
    if (block.type === 'tool_call') return false;
    if (isKind(block, 'thinking', 'redacted_thinking')) return false;
    const serverCallId = serverToolUseId(block);
    return serverCallId === undefined || pairedResults.has(serverCallId);
  });
  return [...kept, ...blocks.slice(lastFallback)];
}

/**
 * Accumulates raw Messages API stream events into provider-neutral ModelEvents and the final
 * assistant message. Tool input JSON is parsed per block when the block stops, so one malformed
 * input (possible with eager input streaming) does not affect the rest of the message.
 */
export class StreamAccumulator {
  private readonly slots = new Map<number, Slot>();
  private model: string;
  private started = false;
  private completed = false;
  private stopReason: BetaStopReason | null = null;
  private stopDetails: BetaRefusalStopDetails | null = null;
  private readonly usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  /** Latest `usage.iterations` (cumulative per-attempt usage), if the API reported any. */
  private iterations: readonly ApiUsage[] | undefined;
  private readonly progressUpdates: boolean;
  private readonly priorCalls: ReadonlyMap<string, HostedToolActivity>;
  /** Hosted tool calls announced with `hosted_tool_start` in this response. */
  private readonly startedCalls = new Set<string>();

  constructor(requestedModel: string, options: StreamAccumulatorOptions = {}) {
    this.model = requestedModel;
    this.progressUpdates = options.progressUpdates ?? false;
    this.priorCalls = options.priorCalls ?? new Map();
  }

  /** Feeds one stream event and returns the ModelEvents it produces. */
  push(event: BetaRawMessageStreamEvent): ModelEvent[] {
    switch (event.type) {
      case 'message_start': {
        this.started = true;
        if (event.message.model) this.model = event.message.model;
        this.applyUsage(event.message.usage);
        return [{ type: 'message_start', model: this.model }];
      }
      case 'content_block_start':
        return this.startBlock(event);
      case 'content_block_delta':
        return this.applyDelta(event.index, event.delta);
      case 'content_block_stop':
        return this.stopBlock(event.index);
      case 'message_delta': {
        this.stopReason = event.delta.stop_reason ?? this.stopReason;
        this.stopDetails = event.delta.stop_details ?? this.stopDetails;
        this.applyUsage(event.usage);
        return [];
      }
      case 'message_stop':
        this.completed = true;
        return [];
      default:
        return [];
    }
  }

  /** Builds the final `message_end` event. Throws if the stream ended before message_stop. */
  finish(): MessageEndEvent {
    if (!this.started || !this.completed) {
      throw new ProviderError(
        'network',
        'The response stream ended before the message was complete.',
        {
          provider: PROVIDER_ID,
          retryable: true,
        },
      );
    }
    const blocks = [...this.slots.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, slot]) => slot.block ?? this.finalize(slot));
    const stopReason = this.stopReason ? (STOP_REASONS[this.stopReason] ?? 'unknown') : 'unknown';
    if (stopReason === 'max_tokens') this.markTruncatedToolInput(blocks);

    const fallbacks = blocks
      .filter((block): block is ProviderBlock => isKind(block, 'fallback'))
      .map(fallbackModels)
      .filter((pair): pair is { from: string; to: string } => pair !== undefined);
    const notices = fallbacks.map(({ from, to }) => `${from} declined; ${to} continued`);
    const servingModel = fallbacks.at(-1)?.to ?? this.model;

    return {
      type: 'message_end',
      message: { role: 'assistant', content: applyFallbackEchoRules(blocks) },
      stopReason,
      usage: { ...this.usage },
      ...this.billedUsage(),
      model: servingModel,
      ...(stopReason === 'refusal' ? { refusal: this.refusalInfo() } : {}),
      ...(notices.length > 0 ? { notices } : {}),
    };
  }

  private refusalInfo(): RefusalInfo {
    return {
      category: this.stopDetails?.category ?? null,
      explanation: this.stopDetails?.explanation ?? null,
    };
  }

  /**
   * `{ billedUsage }` when the API's per-attempt usage adds up to more than the top-level
   * counters (which cover only the attempt that produced the message), else nothing.
   */
  private billedUsage(): { billedUsage?: Usage } {
    if (!this.iterations || this.iterations.length === 0) return {};
    const summed = sumIterations(this.iterations);
    // Every attempt is included in the iterations, so the total is never below the serving
    // attempt's own counters; taking the larger guards against an incomplete report.
    const billed: Usage = {
      inputTokens: Math.max(summed.inputTokens, this.usage.inputTokens),
      outputTokens: Math.max(summed.outputTokens, this.usage.outputTokens),
      cacheReadTokens: Math.max(summed.cacheReadTokens, this.usage.cacheReadTokens),
      cacheWriteTokens: Math.max(summed.cacheWriteTokens, this.usage.cacheWriteTokens),
      // Searches are counted per response, not per attempt.
      ...(this.usage.webSearches ? { webSearches: this.usage.webSearches } : {}),
    };
    return sameUsage(billed, this.usage) ? {} : { billedUsage: billed };
  }

  private applyUsage(usage: ApiUsage & { iterations?: readonly ApiUsage[] | null }): void {
    // Iterations are cumulative too: the latest non-null list replaces the previous one.
    if (Array.isArray(usage.iterations)) this.iterations = usage.iterations;
    // message_delta usage is cumulative; null means "unchanged".
    if (typeof usage.input_tokens === 'number') this.usage.inputTokens = usage.input_tokens;
    if (typeof usage.output_tokens === 'number') this.usage.outputTokens = usage.output_tokens;
    if (typeof usage.cache_read_input_tokens === 'number') {
      this.usage.cacheReadTokens = usage.cache_read_input_tokens;
    }
    if (typeof usage.cache_creation_input_tokens === 'number') {
      this.usage.cacheWriteTokens = usage.cache_creation_input_tokens;
    }
    const searches = usage.server_tool_use?.web_search_requests;
    if (typeof searches === 'number' && searches > 0) this.usage.webSearches = searches;
  }

  private startBlock(event: BetaRawContentBlockStartEvent): ModelEvent[] {
    const block = event.content_block;
    switch (block.type) {
      case 'text':
        this.slots.set(event.index, {
          state: { type: 'text', text: block.text, citations: [...(block.citations ?? [])] },
        });
        return block.text ? [{ type: 'text_delta', text: block.text }] : [];
      case 'thinking':
        this.slots.set(event.index, {
          state: {
            type: 'thinking',
            raw: { ...block },
            thinking: block.thinking ?? '',
            signature: block.signature ?? '',
          },
        });
        return [{ type: 'thinking' }];
      case 'tool_use':
        this.slots.set(event.index, {
          state: {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            json: '',
            bytes: 0,
            initial: block.input,
          },
        });
        return [{ type: 'tool_call_start', id: block.id, name: block.name }];
      default:
        this.slots.set(event.index, { state: { type: 'opaque', raw: { ...block }, json: '' } });
        return block.type === 'redacted_thinking' ? [{ type: 'thinking' }] : [];
    }
  }

  private applyDelta(index: number, delta: BetaRawContentBlockDelta): ModelEvent[] {
    const state = this.slots.get(index)?.state;
    if (!state) return [];
    switch (delta.type) {
      case 'text_delta':
        if (state.type !== 'text' || delta.text === '') return [];
        state.text += delta.text;
        return [{ type: 'text_delta', text: delta.text }];
      case 'thinking_delta':
        if (state.type === 'thinking') state.thinking += delta.thinking;
        return [];
      case 'signature_delta':
        // The signature arrives whole; it is not a fragment to append.
        if (state.type === 'thinking') state.signature = delta.signature;
        return [];
      case 'input_json_delta':
        if (delta.partial_json === '') return [];
        if (state.type === 'opaque') {
          state.json += delta.partial_json;
          return [];
        }
        if (state.type !== 'tool_use') return [];
        state.json += delta.partial_json;
        state.bytes += Buffer.byteLength(delta.partial_json, 'utf8');
        return [{ type: 'tool_call_delta', id: state.id, inputBytes: state.bytes }];
      case 'compaction_delta':
        if (state.type === 'opaque') {
          state.raw['content'] = delta.content;
          if ('encrypted_content' in delta)
            state.raw['encrypted_content'] = delta.encrypted_content;
        }
        return [];
      case 'citations_delta':
        if (state.type === 'text') state.citations.push(delta.citation);
        return [];
      default:
        // Future delta types carry nothing Patch replays.
        return [];
    }
  }

  private stopBlock(index: number): ModelEvent[] {
    const slot = this.slots.get(index);
    if (!slot || slot.block) return [];
    const block = this.finalize(slot);
    if (block.type !== 'provider') return [];
    if (block.kind === 'thinking' && block.displayText) {
      return [{ type: 'progress', text: block.displayText }];
    }
    return block.hostedTool
      ? hostedEvents(block.hostedTool, this.priorCalls, this.startedCalls)
      : [];
  }

  private finalize(slot: Slot): ContentBlock {
    slot.block = this.toContentBlock(slot.state);
    return slot.block;
  }

  private toContentBlock(state: BlockState): ContentBlock {
    switch (state.type) {
      case 'text': {
        const block: TextBlock = { type: 'text', text: state.text };
        if (state.citations.length > 0) {
          block.providerData = { provider: PROVIDER_ID, data: { citations: state.citations } };
        }
        return block;
      }
      case 'thinking': {
        const data = { ...state.raw, thinking: state.thinking, signature: state.signature };
        const note = state.thinking.trim();
        const isProgress =
          this.progressUpdates && note !== '' && state.thinking !== INTERRUPTED_PROGRESS_TEXT;
        return providerBlock('thinking', data, isProgress ? note : undefined);
      }
      case 'tool_use':
        return this.toToolCall(state);
      case 'opaque': {
        if (state.json !== '') {
          const parsed = parseToolInput(state.json);
          state.raw['input'] = 'input' in parsed ? parsed.input : state.json;
        } else if (state.raw['type'] === 'server_tool_use' && !('input' in state.raw)) {
          // A call is sent back with its input, which can arrive only as deltas.
          state.raw['input'] = {};
        }
        const kind = typeof state.raw['type'] === 'string' ? state.raw['type'] : 'unknown';
        const hosted = hostedCallActivity(state.raw) ?? hostedResultActivity(state.raw);
        return providerBlock(kind, state.raw, hosted ? activityText(hosted) : undefined, hosted);
      }
    }
  }

  private toToolCall(state: Extract<BlockState, { type: 'tool_use' }>): ToolCallBlock {
    const base = { type: 'tool_call' as const, id: state.id, name: state.name };
    if (state.json.trim() === '') {
      return { ...base, input: isRecord(state.initial) ? state.initial : {} };
    }
    const parsed = parseToolInput(state.json);
    if ('input' in parsed) return { ...base, input: parsed.input };
    return { ...base, input: {}, inputError: parsed.error, rawInput: state.json };
  }

  /** A response cut off by max_tokens leaves its last tool call's JSON incomplete. */
  private markTruncatedToolInput(blocks: ContentBlock[]): void {
    const last = blocks.at(-1);
    if (last?.type === 'tool_call' && last.inputError !== undefined) {
      last.inputError = TRUNCATED_INPUT_ERROR;
    }
  }
}
