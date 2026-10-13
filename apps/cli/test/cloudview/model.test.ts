import type { MessageBlock } from '@patch/cloud-protocol';
import { describe, expect, it } from 'vitest';
import {
  MAX_LIVE_ITEMS,
  MAX_LIVE_TAIL,
  buildItems,
  committedCount,
  nextProfile,
  summarizeRun,
  type BuildContext,
  type Entry,
} from '../../src/cloudview/model.js';
import { message, task } from './fakes.js';

const none: BuildContext = {
  tasks: {},
  missing: new Set(),
  facts: {},
  activeProposal: null,
  activeChoose: null,
};

const entry = (id: string, role: 'user' | 'assistant', blocks: MessageBlock[]): Entry => ({
  kind: 'message',
  id,
  message: message(id, role, blocks),
});

const pending = (): MessageBlock => ({
  type: 'proposal',
  projectId: 'p',
  projectName: 'P',
  snapshotId: 's',
  prompt: 'do it',
  profile: 'auto',
  state: 'pending',
});

describe('buildItems', () => {
  it('expands each block into an item and settles the ones that cannot change', () => {
    const items = buildItems(
      [
        entry('m1', 'user', [{ type: 'text', text: 'hi' }]),
        entry('m2', 'assistant', [
          { type: 'text', text: 'hello' },
          { type: 'help', examples: ['a'] },
          { type: 'unsupported', what: 'x' },
        ]),
      ],
      none,
    );
    expect(items.map((i) => [i.item.kind, i.settled])).toEqual([
      ['user', true],
      ['text', true],
      ['help', true],
      ['unsupported', true],
    ]);
    expect(items.map((i) => i.item.id)).toEqual(['m1', 'm2:0', 'm2:1', 'm2:2']);
  });

  it('keeps a run live until the task is final and its recorded facts are read', () => {
    const entries = [entry('m1', 'assistant', [{ type: 'run', taskId: 't1' }])];
    const running = task({ id: 't1', status: 'running' });
    expect(buildItems(entries, none)[0]?.settled).toBe(false);
    expect(buildItems(entries, { ...none, tasks: { t1: running } })[0]?.settled).toBe(false);
    const done = task({ id: 't1', status: 'succeeded' });
    expect(
      buildItems(entries, { ...none, tasks: { t1: done }, facts: { t1: 'pending' } })[0]?.settled,
    ).toBe(false);
    expect(
      buildItems(entries, { ...none, tasks: { t1: done }, facts: { t1: {} } })[0]?.settled,
    ).toBe(true);
    expect(buildItems(entries, { ...none, missing: new Set(['t1']) })[0]?.settled).toBe(true);
  });

  it('keeps only the pending proposal that takes the keyboard live', () => {
    const entries = [entry('m1', 'assistant', [pending()]), entry('m2', 'assistant', [pending()])];
    const items = buildItems(entries, { ...none, activeProposal: 'm2' });
    expect(items.map((i) => i.settled)).toEqual([true, false]);
    expect(items[1]?.item).toMatchObject({ kind: 'proposal', active: true });
    expect(items[0]?.item).toMatchObject({ kind: 'proposal', active: false });
  });

  it('settles a proposal once it is answered', () => {
    const confirmed: MessageBlock = {
      ...(pending() as Extract<MessageBlock, { type: 'proposal' }>),
      state: 'confirmed',
      taskId: 't',
    };
    const items = buildItems([entry('m1', 'assistant', [confirmed])], none);
    expect(items[0]?.settled).toBe(true);
  });

  it('freezes the oldest live items beyond the limit', () => {
    const entries = Array.from({ length: MAX_LIVE_ITEMS + 3 }, (_, i) =>
      entry(`m${i}`, 'assistant', [{ type: 'run', taskId: `t${i}` }]),
    );
    const items = buildItems(entries, none);
    expect(items.filter((i) => !i.settled)).toHaveLength(MAX_LIVE_ITEMS);
    expect(items.slice(0, 3).every((i) => i.settled)).toBe(true);
  });

  it('does not let a long tail behind a live item grow without bound', () => {
    const entries: Entry[] = [entry('live', 'assistant', [{ type: 'run', taskId: 'tx' }])];
    for (let i = 0; i < MAX_LIVE_TAIL + 3; i++) {
      entries.push(entry(`t${i}`, 'assistant', [{ type: 'text', text: `line ${i}` }]));
    }
    const items = buildItems(entries, none);
    expect(items[0]?.settled).toBe(true);
  });

  it('never freezes the proposal that waits for an answer', () => {
    const entries: Entry[] = [entry('p', 'assistant', [pending()])];
    for (let i = 0; i < MAX_LIVE_TAIL + 3; i++) {
      entries.push(entry(`t${i}`, 'assistant', [{ type: 'text', text: 'x' }]));
    }
    expect(buildItems(entries, { ...none, activeProposal: 'p' })[0]?.settled).toBe(false);
  });

  it('shows a message the CLI does not know as a pointer to Patch HQ', () => {
    const odd = { type: 'hologram' } as unknown as MessageBlock;
    const items = buildItems([entry('m', 'assistant', [odd])], none);
    expect(items[0]?.item.kind).toBe('unknown');
  });
});

describe('one card per started run', () => {
  const confirmed = (taskId: string): MessageBlock => ({
    ...(pending() as Extract<MessageBlock, { type: 'proposal' }>),
    state: 'confirmed',
    taskId,
  });

  it('hides the card of the "Started" message once a newer message carries the run', () => {
    const entries = [
      entry('m1', 'assistant', [confirmed('t1')]),
      entry('m2', 'assistant', [
        { type: 'text', text: 'Started' },
        { type: 'run', taskId: 't1' },
      ]),
      entry('m3', 'assistant', [{ type: 'run', taskId: 't1' }]),
    ];
    const items = buildItems(entries, none);
    expect(items.filter((i) => i.item.kind === 'run').map((i) => i.item.id)).toEqual(['m3:0']);
    expect(items.some((i) => i.item.id === 'm2:0')).toBe(true);
    expect(items.some((i) => i.item.id === 'm2:1')).toBe(false);
  });

  it('keeps the cards of answers that only list runs', () => {
    const entries = [
      entry('m1', 'assistant', [{ type: 'run', taskId: 'a' }]),
      entry('m2', 'assistant', [{ type: 'run', taskId: 'a' }]),
    ];
    expect(buildItems(entries, none).filter((i) => i.item.kind === 'run')).toHaveLength(2);
  });

  it('keeps the only card of a finished started run live until its result message arrives', () => {
    const now = Date.now();
    const done = task({
      id: 't1',
      status: 'succeeded',
      finishedAt: new Date(now - 1000).toISOString(),
    });
    const entries = [
      entry('m1', 'assistant', [confirmed('t1')]),
      entry('m2', 'assistant', [{ type: 'run', taskId: 't1' }]),
    ];
    const context = { ...none, tasks: { t1: done }, facts: { t1: {} }, now };
    const run = (c: BuildContext) => buildItems(entries, c).find((i) => i.item.kind === 'run');
    expect(run(context)?.settled).toBe(false);
    // a result that never comes does not hold the card for ever
    expect(run({ ...context, now: now + 60_000 })?.settled).toBe(true);
    // with the result message there is one card (the newest) and it is settled
    const withResult = [...entries, entry('m3', 'assistant', [{ type: 'run', taskId: 't1' }])];
    const found = buildItems(withResult, context).filter((i) => i.item.kind === 'run');
    expect(found.map((i) => [i.item.id, i.settled])).toEqual([['m3:0', true]]);
  });
});

describe('committedCount', () => {
  it('counts the leading finished items and never goes back', () => {
    const live = (settled: boolean) => ({ item: { kind: 'unknown', id: 'x' } as const, settled });
    expect(committedCount([live(true), live(true), live(false), live(true)], 0)).toBe(2);
    expect(committedCount([live(true), live(false)], 3)).toBe(3);
    expect(committedCount([], 0)).toBe(0);
  });
});

describe('summarizeRun', () => {
  it('words every status honestly', () => {
    expect(summarizeRun(task({ status: 'queued' })).outcome).toBe('Waiting for the worker.');
    expect(summarizeRun(task({ status: 'starting' })).tone).toBe('active');
    expect(summarizeRun(task({ status: 'running', steps: 4 })).outcome).toBe(
      'Working. Model step 4 so far.',
    );
    expect(summarizeRun(task({ status: 'running', cancelRequested: true })).outcome).toBe(
      'Cancel requested: stopping.',
    );
    expect(summarizeRun(task({ status: 'cancelled' }))).toMatchObject({
      tone: 'idle',
      label: 'cancelled',
    });
    const interrupted = summarizeRun(task({ status: 'interrupted', error: 'host restarted' }));
    expect(interrupted).toMatchObject({ tone: 'warn', label: 'interrupted' });
    expect(interrupted.outcome).toContain('did not finish');
    expect(interrupted.outcome).toContain('host restarted');
  });

  it('a failure is an error with its reason, never a success', () => {
    const s = summarizeRun(task({ status: 'failed', error: 'boom' }));
    expect(s.tone).toBe('error');
    expect(s.outcome).toBe('Failed. boom');
    expect(summarizeRun(task({ status: 'failed', error: null })).outcome).toContain(
      'did not finish its work',
    );
  });

  it('says what changed only when it was recorded, and never for a plan', () => {
    const ok = task({ status: 'succeeded' });
    expect(summarizeRun(ok).outcome).toBe('Finished.');
    expect(summarizeRun(ok, {}).outcome).toBe('Finished.');
    expect(summarizeRun(ok, { filesChanged: 0 }).outcome).toBe('Finished. No files were changed.');
    expect(summarizeRun(ok, { filesChanged: 1 }).outcome).toBe('Finished. 1 file changed.');
    expect(summarizeRun(ok, { filesChanged: 4 }).outcome).toBe('Finished. 4 files changed.');
    expect(
      summarizeRun(task({ status: 'succeeded', profile: 'plan' }), { filesChanged: 4 }).outcome,
    ).toBe('Finished. This was a plan-only run: nothing was changed.');
  });
});

describe('nextProfile', () => {
  it('cycles', () => {
    expect(nextProfile('auto')).toBe('edits');
    expect(nextProfile('edits')).toBe('plan');
    expect(nextProfile('plan')).toBe('auto');
  });
});
