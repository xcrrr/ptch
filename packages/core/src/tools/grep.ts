import { formatBytes, formatCount, isAbortError, plural } from '@patch/shared';
import { z } from 'zod';
import { findRipgrep } from '../fs/walk.js';
import { displayPathInput, resolveSearchPath } from './fs-helpers.js';
import {
  grepWithJavaScript,
  grepWithRipgrep,
  MAX_FALLBACK_FILE_BYTES,
  MAX_GREP_LINE_CHARS,
  type GrepQuery,
  type GrepResult,
} from './grep-search.js';
import { ToolError, defineTool, type ToolContext, type ToolResult } from './types.js';

export const DEFAULT_GREP_RESULTS = 200;

export const grepInput = z.object({
  pattern: z.string().describe('Regular expression to search for (ripgrep regex syntax).'),
  path: z
    .string()
    .optional()
    .describe('File or directory to search (default: the working directory).'),
  glob: z
    .string()
    .optional()
    .describe('Only search files matching this glob, e.g. "*.ts" or "src/**/*.py".'),
  case_insensitive: z.boolean().optional().describe('Case-insensitive search.'),
  output_mode: z
    .enum(['content', 'files', 'count'])
    .optional()
    .describe(
      '"content" (matching lines, default), "files" (matching file paths only), or "count" (matches per file).',
    ),
  context: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('Lines of context around each match (content mode).'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .optional()
    .describe(
      `Maximum matching lines (content) or files (files/count) to return (default ${DEFAULT_GREP_RESULTS}).`,
    ),
});

type GrepInput = z.infer<typeof grepInput>;

/** Upper bound on content-mode output; matches beyond it are counted in the omission note. */
const MAX_OUTPUT_CHARS = 100_000;

async function search(ctx: ToolContext, query: GrepQuery): Promise<GrepResult> {
  const rgPath = await findRipgrep();
  if (rgPath) {
    try {
      return await grepWithRipgrep(rgPath, query);
    } catch (error) {
      if (error instanceof ToolError || isAbortError(error)) throw error;
      ctx.logger.warn('ripgrep failed; falling back to the JavaScript search', error);
    }
  }
  return grepWithJavaScript(query);
}

function narrowingHint(budgetReached: boolean): string {
  return budgetReached
    ? 'narrow the search with path or glob'
    : 'narrow the search with path or glob, or raise max_results';
}

function formatContent(ctx: ToolContext, result: GrepResult, context: number): string[] {
  const lines: string[] = [];
  let chars = 0;
  let shown = 0;
  let budgetReached = false;
  files: for (const file of result.files) {
    const display = ctx.paths.display(file.path);
    let previous: number | undefined;
    if (context > 0 && lines.length > 0) lines.push('--');
    for (const line of file.lines) {
      if (context > 0 && previous !== undefined && line.lineNumber > previous + 1) lines.push('--');
      const separator = line.isMatch ? ':' : '-';
      const text = `${display}${separator}${line.lineNumber}${separator}${line.text}`;
      if (chars + text.length > MAX_OUTPUT_CHARS && shown > 0) {
        budgetReached = true;
        break files;
      }
      lines.push(text);
      chars += text.length + 1;
      if (line.isMatch) shown++;
      previous = line.lineNumber;
    }
  }
  while (lines.at(-1) === '--') lines.pop();
  const omitted = result.totalMatches - shown;
  if (omitted > 0) {
    lines.push(
      `... ${formatCount(omitted)} more ${omitted === 1 ? 'match' : 'matches'} (${narrowingHint(budgetReached)})`,
    );
  }
  return lines;
}

function formatFiles(ctx: ToolContext, result: GrepResult, withCounts: boolean): string[] {
  const lines = result.files.map((file) => {
    const display = ctx.paths.display(file.path);
    return withCounts ? `${display}:${file.matchCount}` : display;
  });
  const omitted = result.totalFiles - result.files.length;
  if (omitted > 0) {
    lines.push(
      `... ${formatCount(omitted)} more ${omitted === 1 ? 'file' : 'files'} (${narrowingHint(false)})`,
    );
  }
  if (withCounts && result.totalFiles > 1) {
    lines.push(
      `Total: ${plural(result.totalMatches, 'match', 'matches')} in ${plural(result.totalFiles, 'file')}.`,
    );
  }
  return lines;
}

function locationText(ctx: ToolContext, input: GrepInput): string {
  const where = input.path === undefined ? '' : ` in ${displayPathInput(ctx, input.path)}`;
  const files = input.glob === undefined ? '' : ` (files matching ${input.glob})`;
  return `${where}${files}`;
}

function displaySummary(result: GrepResult, mode: GrepQuery['mode']): string {
  if (result.totalFiles === 0) return 'no matches';
  const files = plural(result.totalFiles, 'file');
  if (mode === 'files') return files;
  return `${plural(result.totalMatches, 'match', 'matches')} in ${files}`;
}

/**
 * Searches file contents. Uses ripgrep when available (`--json` output, `--max-columns 300`,
 * respects .gitignore, `--hidden` with `--glob !.git`); otherwise a JS fallback over walkFiles()
 * with the same semantics (skip binary files and files > 2 MB, JS RegExp; an invalid pattern →
 * ToolError with the regex error).
 * Content output: "path:line:text" (context lines "path-line-text"), grouped by file, truncated
 * at max_results with a "... N more matches" note. Paths relative to the working directory.
 * rg exit code 1 means no matches → "No matches for <pattern>." (not an error).
 * Display: verb "grep", target `"<pattern>"` (+ " in <path>" when given), summary
 * "<n> matches in <m> files" / "no matches". Permission: read of the search path.
 *
 * Implementation notes: rg ignores --max-columns in JSON mode, so both engines cut lines longer
 * than 300 characters themselves (to a window around the match). Results are sorted by path
 * (`--sort path`) for deterministic output, `--crlf` makes `$` work in CRLF files, and patterns
 * that need look-around are retried with PCRE2. `glob` is applied by Patch (ripgrep's `--glob`
 * would re-include gitignored files), with ripgrep's semantics in both engines. Directory
 * searches skip files that look like secrets (.env, keys) entirely, and the output does not
 * mention them: a note naming the secret files that matched would let repeated searches recover
 * their contents pattern by pattern without a permission prompt. Searching such a file by its
 * own path works (reading it asks first).
 */
export const grepTool = defineTool({
  name: 'grep',
  description:
    'Search file contents with a regular expression (ripgrep syntax). Respects .gitignore. Use glob to restrict which files are searched, output_mode "files" to list matching files, and context for surrounding lines. Directory searches skip files that may contain secrets (.env, private keys, credentials); pass such a file as path to search it.',
  inputSchema: grepInput,
  permissionClass: 'read',
  summarize(input, ctx) {
    const where = input.path === undefined ? '' : ` in ${displayPathInput(ctx, input.path)}`;
    return {
      verb: 'grep',
      target: `"${input.pattern}"${where}`,
      ...(input.glob === undefined ? {} : { detail: input.glob }),
    };
  },
  async permission(input, ctx) {
    return { kind: 'read', paths: [await resolveSearchPath(ctx, input.path)] };
  },
  async execute(input, ctx): Promise<ToolResult> {
    if (input.pattern === '') throw new ToolError('pattern must not be empty.');
    const resolved = await resolveSearchPath(ctx, input.path);
    if (!resolved.exists) throw new ToolError(`Path not found: ${resolved.display}`);
    const mode = input.output_mode ?? 'content';
    const context = mode === 'content' ? (input.context ?? 0) : 0;
    const result = await search(ctx, {
      pattern: input.pattern,
      target: resolved.absolute,
      targetIsDirectory: resolved.isDirectory,
      ...(input.glob === undefined ? {} : { glob: input.glob }),
      caseInsensitive: input.case_insensitive ?? false,
      mode,
      context,
      maxResults: input.max_results ?? DEFAULT_GREP_RESULTS,
      hideSensitive: resolved.sensitive === undefined,
      signal: ctx.signal,
    });

    const notes: string[] = [];
    if (result.skippedLargeFiles > 0) {
      const count = result.skippedLargeFiles;
      notes.push(
        `Note: ${plural(count, 'file')} larger than ${formatBytes(MAX_FALLBACK_FILE_BYTES)} ${count === 1 ? 'was' : 'were'} not searched; install ripgrep (rg) to search large files.`,
      );
    }
    if (result.totalFiles === 0) {
      return {
        content: [`No matches for ${input.pattern}${locationText(ctx, input)}.`, ...notes].join(
          '\n',
        ),
        display: { summary: 'no matches' },
      };
    }
    const body =
      mode === 'content'
        ? formatContent(ctx, result, context)
        : formatFiles(ctx, result, mode === 'count');
    if (result.shortenedLines) {
      notes.push(`Note: lines longer than ${MAX_GREP_LINE_CHARS} characters were shortened (…).`);
    }
    return {
      content: [...body, ...(notes.length > 0 ? ['', ...notes] : [])].join('\n'),
      display: { summary: displaySummary(result, mode) },
    };
  },
});
