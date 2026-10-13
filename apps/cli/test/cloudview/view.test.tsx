import type { MessageBlock } from '@patch/cloud-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudApiError } from '../../src/cloud/client.js';
import { CloudViewController } from '../../src/cloudview/controller.js';
import { withColors } from '../ui/helpers.js';
import {
  FakeApi,
  FakeBackend,
  iso,
  message,
  project,
  task,
  type FakeBackendOptions,
} from './fakes.js';
import { KEY, mountView, type MountedView } from './screen.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

interface Ctx {
  view: MountedView;
  c: CloudViewController;
  api: FakeApi;
  backend: FakeBackend;
}

async function open(
  options: {
    backend?: FakeBackendOptions;
    columns?: number;
    rows?: number;
    splash?: boolean;
    resume?: { id: string };
    prepare?: (api: FakeApi) => void | Promise<void>;
    start?: boolean;
    copy?: (text: string) => Promise<boolean>;
  } = {},
): Promise<Ctx> {
  const api = new FakeApi();
  await options.prepare?.(api);
  const backend = new FakeBackend(api, options.backend);
  const c = new CloudViewController(backend, {
    pollMs: 3_600_000,
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.copy ? { copy: options.copy } : {}),
  });
  const view = mountView(c, {
    columns: options.columns ?? 80,
    rows: options.rows ?? 30,
    splash: options.splash ?? false,
  });
  cleanups.push(() => {
    c.close();
    view.unmount();
  });
  if (options.start !== false) {
    await c.start();
    await c.idle();
  }
  return { view, c, api, backend };
}

const proposal = (
  over: Partial<Extract<MessageBlock, { type: 'proposal' }>> = {},
): MessageBlock => ({
  type: 'proposal',
  projectId: 'prj_demo',
  projectName: 'Demo App',
  snapshotId: 'snp_1',
  prompt: 'Fix the failing tests',
  profile: 'auto',
  state: 'pending',
  ...over,
});

async function say(ctx: Ctx, text: string): Promise<void> {
  await ctx.view.type(text, KEY.enter);
  await ctx.c.idle();
}

describe('the start', () => {
  it('shows who and where in a dim header, and the prompt with the project in the footer', async () => {
    const { view } = await open({ backend: { linkedProject: 'prj_demo' } });
    const screen = await view.screen();
    expect(screen).toContain('Owner · cloud.test');
    // the worker and the project are said once, in the footer
    expect(screen).not.toContain('Owner · cloud.test · worker');
    expect(screen).toContain("What's happening with my projects?");
    expect(screen).toContain('/ for commands');
    expect(screen).toMatch(/Demo App · worker online\s*$/m);
  });

  it('says the worker is offline when it is', async () => {
    const { view } = await open({
      prepare: (api) => {
        api.workerOnline = false;
      },
    });
    expect(await view.screen()).toContain('worker offline');
  });

  it('asks to sign in first when there is no sign-in, with the address as a fallback', async () => {
    let release: () => void = () => undefined;
    const { view, c } = await open({
      start: false,
      backend: {
        signedIn: false,
        login: async (hooks) => {
          hooks.announce('http://127.0.0.1:3044/authorize?client_id=patch-cli&state=abc');
          await new Promise<void>((resolve) => (release = resolve));
          return new FakeApi();
        },
      },
    });
    void c.start();
    const screen = await view.waitFor('Waiting for you to approve');
    expect(screen).toContain('Sign in to Patch Cloud');
    expect(screen).toContain('If it does not, press c to copy the address.');
    // a short address, not the long one with its query (c copies the whole)
    expect(screen).toContain('http://127.0.0.1:3044/authorize…');
    expect(screen).not.toContain('client_id=patch-cli');
    expect(screen).toContain('c copies the full address');
    // the prompt is not offered while the browser step is open
    expect(screen).not.toContain('› ');
    release();
    await c.idle();
    await view.waitFor('worker online');
    expect(await view.screen()).not.toContain('Waiting for you to approve');
  });

  it('copies the sign-in address with c, since a wrapped address cannot be selected cleanly', async () => {
    const copied: string[] = [];
    const address = 'http://127.0.0.1:3044/authorize?client_id=patch-cli&state=abc';
    const { view, c } = await open({
      start: false,
      copy: async (text) => {
        copied.push(text);
        return true;
      },
      backend: {
        signedIn: false,
        login: async (hooks) => {
          hooks.announce(address);
          return new Promise(() => undefined);
        },
      },
    });
    void c.start();
    const before = await view.waitFor('Waiting for you to approve');
    expect(before).toContain('c copies the full address');
    await view.type('c');
    await view.waitFor('Address copied.');
    expect(copied).toEqual([address]);
  });

  it('shows a cancelled sign-in as a line and lets the user try again', async () => {
    const { view, c } = await open({
      start: false,
      backend: {
        signedIn: false,
        login: (hooks) =>
          new Promise((_, reject) =>
            hooks.signal.addEventListener('abort', () =>
              reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
            ),
          ),
      },
    });
    void c.start();
    await view.waitFor('Waiting for you to approve');
    await view.type(KEY.esc);
    const screen = await view.waitFor('Sign-in cancelled.');
    expect(screen).toContain('Type /login to try again');
  });

  it('does not crash when Patch Cloud cannot be reached while signing in', async () => {
    const { view } = await open({
      backend: {
        signedIn: false,
        login: async () => {
          throw new CloudApiError(
            'Cannot reach https://site.test. Check your connection.',
            0,
            'unreachable',
          );
        },
      },
    });
    const screen = await view.screen();
    expect(screen).toContain('Cannot reach https://site.test');
    expect(screen).toContain('signed out');
  });
});

describe('a conversation', () => {
  it('sends a message and shows the answer under it', async () => {
    const ctx = await open();
    await say(ctx, 'hello cloud');
    const screen = await ctx.view.waitFor('You said: hello cloud');
    expect(screen).toContain('› hello cloud');
    expect(screen).toContain('Reply to Patch');
  });

  it('keeps long answers readable in a narrow terminal', async () => {
    const ctx = await open({ columns: 60 });
    ctx.api.reply = () => [
      {
        type: 'text',
        text: 'This answer is deliberately long so that it has to wrap onto several lines in a terminal that is only sixty columns wide.',
      },
    ];
    await say(ctx, 'tell me something long');
    const screen = await ctx.view.waitFor('columns wide.');
    for (const line of screen.split('\n')) expect(line.length).toBeLessThanOrEqual(60);
    expect(screen).toContain('deliberately long so that it has to wrap');
  });

  it('draws a status answer as a labelled snapshot', async () => {
    const ctx = await open();
    ctx.api.reply = () => [
      {
        type: 'status',
        at: new Date(2026, 9, 13, 14, 5).toISOString(),
        workerOnline: true,
        sandbox: 'docker',
        queued: 1,
        running: 2,
        spentTodayUsd: 0.5,
        spentMonthUsd: 12.25,
        budgetBlocked: true,
      },
    ];
    await say(ctx, 'status');
    const screen = await ctx.view.waitFor('snapshot as of 14:05');
    expect(screen).toContain('Worker  online · sandbox docker');
    expect(screen).toContain('Runs    2 running · 1 queued');
    expect(screen).toContain('Spent   $0.50 today · $12.25 this month');
    expect(screen).toContain('A spending limit is reached, so queued runs are waiting.');
  });

  it('draws help examples and unsupported requests', async () => {
    const ctx = await open();
    ctx.api.reply = () => [
      { type: 'help', examples: ['Show my latest runs.', 'What failed recently?'] },
      {
        type: 'unsupported',
        what: 'Deleting a project is not something Patch Cloud does from chat.',
      },
    ];
    await say(ctx, 'delete everything');
    const screen = await ctx.view.waitFor('not available');
    expect(screen).toContain('› Show my latest runs.');
    expect(screen).toContain('Deleting a project is not something Patch Cloud does from chat.');
  });
});

describe('one card for a started run', () => {
  it('keeps exactly one live card, in the newest message, and leaves runs that are only listed', async () => {
    const ctx = await open({ backend: { linkedProject: 'prj_demo' } });
    const listed = task({
      id: 'tsk_listed00000000000000000',
      title: 'Listed only',
      status: 'running',
    });
    ctx.api.tasks.set(listed.id, listed);
    ctx.api.reply = (text) =>
      text.startsWith('show')
        ? [{ type: 'run', taskId: listed.id }]
        : [{ type: 'text', text: 'I can run this.' }, proposal()];
    await say(ctx, 'show runs');
    await ctx.view.waitFor('Listed only');
    await say(ctx, 'fix the failing tests');
    await ctx.view.waitFor('proposed run');
    await ctx.view.type(KEY.enter);
    await ctx.c.idle();
    const started = [...ctx.api.tasks.values()].find((t) => t.id !== listed.id)!;
    await ctx.view.waitFor('Fix the failing tests');
    // the task ends; the server appends its result message with the card
    const done = { ...started, status: 'succeeded' as const, finishedAt: new Date().toISOString() };
    ctx.api.tasks.set(started.id, done);
    const conversationId = ctx.c.getState().conversation!.id;
    (ctx.api.messages.get(conversationId) as unknown[]).push(
      message(
        'msg_result',
        'assistant',
        [
          { type: 'text', text: 'Finished: Fix the failing tests.' },
          { type: 'run', taskId: started.id },
        ],
        conversationId,
      ),
    );
    await ctx.c.tick();
    await ctx.c.idle();
    const screen = await ctx.view.waitFor('succeeded · Demo App');
    const transcript = await ctx.view.transcript();
    expect(transcript.match(/Fix the failing tests\n\s+succeeded/g)).toHaveLength(1);
    expect(transcript).not.toMatch(/queued · Demo App/);
    expect(screen).toContain('Listed only'); // a card in an answer that lists runs stays
    expect(transcript.match(/Listed only/g)).toHaveLength(1);
  });
});

describe('run cards', () => {
  withColors();

  async function runCard(over: Parameters<typeof task>[0]) {
    const ctx = await open();
    const t = task(over);
    ctx.api.tasks.set(t.id, t);
    ctx.api.reply = () => [{ type: 'run', taskId: t.id }];
    await say(ctx, 'show the run');
    await ctx.view.waitFor(t.title);
    return { ...ctx, t };
  }

  it('shows a running run live: status, project, duration and cost', async () => {
    const { view } = await runCard({ status: 'running', costUsd: 0.12 });
    const screen = await view.screen();
    expect(screen).toMatch(/Fix the failing tests/);
    expect(screen).toMatch(/running · Demo App · .*\$0\.12/);
    expect(screen).toContain('Working. Model step 3 so far.');
  });

  it('never styles a failure as success', async () => {
    const { view } = await runCard({
      status: 'failed',
      error: 'tests still fail',
      finishedAt: iso(-1000),
    });
    const screen = await view.waitFor('Failed. tests still fail');
    expect(screen).toContain('✗ Fix the failing tests');
    expect(screen).not.toContain('✓ Fix the failing tests');
    // red, not green
    const raw = view.stdout.output;
    expect(raw).toMatch(/\u001b\[31m✗/);
    expect(raw).not.toMatch(/\u001b\[32m✗/);
  });

  it('says an interrupted run did not finish and is not started again', async () => {
    const { view } = await runCard({ status: 'interrupted', finishedAt: iso(-1000) });
    const screen = await view.waitFor('Interrupted.');
    expect(screen).toContain('did not finish and is not started again');
    expect(screen).not.toContain('✓');
  });

  it('shows a cancelled run as cancelled, and success only for succeeded', async () => {
    const cancelled = await runCard({ status: 'cancelled', finishedAt: iso(-1000) });
    const screen = await cancelled.view.waitFor('Cancelled.');
    expect(screen).toContain('– Fix the failing tests');
    const ok = await runCard({ status: 'succeeded', finishedAt: iso(-1000) });
    const done = await ok.view.waitFor('Finished.');
    expect(done).toContain('✓ Fix the failing tests');
  });

  it('shows files changed only when the worker recorded them', async () => {
    const ctx = await open();
    const t = task({ status: 'succeeded', finishedAt: iso(-1000) });
    ctx.api.tasks.set(t.id, t);
    ctx.api.eventLog.set(t.id, [
      {
        seq: 1,
        taskId: t.id,
        projectId: null,
        ts: iso(),
        type: 'task.changes',
        level: 'info',
        data: { files: [{ path: 'a' }, { path: 'b' }, { path: 'c' }], fileCount: 3 },
      },
    ]);
    ctx.api.reply = () => [{ type: 'run', taskId: t.id }];
    await say(ctx, 'run');
    await ctx.view.waitFor('Finished. 3 files changed.');
  });

  it('leaves the files out when nothing was recorded', async () => {
    const { view } = await runCard({ status: 'succeeded', finishedAt: iso(-1000) });
    const screen = await view.waitFor('Finished.');
    expect(screen).not.toContain('changed');
  });
});

describe('proposals', () => {
  async function pending(over: Partial<Extract<MessageBlock, { type: 'proposal' }>> = {}) {
    const ctx = await open({ backend: { linkedProject: 'prj_demo' } });
    ctx.api.snapshots = [
      {
        id: 'snp_1',
        projectId: 'prj_demo',
        createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
        sizeBytes: 1,
        fileCount: 3,
        sha256: 'a'.repeat(64),
        baseCommit: null,
        branch: null,
        dirtyFiles: [],
      },
    ];
    ctx.api.reply = () => [
      { type: 'text', text: 'I can run this. Nothing starts until you confirm.' },
      proposal(over),
    ];
    await say(ctx, 'fix the failing tests');
    await ctx.view.waitFor('proposed run');
    return ctx;
  }

  it('shows the project, the snapshot age, the editable prompt and the keys', async () => {
    const { view } = await pending();
    const screen = await view.waitFor('files uploaded 12m ago');
    expect(screen).toContain('proposed run  Demo App');
    expect(screen).toContain('Fix the failing tests');
    expect(screen).toContain('permissions  auto');
    expect(screen).toContain('enter or y start · e edit · p permissions · n or esc dismiss');
    // the prompt stays available: the keys work only while it is empty
    expect(screen).toContain('Reply to Patch');
  });

  it('never hijacks a message that begins with y, n, p or e', async () => {
    const ctx = await pending();
    await ctx.view.type('yes, but ');
    let screen = await ctx.view.screen();
    expect(screen).toContain('› yes, but');
    expect(screen).not.toContain('enter or y start'); // the key hints show only for an empty prompt
    expect(ctx.api.tasks.size).toBe(0);
    await ctx.view.type('no problem', 'p', 'e');
    expect(await ctx.view.screen()).toContain('› yes, but no problempe');
    expect(ctx.c.getState().proposal).toMatchObject({
      profile: 'auto',
      editing: false,
      busy: null,
    });
    expect(ctx.api.tasks.size).toBe(0);
    // Esc clears the prompt; the keys and their hints are back
    await ctx.view.type(KEY.esc);
    screen = await ctx.view.waitFor('enter or y start');
    expect(screen).not.toContain('yes, but');
    await ctx.view.type('y');
    await ctx.c.idle();
    expect(ctx.api.tasks.size).toBe(1);
  });

  it('keeps Enter on an empty prompt as "start", and ignores other keys', async () => {
    const ctx = await pending();
    await ctx.view.type('x');
    expect(await ctx.view.screen()).toContain('› x');
    expect(ctx.api.tasks.size).toBe(0);
  });

  it('starts on Enter, and on y', async () => {
    for (const key of [KEY.enter, 'y']) {
      const ctx = await pending();
      await ctx.view.type(key);
      await ctx.c.idle();
      const screen = await ctx.view.waitFor('✓ Started');
      expect(ctx.api.tasks.size).toBe(1);
      expect(screen).toContain('Reply to Patch');
      cleanups.pop()?.();
    }
  });

  it('dismisses on n and on Esc, and nothing is started', async () => {
    for (const key of ['n', KEY.esc]) {
      const ctx = await pending();
      await ctx.view.type(key);
      await ctx.c.idle();
      await ctx.view.waitFor('Dismissed. Nothing was started.');
      expect(ctx.api.tasks.size).toBe(0);
      cleanups.pop()?.();
    }
  });

  it('cycles the permissions with p and sends the choice', async () => {
    const ctx = await pending();
    await ctx.view.type('p');
    expect(await ctx.view.waitFor('permissions  edits only')).toContain(
      'Edits files only. No commands.',
    );
    await ctx.view.type('p');
    expect(await ctx.view.waitFor('permissions  plan only')).toContain('Read-only research.');
    await ctx.view.type(KEY.enter);
    await ctx.c.idle();
    expect([...ctx.api.tasks.values()][0]?.profile).toBe('plan');
  });

  it('edits the prompt with e, then starts it', async () => {
    const ctx = await pending();
    await ctx.view.type('e');
    const screen = await ctx.view.waitFor('Edit the prompt below');
    expect(screen).toContain('› Fix the failing tests');
    await ctx.view.type(' and add one', KEY.enter);
    await ctx.view.waitFor('Fix the failing tests and add one');
    await ctx.view.type(KEY.enter);
    await ctx.c.idle();
    expect([...ctx.api.tasks.values()][0]?.prompt).toBe('Fix the failing tests and add one');
  });

  it('shows the refusal of the server verbatim', async () => {
    const ctx = await pending();
    const conversationId = ctx.c.getState().conversation!.id;
    const assistant = ctx.c
      .getState()
      .entries.find((e) => e.kind === 'message' && e.message.role === 'assistant');
    const refused = message(
      (assistant as { id: string }).id,
      'assistant',
      [
        { type: 'text', text: 'I can run this.' },
        proposal({
          state: 'failed',
          error: 'The daily spend limit of $5.00 is reached. Nothing was started.',
        }),
      ],
      conversationId,
    );
    ctx.api.confirmError = () =>
      new CloudApiError('The daily spend limit of $5.00 is reached.', 409, 'budget_blocked', {
        proposal: refused,
      });
    await ctx.view.type(KEY.enter);
    await ctx.c.idle();
    const screen = await ctx.view.waitFor(
      'The daily spend limit of $5.00 is reached. Nothing was started.',
    );
    expect(screen).toContain('✗');
    expect(ctx.api.tasks.size).toBe(0);
  });

  it('shows only the first lines of a very long prompt, so the screen is never overrun', async () => {
    const long = Array.from({ length: 20 }, (_, i) => `step ${i + 1}`).join('\n');
    const ctx = await open({ rows: 24 });
    ctx.api.reply = () => [proposal({ prompt: long })];
    await say(ctx, 'do all of it');
    const screen = await ctx.view.waitFor('more lines');
    expect(screen).toContain('step 1');
    expect(screen).toContain('step 8');
    expect(screen).not.toContain('step 9');
    expect(screen).toContain('… 12 more lines');
    expect(screen).toContain('enter or y start');
  });

  it('lets a slash command through without answering the proposal', async () => {
    const ctx = await pending();
    await ctx.view.type('/');
    await ctx.view.waitFor('/new');
    await ctx.view.type('help', KEY.enter);
    await ctx.c.idle();
    const screen = await ctx.view.waitFor('Anything that would change code becomes a proposal');
    expect(ctx.api.tasks.size).toBe(0);
    expect(screen).toContain('enter or y start');
  });
});

describe('wide and narrow terminals', () => {
  it('keeps the header on one line in a wide terminal', async () => {
    const ctx = await open({ columns: 200, rows: 24, backend: { linkedProject: 'prj_demo' } });
    const screen = await ctx.view.screen();
    expect(screen).toMatch(/^ {2}Owner · cloud.test$/m);
    expect(screen).toMatch(/Demo App · worker online$/m);
  });

  it('fits the prompt, footer and a picker in 60 columns', async () => {
    const ctx = await open({ columns: 60, rows: 20 });
    await ctx.view.type('/projects', KEY.enter);
    const screen = await ctx.view.waitFor('enter choose');
    expect(screen).toContain('Demo App');
    for (const line of screen.split('\n')) expect(line.length).toBeLessThanOrEqual(60);
  });
});

describe('pickers', () => {
  it('/projects shows a list; arrows move, Enter chooses, the footer shows the context', async () => {
    const ctx = await open({
      prepare: (api) => {
        api.projects = [project(), project({ id: 'prj_two', name: 'Second app', taskCount: 1 })];
      },
    });
    await ctx.view.type('/projects', KEY.enter);
    const screen = await ctx.view.waitFor('Projects');
    expect(screen).toContain('› Demo App');
    expect(screen).toContain('Second app');
    await ctx.view.type(KEY.down, KEY.enter);
    await ctx.c.idle();
    const after = await ctx.view.waitFor('Working in project Second app.');
    expect(after).toMatch(/Second app · worker online\s*$/m);
  });

  it('Esc closes a picker without choosing', async () => {
    const ctx = await open();
    await ctx.view.type('/projects', KEY.enter);
    await ctx.view.waitFor('enter choose · esc cancel');
    await ctx.view.type(KEY.esc);
    await ctx.c.idle();
    const screen = await ctx.view.screen();
    expect(screen).not.toContain('enter choose · esc cancel');
    expect(ctx.c.getState().project).toBeNull();
  });

  it('asks which project when the assistant needs one, and sends the same text again', async () => {
    const ctx = await open({
      prepare: (api) => {
        api.projects = [project(), project({ id: 'prj_two', name: 'Second app' })];
      },
    });
    ctx.api.reply = (_text, projectId) =>
      projectId
        ? [{ type: 'text', text: `Answer for ${projectId}` }]
        : [{ type: 'choose_project', reason: 'Which project is this about?' }];
    await say(ctx, 'what failed recently?');
    const screen = await ctx.view.waitFor('Which project?');
    expect(screen).toContain('Which project is this about?');
    await ctx.view.type(KEY.down, KEY.enter);
    await ctx.c.idle();
    await ctx.view.waitFor('Answer for prj_two');
    expect(ctx.api.log.filter((l) => l === 'sendMessage what failed recently?')).toHaveLength(2);
  });

  it('scrolls a long list in a short terminal', async () => {
    const ctx = await open({
      rows: 14,
      prepare: (api) => {
        api.projects = Array.from({ length: 25 }, (_, i) =>
          project({ id: `prj_${i}`, name: `Project ${String(i).padStart(2, '0')}` }),
        );
      },
    });
    await ctx.view.type('/projects', KEY.enter);
    const screen = await ctx.view.waitFor('more');
    expect(screen).toContain('Project 00');
    expect(screen).toMatch(/↓ \d+ more/);
  });
});

describe('problems', () => {
  it('keeps the conversation and shows a banner while Patch Cloud is unreachable', async () => {
    const ctx = await open();
    await say(ctx, 'hello');
    await ctx.view.waitFor('You said: hello');
    ctx.api.failures.push(new CloudApiError('Cannot reach Patch Cloud', 0, 'unreachable'));
    await say(ctx, 'are you there');
    const screen = await ctx.view.waitFor('Patch Cloud is unreachable.');
    expect(screen).toContain('Your conversation stays here.');
    expect(screen).toContain('You said: hello');
    expect(screen).toContain('are you there'); // back in the prompt
    expect(screen).toMatch(/offline\s*$/m);
  });

  it('asks for /login when the session expired and does not crash', async () => {
    const ctx = await open();
    await say(ctx, 'hello');
    ctx.api.failures.push(
      new CloudApiError('Patch Cloud rejected this sign-in.', 401, 'unauthenticated'),
    );
    await say(ctx, 'again');
    const screen = await ctx.view.waitFor('Your sign-in expired or was revoked. Type /login');
    expect(screen).toContain('› again'); // the message is back in the prompt
    expect(screen).not.toContain('✗');
  });

  it('shows a 429 as a readable line', async () => {
    const ctx = await open();
    await say(ctx, 'hello');
    ctx.api.failures.push(new CloudApiError('Too many requests.', 429, 'rate_limited'));
    await say(ctx, 'again');
    const screen = await ctx.view.waitFor('limiting requests right now (429)');
    expect(screen.replace(/\s+/g, ' ')).toContain('Wait a moment and try again.');
  });

  it('shows a 409 as the server wrote it', async () => {
    const ctx = await open();
    await say(ctx, 'hello');
    ctx.api.failures.push(new CloudApiError('This conversation is archived.', 409, 'conflict'));
    await say(ctx, 'again');
    await ctx.view.waitFor('This conversation is archived.');
  });
});

describe('keys', () => {
  it('Ctrl+C clears the prompt, then twice leaves', async () => {
    const ctx = await open();
    await ctx.view.type('half a thought', KEY.ctrlC);
    expect(await ctx.view.screen()).not.toContain('half a thought');
    await ctx.view.type(KEY.ctrlC);
    expect(await ctx.view.screen()).toContain('Press Ctrl+C again to exit');
    await ctx.view.type(KEY.ctrlC);
    await ctx.view.exited();
    expect(ctx.c.getState().exiting).toBe(true);
  });

  it('Shift+Enter (Alt+Enter) adds a line instead of sending', async () => {
    const ctx = await open();
    await ctx.view.type('one', KEY.shiftEnter, 'two');
    const screen = await ctx.view.screen();
    expect(screen).toContain('› one');
    expect(screen).toContain('two');
    expect(ctx.api.log).not.toContain('createConversation');
  });

  it('Up brings back the previous message', async () => {
    const ctx = await open();
    await say(ctx, 'first thing');
    await ctx.view.waitFor('You said: first thing');
    await ctx.view.type(KEY.up);
    expect(await ctx.view.screen()).toMatch(/› first thing/);
  });
});

describe('/push and runs', () => {
  it('/push shows the preview and uploads after y', async () => {
    const ctx = await open({ backend: { linkedProject: 'prj_demo' } });
    await ctx.view.type('/push', KEY.enter);
    const screen = await ctx.view.waitFor('y or enter uploads · n or esc cancels');
    expect(screen).toContain('Upload preview');
    expect(screen).toContain('.env');
    expect(screen.replace(/\s+/g, ' ')).toContain('Ignored files are never uploaded.');
    expect(ctx.api.uploads).toEqual([]);
    await ctx.view.type('y');
    await ctx.c.idle();
    await ctx.view.waitFor('Uploaded 2 files');
    expect(ctx.api.uploads).toHaveLength(1);
  });

  it('/push cancels on n and uploads nothing', async () => {
    const ctx = await open({ backend: { linkedProject: 'prj_demo' } });
    await ctx.view.type('/push', KEY.enter);
    await ctx.view.waitFor('y or enter uploads');
    await ctx.view.type('n');
    await ctx.view.waitFor('Cancelled. Nothing was uploaded.');
    expect(ctx.api.uploads).toEqual([]);
  });

  it('/runs lists runs with their status and opens one to follow its log', async () => {
    const ctx = await open();
    const a = task({
      id: 'tsk_runa00000000000000000000',
      title: 'Refactor store',
      status: 'running',
    });
    ctx.api.tasks.set(a.id, a);
    ctx.api.followScript = [{ type: 'agent.text', data: { text: 'Reading the store module' } }];
    ctx.api.followFinal = { ...a, status: 'succeeded' };
    ctx.api.tasks.set(a.id, a);
    await ctx.view.type('/runs', KEY.enter);
    const list = await ctx.view.waitFor('Recent runs');
    // the same turning mark as the cards, the title, and a status column
    expect(list).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Refactor store/);
    expect(list).toMatch(/running {5}· Demo App/);
    expect(list).toContain('Runs that are still going update here.');
    await ctx.view.type(KEY.enter);
    await ctx.c.idle();
    const screen = await ctx.view.waitFor('Reading the store module');
    expect(screen).toContain('Following Refactor store');
  });
});

describe('the start screen', () => {
  it('shows the logo above the prompt, and fades it out on the first message', async () => {
    const ctx = await open({ splash: true, rows: 30, backend: { linkedProject: 'prj_demo' } });
    await ctx.view.waitFor('Owner · cloud.test');
    await new Promise((resolve) => setTimeout(resolve, 1_700)); // the intro plays
    const intro = await ctx.view.screen();
    expect(intro).toMatch(/▄▄▄▄▄/);
    expect(intro).toContain("What's happening with my projects?");
    await ctx.view.type('hello', KEY.enter);
    await ctx.c.idle();
    await ctx.view.waitFor('You said: hello', 5_000);
    const after = await ctx.view.screen();
    expect(after).not.toMatch(/▄▄▄▄▄/);
    expect(after).toContain('› hello');
  });

  it('skips the intro when a conversation is opened', async () => {
    const api = new FakeApi();
    const conversation = await api.createConversation({ projectId: 'prj_demo' });
    await api.sendMessage(conversation.id, { text: 'earlier question' });
    const backend = new FakeBackend(api);
    const c = new CloudViewController(backend, {
      pollMs: 3_600_000,
      resume: { id: conversation.id },
    });
    const view = mountView(c, { columns: 80, rows: 30, splash: true });
    cleanups.push(() => {
      c.close();
      view.unmount();
    });
    await c.start();
    await c.idle();
    const screen = await view.waitFor('You said: earlier question');
    expect(screen).not.toMatch(/▄▄▄▄▄/);
    expect(screen).toContain('› earlier question');
  });
});
