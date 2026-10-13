/**
 * Provider-neutral model protocol.
 *
 * The agent runtime only speaks these types. Each provider package (Anthropic today; others later)
 * translates them to and from its own wire format. Nothing in here may reference a specific vendor.
 */

export type Role = 'user' | 'assistant';

export interface TextBlock {
  type: 'text';
  text: string;
  /**
   * Opaque provider metadata of this text, such as citations of web search results. Replayed
   * verbatim to the provider that produced it; other providers drop it.
   */
  providerData?: { provider: string; data: Record<string, unknown> };
}

/** Image formats every provider is expected to accept. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** An image the user attached (allowed in user messages) or a tool returned (ToolResultBlock). */
export interface ImageBlock {
  type: 'image';
  mediaType: ImageMediaType;
  /** Base64-encoded image bytes, without a `data:` prefix. */
  data: string;
  /** Display only (a file name or "clipboard"); never sent to the model. */
  label?: string;
}

export interface ToolCallBlock {
  type: 'tool_call';
  /** Provider-assigned call id. Tool results reference it. */
  id: string;
  name: string;
  /** Parsed tool input. `{}` when the streamed input could not be parsed (see `inputError`). */
  input: Record<string, unknown>;
  /** Set when the provider could not parse the streamed input as a JSON object. */
  inputError?: string;
  /** Raw input text as streamed. Only kept when `inputError` is set. */
  rawInput?: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolCallId: string;
  /** Text returned to the model. */
  content: string;
  /** Images returned to the model after the text (e.g. read_file on a screenshot). */
  images?: ImageBlock[];
  isError?: boolean;
}

/**
 * Opaque provider-specific content (for example Anthropic thinking blocks carrying signatures).
 * It must be sent back verbatim to the provider that produced it; other providers drop it.
 */
export interface ProviderBlock {
  type: 'provider';
  /** Provider id, e.g. "anthropic". */
  provider: string;
  /** Provider-specific kind, e.g. "thinking", "redacted_thinking", "fallback". */
  kind: string;
  /** JSON-serializable payload, replayed verbatim. */
  data: unknown;
  /**
   * Optional user-visible text carried by this block, e.g. a model-authored progress note.
   * Never raw reasoning. Used to re-render a transcript on resume.
   */
  displayText?: string;
  /** Set when the block is a hosted tool call or its result (see HostedToolActivity). */
  hostedTool?: HostedToolActivity;
}

/** Tools the provider runs itself, within a response (no client-side execution). */
export type HostedToolKind = 'web_search' | 'web_fetch';

/**
 * A hosted tool offered to the model. `allowedDomains` and `blockedDomains` are exclusive;
 * providers send the allowed list when both are set.
 */
export type HostedTool =
  | {
      kind: 'web_search';
      /** Cap on uses per request. */
      maxUses?: number;
      allowedDomains?: string[];
      blockedDomains?: string[];
    }
  | {
      kind: 'web_fetch';
      maxUses?: number;
      allowedDomains?: string[];
      blockedDomains?: string[];
      /** Approximate cap on the tokens of fetched text kept in context. */
      maxContentTokens?: number;
    };

/**
 * What a provider block records about a hosted tool, for display. The call carries `detail`
 * (the search query or the URL); its result, which may arrive in a later message, carries a
 * short `summary` such as "8 results" or the error.
 */
export type HostedToolActivity =
  | { phase: 'call'; id: string; kind: HostedToolKind; detail: string }
  | { phase: 'result'; id: string; kind: HostedToolKind; summary: string; isError: boolean };

export type ContentBlock = TextBlock | ImageBlock | ToolCallBlock | ToolResultBlock | ProviderBlock;

export interface Message {
  role: Role;
  content: ContentBlock[];
}

export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object) describing the tool input. */
  inputSchema: JsonSchema;
}

export interface ModelRequest {
  model: string;
  /** System prompt. Frozen for the lifetime of a session so providers can cache it. */
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  /**
   * Hosted tools to offer, in addition to `tools`. Like the tools, fixed for a session. Providers
   * leave out the ones the model cannot use (see ModelInfo.hostedTools).
   */
  hostedTools?: HostedTool[];
  maxOutputTokens?: number;
  /**
   * `agent` for normal agent turns, `summary` for compaction/summarization requests.
   * Providers may use this to pick cheaper settings.
   */
  purpose?: 'agent' | 'summary';
  signal?: AbortSignal;
}

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'refusal'
  | 'context_window_exceeded'
  | 'pause'
  | 'unknown';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Web searches a hosted tool ran (billed per search on top of tokens). Absent when none. */
  webSearches?: number;
}

export interface RefusalInfo {
  category: string | null;
  explanation: string | null;
}

export type ModelEvent =
  /** The provider accepted the request and started streaming. `model` is the serving model. */
  | { type: 'message_start'; model: string }
  /** The model is reasoning. Reasoning content is never exposed. */
  | { type: 'thinking' }
  /** A short model-authored progress note (e.g. "Checking the failing test"). Not raw reasoning. */
  | { type: 'progress'; text: string }
  | { type: 'text_delta'; text: string }
  /** A tool call started streaming. */
  | { type: 'tool_call_start'; id: string; name: string }
  /** More tool input arrived. `inputBytes` is the total streamed so far for this call. */
  | { type: 'tool_call_delta'; id: string; inputBytes: number }
  /** The model called a hosted tool, which the provider now runs. `detail`: query or URL. */
  | { type: 'hosted_tool_start'; id: string; kind: HostedToolKind; detail: string }
  /** A hosted tool finished. `summary` is short ("8 results", "14 KB") or the error. */
  | {
      type: 'hosted_tool_end';
      id: string;
      kind: HostedToolKind;
      summary: string;
      isError: boolean;
    }
  /** Final event. `message` is the complete assistant message, in order, ready to be stored. */
  | {
      type: 'message_end';
      message: Message;
      stopReason: StopReason;
      /** Usage of the attempt that produced `message`; drives context accounting. */
      usage: Usage;
      /**
       * Tokens billed across every attempt of this turn (e.g. a declined attempt plus the
       * fallback that served it). Absent when equal to `usage`.
       */
      billedUsage?: Usage;
      model: string;
      refusal?: RefusalInfo;
      /** Non-fatal provider notices worth surfacing (e.g. "fallback model served this turn"). */
      notices?: string[];
    };

export interface ModelPricing {
  /** USD per million tokens. */
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
  /** USD per web search run by a hosted tool. */
  webSearchPerRequest?: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  contextWindow: number;
  maxOutputTokens: number;
  description?: string;
  pricing?: ModelPricing;
  /** True when the provider knows this model; false for an unrecognized model string. */
  known: boolean;
  /** Hosted tools the provider can offer with this model (absent: none). */
  hostedTools?: HostedToolKind[];
}

/**
 * A model provider. The agent loop depends only on this interface.
 *
 * `stream` must:
 *  - yield exactly one `message_end` on success (always the last event);
 *  - throw a `ProviderError` (see errors.ts) on failure, including `kind: 'aborted'` when
 *    `request.signal` fires;
 *  - never throw raw SDK errors.
 */
export interface ModelProvider {
  /** Stable provider id, e.g. "anthropic". */
  readonly id: string;
  /** Human name, e.g. "Anthropic". */
  readonly displayName: string;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
  /** Best-effort model metadata. Unknown models get conservative defaults with `known: false`. */
  getModelInfo(model: string): ModelInfo;
  /** Curated list of models to offer in pickers. */
  listModels(): ModelInfo[];
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  const webSearches = (a.webSearches ?? 0) + (b.webSearches ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    ...(webSearches > 0 ? { webSearches } : {}),
  };
}

/** Total prompt tokens a request consumed (uncached + cache reads + cache writes). */
export function promptTokens(usage: Usage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

export function estimateCostUsd(
  usage: Usage,
  pricing: ModelPricing | undefined,
): number | undefined {
  if (!pricing) return undefined;
  return (
    (usage.inputTokens * pricing.inputPerMTok +
      usage.outputTokens * pricing.outputPerMTok +
      usage.cacheReadTokens * pricing.cacheReadPerMTok +
      usage.cacheWriteTokens * pricing.cacheWritePerMTok) /
      1_000_000 +
    (usage.webSearches ?? 0) * (pricing.webSearchPerRequest ?? 0)
  );
}

export function textOf(message: Message): string {
  return message.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
