import { formatBytes, splitLines } from '@patch/shared';
import { GitCommandError, runGit, type GitRunResult } from './git.js';
import { literalPathspec, repoRelativePath } from './repo-path.js';

export interface GitCommit {
  /** Short sha. */
  sha: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  author: string;
  subject: string;
}

export interface GitDiffOptions {
  /**
   * Which changes to show:
   *  - "unstaged": work tree vs index (`git diff`)
   *  - "staged":   index vs HEAD (`git diff --cached`)
   *  - "all":      work tree vs HEAD (`git diff HEAD`); for a repo without commits, staged + unstaged
   */
  scope: 'unstaged' | 'staged' | 'all';
  /** Limit to these paths (relative to repo root or absolute). */
  paths?: string[];
  /** Return `--stat` output instead of a patch. */
  stat?: boolean;
  signal?: AbortSignal;
}

const DIFF_BASE_ARGS = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];
const STAT_ARGS = ['--stat=200', '--stat-graph-width=40'];

async function hasCommits(root: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runGit(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, signal });
  return result.exitCode === 0;
}

/**
 * The comparisons that make up a scope. "all" in a repository without commits has no HEAD to
 * compare against, so it is the staged changes followed by the unstaged ones.
 */
async function scopeComparisons(
  root: string,
  scope: GitDiffOptions['scope'],
  signal?: AbortSignal,
): Promise<string[][]> {
  switch (scope) {
    case 'unstaged':
      return [[]];
    case 'staged':
      return [['--cached']];
    case 'all':
      return (await hasCommits(root, signal)) ? [['HEAD']] : [['--cached'], []];
  }
}

function pathspecArgs(root: string, paths: string[] | undefined): string[] {
  if (!paths || paths.length === 0) return [];
  return ['--', ...paths.map((p) => literalPathspec(repoRelativePath(root, p)))];
}

async function runDiff(root: string, args: string[], signal?: AbortSignal): Promise<GitRunResult> {
  const result = await runGit(args, { cwd: root, signal });
  if (result.exitCode !== 0) throw GitCommandError.fromResult('diff', result);
  return result;
}

/** Runs git diff (no color, no external diff tool, no textconv). Returns raw unified diff text. */
export async function getGitDiff(root: string, options: GitDiffOptions): Promise<string> {
  const comparisons = await scopeComparisons(root, options.scope, options.signal);
  const pathspecs = pathspecArgs(root, options.paths);
  const format = options.stat ? STAT_ARGS : [];
  let output = '';
  for (const comparison of comparisons) {
    const result = await runDiff(
      root,
      [...DIFF_BASE_ARGS, ...format, ...comparison, ...pathspecs],
      options.signal,
    );
    output += result.stdout;
    if (result.truncated) {
      return `${output}\n... diff output exceeded ${formatBytes(Buffer.byteLength(output))} and was cut here ...\n`;
    }
  }
  return output;
}

export interface DiffFileStat {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
}

/**
 * Parses `git diff --numstat -z` output. Binary files ("-\t-") count as 0/0 with `binary: true`;
 * renames ("added\tremoved\t\0old\0new") are reported under the new path.
 */
export function parseNumstat(output: string): DiffFileStat[] {
  const fields = output.split('\0');
  const stats: DiffFileStat[] = [];
  for (let i = 0; i < fields.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(fields[i]);
    if (!match) continue;
    let path = match[3];
    if (path === '') {
      path = fields[i + 2] ?? '';
      i += 2;
    }
    if (path === '') continue;
    const binary = match[1] === '-' || match[2] === '-';
    stats.push({
      path,
      added: binary ? 0 : Number(match[1]),
      removed: binary ? 0 : Number(match[2]),
      binary,
    });
  }
  return stats;
}

function mergeStats(groups: DiffFileStat[][]): DiffFileStat[] {
  const byPath = new Map<string, DiffFileStat>();
  for (const stat of groups.flat()) {
    const existing = byPath.get(stat.path);
    if (existing) {
      existing.added += stat.added;
      existing.removed += stat.removed;
      existing.binary ||= stat.binary;
    } else {
      byPath.set(stat.path, { ...stat });
    }
  }
  return [...byPath.values()];
}

/**
 * Parses `git diff --numstat` style counts for the given scope. `paths` (relative to the repo
 * root or absolute) limits the counts like `GitDiffOptions.paths`. For "all" in a repository
 * without commits, staged and unstaged counts are summed per file (matching `getGitDiff`).
 */
export async function getDiffNumstat(
  root: string,
  scope: GitDiffOptions['scope'],
  signal?: AbortSignal,
  paths?: string[],
): Promise<DiffFileStat[]> {
  const comparisons = await scopeComparisons(root, scope, signal);
  const pathspecs = pathspecArgs(root, paths);
  const groups: DiffFileStat[][] = [];
  for (const comparison of comparisons) {
    const result = await runDiff(
      root,
      [...DIFF_BASE_ARGS, '--numstat', '-z', ...comparison, ...pathspecs],
      signal,
    );
    groups.push(parseNumstat(result.stdout));
  }
  return groups.length === 1 ? groups[0] : mergeStats(groups);
}

const DEFAULT_LOG_LIMIT = 10;
const MAX_LOG_LIMIT = 100;
const FIELD_SEPARATOR = '\x1f';
const LOG_FORMAT = '--pretty=format:%h%x1f%ad%x1f%an%x1f%s';
const NO_COMMITS = /does not have any commits|bad default revision 'HEAD'/;

/** Parses `git log --date=short --pretty=format:%h%x1f%ad%x1f%an%x1f%s` output. */
export function parseGitLog(output: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const line of splitLines(output)) {
    const [sha, date, author, ...subject] = line.split(FIELD_SEPARATOR);
    if (!sha || date === undefined || author === undefined) continue;
    commits.push({ sha, date, author, subject: subject.join(FIELD_SEPARATOR) });
  }
  return commits;
}

/** Recent commits (default 10, max 100), optionally limited to a path. [] for a repo without commits. */
export async function getGitLog(
  root: string,
  options: { limit?: number; path?: string; signal?: AbortSignal } = {},
): Promise<GitCommit[]> {
  const requested = Math.floor(options.limit ?? DEFAULT_LOG_LIMIT);
  const limit = Math.min(MAX_LOG_LIMIT, Math.max(1, requested || DEFAULT_LOG_LIMIT));
  const args = [
    'log',
    `--max-count=${limit}`,
    '--date=short',
    LOG_FORMAT,
    '--no-color',
    '--no-show-signature',
  ];
  if (options.path !== undefined) args.push(...pathspecArgs(root, [options.path]));
  const result = await runGit(args, { cwd: root, signal: options.signal });
  if (result.exitCode !== 0) {
    if (NO_COMMITS.test(result.stderr)) return [];
    throw GitCommandError.fromResult('log', result);
  }
  return parseGitLog(result.stdout);
}
