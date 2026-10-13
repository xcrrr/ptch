import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_OUTPUT_TAG } from '@patch/core';
import {
  ScriptedProvider,
  makeGitRepo,
  makeTempDir,
  textResponse,
  type ScriptStep,
} from '@patch/core/testing';
import { stripAnsi, type ModelRequest } from '@patch/shared';
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

function workspace(files: Record<string, string> = {}, config?: unknown) {
  const repo = makeGitRepo({ 'README.md': '# demo\n', ...files });
  const home = makeTempDir('patch-home-');
  cleanups.push(repo.cleanup, home.cleanup);
  if (config !== undefined) writeFileSync(join(home.dir, 'config.json'), JSON.stringify(config));
  return { repo: repo.dir, home: home.dir };
}

async function print(argv: string[], cwd: string, home: string, steps: ScriptStep[]) {
  const provider = new ScriptedProvider(steps);
  const stdout = new Capture();
  const stderr = new Capture();
  const io: Partial<CliIO> = {
    stdin: Readable.from([]) as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    env: { PATH: process.env.PATH, PATCH_HOME: home },
    cwd,
    homeDir: home,
    providerFactory: () => provider,
    assumeCredentials: true,
  };
  const code = await runCli(['-p', ...argv], io);
  return { code, provider, stdout: stdout.text, stderr: stripAnsi(stderr.text) };
}

function userTexts(request: ModelRequest | undefined): string[] {
  return (request?.messages ?? [])
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.content)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []));
}

describe('print mode with custom commands', () => {
  it('expands a custom command named by the prompt', async () => {
    const { repo, home } = workspace({
      '.patch/commands/review.md': '---\ndescription: Review\n---\nReview $1 and nothing else.\n',
    });
    const run = await print(['/review src/auth'], repo, home, [textResponse('Looks good.')]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('Looks good.\n');
    expect(run.stderr).toContain('/review · .patch/commands/review.md');
    expect(userTexts(run.provider.requests[0])).toEqual(['Review src/auth and nothing else.']);
  });

  it('sends other prompts as they are, and never lets a custom command replace a built-in', async () => {
    const { repo, home } = workspace({ '.patch/commands/status.md': 'Custom status.' });
    const run = await print(['/status now'], repo, home, [textResponse('ok')]);
    expect(run.code).toBe(0);
    expect(userTexts(run.provider.requests[0])).toEqual(['/status now']);
    expect(run.stderr).toContain(
      'Custom command /status (.patch/commands/status.md) is not available: a built-in command has that name.',
    );
  });
});

describe('print mode with hooks', () => {
  it('sends SessionStart output with the prompt', async () => {
    const { repo, home } = workspace(
      {},
      {
        hooks: {
          SessionStart: [{ command: `node -e "process.stdout.write('Use pnpm, not npm.')"` }],
        },
      },
    );
    const run = await print(['install deps'], repo, home, [textResponse('ok')]);
    expect(run.code).toBe(0);
    const [context, prompt] = userTexts(run.provider.requests[0]);
    expect(context?.startsWith(`${HOOK_OUTPUT_TAG} event="SessionStart">`)).toBe(true);
    expect(context).toContain('Use pnpm, not npm.');
    expect(prompt).toBe('install deps');
  });

  it('drops a prompt a UserPromptSubmit hook blocks and fails', async () => {
    const { repo, home } = workspace(
      {},
      {
        hooks: {
          UserPromptSubmit: [
            {
              command: `node -e "process.stderr.write('No deploys on Fridays.'); process.exit(2)"`,
            },
          ],
        },
      },
    );
    const run = await print(['deploy it'], repo, home, [textResponse('never')]);
    expect(run.code).toBe(1);
    expect(run.provider.requests).toHaveLength(0);
    expect(run.stderr).toContain(
      'A UserPromptSubmit hook blocked this prompt, so it was not sent.',
    );
    expect(run.stderr).toContain('No deploys on Fridays.');
  });
});
