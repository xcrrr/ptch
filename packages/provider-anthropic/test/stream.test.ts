import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { isProviderError, type ContentBlock, type ModelEvent } from '@patch/shared';
import { describe, expect, it } from 'vitest';
import {
  applyFallbackEchoRules,
  INTERRUPTED_PROGRESS_TEXT,
  parseToolInput,
  StreamAccumulator,
  type StreamAccumulatorOptions,
} from '../src/stream.js';

/** Builds raw stream events loosely; the accumulator must cope with fields it does not know. */
function ev(event: Record<string, unknown>): BetaRawMessageStreamEvent {
  return event as unknown as BetaRawMessageStreamEvent;
}

function messageStart(model = 'claude-opus-5-5', usage: Record<string, unknown> = {}) {
  return ev({
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      usage: { input_tokens: 10, output_tokens: 1, ...usage },
    },
  });
}

function messageDelta(stopReason: string, extra: Record<string, unknown> = {}) {
  return ev({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null, stop_details: null, ...extra },
    usage: { output_tokens: 5 },
  });
}

/** Runs events through an accumulator for a request that asked for progress updates. */
function run(
  events: BetaRawMessageStreamEvent[],
  options: StreamAccumulatorOptions = { progressUpdates: true },
): {
  events: ModelEvent[];
  acc: StreamAccumulator;
} {
  const acc = new StreamAccumulator('claude-opus-5-5', options);
  const out: ModelEvent[] = [];
  for (const event of events) out.push(...acc.push(event));
  return { events: out, acc };
}

const start = (index: number, block: Record<string, unknown>) =>
  ev({ type: 'content_block_start', index, content_block: block });
const delta = (index: number, payload: Record<string, unknown>) =>
  ev({ type: 'content_block_delta', index, delta: payload });
const stop = (index: number) => ev({ type: 'content_block_stop', index });

describe('parseToolInput', () => {
  it('accepts JSON objects', () => {
    expect(parseToolInput('{"path":"a.ts","n":2}')).toEqual({ input: { path: 'a.ts', n: 2 } });
  });

  it('reports invalid JSON with the parser reason', () => {
    const result = parseToolInput('{"path": "a.ts"');
    expect(result).toHaveProperty('error');
    expect('error' in result && result.error).toMatch(
      /^The tool input is not valid JSON \(.+\)\.$/,
    );
  });

  it.each([
    ['[1,2]', 'an array'],
    ['"text"', 'a string'],
    ['42', 'a number'],
    ['null', 'null'],
    ['true', 'a boolean'],
  ])('rejects non-object JSON %s', (raw, described) => {
    expect(parseToolInput(raw)).toEqual({
      error: `The tool input must be a JSON object, but it was ${described}.`,
    });
  });
});

describe('StreamAccumulator', () => {
  it('fails when the stream ends before message_stop', () => {
    const { acc } = run([messageStart(), start(0, { type: 'text', text: '' }), stop(0)]);
    let caught: unknown;
    try {
      acc.finish();
    } catch (error) {
      caught = error;
    }
    expect(isProviderError(caught) && caught.kind).toBe('network');
    expect(isProviderError(caught) && caught.retryable).toBe(true);
  });

  it('fails when no message_start arrived', () => {
    const { acc } = run([ev({ type: 'message_stop' })]);
    expect(() => acc.finish()).toThrow(/ended before the message was complete/);
  });

  it('orders blocks by index and keeps unknown block types verbatim', () => {
    const { acc } = run([
      messageStart(),
      start(1, { type: 'text', text: '' }),
      delta(1, { type: 'text_delta', text: 'after' }),
      start(0, { type: 'mystery_block', payload: { a: 1 } }),
      stop(0),
      stop(1),
      messageDelta('end_turn'),
      ev({ type: 'message_stop' }),
    ]);
    const end = acc.finish();
    expect(end.message.content).toEqual([
      {
        type: 'provider',
        provider: 'anthropic',
        kind: 'mystery_block',
        data: { type: 'mystery_block', payload: { a: 1 } },
      },
      { type: 'text', text: 'after' },
    ]);
  });

  it('applies input_json_delta to opaque server tool blocks', () => {
    const { acc } = run([
      messageStart(),
      start(0, { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '{"query":' }),
      delta(0, { type: 'input_json_delta', partial_json: '"vitest"}' }),
      stop(0),
      messageDelta('end_turn'),
      ev({ type: 'message_stop' }),
    ]);
    const [block] = acc.finish().message.content;
    expect(block).toMatchObject({
      type: 'provider',
      kind: 'server_tool_use',
      data: { type: 'server_tool_use', id: 'srv_1', input: { query: 'vitest' } },
    });
  });

  it('replaces the signature on signature_delta and concatenates thinking text', () => {
    const { events, acc } = run([
      messageStart(),
      start(0, { type: 'thinking', thinking: '', signature: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'Checking the ' }),
      delta(0, { type: 'thinking_delta', thinking: 'failing test.' }),
      delta(0, { type: 'signature_delta', signature: 'sig-final' }),
      stop(0),
      messageDelta('end_turn'),
      ev({ type: 'message_stop' }),
    ]);
    expect(events).toEqual([
      { type: 'message_start', model: 'claude-opus-5-5' },
      { type: 'thinking' },
      { type: 'progress', text: 'Checking the failing test.' },
    ]);
    expect(acc.finish().message.content).toEqual([
      {
        type: 'provider',
        provider: 'anthropic',
        kind: 'thinking',
        data: { type: 'thinking', thinking: 'Checking the failing test.', signature: 'sig-final' },
        displayText: 'Checking the failing test.',
      },
    ]);
  });

  it('stores but does not surface the interrupted-progress placeholder', () => {
    const { events, acc } = run([
      messageStart(),
      start(0, { type: 'thinking', thinking: '', signature: '' }),
      delta(0, { type: 'thinking_delta', thinking: INTERRUPTED_PROGRESS_TEXT }),
      delta(0, { type: 'signature_delta', signature: 's' }),
      stop(0),
      messageDelta('end_turn'),
      ev({ type: 'message_stop' }),
    ]);
    expect(events.map((e) => e.type)).toEqual(['message_start', 'thinking']);
    const [block] = acc.finish().message.content;
    expect(block).toMatchObject({
      kind: 'thinking',
      data: { thinking: INTERRUPTED_PROGRESS_TEXT },
    });
    expect(block).not.toHaveProperty('displayText');
  });

  it('keeps thinking text but never surfaces it when progress updates were not requested', () => {
    // Opus 4.6 / Sonnet 4.6 return summarized reasoning in thinking blocks by default.
    const { events, acc } = run(
      [
        messageStart('claude-sonnet-4-6'),
        start(0, { type: 'thinking', thinking: '', signature: '' }),
        delta(0, { type: 'thinking_delta', thinking: 'The user wants a fix; first I will...' }),
        delta(0, { type: 'signature_delta', signature: 'sig' }),
        stop(0),
        messageDelta('end_turn'),
        ev({ type: 'message_stop' }),
      ],
      {},
    );
    expect(events).toEqual([
      { type: 'message_start', model: 'claude-sonnet-4-6' },
      { type: 'thinking' },
    ]);
    expect(acc.finish().message.content).toEqual([
      {
        type: 'provider',
        provider: 'anthropic',
        kind: 'thinking',
        data: {
          type: 'thinking',
          thinking: 'The user wants a fix; first I will...',
          signature: 'sig',
        },
      },
    ]);
  });

  it('treats whitespace-only thinking as reasoning, not progress', () => {
    const { events } = run([
      messageStart(),
      start(0, { type: 'thinking', thinking: '', signature: '' }),
      delta(0, { type: 'thinking_delta', thinking: '  \n' }),
      stop(0),
    ]);
    expect(events.some((e) => e.type === 'progress')).toBe(false);
  });

  it('maps every API stop reason', () => {
    const cases: Array<[string, string]> = [
      ['end_turn', 'end_turn'],
      ['tool_use', 'tool_use'],
      ['max_tokens', 'max_tokens'],
      ['stop_sequence', 'stop_sequence'],
      ['refusal', 'refusal'],
      ['pause_turn', 'pause'],
      ['model_context_window_exceeded', 'context_window_exceeded'],
      ['compaction', 'unknown'],
      ['something_new', 'unknown'],
    ];
    for (const [api, expected] of cases) {
      const { acc } = run([messageStart(), messageDelta(api), ev({ type: 'message_stop' })]);
      expect(acc.finish().stopReason, api).toBe(expected);
    }
  });

  it('keeps cumulative usage from message_delta and ignores null fields', () => {
    const { acc } = run([
      messageStart('claude-opus-5-5', {
        input_tokens: 100,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: null,
      }),
      ev({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null },
        usage: { output_tokens: 77, input_tokens: null, cache_creation_input_tokens: 12 },
      }),
      ev({ type: 'message_stop' }),
    ]);
    expect(acc.finish().usage).toEqual({
      inputTokens: 100,
      outputTokens: 77,
      cacheReadTokens: 40,
      cacheWriteTokens: 12,
    });
  });

  it('reports billed usage across a declined attempt and the fallback that served the turn', () => {
    const { acc } = run([
      messageStart('claude-opus-5-5', { input_tokens: 1000, cache_read_input_tokens: 0 }),
      start(0, { type: 'text', text: '' }),
      delta(0, { type: 'text_delta', text: 'Partial. ' }),
      stop(0),
      start(1, {
        type: 'fallback',
        from: { model: 'claude-opus-5-5' },
        to: { model: 'claude-opus-5' },
      }),
      stop(1),
      start(2, { type: 'text', text: '' }),
      delta(2, { type: 'text_delta', text: 'Continued.' }),
      stop(2),
      ev({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null },
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 0,
          iterations: [
            {
              type: 'message',
              model: 'claude-opus-5-5',
              input_tokens: 1000,
              output_tokens: 3000,
              cache_read_input_tokens: 200,
              cache_creation_input_tokens: 50,
            },
            {
              type: 'fallback_message',
              model: 'claude-opus-5',
              input_tokens: 1000,
              output_tokens: 500,
              cache_read_input_tokens: 200,
              cache_creation_input_tokens: 0,
            },
          ],
        },
      }),
      ev({ type: 'message_stop' }),
    ]);
    const end = acc.finish();
    expect(end.model).toBe('claude-opus-5');
    // The serving attempt: what the conversation holds (context accounting).
    expect(end.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
    });
    // Every attempt the API billed.
    expect(end.billedUsage).toEqual({
      inputTokens: 2000,
      outputTokens: 3500,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
    });
  });

  it('uses the latest iterations list, since iterations are cumulative', () => {
    const iteration = (output: number) => ({
      type: 'message',
      input_tokens: 10,
      output_tokens: output,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    const { acc } = run([
      messageStart('claude-opus-5-5', { iterations: [iteration(1)] }),
      ev({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null },
        usage: { output_tokens: 5, iterations: [iteration(40), iteration(5)] },
      }),
      ev({
        type: 'message_delta',
        delta: { stop_reason: null, stop_sequence: null, stop_details: null },
        usage: { output_tokens: 5, iterations: null },
      }),
      ev({ type: 'message_stop' }),
    ]);
    expect(acc.finish().billedUsage).toEqual({
      inputTokens: 20,
      outputTokens: 45,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('omits billed usage when the iterations add up to the top-level usage', () => {
    const { acc } = run([
      messageStart('claude-opus-5-5', { input_tokens: 10 }),
      ev({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null },
        usage: {
          output_tokens: 5,
          iterations: [
            {
              type: 'message',
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          ],
        },
      }),
      ev({ type: 'message_stop' }),
    ]);
    const end = acc.finish();
    expect(end).not.toHaveProperty('billedUsage');
    expect(end.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const { acc: plain } = run([
      messageStart(),
      messageDelta('end_turn'),
      ev({ type: 'message_stop' }),
    ]);
    expect(plain.finish()).not.toHaveProperty('billedUsage');
  });

  it('does not emit tool_call_delta for empty fragments and counts UTF-8 bytes', () => {
    const { events } = run([
      messageStart(),
      start(0, { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '' }),
      delta(0, { type: 'input_json_delta', partial_json: '{"text":"żółw"' }),
      delta(0, { type: 'input_json_delta', partial_json: '}' }),
      stop(0),
    ]);
    expect(events.filter((e) => e.type === 'tool_call_delta')).toEqual([
      // 9 ASCII bytes + "żółw" (7 bytes in UTF-8) + closing quote.
      { type: 'tool_call_delta', id: 'toolu_1', inputBytes: 17 },
      { type: 'tool_call_delta', id: 'toolu_1', inputBytes: 18 },
    ]);
  });

  it('uses an empty object for a tool call without streamed input', () => {
    const { acc } = run([
      messageStart(),
      start(0, { type: 'tool_use', id: 'toolu_1', name: 'git_status', input: {} }),
      stop(0),
      messageDelta('tool_use'),
      ev({ type: 'message_stop' }),
    ]);
    expect(acc.finish().message.content).toEqual([
      { type: 'tool_call', id: 'toolu_1', name: 'git_status', input: {} },
    ]);
  });
});

describe('applyFallbackEchoRules', () => {
  const thinking: ContentBlock = {
    type: 'provider',
    provider: 'anthropic',
    kind: 'thinking',
    data: { type: 'thinking' },
  };
  const fallback: ContentBlock = {
    type: 'provider',
    provider: 'anthropic',
    kind: 'fallback',
    data: { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
  };
  const serverCall = (id: string): ContentBlock => ({
    type: 'provider',
    provider: 'anthropic',
    kind: 'server_tool_use',
    data: { type: 'server_tool_use', id },
  });
  const serverResult = (id: string): ContentBlock => ({
    type: 'provider',
    provider: 'anthropic',
    kind: 'web_search_tool_result',
    data: { type: 'web_search_tool_result', tool_use_id: id },
  });

  it('returns the blocks unchanged without a fallback', () => {
    const blocks: ContentBlock[] = [thinking, { type: 'text', text: 'hi' }];
    expect(applyFallbackEchoRules(blocks)).toBe(blocks);
  });

  it('drops declined thinking, tool calls and unpaired server calls but keeps text and pairs', () => {
    const toolCall: ContentBlock = { type: 'tool_call', id: 't1', name: 'read_file', input: {} };
    const text: ContentBlock = { type: 'text', text: 'partial' };
    const after: ContentBlock = { type: 'text', text: 'rest' };
    const result = applyFallbackEchoRules([
      thinking,
      text,
      serverCall('paired'),
      serverResult('paired'),
      serverCall('unpaired'),
      toolCall,
      fallback,
      thinking,
      after,
    ]);
    expect(result).toEqual([
      text,
      serverCall('paired'),
      serverResult('paired'),
      fallback,
      thinking,
      after,
    ]);
  });

  it('only sanitizes blocks before the last of several fallbacks', () => {
    const second: ContentBlock = {
      ...fallback,
      data: { type: 'fallback', from: { model: 'b' }, to: { model: 'c' } },
    };
    const result = applyFallbackEchoRules([thinking, fallback, thinking, second, thinking]);
    expect(result).toEqual([fallback, second, thinking]);
  });
});
