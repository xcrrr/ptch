import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeGitRepo, makeTempDir, writeFiles } from '../../src/testing/index.js';
import { readFileTool } from '../../src/tools/read-file.js';
import type { ToolContext } from '../../src/tools/types.js';
import { writeFileTool } from '../../src/tools/write-file.js';
import { lines, makeToolContext, runTool } from './context.js';

describe('write_file', () => {
  let temp: { dir: string; cleanup: () => void };
  let ctx: ToolContext;
  const abs = (relative: string) => path.join(temp.dir, relative);
  const write = (relative: string, content: string) =>
    runTool(writeFileTool, { path: relative, content }, ctx);
  const read = (relative: string, extra: { offset?: number; limit?: number } = {}) =>
    runTool(readFileTool, { path: relative, ...extra }, ctx);

  beforeEach(() => {
    temp = makeTempDir();
    ctx = makeToolContext({ cwd: temp.dir });
  });

  afterEach(() => temp.cleanup());

  it('creates new files and their parent directories', async () => {
    expect(writeFileTool.summarize({ path: 'src/lib/new.ts', content: 'a\nb\n' }, ctx)).toEqual({
      verb: 'create',
      target: 'src/lib/new.ts',
      detail: '2 lines',
    });
    const result = await write('src/lib/new.ts', 'export const a = 1;\nexport const b = 2;\n');
    expect(result.content).toBe('Created src/lib/new.ts (2 lines).');
    expect(readFileSync(abs('src/lib/new.ts'), 'utf8')).toBe(
      'export const a = 1;\nexport const b = 2;\n',
    );
    expect(result.display?.diff).toMatchObject({ isNew: true, added: 2, removed: 0 });
    expect(result.display?.summary).toBe('2 lines');
    expect(ctx.fileState.wasWrittenByPatch(abs('src/lib/new.ts'))).toBe(true);
    expect(readdirSync(abs('src/lib'))).toEqual(['new.ts']);
  });

  it('requires a full read before overwriting an existing file', async () => {
    writeFiles(temp.dir, { 'a.txt': 'one\ntwo\nthree\n' });
    expect(writeFileTool.summarize({ path: 'a.txt', content: '' }, ctx).verb).toBe('write');
    await expect(write('a.txt', 'replaced\n')).rejects.toThrow('Read a.txt before overwriting it.');

    await read('a.txt', { limit: 1 });
    await expect(write('a.txt', 'replaced\n')).rejects.toThrow(
      'Read all of a.txt before overwriting it (only part of it has been read).',
    );

    await read('a.txt');
    const result = await write('a.txt', 'one\nTWO\nthree\nfour\n');
    expect(result.content).toBe('Updated a.txt (+2 -1).');
    expect(result.display?.summary).toBe('+2 -1');
    expect(readFileSync(abs('a.txt'), 'utf8')).toBe('one\nTWO\nthree\nfour\n');
  });

  it('refuses to overwrite a file that changed on disk since it was read', async () => {
    writeFiles(temp.dir, { 'a.txt': 'original\n' });
    await read('a.txt');
    writeFileSync(abs('a.txt'), 'edited by the user\n');
    await expect(write('a.txt', 'from the model\n')).rejects.toThrow(
      'a.txt has changed since it was last read. Read it again before writing.',
    );
    expect(readFileSync(abs('a.txt'), 'utf8')).toBe('edited by the user\n');
  });

  it('lets Patch overwrite its own writes without reading again', async () => {
    await write('gen.txt', 'v1\n');
    const second = await write('gen.txt', 'v2\n');
    expect(second.content).toBe('Updated gen.txt (+1 -1).');
    expect(readFileSync(abs('gen.txt'), 'utf8')).toBe('v2\n');
  });

  it('keeps the line endings and BOM of the file it replaces', async () => {
    writeFileSync(abs('win.txt'), Buffer.from('\uFEFFa\r\nb\r\n', 'utf8'));
    await read('win.txt');
    await write('win.txt', 'a\nb\nc\n');
    expect(readFileSync(abs('win.txt'), 'utf8')).toBe('\uFEFFa\r\nb\r\nc\r\n');
  });

  it('keeps CRLF or a BOM that the model writes into a new file', async () => {
    await write('script.bat', '@echo off\r\necho hi\r\n');
    expect(readFileSync(abs('script.bat'), 'utf8')).toBe('@echo off\r\necho hi\r\n');
    await write('bom.txt', '\uFEFFhello\n');
    expect(readFileSync(abs('bom.txt'), 'utf8')).toBe('\uFEFFhello\n');
  });

  it('reports identical content without rewriting the file', async () => {
    writeFiles(temp.dir, { 'same.txt': 'same\n' });
    await read('same.txt');
    const result = await write('same.txt', 'same\n');
    expect(result.content).toBe('No changes: same.txt already has this content.');
    expect(ctx.fileState.wasWrittenByPatch(abs('same.txt'))).toBe(false);
  });

  it('refuses directories, in permission() as well', async () => {
    writeFiles(temp.dir, { 'dir/x.txt': '' });
    await expect(writeFileTool.permission({ path: 'dir', content: 'x' }, ctx)).rejects.toThrow(
      'dir is a directory',
    );
    await expect(
      writeFileTool.permission({ path: 'dir/x.txt', content: 'x' }, ctx),
    ).rejects.toThrow('Read dir/x.txt before overwriting it.');
  });

  it('previews the diff without writing', async () => {
    writeFiles(temp.dir, { 'a.txt': 'a\n' });
    await read('a.txt');
    const preview = await writeFileTool.preview?.({ path: 'a.txt', content: 'a\nb\n' }, ctx);
    expect(preview?.diff).toMatchObject({ path: 'a.txt', added: 1, removed: 0, isNew: false });
    const created = await writeFileTool.preview?.({ path: 'n.txt', content: 'x\n' }, ctx);
    expect(created?.diff).toMatchObject({ isNew: true, added: 1 });
    expect(readFileSync(abs('a.txt'), 'utf8')).toBe('a\n');
    expect(readdirSync(temp.dir)).toEqual(['a.txt']);
  });
});

describe('write_file in a Git repository', () => {
  it('notes uncommitted user changes in the file it replaces', async () => {
    const repo = makeGitRepo({ 'config.json': '{}\n' });
    try {
      const ctx = makeToolContext({ cwd: repo.dir, gitRoot: repo.dir });
      writeFileSync(path.join(repo.dir, 'config.json'), '{ "user": true }\n');
      await runTool(readFileTool, { path: 'config.json' }, ctx);
      const result = await runTool(
        writeFileTool,
        { path: 'config.json', content: '{ "patch": true }\n' },
        ctx,
      );
      expect(lines(result.content)).toEqual([
        'Updated config.json (+1 -1).',
        'Note: config.json already had uncommitted changes that were not made by Patch.',
      ]);
    } finally {
      repo.cleanup();
    }
  });
});
