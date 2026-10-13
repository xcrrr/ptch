import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { oneLine } from '@patch/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptyHooks,
  type HookDefinition,
  type HookEvent,
  type HooksConfig,
} from '../../src/hooks/definitions.js';
import { HookRunner, describeHookFailure } from '../../src/hooks/runner.js';
import { noopLogger } from '../../src/logging/logger.js';
import type { ShellInfo } from '../../src/shell/shell.js';
import { makeTempDir, textResponse, toolResponse, writeFiles } from '../../src/testing/index.js';
import { TEST_CWD, allowDecision, createHarness, eventsOf, runTurn } from '../agent/helpers.js';
import { NODE, isPosixShell, isProcessAlive, readPid, shell, waitFor } from '../shell/helpers.js';

let dir: string;
let cleanup: () => void;

beforeEach(() => {
  ({ dir, cleanup } = makeTempDir('patch-hooks-'));
  writeFiles(dir, { 'hook.cjs': HOOK_SCRIPT, 'sleep.cjs': SLEEP_SCRIPT });
});

afterEach(() => cleanup());

/**
 * `hook.cjs <name> <exit code> [stdout] [stderr]`: records its stdin, environment and working
 * directory in <name>.json, prints the given text and exits with the given code.
 */
const HOOK_SCRIPT = `
const fs = require('fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const [name, code, out, err] = process.argv.slice(2);
  fs.writeFileSync(name + '.json', JSON.stringify({
    input: JSON.parse(input),
    env: {
      event: process.env.PATCH_HOOK_EVENT,
      tool: process.env.PATCH_TOOL_NAME,
      file: process.env.PATCH_FILE,
      project: process.env.PATCH_PROJECT_DIR,
    },
    cwd: process.cwd(),
  }));
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  process.exitCode = Number(code);
});
`;

/** `sleep.cjs`: writes its pid to sleep.pid and waits for a minute. */
const SLEEP_SCRIPT = `
require('fs').writeFileSync('sleep.pid', String(process.pid));
setTimeout(() => {}, 60000);
`;

function hookCommand(name: string, code: number, stdout = '', stderr = ''): string {
  return `${NODE} hook.cjs ${name} ${code} "${stdout}" "${stderr}"`;
}

function hook(event: HookEvent, command: string, extra: Partial<HookDefinition> = {}) {
  return { event, command, timeoutMs: 30_000, ...extra };
}

function runner(hooks: Partial<Record<HookEvent, HookDefinition[]>>, shellInfo = shell) {
  const config: HooksConfig = { ...emptyHooks(), ...hooks };
  return new HookRunner({
    hooks: config,
    shell: shellInfo,
    projectRoot: dir,
    cwd: join(dir, 'src'),
    logger: noopLogger,
  });
}

function recorded(name: string): {
  input: Record<string, unknown>;
  env: Record<string, string>;
  cwd: string;
} {
  return JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
}

function samePath(a: string, b: string): boolean {
  const fold = (value: string) => {
    const real = realpathSync.native(value);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  return fold(a) === fold(b);
}

const signal = () => new AbortController().signal;

describe.runIf(isPosixShell)('HookRunner with real commands', () => {
  it('passes the event as JSON on stdin and in the environment, and collects stdout', async () => {
    const hooks = runner({ PreToolUse: [hook('PreToolUse', hookCommand('pre', 0, 'looks fine'))] });
    const file = join(dir, 'src', 'a.ts');
    const result = await hooks.run({
      event: 'PreToolUse',
      sessionId: 'session-1',
      signal: signal(),
      tool: { name: 'edit_file', input: { path: 'src/a.ts', old_string: 'a' }, file },
    });
    expect(result).toEqual({ outputs: ['looks fine'], failures: [], aborted: false });
    const { input, env, cwd } = recorded('pre');
    expect(input).toEqual({
      event: 'PreToolUse',
      sessionId: 'session-1',
      cwd: join(dir, 'src'),
      projectDir: dir,
      tool: 'edit_file',
      input: { path: 'src/a.ts', old_string: 'a' },
      file,
    });
    expect(env).toEqual({ event: 'PreToolUse', tool: 'edit_file', file, project: dir });
    expect(samePath(cwd, dir)).toBe(true);
  });

  it('adds event fields and leaves the tool variables empty for other events', async () => {
    const hooks = runner({ UserPromptSubmit: [hook('UserPromptSubmit', hookCommand('ups', 0))] });
    const result = await hooks.run({
      event: 'UserPromptSubmit',
      sessionId: 's',
      signal: signal(),
      fields: { prompt: 'fix the "bug"' },
    });
    expect(result.outputs).toEqual([]);
    const { input, env } = recorded('ups');
    expect(input).toMatchObject({ event: 'UserPromptSubmit', prompt: 'fix the "bug"' });
    expect(input).not.toHaveProperty('tool');
    expect(env).toEqual({ event: 'UserPromptSubmit', tool: '', file: '', project: dir });
  });

  it('runs hooks in order; exit code 2 blocks with stderr and skips the rest', async () => {
    const blocker = hook('Stop', hookCommand('second', 2, '', 'Run the tests first.'));
    const hooks = runner({
      Stop: [
        hook('Stop', hookCommand('first', 0, 'one')),
        blocker,
        hook('Stop', hookCommand('third', 0)),
      ],
    });
    const result = await hooks.run({ event: 'Stop', sessionId: 's', signal: signal() });
    expect(result).toEqual({
      outputs: ['one'],
      failures: [],
      aborted: false,
      blocked: { hook: blocker, message: 'Run the tests first.' },
    });
    expect(existsSync(join(dir, 'first.json'))).toBe(true);
    expect(existsSync(join(dir, 'third.json'))).toBe(false);
  });

  it('reports other exit codes and timeouts as failures and keeps going', async () => {
    const failing = hook('SessionStart', hookCommand('failing', 1, '', 'boom'));
    const slow = hook('SessionStart', `${NODE} sleep.cjs`, { timeoutMs: 500 });
    const hooks = runner({
      SessionStart: [failing, slow, hook('SessionStart', hookCommand('after', 0, 'context'))],
    });
    const result = await hooks.run({ event: 'SessionStart', sessionId: 's', signal: signal() });
    expect(result).toEqual({
      outputs: ['context'],
      failures: [
        { hook: failing, reason: 'exit 1', detail: 'boom' },
        { hook: slow, reason: 'timed out after 0.5s' },
      ],
      aborted: false,
    });
    expect(describeHookFailure(result.failures[0]!)).toEqual({
      // Long commands are shortened (the Node path alone is long on CI machines).
      text: `SessionStart hook failed (exit 1): ${oneLine(failing.command, 80)}`,
      hint: 'boom',
    });
  });

  it('stops the running hook when interrupted and skips the rest', async () => {
    const hooks = runner({
      PostToolUse: [
        hook('PostToolUse', `${NODE} sleep.cjs`),
        hook('PostToolUse', hookCommand('later', 0)),
      ],
    });
    const abort = new AbortController();
    const running = hooks.run({
      event: 'PostToolUse',
      sessionId: 's',
      signal: abort.signal,
      tool: { name: 'bash', input: { command: 'ls' } },
    });
    let pid: number | undefined;
    await waitFor(
      () => (pid = readPid(() => readFileSync(join(dir, 'sleep.pid'), 'utf8'))) !== undefined,
    );
    abort.abort();
    const result = await running;
    expect(result).toEqual({ outputs: [], failures: [], aborted: true });
    expect(existsSync(join(dir, 'later.json'))).toBe(false);
    await waitFor(() => !isProcessAlive(pid!), 10_000);
  });
});

describe.runIf(isPosixShell)('hooks in a turn, with real commands', () => {
  it('block a call with PreToolUse and observe the others with PostToolUse', async () => {
    const hooks = runner({
      PreToolUse: [
        hook('PreToolUse', hookCommand('pre', 2, '', 'gen/ is read-only'), { matcher: 'note' }),
      ],
      PostToolUse: [hook('PostToolUse', hookCommand('post', 0))],
    });
    const harness = createHarness(
      [
        toolResponse([
          { name: 'note', input: { path: 'gen/api.ts', content: 'x' } },
          { name: 'echo', input: { text: 'hi' } },
        ]),
        textResponse('ok'),
      ],
      { agent: { hooks }, decisions: { write: allowDecision() } },
    );
    const { result, events } = await runTurn(harness.agent, 'go');

    expect(result.status).toBe('completed');
    expect(harness.lab.notes.size).toBe(0);
    expect(harness.lab.log).toEqual(['start:echo:hi', 'end:echo:hi']);
    const [note, echo] = eventsOf(events, 'tool_end');
    expect(note?.result).toMatchObject({
      isError: true,
      content: expect.stringContaining('gen/ is read-only'),
      display: { summary: 'blocked by hook' },
    });
    expect(echo?.result.isError).toBeUndefined();
    expect(recorded('pre')).toMatchObject({
      input: { event: 'PreToolUse', tool: 'note', file: join(TEST_CWD, 'gen', 'api.ts') },
      env: { tool: 'note', file: join(TEST_CWD, 'gen', 'api.ts') },
    });
    // The blocked call never ran, so only echo reached PostToolUse (its "path" is its text).
    expect(recorded('post')).toMatchObject({
      input: { event: 'PostToolUse', tool: 'echo', outcome: 'success', isError: false },
      env: { tool: 'echo', file: join(TEST_CWD, 'hi') },
    });
  });
});

describe('HookRunner', () => {
  it('matches tool hooks by a regular expression over the whole tool name', () => {
    const guard = hook('PreToolUse', 'guard', { matcher: 'bash|edit_file' });
    const all = hook('PreToolUse', 'log');
    const hooks = runner({ PreToolUse: [guard, all] });
    expect(hooks.hooksFor('PreToolUse', 'bash')).toEqual([guard, all]);
    expect(hooks.hooksFor('PreToolUse', 'edit_file')).toEqual([guard, all]);
    expect(hooks.hooksFor('PreToolUse', 'bash_extra')).toEqual([all]);
    expect(hooks.hooksFor('PreToolUse', 'read_file')).toEqual([all]);
    expect(hooks.has('PostToolUse', 'bash')).toBe(false);
    expect(runner({ PostToolUse: [guard] }).has('PostToolUse', 'write_file')).toBe(false);
  });

  it('runs nothing for an event without hooks', async () => {
    const hooks = runner({});
    expect(await hooks.run({ event: 'Stop', sessionId: 's', signal: signal() })).toEqual({
      outputs: [],
      failures: [],
      aborted: false,
    });
  });

  it('reports a hook whose shell cannot start', async () => {
    const missing: ShellInfo = {
      kind: 'bash',
      executable: join(dir, 'no-such-shell'),
      label: 'bash',
      argsFor: (command) => ['-c', command],
    };
    const broken = hook('Stop', 'echo hi');
    const result = await runner({ Stop: [broken] }, missing).run({
      event: 'Stop',
      sessionId: 's',
      signal: signal(),
    });
    expect(result.failures).toEqual([
      { hook: broken, reason: expect.stringMatching(/^Could not start shell .*no-such-shell/) },
    ]);
  });
});
