import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { normalizeNewlines } from '@patch/shared';
import { isCaseInsensitivePlatform, relativeInside } from '../git/repo-path.js';
import type { InstructionFile, InstructionSource } from './types.js';

/** Max bytes of a single instruction file loaded into context. */
export const MAX_INSTRUCTION_BYTES = 40_000;

/** Per directory, the first existing file wins: PATCH.md is native, the others are fallbacks. */
const INSTRUCTION_SOURCES: readonly InstructionSource[] = ['PATCH.md', 'CLAUDE.md', 'AGENTS.md'];

interface CappedText {
  text: string;
  truncated: boolean;
}

/**
 * Cuts UTF-8 bytes to at most `maxBytes` without splitting a character, preferring to end at a
 * line break when one is reasonably close to the limit.
 */
function cutUtf8(bytes: Buffer, maxBytes: number): string {
  let end = maxBytes;
  // Step back over continuation bytes (10xxxxxx) so the cut lands on a character boundary.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  const text = bytes.toString('utf8', 0, end);
  const lastBreak = text.lastIndexOf('\n');
  return lastBreak >= text.length * 0.8 ? text.slice(0, lastBreak + 1) : text;
}

/** Reads a regular file, keeping at most `maxBytes`. Undefined when it is missing or unreadable. */
async function readCapped(file: string, maxBytes: number): Promise<CappedText | undefined> {
  let handle;
  try {
    handle = await open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > maxBytes;
    const raw = truncated ? cutUtf8(buffer, maxBytes) : buffer.toString('utf8', 0, bytesRead);
    return { text: normalizeNewlines(raw.replace(/^\uFEFF/, '')), truncated };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface FoundInstructions extends CappedText {
  path: string;
  source: InstructionSource;
}

/** The first of PATCH.md, CLAUDE.md, AGENTS.md that exists as a file in `dir`. */
async function findInstructions(dir: string): Promise<FoundInstructions | undefined> {
  for (const source of INSTRUCTION_SOURCES) {
    const file = path.join(dir, source);
    const read = await readCapped(file, MAX_INSTRUCTION_BYTES);
    if (read) return { ...read, path: file, source };
  }
  return undefined;
}

function toDisplaySlashes(value: string): string {
  return value.split(path.sep).join('/');
}

function displayRelativeTo(file: string, base: string): string {
  return toDisplaySlashes(path.relative(base, file));
}

function displayUserFile(file: string, home: string): string {
  const relative = relativeInside(home, file);
  if (relative === undefined) return file;
  return relative === '' ? '~' : `~/${toDisplaySlashes(relative)}`;
}

/**
 * Where `cwd` sits below the project root ('' for the root itself, undefined when outside).
 * Falls back to the real path when cwd reaches the project through a symlink or junction.
 */
async function cwdBelowRoot(projectRoot: string, cwd: string): Promise<string | undefined> {
  const direct = relativeInside(projectRoot, cwd);
  if (direct !== undefined) return direct;
  try {
    return relativeInside(projectRoot, await realpath(cwd));
  } catch {
    return undefined;
  }
}

function samePath(a: string, b: string): boolean {
  const fold = (value: string) =>
    isCaseInsensitivePlatform(process.platform) ? value.toLowerCase() : value;
  return fold(path.resolve(a)) === fold(path.resolve(b));
}

/**
 * Loads instruction files.
 *  1. User scope: `userInstructionsPath` (~/.patch/PATCH.md) if it exists.
 *  2. Project scope: the first of PATCH.md, CLAUDE.md, AGENTS.md found at the project root.
 *     PATCH.md is native; CLAUDE.md and AGENTS.md are compatibility fallbacks used only when
 *     PATCH.md is absent.
 *  3. If cwd is a subdirectory of the project root, also the first of PATCH.md/CLAUDE.md/AGENTS.md
 *     in cwd (more specific, listed last).
 * Files larger than MAX_INSTRUCTION_BYTES are cut with `truncated: true`.
 *
 * A file that exists but is blank still takes precedence over the fallbacks at its level (so an
 * empty PATCH.md opts out of CLAUDE.md/AGENTS.md) but is not returned.
 */
export async function loadInstructions(options: {
  projectRoot: string;
  cwd: string;
  home: string;
  userInstructionsPath: string;
}): Promise<InstructionFile[]> {
  const { projectRoot, cwd, home, userInstructionsPath } = options;
  const files: InstructionFile[] = [];
  const add = (found: FoundInstructions, scope: InstructionFile['scope'], display: string) => {
    if (found.text.trim() === '') return;
    if (files.some((file) => samePath(file.path, found.path))) return;
    files.push({
      path: found.path,
      display,
      scope,
      source: found.source,
      content: found.text,
      truncated: found.truncated,
    });
  };

  const user = await readCapped(userInstructionsPath, MAX_INSTRUCTION_BYTES);
  if (user) {
    const userFile = { ...user, path: userInstructionsPath, source: 'PATCH.md' as const };
    add(userFile, 'user', displayUserFile(userInstructionsPath, home));
  }

  const [atRoot, below] = await Promise.all([
    findInstructions(projectRoot),
    cwdBelowRoot(projectRoot, cwd),
  ]);
  // Display paths relative to cwd's position inside the project (stable even through symlinks).
  const displayBase = below === undefined ? cwd : path.join(projectRoot, below);
  if (atRoot) add(atRoot, 'project', displayRelativeTo(atRoot.path, displayBase));
  if (below) {
    const inCwd = await findInstructions(displayBase);
    if (inCwd) add(inCwd, 'project', displayRelativeTo(inCwd.path, displayBase));
  }
  return files;
}
