import type { HostedTool, HostedToolKind } from '@patch/shared';
import type { WebConfig } from '../config/config.js';
import type { ToolCallSummary } from '../tools/types.js';

const VERBS: Record<HostedToolKind, string> = { web_search: 'search', web_fetch: 'fetch' };

/**
 * The hosted tools a session offers, from the user's web settings. Decided when the session's
 * agent is created and never changed while it runs: the tool list is part of the cached prompt
 * prefix.
 */
export function hostedToolsFor(web: WebConfig): HostedTool[] {
  const domains =
    web.allowedDomains.length > 0
      ? { allowedDomains: [...web.allowedDomains] }
      : web.blockedDomains.length > 0
        ? { blockedDomains: [...web.blockedDomains] }
        : {};
  const tools: HostedTool[] = [];
  if (web.search) tools.push({ kind: 'web_search', ...domains });
  if (web.fetch) tools.push({ kind: 'web_fetch', ...domains });
  return tools;
}

/**
 * A URL for display: no scheme, "www." or fragment, e.g.
 * "https://www.example.com/docs/a.html#x" → "example.com/docs/a.html".
 */
export function shortenUrl(url: string): string {
  const text = url.trim();
  if (!URL.canParse(text)) return text;
  const parsed = new URL(text);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return text;
  const host = parsed.host.replace(/^www\./, '');
  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  return `${host}${path}${parsed.search}`;
}

/** Transcript row of a hosted tool call: "search  <query>", "fetch  <url>". */
export function hostedToolSummary(kind: HostedToolKind, detail: string): ToolCallSummary {
  const target = kind === 'web_fetch' ? shortenUrl(detail) : detail.replace(/\s+/g, ' ').trim();
  return { verb: VERBS[kind], target };
}
