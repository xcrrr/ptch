import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/agent/events.js';
import { INTERRUPTED_TOOL_MESSAGE } from '../../src/agent/tool-runner.js';
import { INTERRUPTED_MARKER } from '../../src/session/schema.js';
import { textResponse, toolResponse } from '../../src/testing/index.js';
import {
  agentRequests,
  createHarness,
  eventTypes,
  expectAppendOnly,
  expectValidHistory,
  runTurn,
} from './helpers.js';

const marker = { type: 'text', text: INTERRUPTED_MARKER } as const;

function abortOn(controller: AbortController, predicate: (event: AgentEvent) => boolean) {
  return (event: AgentEvent) => {
    if (predicate(event)) controller.abort();
  };
}

describe('interrupting a turn', () => {
  it('during streaming: keeps the partial text, appends the marker and recovers next turn', async () => {
    const harness = createHarness([
      textResponse('Hello world, this is a long answer.', { chunkSize: 6, chunkDelayMs: 20 }),
    ]);
    const controller = new AbortController();
    let deltas = 0;
    const { result, events } = await runTurn(harness.agent, 'talk', {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'text_delta' && ++deltas === 2) controller.abort();
      },
    });

    expect(result).toMatchObject({ status: 'interrupted', finalText: 'Hello world,', steps: 1 });
    expect(eventTypes(events)).toEqual([
      'turn_start',
      'model_start',
      'text_delta',
      'text_delta',
      'text_end',
      'turn_end',
    ]);
    expect(harness.session.messages()).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'talk' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello world,' }] },
      { role: 'user', content: [marker] },
    ]);
    expect(harness.session.ofType('usage')).toHaveLength(0);

    harness.provider.push(textResponse('Continuing.'));
    const next = await runTurn(harness.agent, 'go on');
    expect(next.result.status).toBe('completed');
    expectAppendOnly(agentRequests(harness.provider));
    expectValidHistory(harness.session.history());
  });

  it('before any text: stores only the marker, even if the provider ignores the signal', async () => {
    const harness = createHarness([() => new Promise<never>(() => {})]);
    const controller = new AbortController();
    const started = Date.now();
    const { result } = await runTurn(harness.agent, 'hang', {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'model_start') setTimeout(() => controller.abort(), 10);
      },
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatchObject({ status: 'interrupted', finalText: '' });
    expect(harness.session.messages()).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hang' }] },
      { role: 'user', content: [marker] },
    ]);
  });

  it('while a tool call is streaming: keeps the text only, never a dangling call', async () => {
    const harness = createHarness([
      toolResponse([{ id: 'c1', name: 'echo', input: { text: 'a' } }], 'Let me check.'),
    ]);
    const controller = new AbortController();
    const { result } = await runTurn(harness.agent, 'check', {
      signal: controller.signal,
      onEvent: abortOn(controller, (event) => event.type === 'tool_prepare'),
    });
    expect(result.status).toBe('interrupted');
    expect(harness.lab.log).toEqual([]);
    expect(harness.session.messages().slice(1)).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }] },
      { role: 'user', content: [marker] },
    ]);
    expectValidHistory(harness.session.history());
  });

  it('when already aborted: records the message and the marker without calling the model', async () => {
    const harness = createHarness([textResponse('unused')]);
    const controller = new AbortController();
    controller.abort();
    const { result } = await runTurn(harness.agent, 'too late', { signal: controller.signal });
    expect(result).toMatchObject({ status: 'interrupted', steps: 0 });
    expect(harness.provider.requests).toHaveLength(0);
    expect(harness.session.messages()).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'too late' }] },
      { role: 'user', content: [marker] },
    ]);
  });

  it('during a slow tool: answers every call and puts the marker after the results', async () => {
    const harness = createHarness([
      toolResponse([
        { id: 'r1', name: 'echo', input: { text: 'first' } },
        { id: 's1', name: 'slow', input: {} },
        { id: 'r2', name: 'echo', input: { text: 'never' } },
      ]),
      textResponse('never requested'),
    ]);
    const controller = new AbortController();
    const { result, events } = await runTurn(harness.agent, 'run it', {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'tool_start' && event.name === 'slow') {
          setTimeout(() => controller.abort(), 10);
        }
      },
    });

    expect(result).toMatchObject({ status: 'interrupted', steps: 1, toolCalls: 2 });
    expect(harness.provider.requests).toHaveLength(1);
    expect(harness.session.history().at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', toolCallId: 'r1', content: 'echo: first' },
        { type: 'tool_result', toolCallId: 's1', content: INTERRUPTED_TOOL_MESSAGE, isError: true },
        { type: 'tool_result', toolCallId: 'r2', content: INTERRUPTED_TOOL_MESSAGE, isError: true },
        marker,
      ],
    });
    expect(harness.lab.log).not.toContain('start:echo:never');
    const ends = events.filter((event) => event.type === 'tool_end');
    expect(ends.map((event) => event.id)).toEqual(['r1', 's1', 'r2']);
    expect(harness.session.ofType('tool')).toHaveLength(3);
    expectValidHistory(harness.session.history());
  });

  it('does not wait for a tool that ignores the abort signal', async () => {
    const harness = createHarness([
      toolResponse([{ id: 's1', name: 'slow', input: { ms: 2_000, ignoreAbort: true } }]),
    ]);
    const controller = new AbortController();
    const started = Date.now();
    const { result } = await runTurn(harness.agent, 'run', {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'tool_start') setTimeout(() => controller.abort(), 10);
      },
    });
    expect(result.status).toBe('interrupted');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(harness.lab.log).toEqual(['start:slow']);
  });

  it('while waiting for permission: stops asking, runs nothing and answers every call', async () => {
    const harness = createHarness([
      toolResponse([
        { id: 'w1', name: 'note', input: { path: 'a.md', content: 'x' } },
        { id: 'r1', name: 'echo', input: { text: 'later' } },
      ]),
    ]);
    const controller = new AbortController();
    const { result, events } = await runTurn(harness.agent, 'write', {
      signal: controller.signal,
      respond: () => {
        setTimeout(() => controller.abort(), 10);
        return new Promise(() => {});
      },
    });
    expect(result).toMatchObject({ status: 'interrupted', toolCalls: 1 });
    expect(harness.lab.log).toEqual([]);
    expect(harness.session.history().at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', toolCallId: 'w1', content: INTERRUPTED_TOOL_MESSAGE, isError: true },
        { type: 'tool_result', toolCallId: 'r1', content: INTERRUPTED_TOOL_MESSAGE, isError: true },
        marker,
      ],
    });
    expect(eventTypes(events)).toContain('tool_permission');
    expectValidHistory(harness.session.history());
  });

  it('never emits events after turn_end, even from tools still running', async () => {
    const harness = createHarness([
      toolResponse([
        { id: 'p1', name: 'progress', input: { lines: 1, holdMs: 80 } },
        { id: 'p2', name: 'progress', input: { lines: 1, holdMs: 80 } },
      ]),
    ]);
    const controller = new AbortController();
    const { result, events } = await runTurn(harness.agent, 'go', {
      signal: controller.signal,
      onEvent: abortOn(controller, (event) => event.type === 'tool_progress'),
    });
    expect(result.status).toBe('interrupted');
    await new Promise((done) => setTimeout(done, 150));
    expect(events.at(-1)?.type).toBe('turn_end');
    expect(events.filter((event) => event.type === 'turn_end')).toHaveLength(1);
  });

  it('interrupted reads in a concurrent group each get the interrupted result', async () => {
    const harness = createHarness([
      toolResponse([
        { id: 'a', name: 'echo', input: { text: 'fast' } },
        { id: 'b', name: 'progress', input: { lines: 1, holdMs: 200 } },
        { id: 'c', name: 'progress', input: { lines: 1, holdMs: 200 } },
      ]),
    ]);
    const controller = new AbortController();
    const { result } = await runTurn(harness.agent, 'go', {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'tool_end' && event.id === 'a') setTimeout(() => controller.abort(), 10);
      },
    });
    expect(result.status).toBe('interrupted');
    const content = harness.session.history().at(-1)?.content;
    expect(content).toEqual([
      { type: 'tool_result', toolCallId: 'a', content: 'echo: fast' },
      { type: 'tool_result', toolCallId: 'b', content: INTERRUPTED_TOOL_MESSAGE, isError: true },
      { type: 'tool_result', toolCallId: 'c', content: INTERRUPTED_TOOL_MESSAGE, isError: true },
      marker,
    ]);
  });
});
