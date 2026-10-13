import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  textOf,
  type Message,
  type ModelEvent,
  type ModelRequest,
} from '@patch/shared';
import { USER_SHELL_CONTEXT_TAG } from '../../src/session/schema.js';
import { ScriptedProvider, textResponse, toolResponse } from '../../src/testing/index.js';
import { TRUNCATED_TOOL_MESSAGE } from '../../src/agent/tool-runner.js';
import {
  TEST_MODEL,
  TEST_SYSTEM,
  agentRequests,
  createHarness,
  eventTypes,
  eventsOf,
  expectAppendOnly,
  expectValidHistory,
  runTurn,
} from './helpers.js';

function userText(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

describe('Agent.runTurn: text turns', () => {
  it('streams a text answer, emits events in order and persists the exchange', async () => {
    const { agent, provider, session } = createHarness([
      textResponse('Hello there, colleague.', {
        chunkSize: 6,
        usage: { inputTokens: 120, outputTokens: 7, cacheReadTokens: 30 },
      }),
    ]);

    const { result, events } = await runTurn(agent, 'Say hello');

    expect(result).toEqual({
      status: 'completed',
      finalText: 'Hello there, colleague.',
      steps: 1,
      toolCalls: 0,
      usage: { inputTokens: 120, outputTokens: 7, cacheReadTokens: 30, cacheWriteTokens: 0 },
    });
    expect(eventTypes(events)).toEqual([
      'turn_start',
      'model_start',
      'text_delta',
      'text_delta',
      'text_delta',
      'text_delta',
      'text_end',
      'usage',
      'turn_end',
    ]);
    expect(events[0]).toEqual({ type: 'turn_start', text: 'Say hello' });
    expect(events[1]).toEqual({ type: 'model_start', step: 1, model: TEST_MODEL });
    expect(
      eventsOf(events, 'text_delta')
        .map((event) => event.text)
        .join(''),
    ).toBe('Hello there, colleague.');
    expect(eventsOf(events, 'usage')[0]).toEqual({
      type: 'usage',
      model: TEST_MODEL,
      usage: { inputTokens: 120, outputTokens: 7, cacheReadTokens: 30, cacheWriteTokens: 0 },
      contextTokens: 157,
      contextWindow: 200_000,
    });
    expect(eventsOf(events, 'turn_end')[0]?.result).toEqual(result);

    expect(session.entries().map((entry) => entry.type)).toEqual([
      'meta',
      'message',
      'usage',
      'message',
    ]);
    expect(session.messages()).toEqual([
      userText('Say hello'),
      { role: 'assistant', content: [{ type: 'text', text: 'Hello there, colleague.' }] },
    ]);

    const [request] = provider.requests;
    expect(request).toMatchObject({
      model: TEST_MODEL,
      system: TEST_SYSTEM,
      messages: [userText('Say hello')],
      maxOutputTokens: 32_000,
      purpose: 'agent',
    });
    expect(request?.tools.map((tool) => tool.name)).toEqual([
      'echo',
      'note',
      'slow',
      'fail',
      'crash',
      'progress',
      'badpath',
    ]);
  });

  it('forwards thinking and progress notes and closes text runs around them', async () => {
    const { agent } = createHarness([{ progress: ['Checking the config'], text: 'Done.' }]);
    const { events } = await runTurn(agent, 'go');
    expect(eventTypes(events)).toEqual([
      'turn_start',
      'model_start',
      'thinking',
      'progress',
      'text_delta',
      'text_end',
      'usage',
      'turn_end',
    ]);
    expect(eventsOf(events, 'progress')[0]?.text).toBe('Checking the config');
  });

  it('uses the configured output cap, else min(64000, model max)', async () => {
    const capped = createHarness([textResponse('a')], { agent: { maxOutputTokens: 1_234 } });
    await runTurn(capped.agent, 'q');
    expect(capped.provider.requests[0]?.maxOutputTokens).toBe(1_234);

    const big = createHarness([textResponse('a')], { modelInfo: { maxOutputTokens: 128_000 } });
    await runTurn(big.agent, 'q');
    expect(big.provider.requests[0]?.maxOutputTokens).toBe(64_000);
  });

  it('keeps the frozen system prompt and continues the conversation across turns', async () => {
    const { agent, provider, session } = createHarness([textResponse('one'), textResponse('two')]);
    await runTurn(agent, 'first');
    const second = await runTurn(agent, 'second');
    expect(second.result.finalText).toBe('two');
    expect(provider.requests[1]?.messages).toEqual([
      userText('first'),
      { role: 'assistant', content: [{ type: 'text', text: 'one' }] },
      userText('second'),
    ]);
    expectAppendOnly(agentRequests(provider));
    expectValidHistory(session.history());
  });

  it('rejects an empty message without touching the history', async () => {
    const { agent, provider, session } = createHarness([]);
    const { result, events } = await runTurn(agent, '   ');
    expect(result.status).toBe('error');
    expect(result.error?.title).toMatch(/empty/);
    expect(eventTypes(events)).toEqual(['turn_start', 'turn_end']);
    expect(provider.requests).toHaveLength(0);
    expect(session.entries()).toHaveLength(1);
  });
});

describe('Agent.runTurn: tool loop', () => {
  it('pairs every tool call with one result message and keeps requests append-only', async () => {
    const { agent, provider, session } = createHarness([
      toolResponse([{ id: 'c1', name: 'echo', input: { text: 'a' } }], 'Looking.'),
      toolResponse([
        { id: 'c2', name: 'echo', input: { text: 'b' } },
        { id: 'c3', name: 'echo', input: { text: 'c' } },
      ]),
      textResponse('All done.'),
    ]);

    const { result, events } = await runTurn(agent, 'Do the thing');

    expect(result).toMatchObject({
      status: 'completed',
      finalText: 'All done.',
      steps: 3,
      toolCalls: 3,
    });
    const requests = agentRequests(provider);
    expect(requests).toHaveLength(3);
    expect(requests[1]?.messages).toEqual([
      userText('Do the thing'),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Looking.' },
          { type: 'tool_call', id: 'c1', name: 'echo', input: { text: 'a' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: 'echo: a' }] },
    ]);
    expect(requests[2]?.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', toolCallId: 'c2', content: 'echo: b' },
        { type: 'tool_result', toolCallId: 'c3', content: 'echo: c' },
      ],
    });
    expectAppendOnly(requests);
    expectValidHistory(session.history());

    // Text run closes before the tool call starts streaming.
    const types = eventTypes(events);
    expect(types.slice(0, 6)).toEqual([
      'turn_start',
      'model_start',
      'text_delta',
      'text_end',
      'tool_prepare',
      'tool_prepare',
    ]);
    expect(eventsOf(events, 'tool_prepare').slice(0, 2)).toEqual([
      { type: 'tool_prepare', id: 'c1', name: 'echo', inputBytes: 0 },
      {
        type: 'tool_prepare',
        id: 'c1',
        name: 'echo',
        inputBytes: JSON.stringify({ text: 'a' }).length,
      },
    ]);
    const start = eventsOf(events, 'tool_start')[0];
    expect(start).toEqual({
      type: 'tool_start',
      id: 'c1',
      name: 'echo',
      summary: { verb: 'echo', target: 'a' },
      input: { text: 'a' },
    });
    const end = eventsOf(events, 'tool_end')[0];
    expect(end).toMatchObject({
      id: 'c1',
      name: 'echo',
      summary: { verb: 'echo', target: 'a' },
      result: { content: 'echo: a' },
    });
    expect(end?.denied).toBeUndefined();
    expect(end?.durationMs).toBeGreaterThanOrEqual(0);

    const toolEntries = session.ofType('tool');
    expect(toolEntries.map((entry) => entry.callId)).toEqual(['c1', 'c2', 'c3']);
    expect(toolEntries[0]).toMatchObject({
      name: 'echo',
      summary: { verb: 'echo', target: 'a' },
      isError: false,
    });
    expect(session.ofType('usage')).toHaveLength(3);
  });

  it('sums usage over every request of the turn', async () => {
    const { agent } = createHarness([
      toolResponse([{ name: 'echo', input: { text: 'x' } }], undefined, {
        usage: { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 100 },
      }),
      textResponse('ok', { usage: { inputTokens: 20, outputTokens: 7, cacheReadTokens: 100 } }),
    ]);
    const { result } = await runTurn(agent, 'go');
    expect(result.usage).toEqual({
      inputTokens: 30,
      outputTokens: 12,
      cacheReadTokens: 100,
      cacheWriteTokens: 100,
    });
  });

  it('continues after a pause without adding tool results', async () => {
    const { agent, provider, session } = createHarness([
      textResponse('Part one.', { stopReason: 'pause' }),
      textResponse('Part two.'),
    ]);
    const { result } = await runTurn(agent, 'long task');
    expect(result).toMatchObject({ status: 'completed', finalText: 'Part two.', steps: 2 });
    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Part one.' }],
    });
    expectAppendOnly(agentRequests(provider));
    expectValidHistory(session.history());
  });

  it('stops at the step limit with a notice and a valid history', async () => {
    const { agent, provider, session } = createHarness(
      [
        toolResponse([{ name: 'echo', input: { text: '1' } }]),
        toolResponse([{ name: 'echo', input: { text: '2' } }]),
        toolResponse([{ name: 'echo', input: { text: '3' } }]),
      ],
      { agent: { maxStepsPerTurn: 2 } },
    );
    const { result, events } = await runTurn(agent, 'loop forever');
    expect(result).toMatchObject({ status: 'max_steps', steps: 2, toolCalls: 2 });
    expect(provider.requests).toHaveLength(2);
    expect(eventsOf(events, 'notice')).toEqual([
      {
        type: 'notice',
        level: 'warn',
        text: 'Stopped after 2 steps. Send a message to let Patch continue.',
      },
    ]);
    expect(session.ofType('notice').map((entry) => entry.text)).toEqual([
      'Stopped after 2 steps. Send a message to let Patch continue.',
    ]);
    expectValidHistory(session.history());
  });

  it('surfaces provider notices as info notices', async () => {
    class NoticeProvider extends ScriptedProvider {
      override async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
        for await (const event of super.stream(request)) {
          yield event.type === 'message_end'
            ? { ...event, notices: ['Fallback model served this turn.'] }
            : event;
        }
      }
    }
    const { agent, session } = createHarness([], {
      provider: new NoticeProvider([
        textResponse('ok'),
        { stopReason: 'refusal', refusal: { category: null, explanation: null } },
      ]),
    });
    const { events } = await runTurn(agent, 'hi');
    expect(eventsOf(events, 'notice')).toEqual([
      { type: 'notice', level: 'info', text: 'Fallback model served this turn.' },
    ]);
    expect(session.ofType('notice')[0]).toMatchObject({ level: 'info' });

    const refused = await runTurn(agent, 'again');
    expect(eventsOf(refused.events, 'notice').map((event) => event.level)).toEqual([
      'info',
      'warn',
    ]);
  });
});

describe('Agent.runTurn: stop reasons', () => {
  it('max_tokens without tool calls: keeps the text and ends truncated', async () => {
    const { agent, session } = createHarness([
      textResponse('A very long answer that got cu', { stopReason: 'max_tokens' }),
    ]);
    const { result, events } = await runTurn(agent, 'explain');
    expect(result).toMatchObject({
      status: 'truncated',
      finalText: 'A very long answer that got cu',
    });
    expect(eventsOf(events, 'notice')[0]).toMatchObject({
      level: 'warn',
      text: 'The response was cut off at the output token limit.',
    });
    expect(session.messages().at(-1)?.role).toBe('assistant');
  });

  it('max_tokens with tool calls: answers the cut-off calls with errors and continues', async () => {
    const { agent, provider, session, lab } = createHarness([
      toolResponse(
        [{ id: 'big', name: 'note', input: { path: 'a.txt', content: 'x' } }],
        undefined,
        {
          stopReason: 'max_tokens',
        },
      ),
      textResponse('I will write it in parts.'),
    ]);
    const { result, events } = await runTurn(agent, 'write a huge file');
    expect(result).toMatchObject({ status: 'completed', steps: 2, toolCalls: 0 });
    expect(lab.log).toEqual([]);
    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', toolCallId: 'big', content: TRUNCATED_TOOL_MESSAGE, isError: true },
      ],
    });
    expect(eventsOf(events, 'tool_end')).toHaveLength(1);
    expect(eventsOf(events, 'tool_start')).toHaveLength(0);
    expectValidHistory(session.history());
    expectAppendOnly(agentRequests(provider));
  });

  it('stops after two consecutive cut-off tool responses', async () => {
    const cutOff = () =>
      toolResponse([{ name: 'note', input: { path: 'a.txt', content: 'x' } }], undefined, {
        stopReason: 'max_tokens',
      });
    const { agent, provider, session } = createHarness([cutOff(), cutOff(), textResponse('never')]);
    const { result, events } = await runTurn(agent, 'write');
    expect(result.status).toBe('truncated');
    expect(provider.requests).toHaveLength(2);
    expect(eventsOf(events, 'notice').at(-1)).toMatchObject({ level: 'warn' });
    expectValidHistory(session.history());
  });

  it('resets the truncation streak after a normal step', async () => {
    const cutOff = () =>
      toolResponse([{ name: 'echo', input: { text: 'x' } }], undefined, {
        stopReason: 'max_tokens',
      });
    const { agent } = createHarness([
      cutOff(),
      toolResponse([{ name: 'echo', input: { text: 'y' } }]),
      cutOff(),
      textResponse('done'),
    ]);
    const { result } = await runTurn(agent, 'go');
    expect(result).toMatchObject({ status: 'completed', steps: 4 });
  });

  it('context_window_exceeded without tool calls ends with an error and a /compact hint', async () => {
    const { agent } = createHarness([
      textResponse('partial', { stopReason: 'context_window_exceeded' }),
    ]);
    const { result, events } = await runTurn(agent, 'go');
    expect(result.status).toBe('error');
    expect(result.error?.hint).toMatch(/\/compact/);
    expect(eventsOf(events, 'notice')[0]).toMatchObject({
      level: 'error',
      hint: result.error?.hint,
    });
  });

  it('refusal: discards the response, warns with the category and keeps the history valid', async () => {
    const { agent, provider, session } = createHarness([
      textResponse('I started to', {
        stopReason: 'refusal',
        refusal: { category: 'cyber', explanation: null },
      }),
      textResponse('Sure, here is something else.'),
    ]);
    const { result, events } = await runTurn(agent, 'bad request');
    expect(result).toMatchObject({ status: 'refused', finalText: '' });
    const notice = eventsOf(events, 'notice')[0];
    expect(notice).toEqual({
      type: 'notice',
      level: 'warn',
      text: 'The model declined this request. Category: cyber.',
      hint: 'Rephrase the request or switch models with /model.',
    });
    expect(session.messages()).toEqual([userText('bad request')]);
    expect(session.ofType('notice')[0]?.text).toBe(notice?.text);
    expect(session.ofType('usage')).toHaveLength(1);

    const next = await runTurn(agent, 'something else');
    expect(next.result.status).toBe('completed');
    expect(provider.requests[1]?.messages).toEqual([
      userText('bad request'),
      userText('something else'),
    ]);
  });

  it('refusal without a category omits it', async () => {
    const { agent } = createHarness([
      { stopReason: 'refusal', refusal: { category: null, explanation: null } },
    ]);
    const { events } = await runTurn(agent, 'x');
    expect(eventsOf(events, 'notice')[0]?.text).toBe('The model declined this request.');
  });

  it('a refusal at a later step reports no final text, not the previous step’s', async () => {
    const { agent } = createHarness([
      toolResponse([{ id: 'c1', name: 'echo', input: { text: 'a' } }], 'Let me look first.'),
      { stopReason: 'refusal', refusal: { category: null, explanation: null } },
    ]);
    const { result } = await runTurn(agent, 'go');
    expect(result).toMatchObject({ status: 'refused', finalText: '', steps: 2 });
  });

  it('a provider error at a later step reports no final text', async () => {
    const { agent } = createHarness([
      toolResponse([{ id: 'c1', name: 'echo', input: { text: 'a' } }], 'Let me look first.'),
      { error: new ProviderError('overloaded', 'Overloaded', { provider: 'anthropic' }) },
    ]);
    const { result } = await runTurn(agent, 'go');
    expect(result).toMatchObject({ status: 'error', finalText: '', steps: 2 });
  });

  it('does not store an assistant message without content', async () => {
    const { agent, session } = createHarness([{}]);
    const { result } = await runTurn(agent, 'hi');
    expect(result).toMatchObject({ status: 'completed', finalText: '' });
    expect(session.messages()).toEqual([userText('hi')]);
  });
});

describe('Agent.runTurn: provider failures', () => {
  it('reports a friendly error, keeps history valid and recovers on the next turn', async () => {
    const { agent, provider, session } = createHarness([
      toolResponse([{ id: 'c1', name: 'echo', input: { text: 'a' } }]),
      { error: new ProviderError('overloaded', 'Overloaded', { provider: 'anthropic' }) },
      textResponse('Back again.'),
    ]);
    const { result, events } = await runTurn(agent, 'try');
    expect(result.status).toBe('error');
    expect(result.error).toEqual({
      title: 'Anthropic is temporarily overloaded.',
      hint: 'Try again in a moment. Patch already retried automatically.',
    });
    expect(result.toolCalls).toBe(1);
    expect(eventsOf(events, 'notice')).toEqual([
      { type: 'notice', level: 'error', text: result.error?.title, hint: result.error?.hint },
    ]);
    expect(session.ofType('notice')).toMatchObject([
      { level: 'error', text: 'Anthropic is temporarily overloaded.' },
    ]);
    expectValidHistory(session.history());

    const next = await runTurn(agent, 'again');
    expect(next.result).toMatchObject({ status: 'completed', finalText: 'Back again.' });
    expectAppendOnly(agentRequests(provider));
    expectValidHistory(session.history());
  });

  it('names the model in model-specific errors', async () => {
    const { agent } = createHarness([
      {
        error: new ProviderError('not_found', 'model missing', {
          provider: 'anthropic',
          status: 404,
        }),
      },
    ]);
    const { result } = await runTurn(agent, 'x');
    expect(result.error?.title).toBe(
      `Anthropic request failed: model "${TEST_MODEL}" was not found.`,
    );
  });

  it('treats a stream that ends without message_end as an error', async () => {
    class EndlessProvider extends ScriptedProvider {
      override async *stream(): AsyncGenerator<ModelEvent> {
        yield { type: 'text_delta', text: 'half' };
      }
    }
    const { agent, session } = createHarness([], { provider: new EndlessProvider([]) });
    const { result, events } = await runTurn(agent, 'x');
    expect(result.status).toBe('error');
    expect(result.error?.title).toBe('The model response ended without a final message.');
    expect(eventTypes(events)).toContain('text_end');
    expect(session.messages()).toEqual([userText('x')]);
  });

  it('never throws: a session failure becomes an error result', async () => {
    const { agent, session } = createHarness([textResponse('ok')]);
    const append = session.append.bind(session);
    let calls = 0;
    session.append = (entry) => {
      calls++;
      if (calls === 2) throw new Error('disk full');
      return append(entry);
    };
    const { result, events } = await runTurn(agent, 'x');
    expect(result.status).toBe('error');
    expect(result.error?.title).toBe('disk full');
    expect(eventTypes(events).at(-1)).toBe('turn_end');
  });

  it('keeps running when the event listener throws', async () => {
    const { agent, session } = createHarness([
      toolResponse([{ id: 'c1', name: 'echo', input: { text: 'a' } }]),
      textResponse('done'),
    ]);
    const result = await agent.runTurn(
      { text: 'go' },
      {
        signal: new AbortController().signal,
        onEvent: () => {
          throw new Error('render failed');
        },
        requestPermission: async () => ({ decision: 'deny' }),
      },
    );
    expect(result).toMatchObject({ status: 'completed', finalText: 'done', toolCalls: 1 });
    expectValidHistory(session.history());
  });

  it('answers dangling tool calls when the turn fails unexpectedly after storing them', async () => {
    const { agent, session } = createHarness([
      toolResponse([{ id: 'c1', name: 'echo', input: { text: 'a' } }]),
    ]);
    const append = session.append.bind(session);
    session.append = (entry) => {
      if (entry.type === 'tool') throw new Error('disk hiccup');
      return append(entry);
    };
    const { result } = await runTurn(agent, 'x');
    expect(result.status).toBe('error');
    const history = session.history();
    expectValidHistory(history);
    expect(history.at(-1)?.content[0]).toMatchObject({
      type: 'tool_result',
      toolCallId: 'c1',
      isError: true,
    });
  });
});

describe('Agent: model, shell context and busy guards', () => {
  it('setModel is a no-op when unchanged and otherwise switches subsequent requests', async () => {
    const { agent, provider, session } = createHarness([textResponse('a'), textResponse('b')]);
    agent.setModel(TEST_MODEL);
    expect(session.ofType('model')).toHaveLength(0);
    await runTurn(agent, 'one');
    agent.setModel('other-model');
    expect(agent.model).toBe('other-model');
    expect(session.ofType('model').map((entry) => entry.model)).toEqual(['other-model']);
    const { events } = await runTurn(agent, 'two');
    expect(provider.requests[1]?.model).toBe('other-model');
    expect(eventsOf(events, 'model_start')[0]?.model).toBe('other-model');
    expect(provider.requests[1]?.system).toBe(TEST_SYSTEM);
  });

  it('recordUserShellCommand appends a shell entry and a tagged user message', async () => {
    const { agent, provider, session } = createHarness([textResponse('I see the status.')]);
    agent.recordUserShellCommand({
      command: 'git status',
      exitCode: 0,
      output: '\u001b[32mOn branch main\u001b[0m\r\nnothing to commit\r\n',
      durationMs: 42,
    });
    expect(session.ofType('shell')[0]).toMatchObject({
      command: 'git status',
      exitCode: 0,
      durationMs: 42,
    });
    const text = textOf(session.messages()[0]!);
    expect(text).toBe(
      `${USER_SHELL_CONTEXT_TAG}\n$ git status\nOn branch main\nnothing to commit\n(exit code 0)\n</user-shell-command>`,
    );
    await runTurn(agent, 'what changed?');
    expect(provider.requests[0]?.messages.map((message) => textOf(message))).toEqual([
      text,
      'what changed?',
    ]);
  });

  it('recordUserShellCommand truncates long output and handles a missing exit code', () => {
    const { agent, session } = createHarness([]);
    const output = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
    agent.recordUserShellCommand({ command: 'seq 500', exitCode: null, output, durationMs: 1 });
    agent.recordUserShellCommand({ command: 'true', exitCode: 0, output: '', durationMs: 1 });
    const [long, empty] = session.messages().map((message) => textOf(message));
    expect(long).toContain('line 1\n');
    expect(long).toContain('line 500\n');
    expect(long).toMatch(/\.\.\. 300 lines omitted \.\.\./);
    expect(long).toContain('(no exit code: the command was terminated)');
    expect(long!.split('\n').length).toBeLessThan(210);
    expect(empty).toBe(
      `${USER_SHELL_CONTEXT_TAG}\n$ true\n(no output)\n(exit code 0)\n</user-shell-command>`,
    );
  });

  it('defers shell commands recorded during a turn until it ends', async () => {
    const { agent, session } = createHarness([
      toolResponse([{ id: 'c1', name: 'echo', input: { text: 'a', delayMs: 20 } }]),
      textResponse('done'),
    ]);
    const { result } = await runTurn(agent, 'go', {
      onEvent: (event) => {
        if (event.type === 'tool_start') {
          agent.recordUserShellCommand({ command: 'ls', exitCode: 0, output: 'a', durationMs: 1 });
        }
      },
    });
    expect(result.status).toBe('completed');
    const history = session.history();
    expectValidHistory(history);
    expect(textOf(history.at(-1)!)).toContain('$ ls');
    expect(history.at(-2)).toMatchObject({ role: 'assistant' });
  });

  it('refuses a second concurrent turn and compaction while a turn runs', async () => {
    const { agent, provider } = createHarness([
      toolResponse([{ name: 'echo', input: { text: 'a', delayMs: 30 } }]),
      textResponse('done'),
    ]);
    const first = runTurn(agent, 'one');
    const second = await runTurn(agent, 'two');
    expect(second.result.status).toBe('error');
    expect(second.result.error?.title).toBe('Patch is already working on a request.');
    expect(eventTypes(second.events)).toEqual(['turn_end']);
    await expect(agent.compact({ signal: new AbortController().signal })).rejects.toThrow(
      'Cannot compact while a turn is running.',
    );
    expect((await first).result.status).toBe('completed');
    expect(provider.requests.every((request) => textOf(request.messages[0]!) === 'one')).toBe(true);
  });

  it('reports context usage from the last request', async () => {
    const { agent } = createHarness(
      [
        textResponse('a', {
          usage: { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 4_000 },
        }),
      ],
      { modelInfo: { contextWindow: 100_000 } },
    );
    expect(agent.contextUsage()).toEqual({ tokens: 0, window: 100_000 });
    await runTurn(agent, 'q');
    expect(agent.contextUsage()).toEqual({ tokens: 5_050, window: 100_000 });
  });
});
