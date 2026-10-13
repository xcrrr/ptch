import { describe, expect, it } from 'vitest';
import { ProviderError, type Message } from '@patch/shared';
import { UNFINISHED_TOOL_MESSAGE } from '../../src/agent/repair.js';
import { COMPACTION_SUMMARY_PREFIX, WORKING_DIRECTORY_TAG } from '../../src/session/schema.js';
import { textResponse, toolResponse } from '../../src/testing/index.js';
import { agentRequests, createHarness, expectValidHistory, runTurn } from './helpers.js';

/** A working-directory note as the CLI writes it. */
const NOTE = [
  WORKING_DIRECTORY_TAG,
  'Working directory: /repo',
  'Project root: /repo',
  WORKING_DIRECTORY_TAG.replace('<', '</'),
].join('\n');

const smallWindow = { contextWindow: 1_000 };

function noted(text: string, notes: string[] = [NOTE]): Message {
  return {
    role: 'user',
    content: [
      ...notes.map((note) => ({ type: 'text' as const, text: note })),
      { type: 'text', text },
    ],
  };
}

const tooLong = () =>
  new ProviderError('context_length', 'prompt is too long', { provider: 'anthropic', status: 400 });

describe('notes sent with a user turn', () => {
  it('go before the text, in the same user message', async () => {
    const harness = createHarness([textResponse('ok')]);
    await runTurn(harness.agent, 'hello', { notes: [NOTE, '  ', ''] });

    const request = agentRequests(harness.provider)[0]!;
    // Blank notes are dropped (an empty text block is invalid).
    expect(request.messages).toEqual([noted('hello')]);
    expect(harness.session.title()).toBe('hello');
  });

  it('leave a turn without notes unchanged', async () => {
    const harness = createHarness([textResponse('ok')]);
    await runTurn(harness.agent, 'hello', { notes: [] });
    expect(agentRequests(harness.provider)[0]!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('come after the repair of tool calls a stopped process left unanswered', async () => {
    const harness = createHarness([textResponse('ok')]);
    harness.session.append({
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'run it' }] },
    });
    harness.session.append({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c1', name: 'echo', input: { text: 'a' } }],
      },
    });
    await runTurn(harness.agent, 'continue', { notes: [NOTE] });

    const { messages } = agentRequests(harness.provider)[0]!;
    expectValidHistory(messages);
    expect(messages.slice(2)).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'c1',
            content: UNFINISHED_TOOL_MESSAGE,
            isError: true,
          },
        ],
      },
      noted('continue'),
    ]);
  });

  it('survive the automatic compaction before the turn', async () => {
    const harness = createHarness(
      [
        textResponse('first answer', { usage: { inputTokens: 900, outputTokens: 30 } }),
        textResponse('auto summary'),
        textResponse('second answer'),
      ],
      { modelInfo: smallWindow },
    );
    await runTurn(harness.agent, 'first');
    await runTurn(harness.agent, 'second', { notes: [NOTE] });

    expect(harness.provider.requests.map((request) => request.purpose)).toEqual([
      'agent',
      'summary',
      'agent',
    ]);
    expect(agentRequests(harness.provider)[1]!.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: `${COMPACTION_SUMMARY_PREFIX}\n\nauto summary` }],
      },
      noted('second'),
    ]);
  });

  it('are sent again with the text when the first request overflows and the turn compacts', async () => {
    const harness = createHarness(
      [textResponse('a'), { error: tooLong() }, textResponse('summary'), textResponse('b')],
      { modelInfo: smallWindow },
    );
    await runTurn(harness.agent, 'one');
    const { result } = await runTurn(harness.agent, 'two', { notes: [NOTE] });

    expect(result.status).toBe('completed');
    const [, overflowed, retried] = agentRequests(harness.provider);
    expect(overflowed!.messages.at(-1)).toEqual(noted('two'));
    expect(retried!.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: `${COMPACTION_SUMMARY_PREFIX}\n\nsummary` }],
      },
      noted('two'),
    ]);
  });

  it('are sent again after a compaction later in the turn', async () => {
    const harness = createHarness(
      [
        toolResponse([{ id: 'c1', name: 'echo', input: { text: 'big' } }]),
        { error: tooLong() },
        textResponse('## Goal\nRead it.'),
        textResponse('done'),
      ],
      { modelInfo: smallWindow },
    );
    const { result } = await runTurn(harness.agent, 'read it', { notes: [NOTE] });

    expect(result.status).toBe('completed');
    const retried = agentRequests(harness.provider).at(-1)!;
    expect(retried.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: `${COMPACTION_SUMMARY_PREFIX}\n\n## Goal\nRead it.` }],
      },
      { role: 'user', content: [{ type: 'text', text: NOTE }] },
    ]);
    expectValidHistory(harness.session.history());
  });
});
