import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { planModeNote } from '@patch/core';
import {
  ScriptedProvider,
  makeGitRepo,
  makeTempDir,
  textResponse,
  toolResponse,
  type ScriptStep,
} from '@patch/core/testing';
import { stripAnsi, type ModelRequest } from '@patch/shared';
import { HELP_TEXT, UsageError, parseArgs } from '../src/args.js';
import { runCli, type CliIO } from '../src/cli.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

class Capture extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _encoding: string, callback: () => void): void {
    this.text += chunk.toString();
    callback();
  }
}

const PLAN = '## Answer 42\n\n1. Change `answer` in `src/app.ts` to 42.\n2. Run the tests.';

async function print(argv: string[], steps: ScriptStep[]) {
  const repo = makeGitRepo({ 'src/app.ts': 'export const answer = 41;\n' });
  const home = makeTempDir('patch-home-');
  cleanups.push(repo.cleanup, home.cleanup);
  const provider = new ScriptedProvider(steps);
  const stdout = new Capture();
  const stderr = new Capture();
  const io: Partial<CliIO> = {
    stdin: Readable.from([]) as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    env: { PATH: process.env.PATH, PATCH_HOME: home.dir },
    cwd: repo.dir,
    homeDir: home.dir,
    providerFactory: () => provider,
    assumeCredentials: true,
  };
  const code = await runCli(['-p', ...argv], io);
  return {
    code,
    provider,
    repo: repo.dir,
    stdout: stdout.text,
    stderr: stripAnsi(stderr.text),
  };
}

function userTexts(request: ModelRequest | undefined): string[] {
  return (request?.messages.at(-1)?.content ?? []).flatMap((block) =>
    block.type === 'text' ? [block.text] : [],
  );
}

const research: ScriptStep[] = [
  toolResponse([{ name: 'read_file', input: { path: 'src/app.ts' } }], 'Reading first.'),
  toolResponse([
    { name: 'edit_file', input: { path: 'src/app.ts', old_string: '41', new_string: '42' } },
  ]),
  toolResponse([{ name: 'present_plan', input: { plan: PLAN } }], 'Here is the plan.'),
];

describe('ptch -p --plan', () => {
  it('researches, changes nothing, prints the plan and exits 0', async () => {
    const run = await print(
      ['--plan', 'Make the answer 42.'],
      [...research, textResponse('never asked for')],
    );

    expect(run.code).toBe(0);
    expect(run.provider.requests).toHaveLength(3);
    expect(run.provider.remaining).toBe(1);
    expect(userTexts(run.provider.requests[0])).toEqual([
      planModeNote(true),
      'Make the answer 42.',
    ]);
    expect(readFileSync(join(run.repo, 'src/app.ts'), 'utf8')).toBe('export const answer = 41;\n');
    expect(run.stdout).toBe(`Reading first.\nHere is the plan.\n\n${PLAN}\n`);
    // Denied by plan mode: nothing to approve, so no "Needs approval" hint.
    expect(run.stderr).toMatch(/edit\s+src\/app\.ts.*\(declined\)/);
    expect(run.stderr).not.toContain('Needs approval');
    expect(run.stderr).toMatch(/plan\s+Answer 42 · presented/);
  });

  it('returns the plan as the result in json format', async () => {
    const run = await print(['--plan', '--output-format', 'json', 'Make the answer 42.'], research);
    expect(run.code).toBe(0);
    const json = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ status: 'completed', is_error: false, result: PLAN });
  });

  it('without --plan prints a presented plan and carries on', async () => {
    const run = await print(
      ['Plan, then make the answer 42.'],
      [
        toolResponse([{ name: 'present_plan', input: { plan: PLAN } }]),
        textResponse('Following the plan.'),
      ],
    );
    expect(run.code).toBe(0);
    expect(run.provider.requests).toHaveLength(2);
    expect(run.stdout).toBe(`${PLAN}\nFollowing the plan.\n`);
    expect(userTexts(run.provider.requests[0])).toEqual(['Plan, then make the answer 42.']);
  });
});

describe('--plan', () => {
  it('is parsed for both modes and documented', () => {
    expect(parseArgs([]).plan).toBe(false);
    expect(parseArgs(['--plan']).plan).toBe(true);
    expect(parseArgs(['-p', '--plan', 'do it'])).toMatchObject({
      print: true,
      plan: true,
      prompt: 'do it',
    });
    expect(HELP_TEXT).toContain('--plan');
    expect(HELP_TEXT).toContain('ptch -p --plan "<prompt>"');
  });
});

describe('ptch -p --auto', () => {
  it('edits and runs commands without asking, and denies destructive commands', async () => {
    const run = await print(
      ['--auto', 'Make the answer 42 and clean up.'],
      [
        toolResponse([
          { name: 'read_file', input: { path: 'src/app.ts' } },
          { name: 'edit_file', input: { path: 'src/app.ts', old_string: '41', new_string: '42' } },
          { name: 'bash', input: { command: 'mkdir build' } },
        ]),
        toolResponse([{ name: 'bash', input: { command: 'rm -rf build' } }]),
        textResponse('Changed the answer; build/ is still there.'),
      ],
    );

    expect(run.code).toBe(0);
    expect(readFileSync(join(run.repo, 'src/app.ts'), 'utf8')).toBe('export const answer = 42;\n');
    expect(existsSync(join(run.repo, 'build'))).toBe(true);
    expect(run.stdout).toBe('Changed the answer; build/ is still there.\n');
    expect(run.stderr).toContain(
      'Denied in auto mode: Potentially destructive command — rm -rf build. Auto mode still asks before destructive commands and secret files, and print mode cannot ask; run it interactively to allow it.',
    );
    expect(run.stderr).not.toContain('Needs approval');
    const denied = run.provider.requests[2]?.messages
      .at(-1)
      ?.content.find((block) => block.type === 'tool_result');
    expect(denied?.type === 'tool_result' && denied.content).toContain(
      "needs the user's approval even in auto mode",
    );
  });

  it('lists what it denied in json format', async () => {
    const run = await print(
      ['--auto', '--output-format', 'json', 'Clean up.'],
      [toolResponse([{ name: 'bash', input: { command: 'rm -rf build' } }]), textResponse('ok')],
    );
    const json = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      status: 'completed',
      permission_denials: ['rm -rf build (run it interactively)'],
    });
  });
});

describe('--auto', () => {
  it('is parsed for both modes, documented, and refused together with --plan', () => {
    expect(parseArgs([]).auto).toBe(false);
    expect(parseArgs(['--auto'])).toMatchObject({ auto: true, plan: false });
    expect(parseArgs(['-p', '--auto', 'do it'])).toMatchObject({
      print: true,
      auto: true,
      prompt: 'do it',
    });
    expect(() => parseArgs(['--plan', '--auto'])).toThrow(
      'Use either --plan or --auto, not both: plan mode changes nothing, auto mode acts without asking.',
    );
    expect(() => parseArgs(['-p', '--auto', '--plan', 'x'])).toThrow(UsageError);
    expect(HELP_TEXT).toContain('--auto');
  });

  it('is a usage error (exit 2) together with --plan', async () => {
    const run = await print(['--plan', '--auto', 'x'], []);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('Use either --plan or --auto, not both');
    expect(run.provider.requests).toHaveLength(0);
  });
});
