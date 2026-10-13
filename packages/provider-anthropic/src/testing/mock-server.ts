/**
 * A local HTTP server that emulates the Anthropic Messages API (`POST /v1/messages`, JSON and
 * SSE streaming) for tests and offline manual verification. It also acts as a conformance
 * checker: requests that would be rejected by the real API (per the documented rules below) get
 * a realistic 400 `invalid_request_error`, and every problem is recorded in `violations`.
 *
 * This file depends only on Node built-ins and uses only erasable TypeScript syntax, so it also
 * runs directly under Node's built-in type stripping (see serve.ts).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A web search result; its `encrypted_content` is generated. */
export interface MockSearchResult {
  url: string;
  title: string;
  page_age?: string;
}

/** A citation of a web search result; its `encrypted_index` is generated. */
export interface MockCitation {
  url: string;
  title: string;
  cited_text: string;
}

export type MockBlock =
  | { type: 'text'; text: string; citations?: MockCitation[] }
  | {
      type: 'tool_use';
      id?: string;
      name: string;
      input: unknown;
      /** Send this raw partial JSON instead of the serialized input. */
      rawJson?: string;
    }
  /** `thinking` is the visible text (progress update or empty). A signature is generated. */
  | { type: 'thinking'; thinking: string }
  | { type: 'redacted_thinking' }
  | { type: 'fallback'; from: string; to: string }
  /** A server tool call, e.g. `web_search` with `{ query }` or `web_fetch` with `{ url }`. */
  | { type: 'server_tool_use'; id?: string; name: string; input: Record<string, unknown> }
  /**
   * The result of a web search: `results`, or an error. `tool_use_id` defaults to the last
   * `web_search` call of the same response.
   */
  | {
      type: 'web_search_tool_result';
      tool_use_id?: string;
      results?: MockSearchResult[];
      error_code?: string;
    }
  /** The result of a web fetch: the page `text`, or an error. `tool_use_id` as above. */
  | {
      type: 'web_fetch_tool_result';
      tool_use_id?: string;
      url?: string;
      title?: string;
      text?: string;
      error_code?: string;
    };

export interface MockMessageResponse {
  content: MockBlock[];
  stop_reason?:
    | 'end_turn'
    | 'tool_use'
    | 'max_tokens'
    | 'stop_sequence'
    | 'refusal'
    | 'pause_turn'
    | 'model_context_window_exceeded';
  stop_details?: { type: 'refusal'; category: string | null; explanation: string | null };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    /**
     * Per-attempt usage, sent verbatim as `usage.iterations` in message_delta (e.g. a declined
     * `message` entry followed by the serving `fallback_message` entry).
     */
    iterations?: Json[];
    /** Server tool counts; by default, the successful web searches and fetches of the content. */
    server_tool_use?: { web_search_requests: number; web_fetch_requests: number };
  };
  /** Model reported in message_start (defaults to the requested model). */
  model?: string;
  /** Delay between SSE events in ms (default 0). */
  delayMs?: number;
  /** Characters per text_delta / input_json_delta event (default 20). */
  chunkSize?: number;
}

export interface MockErrorResponse {
  status: number;
  error: { type: string; message: string };
  /** Emit as a mid-stream SSE `error` event after message_start instead of an HTTP error. */
  midStream?: boolean;
  /** Extra response headers for an HTTP error, e.g. `{ 'retry-after-ms': '10' }`. */
  headers?: Record<string, string>;
}

export type MockResponse = MockMessageResponse | MockErrorResponse;

export interface RecordedRequest {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
  /** Beta names from the anthropic-beta header. */
  betas: string[];
}

export interface MockAnthropicServer {
  /** Base URL to pass as baseUrl / ANTHROPIC_BASE_URL. */
  url: string;
  requests: RecordedRequest[];
  /** Human-readable conformance problems found so far. */
  violations: string[];
  /** Queue responses; each request consumes one (FIFO). */
  enqueue(...responses: Array<MockResponse | ((request: RecordedRequest) => MockResponse)>): void;
  /** Responder used when the queue is empty (default: a short text reply). */
  setFallbackResponder(responder: (request: RecordedRequest) => MockResponse): void;
  close(): Promise<void>;
}

export interface MockServerOptions {
  /** Port to bind (default 0 = random). Host is always 127.0.0.1. */
  port?: number;
  /** Reject non-conforming requests with 400 (default true). Violations are recorded either way. */
  strict?: boolean;
  /** Called for every new violation (e.g. to log it). */
  onViolation?: (violation: string) => void;
  /** Called for every request received, before it is answered. */
  onRequest?: (request: RecordedRequest) => void;
}

type Json = Record<string, unknown>;
type QueuedResponse = MockResponse | ((request: RecordedRequest) => MockResponse);

/** A conformance problem. `reject` carries the error the real API would return. */
interface Problem {
  violation: string;
  reject?: { status: number; type: string; message: string };
}

interface ConversationEntry {
  /** Canonical JSON of {role, block}. */
  key: string;
  /** API-style location, e.g. "messages.2.content.0". */
  path: string;
}

/** A request's conversation in canonical form. */
interface ConversationView {
  system: string;
  tools: string;
  entries: ConversationEntry[];
}

interface IssuedThinking {
  /** The visible thinking text issued with a signature (undefined for redacted_thinking). */
  thinking?: string;
  /** Hash of the conversation before the block, which the block is bound to. */
  binding: string;
}

interface ServerState {
  strict: boolean;
  requests: RecordedRequest[];
  violations: string[];
  queue: QueuedResponse[];
  fallbackResponder: (request: RecordedRequest) => MockResponse;
  conversations: Map<string, ConversationView>;
  issued: Map<string, IssuedThinking>;
  /** Canonical JSON of each server tool block issued, by `serverBlockKey`. */
  issuedServerBlocks: Map<string, string>;
  /** `encrypted_index` values of the citations issued. */
  issuedCitations: Set<string>;
  options: MockServerOptions;
}

const WEB_TOOL_TYPES: Record<string, string[]> = {
  web_search: ['web_search_20250305', 'web_search_20260209', 'web_search_20260318'],
  web_fetch: [
    'web_fetch_20250910',
    'web_fetch_20260209',
    'web_fetch_20260309',
    'web_fetch_20260318',
  ],
};
/** The web tool versions before these dates are the basic ones (no dynamic filtering). */
const BASIC_WEB_TOOL_TYPES = new Set(['web_search_20250305', 'web_fetch_20250910']);
/** Models without programmatic tool calling, which dynamic filtering runs on. */
const NO_DYNAMIC_FILTERING_PATTERN = /^claude-(?:haiku-4-5|(?:opus|sonnet)-4-[0-5]|3)(?:-|$)/;
const BETA_PROGRESS_UPDATES = 'thinking-display-updates-2026-08-18';
const BETA_BLOCK_BINDING = 'thinking-binding-controls-2026-08-01';
const BETA_FALLBACKS_DEFAULT = 'server-side-fallback-2026-07-01';
const BETA_FALLBACKS_LIST = 'server-side-fallback-2026-06-01';
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const FIVE_X_MODEL_PATTERN = /^claude-[a-z]+-5(?:-\d+)?(?:-|$)/;
/** Models released before the 'xhigh' effort level (it arrived with Claude Opus 4.7). */
const NO_XHIGH_EFFORT_PATTERN = /^claude-(?:opus|sonnet)-4-6(?:-|$)/;
const SAMPLING_PARAMS = ['temperature', 'top_p', 'top_k'];
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const IMAGE_MEDIA_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const IMAGE_BLOCK_KEYS = new Set(['type', 'source', 'cache_control', 'transformations']);
const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const DEFAULT_CHUNK_SIZE = 20;
const DEFAULT_REPLY: MockMessageResponse = { content: [{ type: 'text', text: 'Mock response.' }] };

const INVALID_SIGNATURE = 'Invalid `signature` in `thinking` block.';
const BOUND_ELSEWHERE = `${INVALID_SIGNATURE} The block is bound to a different conversation.`;

// ---------------------------------------------------------------------------------------------
// Canonical forms: what the real API compares (block content, not JSON layout or cache markers).

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function withoutKeys(value: unknown, keys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutKeys(item, keys));
  if (!isRecord(value)) return value;
  const result: Json = {};
  for (const [key, item] of Object.entries(value)) {
    if (!keys.has(key)) result[key] = withoutKeys(item, keys);
  }
  return result;
}

const CACHE_CONTROL = new Set(['cache_control']);
/** eager_input_streaming changes how input is streamed, not the prompt. */
const TOOL_TRANSPORT_KEYS = new Set(['cache_control', 'eager_input_streaming']);

/** Message content as a block list (a string is shorthand for one text block). */
function contentBlocks(content: unknown): unknown[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function modelOf(info: unknown): unknown {
  return isRecord(info) ? info['model'] : undefined;
}

/** Canonical block, or undefined for blocks that render as nothing (empty text). */
function canonicalBlock(block: unknown): unknown {
  if (!isRecord(block)) return block;
  switch (block['type']) {
    case 'text': {
      if (block['text'] === '') return undefined;
      // Citations are part of the text the model wrote (and web search ones must be sent back).
      const citations = block['citations'];
      return Array.isArray(citations) && citations.length > 0
        ? { type: 'text', text: block['text'], citations: withoutKeys(citations, CACHE_CONTROL) }
        : { type: 'text', text: block['text'] };
    }
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block['id'],
        name: block['name'],
        input: withoutKeys(block['input'], CACHE_CONTROL),
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block['tool_use_id'],
        content: canonicalContent(block['content']),
        is_error: block['is_error'] === true,
      };
    case 'thinking':
      return { type: 'thinking', thinking: block['thinking'], signature: block['signature'] };
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: block['data'] };
    case 'fallback':
      return {
        type: 'fallback',
        from: { model: modelOf(block['from']) },
        to: { model: modelOf(block['to']) },
      };
    default:
      return withoutKeys(block, CACHE_CONTROL);
  }
}

function canonicalContent(content: unknown): unknown[] {
  return contentBlocks(content)
    .map(canonicalBlock)
    .filter((block) => block !== undefined);
}

function canonicalSystem(system: unknown): string {
  return stableStringify(canonicalContent(system));
}

function canonicalTools(tools: unknown): string {
  return stableStringify(
    Array.isArray(tools) ? tools.map((tool) => withoutKeys(tool, TOOL_TRANSPORT_KEYS)) : [],
  );
}

function entryKey(role: unknown, block: unknown): string {
  return stableStringify({ role, block });
}

function bindingHash(system: string, tools: string, entries: ConversationEntry[]): string {
  const hash = createHash('sha256');
  hash.update(system).update('\u0000').update(tools);
  for (const entry of entries) hash.update('\u0000').update(entry.key);
  return hash.digest('hex');
}

function issuedKey(block: Json): string | undefined {
  if (block['type'] === 'thinking' && typeof block['signature'] === 'string') {
    return `thinking:${block['signature']}`;
  }
  if (block['type'] === 'redacted_thinking' && typeof block['data'] === 'string') {
    return `redacted_thinking:${block['data']}`;
  }
  return undefined;
}

function randomId(prefix: string, bytes = 12): string {
  return `${prefix}${randomBytes(bytes).toString('hex')}`;
}

// ---------------------------------------------------------------------------------------------
// Conformance checks.

function invalid(path: string, message: string, violation?: string): Problem {
  const text = path ? `${path}: ${message}` : message;
  return {
    violation: violation ?? text,
    reject: { status: 400, type: 'invalid_request_error', message: text },
  };
}

function headerValue(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}

function checkHeaders(headers: IncomingMessage['headers']): Problem[] {
  const problems: Problem[] = [];
  const apiKey = headerValue(headers, 'x-api-key');
  const authorization = headerValue(headers, 'authorization');
  if (!apiKey && !/^Bearer \S+/.test(authorization ?? '')) {
    problems.push({
      violation: 'missing credentials: neither x-api-key nor authorization: Bearer was sent',
      reject: {
        status: 401,
        type: 'authentication_error',
        message: 'x-api-key header is required',
      },
    });
  }
  if (!headerValue(headers, 'anthropic-version')) {
    problems.push(invalid('anthropic-version', 'header is required'));
  }
  return problems;
}

function messageList(body: Json): Json[] | undefined {
  const messages = body['messages'];
  if (!Array.isArray(messages)) return undefined;
  return messages.every(isRecord) ? messages : undefined;
}

function checkBasics(body: Json): Problem[] {
  const problems: Problem[] = [];
  if (typeof body['model'] !== 'string' || body['model'] === '') {
    problems.push(invalid('model', 'Field required'));
  }
  const maxTokens = body['max_tokens'];
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1) {
    problems.push(invalid('max_tokens', 'Input should be a positive integer'));
  }
  const messages = body['messages'];
  if (!Array.isArray(messages) || messages.length === 0) {
    problems.push(invalid('messages', 'at least one message is required'));
    return problems;
  }
  messages.forEach((message, i) => {
    if (!isRecord(message)) {
      problems.push(invalid(`messages.${i}`, 'Input should be an object'));
      return;
    }
    if (message['role'] !== 'user' && message['role'] !== 'assistant') {
      problems.push(invalid(`messages.${i}.role`, "Input should be 'user' or 'assistant'"));
    }
    const content = message['content'];
    if (typeof content !== 'string' && !Array.isArray(content)) {
      problems.push(
        invalid(`messages.${i}.content`, 'Input should be a string or a list of blocks'),
      );
    }
    if (content === '' || (Array.isArray(content) && content.length === 0)) {
      problems.push(invalid(`messages.${i}`, 'all messages must have non-empty content'));
    }
    (Array.isArray(content) ? (content as unknown[]) : []).forEach((block, j) => {
      if (isRecord(block) && block['type'] === 'text' && block['text'] === '') {
        problems.push(
          invalid(`messages.${i}.content.${j}.text`, 'text content blocks must be non-empty'),
        );
      }
    });
  });
  if (isRecord(messages[0]) && messages[0]['role'] !== 'user') {
    problems.push(invalid('messages.0.role', 'the first message must use the "user" role'));
  }
  return problems;
}

function checkModelParameters(body: Json): Problem[] {
  const problems: Problem[] = [];
  for (const param of SAMPLING_PARAMS) {
    if (param in body) {
      problems.push(
        invalid(param, `sampling parameters are not supported for this model; remove \`${param}\``),
      );
    }
  }
  const model = typeof body['model'] === 'string' ? body['model'] : '';
  const thinking = body['thinking'];
  if (thinking !== undefined && FIVE_X_MODEL_PATTERN.test(model)) {
    if (!isRecord(thinking) || thinking['type'] !== 'adaptive') {
      const type = isRecord(thinking) ? String(thinking['type']) : typeof thinking;
      problems.push(
        invalid(
          'thinking.type',
          `'${type}' is not supported for ${model}; use 'adaptive' or omit \`thinking\``,
        ),
      );
    }
    if (isRecord(thinking) && 'budget_tokens' in thinking) {
      problems.push(invalid('thinking.budget_tokens', `is not supported for ${model}`));
    }
  }
  const outputConfig = body['output_config'];
  const effort = isRecord(outputConfig) ? outputConfig['effort'] : undefined;
  if (effort === 'xhigh' && NO_XHIGH_EFFORT_PATTERN.test(model)) {
    problems.push(
      invalid(
        'output_config.effort',
        `'xhigh' is not supported for ${model}; use 'low', 'medium', 'high' or 'max'`,
      ),
    );
  }
  const toolChoice = body['tool_choice'];
  if (toolChoice !== undefined) {
    const type = isRecord(toolChoice) ? toolChoice['type'] : undefined;
    if (type !== 'auto' && type !== 'none') {
      problems.push(
        invalid('tool_choice', 'type "tool" and "any" are not supported for this model.'),
      );
    }
  }
  return problems;
}

function checkBetas(body: Json, betas: string[]): Problem[] {
  const problems: Problem[] = [];
  const requires = (path: string, what: string, beta: string) => {
    if (!betas.includes(beta)) {
      problems.push(invalid(path, `${what} requires the \`anthropic-beta: ${beta}\` header`));
    }
  };
  const thinking = body['thinking'];
  if (isRecord(thinking)) {
    if (thinking['display'] === 'updates') {
      requires('thinking.display', "'updates'", BETA_PROGRESS_UPDATES);
    }
    if (thinking['block_binding'] !== undefined && thinking['block_binding'] !== null) {
      requires('thinking.block_binding', 'block_binding', BETA_BLOCK_BINDING);
    }
  }
  const fallbacks = body['fallbacks'];
  if (fallbacks === 'default') requires('fallbacks', '"default"', BETA_FALLBACKS_DEFAULT);
  else if (Array.isArray(fallbacks)) requires('fallbacks', 'a fallback list', BETA_FALLBACKS_LIST);
  return problems;
}

interface Turn {
  role: unknown;
  /** Index of the first message merged into this turn. */
  firstMessage: number;
  blocks: Array<{ block: Json; path: string }>;
}

/** The API merges consecutive same-role messages into one turn before validating tool pairing. */
function mergeTurns(messages: Json[]): Turn[] {
  const turns: Turn[] = [];
  messages.forEach((message, i) => {
    const last = turns.at(-1);
    const turn: Turn =
      last && last.role === message['role']
        ? last
        : { role: message['role'], firstMessage: i, blocks: [] };
    if (turn !== last) turns.push(turn);
    contentBlocks(message['content']).forEach((block, j) => {
      if (isRecord(block)) turn.blocks.push({ block, path: `messages.${i}.content.${j}` });
    });
  });
  return turns;
}

function toolUseIds(turn: Turn | undefined): Set<string> {
  const ids = new Set<string>();
  for (const { block } of turn?.blocks ?? []) {
    if (block['type'] === 'tool_use' && typeof block['id'] === 'string') ids.add(block['id']);
  }
  return ids;
}

function checkToolPairing(messages: Json[]): Problem[] {
  const problems: Problem[] = [];
  const turns = mergeTurns(messages);
  turns.forEach((turn, t) => {
    if (turn.role === 'assistant') {
      const ids = toolUseIds(turn);
      if (ids.size === 0) return;
      const next = turns[t + 1];
      const answered = new Set(
        (next?.role === 'user' ? next.blocks : [])
          .filter(({ block }) => block['type'] === 'tool_result')
          .map(({ block }) => block['tool_use_id']),
      );
      const missing = [...ids].filter((id) => !answered.has(id));
      if (missing.length > 0) {
        problems.push(
          invalid(
            `messages.${turn.firstMessage}`,
            `\`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${missing.join(', ')}. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message.`,
          ),
        );
      }
      return;
    }
    const previousIds = toolUseIds(turns[t - 1]?.role === 'assistant' ? turns[t - 1] : undefined);
    let sawOtherContent = false;
    for (const { block, path } of turn.blocks) {
      if (block['type'] !== 'tool_result') {
        sawOtherContent = true;
        continue;
      }
      if (sawOtherContent) {
        problems.push(
          invalid(
            path,
            '`tool_result` blocks must come before any other content in a user message.',
          ),
        );
      }
      const id = block['tool_use_id'];
      if (typeof id !== 'string' || !previousIds.has(id)) {
        problems.push(
          invalid(
            path,
            `unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${String(id)}. Each \`tool_result\` block must have a corresponding \`tool_use\` block in the previous message.`,
          ),
        );
      }
    }
  });
  return problems;
}

function checkTools(body: Json, messages: Json[]): Problem[] {
  const problems: Problem[] = [];
  const rawTools = body['tools'];
  if (rawTools !== undefined && !Array.isArray(rawTools)) {
    return [invalid('tools', 'Input should be a list')];
  }
  const tools: unknown[] = Array.isArray(rawTools) ? rawTools : [];
  const names = new Set<string>();
  tools.forEach((tool, k) => {
    if (!isRecord(tool)) {
      problems.push(invalid(`tools.${k}`, 'Input should be an object'));
      return;
    }
    const name = tool['name'];
    if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) {
      problems.push(
        invalid(`tools.${k}.name`, `String should match pattern '${TOOL_NAME_PATTERN.source}'`),
      );
    } else if (names.has(name)) {
      problems.push(invalid('tools', `Tool names must be unique (duplicate: ${name}).`));
    } else {
      names.add(name);
    }
    const isCustomTool = tool['type'] === undefined || tool['type'] === 'custom';
    const schema = tool['input_schema'];
    if (isCustomTool && (!isRecord(schema) || schema['type'] !== 'object')) {
      problems.push(invalid(`tools.${k}.input_schema.type`, "Input should be 'object'"));
    }
  });

  let usesTools = false;
  messages.forEach((message, i) => {
    contentBlocks(message['content']).forEach((block, j) => {
      if (!isRecord(block)) return;
      if (block['type'] === 'tool_result') usesTools = true;
      if (block['type'] !== 'tool_use') return;
      usesTools = true;
      const name = block['name'];
      if (names.size > 0 && (typeof name !== 'string' || !names.has(name))) {
        problems.push(
          invalid(
            `messages.${i}.content.${j}.name`,
            `Tool '${String(name)}' is not defined in \`tools\`.`,
          ),
        );
      }
    });
  });
  if (usesTools && names.size === 0) {
    problems.push(
      invalid(
        'tools',
        'Requests which include `tool_use` or `tool_result` blocks must define tools.',
      ),
    );
  }
  return problems;
}

/** The format a base64 image's bytes start with (undefined: none of the supported ones). */
function imageFormatOf(data: string): string | undefined {
  const bytes = Buffer.from(data.slice(0, 32), 'base64');
  const text = bytes.toString('latin1');
  if (text.startsWith('\u0089PNG\r\n\u001a\n')) return 'image/png';
  if (text.startsWith('\u00ff\u00d8\u00ff')) return 'image/jpeg';
  if (/^GIF8[79]a/.test(text)) return 'image/gif';
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

function checkImageBlock(block: Json, path: string): Problem[] {
  const problems: Problem[] = [];
  for (const key of Object.keys(block)) {
    if (!IMAGE_BLOCK_KEYS.has(key)) {
      problems.push(invalid(`${path}.${key}`, 'Extra inputs are not permitted'));
    }
  }
  const source = block['source'];
  if (!isRecord(source)) return [...problems, invalid(`${path}.source`, 'Field required')];
  if (source['type'] !== 'base64') {
    // URL and Files API sources are valid API input, but Patch only sends base64 images.
    return [
      ...problems,
      { violation: `${path}.source.type: expected base64, got ${String(source['type'])}` },
    ];
  }
  const mediaType = source['media_type'];
  if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPES.includes(mediaType)) {
    problems.push(
      invalid(
        `${path}.source.media_type`,
        "Input should be 'image/jpeg', 'image/png', 'image/gif' or 'image/webp'",
      ),
    );
  }
  const data = source['data'];
  if (typeof data !== 'string' || data === '') {
    problems.push(invalid(`${path}.source.data`, 'Field required'));
  } else if (data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
    problems.push(invalid(`${path}.source.data`, 'Image data is not valid base64.'));
  } else if (data.length > MAX_IMAGE_BASE64_BYTES) {
    problems.push(
      invalid(
        `${path}.source.base64`,
        `image exceeds 5 MB maximum: ${data.length} bytes > ${MAX_IMAGE_BASE64_BYTES} bytes`,
      ),
    );
  } else if (typeof mediaType === 'string' && imageFormatOf(data) !== mediaType) {
    problems.push(
      invalid(
        `${path}.source.base64`,
        `The image was specified using the ${mediaType} media type, but the data is not a valid ${mediaType} image.`,
      ),
    );
  }
  return problems;
}

/**
 * Image blocks: only in user messages (directly or in a tool_result's content), with a base64
 * source of a supported media type whose data is valid base64 of that format, at most 5 MB, and
 * no fields the API does not define (a display label must not leak into the request).
 */
function checkImages(messages: Json[]): Problem[] {
  const problems: Problem[] = [];
  messages.forEach((message, i) => {
    contentBlocks(message['content']).forEach((block, j) => {
      if (!isRecord(block)) return;
      const path = `messages.${i}.content.${j}`;
      if (block['type'] === 'image') {
        if (message['role'] !== 'user') {
          problems.push(invalid(path, 'Image blocks are only allowed in user messages.'));
        }
        problems.push(...checkImageBlock(block, path));
      } else if (block['type'] === 'tool_result' && Array.isArray(block['content'])) {
        (block['content'] as unknown[]).forEach((inner, k) => {
          if (isRecord(inner) && inner['type'] === 'image') {
            problems.push(...checkImageBlock(inner, `${path}.content.${k}`));
          }
          if (isRecord(inner) && inner['type'] === 'text' && inner['text'] === '') {
            problems.push(
              invalid(`${path}.content.${k}.text`, 'text content blocks must be non-empty'),
            );
          }
        });
      }
    });
  });
  return problems;
}

/** A bare domain with an optional path: no scheme, and wildcards only in the path. */
function validDomain(entry: string): boolean {
  if (entry === '' || /\s|:\/\//.test(entry)) return false;
  const host = entry.split('/')[0] ?? '';
  return host.includes('.') && !host.includes('*');
}

/** Web search and web fetch definitions: versions, domain lists, and the model's support. */
function checkWebToolDefinitions(body: Json): Problem[] {
  const problems: Problem[] = [];
  const tools: unknown[] = Array.isArray(body['tools']) ? body['tools'] : [];
  const model = typeof body['model'] === 'string' ? body['model'] : '';
  tools.forEach((tool, k) => {
    if (!isRecord(tool) || typeof tool['type'] !== 'string') return;
    const type = tool['type'];
    const family = Object.keys(WEB_TOOL_TYPES).find((name) => type.startsWith(`${name}_`));
    if (family === undefined) return;
    const path = `tools.${k}`;
    if (!WEB_TOOL_TYPES[family]!.includes(type)) {
      problems.push(invalid(`${path}.type`, `Unknown tool type '${type}'`));
      return;
    }
    if (tool['name'] !== family)
      problems.push(invalid(`${path}.name`, `Input should be '${family}'`));
    if ('eager_input_streaming' in tool) {
      problems.push(invalid(`${path}.eager_input_streaming`, 'Extra inputs are not permitted'));
    }
    const lists = (['allowed_domains', 'blocked_domains'] as const).filter(
      (key) => tool[key] !== undefined && tool[key] !== null,
    );
    if (lists.length === 2) {
      problems.push(invalid(path, 'Use either `allowed_domains` or `blocked_domains`, not both.'));
    }
    for (const key of lists) {
      const list = tool[key];
      if (!Array.isArray(list)) {
        problems.push(invalid(`${path}.${key}`, 'Input should be a list'));
        continue;
      }
      list.forEach((domain, d) => {
        if (typeof domain !== 'string' || !validDomain(domain)) {
          problems.push(invalid(`${path}.${key}.${d}`, 'Invalid domain format'));
        }
      });
    }
    const callers = tool['allowed_callers'];
    const direct = Array.isArray(callers) && callers.includes('direct');
    if (!BASIC_WEB_TOOL_TYPES.has(type) && !direct && NO_DYNAMIC_FILTERING_PATTERN.test(model)) {
      problems.push(
        invalid(
          path,
          `\`${type}\` uses programmatic tool calling, which ${model} does not support; set \`allowed_callers: ["direct"]\`.`,
        ),
      );
    }
  });
  return problems;
}

/** The `tool_use_id` of a server tool result block (`<name>_tool_result`), if it is one. */
function serverResultId(block: Json): string | undefined {
  const type = block['type'];
  if (typeof type !== 'string' || type === 'tool_result' || !type.endsWith('_tool_result')) {
    return undefined;
  }
  return typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : undefined;
}

/** Identity of an issued server tool block: its type and call id. */
function serverBlockKey(block: Json): string | undefined {
  if (block['type'] === 'server_tool_use' && typeof block['id'] === 'string') {
    return `server_tool_use:${block['id']}`;
  }
  const resultId = serverResultId(block);
  return resultId === undefined ? undefined : `${String(block['type'])}:${resultId}`;
}

function isErrorContent(content: unknown): boolean {
  return (
    isRecord(content) &&
    typeof content['type'] === 'string' &&
    content['type'].endsWith('_tool_result_error')
  );
}

/** Server tool blocks (and their encrypted content) must come back exactly as issued. */
function checkIssuedServerBlock(block: Json, path: string, state: ServerState): Problem[] {
  const key = serverBlockKey(block);
  if (key === undefined) return [];
  const issued = state.issuedServerBlocks.get(key);
  if (issued === undefined) {
    // A client may answer a call that can no longer run with an error result of its own.
    if (serverResultId(block) !== undefined && isErrorContent(block['content'])) return [];
    return [
      invalid(
        path,
        `\`${String(block['type'])}\` block was not issued by this server.`,
        `${path}: server tool block was not issued by this server`,
      ),
    ];
  }
  if (issued !== stableStringify(canonicalBlock(block))) {
    return [
      invalid(
        path,
        `\`${String(block['type'])}\` block was modified. Send server tool blocks back exactly as received, including \`encrypted_content\`.`,
        `${path}: server tool block differs from the one issued`,
      ),
    ];
  }
  return [];
}

/** Web search citations carry an `encrypted_index` that must come back unmodified. */
function checkCitations(block: Json, path: string, state: ServerState): Problem[] {
  const citations = block['citations'];
  if (!Array.isArray(citations)) return [];
  const problems: Problem[] = [];
  citations.forEach((citation, c) => {
    if (!isRecord(citation) || citation['type'] !== 'web_search_result_location') return;
    const index = citation['encrypted_index'];
    if (typeof index !== 'string' || !state.issuedCitations.has(index)) {
      problems.push(invalid(`${path}.citations.${c}.encrypted_index`, 'Invalid encrypted_index.'));
    }
  });
  return problems;
}

/**
 * Server tool blocks in the history: issued here and unmodified, results answering an earlier
 * call, and no open call (one without a result) followed by anything but the client tool results
 * it waits for; an open call that the request resumes needs its tool.
 */
function checkServerToolHistory(body: Json, messages: Json[], state: ServerState): Problem[] {
  const problems: Problem[] = [];
  const tools: unknown[] = Array.isArray(body['tools']) ? body['tools'] : [];
  const toolNames = new Set(tools.filter(isRecord).map((tool) => tool['name']));
  const turns = mergeTurns(messages);
  const calls = new Set<string>();
  const answered = new Set<string>();
  for (const turn of turns) {
    if (turn.role !== 'assistant') continue;
    for (const { block, path } of turn.blocks) {
      if (block['type'] === 'text') problems.push(...checkCitations(block, path, state));
      if (block['type'] === 'server_tool_use' && typeof block['id'] === 'string') {
        calls.add(block['id']);
      }
      const resultId = serverResultId(block);
      if (resultId !== undefined) {
        if (!calls.has(resultId)) {
          problems.push(
            invalid(
              path,
              `unexpected \`tool_use_id\` found in \`${String(block['type'])}\` block: ${resultId}. It must answer a \`server_tool_use\` block earlier in the conversation.`,
            ),
          );
        }
        answered.add(resultId);
      }
      problems.push(...checkIssuedServerBlock(block, path, state));
    }
  }
  turns.forEach((turn, t) => {
    if (turn.role !== 'assistant') return;
    for (const { block, path } of turn.blocks) {
      const id = block['id'];
      if (block['type'] !== 'server_tool_use' || typeof id !== 'string' || answered.has(id)) {
        continue;
      }
      const name = String(block['name']);
      const next = turns[t + 1];
      const resumable =
        next === undefined ||
        (t + 2 === turns.length &&
          next.blocks.every(({ block: b }) => b['type'] === 'tool_result'));
      if (!resumable) {
        problems.push(
          invalid(
            path,
            `\`${name}\` tool use with id \`${id}\` was found without a corresponding \`${name}_tool_result\` block`,
          ),
        );
      } else if (!toolNames.has(name)) {
        problems.push(
          invalid(
            path,
            `\`${name}\` tool use with id \`${id}\` is waiting to run, but no \`${name}\` tool was provided`,
          ),
        );
      }
    }
  });
  return problems;
}

/** Thinking, redacted_thinking and tool_use blocks before a fallback belong to a declined attempt. */
function checkFallbackEcho(messages: Json[]): Problem[] {
  const problems: Problem[] = [];
  messages.forEach((message, i) => {
    if (message['role'] !== 'assistant') return;
    const blocks = contentBlocks(message['content']);
    let lastFallback = -1;
    blocks.forEach((block, j) => {
      if (isRecord(block) && block['type'] === 'fallback') lastFallback = j;
    });
    blocks.slice(0, Math.max(lastFallback, 0)).forEach((block, j) => {
      const type = isRecord(block) ? block['type'] : undefined;
      if (type === 'thinking' || type === 'redacted_thinking' || type === 'tool_use') {
        problems.push(
          invalid(
            `messages.${i}.content.${j}`,
            `\`${type}\` blocks that precede a \`fallback\` block must be omitted when the response is sent back.`,
          ),
        );
      }
    });
  });
  return problems;
}

/**
 * Verifies every replayed thinking block: the signature must have been issued here, the text
 * must be unmodified, and the conversation before the block must be the one it was created in.
 * Also returns the canonical conversation for the append-only check.
 */
function checkThinkingReplay(
  body: Json,
  messages: Json[],
  issued: Map<string, IssuedThinking>,
): { problems: Problem[]; view: ConversationView } {
  const problems: Problem[] = [];
  const system = canonicalSystem(body['system']);
  const tools = canonicalTools(body['tools']);
  const entries: ConversationEntry[] = [];
  const thinking = body['thinking'];
  const dropsMismatches =
    isRecord(thinking) &&
    isRecord(thinking['block_binding']) &&
    thinking['block_binding']['prefix_mismatch_behavior'] === 'drop_block';

  messages.forEach((message, i) => {
    contentBlocks(message['content']).forEach((block, j) => {
      const path = `messages.${i}.content.${j}`;
      const key = isRecord(block) ? issuedKey(block) : undefined;
      const isThinking =
        isRecord(block) && (block['type'] === 'thinking' || block['type'] === 'redacted_thinking');
      if (isThinking && message['role'] !== 'assistant') {
        problems.push(
          invalid(
            path,
            `\`${String(block['type'])}\` blocks are only allowed in assistant messages.`,
          ),
        );
      } else if (isThinking) {
        const record = key ? issued.get(key) : undefined;
        if (!record) {
          problems.push(
            invalid(
              path,
              INVALID_SIGNATURE,
              `${path}: thinking block signature was not issued by this server`,
            ),
          );
        } else if (record.thinking !== undefined && record.thinking !== block['thinking']) {
          problems.push(
            invalid(
              path,
              INVALID_SIGNATURE,
              `${path}: thinking text differs from the text issued with its signature`,
            ),
          );
        } else if (record.binding !== bindingHash(system, tools, entries)) {
          const violation = `${path}: thinking block replayed after an edit to the conversation before it`;
          problems.push(
            dropsMismatches
              ? { violation: `${violation} (dropped per block_binding)` }
              : invalid(path, BOUND_ELSEWHERE, violation),
          );
        }
      }
      const canonical = canonicalBlock(block);
      if (canonical !== undefined)
        entries.push({ key: entryKey(message['role'], canonical), path });
    });
  });
  return { problems, view: { system, tools, entries } };
}

function conversationKey(messages: Json[]): string | undefined {
  const first = messages[0];
  return first?.['role'] === 'user'
    ? stableStringify(canonicalContent(first['content']))
    : undefined;
}

/** Recorded only: edits invalidate caching and thinking, but the API itself accepts them. */
function checkAppendOnly(
  previous: ConversationView | undefined,
  view: ConversationView,
): Problem[] {
  if (!previous) return [];
  const problems: Problem[] = [];
  if (previous.system !== view.system) {
    problems.push({ violation: 'system prompt changed within a conversation' });
  }
  if (previous.tools !== view.tools) {
    problems.push({ violation: 'tool definitions changed within a conversation' });
  }
  const mismatch = previous.entries.findIndex((entry, k) => view.entries[k]?.key !== entry.key);
  if (mismatch >= 0) {
    const where =
      view.entries[mismatch]?.path ?? `the end of the request (block ${mismatch} is missing)`;
    problems.push({
      violation: `messages are not append-only: ${where} differs from the previous request (${previous.entries[mismatch]?.path})`,
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Responses.

function isErrorResponse(response: MockResponse): response is MockErrorResponse {
  return 'error' in response && 'status' in response;
}

function chunks(text: string, size: number): string[] {
  const codePoints = Array.from(text);
  const result: string[] = [];
  const step = Math.max(1, Math.floor(size));
  for (let i = 0; i < codePoints.length; i += step)
    result.push(codePoints.slice(i, i + step).join(''));
  return result;
}

function parseObject(json: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A response block with its generated ids/signatures, plus what a client would echo back. */
interface PreparedBlock {
  wire: Json;
  /** The canonical block a conforming streaming client sends back (undefined: not echoed). */
  echo: unknown;
  /** Raw JSON streamed for tool_use blocks. */
  json?: string;
}

const DIRECT_CALLER = { type: 'direct' };

function searchResultContent(block: Extract<MockBlock, { type: 'web_search_tool_result' }>) {
  if (block.error_code !== undefined) {
    return { type: 'web_search_tool_result_error', error_code: block.error_code };
  }
  return (block.results ?? []).map((result) => ({
    type: 'web_search_result',
    url: result.url,
    title: result.title,
    encrypted_content: randomBytes(32).toString('base64'),
    page_age: result.page_age ?? null,
  }));
}

function fetchResultContent(block: Extract<MockBlock, { type: 'web_fetch_tool_result' }>) {
  if (block.error_code !== undefined) {
    return { type: 'web_fetch_tool_result_error', error_code: block.error_code };
  }
  return {
    type: 'web_fetch_result',
    url: block.url ?? '',
    content: {
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: block.text ?? '' },
      title: block.title ?? null,
      citations: null,
    },
    retrieved_at: '2026-10-01T12:00:00Z',
  };
}

function prepareBlocks(content: MockBlock[]): PreparedBlock[] {
  let lastFallback = -1;
  content.forEach((block, i) => {
    if (block.type === 'fallback') lastFallback = i;
  });
  /** The last server tool call of each name in this response (results default to it). */
  const lastCall = new Map<string, string>();
  const callFor = (name: string, explicit: string | undefined) =>
    explicit ?? lastCall.get(name) ?? randomId('srvtoolu_mock_');
  return content.map((block, i): PreparedBlock => {
    const declined = i < lastFallback;
    switch (block.type) {
      case 'text': {
        const citations = (block.citations ?? []).map((citation) => ({
          type: 'web_search_result_location',
          url: citation.url,
          title: citation.title,
          cited_text: citation.cited_text,
          encrypted_index: randomBytes(24).toString('base64'),
        }));
        const wire = {
          type: 'text',
          text: block.text,
          citations: citations.length > 0 ? citations : null,
        };
        return { wire, echo: canonicalBlock(wire) };
      }
      case 'server_tool_use': {
        const wire = {
          type: 'server_tool_use',
          id: block.id ?? randomId('srvtoolu_mock_'),
          name: block.name,
          input: block.input,
          caller: DIRECT_CALLER,
        };
        lastCall.set(block.name, wire.id);
        return {
          wire,
          echo: declined ? undefined : canonicalBlock(wire),
          json: JSON.stringify(block.input),
        };
      }
      case 'web_search_tool_result': {
        const wire = {
          type: 'web_search_tool_result',
          tool_use_id: callFor('web_search', block.tool_use_id),
          content: searchResultContent(block),
          caller: DIRECT_CALLER,
        };
        return { wire, echo: canonicalBlock(wire) };
      }
      case 'web_fetch_tool_result': {
        const wire = {
          type: 'web_fetch_tool_result',
          tool_use_id: callFor('web_fetch', block.tool_use_id),
          content: fetchResultContent(block),
          caller: DIRECT_CALLER,
        };
        return { wire, echo: canonicalBlock(wire) };
      }
      case 'tool_use': {
        const json = block.rawJson ?? JSON.stringify(block.input ?? {});
        const parsed = parseObject(json) ?? {};
        const wire = {
          type: 'tool_use',
          id: block.id ?? randomId('toolu_mock_'),
          name: block.name,
        };
        return {
          wire: { ...wire, input: block.rawJson === undefined ? block.input : parsed },
          echo: declined ? undefined : canonicalBlock({ ...wire, input: parsed }),
          json,
        };
      }
      case 'thinking': {
        const wire = {
          type: 'thinking',
          thinking: block.thinking,
          signature: randomBytes(48).toString('base64'),
        };
        return { wire, echo: declined ? undefined : canonicalBlock(wire) };
      }
      case 'redacted_thinking': {
        const wire = { type: 'redacted_thinking', data: randomBytes(96).toString('base64') };
        return { wire, echo: declined ? undefined : canonicalBlock(wire) };
      }
      case 'fallback': {
        const wire = {
          type: 'fallback',
          from: { model: block.from },
          to: { model: block.to },
          trigger: { type: 'refusal', category: null },
        };
        return { wire, echo: canonicalBlock(wire) };
      }
    }
  });
}

/** Remembers the server tool blocks and citations issued, which must come back unmodified. */
function registerServerBlocks(blocks: PreparedBlock[], state: ServerState): void {
  for (const block of blocks) {
    const key = serverBlockKey(block.wire);
    if (key !== undefined) {
      state.issuedServerBlocks.set(key, stableStringify(canonicalBlock(block.wire)));
    }
    const citations = block.wire['citations'];
    if (!Array.isArray(citations)) continue;
    for (const citation of citations) {
      const index = isRecord(citation) ? citation['encrypted_index'] : undefined;
      if (typeof index === 'string') state.issuedCitations.add(index);
    }
  }
}

/** Remembers each thinking block's signature and the conversation it is bound to. */
function registerThinking(
  blocks: PreparedBlock[],
  view: ConversationView,
  issued: Map<string, IssuedThinking>,
): void {
  const entries = [...view.entries];
  for (const block of blocks) {
    const key = issuedKey(block.wire);
    if (key) {
      const thinking =
        block.wire['type'] === 'thinking' ? String(block.wire['thinking']) : undefined;
      issued.set(key, { thinking, binding: bindingHash(view.system, view.tools, entries) });
    }
    if (block.echo !== undefined)
      entries.push({ key: entryKey('assistant', block.echo), path: '' });
  }
}

interface SseEvent {
  event: string;
  data: Json;
}

function blockEvents(index: number, block: PreparedBlock, chunkSize: number): SseEvent[] {
  const start = (contentBlock: Json): SseEvent => ({
    event: 'content_block_start',
    data: { type: 'content_block_start', index, content_block: contentBlock },
  });
  const delta = (payload: Json): SseEvent => ({
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index, delta: payload },
  });
  const stop: SseEvent = {
    event: 'content_block_stop',
    data: { type: 'content_block_stop', index },
  };
  const wire = block.wire;
  switch (wire['type']) {
    case 'text': {
      const citations = Array.isArray(wire['citations']) ? wire['citations'] : [];
      return [
        start({ type: 'text', text: '', citations: null }),
        ...citations.map((citation: unknown) =>
          delta({ type: 'citations_delta', citation: citation as Json }),
        ),
        ...chunks(String(wire['text']), chunkSize).map((text) =>
          delta({ type: 'text_delta', text }),
        ),
        stop,
      ];
    }
    case 'server_tool_use':
      return [
        start({ ...wire, input: {} }),
        ...chunks(block.json ?? '', chunkSize).map((partial) =>
          delta({ type: 'input_json_delta', partial_json: partial }),
        ),
        stop,
      ];
    case 'tool_use':
      return [
        start({ type: 'tool_use', id: wire['id'], name: wire['name'], input: {} }),
        ...chunks(block.json ?? '', chunkSize).map((partial) =>
          delta({ type: 'input_json_delta', partial_json: partial }),
        ),
        stop,
      ];
    case 'thinking':
      return [
        start({ type: 'thinking', thinking: '', signature: '' }),
        ...chunks(String(wire['thinking']), chunkSize).map((text) =>
          delta({ type: 'thinking_delta', thinking: text, estimated_tokens: null }),
        ),
        delta({ type: 'signature_delta', signature: wire['signature'] }),
        stop,
      ];
    default:
      return [start(wire), stop];
  }
}

function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

interface MessagePlan {
  id: string;
  model: string;
  blocks: PreparedBlock[];
  stopReason: string;
  stopDetails: Json | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  iterations?: Json[];
  serverToolUse?: { web_search_requests: number; web_fetch_requests: number };
}

/** Successful searches and fetches (failed ones are not billed). */
function countServerToolUse(blocks: PreparedBlock[]): MessagePlan['serverToolUse'] {
  const succeeded = (type: string) =>
    blocks.filter((b) => b.wire['type'] === type && !isErrorContent(b.wire['content'])).length;
  const searches = succeeded('web_search_tool_result');
  const fetches = succeeded('web_fetch_tool_result');
  return searches + fetches > 0
    ? { web_search_requests: searches, web_fetch_requests: fetches }
    : undefined;
}

function planMessage(response: MockMessageResponse, body: Json, bodyBytes: number): MessagePlan {
  const blocks = prepareBlocks(response.content);
  const serverToolUse = response.usage?.server_tool_use ?? countServerToolUse(blocks);
  const outputChars = blocks.reduce((sum, block) => sum + JSON.stringify(block.wire).length, 0);
  const stopReason =
    response.stop_reason ??
    (response.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
  const defaultDetails =
    stopReason === 'refusal' ? { type: 'refusal', category: null, explanation: null } : null;
  return {
    id: randomId('msg_mock_'),
    model: response.model ?? String(body['model']),
    blocks,
    stopReason,
    stopDetails: response.stop_details ?? defaultDetails,
    usage: {
      input: response.usage?.input_tokens ?? estimateTokens(bodyBytes),
      output: response.usage?.output_tokens ?? estimateTokens(outputChars),
      cacheRead: response.usage?.cache_read_input_tokens ?? 0,
      cacheWrite: response.usage?.cache_creation_input_tokens ?? 0,
    },
    ...(response.usage?.iterations ? { iterations: response.usage.iterations } : {}),
    ...(serverToolUse ? { serverToolUse } : {}),
  };
}

function messageStartEvent(plan: MessagePlan): SseEvent {
  return {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: plan.id,
        type: 'message',
        role: 'assistant',
        model: plan.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: {
          input_tokens: plan.usage.input,
          output_tokens: 1,
          cache_read_input_tokens: plan.usage.cacheRead,
          cache_creation_input_tokens: plan.usage.cacheWrite,
        },
      },
    },
  };
}

function messageEvents(plan: MessagePlan, chunkSize: number): SseEvent[] {
  return [
    messageStartEvent(plan),
    { event: 'ping', data: { type: 'ping' } },
    ...plan.blocks.flatMap((block, index) => blockEvents(index, block, chunkSize)),
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: {
          stop_reason: plan.stopReason,
          stop_sequence: null,
          stop_details: plan.stopDetails,
          container: null,
        },
        usage: {
          input_tokens: plan.usage.input,
          output_tokens: plan.usage.output,
          cache_read_input_tokens: plan.usage.cacheRead,
          cache_creation_input_tokens: plan.usage.cacheWrite,
          ...(plan.iterations ? { iterations: plan.iterations } : {}),
          ...(plan.serverToolUse ? { server_tool_use: plan.serverToolUse } : {}),
        },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

function messageJson(plan: MessagePlan): Json {
  return {
    id: plan.id,
    type: 'message',
    role: 'assistant',
    model: plan.model,
    content: plan.blocks.map((block) => block.wire),
    stop_reason: plan.stopReason,
    stop_sequence: null,
    stop_details: plan.stopDetails,
    usage: {
      input_tokens: plan.usage.input,
      output_tokens: plan.usage.output,
      cache_read_input_tokens: plan.usage.cacheRead,
      cache_creation_input_tokens: plan.usage.cacheWrite,
      ...(plan.iterations ? { iterations: plan.iterations } : {}),
      ...(plan.serverToolUse ? { server_tool_use: plan.serverToolUse } : {}),
    },
  };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    // Failure mid-stream: the status line is gone, so the only signal left is a dropped stream.
    res.destroy();
    return;
  }
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendApiError(
  res: ServerResponse,
  requestId: string,
  status: number,
  error: { type: string; message: string },
  headers: Record<string, string> = {},
): void {
  sendJson(
    res,
    status,
    { type: 'error', error, request_id: requestId },
    { 'request-id': requestId, ...headers },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Writes SSE events, pausing between them; stops early if the client disconnects. */
async function streamEvents(
  res: ServerResponse,
  requestId: string,
  events: SseEvent[],
  delayMs: number,
): Promise<void> {
  let disconnected = false;
  res.once('close', () => {
    disconnected = true;
  });
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'request-id': requestId,
  });
  res.flushHeaders();
  for (const [index, { event, data }] of events.entries()) {
    if (index > 0 && delayMs > 0) await sleep(delayMs);
    if (disconnected || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  res.end();
}

// ---------------------------------------------------------------------------------------------
// Server.

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) parts.push(chunk);
    });
    req.on('end', () => resolve(size <= MAX_BODY_BYTES ? Buffer.concat(parts) : undefined));
    req.on('error', reject);
    req.on('close', () => {
      if (!req.complete) reject(new Error('The client disconnected before sending the body.'));
    });
  });
}

function parseBetas(headers: IncomingMessage['headers']): string[] {
  return (headerValue(headers, 'anthropic-beta') ?? '')
    .split(',')
    .map((beta) => beta.trim())
    .filter((beta) => beta !== '');
}

function record(state: ServerState, requestNumber: number, problems: Problem[]): void {
  for (const problem of problems) {
    const violation = `request ${requestNumber}: ${problem.violation}`;
    state.violations.push(violation);
    state.options.onViolation?.(violation);
  }
}

function conformanceProblems(
  state: ServerState,
  request: RecordedRequest,
  rawHeaders: IncomingMessage['headers'],
): { problems: Problem[]; view?: ConversationView; conversation?: string } {
  const body = request.body;
  const problems = [
    ...checkHeaders(rawHeaders),
    ...checkBasics(body),
    ...checkModelParameters(body),
    ...checkBetas(body, request.betas),
    ...checkWebToolDefinitions(body),
  ];
  const messages = messageList(body);
  if (!messages) return { problems };
  problems.push(
    ...checkToolPairing(messages),
    ...checkTools(body, messages),
    ...checkImages(messages),
    ...checkFallbackEcho(messages),
    ...checkServerToolHistory(body, messages, state),
  );
  const replay = checkThinkingReplay(body, messages, state.issued);
  problems.push(...replay.problems);
  const conversation = conversationKey(messages);
  // A single-message request starts a new conversation rather than editing an old one.
  if (conversation !== undefined && messages.length > 1) {
    problems.push(...checkAppendOnly(state.conversations.get(conversation), replay.view));
  }
  return { problems, view: replay.view, conversation };
}

async function handleRequest(
  state: ServerState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestId = randomId('req_mock_');
  const raw = await readBody(req);
  const requestNumber = state.requests.length + 1;
  const recorded: RecordedRequest = {
    headers: { ...req.headers },
    body: {},
    betas: parseBetas(req.headers),
  };
  state.requests.push(recorded);

  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (req.method !== 'POST' || path !== '/v1/messages') {
    state.options.onRequest?.(recorded);
    record(state, requestNumber, [{ violation: `unsupported endpoint: ${req.method} ${path}` }]);
    sendApiError(res, requestId, 404, {
      type: 'not_found_error',
      message: `Not found: ${req.method} ${path}`,
    });
    return;
  }
  if (raw === undefined) {
    state.options.onRequest?.(recorded);
    record(state, requestNumber, [{ violation: 'request body exceeds the size limit' }]);
    sendApiError(res, requestId, 413, {
      type: 'request_too_large',
      message: 'Request exceeds the maximum allowed size.',
    });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) {
    state.options.onRequest?.(recorded);
    record(state, requestNumber, [{ violation: 'request body is not a JSON object' }]);
    sendApiError(res, requestId, 400, {
      type: 'invalid_request_error',
      message: 'Request body must be a JSON object.',
    });
    return;
  }
  recorded.body = parsed;
  state.options.onRequest?.(recorded);

  const { problems, view, conversation } = conformanceProblems(state, recorded, req.headers);
  record(state, requestNumber, problems);
  const rejection = problems.find((problem) => problem.reject)?.reject;
  if (state.strict && rejection) {
    sendApiError(res, requestId, rejection.status, {
      type: rejection.type,
      message: rejection.message,
    });
    return;
  }

  const queued = state.queue.shift();
  const response =
    typeof queued === 'function' ? queued(recorded) : (queued ?? state.fallbackResponder(recorded));
  const streaming = parsed['stream'] === true;

  if (isErrorResponse(response)) {
    if (response.midStream && streaming) {
      const plan = planMessage({ content: [] }, parsed, raw.length);
      const events: SseEvent[] = [
        messageStartEvent(plan),
        { event: 'error', data: { type: 'error', error: response.error, request_id: requestId } },
      ];
      await streamEvents(res, requestId, events, 0);
      return;
    }
    sendApiError(res, requestId, response.status, response.error, response.headers);
    return;
  }

  const plan = planMessage(response, parsed, raw.length);
  registerServerBlocks(plan.blocks, state);
  if (view) {
    registerThinking(plan.blocks, view, state.issued);
    if (conversation !== undefined) state.conversations.set(conversation, view);
  }
  if (!streaming) {
    sendJson(res, 200, messageJson(plan), { 'request-id': requestId });
    return;
  }
  await streamEvents(
    res,
    requestId,
    messageEvents(plan, response.chunkSize ?? DEFAULT_CHUNK_SIZE),
    response.delayMs ?? 0,
  );
}

/**
 * Conformance rules checked on every request:
 *  - POST /v1/messages; `x-api-key` or `authorization: Bearer` present; `anthropic-version` set.
 *  - Body: model (string), max_tokens (positive int), messages (non-empty array; first role
 *    'user'; roles only user/assistant; no empty messages or empty text blocks).
 *  - No temperature/top_p/top_k; `thinking` absent or type 'adaptive' (no budget_tokens) for
 *    5.x models; no `output_config.effort: 'xhigh'` for Opus/Sonnet 4.6; tool_choice, if
 *    present, must be {type:'auto'} or {type:'none'}.
 *  - Every assistant tool_use id has a matching tool_result in the immediately following user
 *    message; every tool_result references a tool_use in the immediately preceding assistant
 *    message; tool_result blocks come before other blocks in their message. (Consecutive
 *    same-role messages are merged first, as the API does.)
 *  - If any message contains tool_use/tool_result, `tools` must be non-empty and contain every
 *    referenced tool name; tool names match ^[a-zA-Z0-9_-]{1,64}$; input_schema.type === 'object'.
 *  - Betas: thinking.display 'updates' requires thinking-display-updates-2026-08-18;
 *    thinking.block_binding requires thinking-binding-controls-2026-08-01; fallbacks:'default'
 *    requires server-side-fallback-2026-07-01; array fallbacks require server-side-fallback-2026-06-01.
 *  - Thinking blocks sent back must carry a signature this server issued, unmodified.
 *  - Fallback echo rules: an assistant message must not contain thinking, redacted_thinking or
 *    tool_use blocks before its last `fallback` block.
 *  - Web tools: `web_search_*` / `web_fetch_*` definitions use a known version and the matching
 *    name, never `eager_input_streaming`, at most one of allowed_domains/blocked_domains (bare
 *    domains, wildcards only in the path), and the dynamic-filtering versions only on models
 *    with programmatic tool calling (or with `allowed_callers: ["direct"]`).
 *  - Server tool blocks sent back (server_tool_use, `*_tool_result`) must be the ones issued,
 *    unmodified (including `encrypted_content`); a client may add an error result of its own for
 *    a call that never ran. Web search citations must carry an issued `encrypted_index`. Every
 *    result answers an earlier call; a call without a result must be in the last turn (a paused
 *    turn being continued) or be followed only by a last turn of client tool results, and its
 *    tool must then be defined.
 *  - Append-only check per conversation (keyed by the first user message): compared with the
 *    previous request of the same conversation, `system` and `tools` must be identical and the
 *    previous `messages` must be a prefix of the new ones (ignoring cache_control placement).
 *    Violations are recorded (and with strict, a request replaying a thinking block after an edit
 *    is rejected like the real API: "Invalid `signature` in `thinking` block. The block is bound
 *    to a different conversation.").
 *
 * Implementation notes: a thinking block is bound to a hash of the conversation before it
 * (system, tools ignoring cache_control/eager_input_streaming, and every earlier block), as
 * computed when it was issued; a replay whose preceding conversation hashes differently is the
 * "edit" above. With `thinking.block_binding.prefix_mismatch_behavior: 'drop_block'` such a
 * block is recorded as dropped instead of rejected, as the API does. A request with a single
 * message starts a new conversation. "Previous request" means the previous request answered
 * with a message; rejected and error-answered requests do not change conversation state, and
 * rejected requests do not consume a queued response.
 */
export async function startMockAnthropicServer(
  options: MockServerOptions = {},
): Promise<MockAnthropicServer> {
  const state: ServerState = {
    strict: options.strict ?? true,
    requests: [],
    violations: [],
    queue: [],
    fallbackResponder: () => DEFAULT_REPLY,
    conversations: new Map(),
    issued: new Map(),
    issuedServerBlocks: new Map(),
    issuedCitations: new Set(),
    options,
  };

  const server = createServer((req, res) => {
    handleRequest(state, req, res).catch(() => {
      sendApiError(res, randomId('req_mock_'), 500, {
        type: 'api_error',
        message: 'Internal mock server error.',
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;

  return {
    url: `http://127.0.0.1:${port}`,
    requests: state.requests,
    violations: state.violations,
    enqueue(...responses) {
      state.queue.push(...responses);
    },
    setFallbackResponder(responder) {
      state.fallbackResponder = responder;
    },
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
