import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ScriptedProvider,
  makeGitRepo,
  makeTempDir,
  textResponse,
  toolResponse,
  type ScriptStep,
} from '@patch/core/testing';
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

async function stream(argv: string[], steps: ScriptStep[], files: Record<string, string>) {
  const repo = makeGitRepo(files);
  const home = makeTempDir('patch-home-');
  cleanups.push(repo.cleanup, home.cleanup);
  const stdout = new Capture();
  const stderr = new Capture();
  const io: Partial<CliIO> = {
    stdin: Readable.from([]) as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    env: { PATH: process.env.PATH, PATCH_HOME: home.dir },
    cwd: repo.dir,
    homeDir: home.dir,
    providerFactory: () => new ScriptedProvider(steps),
    assumeCredentials: true,
  };
  const code = await runCli(['-p', '--output-format', 'stream-json', ...argv], io);
  const records = stdout.text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown> & { type: string });
  return { code, records, raw: stdout.text, stderr: stderr.text, repo: repo.dir };
}

describe('ptch -p --output-format stream-json', () => {
  it('writes only JSON records on stdout, ending with the result', async () => {
    const run = await stream(
      ['--allow-edits', 'Make the answer 42.'],
      [
        toolResponse([{ name: 'read_file', input: { path: 'src/app.ts' } }]),
        toolResponse(
          [
            {
              name: 'edit_file',
              input: { path: 'src/app.ts', old_string: '41', new_string: '42' },
            },
          ],
          'Editing.',
        ),
        textResponse('Done: the answer is 42.'),
      ],
      { 'src/app.ts': 'export const answer = 41;\n' },
    );

    expect(run.code).toBe(0);
    const types = run.records.map((r) => r.type);
    expect(types[0]).toBe('init');
    expect(types.at(-1)).toBe('result');
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_end');
    expect(types).toContain('text');
    expect(run.records[0]).toMatchObject({ permission_mode: 'default' });

    const end = run.records.find((r) => r.type === 'tool_end' && r.name === 'edit_file');
    expect(end).toMatchObject({ name: 'edit_file', is_error: false });
    expect(end?.diff).toMatchObject({ path: 'src/app.ts', added: 1, removed: 1 });

    const result = run.records.at(-1);
    expect(result).toMatchObject({
      type: 'result',
      status: 'completed',
      is_error: false,
      result: 'Done: the answer is 42.',
    });
    expect(readFileSync(join(run.repo, 'src/app.ts'), 'utf8')).toBe('export const answer = 42;\n');
  });

  it('records skipped approvals as permission_denied and still finishes', async () => {
    const run = await stream(
      ['Make the answer 42.'],
      [
        toolResponse([{ name: 'read_file', input: { path: 'src/app.ts' } }]),
        toolResponse([
          { name: 'edit_file', input: { path: 'src/app.ts', old_string: '41', new_string: '42' } },
        ]),
        textResponse('Could not edit.'),
      ],
      { 'src/app.ts': 'export const answer = 41;\n' },
    );
    expect(run.code).toBe(0);
    expect(run.records.some((r) => r.type === 'permission_denied')).toBe(true);
    expect(run.records.at(-1)?.permission_denials).toHaveLength(1);
  });

  it('keeps file contents and secrets out of the stream', async () => {
    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const run = await stream(
      ['--allow-edits', 'Write a file.'],
      [
        toolResponse([
          {
            name: 'write_file',
            input: { path: 'out.txt', content: 'PRIVATE-FILE-BODY\n' },
          },
        ]),
        textResponse(`I saw the key ${secret} in the environment.`),
      ],
      { 'README.md': '# x\n' },
    );
    expect(run.raw).not.toContain('PRIVATE-FILE-BODY');
    expect(run.raw).not.toContain(secret);
    expect(run.raw).toContain('[REDACTED]');
  });
});
