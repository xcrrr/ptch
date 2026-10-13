import type { BrainEntryDetail, MessageBlock } from '@patch/cloud-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudApiError } from '../../src/cloud/client.js';
import { CloudViewController } from '../../src/cloudview/controller.js';
import { FakeApi, FakeBackend, message, project, task } from './fakes.js';
import { KEY, mountView, type MountedView } from './screen.js';

/** Every kind of thing Patch Cloud could put into a field to act on the terminal. */
const OSC52 = '\u001b]52;c;RVZJTENMSVA=\u0007';
const OSC0 = '\u001b]0;EVILTITLE\u001b\\';
const DCS = '\u001bP1$rEVILDCS\u001b\\';
const APC = '\u001b_EVILAPC\u001b\\';
const PM = '\u001b^EVILPM\u001b\\';
const SOS = '\u001bXEVILSOS\u001b\\';
const MOVE = '\u001b[2;777H\u001b[777X\u001b[?1049h\u001bc';
const C1 = '\u009b777X\u009dEVILC1\u009c\u0085';
const BIDI = String.fromCharCode(0x202e, 0x202a, 0x2066, 0x2067, 0x2069, 0x200f, 0x061c);
const HOSTILE = `${OSC52}${OSC0}${DCS}${APC}${PM}${SOS}${MOVE}${C1}${BIDI}\u0007\rEVILCR`;
const evil = (label: string): string => `${label}${HOSTILE}`;

/** What must never reach the output: Ink writes none of it itself. */
const BAD: Array<[string, RegExp]> = [
  ['an OSC sequence', /\u001b\]/],
  ['a DCS sequence', /\u001bP/],
  ['an APC sequence', /\u001b_/],
  ['a PM sequence', /\u001b\^/],
  ['a SOS sequence', /\u001bX/],
  ['a full reset', /\u001bc/],
  ['an alternate screen switch', /\u001b\[\?1049/],
  ['a cursor move from the data', /\u001b\[2;777H/],
  ['an erase from the data', /\u001b\[777X/],
  ['a C1 control', /[\u0080-\u009f]/],
  ['a bidi control', new RegExp('[\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]')],
  ['a bell', /\u0007/],
];

function leaks(output: string): string[] {
  return BAD.filter(([, pattern]) => pattern.test(output)).map(([name]) => name);
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const proposal = (): MessageBlock => ({
  type: 'proposal',
  projectId: 'prj_demo',
  projectName: evil('project'),
  snapshotId: 'snp_1',
  prompt: evil('prompt'),
  profile: 'auto',
  state: 'pending',
});

/** A conversation whose every field is hostile, and a Patch Cloud that keeps being hostile. */
function hostileApi(): FakeApi {
  const api = new FakeApi();
  api.projects = [
    project({
      name: evil('name'),
      slug: evil('slug'),
      description: evil('description'),
      gitRemote: evil('remote'),
      lastTaskAt: evil('last'),
      createdAt: evil('created'),
    }),
  ];
  api.me = async () => ({
    authenticated: true,
    kind: 'oauth' as const,
    version: evil('version'),
    account: { id: 'a', name: evil('Owner') },
    client: { id: 'c', name: evil('client'), device: evil('device') },
  });
  const run = task({
    id: 'tsk_run0000000000000000000',
    title: evil('title'),
    prompt: evil('prompt'),
    status: 'failed',
    error: evil('error'),
    resultSummary: evil('summary'),
    createdAt: evil('created'),
    startedAt: evil('started'),
    finishedAt: evil('finished'),
    model: evil('model'),
  });
  const odd = task({
    id: 'tsk_odd00000000000000000000',
    title: evil('odd status'),
    status: evil('exploding') as never,
    costUsd: evil('cost') as never,
  });
  api.tasks.set(run.id, run);
  api.tasks.set(odd.id, odd);
  api.eventLog.set(run.id, [
    {
      seq: 1,
      taskId: run.id,
      projectId: null,
      ts: evil('ts'),
      type: 'task.changes',
      level: 'info',
      data: { files: [{ path: evil('file') }], fileCount: 1 },
    },
  ]);
  api.followScript = [
    { type: 'agent.text', data: { text: evil('said') } },
    { type: 'task.output', data: { stream: 'stderr', text: evil('stderr') } },
    { type: 'agent.tool_end', data: { verb: evil('v'), target: evil('t'), summary: evil('s') } },
    { type: 'task.finished', data: { to: evil('to'), error: evil('why') } },
  ];
  api.followFinal = run;
  api.snapshots = [
    {
      id: 'snp_1',
      projectId: 'prj_demo',
      createdAt: evil('snapshot'),
      sizeBytes: 1,
      fileCount: 1,
      sha256: 'a',
      baseCommit: evil('c'),
      branch: evil('b'),
      dirtyFiles: [],
    },
  ];
  const node = {
    id: 'bre_1',
    projectId: 'prj_demo',
    kind: 'decision' as const,
    title: evil('entry title'),
    excerpt: evil('excerpt'),
    tags: [evil('tag')],
    source: 'user' as const,
    sourceTaskId: null,
    createdAt: evil('c'),
    updatedAt: evil('u'),
    archived: false,
    degree: 1,
  };
  api.brain = {
    nodes: [node],
    links: [],
    truncated: false,
    projects: [{ id: 'prj_demo', name: evil('p'), entryCount: 1 }],
    counts: { knowledge: 0, decision: 1, note: 0, change: 0 },
  };
  const detail: BrainEntryDetail = {
    entry: { ...node, body: evil('body # heading\n\n```\n') },
    projectName: evil('project'),
    links: [
      {
        link: {
          id: 'lnk_1',
          projectId: 'prj_demo',
          from: 'bre_1',
          to: 'bre_2',
          type: 'affects',
          origin: 'derived',
          confirmed: true,
          evidence: [evil('evidence')],
          createdAt: evil('l'),
        },
        direction: 'out',
        other: { id: 'bre_2', title: evil('other'), kind: 'knowledge', archived: false },
      },
    ],
    sourceTask: {
      id: 't',
      title: evil('source'),
      status: evil('status'),
      finishedAt: evil('f'),
      costUsd: 1,
      changedFiles: [evil('changed')],
    },
  };
  api.brainDetails.set('bre_1', detail);
  api.reply = () => [
    { type: 'text', text: evil('answer **bold** `code`') },
    {
      type: 'status',
      at: evil('not a date'),
      workerOnline: true,
      sandbox: evil('sandbox'),
      queued: evil('1') as never,
      running: 2,
      spentTodayUsd: evil('0.5') as never,
      spentMonthUsd: 1,
      budgetBlocked: false,
    },
    { type: 'run', taskId: run.id },
    { type: 'run', taskId: odd.id },
    { type: 'help', examples: [evil('example')] },
    { type: 'unsupported', what: evil('what') },
    proposal(),
  ];
  return api;
}

async function open(): Promise<{ view: MountedView; c: CloudViewController; api: FakeApi }> {
  const api = hostileApi();
  const c = new CloudViewController(new FakeBackend(api, { linkedProject: 'prj_demo' }), {
    pollMs: 3_600_000,
  });
  const view = mountView(c, { columns: 100, rows: 40 });
  cleanups.push(() => {
    c.close();
    view.unmount();
  });
  await c.start();
  await c.idle();
  return { view, c, api };
}

describe('the cloud view with hostile data in every field', () => {
  it('shows a conversation, its blocks, run cards and proposal without any control sequence', async () => {
    const { view, c, api } = await open();
    await view.type('hello', KEY.enter);
    await c.idle();
    const screen = await view.waitFor('proposed run');
    // the readable text is still there, with the hostile parts removed
    expect(screen).toContain('Worker  online · sandbox sandbox');
    expect(screen).toContain('prompt');
    expect(screen).toContain('exploding'); // an unknown status is said as it is
    expect(screen).not.toContain('EVILTITLE');
    expect(screen).not.toContain('EVILCLIP');
    // answers, run cards, a failed refusal and the other blocks, too
    api.confirmError = () =>
      new CloudApiError(evil('refused'), 409, evil('code'), {
        proposal: message('x', 'assistant', [
          {
            ...(proposal() as Record<string, unknown>),
            state: 'failed',
            error: evil('reason'),
          } as never,
        ]),
      });
    await view.type(KEY.enter);
    await c.idle();
    expect(leaks(view.stdout.output)).toEqual([]);
  });

  it('shows pickers, the Brain, a followed run and errors without any control sequence', async () => {
    const { view, c, api } = await open();
    await view.type('hello', KEY.enter);
    await c.idle();
    await view.waitFor('proposed run');
    await view.type(KEY.esc); // dismiss the proposal
    await c.idle();

    for (const command of ['/whoami', '/help', '/projects', '/runs']) {
      await view.type(command, KEY.enter);
      await c.idle();
      await view.type(KEY.esc);
    }
    // open a run from the list and follow its hostile log
    await view.type('/runs', KEY.enter);
    await c.idle();
    await view.type(KEY.enter);
    await c.idle();

    await view.type('/brain', KEY.enter);
    await c.idle();
    await view.type(KEY.enter);
    await c.idle();
    await view.type(KEY.esc);

    await view.type('/resume', KEY.enter);
    await c.idle();
    await view.type(KEY.esc);

    for (const failure of [
      new CloudApiError(evil('unreachable'), 0, 'unreachable'),
      new CloudApiError(evil('rate limited'), 429, evil('rate_limited')),
      new CloudApiError(evil('conflict'), 409, 'conflict'),
      new CloudApiError(evil('server'), 500, 'internal'),
    ]) {
      api.failures.push(failure);
      await view.type('again', KEY.enter);
      await c.idle();
      await view.type(KEY.ctrlC);
    }
    await view.screen();
    expect(leaks(view.stdout.output)).toEqual([]);
    // it did go through all of that: the Brain entry was opened and read
    expect(await view.transcript()).toContain('entry title');
  });

  it('shows the sign-in and a failed sign-in without any control sequence', async () => {
    const api = hostileApi();
    const c = new CloudViewController(
      new FakeBackend(api, {
        signedIn: false,
        login: async (hooks) => {
          hooks.announce(`http://127.0.0.1:1/authorize?state=${encodeURIComponent(HOSTILE)}`);
          throw new CloudApiError(evil('sign-in failed'), 0, 'error');
        },
      }),
      { pollMs: 3_600_000 },
    );
    const view = mountView(c, { columns: 100, rows: 30 });
    cleanups.push(() => {
      c.close();
      view.unmount();
    });
    await c.start();
    await c.idle();
    await view.waitFor('sign-in failed');
    expect(leaks(view.stdout.output)).toEqual([]);
  });

  it('does not crash on messages of a shape it does not know', async () => {
    const { view, c, api } = await open();
    api.reply = () =>
      [
        { type: evil('hologram') },
        { type: 'run', taskId: evil('tsk') },
        null,
      ] as unknown as MessageBlock[];
    await view.type('hello', KEY.enter);
    await c.idle();
    await view.screen();
    expect(leaks(view.stdout.output)).toEqual([]);
  });
});
