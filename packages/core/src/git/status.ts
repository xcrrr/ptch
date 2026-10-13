import { GitCommandError, runGit } from './git.js';
import {
  isCaseInsensitivePlatform,
  literalPathspec,
  relativeInside,
  toPosixPath,
} from './repo-path.js';

export type GitChange =
  | 'unmodified'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'unmerged'
  | 'untracked'
  | 'ignored';

/** How an unmerged path conflicts (from the XY code of a porcelain v2 "u" record). */
export type GitConflict =
  | 'both-modified'
  | 'both-added'
  | 'both-deleted'
  | 'added-by-us'
  | 'added-by-them'
  | 'deleted-by-us'
  | 'deleted-by-them';

export interface GitFileStatus {
  /** Path relative to the repository root, forward slashes. */
  path: string;
  /** Original path for renames/copies. */
  origPath?: string;
  /** Staged (index) state. */
  index: GitChange;
  /** Unstaged (work tree) state. */
  worktree: GitChange;
  /** Set for unmerged paths (index and worktree are then both 'unmerged'). */
  conflict?: GitConflict;
}

export interface GitStatus {
  branch: string | null;
  detached: boolean;
  /** Full HEAD oid, or null when there are no commits. */
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** True when an upstream is configured but its branch no longer exists. */
  upstreamGone?: boolean;
  files: GitFileStatus[];
}

export interface GitStatusCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  /** Distinct changed paths (any state except ignored). */
  total: number;
}

const CHANGE_CODES: Record<string, GitChange> = {
  '.': 'unmodified',
  M: 'modified',
  T: 'type-changed',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'unmerged',
};

const CONFLICT_CODES: Record<string, GitConflict> = {
  UU: 'both-modified',
  AA: 'both-added',
  DD: 'both-deleted',
  AU: 'added-by-us',
  UA: 'added-by-them',
  DU: 'deleted-by-us',
  UD: 'deleted-by-them',
};

/** Splits off the first `count` space-separated fields; the remainder (a path) may contain spaces. */
function splitFields(record: string, count: number): { fields: string[]; rest: string } | null {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const space = record.indexOf(' ', start);
    if (space === -1) return null;
    fields.push(record.slice(start, space));
    start = space + 1;
  }
  const rest = record.slice(start);
  return rest === '' ? null : { fields, rest };
}

function changePair(xy: string): { index: GitChange; worktree: GitChange } {
  return {
    index: CHANGE_CODES[xy[0] ?? '.'] ?? 'modified',
    worktree: CHANGE_CODES[xy[1] ?? '.'] ?? 'modified',
  };
}

function applyHeader(status: GitStatus, header: string, seen: { aheadBehind: boolean }): void {
  const space = header.indexOf(' ');
  const key = space === -1 ? header : header.slice(0, space);
  const value = space === -1 ? '' : header.slice(space + 1);
  switch (key) {
    case 'branch.oid':
      status.head = value === '(initial)' ? null : value;
      break;
    case 'branch.head':
      status.detached = value === '(detached)';
      status.branch = status.detached ? null : value;
      break;
    case 'branch.upstream':
      status.upstream = value;
      break;
    case 'branch.ab': {
      const match = /^\+(\d+) -(\d+)$/.exec(value);
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
        seen.aheadBehind = true;
      }
      break;
    }
  }
}

/**
 * Parses `git status --porcelain=v2 --branch -z` output (NUL-separated records, including
 * rename records whose original path is the following NUL-separated field).
 */
export function parsePorcelainV2(output: string): GitStatus {
  const status: GitStatus = {
    branch: null,
    detached: false,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
  };
  const seen = { aheadBehind: false };
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    switch (record.slice(0, 2)) {
      case '# ':
        applyHeader(status, record.slice(2), seen);
        break;
      case '1 ': {
        // 1 XY sub mH mI mW hH hI path
        const parsed = splitFields(record, 8);
        if (parsed) status.files.push({ path: parsed.rest, ...changePair(parsed.fields[1]) });
        break;
      }
      case '2 ': {
        // 2 XY sub mH mI mW hH hI Xscore path NUL origPath
        const parsed = splitFields(record, 9);
        const origPath = records[++i];
        if (parsed) {
          status.files.push({
            path: parsed.rest,
            ...(origPath ? { origPath } : {}),
            ...changePair(parsed.fields[1]),
          });
        }
        break;
      }
      case 'u ': {
        // u XY sub m1 m2 m3 mW h1 h2 h3 path
        const parsed = splitFields(record, 10);
        if (parsed) {
          const conflict = CONFLICT_CODES[parsed.fields[1]] ?? 'both-modified';
          status.files.push({
            path: parsed.rest,
            index: 'unmerged',
            worktree: 'unmerged',
            conflict,
          });
        }
        break;
      }
      case '? ':
        status.files.push({ path: record.slice(2), index: 'untracked', worktree: 'untracked' });
        break;
      case '! ':
        status.files.push({ path: record.slice(2), index: 'ignored', worktree: 'ignored' });
        break;
    }
  }
  if (status.upstream !== null && !seen.aheadBehind) status.upstreamGone = true;
  return status;
}

const STATUS_ARGS = ['status', '--porcelain=v2', '-z', '--untracked-files=normal'];

/** Runs and parses `git status --porcelain=v2 --branch -z --untracked-files=normal`. */
export async function getGitStatus(root: string, signal?: AbortSignal): Promise<GitStatus> {
  const result = await runGit([...STATUS_ARGS, '--branch'], { cwd: root, signal });
  if (result.exitCode !== 0) throw GitCommandError.fromResult('status', result);
  return parsePorcelainV2(result.stdout);
}

/** True for a real change (not unmodified, untracked, ignored, or a conflict). */
function isChange(change: GitChange): boolean {
  return (
    change !== 'unmodified' &&
    change !== 'untracked' &&
    change !== 'ignored' &&
    change !== 'unmerged'
  );
}

/** The path has changes in the index (renames, additions, ...), excluding conflicts. */
export function isStaged(file: GitFileStatus): boolean {
  return isChange(file.index);
}

/** The work tree differs from the index for this tracked path, excluding conflicts. */
export function isUnstaged(file: GitFileStatus): boolean {
  return isChange(file.worktree);
}

export function isUntracked(file: GitFileStatus): boolean {
  return file.index === 'untracked';
}

export function isConflicted(file: GitFileStatus): boolean {
  return file.index === 'unmerged' || file.worktree === 'unmerged';
}

export function countChanges(status: GitStatus): GitStatusCounts {
  const counts: GitStatusCounts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, total: 0 };
  const changedPaths = new Set<string>();
  for (const file of status.files) {
    if (file.index === 'ignored') continue;
    changedPaths.add(file.path);
    if (isUntracked(file)) counts.untracked++;
    if (isConflicted(file)) counts.conflicted++;
    if (isStaged(file)) counts.staged++;
    if (isUnstaged(file)) counts.unstaged++;
  }
  counts.total = changedPaths.size;
  return counts;
}

/**
 * Status of a single path relative to the repo (fast path for edit safety checks).
 * Returns null when the file is clean or not tracked/known.
 */
export async function getFileGitStatus(
  root: string,
  absolutePath: string,
): Promise<GitFileStatus | null> {
  const relative = relativeInside(root, absolutePath);
  if (relative === undefined || relative === '') return null;
  const target = toPosixPath(relative);
  const result = await runGit([...STATUS_ARGS, '--', literalPathspec(target)], { cwd: root });
  if (result.exitCode !== 0) throw GitCommandError.fromResult('status', result);
  const { files } = parsePorcelainV2(result.stdout);
  const fold = (value: string) =>
    isCaseInsensitivePlatform(process.platform) ? value.toLowerCase() : value;
  const wanted = fold(target);
  const exact = files.find((file) => fold(file.path) === wanted);
  if (exact) return exact;
  // An untracked directory is reported as "dir/" rather than per file.
  const containing = files.find(
    (file) => file.path.endsWith('/') && wanted.startsWith(fold(file.path)),
  );
  return containing ? { ...containing, path: target } : null;
}

/** Human summary like "2 staged, 3 modified, 1 untracked" or "clean". */
export function describeStatus(status: GitStatus): string {
  const counts = countChanges(status);
  const parts: string[] = [];
  if (counts.staged) parts.push(`${counts.staged} staged`);
  if (counts.unstaged) parts.push(`${counts.unstaged} modified`);
  if (counts.untracked) parts.push(`${counts.untracked} untracked`);
  if (counts.conflicted) parts.push(`${counts.conflicted} conflicted`);
  return parts.length > 0 ? parts.join(', ') : 'clean';
}
