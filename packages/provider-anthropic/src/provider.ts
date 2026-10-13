import Anthropic, { BadRequestError, type ClientOptions } from '@anthropic-ai/sdk';
import {
  oneLine,
  type ModelEvent,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
} from '@patch/shared';
import { abortedError, apiErrorDetails, toProviderError } from './errors.js';
import { hostedCallsIn } from './hosted-tools.js';
import {
  ANTHROPIC_MODELS,
  WEB_SEARCH_USD_PER_REQUEST,
  findAnthropicModel,
  type AnthropicEffort,
  type AnthropicModelEntry,
} from './models.js';
import { buildMessagesRequest, type RequestFeatures } from './request.js';
import {
  detectHealAction,
  healActionKey,
  type HealAction,
  type HealableFeature,
} from './self-heal.js';
import { StreamAccumulator } from './stream.js';

/** Minimal logger shape so this package does not depend on @patch/core. */
export interface ProviderLogger {
  debug(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

export interface AnthropicProviderOptions {
  /** Sent as x-api-key. */
  apiKey?: string;
  /** Sent as a bearer token (ANTHROPIC_AUTH_TOKEN). */
  authToken?: string;
  /** Overrides https://api.anthropic.com (also used by tests to target the mock server). */
  baseUrl?: string;
  /** Sent as anthropic-workspace-id: required by API keys that belong to a whole organization. */
  workspaceId?: string;
  /**
   * Reasoning effort for models that support it. Default 'high' for agent requests. A level the
   * model does not accept (e.g. 'xhigh' on Opus 4.6) is clamped to the nearest one it does.
   */
  effort?: AnthropicEffort;
  /** SDK retries for 408/409/429/5xx/connection errors. Default 2. */
  maxRetries?: number;
  /** Per-request timeout in ms. Default 10 minutes. */
  timeoutMs?: number;
  /** Server-side refusal fallbacks on supported models. Default true. */
  fallbacks?: boolean;
  logger?: ProviderLogger;
}

const DEFAULT_EFFORT: AnthropicEffort = 'high';
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const FEATURE_NAMES: Record<HealableFeature, string> = {
  progressUpdates: 'progress updates (thinking.display "updates")',
  blockBinding: 'thinking.block_binding',
  serverFallbacks: 'server-side fallbacks',
  eagerInputStreaming: 'eager_input_streaming',
  webSearch: 'web search',
  webFetch: 'web fetch',
};

/** Features whose loss the user notices: a notice says why they stopped working. */
const VISIBLE_FEATURES: Partial<Record<HealableFeature, string>> = {
  webSearch: 'Web search',
  webFetch: 'Web fetch',
};

const MAX_REASON_CHARS = 160;

function toModelInfo(entry: AnthropicModelEntry): ModelInfo {
  const web = entry.capabilities.webTools !== false;
  return {
    id: entry.id,
    label: entry.label,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    known: entry.known,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.pricing
      ? {
          pricing: {
            ...entry.pricing,
            ...(web ? { webSearchPerRequest: WEB_SEARCH_USD_PER_REQUEST } : {}),
          },
        }
      : {}),
    ...(web ? { hostedTools: ['web_search' as const, 'web_fetch' as const] } : {}),
  };
}

/** Routes the SDK's own log output to the provider logger; without one the SDK stays silent. */
function sdkLogging(
  logger: ProviderLogger | undefined,
): Pick<ClientOptions, 'logger' | 'logLevel'> {
  if (!logger) return { logLevel: 'off' };
  const warn = (message: string, ...rest: unknown[]) =>
    logger.warn(`anthropic sdk: ${message}`, rest.length > 0 ? rest : undefined);
  const debug = (message: string, ...rest: unknown[]) =>
    logger.debug(`anthropic sdk: ${message}`, rest.length > 0 ? rest : undefined);
  // 'warn' keeps the SDK's request-detail debug logging (which can include bodies) off.
  return { logLevel: 'warn', logger: { error: warn, warn, info: debug, debug } };
}

/**
 * Anthropic implementation of ModelProvider on the official SDK (`client.beta.messages.create`
 * with `stream: true`; raw stream events are accumulated here, not with the SDK's message helper,
 * so invalid streamed tool JSON can be handled per block).
 *
 * Request mapping:
 *  - system: one text block with `cache_control: {type:'ephemeral'}`; plus top-level
 *    `cache_control: {type:'ephemeral'}` (automatic caching of the conversation tail).
 *  - tools: {name, description, input_schema, eager_input_streaming: true (if supported)}, then
 *    the hosted tools: web_search → {type:'web_search_20260209'|'web_search_20250305',
 *    name:'web_search', max_uses, allowed_domains | blocked_domains}, web_fetch likewise
 *    ('web_fetch_20260209'|'web_fetch_20250910', plus max_content_tokens); the dynamic-filtering
 *    versions on models with webTools 'dynamic', the basic ones on 'basic', none otherwise.
 *  - messages: text → text (plus its citations, kept in providerData); image → image
 *    {source: {type:'base64', media_type, data}} (the label is never sent); tool_call → tool_use
 *    {id,name,input}; tool_result → tool_result {tool_use_id, content, is_error}, where content is
 *    the text, or [text, ...images] when the result has images; provider blocks with provider ===
 *    'anthropic' → their `data` verbatim; provider blocks from other providers are dropped. A
 *    server tool call left without its result by a turn that ended early (see
 *    closeAbandonedServerToolCalls) gets an `unavailable` error result in the request.
 *  - Per capabilities (models.ts): thinking {type:'adaptive', display:'updates' (when
 *    progressUpdates), block_binding:{prefix_mismatch_behavior:'drop_block'} (when blockBinding)};
 *    output_config.effort (when effort; 'low' for purpose 'summary'; clamped to the model's
 *    effort levels, e.g. 'xhigh' → 'high' on Opus/Sonnet 4.6); fallbacks:'default' (when
 *    serverFallbacks and enabled); with the matching `betas`.
 *  - max_tokens: request.maxOutputTokens ?? min(64000, model max output).
 *  - Never sends temperature/top_p/top_k or a forced tool_choice.
 *
 * Stream mapping:
 *  - message_start → {message_start, model}
 *  - thinking block start → {thinking}; when display 'updates' was requested, a thinking block
 *    with non-empty text → {progress, text} at block stop (other thinking text, such as the
 *    summaries 4.6 models return by default, is kept for replay but never surfaced). The full
 *    thinking block {type, thinking, signature} is kept as a ProviderBlock (kind 'thinking',
 *    displayText = the progress text when surfaced); redacted_thinking likewise (kind
 *    'redacted_thinking').
 *  - text deltas → {text_delta}; citations (start and citations_delta) → TextBlock.providerData.
 *  - tool_use start/delta/stop → {tool_call_start}, {tool_call_delta, inputBytes}; at stop the
 *    accumulated JSON is parsed strictly; failure → ToolCallBlock with input {}, inputError,
 *    rawInput. Non-object JSON is also an inputError.
 *  - server_tool_use web_search/web_fetch → ProviderBlock (kind 'server_tool_use', hostedTool
 *    call with the query or URL) and {hosted_tool_start} at block stop; web_search_tool_result /
 *    web_fetch_tool_result → ProviderBlock (hostedTool result: "8 results", "14 KB" or the error)
 *    and {hosted_tool_end} (preceded by a start when the call was in an earlier response).
 *    usage.server_tool_use.web_search_requests → Usage.webSearches.
 *  - fallback blocks → ProviderBlock kind 'fallback' + a notice "<from> declined; <to> continued".
 *    After a mid-output fallback, thinking/redacted_thinking/tool_use blocks before the last
 *    fallback block are dropped from the stored message (API echo rules).
 *  - unknown block types → ProviderBlock (kind = block type) kept verbatim.
 *  - message_delta stop_reason → StopReason (refusal → also `refusal` from stop_details;
 *    model_context_window_exceeded → 'context_window_exceeded'; pause_turn → 'pause').
 *  - usage → Usage (input, output, cache_read_input_tokens, cache_creation_input_tokens) of the
 *    attempt that produced the message; the sum of usage.iterations (every attempt, including
 *    ones a server-side fallback replaced) → message_end.billedUsage when it differs.
 *
 * Errors → ProviderError: AuthenticationError → auth; PermissionDeniedError → permission;
 * NotFoundError → not_found; RateLimitError → rate_limit; status 529/overloaded_error →
 * overloaded; BadRequestError mentioning prompt length/context → context_length, else
 * invalid_request; APIConnectionTimeoutError → timeout; APIConnectionError → network;
 * InternalServerError/5xx → server; APIUserAbortError or aborted signal → aborted.
 * Mid-stream `error` SSE events map the same way by error type.
 *
 * Self-healing (per provider instance, remembered for later requests):
 *  - 400 mentioning `fallbacks` → disable fallbacks and retry once.
 *  - 400 mentioning `display`/`updates` → stop requesting progress updates and retry once.
 *  - 400 mentioning `block_binding` → stop sending block_binding and retry once.
 *  - 400 mentioning `eager_input_streaming` → stop sending it and retry once.
 *  - 400 mentioning web search / web fetch (e.g. disabled for the organization), unless it is
 *    about blocks in the history → stop offering that tool, retry once, and add a notice.
 *  - 400 about an invalid thinking `signature` → retry once with all thinking/redacted_thinking
 *    blocks stripped from the request.
 * Retries happen only if nothing was yielded yet for that request.
 *
 * Implementation notes: disabled features are remembered per model id. The thinking blocks
 * stripped after a signature error are remembered by signature, so later requests in the same
 * conversation omit exactly those blocks while keeping the ones produced afterwards.
 */
export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic';
  protected readonly options: AnthropicProviderOptions;
  private client: Anthropic | undefined;
  private readonly disabledFeatures = new Map<string, Set<HealableFeature>>();
  private readonly rejectedThinking = new Set<string>();

  constructor(options: AnthropicProviderOptions = {}) {
    this.options = options;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const { signal } = request;
    const model = findAnthropicModel(request.model);
    const attemptedHeals = new Set<string>();
    const priorCalls = hostedCallsIn(request.messages);
    const notices: string[] = [];

    for (;;) {
      if (signal?.aborted) throw abortedError();
      const built = buildMessagesRequest(request, model, {
        features: this.featuresFor(model),
        effort: this.options.effort ?? DEFAULT_EFFORT,
        rejectedThinking: this.rejectedThinking,
      });
      this.options.logger?.debug('anthropic request', {
        model: request.model,
        messages: built.params.messages.length,
        tools: built.params.tools?.length ?? 0,
        betas: built.params.betas ?? [],
      });

      const accumulator = new StreamAccumulator(request.model, {
        progressUpdates: built.sent.progressUpdates,
        priorCalls,
      });
      let yielded = false;
      try {
        const events = await this.getClient().beta.messages.create(built.params, { signal });
        for await (const event of events) {
          for (const modelEvent of accumulator.push(event)) {
            yielded = true;
            yield modelEvent;
          }
        }
        // The SDK ends the stream quietly when the signal aborts it.
        if (signal?.aborted) throw abortedError();
        const end = accumulator.finish();
        yield notices.length > 0 ? { ...end, notices: [...notices, ...(end.notices ?? [])] } : end;
        return;
      } catch (error) {
        const heal = yielded
          ? undefined
          : detectHealAction(error, built.sent, built.thinkingBlockKeys.length);
        if (heal && !attemptedHeals.has(healActionKey(heal)) && !signal?.aborted) {
          attemptedHeals.add(healActionKey(heal));
          const notice = this.applyHeal(heal, model.id, built.thinkingBlockKeys, error);
          if (notice) notices.push(notice);
          continue;
        }
        throw toProviderError(error, signal);
      }
    }
  }

  getModelInfo(model: string): ModelInfo {
    return toModelInfo(findAnthropicModel(model));
  }

  /** The recommended models (shown in pickers); other catalog entries still resolve by id. */
  listModels(): ModelInfo[] {
    return ANTHROPIC_MODELS.filter((entry) => entry.recommended).map(toModelInfo);
  }

  private getClient(): Anthropic {
    // Every option is passed explicitly (null instead of undefined) so the SDK does not fall
    // back to ANTHROPIC_* environment variables; configuration is resolved by the caller.
    this.client ??= new Anthropic({
      apiKey: this.options.apiKey ?? null,
      authToken: this.options.authToken ?? null,
      baseURL: this.options.baseUrl ?? null,
      maxRetries: this.options.maxRetries ?? DEFAULT_MAX_RETRIES,
      timeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(this.options.workspaceId
        ? { defaultHeaders: { 'anthropic-workspace-id': this.options.workspaceId } }
        : {}),
      ...sdkLogging(this.options.logger),
    });
    return this.client;
  }

  private featuresFor(model: AnthropicModelEntry): RequestFeatures {
    const capabilities = model.capabilities;
    const disabled = this.disabledFeatures.get(model.id);
    const healed = (feature: HealableFeature) => disabled?.has(feature) ?? false;
    const enabled = (feature: Exclude<HealableFeature, 'webSearch' | 'webFetch'>): boolean =>
      capabilities[feature] && !healed(feature);
    const webTool = (feature: 'webSearch' | 'webFetch') =>
      capabilities.webTools !== false && !healed(feature);
    return {
      adaptiveThinking: capabilities.adaptiveThinking,
      effort: capabilities.effort,
      progressUpdates: enabled('progressUpdates'),
      blockBinding: enabled('blockBinding'),
      serverFallbacks: this.options.fallbacks !== false && enabled('serverFallbacks'),
      eagerInputStreaming: enabled('eagerInputStreaming'),
      webTools: capabilities.webTools,
      webSearch: webTool('webSearch'),
      webFetch: webTool('webFetch'),
    };
  }

  /** Applies a heal; returns a notice for the user when they lose something they would notice. */
  private applyHeal(
    action: HealAction,
    modelId: string,
    thinkingBlockKeys: string[],
    error: unknown,
  ): string | undefined {
    if (action.type === 'strip_thinking') {
      for (const key of thinkingBlockKeys) this.rejectedThinking.add(key);
      this.options.logger?.warn(
        `Anthropic API rejected ${thinkingBlockKeys.length} thinking block signature(s); ` +
          'retrying without those blocks.',
      );
      return undefined;
    }
    let disabled = this.disabledFeatures.get(modelId);
    if (!disabled) {
      disabled = new Set();
      this.disabledFeatures.set(modelId, disabled);
    }
    disabled.add(action.feature);
    this.options.logger?.warn(
      `Anthropic API rejected ${FEATURE_NAMES[action.feature]} for ${modelId}; ` +
        'retrying without it (remembered for this session).',
    );
    const visible = VISIBLE_FEATURES[action.feature];
    if (!visible) return undefined;
    const reason =
      error instanceof BadRequestError ? apiErrorDetails(error).message?.trim() : undefined;
    return (
      `${visible} is unavailable, so Patch continues without it` +
      (reason ? `: ${oneLine(reason, MAX_REASON_CHARS)}` : '.')
    );
  }
}

/** True when credentials are available for the provider (does not validate them). */
export function hasAnthropicCredentials(
  options: Pick<AnthropicProviderOptions, 'apiKey' | 'authToken'>,
): boolean {
  return Boolean(options.apiKey || options.authToken);
}
