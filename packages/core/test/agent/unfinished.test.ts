import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { textOf, type ContentBlock, type Message } from '@patch/shared';
import { Agent } from '../../src/agent/agent.js';
import {
  DECLINED_UNFINISHED_TOOL_MESSAGE,
  LOST_ERROR_TOOL_MESSAGE,
  LOST_OUTPUT_TOOL_MESSAGE,
  UNFINISHED_TOOL_MESSAGE,
} from '../../src/agent/repair.js';
import { USER_SHELL_CONTEXT_TAG } from '../../src/session/schema.js';
import { SessionStore, type Session } from '../../src/session/store.js';
import {
  ScriptedProvider,
  makeTempDir,
  textResponse,
  toolResponse,
} from '../../src/testing/index.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import {
  FakePermissions,
  TEST_CWD,
  TEST_MODEL,
  TEST_SYSTEM,
  ToolLab,
  agentRequests,
  createFakeTools,
  createHarness,
  createToolContext,
  eventsOf,
  expectValidHistory,
  runTurn,
} from './helpers.js';

const never = () => new AbortController().signal;

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/** What a turn stores before it runs the tools: the response with its calls. */
function assistantCalling(...ids: string[]): Message {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Running the tests.' },
      ...ids.map((id): ContentBlock => ({
        type: 'tool_call',
        id,
        name: 'echo',
        input: { text: id },
      })),
    ],
  };
}

function unfinishedResults(...ids: string[]): Message {
  return {
    role: 'user',
    content: ids.map((id) => ({
      type: 'tool_result',
      toolCallId: id,
      content: UNFINISHED_TOOL_MESSAGE,
      isError: true,
    })),
  };
}

/** A session whose process died while the tools of its last response were running. */
function crashedHarness(...ids: string[]) {
  const harness = createHarness([]);
  harness.session.append({ type: 'message', message: user('run the tests') });
  harness.session.append({ type: 'usage', model: TEST_MODEL, usage: usage(100) });
  harness.session.append({ type: 'message', message: assistantCalling(...ids) });
  return harness;
}

function usage(inputTokens: number) {
  return { inputTokens, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

describe('tool calls left unfinished by a stopped process', () => {
  it('answers them before the next turn, so the request is valid', async () => {
    const harness = crashedHarness('call_x', 'call_y');
    harness.provider.push(textResponse('The earlier run did not finish; starting again.'));

    const { result, events } = await runTurn(harness.agent, 'continue');

    expect(result.status).toBe('completed');
    const request = agentRequests(harness.provider)[0]!;
    expectValidHistory(request.messages);
    expect(request.messages).toEqual([
      user('run the tests'),
      assistantCalling('call_x', 'call_y'),
      unfinishedResults('call_x', 'call_y'),
      user('continue'),
    ]);
    expect(eventsOf(events, 'notice')).toEqual([
      {
        type: 'notice',
        level: 'warn',
        text: 'Patch stopped last time before the results of 2 tool calls were recorded (2 unfinished). The model was told to check the current state before repeating them.',
      },
    ]);
    expectValidHistory(harness.session.history());
  });

  it('tells the model which calls finished, so it does not repeat their changes', async () => {
    const harness = crashedHarness('call_ok', 'call_err', 'call_denied', 'call_running');
    // Recorded as each call settled; the results message was never written.
    const settled = (callId: string, extra: { isError: boolean; denied?: boolean }) =>
      harness.session.append({
        type: 'tool',
        callId,
        name: 'echo',
        summary: { verb: 'echo', target: callId },
        durationMs: 5,
        ...extra,
      });
    settled('call_ok', { isError: false });
    harness.session.append({ type: 'notice', level: 'info', text: 'unrelated' });
    settled('call_err', { isError: true });
    settled('call_denied', { isError: true, denied: true });
    harness.provider.push(textResponse('Checking the state first.'));

    const { events } = await runTurn(harness.agent, 'continue');

    const request = agentRequests(harness.provider)[0]!;
    expectValidHistory(request.messages);
    expect(request.messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolCallId: 'call_ok',
          content: LOST_OUTPUT_TOOL_MESSAGE,
          isError: true,
        },
        {
          type: 'tool_result',
          toolCallId: 'call_err',
          content: LOST_ERROR_TOOL_MESSAGE,
          isError: true,
        },
        {
          type: 'tool_result',
          toolCallId: 'call_denied',
          content: DECLINED_UNFINISHED_TOOL_MESSAGE,
          isError: true,
        },
        {
          type: 'tool_result',
          toolCallId: 'call_running',
          content: UNFINISHED_TOOL_MESSAGE,
          isError: true,
        },
      ],
    });
    for (const result of request.messages[2]!.content) {
      if (result.type !== 'tool_result' || result.toolCallId === 'call_denied') continue;
      expect(result.content).not.toMatch(/not run/i);
    }
    expect(eventsOf(events, 'notice').map((notice) => notice.text)).toEqual([
      'Patch stopped last time before the results of 4 tool calls were recorded (2 finished, 1 declined, 1 unfinished). The model was told to check the current state before repeating them.',
    ]);
  });

  it('ignores tool entries of earlier responses', async () => {
    const harness = createHarness([]);
    harness.session.append({ type: 'message', message: user('first') });
    harness.session.append({ type: 'message', message: assistantCalling('call_x') });
    harness.session.append({
      type: 'tool',
      callId: 'call_x',
      name: 'echo',
      summary: { verb: 'echo', target: 'x' },
      isError: false,
      durationMs: 1,
    });
    harness.session.append({
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'call_x', content: 'echo: x' }],
      },
    });
    // The same id again in a later response (ids are only unique per response).
    harness.session.append({ type: 'message', message: assistantCalling('call_x') });
    harness.provider.push(textResponse('ok'));
    await runTurn(harness.agent, 'continue');
    expect(agentRequests(harness.provider)[0]!.messages[4]).toEqual(unfinishedResults('call_x'));
  });

  it('describes a batch cut short in a real session file by what each call did', async () => {
    const temp = makeTempDir();
    try {
      const store = new SessionStore(join(temp.dir, 'sessions'));
      const session = store.create({
        cwd: TEST_CWD,
        projectRoot: TEST_CWD,
        isGit: false,
        branch: null,
        provider: 'scripted',
        model: TEST_MODEL,
        patchVersion: '0.0.0-test',
        system: TEST_SYSTEM,
      });
      const provider = new ScriptedProvider([
        toolResponse([
          { id: 'c1', name: 'echo', input: { text: 'a' } },
          { id: 'c2', name: 'fail', input: { path: 'missing.txt' } },
          { id: 'c3', name: 'slow', input: {} },
        ]),
      ]);
      const controller = new AbortController();
      const crashCopy = join(temp.dir, 'crashed');
      const turn = runTurn(agentFor(session, provider), 'run them', {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type !== 'tool_start' || event.id !== 'c3') return;
          // The process is killed while `slow` runs: the file as it is now is what survives.
          mkdirSync(crashCopy, { recursive: true });
          copyFileSync(session.filePath, join(crashCopy, basename(session.filePath)));
          controller.abort();
        },
      });
      await turn;
      session.close();

      const crashed = new SessionStore(crashCopy).load(session.id);
      const next = new ScriptedProvider([textResponse('Checking first.')]);
      const { events } = await runTurn(agentFor(crashed, next), 'continue');

      const request = agentRequests(next)[0]!;
      expectValidHistory(request.messages);
      expect(request.messages[2]?.content).toEqual([
        { type: 'tool_result', toolCallId: 'c1', content: LOST_OUTPUT_TOOL_MESSAGE, isError: true },
        { type: 'tool_result', toolCallId: 'c2', content: LOST_ERROR_TOOL_MESSAGE, isError: true },
        { type: 'tool_result', toolCallId: 'c3', content: UNFINISHED_TOOL_MESSAGE, isError: true },
      ]);
      expect(eventsOf(events, 'notice').map((notice) => notice.text)).toEqual([
        'Patch stopped last time before the results of 3 tool calls were recorded (2 finished, 1 unfinished). The model was told to check the current state before repeating them.',
      ]);
      crashed.close();
    } finally {
      temp.cleanup();
    }
  });

  it('answers them once, and never touches a valid history', async () => {
    const harness = crashedHarness('call_x');
    harness.provider.push(textResponse('one'), textResponse('two'));
    await runTurn(harness.agent, 'first');
    const { events } = await runTurn(harness.agent, 'second');

    expect(eventsOf(events, 'notice')).toEqual([]);
    const repairs = harness.session
      .messages()
      .filter((message) => message.content.some((block) => block.type === 'tool_result'));
    expect(repairs).toEqual([unfinishedResults('call_x')]);
    expectValidHistory(agentRequests(harness.provider)[1]!.messages);

    const clean = createHarness([textResponse('a'), textResponse('b')]);
    await runTurn(clean.agent, 'one');
    await runTurn(clean.agent, 'two');
    expect(clean.session.messages().map((message) => textOf(message))).toEqual([
      'one',
      'a',
      'two',
      'b',
    ]);
  });

  it('answers them before a ! command result is recorded', async () => {
    const harness = crashedHarness('call_x');
    harness.agent.recordUserShellCommand({
      command: 'git status',
      exitCode: 0,
      output: 'clean',
      durationMs: 5,
    });
    harness.provider.push(textResponse('Clean tree.'));
    await runTurn(harness.agent, 'and now?');

    const request = agentRequests(harness.provider)[0]!;
    expectValidHistory(request.messages);
    expect(request.messages[2]).toEqual(unfinishedResults('call_x'));
    expect(textOf(request.messages[3]!).startsWith(USER_SHELL_CONTEXT_TAG)).toBe(true);
  });

  it('answers them before a manual compaction, so the summary knows how they ended', async () => {
    const harness = crashedHarness('call_x');
    harness.provider.push(textResponse('## Goal\nRun the tests.'));
    await harness.agent.compact({ signal: never() });

    const transcript = textOf(harness.provider.requests[0]!.messages[0]!);
    expect(transcript).toContain(`[tool result (error)] ${UNFINISHED_TOOL_MESSAGE}`);
    expect(harness.session.messages().at(-1)).toEqual(unfinishedResults('call_x'));
  });

  it('repairs a session file resumed after a crash (append-only, valid after reload)', async () => {
    const temp = makeTempDir();
    try {
      const store = new SessionStore(join(temp.dir, 'sessions'));
      const crashed = store.create({
        cwd: TEST_CWD,
        projectRoot: TEST_CWD,
        isGit: false,
        branch: null,
        provider: 'scripted',
        model: TEST_MODEL,
        patchVersion: '0.0.0-test',
        system: TEST_SYSTEM,
      });
      crashed.append({ type: 'message', message: user('run the tests') });
      crashed.append({ type: 'message', message: assistantCalling('call_x') });
      const before = crashed.entries().length;

      const resumed = store.load(crashed.id);
      const provider = new ScriptedProvider([textResponse('Starting over.')]);
      const agent = agentFor(resumed, provider);
      const { result } = await runTurn(agent, 'continue');

      expect(result.status).toBe('completed');
      expectValidHistory(agentRequests(provider)[0]!.messages);
      const reloaded = store.load(crashed.id);
      // Earlier entries are untouched; the repair and the new turn were appended.
      expect(reloaded.entries().slice(0, before)).toEqual(crashed.entries().slice(0, before));
      expect(reloaded.history()).toEqual([
        user('run the tests'),
        assistantCalling('call_x'),
        unfinishedResults('call_x'),
        user('continue'),
        { role: 'assistant', content: [{ type: 'text', text: 'Starting over.' }] },
      ]);
      reloaded.close();
    } finally {
      temp.cleanup();
    }
  });

  it('leaves calls of the running turn alone (only a stopped process leaves them unanswered)', async () => {
    const harness = createHarness([
      toolResponse([{ id: 'c1', name: 'echo', input: { text: 'a' } }]),
      textResponse('done'),
    ]);
    const { result, events } = await runTurn(harness.agent, 'go');
    expect(result.status).toBe('completed');
    expect(eventsOf(events, 'notice')).toEqual([]);
    const results = harness.session
      .messages()
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'tool_result');
    expect(results).toEqual([{ type: 'tool_result', toolCallId: 'c1', content: 'echo: a' }]);
  });
});

function agentFor(session: Session, provider: ScriptedProvider): Agent {
  return new Agent({
    provider,
    session,
    tools: new ToolRegistry(createFakeTools(new ToolLab())),
    permissions: new FakePermissions(),
    toolContext: createToolContext(),
  });
}
