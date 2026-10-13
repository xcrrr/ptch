import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { stripAnsi } from '@patch/shared';
import {
  ScriptedProvider,
  makeGitRepo,
  makeTempDir,
  textResponse,
  toolResponse,
  type ScriptStep,
} from '@patch/core/testing';
import { parseArgs } from '../../src/args.js';
import { runInteractive } from '../../src/app/render.js';
import { Runtime } from '../../src/runtime.js';
import { CLEAR, delay, fakeTerminal, waitFor } from './fake-tty.js';

const keys = {
  enter: '\r',
  altEnter: '\u001b\r',
  down: '\u001b[B',
  up: '\u001b[A',
  backspace: '\u007f',
  ctrlC: '\u0003',
  ctrlD: '\u0004',
  ctrlL: '\u000c',
  ctrlO: '\u000f',
  ctrlU: '\u0015',
  escape: '\u001b',
  shiftTab: '\u001b[Z',
} as const;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Runs the real interactive UI on a fake 80x24 terminal. */
async function start(steps: ScriptStep[], size = { columns: 80, rows: 24 }) {
  const repo = makeGitRepo({ 'README.md': '# demo\n' });
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
  const term = fakeTerminal(size.columns, size.rows);
  const done = runInteractive(runtime, handle, { ...term.io, patchConsole: false });
  const screen = () => stripAnsi(term.stdout.output);
  await waitFor(() => screen().includes('What do you want to build?'));
  /** Types keys one event at a time, the way a terminal delivers them. */
  const type = async (...inputs: string[]) => {
    for (const input of inputs) {
      term.stdin.type(input);
      await delay(15);
    }
  };
  const exit = async () => {
    await type(keys.ctrlC, keys.ctrlD);
    return done;
  };
  return { term, type, screen, exit, provider, handle, done };
}

describe('the start screen', () => {
  /** A row of the wordmark (the tops of p, t, c and h). */
  const LOGO_ROW = '▄▄▄▄▄   ▄█▄▄   ▄▄▄▄▄  █▄▄▄▄';

  it('scrolls earlier output away, shows the logo, and fades it out on the first message', async () => {
    const { term, type, screen, exit } = await start([textResponse('answer-marker-4c2a')]);
    expect(term.stdout.output.startsWith('\n'.repeat(24) + '\u001b[H')).toBe(true);
    await waitFor(() => screen().includes(LOGO_ROW));
    // The logo is the title: the header under it has none.
    expect(screen()).not.toContain('ptch 0.1.0');
    await waitFor(() => screen().includes('v0.1.0'));

    const mark = term.stdout.output.length;
    await type('hello', keys.enter);
    await waitFor(() => screen().includes('answer-marker-4c2a'));
    const after = stripAnsi(term.stdout.output.slice(mark));
    // The conversation is printed after the logo has gone, never above or below it.
    const transcript = after.indexOf('answer-marker-4c2a');
    expect(after.slice(transcript)).not.toContain(LOGO_ROW);
    expect(after).not.toContain('ptch 0.1.0');
    expect(term.stdout.clearsSince(0)).toBe(0);
    expect(await exit()).toBe(0);
  });

  it('starts without the logo when the terminal is too small for it', async () => {
    const { screen, exit } = await start([], { columns: 80, rows: 14 });
    expect(screen()).toContain('ptch 0.1.0');
    expect(screen()).not.toContain(LOGO_ROW);
    expect(await exit()).toBe(0);
  });
});

describe('the live area', () => {
  it('stays shorter than the terminal while text streams under a slash menu, queue and draft', async () => {
    const code = Array.from({ length: 200 }, (_, i) => `const value${i} = ${i};`).join('\n');
    const { term, type, screen, exit } = await start([
      // An unclosed code fence stays live until the answer ends.
      { text: `Here it is:\n\n\`\`\`ts\n${code}`, chunkSize: 24, chunkDelayMs: 45 },
      textResponse('First queued answer.'),
      textResponse('Second queued answer.'),
      textResponse('Third queued answer.'),
      textResponse('Fourth queued answer.'),
    ]);
    await type('write the code', keys.enter);
    await waitFor(() => screen().includes('const value20'));
    const mark = term.stdout.output.length;

    await type('/');
    await delay(200);
    expect(stripAnsi(term.stdout.output.slice(mark))).toContain('/help');
    await type(keys.backspace);
    for (const prompt of ['one', 'two', 'three', 'four']) await type(prompt, keys.enter);
    await type('draft');
    for (let i = 0; i < 18; i++) await type(keys.altEnter, `line ${i}`);
    await delay(200);
    const streamedMeanwhile = !screen().includes('First queued answer.');

    expect(streamedMeanwhile).toBe(true);
    expect(term.stdout.clearsSince(mark)).toBe(0);
    await waitFor(() => screen().includes('Fourth queued answer.'));
    expect(await exit()).toBe(0);
  });

  it('fits a permission prompt for a long command and shows it in full on ctrl+o', async () => {
    const body = Array.from({ length: 60 }, (_, i) => `entry number ${i + 1}`).join('\n');
    const command = `cat > notes.txt <<'EOF'\n${body}\nEOF`;
    const { term, type, screen, exit } = await start([
      toolResponse([{ name: 'bash', input: { command } }]),
    ]);
    await type('save the notes', keys.enter);
    await waitFor(() => screen().includes('1. Yes'));
    const mark = term.stdout.output.length;

    await type(keys.down, keys.down, keys.up);
    await delay(100);
    expect(term.stdout.clearsSince(mark)).toBe(0);
    const prompt = stripAnsi(term.stdout.output.slice(mark));
    expect(prompt).toContain('ctrl+o show in full');

    await type(keys.ctrlO);
    await waitFor(() => screen().includes('entry number 60'));
    expect(term.stdout.clearsSince(mark)).toBe(0);
    await type(keys.escape);
    await waitFor(() => screen().includes('declined'));
    expect(await exit()).toBe(0);
  });

  it('switches permission modes with shift+tab and shows the mode in the footer', async () => {
    const { term, type, screen, exit, handle } = await start([]);
    const footer = () => screen().trimEnd().split('\n').at(-1) ?? '';
    expect(footer()).toContain('/ for commands');
    const mark = term.stdout.output.length;

    await type(keys.shiftTab);
    await waitFor(() => footer().includes('⏵⏵ accepting edits · shift+tab to change'));
    expect(handle.permissions.mode).toBe('acceptEdits');
    await type(keys.shiftTab);
    await waitFor(() => footer().includes('⏸ plan mode · shift+tab to change'));
    expect(handle.permissions.mode).toBe('plan');
    // Auto mode is confirmed first, once per session.
    await type(keys.shiftTab);
    await waitFor(() => screen().includes('Destructive commands and secret files still ask.'));
    expect(handle.permissions.mode).toBe('plan');
    await type(keys.enter);
    // 80 columns leave room for the start of the hint only.
    await waitFor(() => footer().includes('⏵⏵⏵ auto mode · no permission prompts · shift+'));
    expect(handle.permissions.mode).toBe('auto');
    await type(keys.shiftTab);
    await waitFor(() => footer().includes('/ for commands'));
    expect(handle.permissions.mode).toBe('default');
    expect(term.stdout.clearsSince(mark)).toBe(0);
    expect(await exit()).toBe(0);
  });

  it('fits the review of a long plan and shows it in full on ctrl+o', async () => {
    const plan = Array.from({ length: 60 }, (_, i) => `${i + 1}. Step number ${i + 1}`).join('\n');
    const { term, type, screen, exit, handle } = await start([
      toolResponse([{ name: 'present_plan', input: { plan } }]),
    ]);
    await type(keys.shiftTab, keys.shiftTab);
    await type('plan the work', keys.enter);
    await waitFor(() => screen().includes('1. Yes, and accept edits'));
    const mark = term.stdout.output.length;

    await type(keys.down, keys.down, keys.up);
    await delay(100);
    expect(term.stdout.clearsSince(mark)).toBe(0);
    const prompt = stripAnsi(term.stdout.output.slice(mark));
    expect(prompt).toContain('ctrl+o show in full');
    expect(prompt).not.toContain('Step number 60');

    await type(keys.ctrlO);
    await waitFor(() => screen().includes('Step number 60'));
    expect(term.stdout.clearsSince(mark)).toBe(0);
    await type(keys.escape);
    await waitFor(() => screen().includes('keep planning') && screen().includes('⏸ plan mode'));
    expect(handle.permissions.mode).toBe('plan');
    expect(await exit()).toBe(0);
  });

  it('prints the transcript once, after the screen is cleared, on ctrl+l', async () => {
    const { term, type, screen, exit } = await start([textResponse('reply-marker-7d1f')]);
    await type('hello', keys.enter);
    await waitFor(() => screen().includes('reply-marker-7d1f'));
    await delay(50);
    const mark = term.stdout.output.length;

    await type(keys.ctrlL);
    await waitFor(() => stripAnsi(term.stdout.output.slice(mark)).includes('reply-marker-7d1f'));
    await delay(100);
    const after = term.stdout.output.slice(mark);
    const clear = after.indexOf(CLEAR);
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(stripAnsi(after.slice(0, clear))).not.toContain('reply-marker-7d1f');
    expect(stripAnsi(after.slice(clear)).split('reply-marker-7d1f')).toHaveLength(2);
    expect(await exit()).toBe(0);
  });

  it('keeps the unsent prompt, cursor included, across ctrl+l and /clear', async () => {
    const { term, type, screen, exit, provider } = await start([textResponse('Got it.')]);
    await type('my unsent draft');
    await waitFor(() => screen().includes('my unsent draft'));
    let mark = term.stdout.output.length;

    await type(keys.ctrlL);
    await waitFor(() => term.stdout.clearsSince(mark) > 0);
    await delay(150);
    const afterClear = (): string => {
      const output = term.stdout.output.slice(mark);
      return stripAnsi(output.slice(output.lastIndexOf(CLEAR)));
    };
    expect(afterClear()).toContain('› my unsent draft');
    // Editing continues where the cursor was (the end of the draft).
    await type('!');
    await waitFor(() => afterClear().includes('my unsent draft!'));

    // A draft typed while /clear prepares the new session survives its remount too.
    mark = term.stdout.output.length;
    await type(keys.ctrlU, '/clear', keys.enter, 'next prompt');
    await waitFor(() => term.stdout.clearsSince(mark) > 0);
    await delay(150);
    expect(afterClear()).toContain('› next prompt');
    await type(keys.enter);
    await waitFor(() => screen().includes('Got it.'));
    expect(provider.requests[0]?.messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'next prompt' },
    ]);
    expect(await exit()).toBe(0);
  });
});

describe('exiting', () => {
  it('lets an interrupted ! command record its output before returning', async () => {
    const { type, screen, handle, done } = await start([]);
    await type('!node -e "setInterval(() => {}, 1000)"', keys.enter);
    await waitFor(() => screen().includes('Running node'));
    await delay(300);
    await type(keys.ctrlD);
    expect(await done).toBe(0);
    // The caller deletes the session file when it has no messages: by now the command's output
    // must be in it, after the metadata line.
    expect(handle.session.hasMessages()).toBe(true);
    const lines = readFileSync(handle.session.filePath, 'utf8').split('\n').filter(Boolean);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ type: 'meta' });
    expect(lines.some((line) => (JSON.parse(line) as { type: string }).type === 'shell')).toBe(
      true,
    );
  });
});
