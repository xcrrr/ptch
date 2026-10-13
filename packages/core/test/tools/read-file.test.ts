import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatBytes } from '@patch/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_IMAGE_FILE_BYTES } from '../../src/fs/image-file.js';
import { makeGitRepo, makeTempDir, pngBytes, writeFiles } from '../../src/testing/index.js';
import {
  DEFAULT_READ_LIMIT,
  MAX_LINE_CHARS,
  MAX_READ_CHARS,
  readFileTool,
} from '../../src/tools/read-file.js';
import { ToolError, type ToolContext } from '../../src/tools/types.js';
import { lines, makeToolContext, runTool } from './context.js';

const numbered = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n') + '\n';

describe('read_file', () => {
  let temp: { dir: string; cleanup: () => void };
  let ctx: ToolContext;
  const abs = (relative: string) => path.join(temp.dir, relative);

  beforeEach(() => {
    temp = makeTempDir();
    ctx = makeToolContext({ cwd: temp.dir });
  });

  afterEach(() => temp.cleanup());

  it('returns a header and numbered lines, and records a full read', async () => {
    const source = 'const a = 1;\n\nexport { a };\n';
    writeFiles(temp.dir, { 'src/a.ts': source });
    const result = await runTool(readFileTool, { path: 'src/a.ts' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(lines(result.content)).toEqual([
      'src/a.ts · lines 1-3 of 3',
      '     1\tconst a = 1;',
      '     2\t',
      '     3\texport { a };',
    ]);
    expect(result.display).toEqual({ summary: '3 lines' });
    const record = ctx.fileState.get(abs('src/a.ts'));
    expect(record?.lastRead?.size).toBe(Buffer.byteLength(source));
    expect(record?.partialRead).toBe(false);
  });

  it('pages with offset and limit and records a partial read', async () => {
    writeFiles(temp.dir, { 'a.txt': numbered(10) });
    const result = await runTool(readFileTool, { path: 'a.txt', offset: 3, limit: 2 }, ctx);
    expect(lines(result.content)).toEqual([
      'a.txt · lines 3-4 of 10',
      '     3\tline 3',
      '     4\tline 4',
      '',
      'Showing lines 3-4 of 10. Continue with offset=5.',
    ]);
    expect(result.display?.summary).toBe('lines 3-4');
    expect(ctx.fileState.get(abs('a.txt'))?.partialRead).toBe(true);

    const tail = await runTool(readFileTool, { path: 'a.txt', offset: 9 }, ctx);
    expect(lines(tail.content)[0]).toBe('a.txt · lines 9-10 of 10');
    expect(tail.content).not.toContain('Continue');
  });

  it(`stops at ${DEFAULT_READ_LIMIT} lines by default and says how to continue`, async () => {
    writeFiles(temp.dir, { 'big.txt': numbered(2500) });
    const result = await runTool(readFileTool, { path: 'big.txt' }, ctx);
    const output = lines(result.content);
    expect(output[0]).toBe('big.txt · lines 1-2000 of 2500');
    expect(output).toContain('  2000\tline 2000');
    expect(output).not.toContain('  2001\tline 2001');
    expect(output.at(-1)).toBe('Showing lines 1-2000 of 2500. Continue with offset=2001.');
  });

  it('truncates very long lines and says so', async () => {
    writeFiles(temp.dir, { 'min.js': `${'x'.repeat(MAX_LINE_CHARS + 500)}\nshort\n` });
    const result = await runTool(readFileTool, { path: 'min.js' }, ctx);
    const output = lines(result.content);
    expect(output[1]).toBe(`     1\t${'x'.repeat(MAX_LINE_CHARS)}… [500 chars truncated]`);
    expect(output[2]).toBe('     2\tshort');
    expect(output.at(-1)).toBe('Note: 1 line longer than 2,000 characters was truncated.');
  });

  it('stops early when the output size limit is reached', async () => {
    const lineCount = 200;
    writeFiles(temp.dir, { 'wide.txt': `${'y'.repeat(1990)}\n`.repeat(lineCount) });
    const result = await runTool(readFileTool, { path: 'wide.txt' }, ctx);
    expect(result.content.length).toBeLessThanOrEqual(MAX_READ_CHARS + 500);
    const continuation = lines(result.content).at(-1) ?? '';
    const match =
      /^Showing lines 1-(\d+) of 200 \(output size limit reached\)\. Continue with offset=(\d+)\.$/.exec(
        continuation,
      );
    expect(match).not.toBeNull();
    expect(Number(match?.[2])).toBe(Number(match?.[1]) + 1);
    expect(ctx.fileState.get(abs('wide.txt'))?.partialRead).toBe(true);
  });

  it('reports empty files and offsets past the end explicitly', async () => {
    writeFiles(temp.dir, { 'empty.txt': '', 'short.txt': 'a\nb\n' });
    const empty = await runTool(readFileTool, { path: 'empty.txt' }, ctx);
    expect(lines(empty.content)).toEqual(['empty.txt · 0 lines', 'The file is empty.']);
    expect(ctx.fileState.get(abs('empty.txt'))?.partialRead).toBe(false);

    const past = await runTool(readFileTool, { path: 'short.txt', offset: 5 }, ctx);
    expect(lines(past.content)).toEqual([
      'short.txt · 2 lines',
      'No lines to show: offset 5 is past the end of the file (2 lines).',
    ]);
    expect(past.isError).toBeUndefined();
    expect(ctx.fileState.get(abs('short.txt'))).toBeUndefined();
  });

  it('shows CRLF files without carriage returns', async () => {
    writeFiles(temp.dir, { 'win.txt': 'one\r\ntwo\r\n' });
    const result = await runTool(readFileTool, { path: 'win.txt' }, ctx);
    expect(result.content).not.toContain('\r');
    expect(lines(result.content).slice(1)).toEqual(['     1\tone', '     2\ttwo']);
  });

  it('notes undecodable bytes in files that are not UTF-8', async () => {
    writeFileSync(abs('latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const result = await runTool(readFileTool, { path: 'latin1.txt' }, ctx);
    expect(result.content).toContain('     1\tcaf\uFFFD');
    expect(result.content).toContain('not valid UTF-8');
  });

  it('fails clearly for missing files, directories and binary files', async () => {
    writeFiles(temp.dir, { 'src/index.ts': 'x\n', 'src/util/x.ts': 'x\n' });
    writeFileSync(abs('logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

    const missing = runTool(readFileTool, { path: 'src/index.js' }, ctx);
    await expect(missing).rejects.toBeInstanceOf(ToolError);
    await expect(runTool(readFileTool, { path: 'src/index.js' }, ctx)).rejects.toThrow(
      'File not found: src/index.js. Did you mean src/index.ts?',
    );
    await expect(runTool(readFileTool, { path: 'nothing/here.ts' }, ctx)).rejects.toThrow(
      /^File not found: nothing\/here\.ts\.$/,
    );
    await expect(runTool(readFileTool, { path: 'src/util' }, ctx)).rejects.toThrow(
      'src/util is a directory. Use list_directory to see its contents.',
    );
    await expect(runTool(readFileTool, { path: 'logo.png' }, ctx)).rejects.toThrow(
      'logo.png is a binary file',
    );
  });

  it('summarizes the call and describes the permission subject', async () => {
    writeFiles(temp.dir, { 'src/a.ts': 'x\n' });
    expect(readFileTool.summarize({ path: 'src/a.ts' }, ctx)).toEqual({
      verb: 'read',
      target: 'src/a.ts',
    });
    expect(readFileTool.summarize({ path: './src/a.ts', offset: 40, limit: 80 }, ctx)).toEqual({
      verb: 'read',
      target: 'src/a.ts',
      detail: 'lines 40-119',
    });
    expect(readFileTool.summarize({ path: 'src/a.ts', offset: 7 }, ctx).detail).toBe('from line 7');

    const subject = await readFileTool.permission({ path: 'src/a.ts' }, ctx);
    expect(subject).toMatchObject({
      kind: 'read',
      paths: [{ display: 'src/a.ts', insideProject: true }],
    });
    const outside = await readFileTool.permission({ path: '../elsewhere.txt' }, ctx);
    expect(outside).toMatchObject({ kind: 'read', paths: [{ insideProject: false }] });
  });
});

describe('read_file in a Git repository', () => {
  let repo: { dir: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeGitRepo({ 'clean.txt': 'clean\n', 'dirty.txt': 'original\n' });
    writeFiles(repo.dir, { 'dirty.txt': 'modified by the user\n' });
  });

  afterEach(() => repo.cleanup());

  it('notes uncommitted changes', async () => {
    const ctx = makeToolContext({ cwd: repo.dir, gitRoot: repo.dir });
    const dirty = await runTool(readFileTool, { path: 'dirty.txt' }, ctx);
    expect(lines(dirty.content).at(-1)).toBe('Note: this file has uncommitted changes.');
    const clean = await runTool(readFileTool, { path: 'clean.txt' }, ctx);
    expect(clean.content).not.toContain('uncommitted');
  });

  it('skips the check in directory mode', async () => {
    const ctx = makeToolContext({ cwd: repo.dir, gitRoot: null });
    const dirty = await runTool(readFileTool, { path: 'dirty.txt' }, ctx);
    expect(dirty.content).not.toContain('uncommitted');
  });
});

describe('read_file on images', () => {
  let temp: { dir: string; cleanup: () => void };
  let ctx: ToolContext;

  beforeEach(() => {
    temp = makeTempDir();
    ctx = makeToolContext({ cwd: temp.dir });
  });

  afterEach(() => temp.cleanup());

  it('returns the image to the model with a one-line description', async () => {
    const bytes = pngBytes(1280, 720);
    mkdirSync(path.join(temp.dir, 'docs'));
    writeFileSync(path.join(temp.dir, 'docs', 'screenshot.png'), bytes);
    const result = await runTool(readFileTool, { path: 'docs/screenshot.png' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      `Image: docs/screenshot.png (1280×720, ${formatBytes(bytes.length)})`,
    );
    expect(result.images).toEqual([
      {
        type: 'image',
        mediaType: 'image/png',
        data: bytes.toString('base64'),
        label: 'screenshot.png',
      },
    ]);
    expect(result.display).toEqual({ summary: 'image 1280×720' });
  });

  it('recognizes images by their content and ignores offset and limit', async () => {
    writeFileSync(path.join(temp.dir, 'capture'), pngBytes(10, 20));
    const result = await runTool(readFileTool, { path: 'capture', offset: 5, limit: 2 }, ctx);
    expect(result.images?.[0]?.mediaType).toBe('image/png');
    expect(result.display?.summary).toBe('image 10×20');
  });

  it('reads files with an image extension but text content as text', async () => {
    writeFiles(temp.dir, { 'logo.png': 'version https://git-lfs.github.com/spec/v1\n' });
    const result = await runTool(readFileTool, { path: 'logo.png' }, ctx);
    expect(result.images).toBeUndefined();
    expect(lines(result.content)[0]).toBe('logo.png · lines 1-1 of 1');
  });

  it('refuses images over the size limit', async () => {
    const big = Buffer.alloc(MAX_IMAGE_FILE_BYTES + 1);
    pngBytes(1, 1).copy(big);
    writeFileSync(path.join(temp.dir, 'big.png'), big);
    await expect(runTool(readFileTool, { path: 'big.png' }, ctx)).rejects.toThrow(
      /^big\.png is too large to send/,
    );
  });
});
