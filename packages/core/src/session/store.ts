import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { addUsage, emptyUsage, type Message, type Usage } from '@patch/shared';
import { SessionLock } from './lock.js';
import {
  NO_MESSAGES_TITLE,
  compactionSummaryMessage,
  parseSessionFile,
  scanSessionFile,
  serializeEntry,
  titleFromMessage,
  type SessionFileScan,
} from './parse.js';
import {
  SESSION_FORMAT_VERSION,
  type AppendableEntry,
  type SessionEntry,
  type SessionMeta,
} from './schema.js';

export { SessionLockedError, type SessionLockOwner } from './lock.js';

const SESSION_FILE_EXTENSION = '.jsonl';
const LOCK_FILE_EXTENSION = '.lock';
/** Sessions can contain source code and command output: keep them private to the user. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** Characters allowed in a session id (and therefore in its file name). */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

export interface SessionSummary {
  id: string;
  /** First user message, one line, ≤ 80 chars ("(no messages)" if none). */
  title: string;
  createdAt: string;
  /** Timestamp of the last entry (falls back to file mtime). */
  updatedAt: string;
  cwd: string;
  projectRoot: string;
  branch: string | null;
  model: string;
  /** Number of user + assistant message entries. */
  messageCount: number;
  /** False when the recorded project directory no longer exists. */
  projectExists: boolean;
  filePath: string;
}

export type NewSessionMeta = Omit<SessionMeta, 'type' | 'v' | 'id' | 'createdAt'>;

/**
 * JSONL session storage: one file per session at `<dir>/<id>.jsonl`. The first line is the meta
 * entry; each later line is one entry. Appends are synchronous (appendFileSync) so a crash
 * never loses acknowledged entries and ordering is preserved. Directory created on demand.
 *
 * One writer per session: `create` and `load` take an exclusive lock (`<dir>/<id>.lock`, see
 * SessionLock), and `load` throws SessionLockedError, whose message is written for the user,
 * while another live Patch process has the session open. Two writers would interleave their
 * appends and leave a history no provider accepts. `Session.close()` releases the lock (call it
 * when switching to another session); locks still held are released when the process exits, and
 * a lock whose process is gone (or that its holder stopped refreshing, see SessionLock) is taken
 * over. Within one process the newest `load` of a session wins: earlier Session objects for it
 * stop accepting appends, as does a Session whose lock another process took over.
 */
export class SessionStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * Creates and persists a new session (meta line written immediately). The returned Session
   * holds the session's lock.
   */
  create(meta: NewSessionMeta): Session {
    const identity = {
      type: 'meta',
      v: SESSION_FORMAT_VERSION,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    } as const;
    // Identity first (key order), then re-applied so a caller passing a whole SessionMeta (for
    // example `{ ...previous.meta, model }`) can never reuse another session's id.
    const full: SessionMeta = { ...identity, ...meta, ...identity };
    mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
    const filePath = this.pathFor(full.id);
    const lock = SessionLock.acquire(this.lockPathFor(full.id), full.id);
    try {
      writeFileSync(filePath, serializeEntry(full), { mode: FILE_MODE, flag: 'wx' });
    } catch (error) {
      lock.release();
      throw error;
    }
    return new Session(filePath, full, [full], { lock });
  }

  /**
   * Loads a session by full id for writing: the returned Session holds the session's lock.
   * Throws SessionNotFoundError if missing or unreadable meta, and SessionLockedError while
   * another live Patch process has the session open.
   */
  load(id: string): Session {
    if (!SESSION_ID_PATTERN.test(id)) {
      throw new SessionNotFoundError(`"${id}" is not a valid session id.`);
    }
    const filePath = this.pathFor(id);
    try {
      statSync(filePath);
    } catch (error) {
      throw new SessionNotFoundError(describeReadFailure(id, error));
    }
    // Lock before reading, so everything a previous writer appended is on disk by then.
    const lock = SessionLock.acquire(this.lockPathFor(id), id);
    try {
      let content: string;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch (error) {
        throw new SessionNotFoundError(describeReadFailure(id, error));
      }
      const parsed = parseSessionFile(content, id);
      if ('problem' in parsed) {
        throw new SessionNotFoundError(
          `Session ${id} cannot be loaded: ${parsed.problem} (${filePath}).`,
        );
      }
      return new Session(filePath, parsed.meta, parsed.entries, {
        unterminated: parsed.unterminated,
        lock,
      });
    } catch (error) {
      lock.release();
      throw error;
    }
  }

  /**
   * True while another live Patch process has the session open, so `load(id)` would throw
   * SessionLockedError (for example to skip it when choosing a session to continue).
   */
  isOpenElsewhere(id: string): boolean {
    if (!SESSION_ID_PATTERN.test(id)) return false;
    return SessionLock.heldElsewhere(this.lockPathFor(id));
  }

  /**
   * Resolves a full id or unique prefix (hyphens ignored, case-insensitive).
   * Returns `{ id }`, `{ error: 'not_found' }` or `{ error: 'ambiguous', matches }`.
   */
  resolve(
    idOrPrefix: string,
  ): { id: string } | { error: 'not_found' } | { error: 'ambiguous'; matches: string[] } {
    const wanted = idKey(idOrPrefix.trim());
    if (wanted === '' || !SESSION_ID_PATTERN.test(wanted)) return { error: 'not_found' };
    const matches = this.sessionIds().filter((id) => idKey(id).startsWith(wanted));
    const exact = matches.find((id) => idKey(id) === wanted);
    if (exact !== undefined) return { id: exact };
    if (matches.length === 1) return { id: matches[0]! };
    if (matches.length === 0) return { error: 'not_found' };
    return { error: 'ambiguous', matches: matches.sort() };
  }

  /**
   * Recent sessions, newest `updatedAt` first. When `projectRoot` is given, only sessions whose
   * projectRoot matches (case-insensitive on win32/darwin). Sessions with no user message are
   * excluded unless `includeEmpty`. Must stay fast for hundreds of sessions.
   *
   * Each file is read once and only partially parsed (see `scanSessionFile`). Files that cannot
   * be read or whose meta line is invalid are skipped.
   */
  list(options?: {
    projectRoot?: string;
    limit?: number;
    includeEmpty?: boolean;
  }): SessionSummary[] {
    const rootKey = options?.projectRoot === undefined ? undefined : pathKey(options.projectRoot);
    const accept = (meta: SessionMeta): boolean =>
      rootKey === undefined || pathKey(meta.projectRoot) === rootKey;
    const projectExists = memoize((root: string) => existsSync(root));

    const summaries: SessionSummary[] = [];
    for (const id of this.sessionIds()) {
      const filePath = this.pathFor(id);
      const scan = scanFile(filePath, id, accept);
      if (!scan || (!scan.hasUserMessage && !options?.includeEmpty)) continue;
      summaries.push(toSummary(scan, filePath, projectExists(scan.meta.projectRoot)));
    }
    summaries.sort(compareNewestFirst);
    return options?.limit === undefined
      ? summaries
      : summaries.slice(0, Math.max(0, options.limit));
  }

  /** Most recent non-empty session for a project (used by --continue). */
  latestFor(projectRoot: string): SessionSummary | undefined {
    return this.list({ projectRoot, limit: 1 })[0];
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}${SESSION_FILE_EXTENSION}`);
  }

  private lockPathFor(id: string): string {
    return join(this.dir, `${id}${LOCK_FILE_EXTENSION}`);
  }

  /** Ids of all session files in the directory (empty when it does not exist yet). */
  private sessionIds(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith(SESSION_FILE_EXTENSION))
      .map((name) => name.slice(0, -SESSION_FILE_EXTENSION.length))
      .filter((id) => SESSION_ID_PATTERN.test(id));
  }
}

export class SessionNotFoundError extends Error {
  override readonly name = 'SessionNotFoundError';
}

/** Internal construction options (set by SessionStore.create/load). */
export interface SessionOptions {
  /**
   * The file does not end with a newline (a write was cut short). The next append starts on a
   * fresh line so the partial line cannot corrupt it.
   */
  unterminated?: boolean;
  /** The session's writer lock, released by `close()`. */
  lock?: SessionLock;
}

export class Session {
  readonly id: string;
  readonly meta: SessionMeta;
  readonly filePath: string;
  protected readonly entryList: SessionEntry[];
  private needsLineBreak: boolean;
  private readonly lock: SessionLock | undefined;
  /** Why appends are refused, once the session was closed or loaded again in this process. */
  private closedReason: string | undefined;

  /** Use SessionStore.create/load. */
  constructor(
    filePath: string,
    meta: SessionMeta,
    entries: SessionEntry[],
    options: SessionOptions = {},
  ) {
    this.filePath = filePath;
    this.meta = meta;
    this.id = meta.id;
    this.entryList = entries;
    this.needsLineBreak = options.unterminated ?? false;
    this.lock = options.lock;
    this.lock?.onLost((reason) => {
      this.closedReason ??=
        reason === 'reopened'
          ? `Session ${this.id} was opened again in this process; this copy can no longer write to it.`
          : `Session ${this.id} was taken over by another Patch process (its lock file was replaced); this copy can no longer write to it.`;
    });
  }

  /**
   * False after `close()`, once the session was loaded again in this process, or once another
   * process took its lock over (noticed at the latest by the next append).
   */
  get writable(): boolean {
    return this.closedReason === undefined;
  }

  /**
   * Stops writing to this session and releases its lock, so another Patch process can open it.
   * Reading stays possible; `append` throws afterwards. Idempotent.
   */
  close(): void {
    this.closedReason ??= `Session ${this.id} is closed.`;
    this.lock?.release();
  }

  /** All entries including meta, in file order. */
  entries(): readonly SessionEntry[] {
    return this.entryList;
  }

  /**
   * Appends an entry to memory and disk (synchronously). Fills `ts` if missing. The disk write
   * happens first: if it throws, the in-memory session is unchanged. Throws once the session is
   * no longer writable (see `writable`). Each append first confirms and refreshes the session's
   * lock, so a copy whose lock another process took over never writes after it.
   */
  append(entry: AppendableEntry): SessionEntry {
    if (this.closedReason === undefined && this.lock && !this.lock.refresh()) {
      this.closedReason ??= `Session ${this.id} is closed.`;
    }
    if (this.closedReason !== undefined) throw new Error(this.closedReason);
    const stored = withTimestamp(entry);
    const line = serializeEntry(stored);
    appendFileSync(this.filePath, this.needsLineBreak ? `\n${line}` : line, { mode: FILE_MODE });
    this.needsLineBreak = false;
    this.entryList.push(stored);
    return stored;
  }

  /**
   * Model context: if a compaction exists, a single user message
   * `${COMPACTION_SUMMARY_PREFIX}\n\n<summary>` followed by every message entry after the last
   * compaction; otherwise all message entries.
   *
   * Messages are the stored objects themselves (never merged or normalized) so the prefix sent to
   * the provider stays byte-identical across requests; callers must not mutate them.
   */
  history(): Message[] {
    let messages: Message[] = [];
    for (const entry of this.entryList) {
      if (entry.type === 'compaction') messages = [compactionSummaryMessage(entry.summary)];
      else if (entry.type === 'message') messages.push(entry.message);
    }
    return messages;
  }

  /** Current model: last `model` entry, else meta.model. */
  get model(): string {
    for (let i = this.entryList.length - 1; i >= 0; i--) {
      const entry = this.entryList[i]!;
      if (entry.type === 'model') return entry.model;
    }
    return this.meta.model;
  }

  /** First user message text, one line, ≤ 80 chars. */
  title(): string {
    for (const entry of this.entryList) {
      if (entry.type !== 'message') continue;
      const title = titleFromMessage(entry.message);
      if (title !== undefined) return title;
    }
    return NO_MESSAGES_TITLE;
  }

  /**
   * Tokens billed in this session: the sum of all usage entries (their `billed` usage when
   * recorded), including summary requests of compactions, also failed ones.
   */
  usageTotals(): Usage {
    let total = emptyUsage();
    for (const entry of this.entryList) {
      if (entry.type === 'usage') total = addUsage(total, entry.billed ?? entry.usage);
    }
    return total;
  }

  /**
   * Usage of the most recent request, if any, including a compaction's own summary request.
   * For the size of the current context use `usageSinceCompaction(entries())`.
   */
  lastUsage(): Usage | undefined {
    for (let i = this.entryList.length - 1; i >= 0; i--) {
      const entry = this.entryList[i]!;
      if (entry.type === 'usage') return entry.usage;
    }
    return undefined;
  }

  /** True when there is at least one user message entry. */
  hasMessages(): boolean {
    return this.entryList.some(
      (entry) => entry.type === 'message' && entry.message.role === 'user',
    );
  }
}

/** Puts `type` first (list() relies on it) and fills `ts` unless the caller supplied one. */
function withTimestamp(entry: AppendableEntry): SessionEntry {
  const { type, ts: provided, ...rest } = entry as AppendableEntry & { ts?: unknown };
  const ts = typeof provided === 'string' && provided !== '' ? provided : new Date().toISOString();
  return { type, ts, ...rest } as SessionEntry;
}

function idKey(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

/** Comparable form of a directory path: resolved, no trailing separator, case-folded if needed. */
function pathKey(path: string): string {
  const resolved = resolve(path);
  return CASE_INSENSITIVE_PATHS ? resolved.toLowerCase() : resolved;
}

function scanFile(
  filePath: string,
  id: string,
  accept: (meta: SessionMeta) => boolean,
): SessionFileScan | undefined {
  try {
    return scanSessionFile(readFileSync(filePath, 'utf8'), id, accept);
  } catch {
    return undefined;
  }
}

function toSummary(
  scan: SessionFileScan,
  filePath: string,
  projectExists: boolean,
): SessionSummary {
  const { meta } = scan;
  return {
    id: meta.id,
    title: scan.title,
    createdAt: meta.createdAt,
    updatedAt: scan.lastTimestamp ?? modifiedAt(filePath) ?? meta.createdAt,
    cwd: meta.cwd,
    projectRoot: meta.projectRoot,
    branch: meta.branch,
    model: scan.model,
    messageCount: scan.messageCount,
    projectExists,
    filePath,
  };
}

function modifiedAt(filePath: string): string | undefined {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function timeValue(iso: string): number {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}

function compareNewestFirst(a: SessionSummary, b: SessionSummary): number {
  return (
    timeValue(b.updatedAt) - timeValue(a.updatedAt) ||
    timeValue(b.createdAt) - timeValue(a.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

function memoize<T>(compute: (key: string) => T): (key: string) => T {
  const cache = new Map<string, T>();
  return (key) => {
    if (!cache.has(key)) cache.set(key, compute(key));
    return cache.get(key)!;
  };
}

function describeReadFailure(id: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return `No session with id ${id} was found.`;
  if (code === 'EACCES' || code === 'EPERM') {
    return `Session ${id} cannot be loaded: permission denied.`;
  }
  return `Session ${id} cannot be loaded: ${error instanceof Error ? error.message : String(error)}.`;
}
