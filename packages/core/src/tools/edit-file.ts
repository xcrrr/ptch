import { formatCount, plural, splitLines } from '@patch/shared';
import { z } from 'zod';
import { computeFileDiff } from '../fs/diffing.js';
import type { ResolvedPath } from '../fs/paths.js';
import { readTextFile, type TextFile } from '../fs/text-file.js';
import {
  assertUnchangedSinceRead,
  displayPathInput,
  numberedLine,
  preexistingChangesNote,
  requirePriorRead,
  writeResolvedFile,
  type KnownFile,
} from './fs-helpers.js';
import { MAX_LINE_CHARS } from './read-file.js';
import { ToolError, defineTool, type ToolContext, type ToolResult } from './types.js';

export const editFileInput = z.object({
  path: z.string().describe('Path of the file to edit.'),
  old_string: z
    .string()
    .describe(
      'Exact text to replace, copied from the current file contents (without line-number prefixes). Must match exactly once unless replace_all is true.',
    ),
  new_string: z.string().describe('Replacement text. Must differ from old_string.'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace every occurrence of old_string instead of requiring a unique match.'),
});

type EditFileInput = z.infer<typeof editFileInput>;

/** Lines of the edited region returned to the model (including context). */
const MAX_SNIPPET_LINES = 12;
/** Unchanged lines shown around the edited region. */
const SNIPPET_CONTEXT = 2;
/** Match locations listed when old_string is ambiguous. */
const MAX_LISTED_MATCHES = 10;

interface EditPlan {
  resolved: ResolvedPath;
  file: TextFile;
  newContent: string;
  newString: string;
  /** Index of the first replacement in both the old and the new content. */
  firstIndex: number;
  occurrences: number;
}

function findOccurrences(content: string, needle: string): number[] {
  const indexes: number[] = [];
  for (let index = content.indexOf(needle); index !== -1;) {
    indexes.push(index);
    index = content.indexOf(needle, index + needle.length);
  }
  return indexes;
}

/** 1-based line numbers of ascending character indexes. */
function lineNumbersAt(content: string, indexes: number[]): number[] {
  const lines: number[] = [];
  let line = 1;
  let scanned = 0;
  for (const index of indexes) {
    for (let at = content.indexOf('\n', scanned); at !== -1 && at < index;) {
      line++;
      scanned = at + 1;
      at = content.indexOf('\n', scanned);
    }
    lines.push(line);
  }
  return lines;
}

function looksLineNumbered(text: string): boolean {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines.length > 0 && lines.every((line) => /^\s*\d+\t/.test(line));
}

/**
 * Line where `needle` occurs when all whitespace is ignored (different indentation, tabs vs
 * spaces, wrapped lines), or undefined.
 */
function whitespaceInsensitiveMatchLine(content: string, needle: string): number | undefined {
  const target = needle.replace(/\s+/g, '');
  if (target === '') return undefined;
  const lineStarts: number[] = [];
  let stripped = '';
  for (const line of content.split('\n')) {
    lineStarts.push(stripped.length);
    stripped += line.replace(/\s+/g, '');
  }
  const index = stripped.indexOf(target);
  if (index === -1) return undefined;
  // The last line starting at or before the match owns its first character (blank lines share
  // their start with the following line, so they are skipped naturally).
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= index) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function notFoundError(
  resolved: ResolvedPath,
  file: TextFile,
  oldString: string,
  known: KnownFile,
): ToolError {
  let message = `old_string was not found in ${resolved.display}.`;
  const similarLine = whitespaceInsensitiveMatchLine(file.content, oldString);
  if (looksLineNumbered(oldString)) {
    message +=
      ' It seems to include line-number prefixes from read_file output; copy only the text after the tab.';
  } else if (similarLine !== undefined) {
    message += ` A similar block exists near line ${similarLine} with different whitespace or indentation; copy the exact text from the file.`;
  } else if (known.partial) {
    message += ' Only part of the file has been read; read the section you want to change first.';
  }
  return new ToolError(message);
}

function ambiguousError(resolved: ResolvedPath, file: TextFile, indexes: number[]): ToolError {
  const lines = lineNumbersAt(file.content, indexes.slice(0, MAX_LISTED_MATCHES));
  const more = indexes.length - lines.length;
  const listed = `${lines.join(', ')}${more > 0 ? `, and ${formatCount(more)} more` : ''}`;
  return new ToolError(
    `old_string matches ${formatCount(indexes.length)} times in ${resolved.display} (lines ${listed}). Include more surrounding context to make it unique, or set replace_all.`,
  );
}

/** Validates the edit and computes the new content, without writing anything. */
async function planEdit(input: EditFileInput, ctx: ToolContext): Promise<EditPlan> {
  const oldString = input.old_string.replace(/\r\n/g, '\n');
  const newString = input.new_string.replace(/\r\n/g, '\n');
  if (oldString === '') {
    throw new ToolError(
      'old_string must not be empty. To create a file use write_file; to insert text, include a neighboring line in old_string and repeat it in new_string.',
    );
  }
  if (oldString === newString) {
    throw new ToolError('old_string and new_string are identical; the edit would change nothing.');
  }
  const resolved = await ctx.paths.resolve(input.path);
  const { display } = resolved;
  if (!resolved.exists) {
    throw new ToolError(`File not found: ${display}. Use write_file to create a new file.`);
  }
  if (resolved.isDirectory) throw new ToolError(`${display} is a directory, not a file.`);
  const known = requirePriorRead(ctx, resolved, 'edit');
  const file = await readTextFile(resolved.absolute, display);
  assertUnchangedSinceRead(resolved, known, file.snapshot, {
    action: 'edit',
    requireFullRead: false,
  });
  if (file.lossy) {
    throw new ToolError(
      `${display} is not valid UTF-8 (it may use a legacy encoding such as Latin-1); editing it would corrupt those characters. Convert the file to UTF-8 first.`,
    );
  }

  const indexes = findOccurrences(file.content, oldString);
  if (indexes.length === 0) throw notFoundError(resolved, file, oldString, known);
  if (indexes.length > 1 && !input.replace_all) throw ambiguousError(resolved, file, indexes);
  const firstIndex = indexes[0];
  const newContent = input.replace_all
    ? file.content.split(oldString).join(newString)
    : file.content.slice(0, firstIndex) +
      newString +
      file.content.slice(firstIndex + oldString.length);
  return { resolved, file, newContent, newString, firstIndex, occurrences: indexes.length };
}

/** Numbered lines around the first edited region of the new content. */
function editedSnippet(plan: EditPlan): string[] {
  const lines = splitLines(plan.newContent);
  if (lines.length === 0) return ['The file is now empty.'];
  const regionEnd = plan.firstIndex + Math.max(0, plan.newString.length - 1);
  const [startLine, endLine] = lineNumbersAt(plan.newContent, [plan.firstIndex, regionEnd]);
  const from = Math.max(1, startLine - SNIPPET_CONTEXT);
  const to = Math.min(lines.length, endLine + SNIPPET_CONTEXT);
  const last = Math.min(to, from + MAX_SNIPPET_LINES - 1);
  const snippet: string[] = [];
  for (let line = from; line <= last; line++) {
    snippet.push(numberedLine(line, lines[line - 1], MAX_LINE_CHARS));
  }
  if (last < to) snippet.push(`… ${plural(to - last, 'more line')} in the edited region`);
  return snippet;
}

/**
 * Deterministic exact-string replacement.
 *  - File must exist (else ToolError suggesting write_file), must have been read (fully or
 *    partially) or written by Patch this session, and must be unchanged on disk since.
 *  - Matching is done on "\n"-normalized content; CRLF files keep CRLF; BOM preserved.
 *  - old_string === new_string → ToolError. Empty old_string → ToolError.
 *  - 0 matches → ToolError("old_string was not found in <path>."), adding a hint when a
 *    whitespace-insensitive match exists ("A similar block exists near line N with different
 *    whitespace or indentation; copy the exact text from the file.").
 *  - >1 matches without replace_all → ToolError("old_string matches N times in <path> (lines a,
 *    b, ...). Include more surrounding context to make it unique, or set replace_all.").
 * Result content: "Edited <path>: replaced N occurrence(s) (+a -r)." followed by a short numbered
 * snippet of the edited region (≤ 12 lines) so the model sees the result, plus a note when the
 * file had uncommitted user changes before Patch's first edit.
 * Display: verb "edit", diff. Permission subject: write. Preview: diff.
 *
 * The checks also run in permission(), so an edit that cannot apply fails before the user is
 * asked to approve it. Files that are not valid UTF-8 are refused (the edit would corrupt them).
 */
export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Edit a file by replacing an exact string. old_string must match the current file contents exactly (including whitespace and indentation) and be unique unless replace_all is true. Read the file first. For several separate changes, call this tool several times.',
  inputSchema: editFileInput,
  permissionClass: 'write',
  summarize(input, ctx) {
    return {
      verb: 'edit',
      target: displayPathInput(ctx, input.path),
      ...(input.replace_all ? { detail: 'all occurrences' } : {}),
    };
  },
  async permission(input, ctx) {
    const plan = await planEdit(input, ctx);
    return { kind: 'write', paths: [plan.resolved] };
  },
  async preview(input, ctx) {
    const plan = await planEdit(input, ctx);
    return { diff: computeFileDiff(plan.resolved.display, plan.file.content, plan.newContent) };
  },
  async execute(input, ctx): Promise<ToolResult> {
    const plan = await planEdit(input, ctx);
    const { resolved, file } = plan;
    const note = await preexistingChangesNote(ctx, resolved);
    const snapshot = await writeResolvedFile(resolved, plan.newContent, {
      lineEnding: file.lineEnding,
      bom: file.bom,
    });
    ctx.fileState.recordWrite(resolved.absolute, snapshot);

    const diff = computeFileDiff(resolved.display, file.content, plan.newContent);
    const stat = `+${diff.added} -${diff.removed}`;
    const heading = `Edited ${resolved.display}: replaced ${plural(plan.occurrences, 'occurrence')} (${stat}).`;
    const snippetLabel =
      plan.occurrences > 1 ? [`First of ${formatCount(plan.occurrences)} edited regions:`] : [];
    return {
      content: [heading, ...snippetLabel, ...editedSnippet(plan), ...(note ? [note] : [])].join(
        '\n',
      ),
      display: { diff, summary: stat },
    };
  },
});
