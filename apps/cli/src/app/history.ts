import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** Prompts kept per project (in memory, and in the file after compaction). */
const MAX_ENTRIES = 200;
/** Longer prompts (big pastes) are recalled during the session but never written to the file. */
export const MAX_STORED_PROMPT_CHARS = 64 * 1024;
/** When the file grows past this, it is rewritten with only the entries worth keeping. */
export const HISTORY_COMPACT_BYTES = 2 * 1024 * 1024;
/** A compacted file stays below this, so compaction runs only after this much new history. */
const HISTORY_KEEP_BYTES = HISTORY_COMPACT_BYTES / 2;
/** Startup reads at most this much from the end of the file (newest entries are at the end). */
const LOAD_TAIL_BYTES = HISTORY_COMPACT_BYTES + MAX_STORED_PROMPT_CHARS * 4;
const FILE_MODE = 0o600;

interface HistoryLine {
  project: string;
  text: string;
  ts: string;
}

function projectKey(project: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? project.toLowerCase()
    : project;
}

function parseLine(line: string): HistoryLine | undefined {
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line) as Partial<HistoryLine>;
    if (typeof parsed.text !== 'string' || typeof parsed.project !== 'string') return undefined;
    return { project: parsed.project, text: parsed.text, ts: String(parsed.ts ?? '') };
  } catch {
    return undefined;
  }
}

/**
 * Prompt history for Up/Down recall, per project, stored in ~/.patch/history.jsonl (shared by all
 * projects, newest last). The file stays bounded: huge prompts are not stored, and once it passes
 * HISTORY_COMPACT_BYTES it is rewritten with the newest MAX_ENTRIES distinct prompts per project.
 * Startup reads only the end of the file. Failures never interrupt the session (history is a
 * convenience).
 */
export class PromptHistory {
  private readonly file: string;
  private readonly project: string;
  private entries: string[];

  constructor(patchHome: string, project: string) {
    this.file = join(patchHome, 'history.jsonl');
    this.project = project;
    this.entries = this.load();
  }

  /** Most recent first. */
  list(): readonly string[] {
    return this.entries;
  }

  add(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.entries = [trimmed, ...this.entries.filter((e) => e !== trimmed)].slice(0, MAX_ENTRIES);
    if (trimmed.length > MAX_STORED_PROMPT_CHARS) return;
    const line: HistoryLine = {
      project: this.project,
      text: trimmed,
      ts: new Date().toISOString(),
    };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(line)}\n`, { mode: FILE_MODE });
      if (statSync(this.file).size > HISTORY_COMPACT_BYTES) this.compact();
    } catch {
      // History is best-effort.
    }
  }

  /**
   * Rewrites the file with, per project, the newest MAX_ENTRIES distinct prompts, dropping the
   * oldest lines overall until it fits in HISTORY_KEEP_BYTES. Written to a temporary file and
   * renamed over the original, so a crash never leaves a truncated history.
   */
  private compact(): void {
    const lines = readFileSync(this.file, 'utf8').split('\n');
    const kept: string[] = [];
    const seen = new Map<string, Set<string>>();
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = lines[i] ?? '';
      const parsed = parseLine(raw);
      if (!parsed) continue;
      const key = projectKey(parsed.project);
      const texts = seen.get(key) ?? new Set<string>();
      seen.set(key, texts);
      if (texts.has(parsed.text) || texts.size >= MAX_ENTRIES) continue;
      const size = Buffer.byteLength(raw) + 1;
      if (bytes + size > HISTORY_KEEP_BYTES) break;
      texts.add(parsed.text);
      kept.push(raw);
      bytes += size;
    }
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(
        temp,
        kept
          .reverse()
          .map((line) => `${line}\n`)
          .join(''),
        { mode: FILE_MODE },
      );
      renameSync(temp, this.file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  private load(): string[] {
    let raw: string;
    try {
      raw = readTail(this.file, LOAD_TAIL_BYTES);
    } catch {
      return [];
    }
    const wanted = projectKey(this.project);
    const result: string[] = [];
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0 && result.length < MAX_ENTRIES; i--) {
      const parsed = parseLine(lines[i] ?? '');
      if (parsed && projectKey(parsed.project) === wanted && !result.includes(parsed.text)) {
        result.push(parsed.text);
      }
    }
    return result;
  }
}

/** The last `maxBytes` of a file, starting at a line boundary when the start was cut. */
function readTail(file: string, maxBytes: number): string {
  const size = statSync(file).size;
  if (size <= maxBytes) return readFileSync(file, 'utf8');
  const buffer = Buffer.alloc(maxBytes);
  const fd = openSync(file, 'r');
  let read: number;
  try {
    read = readSync(fd, buffer, 0, maxBytes, size - maxBytes);
  } finally {
    closeSync(fd);
  }
  const text = buffer.subarray(0, read).toString('utf8');
  const firstBreak = text.indexOf('\n');
  return firstBreak === -1 ? '' : text.slice(firstBreak + 1);
}
