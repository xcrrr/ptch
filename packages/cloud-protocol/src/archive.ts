import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { hasUnprintableChars, printablePath } from './paths.js';

/**
 * A small tar.gz reader and writer for workspace snapshots. It only knows regular files and is
 * strict on purpose: the archive comes from a laptop, but the server treats it as untrusted.
 *
 *  - paths must be relative, free of `..`, backslashes, NUL, drive letters and `.git` segments;
 *  - symlinks, hard links and devices are rejected, not skipped;
 *  - entry count, per-file size and total size are limited while reading;
 *  - extraction creates files exclusively (`wx`) under a fresh directory.
 */

export interface ArchiveEntry {
  /** Forward-slash path relative to the archive root. */
  path: string;
  data: Buffer;
  executable?: boolean;
}

export interface ArchiveLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 50_000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 400 * 1024 * 1024,
};

export class ArchiveError extends Error {
  override readonly name = 'ArchiveError';
}

const BLOCK = 512;

/** Returns why `path` cannot be stored in or extracted from a snapshot, or null when it can. */
export function unsafePathReason(path: string): string | null {
  if (path.length === 0) return 'empty path';
  if (path.length > 1_000) return 'path too long';
  if (path.includes('\0')) return 'NUL in path';
  if (hasUnprintableChars(path)) return 'control character in path';
  if (path.includes('\\')) return 'backslash in path';
  if (path.startsWith('/')) return 'absolute path';
  if (/^[A-Za-z]:/.test(path)) return 'drive letter in path';
  const parts = path.split('/');
  for (const part of parts) {
    if (part === '') return 'empty path segment';
    if (part === '.' || part === '..') return 'relative segment in path';
    if (part.toLowerCase() === '.git') return '.git is never part of a snapshot';
  }
  return null;
}

function octal(value: number, width: number): Buffer {
  const text = value.toString(8).padStart(width - 1, '0');
  if (text.length > width - 1) throw new ArchiveError('value too large for a tar header field');
  return Buffer.from(`${text}\0`, 'latin1');
}

function header(name: string, prefix: string, size: number, mode: number, type: string): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  octal(mode, 8).copy(block, 100);
  octal(0, 8).copy(block, 108);
  octal(0, 8).copy(block, 116);
  octal(size, 12).copy(block, 124);
  octal(0, 12).copy(block, 136); // mtime is not preserved: snapshots are content, not history
  block.fill(0x20, 148, 156);
  block.write(type, 156, 1, 'latin1');
  block.write('ustar\0', 257, 'latin1');
  block.write('00', 263, 'latin1');
  block.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `, 'latin1').copy(block, 148);
  return block;
}

function padded(data: Buffer): Buffer {
  const rest = data.length % BLOCK;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rest)]);
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) {
    length = String(length).length + Buffer.byteLength(body);
  }
  return Buffer.from(`${length}${body}`, 'utf8');
}

/** Builds a tar.gz. Throws `ArchiveError` for a path that is not safe to store. */
export function packTarGz(entries: Iterable<ArchiveEntry>): Buffer {
  const chunks: Buffer[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const reason = unsafePathReason(entry.path);
    if (reason) throw new ArchiveError(`${printablePath(entry.path)}: ${reason}`);
    if (seen.has(entry.path))
      throw new ArchiveError(`${printablePath(entry.path)}: duplicate path`);
    seen.add(entry.path);
    const mode = entry.executable ? 0o755 : 0o644;
    const bytes = Buffer.byteLength(entry.path);
    if (bytes <= 100) {
      chunks.push(header(entry.path, '', entry.data.length, mode, '0'));
    } else {
      const slash = entry.path.lastIndexOf('/', 155);
      const prefix = slash > 0 ? entry.path.slice(0, slash) : '';
      const name = slash > 0 ? entry.path.slice(slash + 1) : '';
      if (prefix && Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
        chunks.push(header(name, prefix, entry.data.length, mode, '0'));
      } else {
        const pax = paxRecord('path', entry.path);
        chunks.push(header('PaxHeader', '', pax.length, 0o644, 'x'), padded(pax));
        chunks.push(header(entry.path.slice(-99), '', entry.data.length, mode, '0'));
      }
    }
    chunks.push(padded(entry.data));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(chunks), { level: 6 });
}

function readOctal(block: Buffer, start: number, length: number): number {
  const text = block
    .toString('latin1', start, start + length)
    .replace(/\0.*$/s, '')
    .trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new ArchiveError('corrupt tar header');
  return Number.parseInt(text, 8);
}

function readString(block: Buffer, start: number, length: number): string {
  const end = block.indexOf(0, start);
  const stop = end === -1 || end > start + length ? start + length : end;
  return block.toString('utf8', start, stop);
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.toString('latin1', offset, space), 10);
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) {
      throw new ArchiveError('corrupt pax header');
    }
    const record = data.toString('utf8', space + 1, offset + length - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return out;
}

export interface ReadEntry {
  path: string;
  data: Buffer;
  executable: boolean;
  sha256: string;
}

/** Reads and validates a tar.gz. Nothing is written anywhere. */
export function readTarGz(
  archive: Buffer,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): ReadEntry[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: limits.maxTotalBytes + limits.maxEntries * 2048 });
  } catch (error) {
    throw new ArchiveError(`not a valid gzip archive (${(error as Error).message})`);
  }
  const entries: ReadEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let pax: Record<string, string> = {};
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    offset += BLOCK;

    const stored = readOctal(block, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
    if (sum !== stored) throw new ArchiveError('tar header checksum mismatch');

    const type = String.fromCharCode(block[156] ?? 0);
    const size = readOctal(block, 124, 12);
    if (size > limits.maxFileBytes)
      throw new ArchiveError('an archive entry exceeds the file size limit');
    const data = tar.subarray(offset, offset + size);
    if (data.length !== size) throw new ArchiveError('archive is truncated');
    offset += Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') {
      pax = parsePax(data);
      continue;
    }
    if (type === 'g') continue;
    if (type === '5') continue; // directories are implied by file paths
    if (type !== '0' && type !== '\0') {
      throw new ArchiveError(`unsupported entry type "${type}" (only regular files are allowed)`);
    }

    const prefix = readString(block, 345, 155);
    const name = readString(block, 0, 100);
    const path = pax.path ?? (prefix ? `${prefix}/${name}` : name);
    pax = {};
    const reason = unsafePathReason(path);
    if (reason) throw new ArchiveError(`${JSON.stringify(path)}: ${reason}`);
    if (seen.has(path)) throw new ArchiveError(`${JSON.stringify(path)}: duplicate path`);
    seen.add(path);
    if (entries.length >= limits.maxEntries)
      throw new ArchiveError('too many files in the archive');
    total += size;
    if (total > limits.maxTotalBytes) throw new ArchiveError('archive is too large when unpacked');

    const mode = readOctal(block, 100, 8);
    entries.push({
      path,
      data: Buffer.from(data),
      executable: (mode & 0o111) !== 0,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
  }
  return entries;
}

/**
 * Writes entries below `root`, which must be a directory the caller just created and nothing
 * else uses. Refuses to overwrite and to leave `root`.
 */
export function extractEntries(entries: readonly ReadEntry[], root: string): void {
  const base = resolve(root);
  for (const entry of entries) {
    const reason = unsafePathReason(entry.path);
    if (reason) throw new ArchiveError(`${JSON.stringify(entry.path)}: ${reason}`);
    const dest = resolve(join(base, ...entry.path.split('/')));
    if (!dest.startsWith(base + sep))
      throw new ArchiveError(`${JSON.stringify(entry.path)} escapes the workspace`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, entry.data, { flag: 'wx', mode: entry.executable ? 0o755 : 0o644 });
  }
}
