import type {
  ContentBlock,
  HostedTool,
  Message,
  ModelEvent,
  ProviderBlock,
  TextBlock,
} from '@patch/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeServers,
  collect,
  continueWith,
  lastBody,
  makeProvider,
  makeRequest,
  startServer,
  userText,
} from './helpers.js';

afterEach(closeServers);

const WEB_TOOLS: HostedTool[] = [{ kind: 'web_search' }, { kind: 'web_fetch' }];

function hostedEvents(events: ModelEvent[]) {
  return events.filter((e) => e.type === 'hosted_tool_start' || e.type === 'hosted_tool_end');
}

function providerBlocks(content: ContentBlock[]): ProviderBlock[] {
  return content.filter((b): b is ProviderBlock => b.type === 'provider');
}

function toolsOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return (body['tools'] ?? []) as Array<Record<string, unknown>>;
}

function toolResult(toolCallId: string, content: string): Message {
  return { role: 'user', content: [{ type: 'tool_result', toolCallId, content }] };
}

describe('AnthropicProvider web tools: request', () => {
  it('sends the dynamic-filtering versions after the client tools on Claude 4.6 and later', async () => {
    const server = await startServer();
    await collect(
      makeProvider(server).stream(
        makeRequest({
          hostedTools: [
            { kind: 'web_search', maxUses: 5, allowedDomains: ['docs.python.org'] },
            { kind: 'web_fetch', blockedDomains: ['example.com'], maxContentTokens: 20_000 },
          ],
        }),
      ),
    );
    const tools = toolsOf(lastBody(server));
    expect(tools.map((t) => t['name'])).toEqual(['read_file', 'web_search', 'web_fetch']);
    expect(tools[1]).toEqual({
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: 5,
      allowed_domains: ['docs.python.org'],
    });
    expect(tools[2]).toEqual({
      type: 'web_fetch_20260209',
      name: 'web_fetch',
      blocked_domains: ['example.com'],
      max_content_tokens: 20_000,
    });
    expect(tools[0]).toHaveProperty('eager_input_streaming', true);
    expect(server.violations).toEqual([]);
  });

  it('sends the basic versions to Claude Haiku 4.5', async () => {
    const server = await startServer();
    await collect(
      makeProvider(server).stream(
        makeRequest({ model: 'claude-haiku-4-5', hostedTools: WEB_TOOLS }),
      ),
    );
    expect(toolsOf(lastBody(server)).slice(1)).toEqual([
      { type: 'web_search_20250305', name: 'web_search' },
      { type: 'web_fetch_20250910', name: 'web_fetch' },
    ]);
    expect(server.violations).toEqual([]);
  });

  it('offers no web tools to a model it does not know', async () => {
    const server = await startServer();
    await collect(
      makeProvider(server).stream(makeRequest({ model: 'claude-next', hostedTools: WEB_TOOLS })),
    );
    expect(toolsOf(lastBody(server)).map((t) => t['name'])).toEqual(['read_file']);
  });

  it('sends hosted tools without client tools, each kind once, and only the allowed domains', async () => {
    const server = await startServer();
    await collect(
      makeProvider(server).stream(
        makeRequest({
          tools: [],
          hostedTools: [
            { kind: 'web_search', allowedDomains: ['a.dev'], blockedDomains: ['b.dev'] },
            { kind: 'web_search', maxUses: 1 },
          ],
        }),
      ),
    );
    expect(toolsOf(lastBody(server))).toEqual([
      { type: 'web_search_20260209', name: 'web_search', allowed_domains: ['a.dev'] },
    ]);
    expect(server.violations).toEqual([]);
  });
});

describe('AnthropicProvider web tools: responses', () => {
  it('reports a search, keeps its blocks and citations, and sends them back verbatim', async () => {
    const server = await startServer();
    server.enqueue({
      content: [
        { type: 'text', text: 'Searching.' },
        { type: 'server_tool_use', name: 'web_search', input: { query: 'vitest 4 release' } },
        {
          type: 'web_search_tool_result',
          results: [
            { url: 'https://vitest.dev/blog/vitest-4', title: 'Vitest 4' },
            { url: 'https://github.com/vitest-dev/vitest/releases', title: 'Releases' },
          ],
        },
        {
          type: 'text',
          text: 'Vitest 4 is out.',
          citations: [
            { url: 'https://vitest.dev/blog/vitest-4', title: 'Vitest 4', cited_text: 'Vitest 4' },
          ],
        },
      ],
    });
    const provider = makeProvider(server);
    const request = makeRequest({ hostedTools: WEB_TOOLS });
    const { events, end } = await collect(provider.stream(request));

    const call = providerBlocks(end.message.content)[0];
    const id = call?.hostedTool?.id ?? '';
    expect(id).toMatch(/^srvtoolu_/);
    expect(hostedEvents(events)).toEqual([
      { type: 'hosted_tool_start', id, kind: 'web_search', detail: 'vitest 4 release' },
      { type: 'hosted_tool_end', id, kind: 'web_search', summary: '2 results', isError: false },
    ]);
    expect(providerBlocks(end.message.content).map((b) => [b.kind, b.displayText])).toEqual([
      ['server_tool_use', 'Searched the web for vitest 4 release'],
      ['web_search_tool_result', '2 results'],
    ]);
    const cited = end.message.content.at(-1) as TextBlock;
    expect(cited.text).toBe('Vitest 4 is out.');
    expect(cited.providerData?.provider).toBe('anthropic');
    expect(end.usage.webSearches).toBe(1);

    server.enqueue({ content: [{ type: 'text', text: 'Anything else?' }] });
    await collect(provider.stream(continueWith(request, end.message, userText('Thanks'))));
    const echoed = (lastBody(server)['messages'] as Array<{ content: unknown[] }>)[1]?.content;
    expect(echoed?.[3]).toMatchObject({ type: 'text', citations: [{ url: expect.any(String) }] });
    expect(server.violations).toEqual([]);
  });

  it('summarizes fetched pages and error results', async () => {
    const server = await startServer();
    server.enqueue({
      content: [
        { type: 'server_tool_use', name: 'web_fetch', input: { url: 'https://a.dev/guide' } },
        { type: 'web_fetch_tool_result', url: 'https://a.dev/guide', text: 'x'.repeat(14_336) },
        { type: 'server_tool_use', name: 'web_fetch', input: { url: 'https://b.dev/missing' } },
        { type: 'web_fetch_tool_result', error_code: 'url_not_accessible' },
        { type: 'server_tool_use', name: 'web_search', input: { query: 'more' } },
        { type: 'web_search_tool_result', error_code: 'max_uses_exceeded' },
        { type: 'text', text: 'Done.' },
      ],
    });
    const { events, end } = await collect(
      makeProvider(server).stream(makeRequest({ hostedTools: WEB_TOOLS })),
    );
    expect(
      hostedEvents(events)
        .filter((e) => e.type === 'hosted_tool_end')
        .map((e) => [e.kind, e.summary, e.isError]),
    ).toEqual([
      ['web_fetch', '14 KB', false],
      ['web_fetch', 'page not accessible', true],
      ['web_search', 'use limit reached', true],
    ]);
    expect(end.usage.webSearches).toBeUndefined();
    expect(end.stopReason).toBe('end_turn');
  });

  it('continues a paused turn without a user message; the result names the earlier call', async () => {
    const server = await startServer();
    server.enqueue({
      content: [
        { type: 'text', text: 'Looking it up.' },
        { type: 'server_tool_use', id: 'srvtoolu_p1', name: 'web_search', input: { query: 'q' } },
      ],
      stop_reason: 'pause_turn',
    });
    const provider = makeProvider(server);
    const request = makeRequest({ hostedTools: WEB_TOOLS });
    const first = await collect(provider.stream(request));
    expect(first.end.stopReason).toBe('pause');
    expect(hostedEvents(first.events)).toEqual([
      { type: 'hosted_tool_start', id: 'srvtoolu_p1', kind: 'web_search', detail: 'q' },
    ]);

    server.enqueue({
      content: [
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_p1',
          results: [{ url: 'https://a.dev', title: 'A' }],
        },
        { type: 'text', text: 'Found it.' },
      ],
    });
    const continued = { ...request, messages: [...request.messages, first.end.message] };
    const second = await collect(provider.stream(continued));
    expect(hostedEvents(second.events)).toEqual([
      { type: 'hosted_tool_start', id: 'srvtoolu_p1', kind: 'web_search', detail: 'q' },
      {
        type: 'hosted_tool_end',
        id: 'srvtoolu_p1',
        kind: 'web_search',
        summary: '1 result',
        isError: false,
      },
    ]);
    const messages = lastBody(server)['messages'] as Array<{ role: string }>;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(server.violations).toEqual([]);
  });

  it('answers a paused call that never ran when the conversation goes on', async () => {
    const server = await startServer();
    server.enqueue({
      content: [{ type: 'server_tool_use', name: 'web_search', input: { query: 'q' } }],
      stop_reason: 'pause_turn',
    });
    const provider = makeProvider(server);
    const request = makeRequest({ hostedTools: WEB_TOOLS });
    const { end } = await collect(provider.stream(request));

    // The turn was interrupted before the continuation: the user writes again.
    server.enqueue({ content: [{ type: 'text', text: 'OK.' }] });
    const next = continueWith(request, end.message, userText('Never mind.'));
    const result = await collect(provider.stream(next));
    expect(result.end.stopReason).toBe('end_turn');
    const sent = lastBody(server)['messages'] as Array<{ role: string; content: unknown[] }>;
    expect(sent[1]?.content.at(-1)).toEqual({
      type: 'web_search_tool_result',
      tool_use_id: expect.stringMatching(/^srvtoolu_/),
      content: { type: 'web_search_tool_result_error', error_code: 'unavailable' },
    });
    // The repair is computed, not stored, and the same history gives the same request.
    expect(next.messages[1]).toBe(end.message);
    expect(server.violations).toEqual([]);
  });

  it('runs a call made alongside a client tool once the tool result is sent', async () => {
    const server = await startServer();
    server.enqueue({
      content: [
        {
          type: 'server_tool_use',
          id: 'srvtoolu_f',
          name: 'web_fetch',
          input: { url: 'https://a.dev' },
        },
        { type: 'tool_use', id: 'toolu_r', name: 'read_file', input: { path: 'a.txt' } },
      ],
    });
    const provider = makeProvider(server);
    const request = makeRequest({ hostedTools: WEB_TOOLS });
    const first = await collect(provider.stream(request));
    expect(first.end.stopReason).toBe('tool_use');

    server.enqueue({
      content: [
        {
          type: 'web_fetch_tool_result',
          tool_use_id: 'srvtoolu_f',
          url: 'https://a.dev',
          text: 'hi',
        },
        { type: 'text', text: 'Both read.' },
      ],
    });
    const next = continueWith(request, first.end.message, toolResult('toolu_r', 'file text'));
    const second = await collect(provider.stream(next));
    expect(hostedEvents(second.events)).toEqual([
      { type: 'hosted_tool_start', id: 'srvtoolu_f', kind: 'web_fetch', detail: 'https://a.dev' },
      {
        type: 'hosted_tool_end',
        id: 'srvtoolu_f',
        kind: 'web_fetch',
        summary: '2 B',
        isError: false,
      },
    ]);
    expect(server.violations).toEqual([]);
  });

  it('answers such a call right after the tool results when the turn was interrupted', async () => {
    const server = await startServer();
    server.enqueue({
      content: [
        {
          type: 'server_tool_use',
          id: 'srvtoolu_f',
          name: 'web_fetch',
          input: { url: 'https://a.dev' },
        },
        { type: 'tool_use', id: 'toolu_r', name: 'read_file', input: { path: 'a.txt' } },
      ],
    });
    const provider = makeProvider(server);
    const request = makeRequest({ hostedTools: WEB_TOOLS });
    const { end } = await collect(provider.stream(request));

    server.enqueue({ content: [{ type: 'text', text: 'Stopped.' }] });
    const interrupted: Message = {
      role: 'user',
      content: [
        { type: 'tool_result', toolCallId: 'toolu_r', content: 'Interrupted', isError: true },
        { type: 'text', text: '[The user interrupted this response.]' },
      ],
    };
    await collect(provider.stream(continueWith(request, end.message, interrupted)));
    const sent = lastBody(server)['messages'] as Array<{ role: string; content: unknown[] }>;
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(sent[3]?.content).toEqual([
      {
        type: 'web_fetch_tool_result',
        tool_use_id: 'srvtoolu_f',
        content: { type: 'web_fetch_tool_result_error', error_code: 'unavailable' },
      },
    ]);
    expect(server.violations).toEqual([]);
  });

  it('stops offering a web tool the API refuses, and says so', async () => {
    const server = await startServer();
    server.enqueue(
      {
        status: 400,
        error: {
          type: 'invalid_request_error',
          message: 'Web search is not enabled for this organization.',
        },
      },
      { content: [{ type: 'text', text: 'ok' }] },
      { content: [{ type: 'text', text: 'again' }] },
    );
    const provider = makeProvider(server);
    const { end } = await collect(provider.stream(makeRequest({ hostedTools: WEB_TOOLS })));
    expect(toolsOf(lastBody(server)).map((t) => t['name'])).toEqual(['read_file', 'web_fetch']);
    expect(end.notices).toEqual([
      'Web search is unavailable, so Patch continues without it: Web search is not enabled for this organization.',
    ]);

    const later = await collect(provider.stream(makeRequest({ hostedTools: WEB_TOOLS })));
    expect(toolsOf(lastBody(server)).map((t) => t['name'])).toEqual(['read_file', 'web_fetch']);
    expect(later.end.notices).toBeUndefined();
  });
});
