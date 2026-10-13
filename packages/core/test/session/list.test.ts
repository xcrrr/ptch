import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USER_SHELL_CONTEXT_TAG } from '../../src/session/schema.js';
import { SessionStore } from '../../src/session/store.js';
import { makeTempDir } from '../../src/testing/fixtures.js';
import { assistantText, at, fullMeta, newMeta, userText, writeSessionFile } from './helpers.js';

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

let temp: { dir: string; cleanup: () => void };
let sessionsDir: string;
let projectA: string;
let projectB: string;
let store: SessionStore;

beforeEach(() => {
  temp = makeTempDir();
  sessionsDir = join(temp.dir, 'sessions');
  projectA = join(temp.dir, 'project-a');
  projectB = join(temp.dir, 'project-b');
  mkdirSync(projectA);
  mkdirSync(projectB);
  store = new SessionStore(sessionsDir);
});

afterEach(() => temp.cleanup());

/** Creates a session in `projectRoot` whose entries carry the given timestamps. */
function sessionWith(projectRoot: string, title: string, ...timestamps: string[]) {
  const session = store.create(newMeta(projectRoot));
  session.append(at(timestamps[0] ?? '2026-01-01T00:00:00.000Z', userText(title)));
  for (const ts of timestamps.slice(1)) session.append(at(ts, assistantText('reply')));
  return session;
}

describe('SessionStore.resolve', () => {
  const ids = [
    'aaaa1111-0000-4000-8000-000000000001',
    'aaaa2222-0000-4000-8000-000000000002',
    'bbbb1111-0000-4000-8000-000000000003',
  ];

  beforeEach(() => {
    for (const id of ids) writeSessionFile(sessionsDir, id, [fullMeta(id, projectA)]);
  });

  it('accepts a full id', () => {
    expect(store.resolve(ids[0]!)).toEqual({ id: ids[0] });
  });

  it('accepts a unique prefix, ignoring hyphens, case and surrounding whitespace', () => {
    expect(store.resolve('bbbb')).toEqual({ id: ids[2] });
    expect(store.resolve('AAAA-1')).toEqual({ id: ids[0] });
    expect(store.resolve('aaaa2222-0')).toEqual({ id: ids[1] });
    expect(store.resolve('  AAAA2222  ')).toEqual({ id: ids[1] });
    expect(store.resolve('aaaa11110000')).toEqual({ id: ids[0] });
  });

  it('reports ambiguous prefixes with every match', () => {
    expect(store.resolve('aaaa')).toEqual({ error: 'ambiguous', matches: [ids[0], ids[1]] });
    expect(store.resolve('a')).toEqual({ error: 'ambiguous', matches: [ids[0], ids[1]] });
  });

  it('reports not_found for unknown, empty or malformed input', () => {
    for (const input of ['cccc', '', '   ', '-', '../aaaa', 'aaaa.jsonl']) {
      expect(store.resolve(input)).toEqual({ error: 'not_found' });
    }
  });

  it('reports not_found when the sessions directory does not exist', () => {
    expect(new SessionStore(join(temp.dir, 'missing')).resolve('aaaa')).toEqual({
      error: 'not_found',
    });
  });

  it('ignores files that are not sessions', () => {
    writeFileSync(join(sessionsDir, 'cccc1111.txt'), 'x');
    mkdirSync(join(sessionsDir, 'cccc2222.jsonl'));
    expect(store.resolve('cccc')).toEqual({ error: 'not_found' });
  });
});

describe('SessionStore.list', () => {
  it('returns an empty list when the directory does not exist', () => {
    expect(store.list()).toEqual([]);
    expect(store.latestFor(projectA)).toBeUndefined();
  });

  it('summarizes sessions', () => {
    const session = store.create(newMeta(projectA, { branch: 'feature/x', model: 'model-a' }));
    session.append(at('2026-03-01T10:00:00.000Z', userText('  Add retry\nlogic ')));
    session.append(at('2026-03-01T10:00:05.000Z', assistantText('Done.')));
    session.append(at('2026-03-01T10:01:00.000Z', { type: 'model', model: 'model-b' }));
    session.append(at('2026-03-01T10:02:00.000Z', userText('thanks')));
    session.append(at('2026-03-01T10:03:00.000Z', { type: 'notice', level: 'info', text: 'n' }));

    expect(store.list()).toEqual([
      {
        id: session.id,
        title: 'Add retry logic',
        createdAt: session.meta.createdAt,
        updatedAt: '2026-03-01T10:03:00.000Z',
        cwd: projectA,
        projectRoot: projectA,
        branch: 'feature/x',
        model: 'model-b',
        messageCount: 3,
        projectExists: true,
        filePath: session.filePath,
      },
    ]);
  });

  it('agrees with Session.title() on skipped messages', () => {
    const session = store.create(newMeta(projectA));
    session.append(userText(`${USER_SHELL_CONTEXT_TAG}\n$ ls`));
    expect(store.list()[0]?.title).toBe('(no messages)');
    session.append(userText('real request'));
    expect(store.list()[0]?.title).toBe(session.title());
    expect(session.title()).toBe('real request');
  });

  it('sorts newest first by the last entry timestamp', () => {
    const old = sessionWith(projectA, 'old', '2026-01-01T00:00:00.000Z');
    const newest = sessionWith(
      projectA,
      'newest',
      '2026-01-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    );
    const middle = sessionWith(projectB, 'middle', '2026-03-01T00:00:00.000Z');

    expect(store.list().map((s) => s.id)).toEqual([newest.id, middle.id, old.id]);
    expect(store.list({ limit: 2 }).map((s) => s.id)).toEqual([newest.id, middle.id]);
    expect(store.list({ limit: 0 })).toEqual([]);
  });

  it('uses the last valid line, ignoring a truncated tail', () => {
    const session = sessionWith(projectA, 'x', '2026-02-01T00:00:00.000Z');
    writeFileSync(session.filePath, '{"type":"message","ts":"2027-01-01T00:00:00.000Z","mess', {
      flag: 'a',
    });
    const [summary] = store.list();
    expect(summary?.updatedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(summary?.messageCount).toBe(1);
  });

  it('falls back to the file modification time when there are no entries', () => {
    const session = store.create(newMeta(projectA));
    const mtime = new Date('2026-04-04T04:04:04.000Z');
    utimesSync(session.filePath, mtime, mtime);
    expect(store.list({ includeEmpty: true })[0]?.updatedAt).toBe(mtime.toISOString());
  });

  it('excludes sessions without user messages unless includeEmpty', () => {
    const empty = store.create(newMeta(projectA));
    empty.append({ type: 'notice', level: 'info', text: 'started' });
    const used = sessionWith(projectA, 'used');

    expect(store.list().map((s) => s.id)).toEqual([used.id]);
    expect(
      store
        .list({ includeEmpty: true })
        .map((s) => s.id)
        .sort(),
    ).toEqual([empty.id, used.id].sort());
    const emptySummary = store.list({ includeEmpty: true }).find((s) => s.id === empty.id);
    expect(emptySummary).toMatchObject({ title: '(no messages)', messageCount: 0 });
  });

  it('filters by project root', () => {
    const a = sessionWith(projectA, 'in a');
    sessionWith(projectB, 'in b');

    expect(store.list({ projectRoot: projectA }).map((s) => s.id)).toEqual([a.id]);
    expect(store.list({ projectRoot: `${projectA}/` }).map((s) => s.id)).toEqual([a.id]);
    expect(store.list({ projectRoot: join(temp.dir, 'elsewhere') })).toEqual([]);
  });

  it(`matches project roots ${CASE_INSENSITIVE ? 'case-insensitively' : 'case-sensitively'}`, () => {
    const a = sessionWith(projectA, 'in a');
    const variant = projectA.toUpperCase();
    expect(store.list({ projectRoot: variant }).map((s) => s.id)).toEqual(
      CASE_INSENSITIVE ? [a.id] : [],
    );
  });

  it.runIf(process.platform === 'win32')('matches project roots across separator styles', () => {
    const a = sessionWith(projectA, 'in a');
    expect(store.list({ projectRoot: projectA.replace(/\\/g, '/') }).map((s) => s.id)).toEqual([
      a.id,
    ]);
  });

  it('flags sessions whose project directory no longer exists', () => {
    sessionWith(projectA, 'kept');
    sessionWith(projectB, 'deleted', '2026-05-01T00:00:00.000Z');
    rmSync(projectB, { recursive: true });

    const byTitle = Object.fromEntries(store.list().map((s) => [s.title, s.projectExists]));
    expect(byTitle).toEqual({ kept: true, deleted: false });
  });

  it('skips unreadable and invalid files without failing', () => {
    const good = sessionWith(projectA, 'good');
    writeSessionFile(sessionsDir, 'garbage', ['not json']);
    writeSessionFile(sessionsDir, 'mismatch', [fullMeta('different', projectA)]);
    writeFileSync(join(sessionsDir, 'notes.txt'), 'ignored');
    mkdirSync(join(sessionsDir, 'folder.jsonl'));

    expect(store.list({ includeEmpty: true }).map((s) => s.id)).toEqual([good.id]);
  });

  it('latestFor returns the newest non-empty session of a project', () => {
    sessionWith(projectA, 'older', '2026-01-01T00:00:00.000Z');
    const newer = sessionWith(projectA, 'newer', '2026-02-01T00:00:00.000Z');
    sessionWith(projectB, 'other project', '2026-03-01T00:00:00.000Z');
    store.create(newMeta(projectA)); // empty, and the most recently created

    expect(store.latestFor(projectA)?.id).toBe(newer.id);
    expect(store.latestFor(join(temp.dir, 'nothing-here'))).toBeUndefined();
  });

  it('stays fast for hundreds of sessions', () => {
    const system = 'You are Patch. '.repeat(1_000);
    const output = 'line of tool output\n'.repeat(200);
    for (let i = 0; i < 300; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const ts = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
      const lines: unknown[] = [fullMeta(id, i % 2 === 0 ? projectA : projectB, { system })];
      for (let turn = 0; turn < 10; turn++) {
        lines.push({
          type: 'message',
          ts,
          message: { role: 'user', content: [{ type: 'text', text: `task ${i}.${turn}` }] },
        });
        lines.push({
          type: 'tool',
          ts,
          callId: `c${turn}`,
          name: 'bash',
          summary: { verb: 'bash', target: 'ls' },
          isError: false,
          durationMs: 5,
        });
        lines.push({
          type: 'message',
          ts,
          message: { role: 'assistant', content: [{ type: 'text', text: output }] },
        });
        lines.push({
          type: 'usage',
          ts,
          model: 'm',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        });
      }
      writeSessionFile(sessionsDir, id, lines);
    }

    const started = performance.now();
    const all = store.list();
    const filtered = store.list({ projectRoot: projectA });
    const elapsed = performance.now() - started;

    expect(all).toHaveLength(300);
    expect(all[0]?.title).toBe('task 299.0');
    expect(all[0]?.messageCount).toBe(20);
    expect(filtered).toHaveLength(150);
    expect(elapsed).toBeLessThan(1_000);
  });
});
