import { truncateLine } from '@patch/shared';
import type { FileSnapshot } from '../fs/file-state.js';
import { describeFsError } from '../fs/fs-errors.js';
import { isPathInside, type ResolvedPath } from '../fs/paths.js';
import { writeTextFile, type LineEnding } from '../fs/text-file.js';
import { getFileGitStatus, type GitChange } from '../git/status.js';
import { ToolError, type ToolContext } from './types.js';

/** Width of the right-aligned line-number column in numbered file output. */
const LINE_NUMBER_WIDTH = 6;

/** How long the best-effort Git check may delay a file tool. */
const GIT_STATUS_TIMEOUT_MS = 3_000;

const CHANGED_STATES: ReadonlySet<GitChange> = new Set<GitChange>([
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'type-changed',
  'unmerged',
]);

/** "    12\tconst a = 1;" — the numbered-line format shared by read_file and edit_file. */
export function numberedLine(lineNumber: number, text: string, maxChars: number): string {
  return `${String(lineNumber).padStart(LINE_NUMBER_WIDTH)}\t${truncateLine(text, maxChars)}`;
}

/**
 * Display form of a model-supplied path for call summaries. Summaries are synchronous, so this
 * resolves lexically (no symlinks); undefined means the working directory.
 */
export function displayPathInput(ctx: ToolContext, input: string | undefined): string {
  if (input === undefined) return '.';
  if (input.trim() === '' || input.includes('\0')) return input;
  return ctx.paths.display(ctx.paths.resolveLexically(input));
}

/** Resolves the file or directory a search tool works on (default: the working directory). */
export function resolveSearchPath(
  ctx: ToolContext,
  input: string | undefined,
): Promise<ResolvedPath> {
  return ctx.paths.resolve(input ?? ctx.cwd);
}

/**
 * Whether Git reports uncommitted changes (staged or not) to this file. Best-effort: outside a
 * repository, on timeout or on any Git failure it answers false and never throws.
 */
export async function hasUncommittedChanges(ctx: ToolContext, absolute: string): Promise<boolean> {
  const gitRoot = ctx.gitRoot;
  if (gitRoot === null) return false;
  if (!isPathInside(absolute, gitRoot) && !ctx.paths.isInsideProject(absolute)) return false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), GIT_STATUS_TIMEOUT_MS);
  });
  try {
    const status = await Promise.race([getFileGitStatus(gitRoot, absolute), timeout]);
    if (!status) return false;
    return CHANGED_STATES.has(status.index) || CHANGED_STATES.has(status.worktree);
  } catch (error) {
    ctx.logger.debug('Uncommitted-changes check failed', error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type WriteAction = 'edit' | 'overwrite';

function gerund(action: WriteAction): string {
  return action === 'edit' ? 'editing' : 'overwriting';
}

/** What Patch last saw of a file it has read or written this session. */
export interface KnownFile {
  snapshot: FileSnapshot;
  partial: boolean;
}

/** Throws unless Patch has read or written the file in this session (no file system access). */
export function requirePriorRead(
  ctx: ToolContext,
  resolved: ResolvedPath,
  action: WriteAction,
): KnownFile {
  const record = ctx.fileState.get(resolved.absolute);
  if (!record?.lastRead) {
    throw new ToolError(`Read ${resolved.display} before ${gerund(action)} it.`);
  }
  return { snapshot: record.lastRead, partial: record.partialRead === true };
}

/**
 * Throws when the bytes on disk (`current`) differ from what Patch last saw, so a write never
 * clobbers changes made in the meantime. With `requireFullRead`, having read only part of the
 * file is not enough either.
 */
export function assertUnchangedSinceRead(
  resolved: ResolvedPath,
  known: KnownFile,
  current: FileSnapshot,
  options: { action: WriteAction; requireFullRead: boolean },
): void {
  if (known.snapshot.hash !== current.hash) {
    const next = options.action === 'edit' ? 'editing' : 'writing';
    throw new ToolError(
      `${resolved.display} has changed since it was last read. Read it again before ${next}.`,
    );
  }
  if (options.requireFullRead && known.partial) {
    throw new ToolError(
      `Read all of ${resolved.display} before ${gerund(options.action)} it (only part of it has been read).`,
    );
  }
}

/**
 * Before Patch's first write to a file: notes (and records) whether the user had uncommitted
 * changes in it, so the result can tell the model. Returns the note, or undefined.
 */
export async function preexistingChangesNote(
  ctx: ToolContext,
  resolved: ResolvedPath,
): Promise<string | undefined> {
  if (ctx.fileState.wasWrittenByPatch(resolved.absolute)) return undefined;
  if (!(await hasUncommittedChanges(ctx, resolved.absolute))) return undefined;
  ctx.fileState.markPreexistingChanges(resolved.absolute);
  return `Note: ${resolved.display} already had uncommitted changes that were not made by Patch.`;
}

/** writeTextFile with file system failures turned into a ToolError the model can act on. */
export async function writeResolvedFile(
  resolved: ResolvedPath,
  content: string,
  options: { lineEnding: LineEnding; bom: boolean },
): Promise<FileSnapshot> {
  try {
    return await writeTextFile(resolved.absolute, content, options);
  } catch (error) {
    throw new ToolError(`Could not write ${resolved.display}: ${describeFsError(error)}.`);
  }
}

/** Maps `items` with at most `limit` calls in flight, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
