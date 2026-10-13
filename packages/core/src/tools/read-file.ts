import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { formatBytes, formatCount, plural, splitLines } from '@patch/shared';
import { z } from 'zod';
import { isImageFile, readImageFile } from '../fs/image-file.js';
import { readTextFile } from '../fs/text-file.js';
import { displayPathInput, hasUncommittedChanges, numberedLine } from './fs-helpers.js';
import { ToolError, defineTool, type ToolContext, type ToolResult } from './types.js';

export const DEFAULT_READ_LIMIT = 2000;
export const MAX_LINE_CHARS = 2000;
/** Max characters of file content returned in one call (beyond this, the read stops early). */
export const MAX_READ_CHARS = 120_000;

/** Similar names offered when a file is not found. */
const MAX_SUGGESTIONS = 3;

export const readFileInput = z.object({
  path: z
    .string()
    .describe('Path of the file to read (relative to the working directory, or absolute).'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-based line number to start reading from. Use with limit for large files.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .optional()
    .describe(`Maximum number of lines to return (default ${DEFAULT_READ_LIMIT}).`),
});

type ReadFileInput = z.infer<typeof readFileInput>;

function rangeDetail(input: ReadFileInput): string | undefined {
  if (input.offset === undefined && input.limit === undefined) return undefined;
  const start = input.offset ?? 1;
  if (input.limit === undefined) return `from line ${start}`;
  return `lines ${start}-${start + input.limit - 1}`;
}

/** Names in the same directory that differ only in case or extension ("Did you mean ...?"). */
async function similarNames(absolute: string): Promise<string[]> {
  const directory = path.dirname(absolute);
  const wanted = path.basename(absolute).toLowerCase();
  const stem = (name: string) => name.slice(0, name.length - path.extname(name).length);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      const lower = name.toLowerCase();
      return lower === wanted || (stem(lower) !== '' && stem(lower) === stem(wanted));
    })
    .sort()
    .slice(0, MAX_SUGGESTIONS)
    .map((name) => path.join(directory, name));
}

/**
 * An image file as a tool-result image after the line "Image: <path> (<w>×<h>, <size>)". The
 * offset and limit do not apply. Display: summary "image <w>×<h>".
 */
async function readImage(absolute: string, display: string): Promise<ToolResult> {
  const file = await readImageFile(absolute, display);
  const size = formatBytes(file.size);
  const dimensions = file.width && file.height ? `${file.width}×${file.height}` : undefined;
  return {
    content: `Image: ${display} (${dimensions ? `${dimensions}, ${size}` : size})`,
    images: [file.image],
    display: { summary: `image ${dimensions ?? size}` },
  };
}

async function notFoundError(ctx: ToolContext, absolute: string, display: string) {
  const suggestions = (await similarNames(absolute)).map((name) => ctx.paths.display(name));
  const hint = suggestions.length > 0 ? ` Did you mean ${suggestions.join(', ')}?` : '';
  return new ToolError(`File not found: ${display}.${hint}`);
}

/**
 * Output format: a header line, then numbered lines `<n right-aligned to 6>\t<line>`:
 *   "src/a.ts · lines 1-120 of 120"
 * plus explicit notes when: the read stopped early ("Showing lines 1-2000 of 5400. Continue with
 * offset=2001."), lines were cut at MAX_LINE_CHARS, the file is empty, the offset is past the end,
 * or the file has uncommitted changes in Git ("Note: this file has uncommitted changes.").
 * Records the read in FileStateTracker (partial when not the whole file).
 * Display: summary "<n> lines" (or "lines a-b" for partial reads); verb "read"; target display path.
 * Permission subject: { kind: 'read', paths: [resolved] }. Directories → ToolError suggesting
 * list_directory. Files that start like a PNG, JPEG, GIF or WebP image (whatever their extension)
 * are returned as an image instead (see readImage).
 */
export const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Read a text file, or view an image (PNG, JPEG, GIF or WebP, such as a screenshot). Returns numbered lines (number, tab, content). Reads up to 2000 lines by default; use offset and limit to page through large files. Lines longer than 2000 characters are truncated. Other binary files are refused. Always read a file before editing it.',
  inputSchema: readFileInput,
  permissionClass: 'read',
  summarize(input, ctx) {
    const detail = rangeDetail(input);
    return {
      verb: 'read',
      target: displayPathInput(ctx, input.path),
      ...(detail ? { detail } : {}),
    };
  },
  async permission(input, ctx) {
    return { kind: 'read', paths: [await ctx.paths.resolve(input.path)] };
  },
  async execute(input, ctx): Promise<ToolResult> {
    const resolved = await ctx.paths.resolve(input.path);
    const { display } = resolved;
    if (!resolved.exists) throw await notFoundError(ctx, resolved.absolute, display);
    if (resolved.isDirectory) {
      throw new ToolError(`${display} is a directory. Use list_directory to see its contents.`);
    }
    if (await isImageFile(resolved.absolute)) return readImage(resolved.absolute, display);
    const file = await readTextFile(resolved.absolute, display);
    const lines = splitLines(file.content);
    const total = lines.length;

    const notes: string[] = [];
    if (file.lossy) {
      notes.push('Note: this file is not valid UTF-8; undecodable bytes are shown as "\uFFFD".');
    }
    if (await hasUncommittedChanges(ctx, resolved.absolute)) {
      notes.push('Note: this file has uncommitted changes.');
    }

    if (total === 0) {
      ctx.fileState.recordRead(resolved.absolute, file.snapshot, false);
      return {
        content: [`${display} · 0 lines`, 'The file is empty.', ...notes].join('\n'),
        display: { summary: 'empty' },
      };
    }

    const start = input.offset ?? 1;
    if (start > total) {
      return {
        content: [
          `${display} · ${plural(total, 'line')}`,
          `No lines to show: offset ${formatCount(start)} is past the end of the file (${plural(total, 'line')}).`,
          ...notes,
        ].join('\n'),
        display: { summary: 'offset past end' },
      };
    }

    const last = Math.min(total, start + (input.limit ?? DEFAULT_READ_LIMIT) - 1);
    const body: string[] = [];
    let chars = 0;
    let truncatedLines = 0;
    let end = start - 1;
    for (let lineNumber = start; lineNumber <= last; lineNumber++) {
      const text = lines[lineNumber - 1];
      const formatted = numberedLine(lineNumber, text, MAX_LINE_CHARS);
      if (body.length > 0 && chars + formatted.length + 1 > MAX_READ_CHARS) break;
      body.push(formatted);
      chars += formatted.length + 1;
      if (text.length > MAX_LINE_CHARS) truncatedLines++;
      end = lineNumber;
    }

    const partial = start > 1 || end < total;
    ctx.fileState.recordRead(resolved.absolute, file.snapshot, partial);

    if (end < total) {
      const reason = end < last ? ' (output size limit reached)' : '';
      notes.unshift(
        `Showing lines ${start}-${end} of ${total}${reason}. Continue with offset=${end + 1}.`,
      );
    }
    if (truncatedLines > 0) {
      notes.push(
        `Note: ${plural(truncatedLines, 'line')} longer than ${formatCount(MAX_LINE_CHARS)} characters ${truncatedLines === 1 ? 'was' : 'were'} truncated.`,
      );
    }
    const header = `${display} · lines ${start}-${end} of ${total}`;
    return {
      content: [header, ...body, ...(notes.length > 0 ? ['', ...notes] : [])].join('\n'),
      display: { summary: partial ? `lines ${start}-${end}` : plural(total, 'line') },
    };
  },
});
