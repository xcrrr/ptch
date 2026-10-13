import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeGitRepo, makeTempDir, writeFiles } from '../../src/testing/index.js';
import { editFileTool } from '../../src/tools/edit-file.js';
import { readFileTool } from '../../src/tools/read-file.js';
import type { ToolContext } from '../../src/tools/types.js';
import { lines, makeToolContext, runTool } from './context.js';

const SOURCE = [
  'export function greet(name: string) {',
  "  return 'hello ' + name;",
  '}',
  '',
  'export function shout(name: string) {',
  "  return 'HELLO ' + name;",
  '}',
  '',
].join('\n');

describe('edit_file', () => {
  let temp: { dir: string; cleanup: () => void };
  let ctx: ToolContext;
  const abs = (relative: string) => path.join(temp.dir, relative);
  const read = (relative: string, extra: { offset?: number; limit?: number } = {}) =>
    runTool(readFileTool, { path: relative, ...extra }, ctx);
  const edit = (input: {
    path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }) => runTool(editFileTool, input, ctx);

  beforeEach(() => {
    temp = makeTempDir();
    ctx = makeToolContext({ cwd: temp.dir });
    writeFiles(temp.dir, { 'src/greet.ts': SOURCE });
  });

  afterEach(() => temp.cleanup());

  it('replaces a unique match and returns a numbered snippet and a diff', async () => {
    await read('src/greet.ts');
    const result = await edit({
      path: 'src/greet.ts',
      old_string: "  return 'hello ' + name;",
      new_string: "  const greeting = 'hello';\n  return `${greeting} ${name}`;",
    });
    expect(lines(result.content)).toEqual([
      'Edited src/greet.ts: replaced 1 occurrence (+2 -1).',
      '     1\texport function greet(name: string) {',
      "     2\t  const greeting = 'hello';",
      '     3\t  return `${greeting} ${name}`;',
      '     4\t}',
      '     5\t',
    ]);
    expect(readFileSync(abs('src/greet.ts'), 'utf8')).toBe(
      SOURCE.replace(
        "  return 'hello ' + name;",
        "  const greeting = 'hello';\n  return `${greeting} ${name}`;",
      ),
    );
    expect(result.display?.summary).toBe('+2 -1');
    expect(result.display?.diff).toMatchObject({ path: 'src/greet.ts', added: 2, removed: 1 });
    expect(ctx.fileState.wasWrittenByPatch(abs('src/greet.ts'))).toBe(true);
  });

  it('allows consecutive edits without re-reading the file', async () => {
    await read('src/greet.ts');
    await edit({ path: 'src/greet.ts', old_string: 'greet(', new_string: 'welcome(' });
    await edit({ path: 'src/greet.ts', old_string: 'shout(', new_string: 'yell(' });
    const text = readFileSync(abs('src/greet.ts'), 'utf8');
    expect(text).toContain('function welcome(');
    expect(text).toContain('function yell(');
  });

  it('refuses ambiguous matches with their line numbers, unless replace_all is set', async () => {
    await read('src/greet.ts');
    await expect(
      edit({ path: 'src/greet.ts', old_string: '(name: string)', new_string: '(who: string)' }),
    ).rejects.toThrow(
      'old_string matches 2 times in src/greet.ts (lines 1, 5). Include more surrounding context to make it unique, or set replace_all.',
    );
    const result = await edit({
      path: 'src/greet.ts',
      old_string: 'name',
      new_string: 'who',
      replace_all: true,
    });
    expect(lines(result.content)[0]).toBe('Edited src/greet.ts: replaced 4 occurrences (+4 -4).');
    expect(lines(result.content)[1]).toBe('First of 4 edited regions:');
    expect(readFileSync(abs('src/greet.ts'), 'utf8')).not.toContain('name');
  });

  it('lists at most ten match locations', async () => {
    writeFiles(temp.dir, { 'many.txt': 'x\n'.repeat(14) });
    await read('many.txt');
    await expect(edit({ path: 'many.txt', old_string: 'x', new_string: 'y' })).rejects.toThrow(
      'old_string matches 14 times in many.txt (lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, and 4 more).',
    );
  });

  it('explains a missing match, with a hint when only whitespace differs', async () => {
    await read('src/greet.ts');
    await expect(
      edit({ path: 'src/greet.ts', old_string: 'goodbye', new_string: 'bye' }),
    ).rejects.toThrow(/^old_string was not found in src\/greet\.ts\.$/);
    await expect(
      edit({
        path: 'src/greet.ts',
        old_string: "export function shout(name: string) {\n\treturn 'HELLO ' + name;",
        new_string: 'x',
      }),
    ).rejects.toThrow(
      'old_string was not found in src/greet.ts. A similar block exists near line 5 with different whitespace or indentation; copy the exact text from the file.',
    );
  });

  it('recognizes line-number prefixes copied from read_file output', async () => {
    await read('src/greet.ts');
    await expect(
      edit({ path: 'src/greet.ts', old_string: '     3\t}\n     4\t', new_string: '}' }),
    ).rejects.toThrow(/line-number prefixes/);
  });

  it('rejects identical and empty strings', async () => {
    await read('src/greet.ts');
    await expect(edit({ path: 'src/greet.ts', old_string: '}', new_string: '}' })).rejects.toThrow(
      'old_string and new_string are identical',
    );
    await expect(edit({ path: 'src/greet.ts', old_string: '', new_string: 'x' })).rejects.toThrow(
      'old_string must not be empty',
    );
  });

  it('requires a prior read and an unchanged file', async () => {
    await expect(
      edit({ path: 'src/greet.ts', old_string: 'greet', new_string: 'welcome' }),
    ).rejects.toThrow('Read src/greet.ts before editing it.');

    await read('src/greet.ts');
    writeFileSync(abs('src/greet.ts'), SOURCE.replace('hello', 'hi'));
    await expect(
      edit({ path: 'src/greet.ts', old_string: 'greet', new_string: 'welcome' }),
    ).rejects.toThrow(
      'src/greet.ts has changed since it was last read. Read it again before editing.',
    );
    expect(readFileSync(abs('src/greet.ts'), 'utf8')).toContain("'hi '");

    await read('src/greet.ts');
    await edit({ path: 'src/greet.ts', old_string: 'greet', new_string: 'welcome' });
    expect(readFileSync(abs('src/greet.ts'), 'utf8')).toContain('welcome');
  });

  it('accepts a partial read, but hints when the text was not in the part that was read', async () => {
    await read('src/greet.ts', { offset: 1, limit: 2 });
    await edit({ path: 'src/greet.ts', old_string: 'greet(', new_string: 'welcome(' });
    expect(readFileSync(abs('src/greet.ts'), 'utf8')).toContain('welcome(');

    writeFiles(temp.dir, { 'other.txt': 'first\nsecond\n' });
    await read('other.txt', { offset: 1, limit: 1 });
    await expect(
      edit({ path: 'other.txt', old_string: 'does not exist', new_string: 'x' }),
    ).rejects.toThrow(
      'old_string was not found in other.txt. Only part of the file has been read; read the section you want to change first.',
    );
  });

  it('matches LF text against CRLF files and keeps CRLF and the BOM', async () => {
    writeFileSync(abs('win.txt'), Buffer.from('\uFEFFalpha\r\nbeta\r\ngamma\r\n', 'utf8'));
    await read('win.txt');
    await edit({ path: 'win.txt', old_string: 'alpha\nbeta', new_string: 'ALPHA\nBETA\nextra' });
    expect(readFileSync(abs('win.txt'), 'utf8')).toBe('\uFEFFALPHA\r\nBETA\r\nextra\r\ngamma\r\n');
    // The model may also send CRLF itself.
    await edit({ path: 'win.txt', old_string: 'extra\r\ngamma', new_string: 'delta' });
    expect(readFileSync(abs('win.txt'), 'utf8')).toBe('\uFEFFALPHA\r\nBETA\r\ndelta\r\n');
  });

  it('inserts replacement text literally, including "$" patterns', async () => {
    await read('src/greet.ts');
    await edit({ path: 'src/greet.ts', old_string: "'hello '", new_string: "'$& $1 $$'" });
    expect(readFileSync(abs('src/greet.ts'), 'utf8')).toContain("return '$& $1 $$' + name;");
  });

  it('can delete text and reports an emptied file', async () => {
    writeFiles(temp.dir, { 'one.txt': 'only line\n' });
    await read('one.txt');
    const result = await edit({ path: 'one.txt', old_string: 'only line\n', new_string: '' });
    expect(lines(result.content)).toEqual([
      'Edited one.txt: replaced 1 occurrence (+0 -1).',
      'The file is now empty.',
    ]);
    expect(readFileSync(abs('one.txt'), 'utf8')).toBe('');
  });

  it('refuses to edit files that are not valid UTF-8', async () => {
    writeFileSync(abs('latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await read('latin1.txt');
    await expect(
      edit({ path: 'latin1.txt', old_string: 'caf', new_string: 'tea' }),
    ).rejects.toThrow(/not valid UTF-8/);
  });

  it('points to write_file for missing files and refuses directories', async () => {
    await expect(edit({ path: 'src/new.ts', old_string: 'a', new_string: 'b' })).rejects.toThrow(
      'File not found: src/new.ts. Use write_file to create a new file.',
    );
    await expect(edit({ path: 'src', old_string: 'a', new_string: 'b' })).rejects.toThrow(
      'src is a directory',
    );
  });

  it('validates in permission() and previews without writing', async () => {
    await expect(
      editFileTool.permission({ path: 'src/greet.ts', old_string: 'greet', new_string: 'x' }, ctx),
    ).rejects.toThrow('Read src/greet.ts before editing it.');

    await read('src/greet.ts');
    const input = { path: 'src/greet.ts', old_string: 'greet', new_string: 'welcome' };
    const subject = await editFileTool.permission(input, ctx);
    expect(subject).toMatchObject({ kind: 'write', paths: [{ display: 'src/greet.ts' }] });
    const preview = await editFileTool.preview?.(input, ctx);
    expect(preview?.diff).toMatchObject({ added: 1, removed: 1, isNew: false });
    expect(readFileSync(abs('src/greet.ts'), 'utf8')).toBe(SOURCE);
    expect(editFileTool.summarize({ ...input, replace_all: true }, ctx)).toEqual({
      verb: 'edit',
      target: 'src/greet.ts',
      detail: 'all occurrences',
    });
  });
});

describe('edit_file in a Git repository', () => {
  let repo: { dir: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeGitRepo({ 'tracked.txt': 'one\ntwo\n', 'clean.txt': 'a\nb\n' });
  });

  afterEach(() => repo.cleanup());

  it('notes user changes that were uncommitted before Patch first edited the file', async () => {
    const ctx = makeToolContext({ cwd: repo.dir, gitRoot: repo.dir });
    const target = path.join(repo.dir, 'tracked.txt');
    writeFileSync(target, 'one\ntwo\nthree (user)\n');
    await runTool(readFileTool, { path: 'tracked.txt' }, ctx);
    const first = await runTool(
      editFileTool,
      { path: 'tracked.txt', old_string: 'one', new_string: 'ONE' },
      ctx,
    );
    expect(lines(first.content).at(-1)).toBe(
      'Note: tracked.txt already had uncommitted changes that were not made by Patch.',
    );
    expect(ctx.fileState.get(target)?.preexistingChanges).toBe(true);

    const second = await runTool(
      editFileTool,
      { path: 'tracked.txt', old_string: 'two', new_string: 'TWO' },
      ctx,
    );
    expect(second.content).not.toContain('uncommitted');
  });

  it('adds no note for files without uncommitted changes', async () => {
    const ctx = makeToolContext({ cwd: repo.dir, gitRoot: repo.dir });
    await runTool(readFileTool, { path: 'clean.txt' }, ctx);
    const result = await runTool(
      editFileTool,
      { path: 'clean.txt', old_string: 'a', new_string: 'A' },
      ctx,
    );
    expect(result.content).not.toContain('uncommitted');
    expect(ctx.fileState.get(path.join(repo.dir, 'clean.txt'))?.preexistingChanges).toBeUndefined();
  });
});
