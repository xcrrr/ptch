import type { MessageBlock } from '@patch/cloud-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudViewController } from '../../src/cloudview/controller.js';
import { trimRunProse } from '../../src/cloudview/model.js';
import { withColors } from '../ui/helpers.js';
import { FakeApi, FakeBackend, iso, task } from './fakes.js';
import { KEY, mountView, type MountedView } from './screen.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

interface Ctx {
  view: MountedView;
  c: CloudViewController;
  api: FakeApi;
}

async function open(
  options: { columns?: number; rows?: number; prepare?: (api: FakeApi) => void } = {},
): Promise<Ctx> {
  const api = new FakeApi();
  options.prepare?.(api);
  const c = new CloudViewController(new FakeBackend(api, { linkedProject: 'prj_demo' }), {
    pollMs: 3_600_000,
  });
  const view = mountView(c, { columns: options.columns ?? 100, rows: options.rows ?? 40 });
  cleanups.push(() => {
    c.close();
    view.unmount();
  });
  await c.start();
  await c.idle();
  return { view, c, api };
}

async function say(ctx: Ctx, text: string): Promise<void> {
  await ctx.view.type(text, KEY.enter);
  await ctx.c.idle();
}

const proposal = (): MessageBlock => ({
  type: 'proposal',
  projectId: 'prj_demo',
  projectName: 'Demo App',
  snapshotId: 'snp_1',
  prompt: 'Fix the failing tests',
  profile: 'auto',
  state: 'pending',
});

const LEAD = 'I can run this on Demo App (snapshot from 1 min ago) with the "auto" profile.';

function proposalReply(api: FakeApi): void {
  api.snapshots = [
    {
      id: 'snp_1',
      projectId: 'prj_demo',
      createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
      sizeBytes: 1,
      fileCount: 1,
      sha256: 'a'.repeat(64),
      baseCommit: null,
      branch: null,
      dirtyFiles: [],
    },
  ];
  api.reply = () => [
    { type: 'text', text: `${LEAD} Nothing starts until you confirm.` },
    proposal(),
  ];
}

describe('a proposal says each thing once, and what is true now', () => {
  it('has no stale sentence about the profile or a second age of the snapshot', async () => {
    const ctx = await open({ prepare: proposalReply });
    await say(ctx, 'fix the failing tests');
    let screen = await ctx.view.waitFor('files uploaded 12m ago');
    expect(screen).not.toContain('with the "auto" profile');
    expect(screen).not.toContain('snapshot from');
    expect(screen).toContain('permissions  auto');
    expect(screen.match(/Nothing starts until you confirm\./g)).toHaveLength(1);
    // p changes the permissions; nothing on the screen still says "auto"
    await ctx.view.type('p');
    screen = await ctx.view.waitFor('permissions  edits only');
    expect(screen).not.toMatch(/auto/);
    expect(screen.match(/files uploaded/g)).toHaveLength(1);
  });

  it('collapses a started proposal into one line, and the card is the only status', async () => {
    const ctx = await open({ prepare: proposalReply });
    await say(ctx, 'fix the failing tests');
    await ctx.view.waitFor('proposed run');
    await ctx.view.type(KEY.enter);
    await ctx.c.idle();
    const screen = await ctx.view.waitFor('✓ Started · Fix the failing tests');
    expect(screen).not.toContain('Started: Fix');
    expect(screen).not.toContain('It is queued');
    expect(screen).not.toContain('I will report the result');
    // the run card follows, once
    expect(screen.match(/queued · Demo App/g)).toHaveLength(1);
  });

  it('shows no "queued" words above a running card', async () => {
    const ctx = await open({ prepare: proposalReply });
    await say(ctx, 'fix the failing tests');
    await ctx.view.waitFor('proposed run');
    await ctx.view.type(KEY.enter);
    await ctx.c.idle();
    const [started] = [...ctx.api.tasks.values()];
    ctx.api.tasks.set(started!.id, { ...started!, status: 'running', startedAt: iso(-3000) });
    await ctx.c.tick();
    await ctx.c.idle();
    const screen = await ctx.view.waitFor('running · Demo App');
    expect(screen).not.toMatch(/queued/);
  });

  it('keeps what the agent said, and drops the facts the card already shows', async () => {
    const ctx = await open();
    const t = task({ status: 'succeeded', finishedAt: iso(-1000) });
    ctx.api.tasks.set(t.id, t);
    ctx.api.reply = () => [
      {
        type: 'text',
        text: 'Finished: Fix the failing tests.\nThe agent took 8s, cost $0.18, changed 2 files.\n\nFixed isExpired: it used > instead of >=.',
      },
      { type: 'run', taskId: t.id },
    ];
    await say(ctx, 'result');
    const screen = await ctx.view.waitFor('Fixed isExpired');
    expect(screen).not.toContain('The agent took');
    expect(screen).not.toContain('Finished: Fix');
    expect(screen).toContain('succeeded · Demo App');
  });
});

describe('trimRunProse', () => {
  it('drops the report facts of every outcome and keeps the rest', () => {
    expect(
      trimRunProse(
        'Started: X\nIt is queued and the worker will pick it up. I will report the result here when it ends.',
      ),
    ).toBe('');
    expect(trimRunProse('Finished: X.\nThe agent took 1s, cost $0.01.\n\nThe answer.')).toBe(
      'The answer.',
    );
    expect(
      trimRunProse(
        'Failed: X.\nIt took 1s before it stopped.\n\nReason: boom\n\nLast output: partial',
      ),
    ).toBe('Last output: partial');
    expect(
      trimRunProse(
        'Interrupted: X. This did not complete.\nIt took 1s.\n\nThe worker stopped.\nInterrupted tasks are never run again automatically; open the run to retry it.',
      ),
    ).toBe('');
    expect(
      trimRunProse('Cancelled: X. This did not complete.\nIt was cancelled before it started.'),
    ).toBe('');
    expect(trimRunProse('Just words.')).toBe('Just words.');
  });
});

describe('the status answer', () => {
  it('is the card only, and names the version of Patch Cloud', async () => {
    const ctx = await open();
    ctx.api.reply = () => [
      {
        type: 'text',
        text: 'Patch Cloud is reachable.\nThe worker is online (sandbox: x), version 0.4.0.',
      },
      {
        type: 'status',
        at: new Date(2026, 9, 13, 14, 5).toISOString(),
        workerOnline: true,
        sandbox: 'docker',
        queued: 0,
        running: 1,
        spentTodayUsd: 0,
        spentMonthUsd: 0,
        budgetBlocked: false,
      },
    ];
    await say(ctx, 'is the worker online?');
    const screen = await ctx.view.waitFor('snapshot as of 14:05');
    expect(screen).toContain('Patch Cloud 0.4.0 · snapshot as of 14:05');
    expect(screen).not.toContain('Patch Cloud is reachable.');
    expect(screen).not.toContain('(sandbox');
  });
});

describe('the worker and the project are said once', () => {
  it('only in the footer, close to the hint on a wide terminal', async () => {
    const ctx = await open({ columns: 200, rows: 24 });
    const screen = await ctx.view.screen();
    expect(screen.match(/worker online/g)).toHaveLength(1);
    const footer = screen.split('\n').find((line) => line.includes('/ for commands'))!;
    expect(footer.length).toBeLessThanOrEqual(102);
    expect(footer).toMatch(/Demo App · worker online$/);
  });
});

describe('the runs list', () => {
  function runs(api: FakeApi): void {
    const long =
      'A very long title that cannot possibly fit in a narrow terminal next to its status';
    api.tasks.set(
      'tsk_a0000000000000000000000',
      task({ id: 'tsk_a0000000000000000000000', title: long, status: 'running' }),
    );
    api.tasks.set(
      'tsk_b0000000000000000000000',
      task({
        id: 'tsk_b0000000000000000000000',
        title: 'Short',
        status: 'interrupted',
        finishedAt: iso(-1000),
      }),
    );
    api.tasks.set(
      'tsk_c0000000000000000000000',
      task({
        id: 'tsk_c0000000000000000000000',
        title: 'Done',
        status: 'succeeded',
        finishedAt: iso(-1000),
      }),
    );
  }

  it('keeps the status in a column and cuts the title first, in a narrow terminal too', async () => {
    const ctx = await open({ columns: 70, rows: 24, prepare: runs });
    await ctx.view.type('/runs', KEY.enter);
    const screen = await ctx.view.waitFor('Recent runs');
    const lines = screen.split('\n');
    const rows = lines.filter(
      (l) => /running|interrupted|succeeded/.test(l) && !l.includes('Runs that'),
    );
    expect(rows).toHaveLength(3);
    // the status words start in the same column on every row
    const columns = rows.map((l) => l.search(/running|interrupted|succeeded/));
    expect(new Set(columns).size).toBe(1);
    // the long title is the one that was cut
    expect(rows.find((l) => l.includes('A very long'))).toContain('…');
    // a blank line before the hint
    const hint = lines.findIndex((l) => l.includes('enter follow the log'));
    expect(lines[hint - 1]).toBe('');
  });
});

describe('/help and the slash palette', () => {
  it('aligns every row of /help on two spaces', async () => {
    const ctx = await open();
    await ctx.view.type('/help', KEY.enter);
    await ctx.c.idle();
    const doc = ctx.c.getState().entries.find((e) => e.kind === 'doc') as { lines: string[] };
    const rows = doc.lines.slice(3).filter((l) => l !== '');
    expect(rows.length).toBeGreaterThan(10);
    // the descriptions all start in one column, after two spaces
    const starts = rows.map((l) => l.search(/ {2}\S/) + 2);
    expect(new Set(starts).size).toBe(1);
    expect(rows.some((l) => l.startsWith('/brain'))).toBe(true);
    expect(rows.some((l) => l.startsWith('ctrl+c'))).toBe(true);
  });

  it('says how many commands are left out of the palette', async () => {
    const ctx = await open({ rows: 24 });
    await ctx.view.type('/');
    const screen = await ctx.view.waitFor('/new');
    // 12 commands, 6 rows: 5 shown and "… 7 more"
    expect(screen).toMatch(/… 7 more/);
    await ctx.view.type(KEY.esc);
  });
});

describe('/brain', () => {
  it('says "1 link", not "1 links"', async () => {
    const ctx = await open({
      prepare: (api) => {
        api.brain = {
          nodes: [
            {
              id: 'bre_1',
              projectId: 'prj_demo',
              kind: 'note',
              title: 'Only note',
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
          links: [
            {
              id: 'l1',
              projectId: 'prj_demo',
              from: 'bre_1',
              to: 'bre_2',
              type: 'relates',
              origin: 'user',
              confirmed: true,
              evidence: [],
              createdAt: iso(),
            },
          ],
          truncated: false,
          projects: [],
          counts: { knowledge: 0, decision: 0, note: 1, change: 0 },
        };
      },
    });
    await ctx.view.type('/brain', KEY.enter);
    const screen = await ctx.view.waitFor('Brain · Demo App');
    expect(screen).toContain('1 entry · 1 link');
    expect(screen).not.toContain('1 links');
  });
});

describe('permissions in a proposal', () => {
  withColors();

  it('shows auto in a neutral colour, not the danger colour', async () => {
    const ctx = await open({ prepare: proposalReply });
    await say(ctx, 'fix the failing tests');
    await ctx.view.waitFor('permissions  auto');
    const raw = ctx.view.stdout.output;
    expect(raw).not.toMatch(/\u001b\[31mauto/);
    expect(raw).not.toMatch(/\u001b\[33mauto/);
  });
});
