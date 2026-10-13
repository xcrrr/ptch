import { describe, expect, it } from 'vitest';
import type { ToolResultBlock } from '@patch/shared';
import { textResponse, toolResponse } from '../../src/testing/index.js';
import { DECLINED_TOOL_MESSAGE, SKIPPED_TOOL_MESSAGE } from '../../src/agent/tool-runner.js';
import {
  agentRequests,
  askDecision,
  createHarness,
  denyDecision,
  eventTypes,
  eventsOf,
  expectAppendOnly,
  expectValidHistory,
  runTurn,
  type Harness,
} from './helpers.js';

/** Tool results sent back to the model after step `step` (1-based). */
function resultsAfterStep(harness: Harness, step: number): ToolResultBlock[] {
  const request = agentRequests(harness.provider)[step];
  const last = request?.messages.at(-1);
  expect(last?.role).toBe('user');
  return (last?.content ?? []).filter(
    (block): block is ToolResultBlock => block.type === 'tool_result',
  );
}

describe('tool execution', () => {
  it('runs consecutive allowed reads concurrently and returns results in call order', async () => {
    const harness = createHarness([
      toolResponse([
        { id: 'slow-read', name: 'echo', input: { text: 'a', delayMs: 40 } },
        { id: 'fast-read', name: 'echo', input: { text: 'b', delayMs: 5 } },
      ]),
      textResponse('done'),
    ]);
    const { events } = await runTurn(harness.agent, 'read two files');

    expect(harness.lab.maxActive).toBe(2);
    // The fast read finishes first, but results keep the call order.
    expect(eventsOf(events, 'tool_end').map((event) => event.id)).toEqual([
      'fast-read',
      'slow-read',
    ]);
    expect(resultsAfterStep(harness, 1)).toEqual([
      { type: 'tool_result', toolCallId: 'slow-read', content: 'echo: a' },
      { type: 'tool_result', toolCallId: 'fast-read', content: 'echo: b' },
    ]);
    expect(harness.session.ofType('tool').map((entry) => entry.callId)).toEqual([
      'fast-read',
      'slow-read',
    ]);
  });

  it('keeps writes ordered relative to the reads around them', async () => {
    const harness = createHarness(
      [
        toolResponse([
          { name: 'echo', input: { text: 'r1', delayMs: 20 } },
          { name: 'echo', input: { text: 'r2', delayMs: 10 } },
          { name: 'note', input: { path: 'w.txt', content: 'x' } },
          { name: 'echo', input: { text: 'r3', delayMs: 5 } },
          { name: 'echo', input: { text: 'r4' } },
        ]),
        textResponse('done'),
      ],
      { decisions: { write: { type: 'allow', reason: 'test' } } },
    );
    const { result } = await runTurn(harness.agent, 'mixed');
    expect(result.toolCalls).toBe(5);

    const { log } = harness.lab;
    const at = (entry: string) => {
      const index = log.indexOf(entry);
      expect(index, entry).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(at('end:echo:r1')).toBeLessThan(at('start:note:w.txt'));
    expect(at('end:echo:r2')).toBeLessThan(at('start:note:w.txt'));
    expect(at('end:note:w.txt')).toBeLessThan(at('start:echo:r3'));
    // r3 and r4 form a new concurrent group after the write.
    expect(at('start:echo:r4')).toBeLessThan(at('end:echo:r3'));
    expect(resultsAfterStep(harness, 1).map((block) => block.content)).toEqual([
      'echo: r1',
      'echo: r2',
      'Wrote w.txt',
      'echo: r3',
      'echo: r4',
    ]);
  });

  it('starts a non-read tool only after the running reads finished', async () => {
    const harness = createHarness([
      toolResponse([
        { id: 'r', name: 'echo', input: { text: 'r', delayMs: 20 } },
        { id: 's', name: 'slow', input: { ms: 1 } },
      ]),
      textResponse('done'),
    ]);
    const { events } = await runTurn(harness.agent, 'go');
    const types = events.map((event) => ('id' in event ? `${event.type}:${event.id}` : event.type));
    expect(types.indexOf('tool_end:r')).toBeLessThan(types.indexOf('tool_start:s'));
  });

  it('answers an unknown tool with the list of available tools', async () => {
    const harness = createHarness([
      toolResponse([{ id: 'x', name: 'nope', input: {} }]),
      textResponse('ok'),
    ]);
    const { events, result } = await runTurn(harness.agent, 'go');
    expect(result.toolCalls).toBe(1);
    expect(resultsAfterStep(harness, 1)).toEqual([
      {
        type: 'tool_result',
        toolCallId: 'x',
        content:
          'Unknown tool: nope. Available tools: echo, note, slow, fail, crash, progress, badpath.',
        isError: true,
      },
    ]);
    expect(eventsOf(events, 'tool_start')).toHaveLength(0);
    expect(eventsOf(events, 'tool_end')[0]).toMatchObject({
      id: 'x',
      name: 'nope',
      summary: { verb: 'nope', target: '' },
      durationMs: 0,
    });
    expect(harness.session.ofType('tool')[0]).toMatchObject({ callId: 'x', isError: true });
  });

  it('answers invalid JSON input with the parse error and the raw input', async () => {
    const harness = createHarness([
      toolResponse([
        {
          id: 'j',
          name: 'echo',
          input: {},
          inputError: 'Unterminated string in JSON at position 8',
        },
      ]),
      textResponse('ok'),
    ]);
    await runTurn(harness.agent, 'go');
    expect(resultsAfterStep(harness, 1)[0]).toEqual({
      type: 'tool_result',
      toolCallId: 'j',
      content:
        'The tool input was not valid JSON (Unterminated string in JSON at position 8). Raw input: {"broken. Send the call again with valid JSON.',
      isError: true,
    });
    expect(harness.lab.log).toEqual([]);
  });

  it('answers schema violations with each issue path', async () => {
    const harness = createHarness([
      toolResponse([{ id: 'v', name: 'echo', input: { text: 5, delayMs: -1 } }]),
      textResponse('ok'),
    ]);
    await runTurn(harness.agent, 'go');
    const [block] = resultsAfterStep(harness, 1);
    expect(block?.isError).toBe(true);
    expect(block?.content).toMatch(
      /^Invalid input for echo:\n- text: .+\n- delayMs: .+\nFix the input/,
    );
    expect(harness.lab.log).toEqual([]);
  });

  it('returns a ToolError message verbatim with its display', async () => {
    const harness = createHarness([
      toolResponse([{ id: 'f', name: 'fail', input: { path: 'missing.ts' } }]),
      textResponse('ok'),
    ]);
    const { events } = await runTurn(harness.agent, 'go');
    const message = 'File not found: missing.ts. Check the path with glob.';
    expect(resultsAfterStep(harness, 1)[0]).toEqual({
      type: 'tool_result',
      toolCallId: 'f',
      content: message,
      isError: true,
    });
    expect(eventsOf(events, 'tool_end')[0]?.result).toEqual({
      content: message,
      isError: true,
      display: { summary: 'not found' },
    });
    expect(harness.session.ofType('tool')[0]).toMatchObject({
      isError: true,
      display: { summary: 'not found' },
    });
  });

  it('contains an unexpected tool exception without leaking a stack trace', async () => {
    const harness = createHarness([
      toolResponse([{ id: 'c', name: 'crash', input: {} }]),
      textResponse('recovered'),
    ]);
    const { result } = await runTurn(harness.agent, 'go');
    expect(result.status).toBe('completed');
    expect(resultsAfterStep(harness, 1)[0]).toEqual({
      type: 'tool_result',
      toolCallId: 'c',
      content: 'Tool failed: boom',
      isError: true,
    });
  });

  it('turns a ToolError from the permission check into an error result without running', async () => {
    const harness = createHarness([
      toolResponse([{ id: 'p', name: 'badpath', input: { path: '../etc' } }]),
      textResponse('ok'),
    ]);
    const { events } = await runTurn(harness.agent, 'go');
    expect(resultsAfterStep(harness, 1)[0]?.content).toBe(
      'Path ../etc is outside the project. Use a path inside it.',
    );
    expect(harness.lab.log).toEqual([]);
    expect(eventTypes(events)).toContain('tool_start');
  });

  it('streams tool progress tagged with the call id', async () => {
    const harness = createHarness([
      toolResponse([{ id: 'p1', name: 'progress', input: { lines: 2 } }]),
      textResponse('ok'),
    ]);
    const { events } = await runTurn(harness.agent, 'go');
    expect(eventsOf(events, 'tool_progress')).toEqual([
      { type: 'tool_progress', id: 'p1', progress: { tail: ['line 1'], totalLines: 1 } },
      { type: 'tool_progress', id: 'p1', progress: { tail: ['line 2'], totalLines: 2 } },
    ]);
    const types = eventTypes(events);
    expect(types.lastIndexOf('tool_progress')).toBeLessThan(types.indexOf('tool_end'));
  });

  it('falls back to a generic summary when summarize throws', async () => {
    const harness = createHarness([
      toolResponse([{ id: 'e', name: 'echo', input: { text: 'a' } }]),
      textResponse('ok'),
    ]);
    const echo = harness.agent.tools.get('echo')!;
    echo.summarize = () => {
      throw new Error('bad summary');
    };
    const { events } = await runTurn(harness.agent, 'go');
    expect(eventsOf(events, 'tool_start')[0]?.summary).toEqual({ verb: 'echo', target: '' });
    expect(resultsAfterStep(harness, 1)[0]?.content).toBe('echo: a');
  });
});

describe('permissions', () => {
  const writeCall = (id: string, path = 'notes.md') => ({
    id,
    name: 'note',
    input: { path, content: `content of ${path}` },
  });

  it('asks with a full request and runs once on allow_once', async () => {
    const harness = createHarness([toolResponse([writeCall('w1')]), textResponse('written')]);
    const { result, events, permissionRequests } = await runTurn(harness.agent, 'write', {
      respond: () => ({ decision: 'allow_once' }),
    });
    expect(result.status).toBe('completed');
    expect(permissionRequests).toHaveLength(1);
    const [request] = permissionRequests;
    expect(request).toMatchObject({
      id: 'w1',
      toolName: 'note',
      summary: { verb: 'write', target: 'notes.md' },
      subject: { kind: 'write' },
      prompt: {
        title: 'Patch wants to make a change',
        sessionOption: { grant: { kind: 'all-edits' } },
      },
      preview: { text: 'content of notes.md' },
    });
    expect(eventsOf(events, 'tool_permission')).toEqual([
      { type: 'tool_permission', id: 'w1', request },
    ]);
    const types = eventTypes(events);
    expect(types.indexOf('tool_start')).toBeLessThan(types.indexOf('tool_permission'));
    expect(types.indexOf('tool_permission')).toBeLessThan(types.indexOf('tool_end'));
    expect(harness.lab.notes.get('notes.md')).toBe('content of notes.md');
    expect(harness.permissions.granted).toEqual([]);
  });

  it('records the session grant on allow_session so later writes are not asked again', async () => {
    const harness = createHarness([
      toolResponse([writeCall('w1', 'a.md')]),
      toolResponse([writeCall('w2', 'b.md')]),
      textResponse('both written'),
    ]);
    const { result, permissionRequests } = await runTurn(harness.agent, 'write two', {
      respond: () => ({ decision: 'allow_session' }),
    });
    expect(result.status).toBe('completed');
    expect(permissionRequests.map((request) => request.id)).toEqual(['w1']);
    expect(harness.permissions.granted).toEqual([{ kind: 'all-edits' }]);
    expect(harness.permissions.sessionGrants()).toEqual([{ kind: 'all-edits' }]);
    expect([...harness.lab.notes.keys()]).toEqual(['a.md', 'b.md']);
  });

  it('treats allow_session without a session option as allow_once', async () => {
    const harness = createHarness([toolResponse([writeCall('w1')]), textResponse('ok')], {
      decisions: { write: askDecision() },
    });
    await runTurn(harness.agent, 'write', { respond: () => ({ decision: 'allow_session' }) });
    expect(harness.lab.notes.size).toBe(1);
    expect(harness.permissions.granted).toEqual([]);
  });

  it('a user denial without feedback ends the turn and skips the remaining calls', async () => {
    const harness = createHarness([
      toolResponse([
        { id: 'r0', name: 'echo', input: { text: 'before' } },
        writeCall('w1'),
        { id: 'r1', name: 'echo', input: { text: 'after' } },
        writeCall('w2', 'other.md'),
      ]),
      textResponse('should not be requested'),
    ]);
    const { result, events, permissionRequests } = await runTurn(harness.agent, 'write');
    expect(result).toMatchObject({ status: 'denied', steps: 1, toolCalls: 2 });
    expect(permissionRequests).toHaveLength(1);
    expect(harness.provider.requests).toHaveLength(1);
    expect(harness.lab.log).toEqual(['start:echo:before', 'end:echo:before']);

    const last = harness.session.history().at(-1);
    expect(last).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', toolCallId: 'r0', content: 'echo: before' },
        { type: 'tool_result', toolCallId: 'w1', content: DECLINED_TOOL_MESSAGE, isError: true },
        { type: 'tool_result', toolCallId: 'r1', content: SKIPPED_TOOL_MESSAGE, isError: true },
        { type: 'tool_result', toolCallId: 'w2', content: SKIPPED_TOOL_MESSAGE, isError: true },
      ],
    });
    const ends = eventsOf(events, 'tool_end');
    expect(ends.map((event) => [event.id, event.denied ?? false])).toEqual([
      ['r0', false],
      ['w1', true],
      ['r1', false],
      ['w2', false],
    ]);
    expect(harness.session.ofType('tool').find((entry) => entry.callId === 'w1')).toMatchObject({
      denied: true,
      isError: true,
    });
    expectValidHistory(harness.session.history());

    // The next turn continues from a valid history.
    harness.provider.push(textResponse('Understood.'));
    const next = await runTurn(harness.agent, 'ok, skip it');
    expect(next.result.status).toBe('completed');
    expectValidHistory(harness.session.history());
  });

  it('a user denial with feedback is returned to the model and the turn continues', async () => {
    const harness = createHarness([
      toolResponse([writeCall('w1'), { id: 'r1', name: 'echo', input: { text: 'next' } }]),
      textResponse('I will use a different file.'),
    ]);
    const { result } = await runTurn(harness.agent, 'write', {
      respond: () => ({ decision: 'deny', feedback: '  use docs/notes.md instead  ' }),
    });
    expect(result).toMatchObject({ status: 'completed', steps: 2, toolCalls: 2 });
    expect(resultsAfterStep(harness, 1)).toEqual([
      {
        type: 'tool_result',
        toolCallId: 'w1',
        content: 'The user declined this action. The user said: use docs/notes.md instead',
        isError: true,
      },
      { type: 'tool_result', toolCallId: 'r1', content: 'echo: next' },
    ]);
    expect(harness.lab.notes.size).toBe(0);
  });

  it('a rule denial returns the rule message, marks the call denied and continues', async () => {
    const harness = createHarness(
      [
        toolResponse([writeCall('w1'), { id: 'r1', name: 'echo', input: { text: 'x' } }]),
        textResponse('ok'),
      ],
      { decisions: { write: denyDecision('Writes to notes.md are denied by a rule in config.') } },
    );
    const { result, events, permissionRequests } = await runTurn(harness.agent, 'write');
    expect(result).toMatchObject({ status: 'completed', toolCalls: 2 });
    expect(permissionRequests).toHaveLength(0);
    expect(resultsAfterStep(harness, 1)[0]).toEqual({
      type: 'tool_result',
      toolCallId: 'w1',
      content: 'Writes to notes.md are denied by a rule in config.',
      isError: true,
    });
    expect(eventsOf(events, 'tool_end')[0]).toMatchObject({ id: 'w1', denied: true });
    expect(harness.lab.notes.size).toBe(0);
    expectAppendOnly(agentRequests(harness.provider));
  });

  it('asks before a read that is not allowed outright, after earlier reads finish', async () => {
    const harness = createHarness(
      [
        toolResponse([
          { id: 'r0', name: 'echo', input: { text: 'a', delayMs: 15 } },
          { id: 'r1', name: 'fail', input: { path: 'outside.txt' } },
        ]),
        textResponse('ok'),
      ],
      {
        decide: (subject) =>
          subject.kind === 'read' && subject.paths[0]?.input === 'outside.txt'
            ? askDecision({ kind: 'read-path', path: subject.paths[0].absolute })
            : undefined,
      },
    );
    const asked: string[] = [];
    await runTurn(harness.agent, 'go', {
      respond: (request) => {
        asked.push(`${request.id}:${harness.lab.log.join(',')}`);
        return { decision: 'allow_once' };
      },
    });
    // r0 runs without asking; the prompt for r1 appears only after r0 finished.
    expect(asked).toEqual(['r1:start:echo:a,end:echo:a']);
    expect(resultsAfterStep(harness, 1)[1]?.content).toMatch(/^File not found: outside.txt/);
  });

  it('treats a failing requestPermission as a denial', async () => {
    const harness = createHarness([toolResponse([writeCall('w1')]), textResponse('never')]);
    const { result } = await runTurn(harness.agent, 'write', {
      respond: () => {
        throw new Error('UI went away');
      },
    });
    expect(result.status).toBe('denied');
    expect(harness.lab.notes.size).toBe(0);
    expectValidHistory(harness.session.history());
  });

  it('turns a failing permission evaluation into an error result', async () => {
    const harness = createHarness([toolResponse([writeCall('w1')]), textResponse('ok')]);
    harness.permissions.evaluate = () => {
      throw new Error('rules unavailable');
    };
    const { result } = await runTurn(harness.agent, 'write');
    expect(result.status).toBe('completed');
    expect(resultsAfterStep(harness, 1)[0]?.content).toBe(
      'Permission check failed: rules unavailable',
    );
    expect(harness.lab.notes.size).toBe(0);
  });
});
