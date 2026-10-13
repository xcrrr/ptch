import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCK_REFRESH_MS } from '../../src/session/lock.js';
import {
  SessionLockedError,
  SessionNotFoundError,
  SessionStore,
  type Session,
} from '../../src/session/store.js';
import { makeTempDir } from '../../src/testing/fixtures.js';
import { assistantText, newMeta, userText } from './helpers.js';

let temp: { dir: string; cleanup: () => void };
let sessionsDir: string;
let store: SessionStore;
const children: ChildProcess[] = [];

beforeEach(() => {
  temp = makeTempDir();
  sessionsDir = join(temp.dir, 'sessions');
  store = new SessionStore(sessionsDir);
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  temp.cleanup();
});

function lockPath(session: Session): string {
  return join(sessionsDir, `${session.id}.lock`);
}

/** A session on disk that no process holds (as left by a Patch that exited cleanly). */
function closedSession(): Session {
  const session = store.create(newMeta(temp.dir));
  session.append(userText('hello'));
  session.close();
  return session;
}

function writeLock(session: Session, record: Record<string, unknown>): void {
  writeFileSync(lockPath(session), `${JSON.stringify(record)}\n`);
}

function lockRecord(pid: number, overrides: Record<string, unknown> = {}) {
  return {
    pid,
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
    token: 'other-token',
    ...overrides,
  };
}

/** Older than any lock whose holder refreshes it every LOCK_REFRESH_MS may be. */
const STALE_AGE_MS = 60 * LOCK_REFRESH_MS;

/** Sets the lock file's mtime (the holder's last refresh) `ageMs` into the past. */
function setLockAge(session: Session, ageMs: number): void {
  const then = new Date(Date.now() - ageMs);
  utimesSync(lockPath(session), then, then);
}

function lockOwnerPid(session: Session): number | undefined {
  if (!existsSync(lockPath(session))) return undefined;
  return (JSON.parse(readFileSync(lockPath(session), 'utf8')) as { pid: number }).pid;
}

/** A live process that is not this one (stands in for another Patch). */
function liveProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((done) => child.once('exit', done));
  return child.pid!;
}

describe('session writer lock', () => {
  it('refuses to load a session another live process is writing, with a clear message', () => {
    const session = closedSession();
    const other = liveProcess();
    writeLock(session, lockRecord(other.pid!));

    expect(store.isOpenElsewhere(session.id)).toBe(true);
    let error: unknown;
    try {
      store.load(session.id);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SessionLockedError);
    const locked = error as SessionLockedError;
    expect(locked.message).toBe(
      `Session ${session.id} is open in another Patch process (pid ${other.pid}). ` +
        'Close that Patch first, or start a new session. ' +
        `If no other Patch process is using it, delete ${lockPath(session)} and try again.`,
    );
    expect(locked).toMatchObject({ sessionId: session.id, lockPath: lockPath(session) });
    expect(locked.owner).toMatchObject({ pid: other.pid, hostname: hostname() });
    // The other process's lock is left alone.
    expect(lockOwnerPid(session)).toBe(other.pid);
  });

  it('takes over a lock left by a process that died', async () => {
    const session = closedSession();
    const pid = await deadPid();
    writeLock(session, lockRecord(pid));

    expect(store.isOpenElsewhere(session.id)).toBe(false);
    const loaded = store.load(session.id);
    expect(lockOwnerPid(session)).toBe(process.pid);
    loaded.append(assistantText('after takeover'));
    loaded.close();
    expect(existsSync(lockPath(session))).toBe(false);
    // No stray files from the takeover.
    expect(readdirSync(sessionsDir)).toEqual([`${session.id}.jsonl`]);
  });

  it('takes over a lock left by an earlier process that had this pid', () => {
    const session = closedSession();
    writeLock(session, lockRecord(process.pid, { acquiredAt: '2020-01-01T00:00:00.000Z' }));
    expect(() => store.load(session.id).close()).not.toThrow();
  });

  it('refuses a lock held on another host, whose process cannot be checked', () => {
    const session = closedSession();
    writeLock(session, lockRecord(4242, { hostname: `${hostname()}-elsewhere` }));
    expect(() => store.load(session.id)).toThrow(`(pid 4242 on ${hostname()}-elsewhere)`);
  });

  it('treats an unreadable lock as being written unless it is old', () => {
    const session = closedSession();
    writeFileSync(lockPath(session), '');
    expect(() => store.load(session.id)).toThrow(SessionLockedError);

    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath(session), old, old);
    expect(() => store.load(session.id).close()).not.toThrow();
  });

  it('holds the lock from create until close, then refuses appends', () => {
    const session = store.create(newMeta(temp.dir));
    expect(lockOwnerPid(session)).toBe(process.pid);
    expect(session.writable).toBe(true);
    expect(store.isOpenElsewhere(session.id)).toBe(false); // held by this process

    session.close();
    session.close(); // idempotent
    expect(existsSync(lockPath(session))).toBe(false);
    expect(session.writable).toBe(false);
    expect(() => session.append(userText('late'))).toThrow(`Session ${session.id} is closed.`);
    expect(session.entries()).toHaveLength(1);
  });

  it('in one process, the newest load wins and earlier copies stop writing', () => {
    const first = store.create(newMeta(temp.dir));
    first.append(userText('one'));
    const second = store.load(first.id);

    expect(first.writable).toBe(false);
    expect(() => first.append(userText('stale copy'))).toThrow(/opened again in this process/);
    second.append(assistantText('two'));

    // Closing the superseded copy does not release the lock the newer copy holds.
    first.close();
    expect(lockOwnerPid(second)).toBe(process.pid);
    second.close();
    expect(existsSync(lockPath(second))).toBe(false);
    const reloaded = store.load(first.id);
    expect(reloaded.history()).toHaveLength(2);
    reloaded.close();
  });

  it('does not hand over a lock that was deleted by hand and taken by another process', () => {
    const first = store.create(newMeta(temp.dir));
    const other = liveProcess();
    writeLock(first, lockRecord(other.pid!)); // replaces this process's lock file

    expect(() => store.load(first.id)).toThrow(SessionLockedError);
    expect(first.writable).toBe(false);
    expect(lockOwnerPid(first)).toBe(other.pid);
  });

  it('takes over a lock whose pid another program now has, once its holder stopped refreshing it', () => {
    const session = closedSession();
    // The holder died and its pid went to an unrelated process (common on Windows).
    const unrelated = liveProcess();
    writeLock(session, lockRecord(unrelated.pid!, { refreshMs: LOCK_REFRESH_MS }));
    expect(store.isOpenElsewhere(session.id)).toBe(true); // Refreshed recently: may be live.

    setLockAge(session, STALE_AGE_MS);
    expect(store.isOpenElsewhere(session.id)).toBe(false);
    const loaded = store.load(session.id);
    expect(lockOwnerPid(session)).toBe(process.pid);
    loaded.close();
  });

  it('takes over a lock from another host name once it is no longer refreshed', () => {
    const session = closedSession();
    // Written on this machine before its name changed, or on another machine sharing the folder.
    writeLock(
      session,
      lockRecord(4242, { hostname: `${hostname()}-old`, refreshMs: LOCK_REFRESH_MS }),
    );
    expect(() => store.load(session.id)).toThrow(`(pid 4242 on ${hostname()}-old)`);

    setLockAge(session, STALE_AGE_MS);
    store.load(session.id).close();
  });

  it('judges locks of versions without the heartbeat by pid and host alone', () => {
    const session = closedSession();
    writeLock(session, lockRecord(liveProcess().pid!));
    setLockAge(session, 24 * 60 * 60_000);
    expect(() => store.load(session.id)).toThrow(SessionLockedError);

    writeLock(session, lockRecord(4242, { hostname: `${hostname()}-elsewhere` }));
    setLockAge(session, 24 * 60 * 60_000);
    expect(() => store.load(session.id)).toThrow(SessionLockedError);
  });

  it('refreshes a held lock on every append', () => {
    const session = store.create(newMeta(temp.dir));
    setLockAge(session, STALE_AGE_MS);
    expect(store.isOpenElsewhere(session.id)).toBe(false); // Held by this process.

    session.append(userText('hello'));
    expect(Date.now() - statSync(lockPath(session)).mtimeMs).toBeLessThan(60_000);
    session.close();
  });

  it('re-creates its lock file when it was deleted by hand', () => {
    const session = store.create(newMeta(temp.dir));
    rmSync(lockPath(session));
    session.append(userText('hello'));
    expect(lockOwnerPid(session)).toBe(process.pid);
    session.close();
    expect(existsSync(lockPath(session))).toBe(false);
  });

  it('stops writing once another process took its lock over', () => {
    const session = store.create(newMeta(temp.dir));
    session.append(userText('hello'));
    // Another process judged the lock stale (e.g. this one was suspended) and replaced it.
    const other = liveProcess();
    writeLock(session, lockRecord(other.pid!, { refreshMs: LOCK_REFRESH_MS }));

    expect(() => session.append(userText('after the takeover'))).toThrow(
      `Session ${session.id} was taken over by another Patch process`,
    );
    expect(session.writable).toBe(false);
    expect(readFileSync(session.filePath, 'utf8')).not.toContain('after the takeover');
    session.close();
    expect(lockOwnerPid(session)).toBe(other.pid); // Not released: it is not ours.
  });

  describe('heartbeat', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('keeps an idle lock fresh, and notices a takeover while idle', () => {
      const session = store.create(newMeta(temp.dir));
      setLockAge(session, STALE_AGE_MS);
      vi.advanceTimersByTime(LOCK_REFRESH_MS);
      expect(Date.now() - statSync(lockPath(session)).mtimeMs).toBeLessThan(60_000);

      writeLock(session, lockRecord(liveProcess().pid!, { refreshMs: LOCK_REFRESH_MS }));
      vi.advanceTimersByTime(LOCK_REFRESH_MS);
      expect(session.writable).toBe(false);
      session.close();
    });

    it('stops once no lock is held', () => {
      const session = store.create(newMeta(temp.dir));
      expect(vi.getTimerCount()).toBe(1);
      session.close();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('leaves no lock behind when a load fails', () => {
    expect(() => store.load('00000000-0000-0000-0000-000000000000')).toThrow(SessionNotFoundError);
    const session = closedSession();
    writeFileSync(session.filePath, 'not a session');
    expect(() => store.load(session.id)).toThrow(SessionNotFoundError);
    expect(readdirSync(sessionsDir)).toEqual([`${session.id}.jsonl`]);
  });

  const canRunTypeScript = Boolean(
    (process.features as { typescript?: string | false }).typescript,
  );

  it.runIf(canRunTypeScript)(
    'prevents two processes from writing one session, and frees it when the other exits',
    async () => {
      const session = closedSession();
      const holder = await holdLockInChild(lockPath(session), session.id);

      expect(() => store.load(session.id)).toThrow(SessionLockedError);
      expect(store.isOpenElsewhere(session.id)).toBe(true);

      // A normal exit releases the lock.
      holder.stdin!.end();
      await new Promise((done) => holder.once('exit', done));
      expect(existsSync(lockPath(session))).toBe(false);
      store.load(session.id).close();
    },
  );

  it.runIf(canRunTypeScript)('takes over from a holder that was killed', async () => {
    const session = closedSession();
    const holder = await holdLockInChild(lockPath(session), session.id);
    expect(() => store.load(session.id)).toThrow(SessionLockedError);

    holder.kill('SIGKILL');
    await new Promise((done) => holder.once('exit', done));
    expect(existsSync(lockPath(session))).toBe(true); // a kill runs no exit hooks
    const loaded = store.load(session.id);
    expect(lockOwnerPid(session)).toBe(process.pid);
    loaded.close();
  });

  it.runIf(canRunTypeScript && process.platform === 'linux')(
    'on Linux, tells the holder from a process that reused its pid by its start time',
    async () => {
      const session = closedSession();
      await holdLockInChild(lockPath(session), session.id);
      // Not refreshed for long (suspended, say), but provably the same process: still live.
      setLockAge(session, STALE_AGE_MS);
      expect(() => store.load(session.id)).toThrow(SessionLockedError);

      // The same pid with another start time: the holder is gone and its pid was reused.
      const record = JSON.parse(readFileSync(lockPath(session), 'utf8')) as { startId: string };
      expect(record.startId).toMatch(/^[0-9a-f-]+:\d+$/);
      writeLock(session, { ...record, startId: `${record.startId}0` });
      store.load(session.id).close();
    },
  );
});

/** Starts a Node process that takes the lock with the real SessionLock and holds it. */
async function holdLockInChild(path: string, sessionId: string): Promise<ChildProcess> {
  const lockModule = pathToFileURL(
    join(fileURLToPath(new URL('.', import.meta.url)), '../../src/session/lock.ts'),
  ).href;
  const script = [
    `const { SessionLock } = await import(${JSON.stringify(lockModule)});`,
    `SessionLock.acquire(${JSON.stringify(path)}, ${JSON.stringify(sessionId)});`,
    `process.stdout.write('locked\\n');`,
    `process.stdin.resume();`,
    `process.stdin.on('end', () => process.exit(0));`,
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  children.push(child);
  await new Promise<void>((done, fail) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('locked')) done();
    });
    child.once('exit', (code) => fail(new Error(`lock holder exited early (${code})`)));
  });
  return child;
}
