import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { USER_SHELL_CONTEXT_TAG } from '@patch/core';
import {
  ScriptedProvider,
  makeGitRepo,
  makeTempDir,
  textResponse,
  toolResponse,
  type ScriptStep,
} from '@patch/core/testing';
import type { Message, ModelInfo, ModelRequest } from '@patch/shared';
import { parseArgs } from '../../src/args.js';
import {
  AppController,
  EXIT_CONFIRM_MS,
  type ControllerOptions,
} from '../../src/app/controller.js';
import { Runtime, type SessionHandle } from '../../src/runtime.js';
import type { TranscriptItem } from '../../src/ui/transcript.js';
import { WORKING_DIRECTORY_TAG } from '../../src/working-directory.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function setup(
  steps: ScriptStep[],
  options: {
    credentials?: boolean;
    controller?: ControllerOptions;
    env?: NodeJS.ProcessEnv;
    modelInfo?: Partial<ModelInfo>;
  } = {},
) {
  const repo = makeGitRepo({
    'README.md': '# demo\n',
    'src/app.ts': 'export const answer = 41;\n',
    'packages/web/index.ts': 'export {};\n',
  });
  const home = makeTempDir('patch-home-');
  cleanups.push(repo.cleanup, home.cleanup);
  const provider = new ScriptedProvider(steps, options.modelInfo);
  const runtime = await makeRuntime(repo.dir, home.dir, provider, options.credentials, options.env);
  const handle = await runtime.newSession();
  cleanups.push(() => handle.session.close());
  const controller = new AppController(runtime, handle, options.controller);
  cleanups.push(() => controller.close());
  return { controller, provider, repo: repo.dir, home: home.dir, runtime };
}

function makeRuntime(
  cwd: string,
  home: string,
  provider: ScriptedProvider,
  credentials = true,
  env: NodeJS.ProcessEnv = {},
): Promise<Runtime> {
  return Runtime.create({
    cwd,
    env: { PATH: process.env.PATH, PATCH_HOME: home, ...env },
    args: parseArgs([]),
    homeDir: home,
    providerFactory: () => provider,
    assumeCredentials: credentials,
  });
}

/** Text blocks of the user messages in a request. */
function userTexts(request: ModelRequest | undefined): string[] {
  return (request?.messages ?? [])
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.content)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []));
}

/** The API's rule: every tool call is answered by a tool result in the very next message. */
function expectToolCallsAnswered(messages: readonly Message[]): void {
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    const calls = message.content.flatMap((b) => (b.type === 'tool_call' ? [b.id] : []));
    if (calls.length === 0) return;
    const next = messages[index + 1];
    expect(next?.role).toBe('user');
    const answered = (next?.content ?? []).flatMap((b) =>
      b.type === 'tool_result' ? [b.toolCallId] : [],
    );
    expect(answered.sort()).toEqual(calls.sort());
  });
}

/** The newest /status row with this label. */
function statusRow(controller: AppController, label: string) {
  const status = controller
    .getState()
    .items.filter((i) => i.kind === 'status' && i.title === 'Status')
    .at(-1);
  return status?.kind === 'status' ? status.rows.find((row) => row.label === label) : undefined;
}

function fileEntries(filePath: string): Array<{ type: string; [key: string]: unknown }> {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string });
}

function kinds(items: TranscriptItem[]): string[] {
  return items.map((i) => i.kind);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('AppController', () => {
  it('runs a prompt and commits the user message and the answer', async () => {
    const { controller } = await setup([textResponse('The answer is in `src/app.ts`.')]);
    controller.submit('Where is the answer defined?');
    await controller.idle();
    const items = controller.getState().items;
    expect(kinds(items)).toEqual(['welcome', 'user', 'assistant']);
    const assistant = items[2];
    expect(assistant?.kind === 'assistant' && assistant.markdown).toContain('src/app.ts');
    expect(controller.getState().mode).toBe('idle');
    expect(controller.session.hasMessages()).toBe(true);
  });

  it('asks before editing and applies the edit after approval', async () => {
    const { controller, repo } = await setup([
      toolResponse([{ name: 'read_file', input: { path: 'src/app.ts' } }]),
      toolResponse([
        {
          name: 'edit_file',
          input: { path: 'src/app.ts', old_string: '41', new_string: '42' },
        },
      ]),
      textResponse('Fixed the answer.'),
    ]);
    controller.submit('Fix the answer.');
    await waitFor(() => controller.getState().mode === 'permission');
    const request = controller.getState().permission;
    expect(request?.prompt.title).toBe('Patch wants to edit src/app.ts');
    expect(request?.prompt.sessionOption?.grant).toEqual({ kind: 'all-edits' });
    controller.respondPermission({ decision: 'allow_once' });
    await controller.idle();
    expect(readFileSync(join(repo, 'src/app.ts'), 'utf8')).toBe('export const answer = 42;\n');
    const tools = controller.getState().items.filter((i) => i.kind === 'tool');
    expect(tools.map((t) => t.kind === 'tool' && t.summary.verb)).toEqual(['read', 'edit']);
    expect(tools.map((t) => t.kind === 'tool' && t.first)).toEqual([true, false]);
  });

  it('ends the turn when the user declines', async () => {
    const { controller, provider } = await setup([
      toolResponse([{ name: 'bash', input: { command: 'npm test' } }]),
    ]);
    controller.submit('Run the tests.');
    await waitFor(() => controller.getState().mode === 'permission');
    controller.respondPermission({ decision: 'deny' });
    await controller.idle();
    const tool = controller.getState().items.find((i) => i.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.status).toBe('denied');
    expect(provider.requests).toHaveLength(1);
    expect(controller.getState().mode).toBe('idle');
  });

  it('shows rows for tool calls that fail before starting', async () => {
    const { controller } = await setup([
      toolResponse([{ name: 'launch_rockets', input: {} }]),
      textResponse('That tool does not exist.'),
    ]);
    controller.submit('Do something odd.');
    await controller.idle();
    const tool = controller.getState().items.find((i) => i.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.status).toBe('error');
    expect(tool?.kind === 'tool' && tool.display?.lines?.[0]).toMatch(/Unknown tool/);
  });

  it('queues prompts submitted while busy and runs them in order', async () => {
    const { controller, provider } = await setup([
      { text: 'First answer, streaming slowly.', chunkSize: 4, chunkDelayMs: 20 },
      textResponse('Second answer.'),
    ]);
    controller.submit('first');
    controller.submit('second');
    expect(controller.getState().queue).toEqual(['second']);
    await controller.idle();
    await waitFor(() => provider.remaining === 0 && !controller.isBusy());
    await controller.idle();
    const users = controller.getState().items.filter((i) => i.kind === 'user');
    expect(users.map((u) => u.kind === 'user' && u.text)).toEqual(['first', 'second']);
    expect(controller.getState().queue).toEqual([]);
  });

  it('interrupts a streaming answer and stays usable', async () => {
    const { controller } = await setup([
      { text: 'word '.repeat(200), chunkSize: 5, chunkDelayMs: 10 },
      textResponse('Recovered.'),
    ]);
    controller.submit('Write a lot.');
    await waitFor(() => controller.getState().activity?.label === 'Responding');
    expect(controller.handleCtrlC(false)).toBe('interrupted');
    await controller.idle();
    const items = controller.getState().items;
    expect(items.at(-1)).toMatchObject({ kind: 'notice', text: 'Interrupted.' });
    controller.submit('Try again.');
    await controller.idle();
    expect(controller.getState().items.at(-1)).toMatchObject({
      kind: 'assistant',
      markdown: 'Recovered.',
    });
  });

  it('runs ! commands and shares their output with the agent', async () => {
    const { controller } = await setup([]);
    controller.submit('!git status --short');
    await controller.idle();
    const shell = controller.getState().items.find((i) => i.kind === 'shell');
    expect(shell).toMatchObject({ kind: 'shell', command: 'git status --short', exitCode: 0 });
    const history = controller.session.history();
    const last = history.at(-1);
    expect(last?.role).toBe('user');
    const block = last?.content[0];
    expect(block?.type === 'text' && block.text.startsWith(USER_SHELL_CONTEXT_TAG)).toBe(true);
  });

  it('confirms destructive ! commands and refuses blocked ones', async () => {
    const { controller } = await setup([]);
    controller.submit('!sudo ls');
    await controller.idle();
    expect(controller.getState().items.at(-1)).toMatchObject({ kind: 'notice', level: 'warn' });
    controller.submit('!rm -rf build');
    await waitFor(() => controller.getState().mode === 'permission');
    expect(controller.getState().permission?.prompt.severity).toBe('danger');
    controller.respondPermission({ decision: 'deny' });
    await controller.idle();
    expect(controller.getState().items.at(-1)).toMatchObject({ text: 'Command not run.' });
  });

  it('requires two Ctrl+C presses on an empty prompt to exit', async () => {
    const { controller } = await setup([]);
    expect(controller.handleCtrlC(true)).toBe('clear-prompt');
    expect(controller.handleCtrlC(false)).toBe('armed');
    expect(controller.getState().exitArmedAt).not.toBeNull();
    expect(controller.handleCtrlC(false)).toBe('exit');
    expect(controller.getState().exiting).toBe(true);
  });

  it('handles slash commands', async () => {
    const { controller } = await setup([]);
    controller.submit('/help');
    controller.submit('/status');
    await controller.idle();
    controller.submit('/model claude-sonnet-5-5');
    controller.submit('/permissions');
    controller.submit('/nope');
    await controller.idle();
    const items = controller.getState().items;
    expect(items.some((i) => i.kind === 'help')).toBe(true);
    const status = items.find((i) => i.kind === 'status' && i.title === 'Status');
    expect(status?.kind === 'status' && status.rows.map((r) => r.label)).toEqual(
      expect.arrayContaining(['Repository', 'Branch', 'Model', 'Session', 'Context']),
    );
    expect(controller.sessionHandle.agent.model).toBe('claude-sonnet-5-5');
    expect(items.some((i) => i.kind === 'status' && i.title === 'Permissions')).toBe(true);
    expect(items.at(-1)).toMatchObject({ kind: 'notice', text: 'Unknown command: /nope' });
  });

  it('clears into a new session and resumes the previous one', async () => {
    const { controller } = await setup([textResponse('Hello there.')]);
    controller.submit('hello');
    await controller.idle();
    const first = controller.session.id;
    controller.submit('/clear');
    await controller.idle();
    expect(controller.session.id).not.toBe(first);
    expect(kinds(controller.getState().items)).toEqual(['welcome', 'notice']);
    controller.submit(`/resume ${first.slice(0, 8)}`);
    await controller.idle();
    expect(controller.session.id).toBe(first);
    const restored = controller.getState().items;
    expect(kinds(restored)).toEqual(['welcome', 'user', 'assistant', 'divider']);
  });

  it('stays busy when a read-only command finishes during a turn', async () => {
    const { controller, provider } = await setup([
      { text: 'word '.repeat(80), chunkSize: 5, chunkDelayMs: 20 },
      textResponse('Second answer.'),
    ]);
    controller.submit('first');
    await waitFor(() => controller.getState().activity?.label === 'Responding');
    controller.submit('/status');
    controller.submit('/diff');
    await waitFor(() =>
      controller.getState().items.some((i) => i.kind === 'status' && i.title === 'Status'),
    );
    await waitFor(() =>
      controller.getState().items.some((i) => i.kind === 'notice' && /uncommitted/.test(i.text)),
    );
    expect(controller.getState().mode).toBe('running');
    expect(controller.isBusy()).toBe(true);
    controller.submit('second');
    expect(controller.getState().queue).toEqual(['second']);
    controller.submit('/clear');
    expect(controller.getState().items.at(-1)).toMatchObject({
      kind: 'notice',
      text: '/clear is available when Patch is idle.',
    });
    await controller.idle();
    expect(provider.requests).toHaveLength(2);
    const users = controller.getState().items.filter((i) => i.kind === 'user');
    expect(users.map((u) => u.kind === 'user' && u.text)).toEqual(['first', 'second']);
    expect(controller.getState().items.filter((i) => i.kind === 'assistant')).toHaveLength(2);
  });

  it('closes the exit window after EXIT_CONFIRM_MS', async () => {
    const { controller } = await setup([]);
    vi.useFakeTimers();
    try {
      expect(controller.handleCtrlC(false)).toBe('armed');
      expect(controller.getState().exitArmedAt).not.toBeNull();
      vi.advanceTimersByTime(EXIT_CONFIRM_MS);
      expect(controller.getState().exitArmedAt).toBeNull();
      expect(controller.handleCtrlC(false)).toBe('armed');
      vi.advanceTimersByTime(EXIT_CONFIRM_MS / 2);
      expect(controller.handleCtrlC(false)).toBe('exit');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays in the current session when asked to resume it', async () => {
    const changes: SessionHandle[] = [];
    const { controller } = await setup([textResponse('Hello there.')], {
      controller: { onSessionChange: (handle) => changes.push(handle) },
    });
    const { id, filePath } = controller.session;
    controller.submit(`/resume ${id.slice(0, 8)}`);
    await controller.idle();
    expect(changes).toHaveLength(0);
    expect(controller.getState().items.at(-1)).toMatchObject({
      kind: 'notice',
      text: `Already in session ${id.slice(0, 6)}.`,
    });
    controller.submit('hello');
    await controller.idle();
    expect(controller.getState().items.at(-1)).toMatchObject({
      kind: 'assistant',
      markdown: 'Hello there.',
    });
    expect(existsSync(filePath)).toBe(true);
    const entries = fileEntries(filePath);
    expect(entries[0]).toMatchObject({ type: 'meta', id });
    expect(entries.filter((e) => e.type === 'message')).toHaveLength(2);
  });

  it('keeps the model of a session resumed with /resume', async () => {
    const { controller } = await setup([textResponse('Hi.')]);
    controller.submit('/model claude-sonnet-5-5');
    controller.submit('hello');
    await controller.idle();
    const first = controller.session;
    controller.submit('/clear');
    await controller.idle();
    controller.submit('/model claude-haiku-4-5');
    controller.submit(`/resume ${first.id}`);
    await controller.idle();
    expect(controller.session.id).toBe(first.id);
    expect(controller.sessionHandle.agent.model).toBe('claude-sonnet-5-5');
    const models = fileEntries(first.filePath).filter((e) => e.type === 'model');
    expect(models.map((e) => e.model)).toEqual(['claude-sonnet-5-5']);
  });

  it('applies an explicit PATCH_MODEL to a session resumed with /resume', async () => {
    const { controller, repo, home, provider } = await setup([textResponse('Hi.')]);
    controller.submit('hello');
    await controller.idle();
    const id = controller.session.id;
    controller.session.close();
    const runtime = await makeRuntime(repo, home, provider, true, {
      PATCH_MODEL: 'claude-haiku-4-5',
    });
    const other = new AppController(runtime, await runtime.newSession());
    cleanups.push(() => other.session.close());
    other.submit(`/resume ${id}`);
    await other.idle();
    expect(other.session.id).toBe(id);
    expect(other.sessionHandle.agent.model).toBe('claude-haiku-4-5');
  });

  it('does not suggest /compact on resume when the session was just compacted', async () => {
    const { controller, runtime } = await setup([]);
    const session = controller.session;
    session.append({
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'Summarize the project.' }] },
    });
    session.append({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'It is a demo.' }] },
    });
    // A compaction request's usage (the whole transcript as its prompt), then the compaction.
    const usage = {
      inputTokens: 150_000,
      outputTokens: 4_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    session.append({ type: 'usage', model: session.model, usage });
    const resumedNotices = () => {
      const loaded = runtime.resolveSession(session.id);
      if (!loaded.ok) throw new Error(loaded.message);
      const resumed = new AppController(runtime, runtime.openSession(loaded.session), {
        resumed: true,
      });
      return resumed
        .getState()
        .items.filter((i) => i.kind === 'notice' && /context window/.test(i.text));
    };
    expect(resumedNotices()).toHaveLength(1);
    const reloaded = runtime.resolveSession(session.id);
    if (!reloaded.ok) throw new Error(reloaded.message);
    reloaded.session.append({
      type: 'compaction',
      summary: 'A demo project.',
      messagesCompacted: 2,
      auto: false,
    });
    expect(resumedNotices()).toHaveLength(0);
  });

  it('tells the model about the working directory when resumed from another directory', async () => {
    const { controller, repo, home } = await setup([]);
    const provider = new ScriptedProvider([
      textResponse('First.'),
      textResponse('Second.'),
      textResponse('Third.'),
    ]);
    const subRuntime = await makeRuntime(join(repo, 'packages', 'web'), home, provider);
    const subHandle = await subRuntime.newSession();
    const sub = new AppController(subRuntime, subHandle);
    sub.submit('first');
    await sub.idle();
    subHandle.session.close();
    controller.session.close();

    const rootRuntime = await makeRuntime(repo, home, provider);
    const loaded = rootRuntime.resolveSession(subHandle.session.id);
    if (!loaded.ok) throw new Error(loaded.message);
    const resumed = new AppController(rootRuntime, rootRuntime.openSession(loaded.session), {
      resumed: true,
    });
    cleanups.push(() => resumed.session.close());
    expect(resumed.getState().items).toContainEqual(
      expect.objectContaining({
        kind: 'notice',
        level: 'warn',
        text: expect.stringContaining('This session was recorded in'),
      }),
    );
    // Viewing a resumed session changes nothing.
    expect(
      fileEntries(loaded.session.filePath).some(
        (e) => e.type === 'message' && JSON.stringify(e).includes(WORKING_DIRECTORY_TAG),
      ),
    ).toBe(false);

    resumed.submit('second');
    await resumed.idle();
    resumed.submit('third');
    await resumed.idle();
    const [firstRequest, secondRequest, thirdRequest] = provider.requests;
    const updates = userTexts(thirdRequest).filter((t) => t.startsWith(WORKING_DIRECTORY_TAG));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain(`Working directory: ${rootRuntime.workspace.cwd}\n`);
    expect(userTexts(secondRequest).filter((t) => t.startsWith(WORKING_DIRECTORY_TAG))).toEqual(
      updates,
    );
    // The update travels in the prompt's own message, just before its text.
    expect(secondRequest?.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: updates[0] },
        { type: 'text', text: 'second' },
      ],
    });
    // The system prompt and the earlier history stay byte-identical.
    expect(secondRequest?.system).toBe(firstRequest?.system);
    expect(secondRequest?.messages.slice(0, firstRequest?.messages.length)).toEqual(
      firstRequest?.messages,
    );
    // The update is model context only: a later resume does not show it.
    const again = rootRuntime.resolveSession(subHandle.session.id);
    if (!again.ok) throw new Error(again.message);
    const replay = new AppController(rootRuntime, rootRuntime.openSession(again.session), {
      resumed: true,
    });
    cleanups.push(() => replay.session.close());
    const users = replay.getState().items.filter((i) => i.kind === 'user');
    expect(users.map((u) => u.kind === 'user' && u.text)).toEqual(['first', 'second', 'third']);
  });

  it('answers tool calls a stopped process left behind when resuming in another directory', async () => {
    const { controller, repo, home } = await setup([]);
    controller.session.close();
    const provider = new ScriptedProvider([textResponse('Continuing.'), textResponse('Again.')]);
    const subRuntime = await makeRuntime(join(repo, 'packages', 'web'), home, provider);
    const crashed = await subRuntime.newSession();
    crashed.session.append({
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'run the tests' }] },
    });
    // The process died while this call ran: nothing answered it.
    crashed.session.append({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'call_x', name: 'bash', input: { command: 'ls' } }],
      },
    });
    crashed.session.close();

    const rootRuntime = await makeRuntime(repo, home, provider);
    const loaded = rootRuntime.resolveSession(crashed.session.id);
    if (!loaded.ok) throw new Error(loaded.message);
    const resumed = new AppController(rootRuntime, rootRuntime.openSession(loaded.session), {
      resumed: true,
    });
    cleanups.push(() => resumed.session.close());
    resumed.submit('continue');
    await resumed.idle();
    resumed.submit('again');
    await resumed.idle();

    expect(provider.requests).toHaveLength(2);
    for (const request of provider.requests) expectToolCallsAnswered(request.messages);
    const [first, second] = provider.requests;
    const sent = first?.messages.at(-1);
    expect(sent?.role).toBe('user');
    expect(sent?.content.map((block) => (block.type === 'text' ? block.text : block.type))).toEqual(
      [expect.stringContaining(`Working directory: ${rootRuntime.workspace.cwd}\n`), 'continue'],
    );
    expect(userTexts(second).filter((t) => t.startsWith(WORKING_DIRECTORY_TAG))).toHaveLength(1);
  });

  it('sends the directory update after the automatic compaction that starts a turn', async () => {
    const { controller, repo, home } = await setup([]);
    controller.session.close();
    const provider = new ScriptedProvider([
      textResponse('First.'),
      textResponse('A summary of the work so far.'),
      textResponse('Second.'),
    ]);
    const subRuntime = await makeRuntime(join(repo, 'packages', 'web'), home, provider);
    const subHandle = await subRuntime.newSession();
    const sub = new AppController(subRuntime, subHandle);
    sub.submit('first');
    await sub.idle();
    // The conversation now fills most of the context window.
    subHandle.session.append({
      type: 'usage',
      model: subHandle.session.model,
      usage: { inputTokens: 190_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    subHandle.session.close();

    const rootRuntime = await makeRuntime(repo, home, provider);
    const loaded = rootRuntime.resolveSession(subHandle.session.id);
    if (!loaded.ok) throw new Error(loaded.message);
    const resumed = new AppController(rootRuntime, rootRuntime.openSession(loaded.session), {
      resumed: true,
    });
    cleanups.push(() => resumed.session.close());
    resumed.submit('second');
    await resumed.idle();

    expect(provider.requests.map((request) => request.purpose)).toEqual([
      'agent',
      'summary',
      'agent',
    ]);
    const afterCompaction = provider.requests[2];
    const updates = userTexts(afterCompaction).filter((t) => t.startsWith(WORKING_DIRECTORY_TAG));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain(`Working directory: ${rootRuntime.workspace.cwd}\n`);
    expect(userTexts(afterCompaction).at(-1)).toBe('second');
  });

  it('starts /clear sessions from instruction files and Git state as they are now', async () => {
    const { controller, repo, runtime } = await setup([textResponse('Wrote PATCH.md.')]);
    expect(runtime.workspace.instructions).toEqual([]);
    controller.submit('/init');
    await controller.idle();
    // What the /init turn would have written, plus a branch switch made meanwhile.
    writeFileSync(join(repo, 'PATCH.md'), '# demo\n\nMARKER_XYZZY: run tests with `npm test`.\n');
    execFileSync('git', ['checkout', '-q', '-b', 'feature/fresh'], { cwd: repo });
    controller.submit('/status');
    await controller.idle();
    expect(statusRow(controller, 'Instructions')).toMatchObject({
      value: 'none',
      detail: expect.stringContaining('/clear'),
    });

    controller.submit('/clear');
    await controller.idle();
    const session = controller.session;
    expect(session.meta.system).toContain('MARKER_XYZZY');
    expect(session.meta.branch).toBe('feature/fresh');
    const welcome = controller.getState().items[0];
    expect(welcome?.kind === 'welcome' && welcome.info).toMatchObject({
      branch: 'feature/fresh',
      instructionFiles: ['PATCH.md'],
      changedFiles: 1,
    });
    expect(controller.getState().footer.branch).toBe('feature/fresh');
    controller.submit('/status');
    await controller.idle();
    expect(statusRow(controller, 'Instructions')).toEqual({
      label: 'Instructions',
      value: 'PATCH.md',
    });
  });

  it('records an interrupted ! command only while the session is open', async () => {
    const { controller } = await setup([]);
    controller.submit('!node -e "setInterval(() => {}, 1000)"');
    await waitFor(() => controller.getState().liveTools.length > 0);
    controller.requestExit();
    controller.close();
    await controller.idle();
    expect(controller.session.entries().some((e) => e.type === 'shell')).toBe(false);
  });

  it('explains how to configure a missing API key instead of calling the model', async () => {
    const { controller, provider } = await setup([], { credentials: false });
    expect(controller.getState().items[1]).toMatchObject({ kind: 'notice', level: 'warn' });
    controller.submit('hello');
    await controller.idle();
    expect(provider.requests).toHaveLength(0);
    expect(controller.getState().items.at(-1)).toMatchObject({ kind: 'notice' });
  });
});

describe('AppController web tools', () => {
  const WEB_MODEL: Partial<ModelInfo> = { hostedTools: ['web_search', 'web_fetch'] };

  function toolRows(items: TranscriptItem[]) {
    return items.flatMap((item) =>
      item.kind === 'tool'
        ? [
            {
              verb: item.summary.verb,
              target: item.summary.target,
              status: item.status,
              outcome: item.display?.summary,
            },
          ]
        : [],
    );
  }

  it('shows web searches and fetches as tool rows, also after resuming', async () => {
    const { controller, provider } = await setup(
      [
        {
          hosted: [
            {
              id: 's1',
              kind: 'web_search',
              detail: 'vitest 4 release notes',
              summary: '8 results',
            },
            {
              id: 'f1',
              kind: 'web_fetch',
              detail: 'https://www.vitest.dev/blog/vitest-4',
              summary: 'page not accessible',
              isError: true,
            },
          ],
          text: 'Vitest 4 shipped (vitest.dev/blog/vitest-4).',
        },
      ],
      { modelInfo: WEB_MODEL },
    );
    expect(controller.session.meta.system).toContain('# Web');
    controller.submit('What is new in Vitest 4?');
    await controller.idle();
    const rows = [
      { verb: 'search', target: 'vitest 4 release notes', status: 'done', outcome: '8 results' },
      {
        verb: 'fetch',
        target: 'vitest.dev/blog/vitest-4',
        status: 'error',
        outcome: 'page not accessible',
      },
    ];
    expect(toolRows(controller.getState().items)).toEqual(rows);
    expect(kinds(controller.getState().items)).toEqual([
      'welcome',
      'user',
      'tool',
      'tool',
      'assistant',
    ]);
    expect(provider.requests[0]?.hostedTools).toEqual([
      { kind: 'web_search' },
      { kind: 'web_fetch' },
    ]);

    const first = controller.session.id;
    controller.submit('/clear');
    await controller.idle();
    controller.submit(`/resume ${first.slice(0, 8)}`);
    await controller.idle();
    expect(toolRows(controller.getState().items)).toEqual(rows);
  });

  it('keeps one row for a search that a paused response left running', async () => {
    const { controller, provider } = await setup(
      [
        { hosted: [{ id: 's1', kind: 'web_search', detail: 'q' }], stopReason: 'pause' },
        {
          hosted: [
            { id: 's1', kind: 'web_search', detail: 'q', summary: '2 results', continued: true },
          ],
          text: 'Found it.',
        },
      ],
      { modelInfo: WEB_MODEL },
    );
    controller.submit('Look it up.');
    await controller.idle();
    expect(provider.requests).toHaveLength(2);
    const rows = [{ verb: 'search', target: 'q', status: 'done', outcome: '2 results' }];
    expect(toolRows(controller.getState().items)).toEqual(rows);

    const first = controller.session.id;
    controller.submit('/clear');
    await controller.idle();
    controller.submit(`/resume ${first.slice(0, 8)}`);
    await controller.idle();
    expect(toolRows(controller.getState().items)).toEqual(rows);
  });

  it('marks a search that never finished as interrupted', async () => {
    const { controller } = await setup(
      [{ hosted: [{ id: 's1', kind: 'web_search', detail: 'q' }], text: 'Searching.' }],
      { modelInfo: WEB_MODEL },
    );
    controller.submit('Look it up.');
    await controller.idle();
    expect(toolRows(controller.getState().items)).toEqual([
      { verb: 'search', target: 'q', status: 'interrupted', outcome: undefined },
    ]);
  });

  it('reports web search and fetch in /status', async () => {
    const { controller } = await setup([], { modelInfo: WEB_MODEL });
    controller.submit('/status');
    await controller.idle();
    expect(statusRow(controller, 'Web')).toEqual({ label: 'Web', value: 'search, fetch' });
  });

  it('says why the web is off in /status', async () => {
    const unsupported = await setup([]);
    unsupported.controller.submit('/status');
    await unsupported.controller.idle();
    expect(statusRow(unsupported.controller, 'Web')).toEqual({
      label: 'Web',
      value: 'off',
      detail: `not available with ${unsupported.controller.sessionHandle.agent.model}`,
    });
  });

  it('turns web search and fetch off with PATCH_NO_WEB', async () => {
    const { controller, provider } = await setup([textResponse('Offline answer.')], {
      modelInfo: WEB_MODEL,
      env: { PATCH_NO_WEB: '1' },
    });
    expect(controller.session.meta.system).not.toContain('# Web');
    controller.submit('hello');
    await controller.idle();
    expect(provider.requests[0]).not.toHaveProperty('hostedTools');
    controller.submit('/status');
    await controller.idle();
    expect(statusRow(controller, 'Web')).toEqual({
      label: 'Web',
      value: 'off',
      detail: 'PATCH_NO_WEB is set',
    });
  });
});
