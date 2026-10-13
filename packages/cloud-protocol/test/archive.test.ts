import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveError, extractEntries, packTarGz, readTarGz } from '../src/archive.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'archive-'));
  dirs.push(dir);
  return dir;
}

/** Builds a raw tar the way a hostile client could, bypassing the checks of packTarGz. */
function rawTar(entries: Array<{ name: string; type?: string; data?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, type = '0', data = '' } of entries) {
    const block = Buffer.alloc(512);
    block.write(name, 0, 100);
    block.write('0000644\0', 100);
    block.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    block.fill(0x20, 148, 156);
    block.write(type, 156);
    block.write('ustar\0', 257);
    block.write('00', 263);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(block);
    if (data) {
      const body = Buffer.alloc(Math.ceil(data.length / 512) * 512);
      body.write(data);
      blocks.push(body);
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe('tar.gz snapshots', () => {
  it('round-trips files, modes, unicode and long paths', () => {
    const long = `${'deep/'.repeat(40)}file-ąę.txt`;
    const archive = packTarGz([
      { path: 'a.txt', data: Buffer.from('alpha') },
      { path: 'bin/run.sh', data: Buffer.from('#!/bin/sh\n'), executable: true },
      { path: 'src/ünï.ts', data: Buffer.from('x') },
      { path: long, data: Buffer.from('long') },
      { path: 'empty', data: Buffer.alloc(0) },
    ]);
    const entries = readTarGz(archive);
    expect(entries.map((e) => e.path)).toEqual([
      'a.txt',
      'bin/run.sh',
      'src/ünï.ts',
      long,
      'empty',
    ]);
    expect(entries[1]?.executable).toBe(true);
    expect(entries[0]?.executable).toBe(false);
    expect(entries[3]?.data.toString()).toBe('long');
    expect(entries[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('extracts into a directory', () => {
    const dir = temp();
    extractEntries(readTarGz(packTarGz([{ path: 'x/y/z.txt', data: Buffer.from('hello') }])), dir);
    expect(readFileSync(join(dir, 'x/y/z.txt'), 'utf8')).toBe('hello');
    expect(statSync(join(dir, 'x/y')).isDirectory()).toBe(true);
  });

  it.each([
    '../escape.txt',
    'a/../../b',
    '/etc/passwd',
    'C:/Windows/x',
    '.git/config',
    'sub/.git/hooks/pre-commit',
    'a\\b',
    'a//b',
  ])('rejects the path %j when reading', (name) => {
    expect(() => readTarGz(rawTar([{ name, data: 'x' }]))).toThrow(ArchiveError);
  });

  it('refuses to pack unsafe paths and duplicates', () => {
    expect(() => packTarGz([{ path: '../x', data: Buffer.from('') }])).toThrow(ArchiveError);
    expect(() => packTarGz([{ path: '.git/HEAD', data: Buffer.from('') }])).toThrow(/\.git/);
    expect(() =>
      packTarGz([
        { path: 'a', data: Buffer.from('') },
        { path: 'a', data: Buffer.from('') },
      ]),
    ).toThrow(/duplicate/);
  });

  it('rejects symlinks, hard links and devices instead of skipping them', () => {
    for (const type of ['2', '1', '3', '4', '6']) {
      expect(() => readTarGz(rawTar([{ name: 'link', type }]))).toThrow(/unsupported entry type/);
    }
  });

  it('rejects duplicates, truncated archives and non-gzip input', () => {
    expect(() =>
      readTarGz(
        rawTar([
          { name: 'a', data: '1' },
          { name: 'a', data: '2' },
        ]),
      ),
    ).toThrow(/duplicate/);
    const good = packTarGz([{ path: 'a', data: Buffer.alloc(5_000, 1) }]);
    expect(() => readTarGz(good.subarray(0, 10))).toThrow(ArchiveError);
    expect(() => readTarGz(Buffer.from('not gzip'))).toThrow(/gzip/);
  });

  it('enforces limits while reading', () => {
    const archive = packTarGz([
      { path: 'a', data: Buffer.alloc(100) },
      { path: 'b', data: Buffer.alloc(100) },
    ]);
    const roomy = { maxEntries: 10, maxFileBytes: 1e6, maxTotalBytes: 1e6 };
    expect(() => readTarGz(archive, { ...roomy, maxEntries: 1 })).toThrow(/too many/);
    expect(() => readTarGz(archive, { ...roomy, maxFileBytes: 50 })).toThrow(/file size/);
    expect(() => readTarGz(archive, { ...roomy, maxTotalBytes: 150 })).toThrow(/too large/);
  });

  it('never overwrites while extracting', () => {
    const dir = temp();
    const entries = readTarGz(packTarGz([{ path: 'a.txt', data: Buffer.from('1') }]));
    extractEntries(entries, dir);
    expect(() => extractEntries(entries, dir)).toThrow();
  });
});

describe('names with control characters', () => {
  it('are refused by unsafePathReason and never printed raw in errors', async () => {
    const { unsafePathReason, packTarGz } = await import('../src/archive.js');
    for (const name of [
      'a\nb.ts',
      'a\rb',
      'esc\u001b[31mred.ts',
      'tab\there',
      'del\u007f.txt',
      'rtl‮exe.txt',
      'iso⁦x',
      'zero​width',
      'bom﻿x',
    ]) {
      expect(unsafePathReason(name), JSON.stringify(name)).toBe('control character in path');
    }
    expect(unsafePathReason('src/ordinary name (1).ts')).toBeNull();
    expect(unsafePathReason('src/ünïcödé/файл.ts')).toBeNull();
    try {
      packTarGz([{ path: 'x\n## forged\n', data: Buffer.from('a') }]);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('\n');
      expect((error as Error).message).toContain('u000a');
    }
  });
});
