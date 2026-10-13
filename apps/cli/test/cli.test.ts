import { existsSync, readFileSync } from 'node:fs';
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
import { stripAnsi, type ModelRequest } from '@patch/shared';
import { parseArgs } from '../src/args.js';
import { EXIT_INTERRUPTED, runCli, type CliIO } from '../src/cli.js';
import { Runtime } from '../src/runtime.js';
import { WORKING_DIRECTORY_TAG } from '../src/working-directory.js';

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

function workspace() {
  const repo = makeGitRepo({ 'README.md': '# demo\n', 'packages/web/index.ts': 'export {};\n' });
  const home = makeTempDir('patch-home-');
  cleanups.push(repo.cleanup, home.cleanup);
  return { repo: repo.dir, home: home.dir };
}

/** Runs `ptch` in print mode with a scripted model. */
function print(
  argv: string[],
  options: { cwd: string; home: string; provider: ScriptedProvider },
): { result: Promise<number>; stdout: Capture; stderr: Capture } {
  const stdout = new Capture();
  const stderr = new Capture();
  const io: Partial<CliIO> = {
    stdin: Readable.from([]) as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    env: { PATH: process.env.PATH, PATCH_HOME: options.home },
    cwd: options.cwd,
    homeDir: options.home,
    providerFactory: () => options.provider,
    assumeCredentials: true,
  };
  return { result: runCli(['-p', ...argv], io), stdout, stderr };
}

function scripted(steps: ScriptStep[]): ScriptedProvider {
  return new ScriptedProvider(steps);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`still running after ${ms} ms`)), ms),
    ),
  ]);
}

function userTexts(request: ModelRequest | undefined): string[] {
  return (request?.messages ?? [])
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.content)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []));
}

describe('print mode', () => {
  it.each(['SIGTERM', 'SIGHUP'] as const)(
    'stops the running command and exits on %s',
    async (signal) => {
      const { repo, home } = workspace();
      const command = `node -e "require('fs').writeFileSync('child.pid', String(process.pid)); setInterval(() => {}, 1000)"`;
      const provider = scripted([
        toolResponse([{ name: 'bash', input: { command } }]),
        textResponse('Not reached.'),
      ]);
      const run = print(['start it', '--allow-command', 'node'], { cwd: repo, home, provider });
      const pidFile = join(repo, 'child.pid');
      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '');
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(isAlive(pid)).toBe(true);

      process.emit(signal, signal);
      expect(await within(run.result, 15_000)).toBe(EXIT_INTERRUPTED);
      // Windows reports a killed process tree gone a moment after taskkill returns.
      await waitFor(() => !isAlive(pid), 10_000).catch(() => undefined);
      expect(isAlive(pid)).toBe(false);
      expect(process.listenerCount(signal)).toBe(0);
    },
  );

  it('warns and tells the model when a session resumes in another directory', async () => {
    const { repo, home } = workspace();
    const provider = scripted([textResponse('First.'), textResponse('Second.')]);
    const first = print(['first', '--output-format', 'json'], {
      cwd: join(repo, 'packages', 'web'),
      home,
      provider,
    });
    expect(await first.result).toBe(0);
    const { session_id: id } = JSON.parse(first.stdout.text) as { session_id: string };

    const second = print(['second', '--resume', id], { cwd: repo, home, provider });
    expect(await second.result).toBe(0);
    expect(stripAnsi(second.stderr.text)).toContain('This session was recorded in');
    const updates = userTexts(provider.requests[1]).filter((t) =>
      t.startsWith(WORKING_DIRECTORY_TAG),
    );
    expect(updates).toHaveLength(1);
    expect(userTexts(provider.requests[1]).slice(-2)).toEqual([updates[0], 'second']);
    expect(provider.requests[1]?.system).toBe(provider.requests[0]?.system);
  });

  it('repairs a session a stopped process left mid tool call when resuming it elsewhere', async () => {
    const { repo, home } = workspace();
    const provider = scripted([textResponse('Continuing.'), textResponse('Again.')]);
    const runtime = await Runtime.create({
      cwd: join(repo, 'packages', 'web'),
      env: { PATH: process.env.PATH, PATCH_HOME: home },
      args: parseArgs([]),
      homeDir: home,
      providerFactory: () => provider,
      assumeCredentials: true,
    });
    const { session } = await runtime.newSession();
    session.append({
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'run the tests' }] },
    });
    session.append({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'call_x', name: 'bash', input: { command: 'ls' } }],
      },
    });
    session.close();

    for (const prompt of ['continue', 'again']) {
      const run = print([prompt, '--resume', session.id], { cwd: repo, home, provider });
      expect(await run.result).toBe(0);
    }
    expect(provider.requests).toHaveLength(2);
    for (const request of provider.requests) {
      const messages = request.messages;
      const call = messages.findIndex((m) => m.content.some((b) => b.type === 'tool_call'));
      expect(messages[call + 1]?.content).toContainEqual(
        expect.objectContaining({ type: 'tool_result', toolCallId: 'call_x' }),
      );
    }
    const texts = userTexts(provider.requests[1]);
    expect(texts.filter((t) => t.startsWith(WORKING_DIRECTORY_TAG))).toHaveLength(1);
    expect(texts.slice(-1)).toEqual(['again']);
  });
});
