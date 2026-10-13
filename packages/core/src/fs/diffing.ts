import { structuredPatch } from 'diff';
import { splitLines } from '@patch/shared';
import type { DiffHunk, FileDiff } from '../tools/types.js';

/** Lines of unchanged context around each hunk. */
const CONTEXT_LINES = 3;

/**
 * Upper bound for the line diff. Pathological inputs (huge files rewritten end to end) fall back
 * to a single hunk that replaces everything, which is correct if not minimal.
 */
const DIFF_TIMEOUT_MS = 2_000;

const NO_NEWLINE_MARKER = '\\ No newline at end of file';

function wholeFileHunk(oldText: string, newText: string): DiffHunk {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const lines = [...oldLines.map((line) => `-${line}`)];
  if (oldText !== '' && !oldText.endsWith('\n')) lines.push(NO_NEWLINE_MARKER);
  lines.push(...newLines.map((line) => `+${line}`));
  if (newText !== '' && !newText.endsWith('\n')) lines.push(NO_NEWLINE_MARKER);
  return {
    oldStart: 1,
    oldLines: oldLines.length,
    newStart: 1,
    newLines: newLines.length,
    lines,
  };
}

/**
 * Computes a structured line diff between two "\n"-normalized texts using the `diff` package
 * (structuredPatch, 3 lines of context). `oldText` undefined means the file is new.
 */
export function computeFileDiff(
  displayPath: string,
  oldText: string | undefined,
  newText: string,
): FileDiff {
  const before = oldText ?? '';
  const patch = structuredPatch(displayPath, displayPath, before, newText, undefined, undefined, {
    context: CONTEXT_LINES,
    timeout: DIFF_TIMEOUT_MS,
  });
  const hunks: DiffHunk[] = patch
    ? patch.hunks.map((hunk) => ({
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        lines: [...hunk.lines],
      }))
    : [wholeFileHunk(before, newText)];
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  return { path: displayPath, added, removed, isNew: oldText === undefined, hunks };
}

function rangeHeader(start: number, count: number): string {
  // An empty range names the line before it, as in GNU diff ("-0,0" for a new file).
  return `${count === 0 ? Math.max(0, start - 1) : start},${count}`;
}

/** Renders a FileDiff as plain unified-diff text (for model-facing output and logs). */
export function formatFileDiff(diff: FileDiff): string {
  if (diff.hunks.length === 0) return '';
  const lines = [diff.isNew ? '--- /dev/null' : `--- ${diff.path}`, `+++ ${diff.path}`];
  for (const hunk of diff.hunks) {
    lines.push(
      `@@ -${rangeHeader(hunk.oldStart, hunk.oldLines)} +${rangeHeader(hunk.newStart, hunk.newLines)} @@`,
      ...hunk.lines,
    );
  }
  return lines.join('\n');
}
