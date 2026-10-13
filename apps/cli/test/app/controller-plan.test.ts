import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLAN_MODE_TAG, planModeNote } from '@patch/core';
import {
  ScriptedProvider,
  makeGitRepo,
  makeTempDir,
  textResponse,
  toolResponse,
  type ScriptStep,
} from '@patch/core/testing';
import type { ModelRequest } from '@patch/shared';
import { parseArgs } from '../../src/args.js';
import { AppController } from '../../src/app/controller.js';
import { buildTranscriptFromEntries } from '../../src/app/transcript-builder.js';
import { Runtime } from '../../src/runtime.js';
import type { TranscriptItem } from '../../src/ui/transcript.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const PLAN = '## Answer 42\n\n1. Change `answer` in `src/app.ts` to 42.';

async function setup(steps: ScriptStep[]) {
  const repo = makeGitRepo({ 'src/app.ts': 'export const answer = 41;\n' });
  const home = makeTempDir('patch-home-');
  cleanups.push(repo.cleanup, home.cleanup);
  const provider = new ScriptedProvider(steps);
  const runtime = await Runtime.create({
    cwd: repo.dir,
    env: { PATH: process.env.PATH, PATCH_HOME: home.dir },
    args: parseArgs([]),
    homeDir: home.dir,
    providerFactory: () => provider,
    assumeCredentials: true,
  });
  const handle = await runtime.newSession();
  cleanups.push(() => handle.session.close());
  const controller = new AppController(runtime, handle);
  cleanups.push(() => controller.close());
  return { controller, provider, runtime, repo: repo.dir };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Text blocks and tool results of the last message of a request. */
function lastMessage(request: ModelRequest | undefined): string[] {
  return (request?.messages.at(-1)?.content ?? []).flatMap((block) =>
    block.type === 'text' ? [block.text] : block.type === 'tool_result' ? [block.content] : [],
  );
}

function tools(items: readonly TranscriptItem[]) {
  return items.flatMap((item) => (item.kind === 'tool' ? [item] : []));
}

const edit = toolResponse([
  { name: 'read_file', input: { path: 'src/app.ts' } },
  { name: 'edit_file', input: { path: 'src/app.ts', old_string: '41', new_string: '42' } },
]);
const presentPlan = toolResponse([{ id: 'plan1', name: 'present_plan', input: { plan: PLAN } }]);

describe('permission modes in the interactive session', () => {
  it('cycle with Shift+Tab: default → accepting edits → plan → auto → default', async () => {
    const { controller } = await setup([]);
    const modes = () => [
      controller.getState().permissionMode,
      controller.sessionHandle.permissions.mode,
    ];
    expect(modes()).toEqual(['default', 'default']);
    controller.cyclePermissionMode();
    expect(modes()).toEqual(['acceptEdits', 'acceptEdits']);
    controller.cyclePermissionMode();
    expect(modes()).toEqual(['plan', 'plan']);
    controller.cyclePermissionMode();
    expect(controller.getState().mode).toBe('auto-confirm');
    controller.respondAutoConfirm(true);
    expect(modes()).toEqual(['auto', 'auto']);
    controller.cyclePermissionMode();
    expect(modes()).toEqual(['default', 'default']);
  });

  it('/plan turns plan mode on and off, and /status shows the mode', async () => {
    const { controller } = await setup([]);
    controller.submit('/plan');
    expect(controller.getState().permissionMode).toBe('plan');
    expect(controller.getState().items.at(-1)).toMatchObject({
      kind: 'notice',
      text: 'Plan mode is on: Patch researches and presents a plan before changing anything.',
    });
    controller.submit('/status');
    await controller.idle();
    const status = controller.getState().items.at(-1);
    expect(status?.kind === 'status' && status.rows.find((row) => row.label === 'Mode')).toEqual({
      label: 'Mode',
      value: 'plan mode',
      detail: 'shift+tab to change',
    });
    controller.submit('/plan');
    expect(controller.getState().permissionMode).toBe('default');
    expect(controller.getState().items.at(-1)).toMatchObject({ text: 'Plan mode is off.' });
    controller.cyclePermissionMode();
    controller.submit('/plan');
    expect(controller.getState().permissionMode).toBe('plan');
    controller.submit('/plan now');
    expect(controller.getState().permissionMode).toBe('plan');
    expect(controller.getState().items.at(-1)).toMatchObject({ level: 'warn' });
  });

  it('keeps the mode for /clear; a resumed session starts in the default mode', async () => {
    const { controller } = await setup([textResponse('Hi.')]);
    controller.submit('hello');
    await controller.idle();
    const first = controller.session;
    controller.submit('/plan');
    controller.submit('/clear');
    await controller.idle();
    expect(controller.session.id).not.toBe(first.id);
    expect(controller.getState().permissionMode).toBe('plan');
    expect(controller.sessionHandle.permissions.mode).toBe('plan');
    controller.submit(`/resume ${first.id}`);
    await controller.idle();
    expect(controller.session.id).toBe(first.id);
    expect(controller.getState().permissionMode).toBe('default');
    expect(controller.sessionHandle.permissions.mode).toBe('default');
  });

  it('tells the model with the next message, and edits in plan mode are denied without asking', async () => {
    const { controller, provider, repo } = await setup([edit, textResponse('I will plan.')]);
    controller.cyclePermissionMode();
    controller.cyclePermissionMode();
    controller.submit('Make the answer 42.');
    await controller.idle();
    expect(lastMessage(provider.requests[0])).toEqual([planModeNote(true), 'Make the answer 42.']);
    expect(readFileSync(join(repo, 'src/app.ts'), 'utf8')).toBe('export const answer = 41;\n');
    expect(tools(controller.getState().items).map((t) => [t.summary.verb, t.status])).toEqual([
      ['read', 'done'],
      ['edit', 'denied'],
    ]);
    expect(lastMessage(provider.requests[1]).at(-1)).toMatch(/^Plan mode is on: /);
    // The note is no message of the user's in the transcript.
    expect(
      controller.getState().items.some((i) => i.kind === 'user' && i.text.includes(PLAN_MODE_TAG)),
    ).toBe(false);
  });
});

describe('plan review', () => {
  it('approved with "accept edits": the plan stays in the transcript and edits apply without asking', async () => {
    const { controller, provider, repo } = await setup([
      presentPlan,
      edit,
      textResponse('Changed the answer to 42.'),
    ]);
    controller.setPermissionMode('plan');
    controller.submit('Make the answer 42.');
    await waitFor(() => controller.getState().mode === 'plan-review');
    const state = controller.getState();
    expect(state.planReview).toEqual({ id: 'plan1', plan: PLAN });
    expect(state.liveTools).toMatchObject([
      { id: 'plan1', name: 'present_plan', status: 'waiting' },
    ]);

    controller.respondPlan({ decision: 'approve', mode: 'acceptEdits' });
    await controller.idle();
    expect(controller.getState().permissionMode).toBe('acceptEdits');
    expect(controller.getState().mode).toBe('idle');
    expect(readFileSync(join(repo, 'src/app.ts'), 'utf8')).toBe('export const answer = 42;\n');
    const [plan, ...rest] = tools(controller.getState().items);
    expect(plan).toMatchObject({
      name: 'present_plan',
      status: 'done',
      summary: { verb: 'plan', target: 'Answer 42' },
      display: { plan: PLAN, summary: 'approved · accepting edits' },
    });
    expect(rest.map((t) => [t.summary.verb, t.status])).toEqual([
      ['read', 'done'],
      ['edit', 'done'],
    ]);
    expect(lastMessage(provider.requests[1])[0]).toContain('The user approved your plan');

    // The resumed transcript shows the plan the same way.
    const rebuilt = buildTranscriptFromEntries(controller.session.entries(), () => 'x');
    expect(tools(rebuilt)[0]?.display).toEqual({
      plan: PLAN,
      summary: 'approved · accepting edits',
    });
    expect(rebuilt.some((i) => i.kind === 'user' && i.text.includes(PLAN_MODE_TAG))).toBe(false);
  });

  it('kept planning with feedback: the model gets it and plan mode stays on', async () => {
    const { controller, provider } = await setup([presentPlan, textResponse('Revising.')]);
    controller.setPermissionMode('plan');
    controller.submit('Make the answer 42.');
    await waitFor(() => controller.getState().mode === 'plan-review');
    controller.respondPlan({ decision: 'keep_planning', feedback: 'Also update the README.' });
    await controller.idle();
    expect(controller.getState().permissionMode).toBe('plan');
    expect(lastMessage(provider.requests[1])[0]).toContain(
      'Their feedback:\nAlso update the README.',
    );
  });

  it('esc keeps planning and ends the turn; the next message says what to change', async () => {
    const { controller, provider } = await setup([presentPlan, textResponse('Revising.')]);
    controller.setPermissionMode('plan');
    controller.submit('Make the answer 42.');
    await waitFor(() => controller.getState().mode === 'plan-review');
    controller.respondPlan({ decision: 'keep_planning' });
    await controller.idle();
    expect(provider.requests).toHaveLength(1);
    expect(controller.getState().mode).toBe('idle');
    expect(tools(controller.getState().items)[0]).toMatchObject({
      status: 'done',
      display: { summary: 'keep planning' },
    });
    controller.submit('Use 43 instead.');
    await controller.idle();
    expect(lastMessage(provider.requests[1]).at(-1)).toBe('Use 43 instead.');
  });

  it('Ctrl+C interrupts the review and changes nothing; Ctrl+O prints the plan', async () => {
    const { controller } = await setup([presentPlan]);
    controller.setPermissionMode('plan');
    controller.submit('Make the answer 42.');
    await waitFor(() => controller.getState().mode === 'plan-review');
    controller.expandPermission();
    expect(controller.getState().items.at(-1)).toMatchObject({
      kind: 'detail',
      title: 'Plan',
      text: PLAN,
    });
    expect(controller.handleCtrlC(false)).toBe('interrupted');
    await controller.idle();
    expect(controller.getState().permissionMode).toBe('plan');
    expect(controller.getState().planReview).toBeNull();
    expect(controller.getState().items.at(-1)).toMatchObject({ text: 'Interrupted.' });
  });

  it('outside plan mode shows the plan without asking', async () => {
    const { controller } = await setup([presentPlan, textResponse('Doing it.')]);
    controller.submit('Plan first.');
    await controller.idle();
    expect(tools(controller.getState().items)[0]).toMatchObject({
      status: 'done',
      display: { plan: PLAN },
    });
    expect(controller.getState().permissionMode).toBe('default');
  });
});
