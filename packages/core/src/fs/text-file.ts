import { isUtf8 } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream, type Stats } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { formatBytes, normalizeNewlines } from '@patch/shared';
import { ToolError } from '../tools/types.js';
import type { FileSnapshot } from './file-state.js';
import { describeFsError, errorCode, isMissingError } from './fs-errors.js';

export type LineEnding = '\n' | '\r\n';

export interface TextFile {
  /** Content with line endings normalized to "\n". */
  content: string;
  /** Dominant line ending of the file on disk. */
  lineEnding: LineEnding;
  /** True when the file starts with a UTF-8 BOM (stripped from `content`). */
  bom: boolean;
  snapshot: FileSnapshot;
  /**
   * True when the bytes are not valid UTF-8 (e.g. a Latin-1 file): invalid sequences were decoded
   * as U+FFFD, so writing `content` back would not reproduce the original bytes.
   */
  lossy?: boolean;
}

/** Files larger than this are refused by read operations that load the whole file. */
export const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024;

/** How much of a file is inspected for NUL bytes when deciding whether it is binary. */
const BINARY_SNIFF_BYTES = 8192;

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function hasUtf16Bom(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  );
}

function systemError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function sha1(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

function readFailure(error: unknown, displayPath: string): ToolError {
  if (error instanceof ToolError) return error;
  if (isMissingError(error)) return new ToolError(`File not found: ${displayPath}`);
  const code = errorCode(error);
  if (code === 'EISDIR') return new ToolError(`${displayPath} is a directory, not a file.`);
  if (code === 'EACCES' || code === 'EPERM') {
    return new ToolError(`Permission denied: ${displayPath}`);
  }
  return new ToolError(`Could not read ${displayPath}: ${describeFsError(error)}.`);
}

/** Dominant line ending of `text`; "\n" when there are no line breaks or on a tie. */
export function detectLineEnding(text: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    if (index > 0 && text.charCodeAt(index - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * Reads a UTF-8 text file. Throws ToolError for: missing file ("File not found: <display>"),
 * directories, binary files (NUL byte in the first 8 KB → "<display> is a binary file"),
 * and files over MAX_TEXT_FILE_BYTES.
 */
export async function readTextFile(absolutePath: string, displayPath: string): Promise<TextFile> {
  let bytes: Buffer;
  let stats: Stats;
  try {
    // Checking the type before opening matters: opening a FIFO would block until a writer appears.
    stats = await stat(absolutePath);
    if (stats.isDirectory()) throw new ToolError(`${displayPath} is a directory, not a file.`);
    if (!stats.isFile()) throw new ToolError(`${displayPath} is not a regular file.`);
    if (stats.size > MAX_TEXT_FILE_BYTES) {
      throw new ToolError(
        `${displayPath} is too large to read (${formatBytes(stats.size)}; the limit is ${formatBytes(MAX_TEXT_FILE_BYTES)}). Use grep to search it instead.`,
      );
    }
    bytes = await readFile(absolutePath);
  } catch (error) {
    throw readFailure(error, displayPath);
  }
  if (hasUtf16Bom(bytes)) {
    throw new ToolError(
      `${displayPath} is UTF-16 encoded; only UTF-8 text files can be read and edited.`,
    );
  }
  if (isBinaryBuffer(bytes)) {
    throw new ToolError(`${displayPath} is a binary file and cannot be read as text.`);
  }
  const bom = hasUtf8Bom(bytes);
  const body = bom ? bytes.subarray(3) : bytes;
  const text = body.toString('utf8');
  return {
    content: normalizeNewlines(text),
    lineEnding: detectLineEnding(text),
    bom,
    snapshot: { mtimeMs: stats.mtimeMs, size: bytes.length, hash: sha1(bytes) },
    ...(isUtf8(body) ? {} : { lossy: true }),
  };
}

function encodeText(content: string, lineEnding: LineEnding, bom: boolean): Buffer {
  const withoutBom = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const lf = withoutBom.replace(/\r\n/g, '\n');
  const text = lineEnding === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
  return Buffer.from(bom ? `\uFEFF${text}` : text, 'utf8');
}

/** Writing through a symlink must update its target, not replace the link with a regular file. */
async function writeTarget(absolutePath: string): Promise<string> {
  try {
    return await realpath(absolutePath);
  } catch {
    return absolutePath;
  }
}

async function replaceAtomically(target: string, bytes: Buffer, mode: number | undefined) {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    await writeFile(temp, bytes, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
    if (mode !== undefined) await chmod(temp, mode);
    await rename(temp, target);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
    // Rename can fail on Windows when another process holds the file open; write in place.
    await writeFile(target, bytes);
  }
}

/**
 * Writes text atomically (temp file in the same directory + rename; falls back to direct write
 * if rename fails, e.g. on Windows when the file is locked). `content` uses "\n"; it is converted
 * to `lineEnding` and prefixed with a BOM when `bom` is true. Creates parent directories.
 * Returns the snapshot of the written bytes.
 *
 * Existing files keep their permission bits; read-only files are refused (EACCES) rather than
 * silently replaced, which a rename would otherwise allow on POSIX.
 */
export async function writeTextFile(
  absolutePath: string,
  content: string,
  options: { lineEnding?: LineEnding; bom?: boolean } = {},
): Promise<FileSnapshot> {
  const bytes = encodeText(content, options.lineEnding ?? '\n', options.bom ?? false);
  const target = await writeTarget(absolutePath);
  let existing: Stats | undefined;
  try {
    existing = await stat(target);
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }
  if (existing?.isDirectory()) throw systemError('EISDIR', 'illegal operation on a directory');
  if (existing) await access(target, constants.W_OK);
  else await mkdir(path.dirname(target), { recursive: true });
  await replaceAtomically(target, bytes, existing ? existing.mode & 0o7777 : undefined);
  const written = await stat(target);
  return { mtimeMs: written.mtimeMs, size: bytes.length, hash: sha1(bytes) };
}

/** Snapshot of the current bytes on disk, or undefined when the file does not exist. */
export async function snapshotFile(absolutePath: string): Promise<FileSnapshot | undefined> {
  let stats: Stats;
  try {
    stats = await stat(absolutePath);
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw error;
  }
  if (!stats.isFile()) return undefined;
  const hash = createHash('sha1');
  let size = 0;
  for await (const chunk of createReadStream(absolutePath)) {
    const bytes = chunk as Buffer;
    hash.update(bytes);
    size += bytes.length;
  }
  return { mtimeMs: stats.mtimeMs, size, hash: hash.digest('hex') };
}

export function isBinaryBuffer(buffer: Uint8Array): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}
