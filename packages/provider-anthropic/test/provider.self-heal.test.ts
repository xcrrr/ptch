import type { Message, ProviderBlock } from '@patch/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MockErrorResponse } from '../src/testing/mock-server.js';
import {
  closeServers,
  collect,
  collectError,
  continueWith,
  makeProvider,
  makeRequest,
  startServer,
  userText,
} from './helpers.js';

afterEach(closeServers);

const PROGRESS_BETA = 'thinking-display-updates-2026-08-18';
const BINDING_BETA = 'thinking-binding-controls-2026-08-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function badRequest(message: string): MockErrorResponse {
  return { status: 400, error: { type: 'invalid_request_error', message } };
}

function thinkingBlocks(message: Message): ProviderBlock[] {
  return message.content.filter(
    (b): b is ProviderBlock => b.type === 'provider' && b.kind === 'thinking',
  );
}

function sentThinking(body: Record<string, unknown>): unknown[] {
  const messages = body['messages'] as Array<{ content: Array<{ type: string }> }>;
  return messages.flatMap((m) => m.content.filter((b) => b.type === 'thinking'));
}

describe('AnthropicProvider self-healing', () => {
  it('drops fallbacks after a 400 about them and remembers it for that model', async () => {
    const server = await startServer();
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const provider = makeProvider(server, { logger });
    server.enqueue(badRequest('fallbacks: Extra inputs are not permitted'));

    const { end } = await collect(provider.stream(makeRequest()));

    expect(end.message.content).toEqual([{ type: 'text', text: 'Mock response.' }]);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]?.body).toHaveProperty('fallbacks', 'default');
    expect(server.requests[1]?.body).not.toHaveProperty('fallbacks');
    expect(server.requests[1]?.betas).toEqual([PROGRESS_BETA, BINDING_BETA]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/server-side fallbacks for claude-opus-5-5/),
    );

    await collect(provider.stream(makeRequest()));
    expect(server.requests[2]?.body).not.toHaveProperty('fallbacks');

    await collect(provider.stream(makeRequest({ model: 'claude-fable-5-1' })));
    expect(server.requests[3]?.body).toHaveProperty('fallbacks', 'default');
    expect(server.requests).toHaveLength(4);
  });

  it('stops requesting progress updates after a 400 about display', async () => {
    const server = await startServer();
    const provider = makeProvider(server);
    server.enqueue(badRequest("thinking.display: 'updates' is not available for this model"));

    await collect(provider.stream(makeRequest()));

    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.body['thinking']).toEqual({
      type: 'adaptive',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    });
    expect(server.requests[1]?.betas).toEqual([BINDING_BETA, FALLBACK_BETA]);
    await collect(provider.stream(makeRequest()));
    expect(server.requests[2]?.body['thinking']).not.toHaveProperty('display');
  });

  it('stops sending block_binding after a 400 about it', async () => {
    const server = await startServer();
    server.enqueue(badRequest('thinking.block_binding: Extra inputs are not permitted'));
    await collect(makeProvider(server).stream(makeRequest()));
    expect(server.requests[1]?.body['thinking']).toEqual({ type: 'adaptive', display: 'updates' });
    expect(server.requests[1]?.betas).toEqual([PROGRESS_BETA, FALLBACK_BETA]);
  });

  it('recognizes a rejected beta header as the feature it enables', async () => {
    const server = await startServer();
    server.enqueue(
      badRequest(`Unexpected value(s) \`${BINDING_BETA}\` for the \`anthropic-beta\` header.`),
    );
    await collect(makeProvider(server).stream(makeRequest()));
    expect(server.requests[1]?.betas).not.toContain(BINDING_BETA);
    expect(server.requests[1]?.body['thinking']).not.toHaveProperty('block_binding');
  });

  it('stops sending eager_input_streaming after a 400 about it', async () => {
    const server = await startServer();
    server.enqueue(
      badRequest('tools.0.custom.eager_input_streaming: Extra inputs are not permitted'),
    );
    await collect(makeProvider(server).stream(makeRequest()));
    const tools = server.requests[1]?.body['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]).not.toHaveProperty('eager_input_streaming');
    expect(tools[0]).toHaveProperty('name', 'read_file');
  });

  it('heals several different rejections in sequence', async () => {
    const server = await startServer();
    server.enqueue(
      badRequest('fallbacks: not supported'),
      badRequest("thinking.display: 'updates' is not supported"),
    );
    const { end } = await collect(makeProvider(server).stream(makeRequest()));
    expect(end.stopReason).toBe('end_turn');
    expect(server.requests).toHaveLength(3);
    expect(server.requests[2]?.betas).toEqual([BINDING_BETA]);
  });

  it('retries a feature only once', async () => {
    const server = await startServer();
    server.enqueue(
      badRequest('fallbacks: not supported'),
      badRequest('fallbacks: still not supported'),
    );
    const { error } = await collectError(makeProvider(server).stream(makeRequest()));
    expect(error).toMatchObject({
      kind: 'invalid_request',
      message: 'fallbacks: still not supported',
    });
    expect(server.requests).toHaveLength(2);
  });

  it('does not retry unrelated 400s', async () => {
    const server = await startServer();
    server.enqueue(badRequest('messages.0.content.0.text: Field required'));
    const { error } = await collectError(makeProvider(server).stream(makeRequest()));
    expect(error.kind).toBe('invalid_request');
    expect(server.requests).toHaveLength(1);
  });

  it('does not retry once events were yielded', async () => {
    const server = await startServer();
    server.enqueue({ ...badRequest('fallbacks: rejected mid-stream'), midStream: true });
    const { events, error } = await collectError(makeProvider(server).stream(makeRequest()));
    expect(events.map((e) => e.type)).toEqual(['message_start']);
    expect(error.kind).toBe('invalid_request');
    expect(server.requests).toHaveLength(1);
  });

  it('does not strip thinking when the request carried none', async () => {
    const server = await startServer();
    server.enqueue(badRequest('Invalid `signature` in `thinking` block.'));
    const { error } = await collectError(makeProvider(server).stream(makeRequest()));
    expect(error.kind).toBe('invalid_request');
    expect(server.requests).toHaveLength(1);
  });

  it('strips rejected thinking blocks once and keeps later ones', async () => {
    const server = await startServer();
    const provider = makeProvider(server);
    server.enqueue(
      {
        content: [
          { type: 'thinking', thinking: 'Old note.' },
          { type: 'text', text: 'Turn one.' },
        ],
      },
      badRequest('messages.1.content.0: Invalid `signature` in `thinking` block.'),
      {
        content: [
          { type: 'thinking', thinking: 'New note.' },
          { type: 'text', text: 'Turn two.' },
        ],
      },
      { content: [{ type: 'text', text: 'Turn three.' }] },
    );

    const first = makeRequest({ messages: [userText('Start the session')] });
    const turn1 = await collect(provider.stream(first));
    const second = continueWith(first, turn1.end.message, userText('Continue'));
    const turn2 = await collect(provider.stream(second));
    expect(turn2.end.message.content.at(-1)).toEqual({ type: 'text', text: 'Turn two.' });

    // Request 2 was rejected; its retry (request 3) carried no thinking blocks.
    expect(sentThinking(server.requests[1]!.body)).toHaveLength(1);
    expect(sentThinking(server.requests[2]!.body)).toHaveLength(0);

    const third = continueWith(second, turn2.end.message, userText('And finish'));
    await collect(provider.stream(third));
    expect(server.requests).toHaveLength(4);
    // The rejected block stays out; the block produced after recovery is replayed.
    expect(sentThinking(server.requests[3]!.body)).toEqual(
      thinkingBlocks(turn2.end.message).map((b) => b.data),
    );
    // The retry extends the last served request, and the new block replays in its own prefix.
    expect(server.violations).toEqual([]);
  });

  it('recovers when the API refuses a tampered thinking block', async () => {
    const server = await startServer();
    const provider = makeProvider(server);
    server.enqueue(
      {
        content: [
          { type: 'thinking', thinking: 'Plan: read the file.' },
          { type: 'text', text: 'One.' },
        ],
      },
      { content: [{ type: 'text', text: 'Two.' }] },
    );
    const first = makeRequest({ messages: [userText('Tamper test')] });
    const turn1 = await collect(provider.stream(first));
    const tampered: Message = {
      role: 'assistant',
      content: turn1.end.message.content.map((block) =>
        block.type === 'provider' && block.kind === 'thinking'
          ? { ...block, data: { ...(block.data as object), thinking: 'Plan: delete everything.' } }
          : block,
      ),
    };

    const { end } = await collect(provider.stream(continueWith(first, tampered, userText('Go'))));

    expect(end.message.content).toEqual([{ type: 'text', text: 'Two.' }]);
    expect(server.requests).toHaveLength(3);
    expect(server.violations[0]).toMatch(
      /request 2: messages\.1\.content\.0: thinking text differs/,
    );
    expect(sentThinking(server.requests[2]!.body)).toEqual([]);
  });
});
