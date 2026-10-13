/**
 * Width-aware text helpers for terminal layout. Widths are terminal columns (string-width), and
 * every split happens on grapheme boundaries so emoji, combining marks and CJK text never break.
 * Inputs are plain text (no ANSI) unless stated otherwise.
 */
import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** How many code units around a position are segmented to find the neighbouring grapheme. */
const SEGMENT_WINDOW = 64;

export const TAB_WIDTH = 4;

export function displayWidth(text: string): number {
  return stringWidth(text);
}

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Moves `index` left if it points between the two halves of a surrogate pair. */
export function snapToCodePoint(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return Math.max(0, Math.min(index, text.length));
  const isInsidePair =
    isLowSurrogate(text.charCodeAt(index)) && isHighSurrogate(text.charCodeAt(index - 1));
  return isInsidePair ? index - 1 : index;
}

/** Start offset of the grapheme that ends at `index`. */
export function previousGraphemeBoundary(text: string, index: number): number {
  if (index <= 0) return 0;
  const from = Math.max(0, index - SEGMENT_WINDOW);
  let boundary = from;
  for (const part of segmenter.segment(text.slice(from, index))) boundary = from + part.index;
  return snapToCodePoint(text, boundary);
}

/** End offset of the grapheme that starts at `index`. */
export function nextGraphemeBoundary(text: string, index: number): number {
  if (index >= text.length) return text.length;
  let length = 1;
  for (const part of segmenter.segment(text.slice(index, index + SEGMENT_WINDOW))) {
    length = part.segment.length;
    break;
  }
  return snapToCodePoint(text, Math.min(text.length, index + length));
}

/** Expands tabs to spaces using tab stops every `tabWidth` columns (per line). */
export function expandTabs(text: string, tabWidth = TAB_WIDTH): string {
  if (!text.includes('\t')) return text;
  let out = '';
  let column = 0;
  for (const char of text) {
    if (char === '\t') {
      const spaces = tabWidth - (column % tabWidth);
      out += ' '.repeat(spaces);
      column += spaces;
    } else if (char === '\n') {
      out += char;
      column = 0;
    } else {
      out += char;
      column += 1;
    }
  }
  return out;
}

/** Strings that start a control string (OSC, DCS, SOS, PM, APC), up to its terminator or the end. */
const CONTROL_STRING =
  /(?:\u001B[\]PX^_]|[\u0090\u0098\u009D\u009E\u009F])[\s\S]*?(?:\u0007|\u001B\|\u009C|$)/g;
/** CSI sequences (ESC [ or the C1 form), also when cut short. */
const CSI = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]?/g;
/** Any other escape sequence (ESC c, ESC ( B, ...), also when cut short. */
const ESCAPE = /\u001B[ -/]*[0-~]?/g;
/** Bidirectional controls: they can make text read in a different order than it is written. */
const BIDI = new RegExp('[\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]', 'g');
/** Controls other than newline and tab (CR is turned into a newline before this). */
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Strips escape sequences, control characters (not newline or tab) and bidirectional controls. */
export function stripControls(text: string): string {
  return text
    .replace(CONTROL_STRING, '')
    .replace(CSI, '')
    .replace(ESCAPE, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROLS, '')
    .replace(BIDI, '');
}

/**
 * Makes untrusted text safe to lay out: strips every escape sequence (CSI, OSC, DCS, APC, PM,
 * SOS and the rest), control characters (keeping newlines), bidirectional controls, normalizes
 * CR/CRLF and expands tabs.
 */
export function toDisplayText(text: string): string {
  return expandTabs(stripControls(text));
}

/** Whether text holds an escape, a control character or a bidirectional control. */
export function hasHiddenControls(text: string): boolean {
  return stripControls(text) !== text;
}

/** The colours and styles Patch itself uses (chalk): foreground, background, bold, dim, reset. */
const SAFE_SGR = /^(?:0|1|2|3|4|7|22|23|24|27|3[0-79]|4[0-79]|9[0-7]|10[0-7])$/;

/**
 * For text a command prints that mixes server-provided strings with the colours Patch adds:
 * like `toDisplayText`, but keeps plain SGR colour and style sequences (and tabs) of the kinds
 * Patch uses, and drops every other sequence. Nothing a server sends can move the cursor, clear
 * the screen, set the title, write the clipboard or hide text.
 */
export function cleanTerminalOutput(text: string): string {
  return text
    .split(/(\u001B\[[0-9;]*m)/)
    .map((piece, index) => {
      if (index % 2 === 0) return stripControls(piece);
      const params = piece.slice(2, -1).split(';');
      return params.every((p) => p === '' || SAFE_SGR.test(String(Number(p)))) ? piece : '';
    })
    .join('');
}

/** Truncates plain text to `width` columns, marking the cut with "…". */
export function truncateToWidth(
  text: string,
  width: number,
  position: 'end' | 'middle' | 'start' = 'end',
): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  if (width === 1) return '…';
  const parts = graphemes(text);
  const budget = width - 1;
  if (position === 'end') return `${takeWidth(parts, budget)}…`;
  if (position === 'start') return `…${takeWidthFromEnd(parts, budget)}`;
  const headBudget = Math.ceil(budget / 2);
  return `${takeWidth(parts, headBudget)}…${takeWidthFromEnd(parts, budget - headBudget)}`;
}

function takeWidth(parts: readonly string[], budget: number): string {
  let out = '';
  let used = 0;
  for (const part of parts) {
    const w = displayWidth(part);
    if (used + w > budget) break;
    out += part;
    used += w;
  }
  return out;
}

function takeWidthFromEnd(parts: readonly string[], budget: number): string {
  let out = '';
  let used = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i] ?? '';
    const w = displayWidth(part);
    if (used + w > budget) break;
    out = part + out;
    used += w;
  }
  return out;
}

/** Pads plain text with spaces to `width` columns (never truncates). */
export function padEndToWidth(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

export function padStartToWidth(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - displayWidth(text))) + text;
}

/** Splits one line of plain text into chunks of at most `width` columns. */
export function hardWrap(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  if (displayWidth(text) <= limit) return [text];
  const chunks: string[] = [];
  let current = '';
  let used = 0;
  for (const part of graphemes(text)) {
    const w = displayWidth(part);
    if (used + w > limit && current !== '') {
      chunks.push(current);
      current = '';
      used = 0;
    }
    current += part;
    used += w;
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

/**
 * Wraps one line of plain text at whitespace so no row exceeds `width` columns. Words wider than
 * the row are split as a last resort. Trailing whitespace at a break is dropped.
 */
export function wrapAtWhitespace(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  if (displayWidth(text) <= limit) return [text];
  const rows: string[] = [];
  let current = '';
  let used = 0;
  for (const piece of text.split(/(\s+)/)) {
    if (piece === '') continue;
    const w = displayWidth(piece);
    const isSpace = /^\s+$/.test(piece);
    if (used + w <= limit) {
      current += piece;
      used += w;
      continue;
    }
    if (isSpace) {
      if (current !== '') rows.push(current.trimEnd());
      current = '';
      used = 0;
      continue;
    }
    if (current.trim() !== '') rows.push(current.trimEnd());
    const chunks = hardWrap(piece, limit);
    rows.push(...chunks.slice(0, -1));
    current = chunks[chunks.length - 1] ?? '';
    used = displayWidth(current);
  }
  if (current !== '' || rows.length === 0) rows.push(current.trimEnd());
  return rows;
}
