import type { ContentBlock, ProviderBlock } from '@patch/shared';
import { afterEach, describe, expect, it } from 'vitest';
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

function providerBlocks(content: ContentBlock[], kind: string): ProviderBlock[] {
  return content.filter((b): b is ProviderBlock => b.type === 'provider' && b.kind === kind);
}

function toolResult(toolCallId: string, content: string) {
  return {
    role: 'user' as const,
    content: [{ type: 'tool_result' as const, toolCallId, content }],
  };
}

describe('AnthropicProvider streaming', () => {
  it('streams text in chunks and ends with the complete message', async () => {
    const server = await startServer();
    server.enqueue({
      content: [{ type: 'text', text: 'Hello, world! How are you?' }],
      chunkSize: 5,
    });

    const { events, end } = await collect(makeProvider(server).stream(makeRequest()));

    expect(events[0]).toEqual({ type: 'message_start', model: 'claude-opus-5-5' });
    const deltas = events.filter((e) => e.type === 'text_delta').map((e) => e.text);
    expect(deltas).toEqual(['Hello', ', wor', 'ld! H', 'ow ar', 'e you', '?']);
    expect(end.message).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello, world! How are you?' }],
    });
    expect(end.stopReason).toBe('end_turn');
    expect(end.model).toBe('claude-opus-5-5');
    expect(end).not.toHaveProperty('notices');
    expect(server.violations).toEqual([]);
  });

  it('reports the serving model from message_start', async () => {
    const server = await startServer();
    server.enqueue({ content: [{ type: 'text', text: 'ok' }], model: 'claude-opus-5-5-20261001' });
    const { events, end } = await collect(makeProvider(server).stream(makeRequest()));
    expect(events[0]).toEqual({ type: 'message_start', model: 'claude-opus-5-5-20261001' });
    expect(end.model).toBe('claude-opus-5-5-20261001');
  });

  it('maps usage including cache reads and writes', async () => {
    const server = await startServer();
    server.enqueue({
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 1200,
        output_tokens: 345,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: 800,
      },
    });
    const { end } = await collect(makeProvider(server).stream(makeRequest()));
    expect(end.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 345,
      cacheReadTokens: 9000,
      cacheWriteTokens: 800,
    });
  });

  it('reports billed usage separately when a fallback served the turn', async () => {
    const server = await startServer();
    const attempt = (type: string, model: string, output: number) => ({
      type,
      model,
      input_tokens: 1000,
      output_tokens: output,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    server.enqueue({
      content: [
        { type: 'text', text: 'Partial. ' },
        { type: 'fallback', from: 'claude-opus-5-5', to: 'claude-opus-5' },
        { type: 'text', text: 'Continued.' },
      ],
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        iterations: [
          attempt('message', 'claude-opus-5-5', 3000),
          attempt('fallback_message', 'claude-opus-5', 500),
        ],
      },
    });
    const { end } = await collect(makeProvider(server).stream(makeRequest()));
    expect(end.model).toBe('claude-opus-5');
    expect(end.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(end.billedUsage).toEqual({
      inputTokens: 2000,
      outputTokens: 3500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('does not surface reasoning summaries as progress without progress updates', async () => {
    const server = await startServer();
    const summary = 'The user wants the loader fixed. I should read it.';
    server.enqueue({
      content: [
        { type: 'thinking', thinking: summary },
        { type: 'text', text: 'Reading it now.' },
      ],
    });
    const { events, end } = await collect(
      makeProvider(server).stream(makeRequest({ model: 'claude-sonnet-4-6' })),
    );
    expect(events.some((e) => e.type === 'progress')).toBe(false);
    const [thinking] = providerBlocks(end.message.content, 'thinking');
    expect(thinking).not.toHaveProperty('displayText');
    expect(thinking?.data).toMatchObject({ thinking: summary });
  });

  it('streams a tool call with valid JSON input', async () => {
    const server = await startServer();
    server.enqueue({
      content: [
        { type: 'text', text: 'Let me read it.' },
        { type: 'tool_use', id: 'toolu_read', name: 'read_file', input: { path: 'src/index.ts' } },
      ],
      chunkSize: 8,
    });

    const { events, end } = await collect(makeProvider(server).stream(makeRequest()));

    expect(events).toContainEqual({ type: 'tool_call_start', id: 'toolu_read', name: 'read_file' });
    const sizes = events.filter((e) => e.type === 'tool_call_delta').map((e) => e.inputBytes);
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(sizes.at(-1)).toBe(JSON.stringify({ path: 'src/index.ts' }).length);
    expect(end.stopReason).toBe('tool_use');
    expect(end.message.content).toEqual([
      { type: 'text', text: 'Let me read it.' },
      { type: 'tool_call', id: 'toolu_read', name: 'read_file', input: { path: 'src/index.ts' } },
    ]);
  });

  it('keeps a tool call with invalid JSON as an input error without affecting other calls', async () => {
    const server = await startServer();
    server.enqueue({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_bad',
          name: 'read_file',
          input: {},
          rawJson: '{"path": "a.ts",',
        },
        { type: 'tool_use', id: 'toolu_array', name: 'read_file', input: {}, rawJson: '["a.ts"]' },
        { type: 'tool_use', id: 'toolu_ok', name: 'read_file', input: { path: 'b.ts' } },
      ],
    });

    const { end } = await collect(makeProvider(server).stream(makeRequest()));
    const [bad, array, ok] = end.message.content;

    expect(bad).toMatchObject({
      type: 'tool_call',
      id: 'toolu_bad',
      input: {},
      rawInput: '{"path": "a.ts",',
    });
    expect(bad).toHaveProperty('inputError', expect.stringMatching(/not valid JSON/));
    expect(array).toMatchObject({
      id: 'toolu_array',
      input: {},
      rawInput: '["a.ts"]',
      inputError: 'The tool input must be a JSON object, but it was an array.',
    });
    expect(ok).toEqual({
      type: 'tool_call',
      id: 'toolu_ok',
      name: 'read_file',
      input: { path: 'b.ts' },
    });
  });

  it('explains a tool input cut off by max_tokens', async () => {
    const server = await startServer();
    server.enqueue({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_cut',
          name: 'read_file',
          input: {},
          rawJson: '{"path": "src/ver',
        },
      ],
      stop_reason: 'max_tokens',
    });
    const { end } = await collect(makeProvider(server).stream(makeRequest()));
    expect(end.stopReason).toBe('max_tokens');
    expect(end.message.content[0]).toMatchObject({
      inputError: 'The tool input was cut off because the response reached the output token limit.',
      rawInput: '{"path": "src/ver',
    });
  });

  it('surfaces progress updates and keeps every thinking block for replay', async () => {
    const server = await startServer();
    server.enqueue({
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'thinking', thinking: 'Reading the config loader first.' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'config.ts' } },
      ],
    });

    const { events, end } = await collect(makeProvider(server).stream(makeRequest()));

    expect(events.filter((e) => e.type === 'thinking')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'progress')).toEqual([
      { type: 'progress', text: 'Reading the config loader first.' },
    ]);
    const thinking = providerBlocks(end.message.content, 'thinking');
    expect(thinking).toHaveLength(2);
    expect(thinking[0]).not.toHaveProperty('displayText');
    expect(thinking[0]?.data).toMatchObject({
      type: 'thinking',
      thinking: '',
      signature: expect.any(String),
    });
    expect(thinking[1]).toMatchObject({
      displayText: 'Reading the config loader first.',
      data: { type: 'thinking', thinking: 'Reading the config loader first.' },
    });
    // Progress is emitted when the block completes, before the tool call starts.
    const progressAt = events.findIndex((e) => e.type === 'progress');
    const toolAt = events.findIndex((e) => e.type === 'tool_call_start');
    expect(progressAt).toBeLessThan(toolAt);
  });

  it('preserves redacted thinking verbatim', async () => {
    const server = await startServer();
    server.enqueue({ content: [{ type: 'redacted_thinking' }, { type: 'text', text: 'Done.' }] });

    const { events, end } = await collect(makeProvider(server).stream(makeRequest()));

    expect(events).toContainEqual({ type: 'thinking' });
    const [redacted] = providerBlocks(end.message.content, 'redacted_thinking');
    expect(redacted?.data).toEqual({ type: 'redacted_thinking', data: expect.any(String) });
    expect(redacted).not.toHaveProperty('displayText');
  });

  it('echoes thinking blocks verbatim and in place across turns', async () => {
    const server = await startServer();
    server.enqueue(
      {
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'thinking', thinking: 'Looking for the entry point.' },
          { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
      {
        content: [
          { type: 'redacted_thinking' },
          { type: 'text', text: 'Found it.' },
          { type: 'tool_use', id: 'toolu_b', name: 'read_file', input: { path: 'b.ts' } },
        ],
      },
      {
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'All done.' },
        ],
      },
    );
    const provider = makeProvider(server);

    const first = makeRequest({ messages: [userText('Trace the startup path')] });
    const turn1 = await collect(provider.stream(first));
    const second = continueWith(first, turn1.end.message, toolResult('toolu_a', 'export {}'));
    const turn2 = await collect(provider.stream(second));
    const third = continueWith(
      second,
      turn2.end.message,
      toolResult('toolu_b', 'export const b = 1;'),
    );
    const turn3 = await collect(provider.stream(third));

    expect(turn3.end.message.content.at(-1)).toEqual({ type: 'text', text: 'All done.' });
    expect(server.violations).toEqual([]);

    // The API saw exactly the blocks it produced, in their original positions.
    const sentMessages = server.requests[2]?.body['messages'] as Array<{ content: unknown[] }>;
    const thinkingData = providerBlocks(turn1.end.message.content, 'thinking').map((b) => b.data);
    expect(sentMessages[1]?.content.slice(0, 2)).toEqual(thinkingData);
    const redactedData = providerBlocks(turn2.end.message.content, 'redacted_thinking').map(
      (b) => b.data,
    );
    expect(sentMessages[3]?.content[0]).toEqual(redactedData[0]);
  });

  it('maps a refusal with stop details', async () => {
    const server = await startServer();
    server.enqueue({
      content: [{ type: 'text', text: 'I can’t help with that.' }],
      stop_reason: 'refusal',
      stop_details: {
        type: 'refusal',
        category: 'cyber',
        explanation: 'Potential malware development.',
      },
    });
    const { end } = await collect(makeProvider(server).stream(makeRequest()));
    expect(end.stopReason).toBe('refusal');
    expect(end.refusal).toEqual({
      category: 'cyber',
      explanation: 'Potential malware development.',
    });
  });

  it('maps a refusal without stop details to null fields', async () => {
    const server = await startServer();
    server.enqueue({ content: [], stop_reason: 'refusal' });
    const { end } = await collect(makeProvider(server).stream(makeRequest()));
    expect(end.refusal).toEqual({ category: null, explanation: null });
  });

  it.each([
    ['pause_turn', 'pause'],
    ['model_context_window_exceeded', 'context_window_exceeded'],
    ['max_tokens', 'max_tokens'],
  ] as const)('maps stop_reason %s to %s', async (apiReason, expected) => {
    const server = await startServer();
    server.enqueue({ content: [{ type: 'text', text: 'partial' }], stop_reason: apiReason });
    const { end } = await collect(makeProvider(server).stream(makeRequest()));
    expect(end.stopReason).toBe(expected);
    expect(end).not.toHaveProperty('refusal');
  });

  it('handles a mid-output fallback: notice, serving model and echo sanitation', async () => {
    const server = await startServer();
    server.enqueue(
      {
        content: [
          { type: 'thinking', thinking: 'Starting on the exploit analysis.' },
          { type: 'text', text: 'Partial answer. ' },
          { type: 'tool_use', id: 'toolu_declined', name: 'read_file', input: { path: 'x' } },
          { type: 'fallback', from: 'claude-opus-5-5', to: 'claude-opus-5' },
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'Continued answer.' },
        ],
      },
      { content: [{ type: 'text', text: 'Next turn.' }] },
    );
    const provider = makeProvider(server);
    const request = makeRequest({ messages: [userText('Analyze this binary')] });

    const { events, end } = await collect(provider.stream(request));

    expect(events).toContainEqual({
      type: 'tool_call_start',
      id: 'toolu_declined',
      name: 'read_file',
    });
    expect(end.notices).toEqual(['claude-opus-5-5 declined; claude-opus-5 continued']);
    expect(end.model).toBe('claude-opus-5');
    const kinds = end.message.content.map((b) => (b.type === 'provider' ? b.kind : b.type));
    expect(kinds).toEqual(['text', 'fallback', 'thinking', 'text']);
    expect(end.message.content.some((b) => b.type === 'tool_call')).toBe(false);

    const next = continueWith(request, end.message, userText('Thanks, go on'));
    const { end: nextEnd } = await collect(provider.stream(next));
    expect(nextEnd.message.content).toEqual([{ type: 'text', text: 'Next turn.' }]);
    expect(server.violations).toEqual([]);
  });

  it('throws a mapped error from a mid-stream error event after message_start', async () => {
    const server = await startServer();
    server.enqueue({
      status: 529,
      error: { type: 'overloaded_error', message: 'Overloaded' },
      midStream: true,
    });

    const { events, error } = await collectError(makeProvider(server).stream(makeRequest()));

    expect(events).toEqual([{ type: 'message_start', model: 'claude-opus-5-5' }]);
    expect(error).toMatchObject({ kind: 'overloaded', retryable: true, message: 'Overloaded' });
    expect(server.requests).toHaveLength(1);
  });

  it('aborts promptly mid-stream', async () => {
    const server = await startServer();
    server.enqueue({
      content: [{ type: 'text', text: 'x'.repeat(400) }],
      chunkSize: 4,
      delayMs: 100,
    });
    const controller = new AbortController();
    const stream = makeProvider(server).stream(makeRequest({ signal: controller.signal }));

    const seen: string[] = [];
    let abortedAt = 0;
    const result = await (async () => {
      try {
        for await (const event of stream) {
          seen.push(event.type);
          if (event.type === 'text_delta' && abortedAt === 0) {
            abortedAt = Date.now();
            controller.abort();
          }
        }
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect(Date.now() - abortedAt).toBeLessThan(1000);
    expect(result).toMatchObject({ name: 'ProviderError', kind: 'aborted' });
    expect(seen).not.toContain('message_end');
  });

  it('fails immediately without a request when already aborted', async () => {
    const server = await startServer();
    const controller = new AbortController();
    controller.abort();
    const { error } = await collectError(
      makeProvider(server).stream(makeRequest({ signal: controller.signal })),
    );
    expect(error.kind).toBe('aborted');
    expect(server.requests).toHaveLength(0);
  });

  it('cancels the HTTP stream when the consumer stops early', async () => {
    const server = await startServer();
    server.enqueue({
      content: [{ type: 'text', text: 'y'.repeat(200) }],
      chunkSize: 2,
      delayMs: 20,
    });
    const started = Date.now();
    for await (const event of makeProvider(server).stream(makeRequest())) {
      if (event.type === 'text_delta') break;
    }
    expect(Date.now() - started).toBeLessThan(1000);
    // The server is still usable afterwards.
    server.enqueue({ content: [{ type: 'text', text: 'again' }] });
    const { end } = await collect(makeProvider(server).stream(makeRequest()));
    expect(end.message.content).toEqual([{ type: 'text', text: 'again' }]);
  });
});
