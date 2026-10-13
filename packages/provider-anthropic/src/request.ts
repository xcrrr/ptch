import type {
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaThinkingConfigAdaptive,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaWebFetchTool20250910,
  BetaWebFetchTool20260209,
  BetaWebSearchTool20250305,
  BetaWebSearchTool20260209,
  MessageCreateParamsStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type {
  ContentBlock,
  HostedTool,
  HostedToolKind,
  ImageBlock,
  Message,
  ModelRequest,
  TextBlock,
  ToolResultBlock,
  ToolSpec,
} from '@patch/shared';
import { PROVIDER_ID } from './errors.js';
import {
  clampEffort,
  type AnthropicEffort,
  type AnthropicModelEntry,
  type WebToolsSupport,
} from './models.js';

export const BETA_PROGRESS_UPDATES = 'thinking-display-updates-2026-08-18';
export const BETA_BLOCK_BINDING = 'thinking-binding-controls-2026-08-01';
export const BETA_SERVER_FALLBACKS = 'server-side-fallback-2026-07-01';

/** Output cap per response unless the request sets one (the model's own maximum still applies). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

/** Effort for `purpose: 'summary'` requests: summaries do not need deep reasoning. */
export const SUMMARY_EFFORT: AnthropicEffort = 'low';

/** Server tools whose call and result blocks follow `<name>` / `<name>_tool_result`. */
const NAMED_RESULT_SERVER_TOOLS = new Set([
  'web_search',
  'web_fetch',
  'code_execution',
  'bash_code_execution',
  'text_editor_code_execution',
]);

/** Request features in effect for one request: model capabilities minus self-healed ones. */
export interface RequestFeatures {
  adaptiveThinking: boolean;
  progressUpdates: boolean;
  blockBinding: boolean;
  effort: boolean;
  serverFallbacks: boolean;
  eagerInputStreaming: boolean;
  /** Web tool versions the model takes (see AnthropicModelCapabilities.webTools). */
  webTools: WebToolsSupport;
  /** The web tools the API has not rejected so far. */
  webSearch: boolean;
  webFetch: boolean;
}

/** Optional request parameters that were actually sent (used to attribute a 400 to one of them). */
export interface SentFeatures {
  progressUpdates: boolean;
  blockBinding: boolean;
  serverFallbacks: boolean;
  eagerInputStreaming: boolean;
  webSearch: boolean;
  webFetch: boolean;
}

export interface BuildRequestOptions {
  features: RequestFeatures;
  /** Effort for agent requests (clamped to the levels the model accepts). */
  effort: AnthropicEffort;
  /** Keys (see thinkingBlockKey) of thinking blocks the API rejected; they are not sent again. */
  rejectedThinking?: ReadonlySet<string>;
}

export interface BuiltRequest {
  params: MessageCreateParamsStreaming;
  sent: SentFeatures;
  /** Keys of the thinking / redacted_thinking blocks included in `params.messages`. */
  thinkingBlockKeys: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Identity of a stored thinking or redacted_thinking block (its signature or opaque data). */
export function thinkingBlockKey(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  if (data['type'] === 'thinking' && typeof data['signature'] === 'string') {
    return `thinking:${data['signature']}`;
  }
  if (data['type'] === 'redacted_thinking' && typeof data['data'] === 'string') {
    return `redacted_thinking:${data['data']}`;
  }
  return undefined;
}

class MessageMapper {
  readonly thinkingBlockKeys: string[] = [];

  constructor(private readonly rejectedThinking: ReadonlySet<string>) {}

  mapMessages(messages: Message[]): BetaMessageParam[] {
    const result: BetaMessageParam[] = [];
    for (const message of messages) {
      const content = this.mapContent(message.content);
      // An empty message is invalid; dropping it lets the API merge the neighbouring turns.
      if (content.length > 0) result.push({ role: message.role, content });
    }
    return result;
  }

  private mapContent(blocks: ContentBlock[]): BetaContentBlockParam[] {
    const result: BetaContentBlockParam[] = [];
    for (const block of blocks) {
      const mapped = this.mapBlock(block);
      if (mapped) result.push(mapped);
    }
    return result;
  }

  private mapBlock(block: ContentBlock): BetaContentBlockParam | undefined {
    switch (block.type) {
      case 'text':
        // The API rejects empty text blocks.
        return block.text === ''
          ? undefined
          : { type: 'text', text: block.text, ...textData(block) };
      case 'image':
        return mapImage(block);
      case 'tool_call':
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          content: toolResultContent(block),
          ...(block.isError ? { is_error: true } : {}),
        };
      case 'provider':
        return this.mapProviderBlock(block.provider, block.data);
    }
  }

  /** Anthropic blocks are replayed verbatim (never modified); other providers' blocks are dropped. */
  private mapProviderBlock(provider: string, data: unknown): BetaContentBlockParam | undefined {
    if (provider !== PROVIDER_ID || !isRecord(data) || typeof data['type'] !== 'string') {
      return undefined;
    }
    const key = thinkingBlockKey(data);
    if (key !== undefined) {
      if (this.rejectedThinking.has(key)) return undefined;
      this.thinkingBlockKeys.push(key);
    }
    return data as unknown as BetaContentBlockParam;
  }
}

/** A base64 image block. The label is for display only and never sent. */
function mapImage(block: ImageBlock): BetaImageBlockParam {
  return {
    type: 'image',
    source: { type: 'base64', media_type: block.mediaType, data: block.data },
  };
}

/**
 * A result's text, or its text followed by its images (an empty text is left out: the API rejects
 * empty text blocks). Results without images keep the plain string form.
 */
function toolResultContent(block: ToolResultBlock): BetaToolResultBlockParam['content'] {
  const images = block.images ?? [];
  if (images.length === 0) return block.content;
  return [
    ...(block.content === '' ? [] : [{ type: 'text' as const, text: block.content }]),
    ...images.map(mapImage),
  ];
}

/** This provider's extra text fields (citations, whose references must be sent back). */
function textData(block: TextBlock): Record<string, unknown> {
  const extra = block.providerData;
  return extra?.provider === PROVIDER_ID && isRecord(extra.data) ? extra.data : {};
}

/** A server tool call block that expects a `<name>_tool_result` block, as {id, name}. */
function serverToolCall(block: unknown): { id: string; name: string } | undefined {
  if (!isRecord(block) || block['type'] !== 'server_tool_use') return undefined;
  const { id, name } = block;
  return typeof id === 'string' && typeof name === 'string' && NAMED_RESULT_SERVER_TOOLS.has(name)
    ? { id, name }
    : undefined;
}

function resultToolUseId(block: unknown): string | undefined {
  if (!isRecord(block) || typeof block['type'] !== 'string') return undefined;
  if (block['type'] === 'tool_result' || !block['type'].endsWith('_tool_result')) return undefined;
  const id = block['tool_use_id'];
  return typeof id === 'string' ? id : undefined;
}

function blocksOf(message: BetaMessageParam): BetaContentBlockParam[] {
  return Array.isArray(message.content) ? message.content : [];
}

function isToolResult(block: unknown): boolean {
  return isRecord(block) && block['type'] === 'tool_result';
}

/** An `unavailable` error result answering a server tool call that can no longer run. */
function unavailableResult({ id, name }: { id: string; name: string }): BetaContentBlockParam {
  return {
    type: `${name}_tool_result`,
    tool_use_id: id,
    content: { type: `${name}_tool_result_error`, error_code: 'unavailable' },
  } as unknown as BetaContentBlockParam;
}

/**
 * A server tool call stays open until its result block arrives, which can be in a later
 * response: a paused turn continues it, and a call made alongside client tools runs once their
 * results are sent (the next response then starts with its result). The API rejects a request in
 * which an open call is followed by anything else, which happens when a turn ends early
 * (interrupted while paused or while client tools ran, or stopped at a limit) and the
 * conversation goes on. Such calls are answered here with an `unavailable` error result: right
 * after the client tool results when the call was waiting for them (where the API would have put
 * the real result), else at the end of the message that made the call. Both places come after
 * everything an earlier request of the conversation sent, so requests stay append-only; the
 * stored history is left as it is.
 */
function closeAbandonedServerToolCalls(messages: BetaMessageParam[]): BetaMessageParam[] {
  const answered = new Set<string>();
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      const id = resultToolUseId(block);
      if (id !== undefined) answered.add(id);
    }
  }
  // Turns: runs of consecutive same-role messages, which the API merges.
  const turns: number[][] = [];
  messages.forEach((message, index) => {
    const last = turns.at(-1);
    if (last && messages[last[0]!]!.role === message.role) last.push(index);
    else turns.push([index]);
  });

  /** Results to append to a message, by message index. */
  const appended = new Map<number, BetaContentBlockParam[]>();
  /** An assistant message of results to insert before block `at` of message `index`. */
  const inserted = new Map<number, { at: number; blocks: BetaContentBlockParam[] }>();
  turns.forEach((turn, t) => {
    if (messages[turn[0]!]!.role !== 'assistant') return;
    const open = turn.flatMap((index) =>
      blocksOf(messages[index]!)
        .map(serverToolCall)
        .filter((call): call is { id: string; name: string } => call !== undefined)
        .filter((call) => !answered.has(call.id))
        .map((call) => ({ ...call, index })),
    );
    const next = turns[t + 1];
    if (open.length === 0 || next === undefined) return;
    const nextBlocks = next.flatMap((index) => blocksOf(messages[index]!));
    if (!isToolResult(nextBlocks[0])) {
      for (const call of open) {
        appended.set(call.index, [...(appended.get(call.index) ?? []), unavailableResult(call)]);
      }
      return;
    }
    // Waiting for client tool results: still resumable when the request ends with them.
    if (t + 2 === turns.length && nextBlocks.every(isToolResult)) return;
    let at = { index: next.at(-1)!, block: blocksOf(messages[next.at(-1)!]!).length };
    for (const index of next) {
      const position = blocksOf(messages[index]!).findIndex((block) => !isToolResult(block));
      if (position >= 0) {
        at = { index, block: position };
        break;
      }
    }
    inserted.set(at.index, { at: at.block, blocks: open.map(unavailableResult) });
  });
  if (appended.size === 0 && inserted.size === 0) return messages;

  const result: BetaMessageParam[] = [];
  messages.forEach((message, index) => {
    const content = [...blocksOf(message), ...(appended.get(index) ?? [])];
    const insertion = inserted.get(index);
    if (!insertion) {
      result.push({ ...message, content });
      return;
    }
    const before = content.slice(0, insertion.at);
    const after = content.slice(insertion.at);
    if (before.length > 0) result.push({ role: message.role, content: before });
    result.push({ role: 'assistant', content: insertion.blocks });
    if (after.length > 0) result.push({ role: message.role, content: after });
  });
  return result;
}

function mapTool(tool: ToolSpec, eagerInputStreaming: boolean): BetaTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as BetaTool.InputSchema,
    ...(eagerInputStreaming ? { eager_input_streaming: true } : {}),
  };
}

/** `allowed_domains` or `blocked_domains` (never both: the API rejects that). */
function domainFilter(tool: HostedTool): {
  allowed_domains?: string[];
  blocked_domains?: string[];
} {
  if (tool.allowedDomains && tool.allowedDomains.length > 0) {
    return { allowed_domains: [...tool.allowedDomains] };
  }
  if (tool.blockedDomains && tool.blockedDomains.length > 0) {
    return { blocked_domains: [...tool.blockedDomains] };
  }
  return {};
}

/** Server tool definition; never with `eager_input_streaming`, which server tools do not take. */
function mapHostedTool(tool: HostedTool, version: 'dynamic' | 'basic'): BetaToolUnion {
  const common = {
    ...(tool.maxUses !== undefined ? { max_uses: tool.maxUses } : {}),
    ...domainFilter(tool),
  };
  if (tool.kind === 'web_search') {
    const search: BetaWebSearchTool20260209 | BetaWebSearchTool20250305 =
      version === 'dynamic'
        ? { type: 'web_search_20260209', name: 'web_search', ...common }
        : { type: 'web_search_20250305', name: 'web_search', ...common };
    return search;
  }
  const fetchOptions = {
    ...common,
    ...(tool.maxContentTokens !== undefined ? { max_content_tokens: tool.maxContentTokens } : {}),
  };
  const fetch: BetaWebFetchTool20260209 | BetaWebFetchTool20250910 =
    version === 'dynamic'
      ? { type: 'web_fetch_20260209', name: 'web_fetch', ...fetchOptions }
      : { type: 'web_fetch_20250910', name: 'web_fetch', ...fetchOptions };
  return fetch;
}

/** The hosted tools this request can send: not rejected so far, each kind once. */
function enabledHostedTools(tools: HostedTool[], features: RequestFeatures): HostedTool[] {
  const enabled: Record<HostedToolKind, boolean> = {
    web_search: features.webSearch,
    web_fetch: features.webFetch,
  };
  const seen = new Set<HostedToolKind>();
  return tools.filter((tool) => {
    if (!enabled[tool.kind] || seen.has(tool.kind)) return false;
    seen.add(tool.kind);
    return true;
  });
}

function thinkingConfig(
  progressUpdates: boolean,
  blockBinding: boolean,
): BetaThinkingConfigAdaptive {
  return {
    type: 'adaptive',
    ...(progressUpdates ? { display: 'updates' as const } : {}),
    ...(blockBinding ? { block_binding: { prefix_mismatch_behavior: 'drop_block' as const } } : {}),
  };
}

function systemBlocks(system: string): BetaTextBlockParam[] | undefined {
  if (system === '') return undefined;
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

/**
 * Builds the streaming Messages API request for a ModelRequest. Only parameters the model
 * supports (and that have not been self-healed away) are sent; sampling parameters and
 * tool_choice are never sent. Effort is clamped to a level the model accepts. Hosted tools follow
 * the client tools, in the versions the model takes.
 */
export function buildMessagesRequest(
  request: ModelRequest,
  model: AnthropicModelEntry,
  options: BuildRequestOptions,
): BuiltRequest {
  const { features } = options;
  const mapper = new MessageMapper(options.rejectedThinking ?? new Set());
  const messages = closeAbandonedServerToolCalls(mapper.mapMessages(request.messages));
  const system = systemBlocks(request.system);
  const eager = features.eagerInputStreaming && request.tools.length > 0;
  const progressUpdates = features.adaptiveThinking && features.progressUpdates;
  const blockBinding = features.adaptiveThinking && features.blockBinding;
  const effort = clampEffort(
    request.purpose === 'summary' ? SUMMARY_EFFORT : options.effort,
    model.capabilities.effortLevels,
  );
  const webVersion = features.webTools;
  const hosted = webVersion ? enabledHostedTools(request.hostedTools ?? [], features) : [];
  const tools: BetaToolUnion[] = [
    ...request.tools.map((t) => mapTool(t, eager)),
    ...(webVersion ? hosted.map((t) => mapHostedTool(t, webVersion)) : []),
  ];

  const betas: string[] = [];
  if (progressUpdates) betas.push(BETA_PROGRESS_UPDATES);
  if (blockBinding) betas.push(BETA_BLOCK_BINDING);
  if (features.serverFallbacks) betas.push(BETA_SERVER_FALLBACKS);

  const params: MessageCreateParamsStreaming = {
    model: request.model,
    max_tokens:
      request.maxOutputTokens ?? Math.min(DEFAULT_MAX_OUTPUT_TOKENS, model.maxOutputTokens),
    messages,
    stream: true,
    cache_control: { type: 'ephemeral' },
    ...(system ? { system } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(features.adaptiveThinking
      ? { thinking: thinkingConfig(progressUpdates, blockBinding) }
      : {}),
    ...(features.effort ? { output_config: { effort } } : {}),
    ...(features.serverFallbacks ? { fallbacks: 'default' as const } : {}),
    ...(betas.length > 0 ? { betas } : {}),
  };

  return {
    params,
    sent: {
      progressUpdates,
      blockBinding,
      serverFallbacks: features.serverFallbacks,
      eagerInputStreaming: eager,
      webSearch: hosted.some((t) => t.kind === 'web_search'),
      webFetch: hosted.some((t) => t.kind === 'web_fetch'),
    },
    thinkingBlockKeys: mapper.thinkingBlockKeys,
  };
}
