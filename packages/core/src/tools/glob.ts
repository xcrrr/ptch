import { stat } from 'node:fs/promises';
import path from 'node:path';
import { formatCount, isAbortError, plural, throwIfAborted } from '@patch/shared';
import { glob as crawl } from 'tinyglobby';
import { z } from 'zod';
import {
  anchoredGlob,
  createGlobMatcher,
  globsIgnoreCase,
  normalizeGlob,
} from '../fs/glob-match.js';
import { cleanRipgrepError, RIPGREP_BASE_ARGS, runRipgrep } from '../fs/ripgrep.js';
import { DEFAULT_IGNORED_DIRS, findRipgrep, GitignoreFilter } from '../fs/walk.js';
import { displayPathInput, mapWithConcurrency, resolveSearchPath } from './fs-helpers.js';
import { ToolError, defineTool, type ToolContext, type ToolResult } from './types.js';

export const MAX_GLOB_RESULTS = 200;

export const globInput = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "**/*.ts" or "src/**/test_*.py".'),
  path: z.string().optional().describe('Directory to search in (default: the working directory).'),
});

const STAT_CONCURRENCY = 64;

/**
 * Normalizes the pattern and turns an absolute pattern inside the search directory into a
 * relative one. `searchDirs` are the forms (canonical, as given) of the search directory.
 */
function preparePattern(raw: string, searchDirs: string[]): string {
  let pattern = normalizeGlob(raw.trim());
  if (pattern === '') throw new ToolError('pattern must not be empty.');
  const fold = (value: string) => (globsIgnoreCase() ? value.toLowerCase() : value);
  for (const dir of searchDirs) {
    const prefix = `${dir.split(path.sep).join('/').replace(/\/+$/, '')}/`;
    if (fold(pattern).startsWith(fold(prefix))) {
      pattern = pattern.slice(prefix.length);
      break;
    }
  }
  if (process.platform === 'win32' && /^[a-zA-Z]:\//.test(pattern)) {
    throw new ToolError(
      `The pattern ${raw} is an absolute path outside the search directory. Set path to the directory to search and use a relative pattern.`,
    );
  }
  if (pattern.split('/').includes('..')) {
    throw new ToolError(
      'Patterns cannot contain "..". Set path to the directory to search and use a pattern relative to it.',
    );
  }
  return pattern;
}

/**
 * Lists the files rg would search and matches them here: rg's own `--glob` is an override that
 * re-includes files .gitignore excludes, which would break "respects .gitignore".
 */
async function findWithRipgrep(
  rgPath: string,
  pattern: string,
  searchDir: string,
  signal: AbortSignal,
): Promise<string[]> {
  const matches = createGlobMatcher(pattern);
  const files: string[] = [];
  const run = await runRipgrep(rgPath, ['--files', '--null', ...RIPGREP_BASE_ARGS, '--', '.'], {
    cwd: searchDir,
    signal,
    delimiter: '\0',
    onRecord: (record) => {
      const absolute = path.resolve(searchDir, record);
      if (matches(path.relative(searchDir, absolute).split(path.sep).join('/'))) {
        files.push(absolute);
      }
    },
  });
  if (run.exitCode === 2 && files.length === 0 && run.stderr.trim() !== '') {
    throw new ToolError(`File search failed: ${cleanRipgrepError(run.stderr)}`);
  }
  return files;
}

async function findWithJavaScript(
  pattern: string,
  searchDir: string,
  signal: AbortSignal,
): Promise<string[]> {
  let relative: string[];
  try {
    relative = await crawl(anchoredGlob(pattern), {
      cwd: searchDir,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      expandDirectories: false,
      caseSensitiveMatch: !globsIgnoreCase(),
      ignore: DEFAULT_IGNORED_DIRS.map((dir) => `**/${dir}/**`),
      signal,
    });
  } catch (error) {
    throwIfAborted(signal);
    throw new ToolError(`Invalid glob pattern ${pattern}: ${(error as Error).message}`);
  }
  throwIfAborted(signal);
  const gitignore = await GitignoreFilter.create(searchDir);
  const kept: string[] = [];
  for (const file of relative) {
    if (!(await gitignore.ignores(file, false))) kept.push(path.resolve(searchDir, file));
  }
  return kept;
}

async function findFiles(ctx: ToolContext, pattern: string, searchDir: string): Promise<string[]> {
  const rgPath = await findRipgrep();
  if (rgPath) {
    try {
      return await findWithRipgrep(rgPath, pattern, searchDir, ctx.signal);
    } catch (error) {
      if (error instanceof ToolError || isAbortError(error)) throw error;
      ctx.logger.warn('ripgrep failed; falling back to the JavaScript glob', error);
    }
  }
  return findWithJavaScript(pattern, searchDir, ctx.signal);
}

/** Newest first; equal times by path so the order is deterministic. */
async function sortByModifiedTime(files: string[]): Promise<string[]> {
  const withTimes = await mapWithConcurrency(files, STAT_CONCURRENCY, async (file) => ({
    file,
    mtime: (await stat(file).catch(() => undefined))?.mtimeMs ?? 0,
  }));
  withTimes.sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return withTimes.map((entry) => entry.file);
}

/**
 * Finds files by glob. Uses `rg --files --hidden --glob <pattern> --glob !.git` when ripgrep is
 * available (respects .gitignore), else tinyglobby with DEFAULT_IGNORED_DIRS ignored. Returns
 * paths relative to the working directory, newest-modified first, capped at MAX_GLOB_RESULTS
 * with a "... N more files (narrow the pattern)" note. "No files matched <pattern>." when empty.
 * Display: verb "glob", target pattern, summary "<n> files". Permission: read of the search dir.
 *
 * Both implementations use ripgrep's glob semantics (a pattern without "/" matches file names at
 * any depth, one with "/" is anchored at the search directory) and honor .gitignore; matching is
 * case-insensitive on Windows and macOS. With ripgrep, the pattern is applied to `rg --files`
 * output rather than passed as `--glob`, because rg globs override .gitignore.
 */
export const globTool = defineTool({
  name: 'glob',
  description:
    'Find files by glob pattern (e.g. "**/*.test.ts"). Respects .gitignore. Returns paths relative to the working directory, most recently modified first.',
  inputSchema: globInput,
  permissionClass: 'read',
  summarize(input, ctx) {
    return {
      verb: 'glob',
      target: input.pattern,
      ...(input.path === undefined ? {} : { detail: `in ${displayPathInput(ctx, input.path)}` }),
    };
  },
  async permission(input, ctx) {
    return { kind: 'read', paths: [await resolveSearchPath(ctx, input.path)] };
  },
  async execute(input, ctx): Promise<ToolResult> {
    const resolved = await resolveSearchPath(ctx, input.path);
    const { display } = resolved;
    if (!resolved.exists) throw new ToolError(`Directory not found: ${display}`);
    if (!resolved.isDirectory) {
      throw new ToolError(
        `${display} is a file; glob searches a directory. Use read_file to read it.`,
      );
    }
    const lexicalDir = ctx.paths.resolveLexically(input.path ?? ctx.cwd);
    const pattern = preparePattern(input.pattern, [resolved.absolute, lexicalDir]);
    const files = await sortByModifiedTime(await findFiles(ctx, pattern, resolved.absolute));
    if (files.length === 0) {
      const where = input.path === undefined ? '' : ` in ${display}`;
      return {
        content: `No files matched ${input.pattern}${where}.`,
        display: { summary: '0 files' },
      };
    }
    const shown = files.slice(0, MAX_GLOB_RESULTS).map((file) => ctx.paths.display(file));
    const omitted = files.length - shown.length;
    if (omitted > 0) {
      shown.push(
        `... ${formatCount(omitted)} more ${omitted === 1 ? 'file' : 'files'} (narrow the pattern)`,
      );
    }
    return { content: shown.join('\n'), display: { summary: plural(files.length, 'file') } };
  },
});
