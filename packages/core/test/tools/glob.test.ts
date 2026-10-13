import { utimesSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findRipgrep } from '../../src/fs/walk.js';
import { makeTempDir, writeFiles } from '../../src/testing/index.js';
import { globTool, MAX_GLOB_RESULTS } from '../../src/tools/glob.js';
import type { ToolContext } from '../../src/tools/types.js';
import { lines, makeToolContext, recordingLogger, runTool } from './context.js';

const ripgrep = await findRipgrep();

const ENGINES = [
  { name: 'ripgrep', disableRipgrep: '', available: ripgrep !== null },
  { name: 'JavaScript fallback', disableRipgrep: '1', available: true },
];

describe.each(ENGINES)('glob with $name', ({ disableRipgrep, available }) => {
  const test = available ? it : it.skip;
  let temp: { dir: string; cleanup: () => void };
  let ctx: ToolContext;
  let problems: string[];
  const glob = (input: { pattern: string; path?: string }) => runTool(globTool, input, ctx);

  /** Sets mtimes so that "newest first" is deterministic: later entries are newer. */
  const touchInOrder = (relativePaths: string[]) => {
    relativePaths.forEach((relative, index) => {
      const time = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
      utimesSync(path.join(temp.dir, relative), time, time);
    });
  };

  beforeEach(() => {
    vi.stubEnv('PATCH_NO_RG', disableRipgrep);
    temp = makeTempDir();
    const recorder = recordingLogger();
    problems = recorder.problems;
    ctx = makeToolContext({ cwd: temp.dir, logger: recorder.logger });
    writeFiles(temp.dir, {
      '.gitignore': 'node_modules/\ndist/\n*.gen.ts\n',
      'src/a.ts': '',
      'src/b.ts': '',
      'src/util/c.ts': '',
      'src/util/c.gen.ts': '',
      'src/readme.md': '',
      'index.ts': '',
      'node_modules/pkg/index.ts': '',
      'dist/out.ts': '',
      '.github/workflows/ci.yml': '',
      '.git/HEAD.ts': '',
    });
    touchInOrder(['src/util/c.ts', 'index.ts', 'src/b.ts', 'src/a.ts']);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    temp.cleanup();
    expect(problems).toEqual([]);
  });

  test('finds files recursively, newest first, relative to the working directory', async () => {
    const result = await glob({ pattern: '**/*.ts' });
    expect(lines(result.content)).toEqual(['src/a.ts', 'src/b.ts', 'index.ts', 'src/util/c.ts']);
    expect(result.display?.summary).toBe('4 files');
  });

  test('matches file names at any depth when the pattern has no slash', async () => {
    const result = await glob({ pattern: '*.ts' });
    expect(lines(result.content)).toEqual(['src/a.ts', 'src/b.ts', 'index.ts', 'src/util/c.ts']);
  });

  test('anchors patterns with a slash at the search directory', async () => {
    expect(lines((await glob({ pattern: 'src/*.ts' })).content)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(lines((await glob({ pattern: '/*.ts' })).content)).toEqual(['index.ts']);
    expect(lines((await glob({ pattern: './src/util/*.ts' })).content)).toEqual(['src/util/c.ts']);
  });

  test('includes hidden files but never .git, and honors .gitignore', async () => {
    expect(lines((await glob({ pattern: '**/*.yml' })).content)).toEqual([
      '.github/workflows/ci.yml',
    ]);
    const all = lines((await glob({ pattern: '**/*' })).content);
    expect(all).toContain('.gitignore');
    expect(all.some((line) => line.startsWith('.git/'))).toBe(false);
    expect(all.some((line) => line.includes('node_modules') || line.startsWith('dist/'))).toBe(
      false,
    );
    expect(all).not.toContain('src/util/c.gen.ts');
  });

  test('searches below path and still reports paths relative to the working directory', async () => {
    const result = await glob({ pattern: '*.ts', path: 'src/util' });
    expect(lines(result.content)).toEqual(['src/util/c.ts']);
    const absolute = await glob({ pattern: path.join(temp.dir, 'src', '*.ts') });
    expect(lines(absolute.content)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('caps results with an explicit note', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < MAX_GLOB_RESULTS + 10; index++) files[`many/f${index}.txt`] = '';
    writeFiles(temp.dir, files);
    const output = lines((await glob({ pattern: 'many/*.txt' })).content);
    expect(output).toHaveLength(MAX_GLOB_RESULTS + 1);
    expect(output.at(-1)).toBe('... 10 more files (narrow the pattern)');
  });

  test('says when nothing matched', async () => {
    const result = await glob({ pattern: '**/*.rs' });
    expect(result.content).toBe('No files matched **/*.rs.');
    expect(result.isError).toBeUndefined();
    const scoped = await glob({ pattern: '*.rs', path: 'src' });
    expect(scoped.content).toBe('No files matched *.rs in src.');
  });

  test('rejects bad patterns and search paths', async () => {
    await expect(glob({ pattern: '../*.ts' })).rejects.toThrow('Patterns cannot contain ".."');
    await expect(glob({ pattern: '  ' })).rejects.toThrow('pattern must not be empty.');
    await expect(glob({ pattern: '*.ts', path: 'index.ts' })).rejects.toThrow(
      'index.ts is a file; glob searches a directory.',
    );
    await expect(glob({ pattern: '*.ts', path: 'nope' })).rejects.toThrow(
      'Directory not found: nope',
    );
  });
});

describe('glob call description', () => {
  it('summarizes the pattern and the search path', () => {
    const ctx = makeToolContext({ cwd: path.resolve('/patch-test/project') });
    expect(globTool.summarize({ pattern: '**/*.ts' }, ctx)).toEqual({
      verb: 'glob',
      target: '**/*.ts',
    });
    expect(globTool.summarize({ pattern: '*.ts', path: 'src/' }, ctx)).toEqual({
      verb: 'glob',
      target: '*.ts',
      detail: 'in src',
    });
  });
});
