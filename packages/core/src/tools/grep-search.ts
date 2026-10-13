import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { throwIfAborted } from '@patch/shared';
import { createGlobMatcher } from '../fs/glob-match.js';
import { sensitivePathReason } from '../fs/paths.js';
import { cleanRipgrepError, RIPGREP_BASE_ARGS, runRipgrep } from '../fs/ripgrep.js';
import { isBinaryBuffer } from '../fs/text-file.js';
import { walkFiles, type WalkEntry } from '../fs/walk.js';
import { ToolError } from './types.js';

export type GrepMode = 'content' | 'files' | 'count';

export interface GrepQuery {
  pattern: string;
  /** Absolute file or directory to search. */
  target: string;
  targetIsDirectory: boolean;
  glob?: string;
  caseInsensitive: boolean;
  mode: GrepMode;
  /** Context lines around each match (content mode). */
  context: number;
  /** Matching lines (content) or files (files/count) to keep. */
  maxResults: number;
  /**
   * Leave out files that look like secrets. They are not searched at all: even a note naming the
   * files that matched would let repeated searches recover their contents one pattern at a time.
   */
  hideSensitive: boolean;
  signal: AbortSignal;
}

export interface GrepLine {
  lineNumber: number;
  text: string;
  isMatch: boolean;
}

export interface GrepFileResult {
  /** Absolute path. */
  path: string;
  /** Matching lines in the file. */
  matchCount: number;
  /** Kept lines in line order (content mode only). */
  lines: GrepLine[];
}

export interface GrepResult {
  /** Files with kept results, in search order. */
  files: GrepFileResult[];
  /** Matching lines across all searched files. */
  totalMatches: number;
  /** Files with at least one match. */
  totalFiles: number;
  /** Matching lines kept in `files` (content mode). */
  keptMatches: number;
  /** Some kept lines were shortened to MAX_GREP_LINE_CHARS. */
  shortenedLines: boolean;
  /** Files the JavaScript fallback left unsearched because of MAX_FALLBACK_FILE_BYTES. */
  skippedLargeFiles: number;
}

/** Longest line shown; longer lines are cut to a window around the first match. */
export const MAX_GREP_LINE_CHARS = 300;
/** The JavaScript fallback skips files larger than this (ripgrep has no such limit). */
export const MAX_FALLBACK_FILE_BYTES = 2 * 1024 * 1024;
/** Characters of a long line shown before its first match. */
const LEAD_CHARS = 100;
/** Files read concurrently by the JavaScript fallback. */
const READ_BATCH = 32;

/**
 * Which files of a directory search are reported, as a predicate on absolute paths: the `glob`
 * restriction (relative to the target) and, with `hideSensitive`, no files that look like secrets.
 * It is applied by Patch for both engines: ripgrep's own `--glob` overrides .gitignore.
 */
function fileFilter(query: GrepQuery): ((file: string) => boolean) | undefined {
  if (!query.targetIsDirectory) return undefined;
  const matches = query.glob === undefined ? undefined : createGlobMatcher(query.glob);
  if (!matches && !query.hideSensitive) return undefined;
  return (file) => {
    const relative = path.relative(query.target, file).split(path.sep).join('/');
    if (query.hideSensitive && sensitivePathReason(relative) !== undefined) return false;
    return !matches || matches(relative);
  };
}

/** Gathers results from either engine with identical limits and bookkeeping. */
class GrepCollector {
  readonly result: GrepResult = {
    files: [],
    totalMatches: 0,
    totalFiles: 0,
    keptMatches: 0,
    shortenedLines: false,
    skippedLargeFiles: 0,
  };
  /** The file being reported; undefined between files and for files that are left out. */
  private current: GrepFileResult | undefined;
  private lastKeptMatch: number | undefined;
  private readonly include: ((file: string) => boolean) | undefined;

  constructor(private readonly query: GrepQuery) {
    this.include = fileFilter(query);
  }

  /** Content mode has kept as many matching lines as allowed. */
  get full(): boolean {
    return this.result.keptMatches >= this.query.maxResults;
  }

  /** The current file is left out (glob, secrets); its records can be skipped unread. */
  get skippingFile(): boolean {
    return this.current === undefined;
  }

  beginFile(file: string): void {
    this.current =
      this.include && !this.include(file) ? undefined : { path: file, matchCount: 0, lines: [] };
    this.lastKeptMatch = undefined;
  }

  /** `column` (character index of the match) is used to pick the window of very long lines. */
  match(lineNumber: number, text: string, column: () => number): void {
    const file = this.current;
    if (!file) return;
    file.matchCount++;
    if (this.query.mode !== 'content' || this.full) return;
    file.lines.push({ lineNumber, text: this.clip(text, column), isMatch: true });
    this.result.keptMatches++;
    this.lastKeptMatch = lineNumber;
  }

  /** Whether a context line would be kept (lets engines skip decoding it). */
  wantsContext(lineNumber: number): boolean {
    if (this.query.mode !== 'content' || !this.current) return false;
    if (!this.full) return true;
    return (
      this.lastKeptMatch !== undefined && lineNumber <= this.lastKeptMatch + this.query.context
    );
  }

  contextLine(lineNumber: number, text: string): void {
    if (!this.wantsContext(lineNumber)) return;
    this.current?.lines.push({ lineNumber, text: this.clip(text, () => 0), isMatch: false });
  }

  endFile(): void {
    const file = this.current;
    this.current = undefined;
    if (!file || file.matchCount === 0) return;
    this.result.totalFiles++;
    this.result.totalMatches += file.matchCount;
    if (this.query.mode === 'content') {
      file.lines = this.withoutStrayContext(file.lines);
      if (file.lines.some((line) => line.isMatch)) this.result.files.push(file);
    } else if (this.result.files.length < this.query.maxResults) {
      this.result.files.push(file);
    }
  }

  /** Records a whole file at once (files and count modes). */
  fileWithMatches(file: string, matchCount: number): void {
    this.beginFile(file);
    if (this.current) this.current.matchCount = matchCount;
    this.endFile();
  }

  /** Drops context lines that only surrounded matches beyond the result limit. */
  private withoutStrayContext(lines: GrepLine[]): GrepLine[] {
    const keep = new Set<number>();
    for (const line of lines) {
      if (!line.isMatch) continue;
      for (
        let n = line.lineNumber - this.query.context;
        n <= line.lineNumber + this.query.context;
        n++
      ) {
        keep.add(n);
      }
    }
    return lines.filter((line) => keep.has(line.lineNumber));
  }

  private clip(text: string, column: () => number): string {
    if (text.length <= MAX_GREP_LINE_CHARS) return text;
    this.result.shortenedLines = true;
    const start = Math.max(0, Math.min(column() - LEAD_CHARS, text.length - MAX_GREP_LINE_CHARS));
    const end = start + MAX_GREP_LINE_CHARS;
    return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
  }
}

// ---------------------------------------------------------------------------------------------
// ripgrep
// ---------------------------------------------------------------------------------------------

interface RgText {
  text?: string;
  bytes?: string;
}

interface RgMessage {
  type: string;
  data: {
    path?: RgText;
    lines?: RgText;
    line_number?: number;
    submatches?: { start: number }[];
  };
}

function decodeRgText(value: RgText | undefined): string {
  if (!value) return '';
  if (value.text !== undefined) return value.text;
  return Buffer.from(value.bytes ?? '', 'base64').toString('utf8');
}

function stripLineTerminator(text: string): string {
  return text.replace(/\r?\n$/, '');
}

/** Character index of a UTF-8 byte offset within `text`. */
function charIndexOfByte(text: string, byteOffset: number): number {
  return Buffer.from(text, 'utf8').subarray(0, byteOffset).toString('utf8').length;
}

const MESSAGE_TYPE = /^\{"type":"(\w+)"/;
const LINE_NUMBER = /"line_number":(\d+)/;

function modeArgs(query: GrepQuery): string[] {
  switch (query.mode) {
    case 'content':
      return ['--json', ...(query.context > 0 ? ['--context', String(query.context)] : [])];
    case 'files':
      return ['--files-with-matches', '--null'];
    case 'count':
      return ['--count', '--with-filename', '--null'];
  }
}

function ripgrepArgs(query: GrepQuery, pcre2: boolean): string[] {
  return [
    ...RIPGREP_BASE_ARGS,
    '--crlf',
    '--sort',
    'path',
    ...(query.caseInsensitive ? ['--ignore-case'] : []),
    ...(pcre2 ? ['--pcre2'] : []),
    ...modeArgs(query),
    '-e',
    query.pattern,
    '--',
    query.targetIsDirectory ? '.' : path.basename(query.target),
  ];
}

function handleJsonRecord(record: string, collector: GrepCollector, cwd: string): void {
  const type = MESSAGE_TYPE.exec(record)?.[1];
  // Most records need no JSON parsing: those of files outside the glob, matches past the result
  // limit (only counted) and context lines that will not be shown.
  if ((type === 'match' || type === 'context') && collector.skippingFile) return;
  if (type === 'match' && collector.full) {
    collector.match(0, '', () => 0);
    return;
  }
  if (type === 'context') {
    const lineNumber = Number(LINE_NUMBER.exec(record)?.[1] ?? 0);
    if (!collector.wantsContext(lineNumber)) return;
  }
  if (type === 'end') {
    collector.endFile();
    return;
  }
  const message = JSON.parse(record) as RgMessage;
  const { data } = message;
  switch (message.type) {
    case 'begin':
      collector.beginFile(path.resolve(cwd, decodeRgText(data.path)));
      break;
    case 'match': {
      const text = stripLineTerminator(decodeRgText(data.lines));
      const byteStart = data.submatches?.[0]?.start ?? 0;
      collector.match(data.line_number ?? 0, text, () => charIndexOfByte(text, byteStart));
      break;
    }
    case 'context':
      collector.contextLine(data.line_number ?? 0, stripLineTerminator(decodeRgText(data.lines)));
      break;
    case 'end':
      collector.endFile();
      break;
  }
}

function searchFailure(stderr: string): ToolError {
  const message = cleanRipgrepError(stderr);
  if (/regex parse error/i.test(message)) {
    return new ToolError(`Invalid regular expression: ${message}`);
  }
  if (/glob/i.test(message)) return new ToolError(`Invalid glob: ${message}`);
  return new ToolError(`Search failed: ${message}`);
}

/** One ripgrep run: its results, or rg's error text when it failed without finding anything. */
async function runSearch(
  rgPath: string,
  query: GrepQuery,
  pcre2: boolean,
): Promise<{ result: GrepResult; error?: string }> {
  const cwd = query.targetIsDirectory ? query.target : path.dirname(query.target);
  const collector = new GrepCollector(query);
  const run = await runRipgrep(rgPath, ripgrepArgs(query, pcre2), {
    cwd,
    signal: query.signal,
    delimiter: query.mode === 'files' ? '\0' : '\n',
    onRecord: (record) => {
      if (query.mode === 'content') {
        handleJsonRecord(record, collector, cwd);
      } else if (query.mode === 'files') {
        collector.fileWithMatches(path.resolve(cwd, record), 1);
      } else {
        const separator = record.lastIndexOf('\0');
        if (separator === -1) return;
        const count = Number(record.slice(separator + 1));
        collector.fileWithMatches(path.resolve(cwd, record.slice(0, separator)), count);
      }
    },
  });
  const { result } = collector;
  if (run.exitCode === 2 && result.totalFiles === 0 && run.stderr.trim() !== '') {
    return { result, error: run.stderr };
  }
  return { result };
}

/** Searches with ripgrep. Patterns that need look-around or backreferences retry with PCRE2. */
export async function grepWithRipgrep(rgPath: string, query: GrepQuery): Promise<GrepResult> {
  const first = await runSearch(rgPath, query, false);
  if (first.error === undefined) return first.result;
  if (!first.error.includes('--pcre2')) throw searchFailure(first.error);
  const second = await runSearch(rgPath, query, true);
  if (second.error !== undefined) throw searchFailure(second.error);
  return second.result;
}

// ---------------------------------------------------------------------------------------------
// JavaScript fallback
// ---------------------------------------------------------------------------------------------

/**
 * Compiles a ripgrep-style pattern as a JavaScript RegExp: a leading inline flag group such as
 * "(?i)" becomes RegExp flags and Python/Rust-style named groups "(?P<name>" are accepted.
 */
export function compileSearchPattern(pattern: string, caseInsensitive: boolean): RegExp {
  let source = pattern;
  const flags = new Set<string>(caseInsensitive ? ['i'] : []);
  const inline = /^\(\?([ims]+)\)/.exec(source);
  if (inline) {
    for (const flag of inline[1]) flags.add(flag);
    source = source.slice(inline[0].length);
  }
  source = source.replace(/\(\?P</g, '(?<');
  const base = [...flags].join('');
  try {
    return new RegExp(source, `${base}u`);
  } catch {
    try {
      return new RegExp(source, base);
    } catch (error) {
      const detail = (error as Error).message.replace(/^Invalid regular expression: /, '');
      throw new ToolError(`Invalid regular expression: ${detail}`);
    }
  }
}

/** Lines of a searchable text file; 'too large' or undefined (binary, unreadable) otherwise. */
async function searchableLines(file: string): Promise<string[] | 'too large' | undefined> {
  try {
    const stats = await stat(file);
    if (!stats.isFile()) return undefined;
    if (stats.size > MAX_FALLBACK_FILE_BYTES) return 'too large';
    const bytes = await readFile(file);
    if (isBinaryBuffer(bytes)) return undefined;
    let text = bytes.toString('utf8');
    if (text.startsWith('\uFEFF')) text = text.slice(1);
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  } catch {
    return undefined;
  }
}

function searchLines(
  file: string,
  lines: string[],
  regex: RegExp,
  query: GrepQuery,
  collector: GrepCollector,
): void {
  if (query.mode !== 'content') {
    let count = 0;
    for (const line of lines) {
      if (!regex.test(line)) continue;
      count++;
      if (query.mode === 'files') break;
    }
    if (count > 0) collector.fileWithMatches(file, count);
    return;
  }
  const columns = new Map<number, number>();
  lines.forEach((line, index) => {
    const found = regex.exec(line);
    if (found) columns.set(index + 1, found.index);
  });
  if (columns.size === 0) return;
  collector.beginFile(file);
  let next = 1;
  for (const lineNumber of columns.keys()) {
    const from = Math.max(next, lineNumber - query.context);
    const to = Math.min(lines.length, lineNumber + query.context);
    for (let current = from; current <= to; current++) {
      const column = columns.get(current);
      if (column === undefined) collector.contextLine(current, lines[current - 1]);
      else collector.match(current, lines[current - 1], () => column);
    }
    next = Math.max(next, to + 1);
  }
  collector.endFile();
}

async function* filesToSearch(query: GrepQuery): AsyncGenerator<WalkEntry> {
  if (!query.targetIsDirectory) {
    yield { absolute: query.target, relative: path.basename(query.target), isDirectory: false };
    return;
  }
  const include = fileFilter(query);
  for await (const entry of walkFiles({ root: query.target, signal: query.signal })) {
    if (!include || include(entry.absolute)) yield entry;
  }
}

/**
 * Searches with a JavaScript RegExp over walkFiles(), mirroring the ripgrep engine: same file
 * order, .gitignore handling and limits; binary files and files over 2 MB are skipped.
 */
export async function grepWithJavaScript(query: GrepQuery): Promise<GrepResult> {
  const regex = compileSearchPattern(query.pattern, query.caseInsensitive);
  const collector = new GrepCollector(query);
  let batch: WalkEntry[] = [];
  const flush = async () => {
    const contents = await Promise.all(batch.map((entry) => searchableLines(entry.absolute)));
    throwIfAborted(query.signal);
    batch.forEach((entry, index) => {
      const lines = contents[index];
      if (lines === 'too large') collector.result.skippedLargeFiles++;
      else if (lines) searchLines(entry.absolute, lines, regex, query, collector);
    });
    batch = [];
  };
  for await (const entry of filesToSearch(query)) {
    batch.push(entry);
    if (batch.length >= READ_BATCH) await flush();
  }
  await flush();
  return collector.result;
}
