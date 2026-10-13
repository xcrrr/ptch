import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Message } from '@patch/shared';
import { INTERRUPTED_TOOL_MESSAGE } from '../../src/agent/tool-runner.js';
import { emptyHooks, type HookDefinition, type HookEvent } from '../../src/hooks/definitions.js';
import { HookRunner, type HookInvocation, type HookRunResult } from '../../src/hooks/runner.js';
import { noopLogger } from '../../src/logging/logger.js';
import { HOOK_OUTPUT_TAG, WORKING_DIRECTORY_TAG } from '../../src/session/schema.js';
import { textResponse, toolResponse } from '../../src/testing/index.js';
import {
  TEST_CWD,
  agentRequests,
  allowDecision,
  createHarness,
  createToolContext,
  denyDecision,
  eventsOf,
  expectAppendOnly,
  expectValidHistory,
  runTurn,
  waitForEvent,
} from './helpers.js';

type Responder = (
  invocation: HookInvocation,
) => Partial<HookRunResult> | Promise<Partial<HookRunResult>>;

function fakeHook(event: HookEvent, command = 'guard'): HookDefinition {
  return { event, command, timeoutMs: 60_000 };
}

/** A HookRunner whose hooks answer from functions instead of running commands. */
class FakeHooks extends HookRunner {
  readonly calls: HookInvocation[] = [];
  private readonly responders: Partial<Record<HookEvent, Responder>>;

  constructor(responders: Partial<Record<HookEvent, Responder>>) {
    const hooks = emptyHooks() as Record<HookEvent, HookDefinition[]>;
    for (const event of Object.keys(responders) as HookEvent[]) hooks[event] = [fakeHook(event)];
    super({
      hooks,
      shell: createToolContext().shell,
      projectRoot: TEST_CWD,
      cwd: TEST_CWD,
      logger: noopLogger,
    });
    this.responders = responders;
  }

  override async run(invocation: HookInvocation): Promise<HookRunResult> {
    this.calls.push(invocation);
    const response = await this.responders[invocation.event]?.(invocation);
    return { outputs: [], failures: [], aborted: false, ...response };
  }

  callsOf(event: HookEvent): HookInvocation[] {
    return this.calls.filter((call) => call.event === event);
  }
}

function block(event: HookEvent, message: string): Partial<HookRunResult> {
  return { blocked: { hook: fakeHook(event), message } };
}

function texts(message: Message | undefined): string[] {
  return (message?.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : []));
}

const DIRECTORY_NOTE = `${WORKING_DIRECTORY_TAG}\nWorking directory: /repo\n</working-directory-update>`;

describe('UserPromptSubmit hooks', () => {
  it('send their output with the prompt as notes, after the turn’s own notes', async () => {
    const hooks = new FakeHooks({
      UserPromptSubmit: () => ({ outputs: ['Ticket ABC-1 is in progress.'] }),
    });
    const harness = createHarness([textResponse('ok')], { agent: { hooks } });
    await runTurn(harness.agent, 'fix it', { notes: [DIRECTORY_NOTE] });

    expect(hooks.calls).toMatchObject([
      { event: 'UserPromptSubmit', sessionId: 'test-session', fields: { prompt: 'fix it' } },
    ]);
    const [request] = agentRequests(harness.provider);
    const [directory, context, prompt] = texts(request?.messages.at(-1));
    expect(directory).toBe(DIRECTORY_NOTE);
    expect(context).toBe(
      `${HOOK_OUTPUT_TAG} event="UserPromptSubmit">\nContext from the user's UserPromptSubmit hook:\nTicket ABC-1 is in progress.\n</hook-output>`,
    );
    expect(prompt).toBe('fix it');
    expect(harness.session.title()).toBe('fix it');
  });

  it('drop the prompt on exit code 2 and show the reason to the user', async () => {
    const hooks = new FakeHooks({
      UserPromptSubmit: () => block('UserPromptSubmit', 'Prompts must not contain secrets.'),
    });
    const harness = createHarness([textResponse('never sent')], { agent: { hooks } });
    const { result, events } = await runTurn(harness.agent, 'my key is sk-123');

    expect(result.status).toBe('blocked');
    expect(harness.provider.requests).toHaveLength(0);
    expect(harness.session.messages()).toEqual([]);
    expect(eventsOf(events, 'notice')).toEqual([
      {
        type: 'notice',
        level: 'warn',
        text: 'A UserPromptSubmit hook blocked this prompt, so it was not sent.',
        hint: 'Prompts must not contain secrets.',
      },
    ]);
  });

  it('end the turn without sending anything when interrupted', async () => {
    const abort = new AbortController();
    const hooks = new FakeHooks({
      UserPromptSubmit: (invocation) =>
        new Promise((resolve) => {
          invocation.signal.addEventListener('abort', () => resolve({ aborted: true }));
          abort.abort();
        }),
    });
    const harness = createHarness([textResponse('never sent')], { agent: { hooks } });
    const { result } = await runTurn(harness.agent, 'hello', { signal: abort.signal });
    expect(result.status).toBe('interrupted');
    expect(harness.provider.requests).toHaveLength(0);
    expect(harness.session.messages()).toEqual([]);
  });
});

describe('SessionStart hooks', () => {
  it('send their output with the next prompt only, even after a blocked one', async () => {
    let blockPrompt = true;
    const hooks = new FakeHooks({
      SessionStart: () => ({ outputs: ['Release freeze until Friday.'] }),
      UserPromptSubmit: () => (blockPrompt ? block('UserPromptSubmit', 'not now') : {}),
    });
    const harness = createHarness([textResponse('one'), textResponse('two')], { agent: { hooks } });
    await harness.agent.runSessionStartHooks('startup', { signal: new AbortController().signal });
    expect(hooks.callsOf('SessionStart')).toMatchObject([{ fields: { source: 'startup' } }]);

    expect((await runTurn(harness.agent, 'blocked')).result.status).toBe('blocked');
    blockPrompt = false;
    await runTurn(harness.agent, 'first');
    await runTurn(harness.agent, 'second');

    const [first, second] = agentRequests(harness.provider);
    const firstTexts = texts(first?.messages.at(-1));
    expect(firstTexts).toHaveLength(2);
    expect(firstTexts[0]).toContain('Release freeze until Friday.');
    expect(firstTexts[0]?.startsWith(`${HOOK_OUTPUT_TAG} event="SessionStart">`)).toBe(true);
    expect(texts(second?.messages.at(-1))).toEqual(['second']);
    expectAppendOnly(agentRequests(harness.provider));
  });

  it('report failures as notices', async () => {
    const hooks = new FakeHooks({
      SessionStart: () => ({
        failures: [
          { hook: fakeHook('SessionStart', 'setup.sh'), reason: 'exit 1', detail: 'no db' },
        ],
      }),
    });
    const harness = createHarness([], { agent: { hooks } });
    const notices: unknown[] = [];
    await harness.agent.runSessionStartHooks('clear', {
      signal: new AbortController().signal,
      onEvent: (event) => notices.push(event),
    });
    expect(notices).toEqual([
      {
        type: 'notice',
        level: 'warn',
        text: 'SessionStart hook failed (exit 1): setup.sh',
        hint: 'no db',
      },
    ]);
  });
});

describe('PreToolUse hooks', () => {
  it('run once the call is approved and can block it', async () => {
    const order: string[] = [];
    const hooks = new FakeHooks({
      PreToolUse: (invocation) => {
        order.push(`hook:${invocation.tool?.name}`);
        return block('PreToolUse', 'Generated files are read-only.');
      },
    });
    const harness = createHarness(
      [
        toolResponse([{ name: 'note', input: { path: 'gen/api.ts', content: 'x' } }]),
        textResponse('Understood.'),
      ],
      { agent: { hooks } },
    );
    const { result, events } = await runTurn(harness.agent, 'edit the generated file', {
      respond: () => {
        order.push('permission');
        return { decision: 'allow_once' };
      },
    });

    expect(result.status).toBe('completed');
    expect(order).toEqual(['permission', 'hook:note']);
    expect(hooks.calls[0]?.tool).toEqual({
      name: 'note',
      input: { path: 'gen/api.ts', content: 'x' },
      file: join(TEST_CWD, 'gen', 'api.ts'),
    });
    expect(harness.lab.notes.has('gen/api.ts')).toBe(false);
    const [end] = eventsOf(events, 'tool_end');
    expect(end?.result).toEqual({
      content:
        'A PreToolUse hook the user configured blocked this call, so it did not run. The hook said:\nGenerated files are read-only.',
      isError: true,
      display: { summary: 'blocked by hook', lines: ['Generated files are read-only.'] },
    });
    expect(end?.denied).toBeUndefined();
    const toolResult = agentRequests(harness.provider)[1]?.messages.at(-1)?.content[0];
    expect(toolResult).toMatchObject({ type: 'tool_result', isError: true });
    expectValidHistory(harness.session.messages());
  });

  it('never run for calls the permission check denies', async () => {
    const hooks = new FakeHooks({ PreToolUse: () => ({}), PostToolUse: () => ({}) });
    const harness = createHarness(
      [
        toolResponse([{ name: 'note', input: { path: 'a.ts', content: 'x' } }]),
        toolResponse([{ name: 'slow', input: { ms: 1 } }]),
        textResponse('ok'),
      ],
      { agent: { hooks }, decisions: { execute: denyDecision('Not allowed by a rule.') } },
    );
    await runTurn(harness.agent, 'go', {
      respond: () => ({ decision: 'deny', feedback: 'no' }),
    });
    expect(hooks.calls).toEqual([]);
    expect(harness.lab.log).toEqual([]);
  });

  it('report failures as notices and let the call run', async () => {
    const hooks = new FakeHooks({
      PreToolUse: () => ({
        failures: [{ hook: fakeHook('PreToolUse', 'guard.sh'), reason: 'exit 1', detail: 'oops' }],
      }),
    });
    const harness = createHarness(
      [toolResponse([{ name: 'echo', input: { text: 'hi' } }]), textResponse('ok')],
      { agent: { hooks } },
    );
    const { events } = await runTurn(harness.agent, 'go');
    expect(harness.lab.log).toEqual(['start:echo:hi', 'end:echo:hi']);
    expect(eventsOf(events, 'notice')).toEqual([
      {
        type: 'notice',
        level: 'warn',
        text: 'PreToolUse hook failed (exit 1): guard.sh',
        hint: 'oops',
      },
    ]);
    expect(harness.session.ofType('notice')).toMatchObject([
      { level: 'warn', text: 'PreToolUse hook failed (exit 1): guard.sh' },
    ]);
  });

  it('stop the call when interrupted', async () => {
    const abort = new AbortController();
    const started = waitForEvent((event) => event.type === 'tool_start');
    const hooks = new FakeHooks({
      PreToolUse: (invocation) =>
        new Promise((resolve) => {
          invocation.signal.addEventListener('abort', () => resolve({ aborted: true }));
        }),
    });
    const harness = createHarness([toolResponse([{ name: 'slow', input: { ms: 1 } }])], {
      agent: { hooks },
    });
    const turn = runTurn(harness.agent, 'go', { signal: abort.signal, onEvent: started.onEvent });
    await started.reached;
    await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort();
    const { result, events } = await turn;
    expect(result.status).toBe('interrupted');
    expect(harness.lab.log).toEqual([]);
    expect(eventsOf(events, 'tool_end')[0]?.result.content).toBe(INTERRUPTED_TOOL_MESSAGE);
    expectValidHistory(harness.session.messages());
  });
});

describe('PostToolUse hooks', () => {
  it('get the outcome and a short summary of the result', async () => {
    const hooks = new FakeHooks({ PostToolUse: () => ({}) });
    const harness = createHarness(
      [
        toolResponse([
          { name: 'note', input: { path: 'a.ts', content: 'secret content' } },
          { name: 'fail', input: { path: 'missing.ts' } },
        ]),
        textResponse('ok'),
      ],
      { agent: { hooks }, decisions: { write: allowDecision() } },
    );
    await runTurn(harness.agent, 'go');
    expect(hooks.calls.map((call) => [call.tool?.name, call.fields])).toEqual([
      ['note', { outcome: 'success', isError: false, summary: '14 chars' }],
      ['fail', { outcome: 'error', isError: true, summary: 'not found' }],
    ]);
  });

  it('pass a problem reported with exit code 2 on to the model', async () => {
    const hooks = new FakeHooks({
      PostToolUse: () => block('PostToolUse', 'prettier: SyntaxError in a.ts'),
    });
    const harness = createHarness(
      [toolResponse([{ name: 'note', input: { path: 'a.ts', content: 'x' } }]), textResponse('ok')],
      { agent: { hooks }, decisions: { write: allowDecision() } },
    );
    const { events } = await runTurn(harness.agent, 'go');
    expect(harness.lab.notes.get('a.ts')).toBe('x');
    const [end] = eventsOf(events, 'tool_end');
    expect(end?.result.isError).toBeUndefined();
    expect(end?.result.content).toBe(
      'Wrote a.ts\n\nA PostToolUse hook the user configured reported a problem after this call:\nprettier: SyntaxError in a.ts',
    );
    expect(eventsOf(events, 'notice')).toMatchObject([
      {
        level: 'warn',
        text: 'PostToolUse hook reported a problem with note: prettier: SyntaxError in a.ts',
      },
    ]);
    // The notice follows the call's row.
    const types = events.map((event) => event.type);
    expect(types.indexOf('notice')).toBeGreaterThan(types.indexOf('tool_end'));
  });
});

describe('Stop hooks', () => {
  it('make the model continue once per turn with the hook’s instruction', async () => {
    const hooks = new FakeHooks({ Stop: () => block('Stop', 'Also update the changelog.') });
    const harness = createHarness([textResponse('Done.'), textResponse('Changelog updated.')], {
      agent: { hooks },
    });
    const { result, events } = await runTurn(harness.agent, 'fix the bug');

    expect(result).toMatchObject({
      status: 'completed',
      finalText: 'Changelog updated.',
      steps: 2,
    });
    expect(hooks.calls.map((call) => call.fields)).toEqual([
      { stopHookActive: false, lastAssistantMessage: 'Done.' },
      { stopHookActive: true, lastAssistantMessage: 'Changelog updated.' },
    ]);
    const second = agentRequests(harness.provider)[1];
    expect(texts(second?.messages.at(-1))).toEqual([
      `${HOOK_OUTPUT_TAG} event="Stop">\nThe user's Stop hook asks you to continue before you finish:\nAlso update the changelog.\n</hook-output>`,
    ]);
    expect(eventsOf(events, 'notice').map(({ level, text }) => [level, text])).toEqual([
      ['info', 'A Stop hook asked Patch to continue: Also update the changelog.'],
      ['warn', 'A Stop hook asked Patch to continue again; Patch stopped instead.'],
    ]);
    expectValidHistory(harness.session.messages());
    expectAppendOnly(agentRequests(harness.provider));
    expect(harness.session.title()).toBe('fix the bug');
  });

  it('do not run when the turn did not complete', async () => {
    const hooks = new FakeHooks({ Stop: () => ({}) });
    const harness = createHarness([{ text: 'cut', stopReason: 'max_tokens' }], {
      agent: { hooks },
    });
    expect((await runTurn(harness.agent, 'go')).result.status).toBe('truncated');
    expect(hooks.calls).toEqual([]);
  });
});
