import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ScriptedProvider,
  makeGitRepo,
  makeTempDir,
  textResponse,
  toolResponse,
  type ScriptStep,
} from '@patch/core/testing';
import { parseArgs } from '../../src/args.js';
import { AppController } from '../../src/app/controller.js';
import { Runtime } from '../../src/runtime.js';
import type { TranscriptItem } from '../../src/ui/transcript.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** `startInAuto`: the session starts in auto mode, as `ptch --auto` makes it. */
async function setup(steps: ScriptStep[], startInAuto = false) {
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
  if (startInAuto) handle.permissions.setMode('auto');
  const controller = new AppController(runtime, handle);
  cleanups.push(() => controller.close());
  return { controller, provider, repo: repo.dir };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function tools(items: readonly TranscriptItem[]) {
  return items.flatMap((item) => (item.kind === 'tool' ? [item] : []));
}

/** Shift+Tab from the default mode to auto mode. */
function cycleToAuto(controller: AppController): void {
  for (let i = 0; i < 3; i++) controller.cyclePermissionMode();
}

describe('turning on auto mode', () => {
  it('asks for confirmation the first time in a session, and only then', async () => {
    const { controller } = await setup([]);
    cycleToAuto(controller);
    expect(controller.getState().mode).toBe('auto-confirm');
    // Nothing changes until the user answers.
    expect(controller.getState().permissionMode).toBe('plan');
    expect(controller.sessionHandle.permissions.mode).toBe('plan');
    controller.respondAutoConfirm(true);
    expect(controller.getState()).toMatchObject({ mode: 'idle', permissionMode: 'auto' });
    expect(controller.sessionHandle.permissions.mode).toBe('auto');

    controller.cyclePermissionMode();
    expect(controller.getState().permissionMode).toBe('default');
    cycleToAuto(controller);
    expect(controller.getState()).toMatchObject({ mode: 'idle', permissionMode: 'auto' });
  });

  it('returns to the default mode on No, esc or Ctrl+C, and asks again next time', async () => {
    const { controller } = await setup([]);
    cycleToAuto(controller);
    controller.respondAutoConfirm(false);
    expect(controller.getState()).toMatchObject({ mode: 'idle', permissionMode: 'default' });
    expect(controller.sessionHandle.permissions.mode).toBe('default');

    cycleToAuto(controller);
    expect(controller.getState().mode).toBe('auto-confirm');
    expect(controller.handleCtrlC(false)).toBe('interrupted');
    expect(controller.getState()).toMatchObject({ mode: 'idle', permissionMode: 'default' });
  });

  it('/auto turns auto mode on (after the confirmation) and off', async () => {
    const { controller } = await setup([]);
    controller.submit('/auto');
    expect(controller.getState().mode).toBe('auto-confirm');
    controller.respondAutoConfirm(true);
    expect(controller.getState().permissionMode).toBe('auto');
    expect(controller.getState().items.at(-1)).toMatchObject({
      kind: 'notice',
      text: 'Auto mode is on: edits and commands run without asking. Destructive commands and secret files still ask.',
    });
    controller.submit('/status');
    await controller.idle();
    const status = controller.getState().items.at(-1);
    expect(status?.kind === 'status' && status.rows.find((row) => row.label === 'Mode')).toEqual({
      label: 'Mode',
      value: 'auto mode (no permission prompts)',
      detail: 'shift+tab to change',
    });
    controller.submit('/auto');
    expect(controller.getState().permissionMode).toBe('default');
    expect(controller.getState().items.at(-1)).toMatchObject({
      text: 'Auto mode is off: Patch asks before acting again.',
    });
    // Confirmed already in this session.
    controller.submit('/auto');
    expect(controller.getState()).toMatchObject({ mode: 'idle', permissionMode: 'auto' });
    controller.submit('/auto please');
    expect(controller.getState().items.at(-1)).toMatchObject({ level: 'warn' });
  });

  it('needs no confirmation in a session started with --auto', async () => {
    const { controller } = await setup([], true);
    expect(controller.getState().permissionMode).toBe('auto');
    controller.cyclePermissionMode();
    cycleToAuto(controller);
    expect(controller.getState()).toMatchObject({ mode: 'idle', permissionMode: 'auto' });
  });

  it('keeps auto mode for /clear; a resumed session starts in default and asks again', async () => {
    const { controller } = await setup([textResponse('Hi.')], true);
    controller.submit('hello');
    await controller.idle();
    const first = controller.session;
    controller.submit('/clear');
    await controller.idle();
    expect(controller.getState().permissionMode).toBe('auto');
    controller.submit(`/resume ${first.id}`);
    await controller.idle();
    expect(controller.getState().permissionMode).toBe('default');
    cycleToAuto(controller);
    expect(controller.getState().mode).toBe('auto-confirm');
  });
});

describe('a turn in auto mode', () => {
  it('edits and runs commands without asking; a destructive command still asks', async () => {
    const { controller, provider, repo } = await setup([
      toolResponse([
        { name: 'read_file', input: { path: 'src/app.ts' } },
        { name: 'edit_file', input: { path: 'src/app.ts', old_string: '41', new_string: '42' } },
        { name: 'bash', input: { command: 'mkdir build' } },
      ]),
      toolResponse([{ name: 'bash', input: { command: 'rm -rf build' } }]),
      textResponse('Kept build.'),
    ]);
    cycleToAuto(controller);
    controller.respondAutoConfirm(true);
    controller.submit('Change the answer and clean up.');
    await waitFor(() => controller.getState().mode === 'permission');
    expect(controller.getState().permission?.prompt.title).toBe('Potentially destructive command');
    expect(readFileSync(join(repo, 'src/app.ts'), 'utf8')).toBe('export const answer = 42;\n');
    expect(existsSync(join(repo, 'build'))).toBe(true);
    controller.respondPermission({ decision: 'deny' });
    await controller.idle();
    expect(existsSync(join(repo, 'build'))).toBe(true);
    expect(tools(controller.getState().items).map((t) => [t.summary.verb, t.status])).toEqual([
      ['read', 'done'],
      ['edit', 'done'],
      ['bash', 'done'],
      ['bash', 'denied'],
    ]);
    expect(provider.requests).toHaveLength(2);
    expect(controller.sessionHandle.permissions.sessionGrants()).toEqual([]);
  });

  it('still asks before reading a secret file', async () => {
    const { controller, repo } = await setup([
      toolResponse([{ name: 'read_file', input: { path: '.env' } }]),
      textResponse('Skipped it.'),
    ]);
    writeFileSync(join(repo, '.env'), 'TOKEN=secret\n');
    cycleToAuto(controller);
    controller.respondAutoConfirm(true);
    controller.submit('Read the env file.');
    await waitFor(() => controller.getState().mode === 'permission');
    expect(controller.getState().permission?.prompt.title).toBe(
      'Patch wants to read a sensitive file',
    );
    controller.respondPermission({ decision: 'deny' });
    await controller.idle();
  });
});
