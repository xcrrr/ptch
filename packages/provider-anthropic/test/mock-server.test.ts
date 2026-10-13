import { afterEach, describe, expect, it } from 'vitest';
import type { MockAnthropicServer } from '../src/testing/mock-server.js';
import { closeServers, startServer } from './helpers.js';

afterEach(closeServers);

type Body = Record<string, unknown>;

interface PostOptions {
  headers?: Record<string, string>;
  betas?: string[];
  path?: string;
  rawBody?: string;
}

async function post(server: MockAnthropicServer, body: Body, options: PostOptions = {}) {
  const response = await fetch(`${server.url}${options.path ?? '/v1/messages'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01',
      ...(options.betas ? { 'anthropic-beta': options.betas.join(',') } : {}),
      ...options.headers,
    },
    body: options.rawBody ?? JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

async function postJson(server: MockAnthropicServer, body: Body, options: PostOptions = {}) {
  const { status, headers, text } = await post(server, body, options);
  return { status, headers, json: JSON.parse(text) as Body };
}

function parseSse(text: string): Array<{ event: string; data: Body }> {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.trim() !== '')
    .map((chunk) => {
      const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? '';
      const data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? '{}') as Body;
      return { event, data };
    });
}

function baseBody(overrides: Body = {}): Body {
  return {
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

const TOOLS = [
  { name: 'read_file', description: 'Read', input_schema: { type: 'object', properties: {} } },
];

function errorMessage(json: Body): string {
  return String((json['error'] as Body)['message']);
}

describe('mock server responses', () => {
  it('streams the documented SSE event sequence with chunked deltas', async () => {
    const server = await startServer();
    server.enqueue({
      content: [
        { type: 'thinking', thinking: 'Note.' },
        { type: 'text', text: 'abcdefgh' },
        { type: 'tool_use', id: 'toolu_x', name: 'read_file', input: { path: 'a' } },
      ],
      chunkSize: 3,
    });
    const { status, headers, text } = await post(server, baseBody({ stream: true, tools: TOOLS }));

    expect(status).toBe(200);
    expect(headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(headers.get('request-id')).toMatch(/^req_mock_/);
    const events = parseSse(text);
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'ping',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    for (const { event, data } of events) expect(data['type']).toBe(event);
    const deltas = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => e.data['delta'] as Body);
    expect(deltas.slice(0, 3)).toEqual([
      { type: 'thinking_delta', thinking: 'Not', estimated_tokens: null },
      { type: 'thinking_delta', thinking: 'e.', estimated_tokens: null },
      { type: 'signature_delta', signature: expect.any(String) },
    ]);
    expect(deltas.slice(3, 6).map((d) => d['text'])).toEqual(['abc', 'def', 'gh']);
    expect(
      deltas
        .slice(6)
        .map((d) => d['partial_json'])
        .join(''),
    ).toBe('{"path":"a"}');
    expect(events.at(-2)?.data['delta']).toMatchObject({
      stop_reason: 'tool_use',
      stop_details: null,
    });
    expect(server.violations).toEqual([]);
  });

  it('answers non-streaming requests with a JSON message', async () => {
    const server = await startServer();
    server.enqueue({
      content: [{ type: 'text', text: 'Hi' }],
      stop_reason: 'refusal',
      usage: { input_tokens: 7, output_tokens: 3 },
    });
    const { status, json } = await postJson(server, baseBody());
    expect(status).toBe(200);
    expect(json).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: 'Hi' }],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: null, explanation: null },
      usage: { input_tokens: 7, output_tokens: 3 },
    });
  });

  it('serves queued responses in order, then the fallback responder', async () => {
    const server = await startServer();
    server.enqueue({ content: [{ type: 'text', text: 'one' }] }, (request) => ({
      content: [{ type: 'text', text: `saw ${String(request.body['model'])}` }],
    }));
    const texts: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const { json } = await postJson(server, baseBody());
      texts.push((json['content'] as Body[])[0]?.['text']);
    }
    server.setFallbackResponder(() => ({ content: [{ type: 'text', text: 'custom' }] }));
    const { json } = await postJson(server, baseBody());
    texts.push((json['content'] as Body[])[0]?.['text']);
    expect(texts).toEqual(['one', 'saw claude-opus-5-5', 'Mock response.', 'custom']);
  });

  it('does not consume a queued response for a rejected request', async () => {
    const server = await startServer();
    server.enqueue({ content: [{ type: 'text', text: 'queued' }] });
    expect((await post(server, baseBody({ temperature: 0.5 }))).status).toBe(400);
    const { json } = await postJson(server, baseBody());
    expect((json['content'] as Body[])[0]?.['text']).toBe('queued');
  });

  it('records every request with its betas', async () => {
    const server = await startServer();
    await post(server, baseBody(), { betas: ['a-beta', 'b-beta'] });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.betas).toEqual(['a-beta', 'b-beta']);
    expect(server.requests[0]?.body['model']).toBe('claude-opus-5-5');
  });

  it('returns scripted HTTP errors with their headers', async () => {
    const server = await startServer();
    server.enqueue({
      status: 529,
      error: { type: 'overloaded_error', message: 'Overloaded' },
      headers: { 'retry-after': '3' },
    });
    const { status, headers, json } = await postJson(server, baseBody({ stream: true }));
    expect(status).toBe(529);
    expect(headers.get('retry-after')).toBe('3');
    expect(json).toMatchObject({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    });
    expect(json['request_id']).toBe(headers.get('request-id'));
  });

  it('emits a mid-stream error event after message_start', async () => {
    const server = await startServer();
    server.enqueue({ status: 500, error: { type: 'api_error', message: 'boom' }, midStream: true });
    const { status, text } = await post(server, baseBody({ stream: true }));
    expect(status).toBe(200);
    const events = parseSse(text);
    expect(events.map((e) => e.event)).toEqual(['message_start', 'error']);
    expect(events[1]?.data['error']).toEqual({ type: 'api_error', message: 'boom' });
  });

  it('answers unknown endpoints and malformed bodies like the API', async () => {
    const server = await startServer();
    const notFound = await postJson(server, {}, { path: '/v1/complete' });
    expect(notFound.status).toBe(404);
    expect(notFound.json['error']).toMatchObject({ type: 'not_found_error' });
    const malformed = await postJson(server, {}, { rawBody: '{"model":' });
    expect(malformed.status).toBe(400);
    expect(server.violations).toEqual([
      'request 1: unsupported endpoint: POST /v1/complete',
      'request 2: request body is not a JSON object',
    ]);
  });

  it('can be closed more than once', async () => {
    const server = await startServer();
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
  });
});

describe('mock server conformance checks', () => {
  it('requires credentials and anthropic-version', async () => {
    const server = await startServer();
    const noKey = await postJson(server, baseBody(), { headers: { 'x-api-key': '' } });
    expect(noKey.status).toBe(401);
    expect(noKey.json['error']).toMatchObject({ type: 'authentication_error' });
    const noVersion = await postJson(server, baseBody(), { headers: { 'anthropic-version': '' } });
    expect(noVersion.status).toBe(400);
    expect(errorMessage(noVersion.json)).toBe('anthropic-version: header is required');
    const bearer = await post(server, baseBody(), {
      headers: { 'x-api-key': '', authorization: 'Bearer tok' },
    });
    expect(bearer.status).toBe(200);
    expect(server.violations).toHaveLength(2);
  });

  const invalidBodies: Array<[string, Body, RegExp]> = [
    ['a missing model', { model: undefined }, /^model: Field required$/],
    ['a non-positive max_tokens', { max_tokens: 0 }, /^max_tokens: /],
    ['no messages', { messages: [] }, /^messages: at least one message/],
    [
      'an assistant first message',
      { messages: [{ role: 'assistant', content: 'x' }] },
      /^messages\.0\.role: the first message/,
    ],
    [
      'an unknown role',
      {
        messages: [
          { role: 'user', content: 'x' },
          { role: 'system', content: 'y' },
        ],
      },
      /^messages\.1\.role: /,
    ],
    [
      'an empty text block',
      { messages: [{ role: 'user', content: [{ type: 'text', text: '' }] }] },
      /text content blocks must be non-empty/,
    ],
    ['an empty message', { messages: [{ role: 'user', content: [] }] }, /non-empty content/],
    ['temperature', { temperature: 1 }, /^temperature: sampling parameters/],
    ['top_p', { top_p: 0.9 }, /^top_p: sampling parameters/],
    ['top_k', { top_k: 5 }, /^top_k: sampling parameters/],
    [
      'disabled thinking on a 5.x model',
      { thinking: { type: 'disabled' } },
      /^thinking\.type: 'disabled' is not supported/,
    ],
    [
      'a thinking budget on a 5.x model',
      { thinking: { type: 'enabled', budget_tokens: 2048 } },
      /thinking\.type: 'enabled'/,
    ],
    ['forced tool choice', { tool_choice: { type: 'any' } }, /^tool_choice: type "tool" and "any"/],
    [
      'xhigh effort on a 4.6 model',
      { model: 'claude-sonnet-4-6', output_config: { effort: 'xhigh' } },
      /^output_config\.effort: 'xhigh' is not supported for claude-sonnet-4-6/,
    ],
  ];

  it.each(invalidBodies)('rejects %s', async (_name, overrides, expected) => {
    const server = await startServer();
    const { status, json } = await postJson(server, baseBody(overrides));
    expect(status).toBe(400);
    expect(json['error']).toMatchObject({ type: 'invalid_request_error' });
    expect(errorMessage(json)).toMatch(expected);
    expect(server.violations.length).toBeGreaterThan(0);
  });

  it('accepts what the API accepts', async () => {
    const server = await startServer();
    const accepted: Body[] = [
      { thinking: { type: 'adaptive' } },
      { tool_choice: { type: 'auto' }, tools: TOOLS },
      { tool_choice: { type: 'none' }, tools: TOOLS },
      { model: 'claude-haiku-4-5', thinking: { type: 'enabled', budget_tokens: 2048 } },
      { model: 'claude-opus-4-7', output_config: { effort: 'xhigh' } },
      { model: 'claude-opus-4-6', output_config: { effort: 'max' } },
      { system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }] },
    ];
    for (const overrides of accepted) {
      expect((await post(server, baseBody(overrides))).status, JSON.stringify(overrides)).toBe(200);
    }
    expect(server.violations).toEqual([]);
  });

  describe('tool use pairing', () => {
    const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} };
    const toolResult = { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' };

    it('requires a tool_result right after every tool_use', async () => {
      const server = await startServer();
      const { status, json } = await postJson(
        server,
        baseBody({
          tools: TOOLS,
          messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: [toolUse] },
            { role: 'user', content: 'no result' },
          ],
        }),
      );
      expect(status).toBe(400);
      expect(errorMessage(json)).toMatch(
        /^messages\.1: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_1/,
      );
    });

    it('rejects a tool_result without a matching tool_use', async () => {
      const server = await startServer();
      const { status, json } = await postJson(
        server,
        baseBody({
          tools: TOOLS,
          messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'text only' },
            { role: 'user', content: [toolResult] },
          ],
        }),
      );
      expect(status).toBe(400);
      expect(errorMessage(json)).toMatch(/^messages\.2\.content\.0: unexpected `tool_use_id`/);
    });

    it('requires tool_result blocks to come first', async () => {
      const server = await startServer();
      const { status, json } = await postJson(
        server,
        baseBody({
          tools: TOOLS,
          messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: [toolUse] },
            { role: 'user', content: [{ type: 'text', text: 'note' }, toolResult] },
          ],
        }),
      );
      expect(status).toBe(400);
      expect(errorMessage(json)).toMatch(/must come before any other content/);
    });

    it('merges consecutive same-role messages before checking', async () => {
      const server = await startServer();
      const { status } = await post(
        server,
        baseBody({
          tools: TOOLS,
          messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: [toolUse] },
            { role: 'user', content: [toolResult] },
            { role: 'user', content: 'and a reminder' },
          ],
        }),
      );
      expect(status).toBe(200);
      expect(server.violations).toEqual([]);
    });

    it('requires tools that define every referenced tool', async () => {
      const server = await startServer();
      const conversation = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [toolUse] },
        { role: 'user', content: [toolResult] },
      ];
      const noTools = await postJson(server, baseBody({ messages: conversation }));
      expect(errorMessage(noTools.json)).toMatch(/must define tools/);
      const otherTool = await postJson(
        server,
        baseBody({
          messages: conversation,
          tools: [{ name: 'grep', description: 'g', input_schema: { type: 'object' } }],
        }),
      );
      expect(errorMessage(otherTool.json)).toMatch(/Tool 'read_file' is not defined/);
    });

    it('validates tool definitions', async () => {
      const server = await startServer();
      const badName = await postJson(
        server,
        baseBody({
          tools: [{ name: 'read file', description: '', input_schema: { type: 'object' } }],
        }),
      );
      expect(errorMessage(badName.json)).toMatch(/^tools\.0\.name: String should match pattern/);
      const badSchema = await postJson(
        server,
        baseBody({
          tools: [{ name: 'read_file', description: '', input_schema: { type: 'array' } }],
        }),
      );
      expect(errorMessage(badSchema.json)).toMatch(/^tools\.0\.input_schema\.type: /);
    });
  });

  describe('betas', () => {
    const cases: Array<[string, Body, string]> = [
      [
        'thinking.display updates',
        { thinking: { type: 'adaptive', display: 'updates' } },
        'thinking-display-updates-2026-08-18',
      ],
      [
        'thinking.block_binding',
        {
          thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
        },
        'thinking-binding-controls-2026-08-01',
      ],
      ['fallbacks "default"', { fallbacks: 'default' }, 'server-side-fallback-2026-07-01'],
      [
        'a fallbacks list',
        { fallbacks: [{ model: 'claude-opus-4-8' }] },
        'server-side-fallback-2026-06-01',
      ],
    ];

    it.each(cases)('requires the beta header for %s', async (_name, overrides, beta) => {
      const server = await startServer();
      const without = await postJson(server, baseBody(overrides));
      expect(without.status).toBe(400);
      expect(errorMessage(without.json)).toContain(beta);
      const withBeta = await post(server, baseBody(overrides), { betas: [beta] });
      expect(withBeta.status).toBe(200);
    });
  });

  describe('thinking replay', () => {
    const ADAPTIVE = { thinking: { type: 'adaptive' } };

    async function firstTurn(server: MockAnthropicServer, prompt = 'Start') {
      server.enqueue({
        content: [
          { type: 'thinking', thinking: 'Checking the tests.' },
          { type: 'redacted_thinking' },
          { type: 'text', text: 'Answer.' },
        ],
      });
      const { json } = await postJson(
        server,
        baseBody({ ...ADAPTIVE, messages: [{ role: 'user', content: prompt }] }),
      );
      return json['content'] as Body[];
    }

    function followUp(prompt: string, assistant: Body[], extra: Body = {}): Body {
      return baseBody({
        ...ADAPTIVE,
        ...extra,
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: assistant },
          { role: 'user', content: 'Next' },
        ],
      });
    }

    it('accepts blocks echoed verbatim (ignoring extra response fields)', async () => {
      const server = await startServer();
      const assistant = await firstTurn(server);
      const echoed = assistant.map((block) =>
        block['type'] === 'text' ? { type: 'text', text: block['text'] } : block,
      );
      expect((await post(server, followUp('Start', echoed))).status).toBe(200);
      expect(server.violations).toEqual([]);
    });

    it('rejects a signature it never issued', async () => {
      const server = await startServer();
      const assistant = await firstTurn(server);
      const forged = assistant.map((b) =>
        b['type'] === 'thinking' ? { ...b, signature: 'forged' } : b,
      );
      const { status, json } = await postJson(server, followUp('Start', forged));
      expect(status).toBe(400);
      expect(errorMessage(json)).toBe(
        'messages.1.content.0: Invalid `signature` in `thinking` block.',
      );
      expect(server.violations).toEqual([
        'request 2: messages.1.content.0: thinking block signature was not issued by this server',
        // The next block was bound to a conversation that contained the original block.
        'request 2: messages.1.content.1: thinking block replayed after an edit to the conversation before it',
      ]);
    });

    it('rejects modified thinking text and unknown redacted data', async () => {
      const server = await startServer();
      const assistant = await firstTurn(server);
      const modified = assistant.map((b) =>
        b['type'] === 'thinking' ? { ...b, thinking: 'Edited.' } : b,
      );
      expect((await post(server, followUp('Start', modified))).status).toBe(400);
      const redacted = assistant.map((b) =>
        b['type'] === 'redacted_thinking' ? { ...b, data: 'AAAA' } : b,
      );
      expect((await post(server, followUp('Start', redacted))).status).toBe(400);
      expect(server.violations).toEqual([
        'request 2: messages.1.content.0: thinking text differs from the text issued with its signature',
        'request 2: messages.1.content.1: thinking block replayed after an edit to the conversation before it',
        'request 3: messages.1.content.1: thinking block signature was not issued by this server',
      ]);
    });

    it('rejects thinking replayed after an edit before it, like the API', async () => {
      const server = await startServer();
      const assistant = await firstTurn(server, 'Original prompt');
      // Same conversation key would need the same first message; edit the system prompt instead.
      const { status, json } = await postJson(
        server,
        followUp('Original prompt', assistant, { system: 'A different system prompt' }),
      );
      expect(status).toBe(400);
      expect(errorMessage(json)).toBe(
        'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.',
      );
      expect(server.violations).toContain(
        'request 2: messages.1.content.0: thinking block replayed after an edit to the conversation before it',
      );
    });

    it('rejects thinking replayed into a different conversation', async () => {
      const server = await startServer();
      const assistant = await firstTurn(server, 'Conversation A');
      const { status } = await post(server, followUp('Conversation B', assistant));
      expect(status).toBe(400);
    });

    it('drops instead of rejecting with block_binding drop_block', async () => {
      const server = await startServer();
      const assistant = await firstTurn(server, 'Original prompt');
      const { status } = await post(
        server,
        followUp('Edited prompt', assistant, {
          thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
        }),
        { betas: ['thinking-binding-controls-2026-08-01'] },
      );
      expect(status).toBe(200);
      expect(server.violations).toEqual([
        'request 2: messages.1.content.0: thinking block replayed after an edit to the conversation before it (dropped per block_binding)',
        'request 2: messages.1.content.1: thinking block replayed after an edit to the conversation before it (dropped per block_binding)',
      ]);
    });

    it('rejects thinking blocks in user messages', async () => {
      const server = await startServer();
      const assistant = await firstTurn(server);
      const thinking = assistant[0];
      const { status, json } = await postJson(
        server,
        baseBody({
          messages: [{ role: 'user', content: [thinking, { type: 'text', text: 'hi' }] }],
        }),
      );
      expect(status).toBe(400);
      expect(errorMessage(json)).toMatch(/only allowed in assistant messages/);
    });

    it('rejects declined blocks echoed before a fallback block', async () => {
      const server = await startServer();
      server.enqueue({
        content: [
          { type: 'thinking', thinking: 'Declined attempt.' },
          { type: 'fallback', from: 'claude-opus-5-5', to: 'claude-opus-5' },
          { type: 'text', text: 'Rescued.' },
        ],
      });
      const { json } = await postJson(
        server,
        baseBody({ ...ADAPTIVE, messages: [{ role: 'user', content: 'Fallback' }] }),
      );
      const content = json['content'] as Body[];
      const verbatim = await postJson(server, followUp('Fallback', content));
      expect(verbatim.status).toBe(400);
      expect(errorMessage(verbatim.json)).toMatch(
        /^messages\.1\.content\.0: `thinking` blocks that precede a `fallback` block/,
      );
      const sanitized = await post(server, followUp('Fallback', content.slice(1)));
      expect(sanitized.status).toBe(200);
    });
  });

  describe('append-only history', () => {
    function conversation(assistantText: string, extra: Body = {}): Body {
      return baseBody({
        ...extra,
        messages: [
          { role: 'user', content: 'Append-only' },
          { role: 'assistant', content: assistantText },
          { role: 'user', content: 'More' },
        ],
      });
    }

    it('records (but accepts) an edited earlier message', async () => {
      const server = await startServer();
      expect((await post(server, conversation('Original reply'))).status).toBe(200);
      expect((await post(server, conversation('Rewritten reply'))).status).toBe(200);
      expect(server.violations).toEqual([
        'request 2: messages are not append-only: messages.1.content.0 differs from the previous request (messages.1.content.0)',
      ]);
    });

    it('records changes to system or tools within a conversation', async () => {
      const server = await startServer();
      await post(server, conversation('Reply', { system: 'one', tools: TOOLS }));
      await post(server, conversation('Reply', { system: 'two', tools: TOOLS }));
      await post(server, conversation('Reply', { system: 'two', tools: [] }));
      expect(server.violations).toEqual([
        'request 2: system prompt changed within a conversation',
        'request 3: tool definitions changed within a conversation',
      ]);
    });

    it('ignores cache_control placement, string shorthand and eager_input_streaming', async () => {
      const server = await startServer();
      await post(server, conversation('Reply', { tools: TOOLS }));
      const moved = baseBody({
        tools: TOOLS.map((tool) => ({ ...tool, eager_input_streaming: true })),
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Append-only', cache_control: { type: 'ephemeral' } }],
          },
          { role: 'assistant', content: [{ type: 'text', text: 'Reply' }] },
          { role: 'user', content: 'More' },
          { role: 'assistant', content: 'Second reply' },
          {
            role: 'user',
            content: [{ type: 'text', text: 'Even more', cache_control: { type: 'ephemeral' } }],
          },
        ],
      });
      expect((await post(server, moved)).status).toBe(200);
      expect(server.violations).toEqual([]);
    });

    it('treats a single-message request as a new conversation', async () => {
      const server = await startServer();
      await post(server, conversation('Reply'));
      await post(server, baseBody({ messages: [{ role: 'user', content: 'Append-only' }] }));
      await post(server, conversation('A different reply'));
      expect(server.violations).toEqual([]);
    });

    it('records violations without rejecting in lenient mode', async () => {
      const server = await startServer({ strict: false });
      const { status } = await post(
        server,
        baseBody({ temperature: 0.2, tool_choice: { type: 'any' } }),
      );
      expect(status).toBe(200);
      expect(server.violations).toEqual([
        'request 1: temperature: sampling parameters are not supported for this model; remove `temperature`',
        'request 1: tool_choice: type "tool" and "any" are not supported for this model.',
      ]);
    });
  });
});

describe('mock server web tools', () => {
  const WEB_TOOLS = [
    { type: 'web_search_20260209', name: 'web_search' },
    { type: 'web_fetch_20260209', name: 'web_fetch' },
  ];
  const searchCall = {
    type: 'server_tool_use' as const,
    id: 'srvtoolu_1',
    name: 'web_search',
    input: { query: 'q' },
  };

  /** A non-streamed response's content, to send back as the assistant message. */
  async function respond(server: MockAnthropicServer, messages: unknown[]): Promise<Body[]> {
    const { status, json } = await postJson(server, baseBody({ tools: WEB_TOOLS, messages }));
    expect(status).toBe(200);
    return json['content'] as Body[];
  }

  it('validates web tool definitions', async () => {
    const server = await startServer();
    const rejected: Array<[Body, RegExp]> = [
      [
        {
          type: 'web_search_20260209',
          name: 'web_search',
          allowed_domains: ['a.dev'],
          blocked_domains: ['b.dev'],
        },
        /either `allowed_domains` or `blocked_domains`/,
      ],
      [
        { type: 'web_fetch_20260209', name: 'web_fetch', allowed_domains: ['https://a.dev'] },
        /Invalid domain/,
      ],
      [
        { type: 'web_fetch_20260209', name: 'web_fetch', blocked_domains: ['*.a.dev'] },
        /Invalid domain/,
      ],
      [
        { type: 'web_search_20260209', name: 'web_search', eager_input_streaming: true },
        /Extra inputs/,
      ],
      [{ type: 'web_search_20990101', name: 'web_search' }, /Unknown tool type/],
      [{ type: 'web_fetch_20250910', name: 'fetch' }, /Input should be 'web_fetch'/],
    ];
    for (const [tool, message] of rejected) {
      const { status, json } = await postJson(server, baseBody({ tools: [tool] }));
      expect(status, JSON.stringify(tool)).toBe(400);
      expect(errorMessage(json)).toMatch(message);
    }
    const accepted = [
      { type: 'web_search_20250305', name: 'web_search', allowed_domains: ['a.dev/blog/*'] },
      { type: 'web_fetch_20260318', name: 'web_fetch', blocked_domains: ['b.dev'], max_uses: 3 },
    ];
    expect((await post(server, baseBody({ tools: accepted }))).status).toBe(200);
  });

  it('takes the dynamic-filtering versions only on models with programmatic tool calling', async () => {
    const server = await startServer();
    const haiku = (tools: unknown[]) => baseBody({ model: 'claude-haiku-4-5', tools });
    const { status, json } = await postJson(server, haiku([WEB_TOOLS[0]]));
    expect(status).toBe(400);
    expect(errorMessage(json)).toMatch(/allowed_callers/);
    const direct = { ...WEB_TOOLS[0], allowed_callers: ['direct'] };
    expect((await post(server, haiku([direct]))).status).toBe(200);
    const basic = { type: 'web_search_20250305', name: 'web_search' };
    expect((await post(server, haiku([basic]))).status).toBe(200);
  });

  it('streams server tool calls as input deltas, results whole, and counts the searches', async () => {
    const server = await startServer();
    server.enqueue({
      content: [
        { type: 'server_tool_use', id: 'srvtoolu_s', name: 'web_search', input: { query: 'abc' } },
        { type: 'web_search_tool_result', results: [{ url: 'https://a.dev', title: 'A' }] },
        {
          type: 'text',
          text: 'Cited.',
          citations: [{ url: 'https://a.dev', title: 'A', cited_text: 'a' }],
        },
      ],
    });
    const { text } = await post(server, baseBody({ stream: true, tools: WEB_TOOLS }));
    const events = parseSse(text);
    const starts = events
      .filter((e) => e.event === 'content_block_start')
      .map((e) => e.data['content_block'] as Body);
    expect(starts[0]).toMatchObject({ type: 'server_tool_use', id: 'srvtoolu_s', input: {} });
    expect(starts[1]).toMatchObject({
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_s',
      content: [
        { type: 'web_search_result', url: 'https://a.dev', encrypted_content: expect.any(String) },
      ],
    });
    const deltas = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => (e.data['delta'] as Body)['type']);
    expect(deltas).toContain('input_json_delta');
    expect(deltas).toContain('citations_delta');
    const usage = events.find((e) => e.event === 'message_delta')?.data['usage'] as Body;
    expect(usage['server_tool_use']).toEqual({ web_search_requests: 1, web_fetch_requests: 0 });
  });

  it('requires server tool blocks and citations back exactly as issued', async () => {
    const server = await startServer();
    server.enqueue({
      content: [
        searchCall,
        { type: 'web_search_tool_result', results: [{ url: 'https://a.dev', title: 'A' }] },
        {
          type: 'text',
          text: 'A.',
          citations: [{ url: 'https://a.dev', title: 'A', cited_text: 'a' }],
        },
      ],
    });
    const content = await respond(server, [{ role: 'user', content: 'Search' }]);
    const follow = (assistant: unknown[]) =>
      baseBody({
        tools: WEB_TOOLS,
        messages: [
          { role: 'user', content: 'Search' },
          { role: 'assistant', content: assistant },
          { role: 'user', content: 'Thanks' },
        ],
      });
    expect((await post(server, follow(content))).status).toBe(200);

    const result = content[1] as Body;
    const tampered = {
      ...result,
      content: [{ ...(result['content'] as Body[])[0], encrypted_content: 'forged' }],
    };
    const modified = await postJson(server, follow([content[0], tampered, content[2]]));
    expect(modified.status).toBe(400);
    expect(errorMessage(modified.json)).toMatch(/was modified/);

    const cited = content[2] as Body;
    const forgedCitation = {
      ...cited,
      citations: [{ ...(cited['citations'] as Body[])[0], encrypted_index: 'forged' }],
    };
    const citation = await postJson(server, follow([content[0], content[1], forgedCitation]));
    expect(citation.status).toBe(400);
    expect(errorMessage(citation.json)).toMatch(/encrypted_index/);
  });

  it('rejects an open server tool call that the conversation moved past', async () => {
    const server = await startServer();
    server.enqueue({ content: [searchCall], stop_reason: 'pause_turn' });
    const content = await respond(server, [{ role: 'user', content: 'Search' }]);
    const history = [
      { role: 'user', content: 'Search' },
      { role: 'assistant', content },
    ];
    // Continuing the paused turn is fine, but only with the tool still defined.
    const continued = baseBody({ tools: WEB_TOOLS, messages: history });
    expect((await post(server, continued)).status).toBe(200);
    const withoutTool = await postJson(server, baseBody({ tools: TOOLS, messages: history }));
    expect(withoutTool.status).toBe(400);
    expect(errorMessage(withoutTool.json)).toMatch(/no `web_search` tool was provided/);

    const movedOn = [...history, { role: 'user', content: 'Something else' }];
    const { status, json } = await postJson(
      server,
      baseBody({ tools: WEB_TOOLS, messages: movedOn }),
    );
    expect(status).toBe(400);
    expect(errorMessage(json)).toMatch(
      /`web_search` tool use with id `srvtoolu_1` was found without a corresponding `web_search_tool_result` block/,
    );

    const answered = [
      { role: 'user', content: 'Search' },
      {
        role: 'assistant',
        content: [
          ...content,
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: { type: 'web_search_tool_result_error', error_code: 'unavailable' },
          },
        ],
      },
      { role: 'user', content: 'Something else' },
    ];
    const accepted = baseBody({ tools: WEB_TOOLS, messages: answered });
    expect((await post(server, accepted)).status).toBe(200);
  });

  it('rejects a result that answers no call', async () => {
    const server = await startServer();
    const { status, json } = await postJson(
      server,
      baseBody({
        tools: WEB_TOOLS,
        messages: [
          { role: 'user', content: 'Search' },
          {
            role: 'assistant',
            content: [
              {
                type: 'web_fetch_tool_result',
                tool_use_id: 'srvtoolu_nope',
                content: { type: 'web_fetch_tool_result_error', error_code: 'unavailable' },
              },
            ],
          },
          { role: 'user', content: 'Next' },
        ],
      }),
    );
    expect(status).toBe(400);
    expect(errorMessage(json)).toMatch(/unexpected `tool_use_id`/);
  });
});
