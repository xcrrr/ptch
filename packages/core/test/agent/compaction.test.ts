import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  emptyUsage,
  textOf,
  type Message,
  type ModelEvent,
  type ModelRequest,
  type Usage,
} from '@patch/shared';
import {
  COMPACTION_INSTRUCTIONS,
  COMPACTION_SYSTEM_PROMPT,
  COMPACTION_TOOL_INPUT_CHARS,
  COMPACTION_TOOL_RESULT_CHARS,
  SummaryRejectedError,
  renderTranscript,
  usageSinceCompaction,
} from '../../src/agent/compaction.js';
import type { AgentEvent } from '../../src/agent/events.js';
import { COMPACTION_SUMMARY_PREFIX, INTERRUPTED_MARKER } from '../../src/session/schema.js';
import { ScriptedProvider, textResponse, toolResponse } from '../../src/testing/index.js';
import {
  MemorySession,
  agentRequests,
  createHarness,
  eventTypes,
  eventsOf,
  expectValidHistory,
  runTurn,
} from './helpers.js';

const never = () => new AbortController().signal;

/**
 * Reports billed usage for chosen requests (by index), as a provider does when a server-side
 * fallback served a request after a declined attempt.
 */
class BilledProvider extends ScriptedProvider {
  readonly billed = new Map<number, Partial<Usage>>();
  private index = 0;

  override async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const billed = this.billed.get(this.index++);
    for await (const event of super.stream(request)) {
      yield event.type === 'message_end' && billed
        ? { ...event, billedUsage: { ...emptyUsage(), ...billed } }
        : event;
    }
  }
}

describe('renderTranscript', () => {
  it('renders roles, text, tool calls, results and progress notes', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Fix the bug\r\nin auth.ts  ' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'provider',
            provider: 'anthropic',
            kind: 'thinking',
            data: { thinking: 'secret reasoning', signature: 'sig' },
            displayText: 'Reading the auth module',
          },
          { type: 'provider', provider: 'anthropic', kind: 'redacted_thinking', data: 'opaque' },
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'src/auth.ts' } },
          {
            type: 'tool_call',
            id: 'c2',
            name: 'write_file',
            input: {},
            inputError: 'Unexpected end of JSON input',
            rawInput: '{"path": "a',
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'c1', content: 'export function login() {}\n' },
          { type: 'tool_result', toolCallId: 'c2', content: 'Invalid JSON', isError: true },
          { type: 'text', text: INTERRUPTED_MARKER },
        ],
      },
      { role: 'assistant', content: [{ type: 'provider', provider: 'x', kind: 'y', data: null }] },
    ];

    expect(renderTranscript(messages)).toBe(
      [
        'User:\nFix the bug\nin auth.ts',
        'Patch:\n[progress] Reading the auth module\nLet me look.\n[tool call read_file {"path":"src/auth.ts"}]\n[tool call write_file (invalid JSON input: Unexpected end of JSON input) {"path": "a]',
        `User:\n[tool result] export function login() {}\n[tool result (error)] Invalid JSON\n${INTERRUPTED_MARKER}`,
      ].join('\n\n'),
    );
    expect(renderTranscript(messages)).not.toContain('secret reasoning');
    expect(renderTranscript([])).toBe('');
  });

  it('truncates long tool inputs and results with explicit markers', () => {
    const longInput = { content: 'x'.repeat(COMPACTION_TOOL_INPUT_CHARS * 2) };
    const lines = Array.from({ length: 400 }, (_, i) => `result line ${i + 1}`);
    const transcript = renderTranscript([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c1', name: 'write_file', input: longInput }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'c1', content: lines.join('\n') }],
      },
    ]);

    const callLine = transcript.split('\n').find((line) => line.startsWith('[tool call'))!;
    const json = JSON.stringify(longInput);
    expect(callLine.length).toBeLessThan(COMPACTION_TOOL_INPUT_CHARS + 60);
    expect(callLine).toContain(
      `[${(json.length - COMPACTION_TOOL_INPUT_CHARS).toLocaleString('en-US')} chars truncated]`,
    );

    const result = transcript.slice(transcript.indexOf('[tool result]'));
    expect(result).toContain('result line 1\n');
    expect(result).toContain('result line 400');
    expect(result).toMatch(/\.\.\. [\d,]+ characters omitted \.\.\./);
    expect(result).not.toContain('result line 200\n');
    expect(result.length).toBeLessThan(COMPACTION_TOOL_RESULT_CHARS + 100);
  });

  it('keeps short tool content intact', () => {
    const content = 'a'.repeat(COMPACTION_TOOL_RESULT_CHARS);
    const transcript = renderTranscript([
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c', content }] },
    ]);
    expect(transcript).toBe(`User:\n[tool result] ${content}`);
  });
});

describe('usageSinceCompaction', () => {
  it('ignores usage recorded before the latest compaction', () => {
    const session = new MemorySession();
    expect(usageSinceCompaction(session.entries())).toBeUndefined();
    const usage = { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    session.append({ type: 'usage', model: 'm', usage });
    session.append({ type: 'notice', level: 'info', text: 'x' });
    expect(usageSinceCompaction(session.entries())).toEqual(usage);
    session.append({ type: 'compaction', summary: 's', messagesCompacted: 2, auto: false });
    expect(usageSinceCompaction(session.entries())).toBeUndefined();
  });

  it('skips the usage of summary requests (they do not send the context)', () => {
    const session = new MemorySession();
    const usage = { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    session.append({ type: 'usage', model: 'm', usage });
    session.append({
      type: 'usage',
      model: 'm',
      purpose: 'summary',
      usage: { ...usage, inputTokens: 900 },
    });
    expect(usageSinceCompaction(session.entries())).toEqual(usage);
  });
});

describe('Agent.compact', () => {
  async function conversation() {
    const harness = createHarness([
      toolResponse([{ id: 'c1', name: 'echo', input: { text: 'a' } }], 'Checking.', {
        usage: { inputTokens: 3_000, outputTokens: 100 },
      }),
      textResponse('Found it.', {
        usage: { inputTokens: 3_500, outputTokens: 200, cacheReadTokens: 500 },
      }),
    ]);
    await runTurn(harness.agent, 'Find the bug');
    return harness;
  }

  it('summarizes the history with a dedicated request and replaces the model context', async () => {
    const harness = await conversation();
    const { agent, provider, session } = harness;
    const history = session.history();
    provider.push(
      textResponse('  ## Goal\nFix the bug.  ', { usage: { inputTokens: 900, outputTokens: 40 } }),
    );
    const events: AgentEvent[] = [];

    const result = await agent.compact({
      signal: never(),
      instructions: '  focus on tests ',
      onEvent: (event) => events.push(event),
    });

    expect(result).toEqual({
      summary: '## Goal\nFix the bug.',
      messagesCompacted: 4,
      usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    const request = provider.requests.at(-1)!;
    expect(request).toEqual({
      model: 'test-model',
      system: COMPACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `${renderTranscript(history)}\n\n${COMPACTION_INSTRUCTIONS}\n\nAdditional focus from the user: focus on tests`,
            },
          ],
        },
      ],
      tools: [],
      maxOutputTokens: 8_000,
      purpose: 'summary',
    });
    expect(events).toEqual([
      { type: 'compaction_start', auto: false },
      { type: 'compaction', summary: '## Goal\nFix the bug.', auto: false, messagesCompacted: 4 },
    ]);
    expect(session.entries().slice(-2)).toMatchObject([
      { type: 'usage', usage: { inputTokens: 900 } },
      {
        type: 'compaction',
        summary: '## Goal\nFix the bug.',
        messagesCompacted: 4,
        tokensBefore: 4_000,
        auto: false,
      },
    ]);
    expect(session.history()).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: `${COMPACTION_SUMMARY_PREFIX}\n\n## Goal\nFix the bug.` }],
      },
    ]);
    expect(agent.contextUsage().tokens).toBe(0);

    provider.push(textResponse('Continuing from the summary.'));
    await runTurn(agent, 'next step');
    const next = agentRequests(provider).at(-1)!;
    expect(next.messages.map((message) => textOf(message))).toEqual([
      `${COMPACTION_SUMMARY_PREFIX}\n\n## Goal\nFix the bug.`,
      'next step',
    ]);
    expect(next.system).toBe(agentRequests(provider)[0]?.system);
    expectValidHistory(session.history());
  });

  it('omits the focus line without instructions and caps output at the model limit', async () => {
    const harness = createHarness([textResponse('hi'), textResponse('summary')], {
      modelInfo: { maxOutputTokens: 4_096 },
    });
    await runTurn(harness.agent, 'hello');
    await harness.agent.compact({ signal: never(), instructions: '   ' });
    const request = harness.provider.requests.at(-1)!;
    expect(request.maxOutputTokens).toBe(4_096);
    expect(textOf(request.messages[0]!).endsWith(COMPACTION_INSTRUCTIONS)).toBe(true);
  });

  it('refuses when there is nothing to compact', async () => {
    const harness = createHarness([]);
    const events: AgentEvent[] = [];
    await expect(
      harness.agent.compact({ signal: never(), onEvent: (event) => events.push(event) }),
    ).rejects.toThrow('Nothing to compact yet.');
    expect(events).toEqual([]);
    expect(harness.provider.requests).toHaveLength(0);
  });

  it('rejects an empty summary: no compaction, but the request is still accounted for', async () => {
    const harness = await conversation();
    const before = harness.session.entries().length;
    const history = harness.session.history();
    const context = harness.agent.contextUsage();
    harness.provider.push(textResponse('   ', { usage: { inputTokens: 900, outputTokens: 3 } }));
    const failure = harness.agent.compact({ signal: never() });
    await expect(failure).rejects.toThrow('Compaction produced an empty summary.');
    await expect(failure).rejects.toBeInstanceOf(SummaryRejectedError);

    expect(harness.session.entries().slice(before)).toEqual([
      expect.objectContaining({
        type: 'usage',
        purpose: 'summary',
        model: 'test-model',
        usage: { inputTokens: 900, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    ]);
    expect(harness.session.history()).toEqual(history);
    // The summary request's size is not the conversation's.
    expect(harness.agent.contextUsage()).toEqual(context);
  });

  it('rejects a summary cut off at the output limit twice: no compaction, both requests counted', async () => {
    const harness = await conversation();
    const before = harness.session.entries().length;
    const totals = harness.session.usageTotals();
    harness.provider.push(
      textResponse('## Goal\nThe user wants to refactor the auth mod', {
        stopReason: 'max_tokens',
        usage: { inputTokens: 900, outputTokens: 8_000 },
      }),
      textResponse('## Goal\nThe user wants to refactor the auth module.\n\n## Op', {
        stopReason: 'max_tokens',
        usage: { inputTokens: 900, outputTokens: 16_000 },
      }),
    );
    await expect(harness.agent.compact({ signal: never() })).rejects.toThrow(
      'The summary was cut off at the output token limit before it was complete.',
    );
    expect(harness.session.ofType('compaction')).toEqual([]);
    expect(harness.session.entries().slice(before)).toMatchObject([
      { type: 'usage', purpose: 'summary', usage: { inputTokens: 1_800, outputTokens: 24_000 } },
    ]);
    expect(harness.session.usageTotals()).toMatchObject({
      inputTokens: totals.inputTokens + 1_800,
      outputTokens: totals.outputTokens + 24_000,
    });
    // One retry with a larger budget (capped at the model's limit, 32000 here).
    expect(
      harness.provider.requests
        .filter((r) => r.purpose === 'summary')
        .map((r) => r.maxOutputTokens),
    ).toEqual([8_000, 16_000]);
  });

  it('records a declined summary request', async () => {
    const harness = await conversation();
    const before = harness.session.entries().length;
    harness.provider.push(
      textResponse('', {
        stopReason: 'refusal',
        usage: { inputTokens: 900, outputTokens: 2 },
        refusal: { category: 'cyber', explanation: null },
      }),
    );
    await expect(harness.agent.compact({ signal: never() })).rejects.toThrow(
      'The model declined to summarize this conversation.',
    );
    expect(harness.session.entries().slice(before)).toMatchObject([
      { type: 'usage', purpose: 'summary', usage: { inputTokens: 900, outputTokens: 2 } },
    ]);
  });

  it('records the first summary request when its retry fails at the provider', async () => {
    const harness = await conversation();
    const before = harness.session.entries().length;
    const failure = new ProviderError('overloaded', 'busy', { provider: 'anthropic' });
    harness.provider.push(
      textResponse('## Goal\nCut', {
        stopReason: 'max_tokens',
        usage: { inputTokens: 900, outputTokens: 8_000 },
      }),
      { error: failure },
    );
    await expect(harness.agent.compact({ signal: never() })).rejects.toBe(failure);
    expect(harness.session.entries().slice(before)).toMatchObject([
      { type: 'usage', purpose: 'summary', usage: { inputTokens: 900, outputTokens: 8_000 } },
    ]);
    expect(harness.session.ofType('compaction')).toEqual([]);
  });

  it('records the billed usage of a summary served by a fallback', async () => {
    const provider = new BilledProvider([
      textResponse('hi', { usage: { inputTokens: 300, outputTokens: 10 } }),
      textResponse('## Goal\nSay hi.', { usage: { inputTokens: 900, outputTokens: 50 } }),
    ]);
    provider.billed.set(1, { inputTokens: 1_800, outputTokens: 60 });
    const harness = createHarness([], { provider });
    await runTurn(harness.agent, 'hello');

    const result = await harness.agent.compact({ signal: never() });

    const billed = {
      inputTokens: 1_800,
      outputTokens: 60,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(result.usage).toEqual(billed);
    expect(harness.session.ofType('usage').at(-1)).toMatchObject({
      purpose: 'summary',
      usage: { inputTokens: 900, outputTokens: 50 },
      billed,
    });
    expect(harness.session.usageTotals()).toMatchObject({ inputTokens: 2_100, outputTokens: 70 });
  });

  it('retries a summary cut off at the output limit once with a larger budget', async () => {
    const harness = await conversation();
    harness.provider.push(
      textResponse('## Goal\nRefactor the auth mod', {
        stopReason: 'max_tokens',
        usage: { inputTokens: 1_000, outputTokens: 8_000 },
      }),
      textResponse('## Goal\nRefactor the auth module.\n\n## Open work\nTests.', {
        usage: { inputTokens: 1_000, outputTokens: 9_000 },
      }),
    );
    const result = await harness.agent.compact({ signal: never() });
    expect(result.summary).toBe('## Goal\nRefactor the auth module.\n\n## Open work\nTests.');
    expect(result.usage).toMatchObject({ inputTokens: 2_000, outputTokens: 17_000 });
    expect(harness.session.ofType('compaction')[0]?.summary).toBe(result.summary);
  });

  it('does not retry when the model allows no larger output, or the context window was full', async () => {
    const small = createHarness(
      [textResponse('hi'), textResponse('## Goal\nCut', { stopReason: 'max_tokens' })],
      { modelInfo: { maxOutputTokens: 8_000 } },
    );
    await runTurn(small.agent, 'hello');
    await expect(small.agent.compact({ signal: never() })).rejects.toThrow(/cut off/);
    expect(small.provider.requests.filter((r) => r.purpose === 'summary')).toHaveLength(1);

    const full = await conversation();
    full.provider.push(textResponse('## Goal\nCut', { stopReason: 'context_window_exceeded' }));
    await expect(full.agent.compact({ signal: never() })).rejects.toThrow(
      "The summary was cut off because the conversation filled the model's context window.",
    );
    expect(full.session.ofType('compaction')).toEqual([]);
    expect(full.provider.requests.filter((r) => r.purpose === 'summary')).toHaveLength(1);
  });

  it('propagates provider errors without changing the session', async () => {
    const harness = await conversation();
    const before = harness.session.entries().length;
    const failure = new ProviderError('rate_limit', 'Too many requests', { provider: 'anthropic' });
    harness.provider.push({ error: failure });
    await expect(harness.agent.compact({ signal: never() })).rejects.toBe(failure);
    expect(harness.session.entries()).toHaveLength(before);

    // The agent is usable again afterwards.
    harness.provider.push(textResponse('summary'));
    await expect(harness.agent.compact({ signal: never() })).resolves.toMatchObject({
      summary: 'summary',
    });
  });

  it('rejects overlapping compactions and turns during a compaction', async () => {
    const harness = await conversation();
    harness.provider.push(textResponse('summary', { chunkSize: 2, chunkDelayMs: 10 }));
    const first = harness.agent.compact({ signal: never() });
    await expect(harness.agent.compact({ signal: never() })).rejects.toThrow(
      'A compaction is already running.',
    );
    const turn = await runTurn(harness.agent, 'hello?');
    expect(turn.result).toMatchObject({
      status: 'error',
      error: { title: 'Patch is compacting the conversation.' },
    });
    await expect(first).resolves.toMatchObject({ summary: 'summary' });
  });
});

describe('automatic compaction', () => {
  const smallWindow = { contextWindow: 1_000 };

  it('compacts before the turn when the last request exceeded the threshold', async () => {
    const harness = createHarness(
      [
        textResponse('first answer', { usage: { inputTokens: 830, outputTokens: 30 } }),
        textResponse('auto summary', { usage: { inputTokens: 700, outputTokens: 20 } }),
        textResponse('second answer', { usage: { inputTokens: 150, outputTokens: 10 } }),
      ],
      { modelInfo: smallWindow },
    );
    await runTurn(harness.agent, 'first');
    const { result, events } = await runTurn(harness.agent, 'second');

    expect(result.status).toBe('completed');
    expect(eventTypes(events).slice(0, 4)).toEqual([
      'turn_start',
      'compaction_start',
      'compaction',
      'model_start',
    ]);
    expect(eventsOf(events, 'compaction')[0]).toMatchObject({
      auto: true,
      summary: 'auto summary',
    });
    expect(harness.provider.requests.map((request) => request.purpose)).toEqual([
      'agent',
      'summary',
      'agent',
    ]);
    expect(agentRequests(harness.provider)[1]?.messages.map((message) => textOf(message))).toEqual([
      `${COMPACTION_SUMMARY_PREFIX}\n\nauto summary`,
      'second',
    ]);
    expect(harness.session.ofType('compaction')[0]).toMatchObject({
      auto: true,
      messagesCompacted: 2,
      tokensBefore: 830,
    });
    // The turn's usage includes the summary request.
    expect(result.usage).toMatchObject({ inputTokens: 850, outputTokens: 30 });
  });

  it('does not compact at or below the threshold, or when disabled', async () => {
    const atThreshold = createHarness(
      [textResponse('a', { usage: { inputTokens: 830, outputTokens: 20 } }), textResponse('b')],
      { modelInfo: smallWindow },
    );
    await runTurn(atThreshold.agent, 'one');
    await runTurn(atThreshold.agent, 'two');
    expect(atThreshold.provider.requests.map((request) => request.purpose)).toEqual([
      'agent',
      'agent',
    ]);

    const disabled = createHarness(
      [textResponse('a', { usage: { inputTokens: 990 } }), textResponse('b')],
      { modelInfo: smallWindow, agent: { autoCompact: false } },
    );
    await runTurn(disabled.agent, 'one');
    await runTurn(disabled.agent, 'two');
    expect(disabled.provider.requests.map((request) => request.purpose)).toEqual([
      'agent',
      'agent',
    ]);
  });

  it('honors a custom threshold', async () => {
    const harness = createHarness(
      [
        textResponse('a', { usage: { inputTokens: 480, outputTokens: 30 } }),
        textResponse('summary'),
        textResponse('b'),
      ],
      { modelInfo: smallWindow, agent: { autoCompactThreshold: 0.5 } },
    );
    await runTurn(harness.agent, 'one');
    await runTurn(harness.agent, 'two');
    expect(harness.provider.requests.map((request) => request.purpose)).toEqual([
      'agent',
      'summary',
      'agent',
    ]);
  });

  it('does not compact again right after a manual compaction', async () => {
    const harness = createHarness(
      [
        textResponse('a', { usage: { inputTokens: 950 } }),
        textResponse('manual summary', { usage: { inputTokens: 990, outputTokens: 5 } }),
        textResponse('b'),
      ],
      { modelInfo: smallWindow },
    );
    await runTurn(harness.agent, 'one');
    await harness.agent.compact({ signal: never() });
    const { events } = await runTurn(harness.agent, 'two');
    expect(eventTypes(events)).not.toContain('compaction_start');
    expect(harness.provider.requests.map((request) => request.purpose)).toEqual([
      'agent',
      'summary',
      'agent',
    ]);
  });

  it('warns and continues with the full history when auto compaction fails', async () => {
    const harness = createHarness(
      [
        textResponse('a', { usage: { inputTokens: 950 } }),
        { error: new ProviderError('overloaded', 'busy', { provider: 'anthropic' }) },
        textResponse('b'),
      ],
      { modelInfo: smallWindow },
    );
    await runTurn(harness.agent, 'one');
    const { result, events } = await runTurn(harness.agent, 'two');
    expect(result.status).toBe('completed');
    expect(eventsOf(events, 'notice')).toEqual([
      {
        type: 'notice',
        level: 'warn',
        text: 'Automatic compaction failed: Anthropic is temporarily overloaded.',
        hint: 'Patch continued without compacting. Run /compact to try again.',
      },
    ]);
    expect(harness.session.ofType('compaction')).toHaveLength(0);
    expect(agentRequests(harness.provider)[1]?.messages.map((message) => textOf(message))).toEqual([
      'one',
      'a',
      'two',
    ]);
  });

  it('an interruption during auto compaction ends the turn as interrupted', async () => {
    const harness = createHarness(
      [
        textResponse('a', { usage: { inputTokens: 950 } }),
        textResponse('summary', { chunkSize: 1, chunkDelayMs: 50 }),
      ],
      { modelInfo: smallWindow },
    );
    await runTurn(harness.agent, 'one');
    const controller = new AbortController();
    const { result, events } = await runTurn(harness.agent, 'two', {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'compaction_start') setTimeout(() => controller.abort(), 10);
      },
    });
    expect(result).toMatchObject({ status: 'interrupted', steps: 0 });
    expect(eventsOf(events, 'notice')).toEqual([]);
    expect(harness.session.ofType('compaction')).toHaveLength(0);
    expect(
      harness.session
        .messages()
        .slice(-2)
        .map((message) => textOf(message)),
    ).toEqual(['two', INTERRUPTED_MARKER]);
  });

  it('counts summary requests that produced no summary in the turn and session usage', async () => {
    const harness = createHarness(
      [
        textResponse('a', { usage: { inputTokens: 950, outputTokens: 1 } }),
        textResponse('## Goal\nCut', {
          stopReason: 'max_tokens',
          usage: { inputTokens: 900, outputTokens: 8_000 },
        }),
        textResponse('## Goal\nCut again', {
          stopReason: 'max_tokens',
          usage: { inputTokens: 900, outputTokens: 16_000 },
        }),
        textResponse('b', { usage: { inputTokens: 960, outputTokens: 1 } }),
      ],
      { modelInfo: smallWindow },
    );
    await runTurn(harness.agent, 'one');
    const { result } = await runTurn(harness.agent, 'two');

    expect(harness.provider.requests.map((request) => request.purpose)).toEqual([
      'agent',
      'summary',
      'summary',
      'agent',
    ]);
    expect(result.usage).toMatchObject({ inputTokens: 2_760, outputTokens: 24_001 });
    expect(harness.session.usageTotals()).toMatchObject({
      inputTokens: 3_710,
      outputTokens: 24_002,
    });
    // Context accounting still follows the agent requests.
    expect(harness.agent.contextUsage().tokens).toBe(961);
  });

  it('counts the billed usage of an automatic summary in the turn', async () => {
    const provider = new BilledProvider(
      [
        textResponse('a', { usage: { inputTokens: 950 } }),
        textResponse('summary', { usage: { inputTokens: 700, outputTokens: 20 } }),
        textResponse('b', { usage: { inputTokens: 100, outputTokens: 10 } }),
      ],
      smallWindow,
    );
    provider.billed.set(1, { inputTokens: 1_400, outputTokens: 30 });
    const harness = createHarness([], { provider });
    await runTurn(harness.agent, 'one');
    const { result } = await runTurn(harness.agent, 'two');
    expect(harness.session.ofType('compaction')).toHaveLength(1);
    expect(result.usage).toMatchObject({ inputTokens: 1_500, outputTokens: 40 });
  });

  it('holds off asking again for a summary the model failed to produce until the context grows', async () => {
    const cutOff = () => textResponse('## Goal\nCut', { stopReason: 'max_tokens' });
    const harness = createHarness(
      [
        textResponse('a', { usage: { inputTokens: 900, outputTokens: 50 } }),
        cutOff(),
        cutOff(),
        textResponse('b', { usage: { inputTokens: 960, outputTokens: 10 } }),
        // 970 tokens: grown by less than 5% of the window since the rejected attempt at 950.
        textResponse('c', { usage: { inputTokens: 990, outputTokens: 10 } }),
        // 1000 tokens: grown enough to try again.
        textResponse('summary'),
        textResponse('d'),
      ],
      { modelInfo: smallWindow },
    );
    await runTurn(harness.agent, 'one');
    const two = await runTurn(harness.agent, 'two');
    const three = await runTurn(harness.agent, 'three');
    const four = await runTurn(harness.agent, 'four');

    expect(harness.provider.requests.map((request) => request.purpose)).toEqual([
      'agent',
      'summary',
      'summary',
      'agent',
      'agent',
      'summary',
      'agent',
    ]);
    expect(eventsOf(two.events, 'notice')).toHaveLength(1);
    expect(eventTypes(three.events)).not.toContain('compaction_start');
    expect(eventsOf(four.events, 'compaction')).toHaveLength(1);
    expect(harness.provider.remaining).toBe(0);
  });

  it('asks again right away after a model change, and after a provider failure', async () => {
    const harness = createHarness(
      [
        textResponse('a', { usage: { inputTokens: 900, outputTokens: 50 } }),
        textResponse('', { stopReason: 'refusal' }),
        textResponse('b', { usage: { inputTokens: 900, outputTokens: 50 } }),
        textResponse('summary'),
        textResponse('c', { usage: { inputTokens: 900, outputTokens: 50 } }),
        { error: new ProviderError('overloaded', 'busy', { provider: 'anthropic' }) },
        textResponse('d', { usage: { inputTokens: 900, outputTokens: 50 } }),
        textResponse('summary'),
        textResponse('e'),
      ],
      { modelInfo: smallWindow },
    );
    await runTurn(harness.agent, 'one');
    await runTurn(harness.agent, 'two'); // declined
    harness.agent.setModel('other-model');
    await runTurn(harness.agent, 'three'); // compacts with the other model
    await runTurn(harness.agent, 'four'); // provider failure: not a rejected summary
    await runTurn(harness.agent, 'five'); // tries again at the same size
    expect(harness.provider.requests.map((request) => request.purpose)).toEqual([
      'agent',
      'summary',
      'agent',
      'summary',
      'agent',
      'summary',
      'agent',
      'summary',
      'agent',
    ]);
    expect(harness.session.ofType('compaction')).toHaveLength(2);
  });

  it('keeps the auto-compaction warning when the summary is cut off, and does not compact', async () => {
    const harness = createHarness(
      [
        textResponse('a', { usage: { inputTokens: 950 } }),
        textResponse('## Goal\nCut', { stopReason: 'max_tokens' }),
        textResponse('## Goal\nCut again', { stopReason: 'max_tokens' }),
        textResponse('b'),
      ],
      { modelInfo: smallWindow },
    );
    await runTurn(harness.agent, 'one');
    const { result, events } = await runTurn(harness.agent, 'two');
    expect(result.status).toBe('completed');
    expect(eventsOf(events, 'notice')[0]?.text).toBe(
      'Automatic compaction failed: The summary was cut off at the output token limit before it was complete.',
    );
    expect(harness.session.ofType('compaction')).toHaveLength(0);
  });
});

describe('recovery from a request that does not fit in the context window', () => {
  const smallWindow = { contextWindow: 1_000 };
  const tooLong = () =>
    new ProviderError('context_length', 'prompt is too long: 1210 tokens > 1000 maximum', {
      provider: 'anthropic',
      status: 400,
    });
  const purposes = (harness: ReturnType<typeof createHarness>) =>
    harness.provider.requests.map((request) => request.purpose);

  it('compacts and resends the user message when the first request of a turn overflows', async () => {
    const harness = createHarness(
      [
        // Below the 85% threshold, so nothing compacts before the next turn.
        textResponse('first answer', { usage: { inputTokens: 700, outputTokens: 50 } }),
        { error: tooLong() },
        textResponse('## Goal\nAnswer questions.', {
          usage: { inputTokens: 600, outputTokens: 30 },
        }),
        textResponse('second answer', { usage: { inputTokens: 120, outputTokens: 10 } }),
      ],
      { modelInfo: smallWindow },
    );
    await runTurn(harness.agent, 'first');
    const { result, events } = await runTurn(harness.agent, 'a very long second message');

    expect(result).toMatchObject({ status: 'completed', finalText: 'second answer', steps: 1 });
    expect(purposes(harness)).toEqual(['agent', 'agent', 'summary', 'agent']);
    expect(eventTypes(events)).toEqual(
      expect.arrayContaining(['compaction_start', 'compaction', 'turn_end']),
    );
    expect(eventsOf(events, 'notice')).toEqual([]);
    const retried = agentRequests(harness.provider).at(-1)!;
    expect(retried.messages.map((message) => textOf(message))).toEqual([
      `${COMPACTION_SUMMARY_PREFIX}\n\n## Goal\nAnswer questions.`,
      'a very long second message',
    ]);
    expectValidHistory(retried.messages);
    expect(harness.session.ofType('compaction')[0]).toMatchObject({ auto: true });
    // The summary request's usage is part of the turn.
    expect(result.usage).toMatchObject({ inputTokens: 720, outputTokens: 40 });
  });

  it('compacts mid-turn when tool results overflow, and continues from the summary', async () => {
    const harness = createHarness(
      [
        toolResponse([{ id: 'c1', name: 'echo', input: { text: 'big file' } }], 'Reading.', {
          usage: { inputTokens: 700, outputTokens: 50 },
        }),
        { error: tooLong() },
        textResponse('## Goal\nRead the file.\n\n## Open work\nReport on it.'),
        textResponse('The file says hello.'),
      ],
      { modelInfo: smallWindow },
    );
    const { result } = await runTurn(harness.agent, 'read it');

    expect(result).toMatchObject({ status: 'completed', finalText: 'The file says hello.' });
    expect(purposes(harness)).toEqual(['agent', 'agent', 'summary', 'agent']);
    const summaryRequest = harness.provider.requests[2]!;
    // The tool results that overflowed the request are summarized, not lost.
    expect(textOf(summaryRequest.messages[0]!)).toContain('[tool result] echo: big file');
    const retried = agentRequests(harness.provider).at(-1)!;
    expect(retried.messages.map((message) => textOf(message))).toEqual([
      `${COMPACTION_SUMMARY_PREFIX}\n\n## Goal\nRead the file.\n\n## Open work\nReport on it.`,
    ]);
    expectValidHistory(harness.session.history());
  });

  it('compacts at most once per turn, then reports the error with the /compact hint', async () => {
    const harness = createHarness(
      [{ error: tooLong() }, textResponse('summary'), { error: tooLong() }],
      { modelInfo: smallWindow },
    );
    const { result } = await runTurn(harness.agent, 'huge paste');
    expect(result.status).toBe('error');
    expect(result.error?.hint).toMatch(/\/compact/);
    expect(purposes(harness)).toEqual(['agent', 'summary', 'agent']);
    expectValidHistory(harness.session.history());
  });

  it('reports the original error when compaction fails, and tries again on the next turn', async () => {
    const harness = createHarness(
      [
        textResponse('a', { usage: { inputTokens: 700 } }),
        { error: tooLong() },
        { error: new ProviderError('overloaded', 'busy', { provider: 'anthropic' }) },
        { error: tooLong() },
        textResponse('summary'),
        textResponse('recovered'),
      ],
      { modelInfo: smallWindow },
    );
    await runTurn(harness.agent, 'one');
    const failed = await runTurn(harness.agent, 'two');
    expect(failed.result.status).toBe('error');
    expect(failed.result.error?.title).toMatch(/no longer fits/);
    expect(eventsOf(failed.events, 'notice').map((notice) => notice.text)).toEqual([
      'Automatic compaction failed: Anthropic is temporarily overloaded.',
      failed.result.error?.title,
    ]);
    expect(harness.session.ofType('compaction')).toHaveLength(0);

    // A later turn (also in print mode, which has no /compact) recovers by itself.
    const next = await runTurn(harness.agent, 'three');
    expect(next.result).toMatchObject({ status: 'completed', finalText: 'recovered' });
    expect(
      agentRequests(harness.provider)
        .at(-1)!
        .messages.map((m) => textOf(m)),
    ).toEqual([`${COMPACTION_SUMMARY_PREFIX}\n\nsummary`, 'three']);
  });

  it('does not compact when auto-compaction is disabled', async () => {
    const harness = createHarness([{ error: tooLong() }], {
      modelInfo: smallWindow,
      agent: { autoCompact: false },
    });
    const { result } = await runTurn(harness.agent, 'x');
    expect(result.status).toBe('error');
    expect(purposes(harness)).toEqual(['agent']);
  });

  it('an interruption during that compaction ends the turn as interrupted', async () => {
    const harness = createHarness(
      [{ error: tooLong() }, textResponse('summary', { chunkSize: 1, chunkDelayMs: 50 })],
      { modelInfo: smallWindow },
    );
    const controller = new AbortController();
    const { result, events } = await runTurn(harness.agent, 'x', {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'compaction_start') setTimeout(() => controller.abort(), 10);
      },
    });
    expect(result.status).toBe('interrupted');
    expect(eventsOf(events, 'notice')).toEqual([]);
    expect(harness.session.ofType('compaction')).toHaveLength(0);
    expectValidHistory(harness.session.history());
  });
});
