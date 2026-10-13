import {
  formatBytes,
  plural,
  type HostedToolActivity,
  type HostedToolKind,
  type Message,
} from '@patch/shared';
import { PROVIDER_ID } from './errors.js';

/** Server tool names that are hosted tools in the provider-neutral protocol. */
const HOSTED_KINDS: Record<string, HostedToolKind> = {
  web_search: 'web_search',
  web_fetch: 'web_fetch',
};

const RESULT_KINDS: Record<string, HostedToolKind> = {
  web_search_tool_result: 'web_search',
  web_fetch_tool_result: 'web_fetch',
};

/** Error codes of web search and web fetch results, as shown to the user. */
const ERROR_TEXT: Record<string, string> = {
  invalid_tool_input: 'invalid input',
  unavailable: 'service unavailable',
  max_uses_exceeded: 'use limit reached',
  too_many_requests: 'rate limited',
  query_too_long: 'query too long',
  request_too_large: 'request too large',
  url_too_long: 'URL too long',
  url_not_allowed: 'URL not allowed',
  url_not_in_prior_context: 'URL not in the conversation',
  url_not_accessible: 'page not accessible',
  unsupported_content_type: 'unsupported content type',
  content_too_large: 'content too large',
};

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** "page not accessible" for url_not_accessible; unknown codes are spelled out. */
export function describeWebToolError(code: unknown): string {
  if (typeof code !== 'string' || code === '') return 'failed';
  return ERROR_TEXT[code] ?? code.replace(/_/g, ' ');
}

/** The hosted tool call a `server_tool_use` block makes (its query or URL as `detail`). */
export function hostedCallActivity(block: Raw): HostedToolActivity | undefined {
  if (block['type'] !== 'server_tool_use' || typeof block['id'] !== 'string') return undefined;
  const kind = typeof block['name'] === 'string' ? HOSTED_KINDS[block['name']] : undefined;
  if (!kind) return undefined;
  const input = isRecord(block['input']) ? block['input'] : {};
  const value = kind === 'web_search' ? input['query'] : input['url'];
  return { phase: 'call', id: block['id'], kind, detail: typeof value === 'string' ? value : '' };
}

/** Decoded size of a fetched document's source (text, or base64 data such as a PDF). */
function documentBytes(source: Raw): number | undefined {
  const data = source['data'];
  if (typeof data !== 'string') return undefined;
  if (source['type'] === 'base64') {
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
  }
  return Buffer.byteLength(data, 'utf8');
}

function fetchSummary(content: Raw): string {
  const document = isRecord(content['content']) ? content['content'] : {};
  const source = isRecord(document['source']) ? document['source'] : {};
  const bytes = documentBytes(source);
  const size = bytes === undefined ? 'fetched' : formatBytes(bytes);
  return source['media_type'] === 'application/pdf' ? `PDF ${size}` : size;
}

/** The outcome a web search or web fetch result block reports ("8 results", "14 KB", an error). */
export function hostedResultActivity(block: Raw): HostedToolActivity | undefined {
  const kind = typeof block['type'] === 'string' ? RESULT_KINDS[block['type']] : undefined;
  if (!kind || typeof block['tool_use_id'] !== 'string') return undefined;
  const id = block['tool_use_id'];
  const content = block['content'];
  // Success: a list of results (search) or a web_fetch_result; failure: one error object.
  if (kind === 'web_search' && Array.isArray(content)) {
    const summary = content.length === 0 ? 'no results' : plural(content.length, 'result');
    return { phase: 'result', id, kind, summary, isError: false };
  }
  if (kind === 'web_fetch' && isRecord(content) && content['type'] === 'web_fetch_result') {
    return { phase: 'result', id, kind, summary: fetchSummary(content), isError: false };
  }
  const code = isRecord(content) ? content['error_code'] : undefined;
  return { phase: 'result', id, kind, summary: describeWebToolError(code), isError: true };
}

/** Short user-visible text for a hosted tool block (also shown by readers unaware of it). */
export function activityText(activity: HostedToolActivity): string {
  if (activity.phase === 'result') return activity.summary;
  const verb = activity.kind === 'web_search' ? 'Searched the web for' : 'Fetched';
  return `${verb} ${activity.detail}`.trim();
}

/** Hosted tool calls stored in a conversation, by id (a result can arrive a response later). */
export function hostedCallsIn(messages: readonly Message[]): Map<string, HostedToolActivity> {
  const calls = new Map<string, HostedToolActivity>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'provider' || block.provider !== PROVIDER_ID) continue;
      if (block.hostedTool?.phase === 'call') calls.set(block.hostedTool.id, block.hostedTool);
    }
  }
  return calls;
}
