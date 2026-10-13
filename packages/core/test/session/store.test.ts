import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COMPACTION_SUMMARY_PREFIX,
  INTERRUPTED_MARKER,
  USER_SHELL_CONTEXT_TAG,
  WORKING_DIRECTORY_TAG,
  type AppendableEntry,
} from '../../src/session/schema.js';
import { Session, SessionNotFoundError, SessionStore } from '../../src/session/store.js';
import { makeTempDir } from '../../src/testing/fixtures.js';
import {
  assistantText,
  at,
  fullMeta,
  newMeta,
  usageEntry,
  userBlocks,
  userText,
  writeSessionFile,
} from './helpers.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let temp: { dir: string; cleanup: () => void };
let sessionsDir: string;
let store: SessionStore;

beforeEach(() => {
  temp = makeTempDir();
  sessionsDir = join(temp.dir, 'home', 'sessions');
  store = new SessionStore(sessionsDir);
});

afterEach(() => temp.cleanup());

function fileLines(session: Session): string[] {
  return readFileSync(session.filePath, 'utf8').split('\n');
}

describe('SessionStore.create', () => {
  it('creates the directory on demand and writes the meta line immediately', () => {
    const session = store.create(newMeta(temp.dir));

    expect(session.id).toMatch(UUID_PATTERN);
    expect(session.filePath).toBe(join(sessionsDir, `${session.id}.jsonl`));
    expect(session.meta).toMatchObject({
      type: 'meta',
      v: 1,
      id: session.id,
      projectRoot: temp.dir,
      model: 'model-a',
      system: 'You are Patch.',
    });
    expect(new Date(session.meta.createdAt).toISOString()).toBe(session.meta.createdAt);
    expect(readFileSync(session.filePath, 'utf8')).toBe(`${JSON.stringify(session.meta)}\n`);
    expect(session.entries()).toEqual([session.meta]);
  });

  it('never reuses the id of a meta object passed in', () => {
    const previous = store.create(newMeta(temp.dir));
    const next = store.create({ ...previous.meta, model: 'model-b' });
    expect(next.id).not.toBe(previous.id);
    expect(next.meta).toMatchObject({ id: next.id, model: 'model-b', type: 'meta', v: 1 });
    expect(Object.keys(next.meta).slice(0, 4)).toEqual(['type', 'v', 'id', 'createdAt']);
    expect(store.load(previous.id).model).toBe('model-a');
  });

  it('gives every session a distinct id', () => {
    const ids = new Set(Array.from({ length: 20 }, () => store.create(newMeta(temp.dir)).id));
    expect(ids.size).toBe(20);
  });

  it.skipIf(process.platform === 'win32')('keeps the directory and files private', () => {
    const session = store.create(newMeta(temp.dir));
    session.append(userText('hello'));
    expect(statSync(sessionsDir).mode & 0o777).toBe(0o700);
    expect(statSync(session.filePath).mode & 0o777).toBe(0o600);
  });
});

describe('Session.append', () => {
  it('writes one JSON line per entry, in order, with type as the first key', () => {
    const session = store.create(newMeta(temp.dir));
    for (let i = 0; i < 50; i++) session.append(userText(`message ${i}`));

    const lines = fileLines(session);
    expect(lines).toHaveLength(52); // meta + 50 entries + trailing empty string
    expect(lines.at(-1)).toBe('');
    lines.slice(1, -1).forEach((line, i) => {
      expect(line.startsWith('{"type":"message","ts":"')).toBe(true);
      expect(JSON.parse(line).message.content[0].text).toBe(`message ${i}`);
    });
  });

  it('fills ts with the current time when absent and keeps a supplied ts', () => {
    const session = store.create(newMeta(temp.dir));
    const before = Date.now();
    const filled = session.append(userText('hi'));
    const kept = session.append(at('2025-05-05T05:05:05.000Z', assistantText('hello')));

    expect(filled.type).toBe('message');
    const ts = (filled as { ts: string }).ts;
    expect(new Date(ts).toISOString()).toBe(ts);
    expect(Date.parse(ts)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(ts)).toBeLessThanOrEqual(Date.now());
    expect((kept as { ts: string }).ts).toBe('2025-05-05T05:05:05.000Z');
    expect(session.entries().slice(1)).toEqual([filled, kept]);
  });

  it('round-trips every entry type through load', () => {
    const session = store.create(newMeta(temp.dir));
    const appended: AppendableEntry[] = [
      userText('fix the bug'),
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'provider', provider: 'anthropic', kind: 'thinking', data: { signature: 'x' } },
            { type: 'text', text: 'Reading the file.' },
            { type: 'tool_call', id: 'call_1', name: 'read', input: { path: 'src/a.ts' } },
          ],
        },
      },
      {
        type: 'tool',
        callId: 'call_1',
        name: 'read',
        summary: { verb: 'read', target: 'src/a.ts', detail: 'lines 1-10' },
        isError: false,
        display: { summary: '10 lines' },
        durationMs: 12,
      },
      userBlocks([{ type: 'tool_result', toolCallId: 'call_1', content: 'const a = 1;' }]),
      usageEntry({ inputTokens: 100, outputTokens: 20 }),
      { type: 'model', model: 'model-b' },
      { type: 'notice', level: 'warn', text: 'Fallback model served this turn.' },
      { type: 'shell', command: 'git status', exitCode: 0, output: 'clean', durationMs: 30 },
      {
        type: 'compaction',
        summary: 'Earlier work.',
        messagesCompacted: 3,
        tokensBefore: 900,
        auto: true,
      },
    ];
    for (const entry of appended) session.append(entry);

    const loaded = store.load(session.id);
    expect(loaded).toBeInstanceOf(Session);
    expect(loaded.id).toBe(session.id);
    expect(loaded.meta).toEqual(session.meta);
    expect(loaded.entries()).toEqual(session.entries());
    expect(loaded.history()).toEqual(session.history());
    expect(loaded.model).toBe('model-b');
  });

  it('continues an existing file after load', () => {
    const session = store.create(newMeta(temp.dir));
    session.append(userText('first'));
    const loaded = store.load(session.id);
    loaded.append(assistantText('second'));

    expect(
      store
        .load(session.id)
        .history()
        .map((m) => m.content),
    ).toEqual([[{ type: 'text', text: 'first' }], [{ type: 'text', text: 'second' }]]);
  });

  it('leaves memory unchanged when the disk write fails', () => {
    const session = store.create(newMeta(temp.dir));
    temp.cleanup();
    expect(() => session.append(userText('lost'))).toThrow();
    expect(session.entries()).toHaveLength(1);
  });
});

describe('SessionStore.load crash tolerance', () => {
  it('skips a truncated last line and starts the next append on a fresh line', () => {
    const session = store.create(newMeta(temp.dir));
    session.append(userText('kept'));
    appendFileSync(session.filePath, '{"type":"message","ts":"2026-01-01T00:00:00.000Z","mess');

    const loaded = store.load(session.id);
    expect(loaded.entries()).toHaveLength(2);
    loaded.append(assistantText('after crash'));

    const reloaded = store.load(session.id);
    expect(reloaded.history().map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(reloaded.entries()).toHaveLength(3);
  });

  it('skips blank lines, garbage, CRLF artifacts, unknown types and malformed entries', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const ts = '2026-01-01T00:00:00.000Z';
    writeSessionFile(sessionsDir, id, [
      fullMeta(id, temp.dir),
      '',
      'not json at all',
      '   ',
      `${JSON.stringify({ type: 'message', ts, message: { role: 'user', content: [{ type: 'text', text: 'one' }] } })}\r`,
      JSON.stringify({ type: 'future_entry', ts, payload: 1 }),
      JSON.stringify({ type: 'message', ts, message: { role: 'user' } }),
      JSON.stringify({ type: 'message', ts, message: { role: 'system', content: [] } }),
      JSON.stringify({ type: 'usage', ts, model: 'm', usage: { inputTokens: 'many' } }),
      JSON.stringify(['an', 'array']),
      JSON.stringify({ type: 'meta', v: 1 }),
      JSON.stringify({
        type: 'message',
        ts,
        message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      }),
    ]);

    const loaded = store.load(id);
    expect(loaded.entries().map((e) => e.type)).toEqual(['meta', 'message', 'message']);
    expect(loaded.history().map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('tolerates a byte order mark before the meta line', () => {
    const id = 'bom-session';
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, `${id}.jsonl`),
      `\uFEFF${JSON.stringify(fullMeta(id, temp.dir))}\n`,
    );
    expect(store.load(id).meta.id).toBe(id);
  });
});

describe('SessionStore.load failures', () => {
  it('throws SessionNotFoundError for a missing session', () => {
    expect(() => store.load('00000000-0000-0000-0000-000000000000')).toThrow(SessionNotFoundError);
    expect(() => store.load('00000000-0000-0000-0000-000000000000')).toThrow(/No session with id/);
  });

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')(
    'loads an id typed in a different case where file names are case-insensitive',
    () => {
      const session = store.create(newMeta(temp.dir));
      expect(store.load(session.id.toUpperCase()).id).toBe(session.id);
    },
  );

  it('rejects ids that could escape the sessions directory', () => {
    for (const id of ['../secret', '..\\secret', 'a/b', '', 'x.jsonl']) {
      expect(() => store.load(id)).toThrow(SessionNotFoundError);
    }
  });

  const invalidMetaCases: Array<[string, string[], RegExp]> = [
    ['an empty file', [], /the file is empty/],
    ['a non-JSON first line', ['{"type":"meta",'], /first line is not valid JSON/],
    [
      'a first line that is not meta',
      [JSON.stringify({ type: 'message' })],
      /not session metadata/,
    ],
    [
      'a newer format version',
      [JSON.stringify({ ...fullMeta('bad', '/p'), v: 2 })],
      /newer version of Patch \(session format v2\)/,
    ],
    [
      'a missing meta field',
      [JSON.stringify({ ...fullMeta('bad', '/p'), system: undefined })],
      /metadata is invalid \(system:/,
    ],
    [
      'an id that does not match the file name',
      [JSON.stringify(fullMeta('other-id', '/p'))],
      /belongs to a different session \(other-id\)/,
    ],
  ];

  it.each(invalidMetaCases)('reports %s clearly', (_name, lines, message) => {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'bad.jsonl'), lines.join('\n'));
    expect(() => store.load('bad')).toThrow(SessionNotFoundError);
    expect(() => store.load('bad')).toThrow(message);
    expect(store.list({ includeEmpty: true })).toEqual([]);
  });
});

describe('Session.history', () => {
  it('returns every message entry, as stored, when there is no compaction', () => {
    const session = store.create(newMeta(temp.dir));
    const first = session.append(userText('a'));
    session.append(usageEntry({ inputTokens: 1 }));
    session.append(userText('b')); // consecutive user messages are not merged
    session.append({ type: 'notice', level: 'info', text: 'note' });
    const last = session.append(assistantText('c'));

    const history = session.history();
    expect(history.map((m) => m.content[0])).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'text', text: 'c' },
    ]);
    expect(history[0]).toBe((first as { message: unknown }).message);
    expect(history[2]).toBe((last as { message: unknown }).message);
  });

  it('replaces everything before the last compaction with its summary', () => {
    const session = store.create(newMeta(temp.dir));
    session.append(userText('old 1'));
    session.append(assistantText('old 2'));
    session.append({
      type: 'compaction',
      summary: 'first summary',
      messagesCompacted: 2,
      auto: false,
    });
    session.append(userText('middle'));
    session.append({
      type: 'compaction',
      summary: 'second summary',
      messagesCompacted: 2,
      auto: true,
    });
    session.append(userText('new 1'));
    session.append(assistantText('new 2'));

    expect(session.history()).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: `${COMPACTION_SUMMARY_PREFIX}\n\nsecond summary` }],
      },
      { role: 'user', content: [{ type: 'text', text: 'new 1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'new 2' }] },
    ]);
  });

  it('returns only the summary right after a compaction', () => {
    const session = store.create(newMeta(temp.dir));
    session.append(userText('old'));
    session.append({ type: 'compaction', summary: 'S', messagesCompacted: 1, auto: false });
    expect(session.history()).toHaveLength(1);
  });

  it('serializes to the same bytes before and after a reload', () => {
    const session = store.create(newMeta(temp.dir));
    session.append(userText('unicode: zażółć ✓ \u2028 "quotes" \\ backslash'));
    session.append({
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'provider',
            provider: 'anthropic',
            kind: 'thinking',
            data: { z: 1, a: [2, { y: 3 }] },
          },
          { type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls', b: 1, a: 2 } },
        ],
      },
    });
    expect(JSON.stringify(store.load(session.id).history())).toBe(
      JSON.stringify(session.history()),
    );
  });
});

describe('Session.title', () => {
  it('is "(no messages)" for a new session', () => {
    expect(store.create(newMeta(temp.dir)).title()).toBe('(no messages)');
  });

  it('skips shell transcripts, interruptions, compaction summaries and tool results', () => {
    const session = store.create(newMeta(temp.dir));
    session.append(userText(`${USER_SHELL_CONTEXT_TAG}\n$ ls\nfile\n</user-shell-command>`));
    session.append(userText(INTERRUPTED_MARKER));
    session.append(userText(`${COMPACTION_SUMMARY_PREFIX}\n\nsummary`));
    session.append(userBlocks([{ type: 'tool_result', toolCallId: 't', content: 'output' }]));
    session.append(userText('   \n  '));
    session.append(assistantText('assistant text is never a title'));
    expect(session.title()).toBe('(no messages)');

    session.append(userText('  Fix the\n\tlogin   redirect  '));
    session.append(userText('later message'));
    expect(session.title()).toBe('Fix the login redirect');
  });

  it('skips working-directory notes, alone or before the text of a turn', () => {
    const note = `${WORKING_DIRECTORY_TAG}\nWorking directory: /repo/web\n</working-directory-update>`;
    const session = store.create(newMeta(temp.dir));
    session.append(userText(note)); // As older versions stored it: a message of its own.
    expect(session.title()).toBe('(no messages)');
    session.append(
      userBlocks([
        { type: 'text', text: note },
        { type: 'text', text: 'Fix the build' },
      ]),
    );
    expect(session.title()).toBe('Fix the build');
    expect(store.list()[0]?.title).toBe('Fix the build');
  });

  it('uses the first text block of a mixed message', () => {
    const session = store.create(newMeta(temp.dir));
    session.append(
      userBlocks([
        { type: 'tool_result', toolCallId: 't', content: 'output' },
        { type: 'text', text: 'and also do this' },
      ]),
    );
    expect(session.title()).toBe('and also do this');
  });

  it('truncates to 80 characters with an ellipsis', () => {
    const session = store.create(newMeta(temp.dir));
    session.append(userText('x'.repeat(200)));
    const title = session.title();
    expect(title).toHaveLength(80);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('Session model, usage and messages', () => {
  it('reports the latest model entry, falling back to meta.model', () => {
    const session = store.create(newMeta(temp.dir, { model: 'start-model' }));
    expect(session.model).toBe('start-model');
    session.append({ type: 'model', model: 'second' });
    session.append(userText('hi'));
    session.append({ type: 'model', model: 'third' });
    expect(session.model).toBe('third');
    expect(store.load(session.id).model).toBe('third');
  });

  it('sums usage entries and reports the last one', () => {
    const session = store.create(newMeta(temp.dir));
    expect(session.usageTotals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(session.lastUsage()).toBeUndefined();

    session.append(
      usageEntry({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 7 }),
    );
    session.append(userText('hi'));
    session.append(usageEntry({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 200 }));

    expect(session.usageTotals()).toEqual({
      inputTokens: 13,
      outputTokens: 7,
      cacheReadTokens: 300,
      cacheWriteTokens: 7,
    });
    expect(session.lastUsage()).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
    });
  });

  it('counts billed and summary usage in the totals and keeps the purpose on reload', () => {
    const session = store.create(newMeta(temp.dir));
    session.append(usageEntry({ inputTokens: 10, outputTokens: 1 }));
    session.append({
      type: 'usage',
      model: 'model-a',
      purpose: 'summary',
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      billed: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    // A purpose written by a newer version still counts toward costs.
    const future = {
      type: 'usage',
      ts: '2026-01-01T00:00:00.000Z',
      model: 'model-a',
      purpose: 'title',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    session.close();
    appendFileSync(session.filePath, `${JSON.stringify(future)}\n`);

    const loaded = store.load(session.id);
    expect(loaded.entries().filter((entry) => entry.type === 'usage')).toMatchObject([
      { usage: { inputTokens: 10 } },
      { purpose: 'summary', billed: { inputTokens: 200 } },
      { purpose: 'title' },
    ]);
    expect(loaded.usageTotals()).toMatchObject({ inputTokens: 211, outputTokens: 22 });
    loaded.close();
  });

  it('hasMessages is true only once a user message exists', () => {
    const session = store.create(newMeta(temp.dir));
    session.append({ type: 'notice', level: 'info', text: 'hello' });
    expect(session.hasMessages()).toBe(false);
    session.append(userText(`${USER_SHELL_CONTEXT_TAG}\n$ ls`));
    expect(session.hasMessages()).toBe(true);
  });
});
