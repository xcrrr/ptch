import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectLineEnding,
  isBinaryBuffer,
  MAX_TEXT_FILE_BYTES,
  readTextFile,
  snapshotFile,
  writeTextFile,
} from '../../src/fs/text-file.js';
import { makeTempDir, writeFiles } from '../../src/testing/index.js';
import { ToolError } from '../../src/tools/types.js';

const sha1 = (bytes: Buffer | string) => createHash('sha1').update(bytes).digest('hex');

describe('text files', () => {
  let temp: { dir: string; cleanup: () => void };
  const file = (name: string) => path.join(temp.dir, name);

  beforeEach(() => {
    temp = makeTempDir();
  });

  afterEach(() => temp.cleanup());

  describe('readTextFile', () => {
    it('reads LF files with a snapshot of the exact bytes', async () => {
      writeFiles(temp.dir, { 'a.txt': 'one\ntwo\n' });
      const text = await readTextFile(file('a.txt'), 'a.txt');
      expect(text).toMatchObject({ content: 'one\ntwo\n', lineEnding: '\n', bom: false });
      expect(text.lossy).toBeUndefined();
      expect(text.snapshot.hash).toBe(sha1('one\ntwo\n'));
      expect(text.snapshot.size).toBe(8);
      expect(text.snapshot.mtimeMs).toBe(statSync(file('a.txt')).mtimeMs);
    });

    it('normalizes CRLF to LF and remembers the line ending', async () => {
      writeFiles(temp.dir, { 'crlf.txt': 'one\r\ntwo\r\nthree' });
      const text = await readTextFile(file('crlf.txt'), 'crlf.txt');
      expect(text.content).toBe('one\ntwo\nthree');
      expect(text.lineEnding).toBe('\r\n');
    });

    it('strips and remembers a UTF-8 BOM', async () => {
      writeFileSync(file('bom.txt'), Buffer.from('\uFEFFhello\n', 'utf8'));
      const text = await readTextFile(file('bom.txt'), 'bom.txt');
      expect(text.bom).toBe(true);
      expect(text.content).toBe('hello\n');
    });

    it('marks files that are not valid UTF-8 as lossy', async () => {
      writeFileSync(file('latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
      const text = await readTextFile(file('latin1.txt'), 'latin1.txt');
      expect(text.lossy).toBe(true);
      expect(text.content).toBe('caf\uFFFD\n');
    });

    it('refuses missing files, directories, binary files, UTF-16 and oversized files', async () => {
      writeFileSync(file('image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
      writeFileSync(file('utf16.txt'), Buffer.from('\uFEFFhi', 'utf16le'));
      writeFiles(temp.dir, { 'dir/x.txt': 'x' });
      writeFileSync(file('huge.log'), '');
      truncateSync(file('huge.log'), MAX_TEXT_FILE_BYTES + 1);

      await expect(readTextFile(file('nope.txt'), 'nope.txt')).rejects.toThrow(
        'File not found: nope.txt',
      );
      await expect(readTextFile(file('dir/x.txt/y'), 'dir/x.txt/y')).rejects.toThrow(
        'File not found',
      );
      await expect(readTextFile(file('dir'), 'dir')).rejects.toThrow('dir is a directory');
      await expect(readTextFile(file('image.png'), 'image.png')).rejects.toThrow(
        'image.png is a binary file',
      );
      await expect(readTextFile(file('utf16.txt'), 'utf16.txt')).rejects.toThrow(/UTF-16/);
      await expect(readTextFile(file('huge.log'), 'huge.log')).rejects.toThrow(/too large/);
      await expect(readTextFile(file('nope.txt'), 'nope.txt')).rejects.toBeInstanceOf(ToolError);
    });
  });

  describe('writeTextFile', () => {
    it('round-trips CRLF files without doubling carriage returns', async () => {
      writeFiles(temp.dir, { 'crlf.txt': 'a\r\nb\r\n' });
      const original = await readTextFile(file('crlf.txt'), 'crlf.txt');
      await writeTextFile(file('crlf.txt'), original.content.replace('b', 'B'), {
        lineEnding: original.lineEnding,
      });
      expect(readFileSync(file('crlf.txt'), 'utf8')).toBe('a\r\nB\r\n');

      // Content that already contains CRLF is normalized before conversion.
      await writeTextFile(file('crlf.txt'), 'x\r\ny\n', { lineEnding: '\r\n' });
      expect(readFileSync(file('crlf.txt'), 'utf8')).toBe('x\r\ny\r\n');
      await writeTextFile(file('lf.txt'), 'x\r\ny\r\n', { lineEnding: '\n' });
      expect(readFileSync(file('lf.txt'), 'utf8')).toBe('x\ny\n');
    });

    it('writes a BOM only when asked, never twice', async () => {
      await writeTextFile(file('bom.txt'), 'hello\n', { bom: true });
      expect([...readFileSync(file('bom.txt')).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      await writeTextFile(file('bom.txt'), '\uFEFFhello\n', { bom: true });
      expect(readFileSync(file('bom.txt'), 'utf8')).toBe('\uFEFFhello\n');
      await writeTextFile(file('plain.txt'), 'hello\n');
      expect(readFileSync(file('plain.txt'), 'utf8')).toBe('hello\n');
    });

    it('creates parent directories, leaves no temp files and returns the disk snapshot', async () => {
      const target = file('deep/nested/dir/new.ts');
      const snapshot = await writeTextFile(target, 'export const x = 1;\n');
      expect(readFileSync(target, 'utf8')).toBe('export const x = 1;\n');
      expect(snapshot).toEqual(await snapshotFile(target));
      expect(snapshot.hash).toBe(sha1('export const x = 1;\n'));
      expect(readdirSync(path.dirname(target))).toEqual(['new.ts']);
    });

    it('replaces existing content in full', async () => {
      writeFiles(temp.dir, { 'a.txt': 'a much longer original content\n' });
      await writeTextFile(file('a.txt'), 'short\n');
      expect(readFileSync(file('a.txt'), 'utf8')).toBe('short\n');
      expect(readdirSync(temp.dir)).toEqual(['a.txt']);
    });

    it.skipIf(process.platform === 'win32')(
      'keeps the permission bits of existing files',
      async () => {
        writeFiles(temp.dir, { 'run.sh': '#!/bin/sh\necho hi\n' });
        chmodSync(file('run.sh'), 0o755);
        await writeTextFile(file('run.sh'), '#!/bin/sh\necho bye\n');
        expect(statSync(file('run.sh')).mode & 0o777).toBe(0o755);
      },
    );

    it.skipIf(process.getuid?.() === 0)('refuses to replace read-only files', async () => {
      writeFiles(temp.dir, { 'locked.txt': 'keep\n' });
      chmodSync(file('locked.txt'), 0o444);
      try {
        await expect(writeTextFile(file('locked.txt'), 'changed\n')).rejects.toMatchObject({
          code: expect.stringMatching(/EACCES|EPERM/),
        });
        expect(readFileSync(file('locked.txt'), 'utf8')).toBe('keep\n');
      } finally {
        chmodSync(file('locked.txt'), 0o644);
      }
    });

    it('refuses to write over a directory', async () => {
      writeFiles(temp.dir, { 'dir/x.txt': 'x' });
      await expect(writeTextFile(file('dir'), 'x')).rejects.toMatchObject({ code: 'EISDIR' });
    });

    it('writes through a symlink to its target', async (context) => {
      writeFiles(temp.dir, { 'real.txt': 'old\n' });
      try {
        symlinkSync(file('real.txt'), file('link.txt'), 'file');
      } catch {
        context.skip();
      }
      await writeTextFile(file('link.txt'), 'new\n');
      expect(readFileSync(file('real.txt'), 'utf8')).toBe('new\n');
      expect(lstatSync(file('link.txt')).isSymbolicLink()).toBe(true);
    });
  });

  describe('snapshotFile', () => {
    it('hashes the bytes on disk and returns undefined for missing files', async () => {
      writeFiles(temp.dir, { 'a.txt': 'abc' });
      const snapshot = await snapshotFile(file('a.txt'));
      expect(snapshot).toMatchObject({ size: 3, hash: sha1('abc') });
      expect(snapshot).toEqual((await readTextFile(file('a.txt'), 'a.txt')).snapshot);
      expect(await snapshotFile(file('missing.txt'))).toBeUndefined();
      expect(await snapshotFile(file('missing-dir/a.txt'))).toBeUndefined();
    });
  });
});

describe('isBinaryBuffer', () => {
  it('looks for NUL bytes in the first 8 KB only', () => {
    expect(isBinaryBuffer(Buffer.from('plain text'))).toBe(false);
    expect(isBinaryBuffer(Buffer.alloc(0))).toBe(false);
    expect(isBinaryBuffer(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
    const lateNul = Buffer.alloc(9000, 0x41);
    lateNul[8500] = 0;
    expect(isBinaryBuffer(lateNul)).toBe(false);
  });
});

describe('detectLineEnding', () => {
  it('picks the dominant line ending, preferring LF on ties', () => {
    expect(detectLineEnding('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(detectLineEnding('a\nb\nc\r\n')).toBe('\n');
    expect(detectLineEnding('a\r\nb\n')).toBe('\n');
    expect(detectLineEnding('no newline')).toBe('\n');
    expect(detectLineEnding('\r\n')).toBe('\r\n');
  });
});
