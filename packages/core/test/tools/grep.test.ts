import path from 'node:path';
import { AbortError } from '@patch/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findRipgrep } from '../../src/fs/walk.js';
import { makeTempDir, writeFiles } from '../../src/testing/index.js';
import { grepTool } from '../../src/tools/grep.js';
import {
  compileSearchPattern,
  grepWithJavaScript,
  grepWithRipgrep,
  MAX_FALLBACK_FILE_BYTES,
  type GrepQuery,
} from '../../src/tools/grep-search.js';
import type { ToolContext } from '../../src/tools/types.js';
import { lines, makeToolContext, recordingLogger, runTool } from './context.js';

const ripgrep = await findRipgrep();

const ENGINES = [
  { name: 'ripgrep', disableRipgrep: '', available: ripgrep !== null },
  { name: 'JavaScript fallback', disableRipgrep: '1', available: true },
];

const FIXTURE: Record<string, string> = {
  '.gitignore': 'build/\n*.log\n',
  'src/auth/session.ts': [
    'import { refreshToken } from "./tokens";',
    '',
    'export function renew() {',
    '  return refreshToken();',
    '}',
    '',
  ].join('\n'),
  'src/auth/tokens.ts': [
    'export function refreshToken() {',
    '  // RefreshToken rotation',
    '  return "token";',
    '}',
    '',
  ].join('\n'),
  'src/main.ts': 'console.log("main");\n',
  'docs/notes.md': 'refreshToken is documented here\n',
  'build/out.js': 'refreshToken();\n',
  'debug.log': 'refreshToken failed\n',
  '.env': 'refreshToken=super-secret\n',
  'windows.txt': 'first line\r\nsecond line\r\n',
};

describe.each(ENGINES)('grep with $name', ({ disableRipgrep, available }) => {
  const test = available ? it : it.skip;
  let temp: { dir: string; cleanup: () => void };
  let ctx: ToolContext;
  let problems: string[];
  const grep = (input: Parameters<typeof grepTool.execute>[0]) => runTool(grepTool, input, ctx);

  beforeEach(() => {
    vi.stubEnv('PATCH_NO_RG', disableRipgrep);
    temp = makeTempDir();
    const recorder = recordingLogger();
    problems = recorder.problems;
    ctx = makeToolContext({ cwd: temp.dir, logger: recorder.logger });
    writeFiles(temp.dir, FIXTURE);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    temp.cleanup();
    expect(problems).toEqual([]);
  });

  test('lists matching lines as path:line:text grouped by file', async () => {
    const result = await grep({ pattern: 'refreshToken' });
    expect(lines(result.content)).toEqual([
      'docs/notes.md:1:refreshToken is documented here',
      'src/auth/session.ts:1:import { refreshToken } from "./tokens";',
      'src/auth/session.ts:4:  return refreshToken();',
      'src/auth/tokens.ts:1:export function refreshToken() {',
    ]);
    expect(result.display?.summary).toBe('4 matches in 3 files');
  });

  test('never reveals whether files that may contain secrets match', async () => {
    writeFiles(temp.dir, { 'config/.env.local': 'TOKEN=sk_live_Q7x\n', 'keys/app.key': 'Q7x\n' });
    // Whether the secret matches a pattern must not change the output, or repeated searches
    // would recover it one character at a time.
    for (const mode of ['content', 'files', 'count'] as const) {
      const hit = await grep({ pattern: 'sk_live_[N-Z]', output_mode: mode });
      const miss = await grep({ pattern: 'sk_live_[A-M]', output_mode: mode });
      expect(hit.content).toBe('No matches for sk_live_[N-Z].');
      expect(miss.content).toBe('No matches for sk_live_[A-M].');
      expect(hit.display).toEqual(miss.display);
    }
    const mixed = await grep({ pattern: 'Q7x|refreshToken', output_mode: 'files' });
    expect(mixed.content).not.toMatch(/\.env|app\.key|secret/);
    // Asking for the secret file itself still searches it (reading it asks first).
    const direct = await grep({ pattern: 'sk_live', path: 'config/.env.local' });
    expect(lines(direct.content)).toEqual(['config/.env.local:1:TOKEN=sk_live_Q7x']);
  });

  test('searches case-insensitively when asked', async () => {
    const result = await grep({ pattern: 'refreshtoken', case_insensitive: true, path: 'src' });
    expect(lines(result.content)).toContain('src/auth/tokens.ts:2:  // RefreshToken rotation');
    expect(result.display?.summary).toBe('4 matches in 2 files');
  });

  test('shows context lines with "-" and separates groups with "--"', async () => {
    const result = await grep({ pattern: 'return', path: 'src/auth', context: 1 });
    expect(lines(result.content)).toEqual([
      'src/auth/session.ts-3-export function renew() {',
      'src/auth/session.ts:4:  return refreshToken();',
      'src/auth/session.ts-5-}',
      '--',
      'src/auth/tokens.ts-2-  // RefreshToken rotation',
      'src/auth/tokens.ts:3:  return "token";',
      'src/auth/tokens.ts-4-}',
    ]);
  });

  test('lists files or counts per file', async () => {
    const files = await grep({ pattern: 'refreshToken', output_mode: 'files' });
    expect(lines(files.content).slice(0, 3)).toEqual([
      'docs/notes.md',
      'src/auth/session.ts',
      'src/auth/tokens.ts',
    ]);
    expect(files.display?.summary).toBe('3 files');

    const counts = await grep({ pattern: 'refreshToken', output_mode: 'count' });
    expect(lines(counts.content).slice(0, 4)).toEqual([
      'docs/notes.md:1',
      'src/auth/session.ts:2',
      'src/auth/tokens.ts:1',
      'Total: 4 matches in 3 files.',
    ]);
  });

  test('restricts the search with a glob', async () => {
    const result = await grep({ pattern: 'refreshToken', glob: '*.md' });
    expect(lines(result.content)).toEqual(['docs/notes.md:1:refreshToken is documented here']);
    const anchored = await grep({ pattern: 'refreshToken', glob: 'src/auth/*.ts' });
    expect(anchored.display?.summary).toBe('3 matches in 2 files');
    // A glob never brings back files that .gitignore excludes.
    const ignored = await grep({ pattern: 'refreshToken', glob: '*.log' });
    expect(ignored.display?.summary).toBe('no matches');
  });

  test('honors .gitignore and never searches .git', async () => {
    writeFiles(temp.dir, { '.git/config': 'refreshToken\n' });
    const output = (await grep({ pattern: 'refreshToken', output_mode: 'files' })).content;
    expect(output).not.toContain('build/out.js');
    expect(output).not.toContain('debug.log');
    expect(output).not.toContain('.git/config');
  });

  test('truncates at max_results with an explicit note', async () => {
    const result = await grep({ pattern: 'refreshToken', max_results: 2 });
    expect(lines(result.content).slice(0, 3)).toEqual([
      'docs/notes.md:1:refreshToken is documented here',
      'src/auth/session.ts:1:import { refreshToken } from "./tokens";',
      '... 2 more matches (narrow the search with path or glob, or raise max_results)',
    ]);
    expect(result.display?.summary).toBe('4 matches in 3 files');

    const files = await grep({ pattern: 'refreshToken', output_mode: 'files', max_results: 1 });
    expect(lines(files.content).slice(0, 2)).toEqual([
      'docs/notes.md',
      '... 2 more files (narrow the search with path or glob, or raise max_results)',
    ]);
  });

  test('reports no matches without an error', async () => {
    const result = await grep({ pattern: 'doesNotExistAnywhere', path: 'src', glob: '*.ts' });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      'No matches for doesNotExistAnywhere in src (files matching *.ts).',
    );
    expect(result.display?.summary).toBe('no matches');
  });

  test('turns an invalid regular expression into a ToolError', async () => {
    await expect(grep({ pattern: 'foo(' })).rejects.toThrow(/^Invalid regular expression/);
  });

  test('supports look-around patterns', async () => {
    const result = await grep({ pattern: 'refresh(?=Token\\(\\))', path: 'src' });
    expect(result.display?.summary).toBe('2 matches in 2 files');
  });

  test('searches a single file, even a secret one when asked for it explicitly', async () => {
    const single = await grep({ pattern: 'second', path: 'windows.txt' });
    expect(lines(single.content)).toEqual(['windows.txt:2:second line']);
    const secret = await grep({ pattern: 'refreshToken', path: '.env' });
    expect(lines(secret.content)).toEqual(['.env:1:refreshToken=super-secret']);
  });

  test('treats CRLF as a line ending', async () => {
    const result = await grep({ pattern: 'line$', path: 'windows.txt' });
    expect(lines(result.content)).toEqual([
      'windows.txt:1:first line',
      'windows.txt:2:second line',
    ]);
    expect(result.content).not.toContain('\r');
  });

  test('shortens very long lines around the match', async () => {
    writeFiles(temp.dir, { 'min.js': `${'a'.repeat(5000)}NEEDLE${'b'.repeat(5000)}\n` });
    const result = await grep({ pattern: 'NEEDLE', path: 'min.js' });
    const [line] = lines(result.content);
    expect(line).toMatch(/^min\.js:1:…a+NEEDLEb+…$/);
    expect(line.length).toBeLessThan(400);
    expect(result.content).toContain('were shortened');
  });

  test('fails for missing paths and empty patterns', async () => {
    await expect(grep({ pattern: 'x', path: 'missing' })).rejects.toThrow(
      'Path not found: missing',
    );
    await expect(grep({ pattern: '' })).rejects.toThrow('pattern must not be empty.');
  });

  test('stops with an AbortError when the signal fires', async () => {
    const controller = new AbortController();
    controller.abort();
    ctx = { ...ctx, signal: controller.signal };
    await expect(grep({ pattern: 'refreshToken' })).rejects.toBeInstanceOf(AbortError);
  });
});

describe.runIf(ripgrep !== null)('grep engines agree', () => {
  let temp: { dir: string; cleanup: () => void };

  beforeEach(() => {
    temp = makeTempDir();
    writeFiles(temp.dir, {
      ...FIXTURE,
      'src/nested/.gitignore': 'ignored.ts\n',
      'src/nested/ignored.ts': 'refreshToken\n',
      'src/nested/kept.ts': 'a\nrefreshToken\nb\nc\nd\nrefreshToken()\n',
      'src/binary.dat': 'refreshToken\0binary',
    });
  });

  afterEach(() => temp.cleanup());

  const queries: Partial<GrepQuery>[] = [
    { pattern: 'refreshToken' },
    { pattern: 'refreshToken', context: 2 },
    { pattern: 'REFRESH', caseInsensitive: true, mode: 'count' },
    { pattern: 'token', mode: 'files', glob: '*.ts' },
    { pattern: 'refreshToken', glob: '*.ts' },
    { pattern: 'refreshToken', glob: '*.{log,md}', mode: 'count' },
    { pattern: 'refreshToken', maxResults: 3, context: 1 },
    { pattern: '^\\s+return', glob: 'src/**' },
  ];

  it.each(queries)('for %o', async (overrides) => {
    const query: GrepQuery = {
      pattern: '',
      target: temp.dir,
      targetIsDirectory: true,
      caseInsensitive: false,
      mode: 'content',
      context: 0,
      maxResults: 200,
      hideSensitive: true,
      signal: new AbortController().signal,
      ...overrides,
    };
    const fromRipgrep = await grepWithRipgrep(ripgrep as string, query);
    const fromJavaScript = await grepWithJavaScript(query);
    expect(fromJavaScript).toEqual(fromRipgrep);
    expect(fromRipgrep.totalFiles).toBeGreaterThan(0);
  });
});

describe('grep search engines and secret files', () => {
  let temp: { dir: string; cleanup: () => void };

  beforeEach(() => {
    temp = makeTempDir();
    writeFiles(temp.dir, { 'a.txt': 'nothing\n', '.env': 'KEY=abc\n', id_rsa: 'abc\n' });
  });

  afterEach(() => temp.cleanup());

  const engines = [
    { name: 'JavaScript fallback', run: (query: GrepQuery) => grepWithJavaScript(query) },
    ...(ripgrep === null
      ? []
      : [
          {
            name: 'ripgrep',
            run: (query: GrepQuery) => grepWithRipgrep(ripgrep as string, query),
          },
        ]),
  ];

  it.each(engines)('$name does not search them in directory searches', async ({ run }) => {
    const query = (pattern: string, mode: GrepQuery['mode']): GrepQuery => ({
      pattern,
      target: temp.dir,
      targetIsDirectory: true,
      caseInsensitive: false,
      mode,
      context: 0,
      maxResults: 200,
      hideSensitive: true,
      signal: new AbortController().signal,
    });
    for (const mode of ['content', 'files', 'count'] as const) {
      const hit = await run(query('abc', mode));
      const miss = await run(query('xyz', mode));
      expect(hit).toEqual(miss);
      expect(hit.totalFiles).toBe(0);
    }
    const shown = await run({ ...query('abc', 'files'), hideSensitive: false });
    expect(shown.totalFiles).toBe(2);
  });
});

describe('grep JavaScript fallback limits', () => {
  let temp: { dir: string; cleanup: () => void };

  beforeEach(() => {
    vi.stubEnv('PATCH_NO_RG', '1');
    temp = makeTempDir();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    temp.cleanup();
  });

  it('says which files were too large to search', async () => {
    const big = `needle\n${'x'.repeat(MAX_FALLBACK_FILE_BYTES)}\n`;
    writeFiles(temp.dir, { 'big.txt': big, 'small.txt': 'needle\n' });
    const ctx = makeToolContext({ cwd: temp.dir });
    const result = await runTool(grepTool, { pattern: 'needle' }, ctx);
    expect(lines(result.content)).toEqual([
      'small.txt:1:needle',
      '',
      'Note: 1 file larger than 2.0 MB was not searched; install ripgrep (rg) to search large files.',
    ]);
  });
});

describe('compileSearchPattern', () => {
  it('maps ripgrep inline flags and named groups onto JavaScript', () => {
    expect(compileSearchPattern('(?i)hello', false).test('HELLO')).toBe(true);
    expect(compileSearchPattern('(?P<word>\\w+)', false).exec('abc')?.groups?.word).toBe('abc');
    expect(compileSearchPattern('hello', true).flags).toContain('i');
    expect(() => compileSearchPattern('a[', false)).toThrow(/^Invalid regular expression/);
  });
});

describe('grep call description', () => {
  it('quotes the pattern and names the path and glob', () => {
    const ctx = makeToolContext({ cwd: path.resolve('/patch-test/project') });
    expect(grepTool.summarize({ pattern: 'refreshToken' }, ctx)).toEqual({
      verb: 'grep',
      target: '"refreshToken"',
    });
    expect(grepTool.summarize({ pattern: 'x', path: 'src', glob: '*.ts' }, ctx)).toEqual({
      verb: 'grep',
      target: '"x" in src',
      detail: '*.ts',
    });
  });
});
