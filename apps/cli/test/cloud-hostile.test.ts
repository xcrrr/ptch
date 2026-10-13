import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { runCloud, type CloudIO } from '../src/cloud/commands.js';
import { renderEvent } from '../src/cloud/format.js';
import { cleanTerminalOutput, toDisplayText } from '../src/ui/text-layout.js';
import { iso, project, status, task } from './cloudview/fakes.js';

/** Everything a hostile server (or a hostile agent's output) can try to do to a terminal. */
const OSC52 = '\u001b]52;c;ZXZpbA==\u0007';
const OSC0 = '\u001b]0;pwned\u001b\\';
const DCS = '\u001bP1$r0;m\u001b\\';
const APC = '\u001b_Gi=1;AAAA\u001b\\';
const PM = '\u001b^private\u001b\\';
const SOS = '\u001bXstring\u001b\\';
const CLEAR = '\u001b[2J\u001b[H\u001bc\u001b[?1049h';
const C1 = '\u009b2J\u009d0;title\u009c\u0085';
const BIDI = String.fromCharCode(0x202e, 0x202a, 0x2066, 0x2067, 0x2069, 0x200f, 0x061c);
const CR = '\rspoof';
const HOSTILE = `${OSC52}${OSC0}${DCS}${APC}${PM}${SOS}${CLEAR}${C1}${BIDI}${CR}\u0007\u0008\u007f`;
const evil = (label: string): string => `${label}${HOSTILE}`;

// Anything that moves, clears, retitles, writes the clipboard or reorders text.
const FORBIDDEN = new RegExp(
  '[\\u001b\\u0080-\\u009f\\u202a-\\u202e\\u2066-\\u2069\\u200e\\u200f\\u061c\\u0007\\u0008\\u007f\\r]',
);
const SGR = /\u001b\[[0-9;]*m/g;

/** What would reach a terminal, with the plain colours Patch adds itself removed. */
function leaked(text: string): string | null {
  const rest = text.replace(SGR, '');
  const found = FORBIDDEN.exec(rest);
  return found
    ? `U+${found[0].charCodeAt(0).toString(16)} near ${JSON.stringify(rest.slice(Math.max(0, (found.index ?? 0) - 20), (found.index ?? 0) + 20))}`
    : null;
}

class Capture extends Writable {
  text = '';
  isTTY = false;
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

const ID = 'tsk_hostile000000000000000';
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function sse(frames: Array<[string, unknown]>): Response {
  const body = frames
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const event = (seq: number, type: string, data: Record<string, unknown>) => ({
  seq,
  taskId: ID,
  projectId: null,
  ts: iso(),
  type,
  level: 'info',
  data,
});

const EVENTS = [
  event(1, 'task.created', {}),
  event(2, 'task.status', { from: evil('a'), to: evil('b'), workerId: evil('w') }),
  event(3, 'agent.init', { model: evil('model'), permission_mode: evil('mode') }),
  event(4, 'agent.text', { text: evil('said') }),
  event(5, 'task.output', { stream: 'stderr', text: evil('stderr') }),
  event(6, 'task.output', { stream: 'worker', text: evil('worker') }),
  event(7, 'agent.tool_start', { verb: evil('v'), target: evil('t') }),
  event(8, 'agent.tool_end', {
    verb: evil('v'),
    target: evil('t'),
    summary: evil('s'),
    is_error: true,
  }),
  event(9, 'agent.hosted_tool', { verb: evil('v'), target: evil('t') }),
  event(10, 'agent.permission_denied', { message: evil('denied') }),
  event(11, 'agent.notice', { level: 'error', text: evil('notice') }),
  event(12, 'task.limit', { limit: evil('limit') }),
  event(13, 'agent.something_new', {}),
  event(14, 'task.changes', {
    files: [{ path: evil('file'), status: evil('status'), added: 1, removed: 2 }],
    skipped: [{ path: evil('skipped'), reason: evil('reason') }],
  }),
  event(15, 'task.finished', { to: evil('failed'), error: evil('error') }),
];

/** A Patch Cloud that says hostile things in every field it controls. */
function hostileCloud(): typeof fetch {
  const bad = task({
    id: ID,
    title: evil('title'),
    prompt: evil('prompt'),
    status: 'failed',
    error: evil('task error'),
    resultSummary: evil('summary'),
    model: evil('model'),
    createdAt: evil('created'),
    finishedAt: iso(),
    startedAt: iso(-5000),
  });
  const patch = [`diff --git a/${evil('a')} b/${evil('a')}`, '--- a/x', '+++ b/x', ''].join('\n');
  return async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    if (path === '/status') {
      const s = status({ sandbox: evil('sandbox'), version: evil('v') });
      return json({ ...s, version: evil('cloud') });
    }
    if (path === '/auth/me') {
      return json({
        authenticated: true,
        kind: 'oauth',
        version: evil('version'),
        account: { id: 'a', name: evil('Owner') },
        client: { id: 'c', name: evil('client'), device: evil('device') },
      });
    }
    if (path === '/projects' && method === 'GET') {
      return json({
        projects: [
          project({
            id: evil('prj'),
            name: evil('name'),
            slug: evil('slug'),
            description: evil('d'),
            gitRemote: evil('remote'),
            lastTaskAt: evil('last'),
          }),
        ],
      });
    }
    if (path === '/tasks' && method === 'GET')
      return json({ tasks: [bad, { ...bad, id: evil('id') }] });
    if (path === `/tasks/${ID}` && method === 'GET') {
      return json({
        task: bad,
        artifacts: [
          {
            id: 'art_patch',
            taskId: ID,
            kind: 'patch',
            name: evil('patch'),
            sizeBytes: 1,
            sha256: 'a',
            createdAt: iso(),
          },
          {
            id: 'art_answer',
            taskId: ID,
            kind: 'answer',
            name: evil('answer'),
            sizeBytes: 1,
            sha256: 'a',
            createdAt: iso(),
          },
        ],
        snapshot: {
          id: 'snp',
          projectId: 'p',
          createdAt: iso(),
          sizeBytes: 1,
          fileCount: 3,
          sha256: 'a',
          baseCommit: evil('commit'),
          branch: evil('branch'),
          dirtyFiles: [evil('dirty')],
        },
        retries: [],
      });
    }
    if (path === `/tasks/${ID}/events`) return json({ events: EVENTS, cursor: 15 });
    if (path === `/tasks/${ID}/stream`) {
      return sse([
        ...EVENTS.map((e) => ['ev', e] as [string, unknown]),
        ['end', { status: 'failed' }],
      ]);
    }
    if (path === '/artifacts/art_answer/download') return new Response(evil('answer text'));
    if (path === '/artifacts/art_patch/download') return new Response(patch);
    if (path === `/tasks/${ID}/cancel`)
      return json({ ...bad, status: 'running', title: evil('c') });
    if (path === `/tasks/${ID}/retry`) return json({ ...bad, id: evil('retry'), status: 'queued' });
    if (path.endsWith('/brain') && method === 'GET') {
      return json({
        entries: [
          {
            id: evil('e'),
            projectId: 'p',
            kind: evil('kind'),
            title: evil('entry'),
            body: evil('body'),
            tags: [evil('tag')],
            source: evil('source'),
            sourceTaskId: null,
            createdAt: evil('when'),
            updatedAt: iso(),
            archived: false,
          },
        ],
      });
    }
    if (path.endsWith('/brain') && method === 'POST') {
      return json({ id: evil('new'), kind: evil('kind'), title: 't' }, { status: 201 });
    }
    if (path === '/tasks' && method === 'POST') return json({ ...bad, id: evil('created') });
    return json({ error: { code: evil('code'), message: evil('server error') } }, { status: 500 });
  };
}

interface Run {
  code: number;
  out: string;
  err: string;
}

async function ptch(
  argv: string[],
  options: { fetchImpl?: typeof fetch; cwd?: string } = {},
): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), 'hostile-home-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const stdout = new Capture();
  const stderr = new Capture();
  const io: CloudIO = {
    stdin: Object.assign(new Writable(), { isTTY: false }) as unknown as NodeJS.ReadStream,
    stdout,
    stderr,
    env: {
      PATCH_HOME: join(home, '.patch'),
      PATCH_CLOUD_URL: 'http://127.0.0.1:9',
      PATCH_CLOUD_TOKEN: 'pct_test',
    },
    cwd: options.cwd ?? repoDir(),
    homeDir: home,
    fetchImpl: options.fetchImpl ?? hostileCloud(),
    answers: { confirm: false },
  };
  const code = await runCloud(argv, io);
  return { code, out: stdout.text, err: stderr.text };
}

let repo: string | undefined;
afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});
function repoDir(): string {
  if (repo) return repo;
  const dir = mkdtempSync(join(tmpdir(), 'hostile-repo-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'a.txt'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  repo = dir;
  return dir;
}

const commands: Array<[string, string[]]> = [
  ['whoami', ['whoami']],
  ['status', ['status']],
  ['projects', ['projects']],
  ['list', ['list']],
  ['list --json', ['list', '--json']],
  ['show', ['show', ID]],
  ['show --json', ['show', ID, '--json']],
  ['logs', ['logs', ID]],
  ['logs --verbose', ['logs', ID, '--verbose']],
  ['logs --follow', ['logs', ID, '--follow']],
  ['result', ['result', ID]],
  ['cancel', ['cancel', ID]],
  ['retry', ['retry', ID]],
  ['apply', ['apply', ID]],
  ['brain', ['brain', '--project', 'prj_x']],
  ['brain search', ['brain', 'search', 'x', '--project', 'prj_x']],
  ['brain add', ['brain', 'add', 'a title', '--project', 'prj_x']],
  ['submit --dry-run', ['submit', 'do it', '--dry-run', '--project', evil('name')]],
];

describe('ptch cloud never lets Patch Cloud write to the terminal', () => {
  for (const [name, argv] of commands) {
    it(`${name}: no escape sequence, control or bidi character gets through`, async () => {
      const result = await ptch(argv);
      expect(leaked(result.out)).toBeNull();
      expect(leaked(result.err)).toBeNull();
      // The command did run and show something (this is not an empty pass).
      expect(result.out + result.err).not.toBe('');
    });
  }

  it('also cleans the errors the server sends, for every status', async () => {
    for (const code of [400, 401, 404, 409, 429, 500]) {
      const failing: typeof fetch = async () =>
        json({ error: { code: evil('code'), message: evil(`error ${code}`) } }, { status: code });
      for (const argv of [
        ['status'],
        ['list'],
        ['projects'],
        ['whoami'],
        ['show', ID],
        ['logs', ID, '--follow'],
      ]) {
        const result = await ptch(argv, { fetchImpl: failing });
        expect(leaked(result.out + result.err)).toBeNull();
      }
    }
  });

  it('keeps the readable text around what it removed', async () => {
    const result = await ptch(['show', ID]);
    expect(result.out).toContain('title');
    expect(result.out).toContain('task error');
    expect(result.out).not.toContain('pwned'.toUpperCase());
  });

  it('refuses a patch with a hostile path without printing the path raw', async () => {
    const result = await ptch(['apply', ID]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('Refusing this patch');
  });

  it('refuses to save a patch through a symbolic link in .patch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hostile-link-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'hostile-elsewhere-'));
    cleanups.push(
      () => rmSync(dir, { recursive: true, force: true }),
      () => rmSync(elsewhere, { recursive: true, force: true }),
    );
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'Test');
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
    try {
      symlinkSync(elsewhere, join(dir, '.patch'), 'junction');
    } catch {
      return; // links are not available here
    }
    const goodPatch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n';
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname.replace('/api/v1', '');
      if (path === `/tasks/${ID}`) {
        return json({
          task: task({ id: ID, status: 'succeeded', projectId: 'prj_demo' }),
          artifacts: [
            {
              id: 'art_patch',
              taskId: ID,
              kind: 'patch',
              name: 'changes.patch',
              sizeBytes: 1,
              sha256: 'a',
              createdAt: iso(),
            },
          ],
          snapshot: null,
          retries: [],
        });
      }
      if (path === '/artifacts/art_patch/download') return new Response(goodPatch);
      return hostileCloud()(input, init);
    };
    const result = await ptch(['apply', ID], { fetchImpl, cwd: dir });
    expect(result.code).toBe(1);
    expect(result.err).toContain('symbolic link');
    expect(existsSync(join(elsewhere, 'cloud'))).toBe(false);
  });
});

describe('the shared sanitisers', () => {
  const payloads = { OSC52, OSC0, DCS, APC, PM, SOS, CLEAR, C1, BIDI, CR, HOSTILE };

  for (const [name, payload] of Object.entries(payloads)) {
    it(`toDisplayText removes ${name}`, () => {
      const cleaned = toDisplayText(`before${payload}after`);
      expect(leaked(cleaned)).toBeNull();
      expect(cleaned.startsWith('before')).toBe(true);
    });
    it(`cleanTerminalOutput removes ${name} but keeps Patch's own colours`, () => {
      const cleaned = cleanTerminalOutput(
        `\u001b[32mgreen\u001b[39m ${payload} \u001b[1mbold\u001b[22m`,
      );
      expect(leaked(cleaned)).toBeNull();
      expect(cleaned).toContain('\u001b[32mgreen\u001b[39m');
      expect(cleaned).toContain('\u001b[1mbold\u001b[22m');
    });
  }

  it('drops style sequences Patch does not use (conceal, 256-colour, cursor moves)', () => {
    expect(cleanTerminalOutput('a\u001b[8mhidden\u001b[0mb')).not.toContain('[8m');
    expect(cleanTerminalOutput('a\u001b[38;5;196mred\u001b[0mb')).not.toContain('38;5');
    expect(cleanTerminalOutput('a\u001b[10Ab\u001b[2Kc')).toBe('abc');
  });

  it('handles sequences that are cut short or nested, and never leaves an ESC', () => {
    for (const text of [
      '\u001b',
      '\u001b[',
      '\u001b]0;never ends',
      '\u001b[31\u001b[2J',
      'x\u001b\u0001]0;y\u0007',
      '\u001bP',
      '\u001b[\u001b[1m2J',
    ]) {
      // what may remain is a plain colour of the kind Patch uses
      expect(cleanTerminalOutput(text).replace(/\u001b\[[0-9;]*m/g, '')).not.toMatch(
        /[\u001b\u009b]/,
      );
      expect(toDisplayText(text)).not.toMatch(/[\u001b\u009b]/);
    }
  });

  it('keeps ordinary text, newlines and tabs', () => {
    expect(cleanTerminalOutput('one\n\ttwo — ünï')).toBe('one\n\ttwo — ünï');
    expect(toDisplayText('a\tb')).toBe('a   b');
  });

  it('renderEvent cleans every kind of event', () => {
    for (const e of EVENTS) {
      for (const verbose of [false, true]) {
        const line = renderEvent(e as never, { verbose });
        if (line !== null) expect(leaked(line)).toBeNull();
      }
    }
  });
});
