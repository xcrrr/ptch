import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/args.js';
import { EXIT_USAGE, runCli } from '../../src/cli.js';
import { delay, fakeTerminal, waitFor } from '../app/fake-tty.js';
import { FakeApi, FakeBackend } from './fakes.js';

class Capture extends Writable {
  text = '';
  isTTY = false;
  override _write(chunk: Buffer | string, _encoding: string, callback: () => void): void {
    this.text += chunk.toString();
    callback();
  }
}

const dead: Array<() => void> = [];
afterEach(() => {
  for (const d of dead.splice(0)) d();
});

function pipes(env: NodeJS.ProcessEnv = {}) {
  const stdout = new Capture();
  const stderr = new Capture();
  return {
    stdout,
    stderr,
    io: {
      stdin: Readable.from([]) as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      env: { PATH: process.env.PATH, ...env },
      cwd: process.cwd(),
    },
  };
}

describe('ptch routes to the cloud', () => {
  it('prints the ptch cloud help when there is no terminal (scripts)', async () => {
    const { io, stderr, stdout } = pipes();
    const code = await runCli([], io);
    expect(code).toBe(EXIT_USAGE);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('Patch Cloud opens in an interactive terminal');
    expect(stderr.text).toContain('ptch cloud submit');
    expect(stderr.text).toContain('ptch cloud list');
  });

  it('says in one honest line that local mode is disabled in this beta', async () => {
    const { io, stderr } = pipes();
    const code = await runCli(['--local'], io);
    expect(code).toBe(EXIT_USAGE);
    expect(stderr.text).toBe(
      'Local mode is disabled in this beta: Patch runs in Patch Cloud. Run "ptch" to open it.\n',
    );
  });

  it('keeps the old messages for the local UI only behind PATCH_ENABLE_LOCAL=1', async () => {
    const { io, stderr } = pipes({ PATCH_ENABLE_LOCAL: '1' });
    const code = await runCli([], io);
    expect(code).toBe(EXIT_USAGE);
    expect(stderr.text).toBe(
      'Patch needs an interactive terminal. For scripts and pipes use: ptch -p "<prompt>"\n',
    );
  });

  it('opens the cloud view on a terminal, not the local agent', async () => {
    const api = new FakeApi();
    const backend = new FakeBackend(api, { linkedProject: 'prj_demo' });
    const term = fakeTerminal(100, 30);
    const run = runCli([], {
      ...term.io,
      env: { PATH: process.env.PATH },
      cwd: process.cwd(),
      cloudView: { backend, patchConsole: false, pollMs: 3_600_000 },
    });
    await waitFor(() => term.stdout.output.includes('worker online'));
    expect(term.stdout.output).toContain('Owner');
    expect(term.stdout.output).not.toContain('What do you want to build?');
    await delay(1_700);
    term.stdin.type('/quit');
    await delay(50);
    term.stdin.type('\r');
    expect(await run).toBe(0);
  });

  it('sends a positional prompt as the first message of a new conversation', async () => {
    const api = new FakeApi();
    const backend = new FakeBackend(api);
    const term = fakeTerminal(100, 30);
    const run = runCli(['what', 'is', 'running?'], {
      ...term.io,
      env: { PATH: process.env.PATH },
      cwd: process.cwd(),
      cloudView: { backend, patchConsole: false, pollMs: 3_600_000 },
    });
    await waitFor(() => api.log.includes('sendMessage what is running?'));
    await waitFor(() => term.stdout.output.includes('You said: what is running?'));
    term.stdin.type('\u0003');
    await delay(30);
    term.stdin.type('\u0003');
    expect(await run).toBe(0);
    // The way back into this conversation is printed on leaving.
    expect(term.stdout.output).toMatch(/Resume this conversation with: ptch --resume cnv_/);
  });

  it('opens a conversation by id with --resume', async () => {
    const api = new FakeApi();
    const conversation = await api.createConversation({});
    await api.sendMessage(conversation.id, { text: 'earlier' });
    const backend = new FakeBackend(api);
    const term = fakeTerminal(100, 30);
    const run = runCli(['--resume', conversation.id], {
      ...term.io,
      env: { PATH: process.env.PATH },
      cwd: process.cwd(),
      cloudView: { backend, patchConsole: false, pollMs: 3_600_000 },
    });
    await waitFor(() => term.stdout.output.includes('You said: earlier'));
    expect(term.stdout.output).not.toContain('What do you want to build?');
    term.stdin.type('/quit');
    await delay(50);
    term.stdin.type('\r');
    expect(await run).toBe(0);
  });

  it('opens the latest conversation with --continue', async () => {
    const api = new FakeApi();
    const first = await api.createConversation({});
    await api.sendMessage(first.id, { text: 'older' });
    const second = await api.createConversation({});
    await api.sendMessage(second.id, { text: 'newest' });
    const term = fakeTerminal(100, 30);
    const run = runCli(['--continue'], {
      ...term.io,
      env: { PATH: process.env.PATH },
      cwd: process.cwd(),
      cloudView: { backend: new FakeBackend(api), patchConsole: false, pollMs: 3_600_000 },
    });
    await waitFor(() => term.stdout.output.includes('You said: newest'));
    expect(term.stdout.output).not.toContain('You said: older');
    term.stdin.type('/quit');
    await delay(50);
    term.stdin.type('\r');
    expect(await run).toBe(0);
  });
});

describe('arguments', () => {
  it('takes a conversation id after --resume', () => {
    expect(parseArgs(['--resume', 'cnv_0abc123def456'])).toMatchObject({
      resume: true,
      resumeId: 'cnv_0abc123def456',
    });
    expect(parseArgs(['--resume', 'fix the bug'])).toMatchObject({
      resume: true,
      prompt: 'fix the bug',
    });
  });

  it('knows the hidden --local switch', () => {
    expect(parseArgs([]).local).toBe(false);
    expect(parseArgs(['--local']).local).toBe(true);
  });
});
