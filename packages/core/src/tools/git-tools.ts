import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { formatCount, plural, truncateMiddle } from '@patch/shared';
import { z } from 'zod';
import type { ResolvedPath } from '../fs/paths.js';
import { GitCommandError, GitUnavailableError } from '../git/git.js';
import { getDiffNumstat, getGitDiff, getGitLog, type GitDiffOptions } from '../git/history.js';
import { isCaseInsensitivePlatform, relativeInside, toPosixPath } from '../git/repo-path.js';
import {
  countChanges,
  getGitStatus,
  isConflicted,
  isStaged,
  isUnstaged,
  isUntracked,
  type GitChange,
  type GitConflict,
  type GitFileStatus,
  type GitStatus,
} from '../git/status.js';
import { defineTool, ToolError, type PermissionSubject, type ToolContext } from './types.js';

const NOT_A_REPOSITORY = 'Not a Git repository (Patch is running in directory mode).';

function requireGitRoot(ctx: ToolContext): string {
  if (ctx.gitRoot === null) throw new ToolError(NOT_A_REPOSITORY);
  return ctx.gitRoot;
}

async function resolveInRepository(
  ctx: ToolContext,
  root: string,
  input: string,
): Promise<ResolvedPath> {
  const resolved = await ctx.paths.resolve(input);
  if (relativeInside(root, resolved.absolute) === undefined) {
    throw new ToolError(`${resolved.display} is outside the Git repository (${root}).`);
  }
  return resolved;
}

/** The path a call is limited to; undefined when there is none or it is the repository root. */
async function resolvePathFilter(
  ctx: ToolContext,
  root: string,
  input: string | undefined,
): Promise<ResolvedPath | undefined> {
  if (input === undefined) return undefined;
  const resolved = await resolveInRepository(ctx, root, input);
  return relativeInside(root, resolved.absolute) === '' ? undefined : resolved;
}

/** Read access to the repository root, or to `input` when the call is limited to a path. */
async function readPermission(ctx: ToolContext, input?: string): Promise<PermissionSubject> {
  const root = requireGitRoot(ctx);
  const target =
    input === undefined
      ? await ctx.paths.resolve(root)
      : await resolveInRepository(ctx, root, input);
  return { kind: 'read', paths: [target] };
}

/** Runs git operations, turning expected git failures into errors the model can act on. */
async function withGitErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GitUnavailableError) {
      throw new ToolError('Git is not installed or not on PATH, so Git tools cannot run.');
    }
    if (error instanceof GitCommandError) throw new ToolError(error.message);
    throw error;
  }
}

/** Maps a root-relative git path to the form shown to the model. */
export type PathFormatter = (repoPath: string) => string;

/**
 * Formats root-relative git paths relative to the working directory, with forward slashes.
 * Untracked directories keep their trailing slash.
 */
async function createPathFormatter(ctx: ToolContext, root: string): Promise<PathFormatter> {
  let base = ctx.cwd;
  if (relativeInside(root, base) === undefined) {
    // cwd reaches the repository through a symlink or junction; use its real location.
    const real = await realpath(ctx.cwd).catch(() => undefined);
    base = real !== undefined && relativeInside(root, real) !== undefined ? real : root;
  }
  return (repoPath) => {
    const absolute = path.join(root, ...repoPath.split('/'));
    const relative = toPosixPath(path.relative(base, absolute)) || '.';
    return repoPath.endsWith('/') && relative !== '.' ? `${relative}/` : relative;
  };
}

/** Indented list of at most `max` entries, then an explicit count of the rest. */
function cappedList(entries: string[], max: number): string[] {
  const lines = entries.slice(0, max).map((entry) => `  ${entry}`);
  if (entries.length > max) lines.push(`  ... ${formatCount(entries.length - max)} more`);
  return lines;
}

// ---------------------------------------------------------------------------------------------
// git_status

const MAX_STATUS_ENTRIES_PER_SECTION = 200;

const CHANGE_LABELS: Record<GitChange, string> = {
  unmodified: 'unmodified',
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  'type-changed': 'type changed',
  unmerged: 'conflicted',
  untracked: 'untracked',
  ignored: 'ignored',
};

const CONFLICT_LABELS: Record<GitConflict, string> = {
  'both-modified': 'both modified',
  'both-added': 'both added',
  'both-deleted': 'both deleted',
  'added-by-us': 'added by us',
  'added-by-them': 'added by them',
  'deleted-by-us': 'deleted by us',
  'deleted-by-them': 'deleted by them',
};

function describeTracking(status: GitStatus): string {
  if (status.upstreamGone) return 'upstream gone';
  const { ahead, behind } = status;
  if (ahead > 0 && behind > 0) return `ahead ${ahead}, behind ${behind}`;
  if (ahead > 0) return `ahead ${ahead}`;
  if (behind > 0) return `behind ${behind}`;
  return 'up to date';
}

function describeBranchLine(status: GitStatus): string {
  if (status.detached) {
    return `HEAD detached at ${status.head ? status.head.slice(0, 7) : 'an unknown commit'}`;
  }
  const onBranch = `On branch ${status.branch ?? '(unknown)'}`;
  if (status.head === null) return `${onBranch} (no commits yet)`;
  if (status.upstream === null) return `${onBranch} (no upstream)`;
  return `${onBranch}, tracking ${status.upstream} (${describeTracking(status)})`;
}

function describeChange(change: GitChange, file: GitFileStatus, format: PathFormatter): string {
  const origin = change === 'renamed' || change === 'copied' ? file.origPath : undefined;
  const target =
    origin === undefined ? format(file.path) : `${format(origin)} -> ${format(file.path)}`;
  return `${CHANGE_LABELS[change]}: ${target}`;
}

function section(title: string, entries: string[]): string[] {
  if (entries.length === 0) return [];
  return [`${title}:`, ...cappedList(entries, MAX_STATUS_ENTRIES_PER_SECTION)];
}

/** Renders a status as the branch line followed by Staged/Unstaged/Untracked/Conflicts sections. */
export function formatGitStatus(status: GitStatus, format: PathFormatter): string {
  const files = status.files;
  const staged = files.filter(isStaged).map((f) => describeChange(f.index, f, format));
  const unstaged = files.filter(isUnstaged).map((f) => describeChange(f.worktree, f, format));
  const untracked = files.filter(isUntracked).map((f) => format(f.path));
  const conflicts = files
    .filter(isConflicted)
    .map((f) => `${f.conflict ? CONFLICT_LABELS[f.conflict] : 'conflicted'}: ${format(f.path)}`);
  const sections = [
    ...section('Staged', staged),
    ...section('Unstaged', unstaged),
    ...section('Untracked', untracked),
    ...section('Conflicts', conflicts),
  ];
  const body = sections.length > 0 ? sections : ['Working tree clean.'];
  return [describeBranchLine(status), ...body].join('\n');
}

export const gitStatusInput = z.object({});

/**
 * Structured status: a branch / upstream / ahead-behind line, then sections "Staged:",
 * "Unstaged:", "Untracked:", "Conflicts:" with one entry per line ("  modified: src/a.ts",
 * "  renamed: a -> b"). Paths relative to the working directory. "Working tree clean." when clean.
 * Not a git repo (ctx.gitRoot null) → ToolError("Not a Git repository (Patch is running in
 * directory mode).").
 * Display: verb "git", target "status", summary "3 changed" / "clean". Permission: read of root.
 */
export const gitStatusTool = defineTool({
  name: 'git_status',
  description:
    'Show the current Git branch, upstream tracking, and staged, unstaged, untracked, and conflicted files.',
  inputSchema: gitStatusInput,
  permissionClass: 'read',
  summarize() {
    return { verb: 'git', target: 'status' };
  },
  permission(_input, ctx) {
    return readPermission(ctx);
  },
  async execute(_input, ctx) {
    const root = requireGitRoot(ctx);
    const status = await withGitErrors(() => getGitStatus(root, ctx.signal));
    const format = await createPathFormatter(ctx, root);
    const { total } = countChanges(status);
    return {
      content: formatGitStatus(status, format),
      display: { summary: total > 0 ? `${formatCount(total)} changed` : 'clean' },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// git_diff

const MAX_DIFF_LINES = 1500;
const MAX_DIFF_CHARS = 60_000;
const MAX_DIFF_LINE_CHARS = 2_000;
const MAX_UNTRACKED_LISTED = 50;

const NO_CHANGES: Record<GitDiffOptions['scope'], string> = {
  all: 'No uncommitted changes to tracked files',
  staged: 'No staged changes',
  unstaged: 'No unstaged changes',
};

function truncateDiff(diff: string, stat: boolean): string {
  const result = truncateMiddle(diff, {
    maxLines: MAX_DIFF_LINES,
    maxChars: MAX_DIFF_CHARS,
    maxLineChars: MAX_DIFF_LINE_CHARS,
  });
  if (!result.truncated) return result.text;
  const hint = stat
    ? 'Pass `path` to focus on one file or directory.'
    : 'Pass `path` to focus on one file or directory, or `stat: true` for a per-file overview.';
  return `${result.text}\n\n[Diff truncated: ${formatCount(result.totalLines)} lines in total, the middle was omitted. ${hint}]`;
}

/** True when an untracked entry ("dir/" or a file) and the requested path overlap. */
function overlapsPath(entry: string, target: string): boolean {
  if (target === '') return true;
  const fold = (value: string) =>
    isCaseInsensitivePlatform(process.platform) ? value.toLowerCase() : value;
  const item = fold(entry.replace(/\/$/, ''));
  const wanted = fold(target);
  return item === wanted || item.startsWith(`${wanted}/`) || wanted.startsWith(`${item}/`);
}

async function listUntracked(
  root: string,
  target: string | undefined,
  signal: AbortSignal,
): Promise<string[]> {
  const status = await getGitStatus(root, signal);
  const relativeTarget =
    target === undefined ? '' : toPosixPath(relativeInside(root, target) ?? '');
  return status.files
    .filter((file) => isUntracked(file) && overlapsPath(file.path, relativeTarget))
    .map((file) => file.path);
}

export const gitDiffInput = z.object({
  scope: z
    .enum(['unstaged', 'staged', 'all'])
    .optional()
    .describe(
      '"unstaged" (work tree vs index), "staged" (index vs HEAD), or "all" (work tree vs HEAD, the default).',
    ),
  path: z.string().optional().describe('Limit the diff to this file or directory.'),
  stat: z
    .boolean()
    .optional()
    .describe('Return a per-file summary (--stat) instead of the full patch.'),
});

/**
 * Unified diff via getGitDiff(); truncated with truncateMiddle (max ~1500 lines / 60k chars, with
 * an explicit omission note suggesting `path` or `stat`). For scope all/unstaged, untracked files
 * are listed after the diff ("Untracked files (not included in the diff): ...").
 * Display: verb "git", target "diff" (+ " <path>"), summary "<n> files +a -r" or "no changes".
 */
export const gitDiffTool = defineTool({
  name: 'git_diff',
  description:
    'Show uncommitted changes as a unified diff. Defaults to all changes against HEAD (staged and unstaged). Use path to focus on one file and stat for an overview.',
  inputSchema: gitDiffInput,
  permissionClass: 'read',
  summarize(input) {
    const detail = [
      input.scope && input.scope !== 'all' ? input.scope : '',
      input.stat ? 'stat' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      verb: 'git',
      target: input.path ? `diff ${input.path}` : 'diff',
      ...(detail ? { detail } : {}),
    };
  },
  permission(input, ctx) {
    return readPermission(ctx, input.path);
  },
  async execute(input, ctx) {
    const root = requireGitRoot(ctx);
    const scope = input.scope ?? 'all';
    const stat = input.stat ?? false;
    const target = await resolvePathFilter(ctx, root, input.path);
    const paths = target ? [target.absolute] : undefined;
    const [diff, stats, untracked] = await withGitErrors(() =>
      Promise.all([
        getGitDiff(root, { scope, paths, stat, signal: ctx.signal }),
        getDiffNumstat(root, scope, ctx.signal, paths),
        scope === 'staged' ? [] : listUntracked(root, target?.absolute, ctx.signal),
      ]),
    );
    const format = await createPathFormatter(ctx, root);

    const parts: string[] = [];
    if (diff.trim() === '') {
      parts.push(`${NO_CHANGES[scope]}${target ? ` in ${target.display}` : ''}.`);
    } else {
      parts.push(truncateDiff(diff, stat));
      const rootFromCwd = format('');
      if (rootFromCwd !== '.') {
        parts.push(`(Paths in the diff are relative to the repository root, ${rootFromCwd})`);
      }
    }
    if (untracked.length > 0) {
      const listed = cappedList(untracked.map(format), MAX_UNTRACKED_LISTED).join('\n');
      parts.push(`Untracked files (not included in the diff):\n${listed}`);
    }

    const added = stats.reduce((sum, s) => sum + s.added, 0);
    const removed = stats.reduce((sum, s) => sum + s.removed, 0);
    let summary =
      stats.length > 0 ? `${plural(stats.length, 'file')} +${added} -${removed}` : 'no changes';
    if (untracked.length > 0) summary += ` · ${formatCount(untracked.length)} untracked`;
    return { content: parts.join('\n\n'), display: { summary } };
  },
});

// ---------------------------------------------------------------------------------------------
// git_log

const DEFAULT_LOG_LIMIT = 10;
const MAX_LOG_LIMIT = 50;

export const gitLogInput = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LOG_LIMIT)
    .optional()
    .describe('Number of commits (default 10).'),
  path: z.string().optional().describe('Only commits touching this path.'),
});

/**
 * Recent commits, one per line: "<sha> <date> <author>  <subject>". "No commits yet." when empty.
 * Display: verb "git", target "log" (+ " <path>"), summary "<n> commits".
 */
export const gitLogTool = defineTool({
  name: 'git_log',
  description:
    'Show recent commits (short sha, date, author, subject), optionally limited to a path.',
  inputSchema: gitLogInput,
  permissionClass: 'read',
  summarize(input) {
    return { verb: 'git', target: input.path ? `log ${input.path}` : 'log' };
  },
  permission(input, ctx) {
    return readPermission(ctx, input.path);
  },
  async execute(input, ctx) {
    const root = requireGitRoot(ctx);
    const target = await resolvePathFilter(ctx, root, input.path);
    const limit = input.limit ?? DEFAULT_LOG_LIMIT;
    // One extra commit tells whether older history exists beyond the limit.
    const fetched = await withGitErrors(() =>
      getGitLog(root, { limit: limit + 1, path: target?.absolute, signal: ctx.signal }),
    );
    const commits = fetched.slice(0, limit);
    const summary = plural(commits.length, 'commit');
    if (commits.length === 0) {
      const content = target ? `No commits touch ${target.display}.` : 'No commits yet.';
      return { content, display: { summary } };
    }
    const lines = commits.map((c) => `${c.sha} ${c.date} ${c.author}  ${c.subject}`);
    if (fetched.length > limit) {
      const raise = limit < MAX_LOG_LIMIT ? ` Raise limit (max ${MAX_LOG_LIMIT}) to see more.` : '';
      lines.push(`(Older commits not shown.${raise})`);
    }
    return { content: lines.join('\n'), display: { summary } };
  },
});
