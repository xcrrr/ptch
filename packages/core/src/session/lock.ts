import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';

/** The process that holds a session's lock, as recorded in its lock file. */
export interface SessionLockOwner {
  pid: number;
  hostname: string;
  /** When the lock was taken (ISO 8601). */
  acquiredAt: string;
}

/**
 * Thrown by `SessionStore.load`/`create` when another live Patch process is writing the session.
 * Two writers would interleave their appends and leave a history no provider accepts, so a
 * session has one writer at a time. The message is written for the user.
 */
export class SessionLockedError extends Error {
  override readonly name = 'SessionLockedError';
  readonly sessionId: string;
  /** The lock file; deleting it by hand overrides a lock wrongly reported as live. */
  readonly lockPath: string;
  /** Undefined when the lock file is being written right now and cannot be read yet. */
  readonly owner: SessionLockOwner | undefined;

  constructor(sessionId: string, lockPath: string, owner: SessionLockOwner | undefined) {
    super(describeLocked(sessionId, lockPath, owner));
    this.sessionId = sessionId;
    this.lockPath = lockPath;
    this.owner = owner;
  }
}

/** Why a held lock stopped being this handle's (see `SessionLock.onLost`). */
export type SessionLockLoss =
  /** A newer acquisition in this process took it over (the session was loaded again). */
  | 'reopened'
  /** Another process replaced the lock file: it judged the lock stale, or it was deleted by hand. */
  | 'taken_over';

interface LockRecord extends SessionLockOwner {
  /** Distinguishes this acquisition from any other (a pid alone can be reused). */
  token: string;
  /**
   * The holder refreshes the lock file's mtime at least this often (ms), so a lock left alone for
   * several such intervals is abandoned. Absent in locks of Patch versions without the heartbeat.
   */
  refreshMs?: number;
  /**
   * Identity of the holder process that a reused pid does not share, where the platform offers
   * one cheaply (Linux: boot id and process start time). Absent elsewhere.
   */
  startId?: string;
}

/** What a lock file holds right now. */
interface LockFileState {
  /** Raw content, compared to detect that the file changed hands. */
  content: string;
  mtimeMs: number;
  /** Undefined when the content is not a lock record (being written, or cut short by a crash). */
  record: LockRecord | undefined;
  /** The file exists but could not be read (permissions, or briefly in use on Windows). */
  unreadable?: boolean;
}

/** How often a holder refreshes the mtime of its lock files (the heartbeat). */
export const LOCK_REFRESH_MS = 30_000;
/** Refreshes a holder may miss before its lock counts as abandoned. */
const MISSED_REFRESHES_BEFORE_STALE = 6;
/** An unreadable lock file younger than this may still be being written by its owner. */
const UNREADABLE_LOCK_GRACE_MS = 10_000;
/** Tolerance when comparing a lock's time with this process's start time. */
const START_TIME_SLACK_MS = 1_000;
const LOCK_FILE_MODE = 0o600;
/** Stale-lock takeovers attempted before giving up (another process keeps winning the race). */
const MAX_ACQUIRE_ATTEMPTS = 3;
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

const HOSTNAME = hostname();
const PROCESS_STARTED_MS = Date.now() - process.uptime() * 1_000;

/** Locks held by this process (by normalized path), refreshed while held, released on exit. */
const held = new Map<string, SessionLock>();
let exitHookInstalled = false;
let heartbeat: ReturnType<typeof setInterval> | undefined;

/**
 * An exclusive advisory lock on one session, held by this process: a `<id>.lock` file next to
 * the session file, created with O_EXCL and recording the owner's pid, host, a random token and,
 * where available, an identity of the owner process that a reused pid does not share.
 *
 * - A lock held by a live process makes `acquire` throw SessionLockedError; a stale one (its
 *   holder is gone: crash, kill, power loss) is taken over. See "Staleness" below.
 * - Within one process the newest acquisition wins: the previous holder is told it lost the
 *   lock (its Session stops writing), so reopening the current session (e.g. /resume) works.
 * - While held, the lock file's mtime is refreshed every LOCK_REFRESH_MS and on every `refresh()`
 *   (Session calls it before each append). `refresh()` also notices when another process took
 *   the lock over, and the Session then stops writing instead of interleaving with the new holder.
 * - `release()` deletes the file if this handle still owns it; every lock still held is released
 *   when the process exits normally.
 *
 * Staleness. A pid alone does not identify the holder: pids are reused (quickly on Windows, and
 * all of them after a reboot), and a host can change its name (macOS does with the network). So:
 * - Same host, and no process has the recorded pid: stale at once.
 * - Same host, the pid is in use, and the lock records the holder's start identity (Linux): live
 *   only while the process with that pid is the holder; a pid reused by another program frees the
 *   lock at once.
 * - Otherwise (no cheap start identity, as on Windows and macOS; a lock written on another host,
 *   or before this host's name changed): live while the holder keeps refreshing it, stale once
 *   its mtime is older than MISSED_REFRESHES_BEFORE_STALE refresh intervals (3 minutes).
 * - Locks written by Patch versions without the heartbeat (no `refreshMs`) are judged by pid
 *   alone: on another host they are never taken over (delete the file by hand, as the error says).
 * - A lock file whose content is not a record yet (being written) is live for 10 s after it last
 *   changed.
 * Taking a stale lock over is race-free: the file is renamed aside and compared with what was
 * judged stale before it is deleted, so a lock refreshed or replaced in the meantime is kept.
 */
export class SessionLock {
  readonly path: string;
  private readonly key: string;
  private readonly record: LockRecord;
  private active = true;
  private lostListener: ((reason: SessionLockLoss) => void) | undefined;

  private constructor(path: string, key: string, record: LockRecord) {
    this.path = path;
    this.key = key;
    this.record = record;
  }

  private get token(): string {
    return this.record.token;
  }

  /** Takes the lock at `lockPath` for session `sessionId`. Throws SessionLockedError if held. */
  static acquire(lockPath: string, sessionId: string): SessionLock {
    const key = lockKey(lockPath);
    const previous = held.get(key);
    if (previous) {
      // Same process: the earlier holder stops writing either way.
      previous.lose('reopened');
      if (readLockFile(lockPath)?.record?.token === previous.token) {
        // Hand the lock over; the file (and its token) stay as they are.
        return SessionLock.hold(new SessionLock(lockPath, key, previous.record));
      }
      // The file is gone or was replaced (deleted by hand): acquire it like any other lock.
    }
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      const record = newRecord();
      if (createLockFile(lockPath, record)) {
        return SessionLock.hold(new SessionLock(lockPath, key, record));
      }
      const existing = readLockFile(lockPath);
      if (!existing) continue; // Released since: try again.
      if (holderIsLive(existing)) {
        throw new SessionLockedError(sessionId, lockPath, ownerOf(existing.record));
      }
      if (!removeStaleLock(lockPath, existing)) {
        throw new SessionLockedError(sessionId, lockPath, ownerOf(readLockFile(lockPath)?.record));
      }
    }
    throw new SessionLockedError(sessionId, lockPath, ownerOf(readLockFile(lockPath)?.record));
  }

  /**
   * True when another live process holds the lock at `lockPath` (so `acquire` would throw).
   * Free and stale locks, and locks held by this process, report false.
   */
  static heldElsewhere(lockPath: string): boolean {
    if (held.has(lockKey(lockPath))) return false;
    const existing = readLockFile(lockPath);
    if (!existing || !holderIsLive(existing)) return false;
    return !(existing.record && isThisProcess(existing.record));
  }

  private static hold(lock: SessionLock): SessionLock {
    held.set(lock.key, lock);
    installExitHook();
    startHeartbeat();
    return lock;
  }

  /** Called (once) when this handle loses the lock to a newer holder (see SessionLockLoss). */
  onLost(listener: (reason: SessionLockLoss) => void): void {
    this.lostListener = listener;
  }

  /**
   * Confirms that this handle still owns its lock file and refreshes the file's mtime, which other
   * processes judge staleness by. A lock file deleted by hand is created again (unless another
   * process has created one since). False once the lock is lost: released, reopened in this
   * process, or taken over by another process (reported through `onLost` then). Without evidence
   * of another holder (the file cannot be read or created right now) it counts as still owned.
   * Never throws.
   */
  refresh(): boolean {
    if (!this.active) return false;
    let current = readLockFile(this.path);
    if (current === undefined) {
      try {
        if (createLockFile(this.path, this.record)) return true;
      } catch {
        return true; // Nobody else can create it either.
      }
      current = readLockFile(this.path); // Another process was quicker.
      if (current === undefined) return true;
    }
    if (current.unreadable) return true;
    if (current.record?.token !== this.token) {
      this.lose('taken_over');
      return false;
    }
    touch(this.path);
    return true;
  }

  /** Deletes the lock file if this handle still owns it. Idempotent; never throws. */
  release(): void {
    if (!this.active) return;
    this.deactivate();
    const current = readLockFile(this.path);
    if (current?.record?.token !== this.token) return; // Not ours any more.
    try {
      rmSync(this.path, { force: true });
    } catch {
      // A leftover lock is stale once this process exits; the next acquire takes it over.
    }
  }

  private lose(reason: SessionLockLoss): void {
    if (!this.active) return;
    this.deactivate();
    const listener = this.lostListener;
    this.lostListener = undefined;
    try {
      listener?.(reason);
    } catch {
      // The listener only records the loss; the lock is gone either way.
    }
  }

  private deactivate(): void {
    this.active = false;
    if (held.get(this.key) === this) held.delete(this.key);
    if (held.size === 0) stopHeartbeat();
  }
}

function describeLocked(
  sessionId: string,
  lockPath: string,
  owner: SessionLockOwner | undefined,
): string {
  const where =
    owner === undefined
      ? ''
      : owner.hostname !== HOSTNAME
        ? ` (pid ${owner.pid} on ${owner.hostname})`
        : ` (pid ${owner.pid})`;
  return (
    `Session ${sessionId} is open in another Patch process${where}. ` +
    `Close that Patch first, or start a new session. ` +
    `If no other Patch process is using it, delete ${lockPath} and try again.`
  );
}

function newRecord(): LockRecord {
  const startId = ownStartId();
  return {
    pid: process.pid,
    hostname: HOSTNAME,
    acquiredAt: new Date().toISOString(),
    token: randomUUID(),
    refreshMs: LOCK_REFRESH_MS,
    ...(startId !== undefined ? { startId } : {}),
  };
}

/** Creates the lock file exclusively. False when it already exists. */
function createLockFile(lockPath: string, record: LockRecord): boolean {
  try {
    writeFileSync(lockPath, `${JSON.stringify(record)}\n`, {
      flag: 'wx',
      mode: LOCK_FILE_MODE,
    });
    return true;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    throw error;
  }
}

/** Undefined when there is no lock file. */
function readLockFile(lockPath: string): LockFileState | undefined {
  let content: string;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
    content = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    // Unreadable: report it as live (fresh) so it is never removed by mistake.
    return { content: '', mtimeMs: Date.now(), record: undefined, unreadable: true };
  }
  return { content, mtimeMs, record: parseRecord(content) };
}

function parseRecord(content: string): LockRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const {
    pid,
    hostname: host,
    acquiredAt,
    token,
    refreshMs,
    startId,
  } = value as Record<string, unknown>;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof host !== 'string' || typeof acquiredAt !== 'string' || typeof token !== 'string') {
    return undefined;
  }
  return {
    pid,
    hostname: host,
    acquiredAt,
    token,
    ...(typeof refreshMs === 'number' && Number.isFinite(refreshMs) && refreshMs > 0
      ? { refreshMs }
      : {}),
    ...(typeof startId === 'string' && startId !== '' ? { startId } : {}),
  };
}

function ownerOf(record: LockRecord | undefined): SessionLockOwner | undefined {
  if (!record) return undefined;
  return { pid: record.pid, hostname: record.hostname, acquiredAt: record.acquiredAt };
}

/** The staleness policy; see "Staleness" on SessionLock. */
function holderIsLive(lock: LockFileState): boolean {
  const { record } = lock;
  if (!record) return ageOf(lock) < UNREADABLE_LOCK_GRACE_MS;
  // Locks of versions without the heartbeat cannot be judged by age.
  const refreshed =
    record.refreshMs === undefined ||
    ageOf(lock) < record.refreshMs * MISSED_REFRESHES_BEFORE_STALE;
  // Processes on another machine cannot be checked (nor can this one's from before a rename).
  if (record.hostname !== HOSTNAME) return refreshed;
  if (record.pid === process.pid) return isThisProcess(record);
  if (!processExists(record.pid)) return false;
  if (record.startId !== undefined) {
    const current = startIdOf(record.pid);
    if (current !== undefined) return current === record.startId;
  }
  // The pid is in use, possibly by an unrelated program that was given the dead holder's pid.
  return refreshed;
}

/** Milliseconds since the lock file last changed (negative when its mtime is in the future). */
function ageOf(lock: LockFileState): number {
  return Date.now() - lock.mtimeMs;
}

/**
 * A lock with this process's pid taken after this process started belongs to it (another module
 * instance or worker thread); one taken earlier was left by a dead process that had the same pid.
 */
function isThisProcess(record: LockRecord): boolean {
  if (record.hostname !== HOSTNAME || record.pid !== process.pid) return false;
  const acquired = Date.parse(record.acquiredAt);
  return Number.isFinite(acquired) && acquired >= PROCESS_STARTED_MS - START_TIME_SLACK_MS;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return errorCode(error) === 'EPERM';
  }
}

let cachedBootId: string | null | undefined;
let cachedOwnStartId: string | null | undefined;

function ownStartId(): string | undefined {
  cachedOwnStartId ??= startIdOf(process.pid) ?? null;
  return cachedOwnStartId ?? undefined;
}

/**
 * An identity of the process with `pid` that a later process given the same pid does not share:
 * on Linux, the boot id and the process's start time (clock ticks since boot, field 22 of
 * /proc/<pid>/stat). Undefined where no cheap source exists (Windows, macOS) or on failure.
 */
function startIdOf(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  cachedBootId ??= readTrimmed('/proc/sys/kernel/random/boot_id') ?? null;
  if (cachedBootId === null) return undefined;
  const stat = readTrimmed(`/proc/${pid}/stat`);
  if (stat === undefined) return undefined;
  // "pid (comm) state ppid ...": comm may contain spaces and parentheses, so split after it.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const startTime = fields[19]; // fields[0] is field 3 (state), so field 22 is fields[19].
  return startTime !== undefined && /^\d+$/.test(startTime)
    ? `${cachedBootId}:${startTime}`
    : undefined;
}

function readTrimmed(path: string): string | undefined {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

/** Sets the file's mtime to now. Best effort: a missed refresh only shortens the grace period. */
function touch(path: string): void {
  const now = new Date();
  try {
    utimesSync(path, now, now);
  } catch {
    // Checked again on the next refresh.
  }
}

/**
 * Removes a stale lock file without ever deleting a lock another process took (or its holder
 * refreshed) in the meantime: the file is first renamed aside (atomic, so only one contender gets
 * it) and then compared with what was judged stale. True when the stale lock is gone; false when
 * a live lock was found (it is put back).
 */
function removeStaleLock(lockPath: string, stale: LockFileState): boolean {
  const aside = `${lockPath}.${randomUUID()}.stale`;
  try {
    renameSync(lockPath, aside);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return true; // Someone else removed it already.
    // Open in another process right now (Windows), e.g. its holder refreshing it: in use.
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return false;
    throw error;
  }
  const moved = readLockFile(aside);
  if (moved && (moved.content !== stale.content || moved.mtimeMs !== stale.mtimeMs)) {
    // Another process replaced the stale lock with its own, or the holder refreshed it, between
    // our read and the rename.
    try {
      writeFileSync(lockPath, moved.content, { flag: 'wx', mode: LOCK_FILE_MODE });
    } catch {
      // A third process holds it now; either way the session is in use.
    }
    rmSync(aside, { force: true });
    return false;
  }
  rmSync(aside, { force: true });
  return true;
}

function startHeartbeat(): void {
  if (heartbeat !== undefined) return;
  heartbeat = setInterval(() => {
    // A lock lost here is reported through onLost; its Session stops writing.
    for (const lock of [...held.values()]) lock.refresh();
  }, LOCK_REFRESH_MS);
  // Never keeps the process alive by itself.
  heartbeat.unref();
}

function stopHeartbeat(): void {
  if (heartbeat === undefined) return;
  clearInterval(heartbeat);
  heartbeat = undefined;
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const lock of [...held.values()]) lock.release();
  });
}

function lockKey(lockPath: string): string {
  const resolved = resolve(lockPath);
  return CASE_INSENSITIVE_PATHS ? resolved.toLowerCase() : resolved;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
