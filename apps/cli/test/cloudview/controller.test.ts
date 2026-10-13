import type { MessageBlock } from '@patch/cloud-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudApiError } from '../../src/cloud/client.js';
import {
  CloudViewController,
  type CloudViewOptions,
  type CloudViewState,
} from '../../src/cloudview/controller.js';
import {
  FakeApi,
  FakeBackend,
  iso,
  message,
  project,
  task,
  type FakeBackendOptions,
} from './fakes.js';

const controllers: CloudViewController[] = [];
afterEach(() => {
  for (const c of controllers.splice(0)) c.close();
});

interface Setup {
  c: CloudViewController;
  api: FakeApi;
  backend: FakeBackend;
  clock: { now: number };
}

async function setup(
  options: {
    backend?: FakeBackendOptions;
    resume?: CloudViewOptions['resume'];
    prompt?: string;
    start?: boolean;
    api?: (api: FakeApi) => void;
  } = {},
): Promise<Setup> {
  const api = new FakeApi();
  options.api?.(api);
  const backend = new FakeBackend(api, options.backend);
  const clock = { now: Date.parse(iso()) };
  const c = new CloudViewController(backend, {
    pollMs: 3_600_000,
    now: () => clock.now,
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.prompt ? { initialPrompt: options.prompt } : {}),
  });
  controllers.push(c);
  if (options.start !== false) {
    await c.start();
    await c.idle();
  }
  return { c, api, backend, clock };
}

const texts = (s: CloudViewState): string[] =>
  s.entries.flatMap((e) =>
    e.kind === 'message'
      ? e.message.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : []))
      : e.kind === 'notice'
        ? [e.text]
        : [],
  );

const proposalBlock = (
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

describe('starting', () => {
  it('connects, reads who and where, and defaults to the project linked to the repository', async () => {
    const { c } = await setup({ backend: { linkedProject: 'prj_demo' } });
    const s = c.getState();
    expect(s.phase).toBe('ready');
    expect(s.booted).toBe(true);
    expect(s.account).toBe('Owner');
    expect(s.worker).toBe('online');
    expect(s.project).toEqual({ id: 'prj_demo', name: 'Demo App' });
    const header = s.entries[0];
    expect(header).toMatchObject({
      kind: 'header',
      account: 'Owner',
      worker: 'online',
      project: 'Demo App',
    });
    expect(c.isFresh()).toBe(true);
  });

  it('has no project when the repository is not linked', async () => {
    const { c } = await setup();
    expect(c.getState().project).toBeNull();
  });

  it('shows the worker as offline when the cloud says so', async () => {
    const { c } = await setup({ api: (api) => (api.workerOnline = false) });
    expect(c.getState().worker).toBe('offline');
  });

  it('signs in first when there is no sign-in, then continues', async () => {
    const hooks: string[] = [];
    const { c, backend } = await setup({
      backend: {
        signedIn: false,
        login: async (h) => {
          h.announce('https://site.test/authorize?x=1');
          hooks.push('announced');
          return new FakeApi();
        },
      },
      start: false,
    });
    expect(c.getState().phase).toBe('signed-out');
    const started = c.start();
    await started;
    await c.idle();
    expect(backend.loginCalls).toBe(1);
    expect(hooks).toEqual(['announced']);
    expect(c.getState().phase).toBe('ready');
    expect(c.getState().signIn.status).toBe('idle');
  });

  it('reports a failed or cancelled sign-in without leaving the view', async () => {
    const failing = await setup({
      backend: {
        signedIn: false,
        login: async () => {
          throw new CloudApiError('Timed out waiting for the browser sign-in.', 0, 'timeout');
        },
      },
    });
    expect(failing.c.getState().phase).toBe('signed-out');
    expect(failing.c.getState().signIn).toMatchObject({
      status: 'failed',
      message: 'Timed out waiting for the browser sign-in.',
    });

    const cancelled = await setup({
      backend: {
        signedIn: false,
        login: (hooks) =>
          new Promise((_, reject) => {
            hooks.signal.addEventListener('abort', () =>
              reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
            );
          }),
      },
      start: false,
    });
    const run = cancelled.c.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(cancelled.c.getState().signIn.status).toBe('waiting');
    expect(cancelled.c.handleCtrlC(false)).toBe('interrupted');
    await run;
    expect(cancelled.c.getState().signIn).toMatchObject({
      status: 'failed',
      message: 'Sign-in cancelled.',
    });
  });

  it('sends ptch "prompt" as the first message of a new conversation', async () => {
    const { c, api } = await setup({ prompt: 'what is running?' });
    expect(api.log).toContain('createConversation');
    expect(api.log).toContain('sendMessage what is running?');
    expect(texts(c.getState())).toContain('You said: what is running?');
    expect(c.isFresh()).toBe(false);
  });

  it('opens an earlier conversation with ptch --resume <id>, showing it as it was', async () => {
    const api = new FakeApi();
    const conversation = await api.createConversation({ projectId: 'prj_demo' });
    await api.sendMessage(conversation.id, { text: 'hello' });
    const backend = new FakeBackend(api);
    const c = new CloudViewController(backend, {
      pollMs: 3_600_000,
      resume: { id: conversation.id },
    });
    controllers.push(c);
    await c.start();
    await c.idle();
    const s = c.getState();
    expect(s.conversation?.id).toBe(conversation.id);
    expect(texts(s)).toEqual(['hello', 'You said: hello']);
    expect(s.project?.id).toBe('prj_demo');
    expect(c.isFresh()).toBe(false);
  });
});

describe('the conversation', () => {
  it('creates the conversation with the first message and keeps its id', async () => {
    const { c, api } = await setup({ backend: { linkedProject: 'prj_demo' } });
    await c.submit('hello there');
    await c.idle();
    const first = c.getState().conversation;
    expect(first?.id).toMatch(/^cnv_/);
    expect(api.log.filter((l) => l === 'createConversation')).toHaveLength(1);
    await c.submit('and again');
    await c.idle();
    expect(c.getState().conversation?.id).toBe(first?.id);
    expect(api.log.filter((l) => l === 'createConversation')).toHaveLength(1);
    expect(texts(c.getState())).toEqual([
      'hello there',
      'You said: hello there',
      'and again',
      'You said: and again',
    ]);
    expect(c.getState().history).toEqual(['and again', 'hello there']);
  });

  it('returns a message that could not be sent to the prompt, with a readable line', async () => {
    const { c, api } = await setup();
    api.failures.push(new CloudApiError('Slow down.', 429, 'rate_limited'));
    // createConversation is the first call that fails
    await c.submit('hello');
    const s = c.getState();
    expect(s.busy).toBeNull();
    expect(s.entries.some((e) => e.kind === 'pending-user')).toBe(false);
    const last = [...s.entries].reverse().find((e) => e.kind === 'notice');
    expect(last).toMatchObject({ level: 'error' });
    expect((last as { text: string }).text).toContain('429');
    expect(s.draft?.text).toBe('hello');
  });

  it('shows 409 conflicts as the server wrote them', async () => {
    const { c, api } = await setup();
    await c.submit('first');
    api.failures.push(
      new CloudApiError('This conversation is full (1000 messages).', 409, 'conflict'),
    );
    await c.submit('second');
    expect(texts(c.getState())).toContain('This conversation is full (1000 messages).');
  });

  it('/new starts over on a cleared screen', async () => {
    const { c } = await setup();
    await c.submit('hello');
    await c.idle();
    const token = c.getState().clearScreenToken;
    await c.submit('/new');
    const s = c.getState();
    expect(s.clearScreenToken).toBe(token + 1);
    expect(s.conversation).toBeNull();
    expect(c.isFresh()).toBe(true);
  });

  it('/resume lists the conversations of the account and opens the chosen one', async () => {
    const { c, api } = await setup();
    const a = await api.createConversation({ title: 'Older talk' });
    await api.sendMessage(a.id, { text: 'older' });
    const b = await api.createConversation({ title: 'Newer talk' });
    await api.sendMessage(b.id, { text: 'newer' });
    await c.submit('/resume');
    const picker = c.getState().picker;
    expect(picker?.kind).toBe('conversations');
    expect(picker?.options.map((o) => o.label)).toEqual(['Newer talk', 'Older talk']);
    const token = c.getState().clearScreenToken;
    await c.selectPicker(a.id);
    await c.idle();
    expect(c.getState().conversation?.id).toBe(a.id);
    expect(c.getState().clearScreenToken).toBe(token + 1);
    expect(texts(c.getState())).toContain('older');
  });

  it('/resume <prefix> opens by prefix and says so when it matches nothing', async () => {
    const { c, api } = await setup();
    const a = await api.createConversation({});
    await api.sendMessage(a.id, { text: 'hi' });
    await c.submit(`/resume ${a.id.slice(0, 8)}`);
    expect(c.getState().conversation?.id).toBe(a.id);
    await c.submit('/resume zzzz');
    expect(texts(c.getState()).at(-1)).toContain('No conversation starts with "zzzz"');
  });
});

describe('proposals', () => {
  async function withProposal(extra: Partial<Extract<MessageBlock, { type: 'proposal' }>> = {}) {
    const s = await setup({ backend: { linkedProject: 'prj_demo' } });
    s.api.reply = () => [
      { type: 'text', text: 'I can run this. Nothing starts until you confirm.' },
      proposalBlock(extra),
    ];
    await s.c.submit('fix the failing tests');
    await s.c.idle();
    return s;
  }

  it('takes the keyboard for a pending proposal and starts it only after confirm', async () => {
    const { c, api } = await withProposal();
    expect(c.getState().proposal).toMatchObject({
      prompt: 'Fix the failing tests',
      profile: 'auto',
    });
    expect(api.tasks.size).toBe(0);
    await c.startProposal();
    await c.idle();
    const s = c.getState();
    expect(api.tasks.size).toBe(1);
    expect(api.log.find((l) => l.startsWith('confirmProposal'))).toMatch(/\{\}$/);
    expect(s.proposal).toBeNull();
    const [started] = [...api.tasks.values()];
    expect(s.tasks[started!.id]?.status).toBe('queued');
    const messages = s.entries.filter((e) => e.kind === 'message');
    expect(messages.at(-1)).toMatchObject({ kind: 'message' });
    const blocks = messages.flatMap((e) => (e.kind === 'message' ? e.message.blocks : []));
    expect(blocks.some((b) => b.type === 'proposal' && b.state === 'confirmed')).toBe(true);
    expect(blocks.some((b) => b.type === 'run' && b.taskId === started!.id)).toBe(true);
  });

  it('sends the edited prompt and profile, and only what changed', async () => {
    const { c, api } = await withProposal();
    c.cycleProfile();
    expect(c.getState().proposal?.profile).toBe('edits');
    c.beginProposalEdit();
    expect(c.getState().draft?.text).toBe('Fix the failing tests');
    await c.submit('Fix the failing tests and add one');
    expect(c.getState().proposal).toMatchObject({
      editing: false,
      prompt: 'Fix the failing tests and add one',
    });
    await c.startProposal();
    const call = api.log.find((l) => l.startsWith('confirmProposal')) as string;
    expect(JSON.parse(call.slice(call.indexOf('{')))).toEqual({
      prompt: 'Fix the failing tests and add one',
      profile: 'edits',
    });
  });

  it('p cycles auto -> edits -> plan -> auto', async () => {
    const { c } = await withProposal();
    const seen = [c.getState().proposal?.profile];
    for (let i = 0; i < 3; i++) {
      c.cycleProfile();
      seen.push(c.getState().proposal?.profile);
    }
    expect(seen).toEqual(['auto', 'edits', 'plan', 'auto']);
  });

  it('dismisses without starting anything', async () => {
    const { c, api } = await withProposal();
    await c.dismissProposal();
    await c.idle();
    expect(api.tasks.size).toBe(0);
    expect(c.getState().proposal).toBeNull();
    const dismissed = c
      .getState()
      .entries.flatMap((e) => (e.kind === 'message' ? e.message.blocks : []))
      .some((b) => b.type === 'proposal' && b.state === 'dismissed');
    expect(dismissed).toBe(true);
  });

  it('shows the server refusal verbatim when confirm answers 409', async () => {
    const { c, api } = await withProposal();
    const failed = message(
      (
        c
          .getState()
          .entries.find((e) => e.kind === 'message' && e.message.role === 'assistant') as {
          id: string;
        }
      ).id,
      'assistant',
      [
        { type: 'text', text: 'I can run this.' },
        proposalBlock({
          state: 'failed',
          error: 'The daily spend limit of $5.00 is reached, so nothing was started.',
        }),
      ],
      c.getState().conversation!.id,
    );
    api.confirmError = () =>
      Object.assign(
        new CloudApiError('The daily spend limit of $5.00 is reached', 409, 'budget_blocked', {
          proposal: failed,
        }),
        {},
      );
    await c.startProposal();
    await c.idle();
    const blocks = c
      .getState()
      .entries.flatMap((e) => (e.kind === 'message' ? e.message.blocks : []));
    const proposal = blocks.find((b) => b.type === 'proposal');
    expect(proposal).toMatchObject({
      state: 'failed',
      error: 'The daily spend limit of $5.00 is reached, so nothing was started.',
    });
    expect(c.getState().proposal).toBeNull();
    expect(api.tasks.size).toBe(0);
  });

  it('keeps a proposal pending and shows the error when the refusal has no record', async () => {
    const { c, api } = await withProposal();
    api.confirmError = () => new CloudApiError('Something broke on the host.', 500, 'internal');
    await c.startProposal();
    expect(c.getState().proposal).toMatchObject({
      busy: null,
      error: 'Something broke on the host.',
    });
  });

  it('keeps the proposal pending while the user types a slash command', async () => {
    const { c, api } = await withProposal();
    c.parkProposal(true);
    expect(c.getState().proposal?.parked).toBe(true);
    await c.submit('/help');
    expect(c.getState().proposal?.parked).toBe(false);
    expect(api.tasks.size).toBe(0);
  });
});

describe('choosing a project', () => {
  it('opens a picker for choose_project and sends the same text again with the project', async () => {
    const { c, api } = await setup();
    api.projects = [project(), project({ id: 'prj_two', name: 'Second' })];
    await c.submit('hi'); // reset the stub reply below only for the next message
    api.reply = (text, projectId) =>
      projectId
        ? [{ type: 'text', text: `OK ${text} on ${projectId}` }]
        : [{ type: 'choose_project', reason: 'Which project is this about?' }];
    await c.submit('what failed recently?');
    await c.idle();
    const picker = c.getState().picker;
    expect(picker).toMatchObject({ kind: 'choose', title: 'Which project?' });
    expect(picker?.options.map((o) => o.label)).toEqual(['Demo App', 'Second']);
    await c.selectPicker('prj_two');
    await c.idle();
    expect(api.log).toContain('sendMessage what failed recently?');
    expect(api.log.filter((l) => l === 'sendMessage what failed recently?')).toHaveLength(2);
    expect(c.getState().project).toEqual({ id: 'prj_two', name: 'Second' });
    expect(texts(c.getState()).at(-1)).toBe('OK what failed recently? on prj_two');
  });

  it('esc leaves the question unanswered without asking again', async () => {
    const { c, api } = await setup();
    api.reply = () => [{ type: 'choose_project', reason: 'Which project?' }];
    await c.submit('what failed?');
    await c.idle();
    expect(c.getState().picker?.kind).toBe('choose');
    c.cancelPicker();
    expect(c.getState().picker).toBeNull();
    await c.tick();
    expect(c.getState().picker).toBeNull();
  });
});

describe('runs while the conversation is open', () => {
  async function withRun(status: 'running' | 'queued' = 'running') {
    const s = await setup();
    const t = task({ status });
    s.api.tasks.set(t.id, t);
    s.api.reply = () => [
      { type: 'text', text: 'Here is the run.' },
      { type: 'run', taskId: t.id },
    ];
    await s.c.submit('show my latest runs');
    await s.c.idle();
    return { ...s, t };
  }

  it('reads the tasks the conversation mentions and polls only the unfinished ones', async () => {
    const { c, api, t } = await withRun();
    expect(c.getState().tasks[t.id]?.status).toBe('running');
    api.log.length = 0;
    await c.tick();
    expect(api.log.filter((l) => l.startsWith('tasksByIds'))).toEqual([`tasksByIds ${t.id}`]);

    api.tasks.set(t.id, { ...t, status: 'succeeded', finishedAt: iso() });
    await c.tick();
    await c.idle();
    expect(c.getState().tasks[t.id]?.status).toBe('succeeded');
    api.log.length = 0;
    await c.tick();
    await c.tick();
    expect(api.log.filter((l) => l.startsWith('tasksByIds'))).toEqual([]);
  });

  it('appends the result message when the run ends', async () => {
    const { c, api, t } = await withRun();
    const conversationId = c.getState().conversation!.id;
    api.tasks.set(t.id, { ...t, status: 'failed', error: 'tests still fail', finishedAt: iso() });
    (api.messages.get(conversationId) as unknown[]).push(
      message(
        'msg_result',
        'assistant',
        [
          { type: 'text', text: 'Failed: Fix the failing tests.\nReason: tests still fail' },
          { type: 'run', taskId: t.id },
        ],
        conversationId,
      ),
    );
    await c.tick();
    await c.idle();
    expect(texts(c.getState())).toContain(
      'Failed: Fix the failing tests.\nReason: tests still fail',
    );
  });

  it('does not poll while the terminal is not focused', async () => {
    const { c, api } = await withRun();
    c.setFocused(false);
    api.log.length = 0;
    await c.tick();
    expect(api.log).toEqual([]);
    c.setFocused(true);
    await c.idle();
  });

  it('reads the changed files only when the worker recorded them', async () => {
    const s = await setup();
    const done = task({ id: 'tsk_done000000000000000000', status: 'succeeded', finishedAt: iso() });
    const quiet = task({
      id: 'tsk_quiet00000000000000000',
      status: 'succeeded',
      finishedAt: iso(),
    });
    s.api.tasks.set(done.id, done);
    s.api.tasks.set(quiet.id, quiet);
    s.api.eventLog.set(done.id, [
      {
        seq: 1,
        taskId: done.id,
        projectId: null,
        ts: iso(),
        type: 'task.changes',
        level: 'info',
        data: { files: [{ path: 'a' }, { path: 'b' }], fileCount: 2 },
      },
    ]);
    s.api.reply = () => [
      { type: 'run', taskId: done.id },
      { type: 'run', taskId: quiet.id },
    ];
    await s.c.submit('runs');
    await s.c.idle();
    expect(s.c.getState().facts[done.id]).toEqual({ filesChanged: 2 });
    expect(s.c.getState().facts[quiet.id]).toEqual({});
  });

  it('marks a run that no longer exists instead of failing', async () => {
    const s = await setup();
    s.api.reply = () => [{ type: 'run', taskId: 'tsk_gone0000000000000000000' }];
    await s.c.submit('runs');
    await s.c.idle();
    expect(s.c.getState().missing).toEqual(['tsk_gone0000000000000000000']);
  });
});

describe('connection problems', () => {
  it('keeps the view, retries by itself and recovers when the cloud is back', async () => {
    const { c, api, clock } = await setup();
    await c.submit('hello');
    await c.idle();
    api.failures.push(new CloudApiError('Cannot reach Patch Cloud', 0, 'unreachable'));
    await c.submit('are you there?');
    expect(c.getState().connection).toBe('offline');
    expect(c.getState().retryAt).toBeGreaterThan(clock.now);
    expect(c.getState().draft?.text).toBe('are you there?');

    // too early: no attempt
    api.log.length = 0;
    await c.tick();
    expect(api.log).toEqual([]);

    // the schedule passes and Patch Cloud answers
    clock.now += 4_000;
    await c.tick();
    await c.idle();
    expect(api.log).toContain('status');
    expect(c.getState().connection).toBe('ok');
    expect(c.getState().retryAt).toBeNull();
  });

  it('backs off while the cloud stays unreachable', async () => {
    const { c, api, clock } = await setup();
    await c.submit('hello');
    api.failures.push(new CloudApiError('down', 0, 'unreachable'));
    await c.submit('x');
    const first = c.getState().retryAt! - clock.now;
    api.failures.push(new CloudApiError('down', 0, 'unreachable'));
    clock.now += 10_000;
    await c.tick();
    const second = c.getState().retryAt! - clock.now;
    expect(second).toBeGreaterThan(first);
  });

  it('asks for /login when the sign-in expired, without crashing, and recovers after it', async () => {
    const { c, api, backend } = await setup();
    await c.submit('hello');
    api.failures.push(
      new CloudApiError(
        'Patch Cloud rejected this sign-in. Run: ptch login',
        401,
        'unauthenticated',
      ),
    );
    await c.submit('again');
    expect(c.getState().connection).toBe('expired');
    api.log.length = 0;
    await c.tick();
    expect(api.log).toEqual([]);
    await c.submit('another');
    expect(c.getState().hint).toContain('/login');
    expect(c.getState().draft?.text).toBe('another');

    await c.submit('/login');
    await c.idle();
    expect(backend.loginCalls).toBe(1);
    expect(c.getState().connection).toBe('ok');
    expect(c.getState().phase).toBe('ready');
  });
});

describe('a sign-in that Patch Cloud no longer accepts', () => {
  it('is noticed at the start, when the answer is "nobody" rather than an error', async () => {
    const { c } = await setup({ api: (api) => (api.meAuthenticated = false) });
    expect(c.getState().connection).toBe('expired');
    await c.submit('/whoami');
    expect(texts(c.getState()).at(-1)).toContain('not valid any more');
  });
});

describe('commands', () => {
  it('/projects lists the projects and a choice sets the context for the next message', async () => {
    const { c, api } = await setup({ backend: { linkedProject: 'prj_demo' } });
    api.projects = [project(), project({ id: 'prj_two', name: 'Second', taskCount: 1 })];
    await c.submit('/projects');
    const picker = c.getState().picker;
    expect(picker?.kind).toBe('projects');
    expect(picker?.options[0]?.hint).toContain('current');
    await c.selectPicker('prj_two');
    expect(c.getState().project).toEqual({ id: 'prj_two', name: 'Second' });
    await c.submit('hello');
    await c.idle();
    expect(c.getState().conversation?.projectId).toBe('prj_two');
  });

  it('/runs lists recent runs with their status and follows the one chosen', async () => {
    const { c, api } = await setup();
    const a = task({
      id: 'tsk_runa00000000000000000000',
      title: 'First',
      status: 'succeeded',
      finishedAt: iso(),
    });
    const b = task({ id: 'tsk_runb00000000000000000000', title: 'Second', status: 'running' });
    api.tasks.set(a.id, a);
    api.tasks.set(b.id, b);
    api.followScript = [
      { type: 'task.started', data: {} },
      { type: 'agent.text', data: { text: 'Looking at the tests' } },
    ];
    api.followFinal = { ...b, status: 'succeeded', finishedAt: iso() };
    await c.submit('/runs');
    const picker = c.getState().picker;
    expect(picker?.kind).toBe('runs');
    expect(picker?.options.map((o) => [o.mark, o.label])).toEqual([
      ['✓', 'First'],
      ['●', 'Second'],
    ]);
    expect(picker?.options[1]?.spinner).toBe(true); // a run that is going on turns
    expect(picker?.options[0]?.spinner).toBe(false);
    // the status is a column of one width
    expect(picker?.options[1]?.hint).toMatch(/^running {5}· /);
    expect(picker?.options[0]?.hint).toMatch(/^succeeded {3}· /);

    // the list refreshes with the runs
    api.tasks.set(b.id, { ...b, status: 'failed', error: 'boom', finishedAt: iso() });
    await c.tick();
    expect(c.getState().picker?.options[1]).toMatchObject({ mark: '✗', label: 'Second' });

    api.tasks.set(b.id, b);
    await c.selectPicker(b.id);
    const lines = c.getState().entries.filter((e) => e.kind === 'log');
    expect(lines.map((e) => (e as { text: string }).text)).toEqual([
      '· started',
      'Looking at the tests',
    ]);
    const end = c.getState().entries.find((e) => e.kind === 'run-end');
    expect(end).toBeTruthy();
    expect(c.getState().follow).toBeNull();
  });

  it('/run <prefix> follows by prefix; esc stops following and the run goes on', async () => {
    const { c, api } = await setup();
    const t = task({ id: 'tsk_abcdef0000000000000000000' });
    api.tasks.set(t.id, t);
    api.followHold = true;
    const following = c.submit('/run abcd');
    await new Promise((r) => setTimeout(r, 10));
    expect(c.getState().follow?.taskId).toBe(t.id);
    expect(c.handleCtrlC(false)).toBe('interrupted');
    await following;
    expect(c.getState().follow).toBeNull();
    expect(texts(c.getState()).some((x) => x.includes('Stopped following'))).toBe(true);
  });

  it('/brain lists the entries of the project, opens one and offers its links', async () => {
    const { c, api } = await setup({ backend: { linkedProject: 'prj_demo' } });
    api.brain = {
      nodes: [
        {
          id: 'bre_1',
          projectId: 'prj_demo',
          kind: 'decision',
          title: 'Use WAL',
          excerpt: '',
          tags: [],
          source: 'user',
          sourceTaskId: null,
          createdAt: iso(),
          updatedAt: iso(),
          archived: false,
          degree: 1,
        },
      ],
      links: [],
      truncated: false,
      projects: [],
      counts: { knowledge: 0, decision: 1, note: 0, change: 0 },
    };
    const entry = api.brain.nodes[0]!;
    api.brainDetails.set('bre_1', {
      entry: { ...entry, body: 'SQLite runs in WAL mode.' },
      projectName: 'Demo App',
      links: [
        {
          link: {
            id: 'lnk_1',
            projectId: 'prj_demo',
            from: 'bre_1',
            to: 'bre_2',
            type: 'affects',
            origin: 'user',
            confirmed: true,
            evidence: [],
            createdAt: iso(),
          },
          direction: 'out',
          other: { id: 'bre_2', title: 'Backups', kind: 'knowledge', archived: false },
        },
      ],
      sourceTask: null,
    });
    await c.submit('/brain');
    const picker = c.getState().picker;
    expect(picker?.options).toEqual([
      expect.objectContaining({
        value: 'bre_1',
        label: 'decision  Use WAL',
        hint: expect.stringContaining('1 link'),
      }),
    ]);
    await c.selectPicker('bre_1');
    const doc = c.getState().entries.find((e) => e.kind === 'brain-entry');
    expect(doc).toMatchObject({ title: 'Use WAL', body: 'SQLite runs in WAL mode.' });
    expect((doc as { links: string[] }).links[0]).toContain('affects  Backups');
    expect(c.getState().picker?.kind).toBe('brain-links');
  });

  it('/brain asks for a project first', async () => {
    const { c } = await setup();
    await c.submit('/brain');
    expect(texts(c.getState()).at(-1)).toContain('Choose a project first');
  });

  it('/push shows what would be uploaded, asks, and uploads only after yes', async () => {
    const { c, api, backend } = await setup({ backend: { linkedProject: 'prj_demo' } });
    await c.submit('/push');
    const doc = c.getState().entries.find((e) => e.kind === 'doc');
    const lines = (doc as { lines: string[] }).lines.join('\n');
    expect(lines).toContain('2 files');
    expect(lines).toContain('.env');
    expect(lines).toContain('looks like a secret');
    expect(c.getState().push?.question).toContain('Upload 2 files to Demo App');
    expect(api.uploads).toEqual([]);

    c.cancelPush();
    expect(api.uploads).toEqual([]);
    expect(c.getState().push).toBeNull();

    await c.submit('/push');
    await c.confirmPush();
    expect(api.uploads).toEqual([{ projectId: 'prj_demo', fileCount: 2 }]);
    expect(backend.linked).toEqual([['/repo', 'prj_demo']]);
    expect(texts(c.getState()).at(-1)).toContain('Uploaded 2 files');
  });

  it('/push creates the project when there is none for this repository', async () => {
    const { c, api } = await setup();
    api.projects = [];
    await c.submit('/push');
    expect(c.getState().push?.question).toContain('repo');
    await c.confirmPush();
    expect(api.log.some((l) => l.startsWith('createProject'))).toBe(true);
    expect(api.uploads).toHaveLength(1);
  });

  it('/whoami, /help and unknown commands answer in the log', async () => {
    const { c } = await setup();
    await c.submit('/whoami');
    await c.submit('/help');
    await c.submit('/nope');
    const docs = c.getState().entries.filter((e) => e.kind === 'doc') as Array<{ lines: string[] }>;
    expect(docs[0]?.lines[0]).toBe('Signed in as Owner on https://cloud.test');
    expect(docs[1]?.lines.join('\n')).toContain('/projects');
    expect(texts(c.getState()).at(-1)).toBe('Unknown command /nope. Type /help for the list.');
  });

  it('/logout signs out and /login signs back in', async () => {
    const { c, backend } = await setup();
    await c.submit('/logout');
    expect(backend.logoutCalls).toBe(1);
    expect(c.getState().phase).toBe('signed-out');
    await c.submit('hello');
    expect(texts(c.getState()).at(-1)).toContain('/login');
    await c.submit('/login');
    await c.idle();
    expect(c.getState().phase).toBe('ready');
  });

  it('/quit exits', async () => {
    const { c } = await setup();
    await c.submit('/quit');
    expect(c.getState().exiting).toBe(true);
  });
});

describe('ctrl+c', () => {
  it('clears a prompt, then arms the exit, then exits on the second press', async () => {
    const { c, clock } = await setup();
    expect(c.handleCtrlC(true)).toBe('clear-prompt');
    expect(c.handleCtrlC(false)).toBe('armed');
    expect(c.getState().exitArmedAt).not.toBeNull();
    clock.now += 500;
    expect(c.handleCtrlC(false)).toBe('exit');
    expect(c.getState().exiting).toBe(true);
  });

  it('does not exit when the second press comes late', async () => {
    const { c, clock } = await setup();
    c.handleCtrlC(false);
    clock.now += 5_000;
    expect(c.handleCtrlC(false)).toBe('armed');
  });

  it('cancels an open picker first', async () => {
    const { c, api } = await setup();
    api.tasks.set('tsk_x', task({ id: 'tsk_x' }));
    await c.submit('/runs');
    expect(c.getState().picker).not.toBeNull();
    expect(c.handleCtrlC(false)).toBe('interrupted');
    expect(c.getState().picker).toBeNull();
  });
});
