import { mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, writeFiles } from '../../src/testing/index.js';
import { listDirectoryTool, MAX_LIST_ENTRIES } from '../../src/tools/list-directory.js';
import type { ToolContext } from '../../src/tools/types.js';
import { lines, makeToolContext, runTool } from './context.js';

describe('list_directory', () => {
  let temp: { dir: string; cleanup: () => void };
  let ctx: ToolContext;
  const list = (input: { path?: string; depth?: number } = {}) =>
    runTool(listDirectoryTool, input, ctx);

  beforeEach(() => {
    temp = makeTempDir();
    ctx = makeToolContext({ cwd: temp.dir });
  });

  afterEach(() => temp.cleanup());

  it('lists one level with directories first and file sizes', async () => {
    writeFiles(temp.dir, {
      'b.txt': 'x'.repeat(1300),
      'A.md': 'hi',
      'src/index.ts': '',
      'lib/util.ts': '',
      '.env.example': 'X=\n',
    });
    mkdirSync(path.join(temp.dir, 'empty'));
    const result = await list();
    expect(lines(result.content)).toEqual([
      'empty/',
      'lib/',
      'src/',
      '.env.example  3 B',
      'A.md  2 B',
      'b.txt  1.3 KB',
    ]);
    expect(result.display?.summary).toBe('6 entries');
  });

  it('descends to the requested depth as an indented tree', async () => {
    writeFiles(temp.dir, {
      'src/index.ts': 'abc',
      'src/util/strings.ts': '',
      'src/util/deep/x.ts': '',
      'README.md': '',
    });
    mkdirSync(path.join(temp.dir, 'src', 'empty'));
    const result = await list({ depth: 3 });
    expect(lines(result.content)).toEqual([
      'src/',
      '  empty/  (empty)',
      '  util/',
      '    deep/',
      '    strings.ts  0 B',
      '  index.ts  3 B',
      'README.md  0 B',
    ]);
    expect(listDirectoryTool.summarize({ depth: 3 }, ctx)).toEqual({
      verb: 'ls',
      target: '.',
      detail: 'depth 3',
    });
  });

  it('does not expand generated directories unless asked to list inside one', async () => {
    writeFiles(temp.dir, {
      'node_modules/pkg/index.js': '',
      'src/a.ts': '',
      '.git/config': '',
    });
    const root = await list({ depth: 2 });
    expect(lines(root.content)).toEqual([
      '.git/  (not expanded)',
      'node_modules/  (not expanded)',
      'src/',
      '  a.ts  0 B',
    ]);
    const inside = await list({ path: 'node_modules', depth: 2 });
    expect(lines(inside.content)).toEqual(['pkg/', '  index.js  0 B']);
  });

  it(`caps the listing at ${MAX_LIST_ENTRIES} entries with explicit notes`, async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < MAX_LIST_ENTRIES + 20; index++) {
      files[`f${String(index).padStart(3, '0')}.txt`] = '';
    }
    writeFiles(temp.dir, files);
    const result = await list();
    const output = lines(result.content);
    expect(output.filter((line) => line.startsWith('f'))).toHaveLength(MAX_LIST_ENTRIES);
    expect(output).toContain('... 20 more entries');
    expect(output.at(-1)).toBe(
      'Showing 500 of 520 entries. List a subdirectory or use a smaller depth to see the rest.',
    );
    expect(result.display?.summary).toBe('520 entries');
  });

  it('keeps every top-level entry when nested entries exceed the cap', async () => {
    const files: Record<string, string> = { 'z-top.txt': '' };
    for (let index = 0; index < MAX_LIST_ENTRIES; index++) {
      files[`a-big/f${String(index).padStart(3, '0')}.txt`] = '';
    }
    writeFiles(temp.dir, files);
    const output = lines((await list({ depth: 2 })).content);
    expect(output).toContain('a-big/');
    expect(output).toContain('z-top.txt  0 B');
    expect(output).toContain('  ... 2 more entries');
  });

  it('shows symbolic links with their target without following them', async () => {
    writeFiles(temp.dir, { 'outside/secret.txt': '', 'project/a.txt': '' });
    symlinkSync(
      path.join(temp.dir, 'outside'),
      path.join(temp.dir, 'project', 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const output = lines((await list({ path: 'project', depth: 2 })).content);
    expect(output.some((line) => line.startsWith('link -> '))).toBe(true);
    expect(output.join('\n')).not.toContain('secret.txt');
  });

  it('reports empty directories and wrong targets clearly', async () => {
    mkdirSync(path.join(temp.dir, 'nothing'));
    writeFiles(temp.dir, { 'file.txt': '' });
    const empty = await list({ path: 'nothing' });
    expect(empty.content).toBe('nothing is empty.');
    await expect(list({ path: 'file.txt' })).rejects.toThrow(
      'file.txt is a file, not a directory. Use read_file to read it.',
    );
    await expect(list({ path: 'missing' })).rejects.toThrow('Directory not found: missing');
  });

  it('asks for read permission on the listed directory', async () => {
    const subject = await listDirectoryTool.permission({}, ctx);
    expect(subject).toMatchObject({ kind: 'read', paths: [{ display: '.', insideProject: true }] });
  });
});
