import chalk, { type ChalkInstance, type ForegroundColorName } from 'chalk';
import { marked, type MarkedToken, type Token, type Tokens } from 'marked';
import { glyphs, theme } from './theme.js';
import {
  displayWidth,
  graphemes,
  padStartToWidth,
  toDisplayText,
  wrapAtWhitespace,
} from './text-layout.js';

export interface MarkdownOptions {
  /** Available columns (the renderer wraps prose to this width minus indentation). */
  width: number;
}

const BULLET = '•';
const RULE_MAX_WIDTH = 40;
/** Nested blocks never wrap narrower than this; on absurdly small terminals they overflow instead. */
const MIN_NESTED_WIDTH = 10;
const CODE_GUTTER_WIDTH = 2;

interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  dim?: boolean;
  color?: ForegroundColorName;
}

/** A run of text with one style. Prose is wrapped as a sequence of fragments. */
interface Fragment {
  text: string;
  style: InlineStyle;
  /** Keep runs of spaces exactly as written (code spans) instead of collapsing them. */
  literal?: boolean;
}

/**
 * Renders Markdown to an ANSI string for the terminal using `marked`'s lexer (no HTML output).
 * Restrained styling with chalk and named colors only:
 *  - headings: bold (h1/h2 also underlined is NOT used; just bold), blank line after
 *  - **bold**, *italic*, ~~strike~~
 *  - `inline code`: theme.code color, no backticks
 *  - fenced/indented code: each line prefixed with a dim "│ " gutter; language label dim on
 *    the first line when present; no syntax highlighting; never wrapped mid-token
 *  - lists: "- " → "• ", ordered "1. "; nested lists indented by 2; task items "[ ]"/"[x]"
 *  - blockquotes: dim "│ " prefix
 *  - links: text followed by dim (url) unless text === url
 *  - horizontal rule: dim "─" × min(width, 40)
 *  - tables: aligned columns with dim separators when they fit in width; otherwise one
 *    "header: value" line per cell
 *  - raw HTML: printed as text
 * Paragraphs are separated by a single blank line; no trailing newline. Output never contains
 * background colors. Must not throw on malformed input (falls back to the raw text).
 *
 * Soft line breaks inside a paragraph are kept as line breaks: model output is written for a
 * terminal, where a newline the author typed is meant to be seen.
 */
export function renderMarkdown(markdown: string, options: MarkdownOptions): string {
  const width = Math.max(1, Math.floor(options.width) || 1);
  const source = toDisplayText(markdown);
  if (source.trim() === '') return '';
  try {
    const tokens = marked.lexer(source, { ...marked.getDefaults(), gfm: true, breaks: false });
    return trimBlankEdges(renderBlocks(tokens, width, false)).join('\n');
  } catch {
    return source.replace(/\s+$/, '');
  }
}

// ---------------------------------------------------------------------------------------------
// Blocks

function renderBlocks(tokens: readonly Token[], width: number, tight: boolean): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    const lines = renderBlock(token, width);
    if (lines.length === 0) continue;
    if (out.length > 0 && !tight) out.push('');
    out.push(...lines);
  }
  return out;
}

function renderBlock(token: Token, width: number): string[] {
  const block = token as MarkedToken;
  switch (block.type) {
    case 'space':
    case 'def':
      return [];
    case 'heading':
      return wrapFragments(inlineFragments(block.tokens, { bold: true }), width);
    case 'paragraph':
      return wrapFragments(inlineFragments(block.tokens, {}), width);
    case 'text':
      return wrapFragments(
        block.tokens ? inlineFragments(block.tokens, {}) : [plain(decodeEntities(block.text))],
        width,
      );
    case 'code':
      return renderCode(block, width);
    case 'blockquote':
      return renderBlockquote(block, width);
    case 'list':
      return renderList(block, width);
    case 'table':
      return renderTable(block, width);
    case 'hr':
      return [chalk.dim(glyphs.rule.repeat(Math.min(width, RULE_MAX_WIDTH)))];
    case 'html':
      return renderPlainText(block.text, width);
    default:
      return renderPlainText(token.raw, width);
  }
}

function renderCode(token: Tokens.Code, width: number): string[] {
  const lines: string[] = [];
  const language = token.lang?.trim().split(/\s+/)[0];
  if (language) lines.push(chalk.dim(`${glyphs.gutter} ${language}`));
  const contentWidth = Math.max(1, width - CODE_GUTTER_WIDTH);
  const gutter = chalk.dim(`${glyphs.gutter} `);
  for (const line of token.text.replace(/\n+$/, '').split('\n')) {
    const code = line.trimEnd();
    if (code === '') {
      lines.push(chalk.dim(glyphs.gutter));
      continue;
    }
    for (const row of wrapAtWhitespace(code, contentWidth)) lines.push(gutter + row);
  }
  return lines;
}

function renderBlockquote(token: Tokens.Blockquote, width: number): string[] {
  const inner = renderBlocks(token.tokens, Math.max(MIN_NESTED_WIDTH, width - 2), false);
  return inner.map((line) =>
    line === '' ? chalk.dim(glyphs.gutter) : chalk.dim(`${glyphs.gutter} `) + line,
  );
}

function renderList(list: Tokens.List, width: number): string[] {
  const start = typeof list.start === 'number' ? list.start : 1;
  const numberWidth = list.ordered
    ? Math.max(...list.items.map((_, i) => `${start + i}.`.length))
    : 0;
  const out: string[] = [];
  list.items.forEach((item, i) => {
    if (i > 0 && list.loose) out.push('');
    const checkbox = item.task ? `[${item.checked ? 'x' : ' '}]` : '';
    // Numbers are right-aligned to a shared width so "9." and "10." items line up.
    const number = list.ordered ? padStartToWidth(`${start + i}.`, numberWidth) : '';
    const marker = [number, checkbox].filter(Boolean).join(' ') || BULLET;
    const indent = ' '.repeat(displayWidth(marker) + 1);
    const contentWidth = Math.max(MIN_NESTED_WIDTH, width - indent.length);
    const content = renderBlocks(withoutCheckbox(item.tokens), contentWidth, !list.loose);
    if (content.length === 0) {
      out.push(marker);
      return;
    }
    content.forEach((line, j) => {
      if (j === 0) out.push(`${marker} ${line}`);
      else out.push(line === '' ? '' : indent + line);
    });
  });
  return out;
}

/** Task items carry a checkbox token (top level when tight, inside the paragraph when loose). */
function withoutCheckbox(tokens: readonly Token[]): Token[] {
  const filtered = tokens.filter((token) => token.type !== 'checkbox');
  const [first, ...rest] = filtered;
  if (first && (first.type === 'paragraph' || first.type === 'text') && first.tokens) {
    const inline = first.tokens.filter((token) => token.type !== 'checkbox');
    return [{ ...first, tokens: inline } as Token, ...rest];
  }
  return filtered;
}

function renderTable(table: Tokens.Table, width: number): string[] {
  const header = table.header.map((cell) => cellFragments(cell, { bold: true }));
  const rows = table.rows.map((row) => header.map((_, c) => cellFragments(row[c], {})));
  const widths = header.map((cell, c) =>
    Math.max(fragmentsWidth(cell), ...rows.map((row) => fragmentsWidth(row[c] ?? []))),
  );
  const separator = ` ${glyphs.gutter} `;
  const total =
    widths.reduce((sum, w) => sum + w, 0) + displayWidth(separator) * (widths.length - 1);
  if (total > width) return renderStackedTable(table, rows, width);

  const renderRow = (cells: Fragment[][]): string =>
    cells
      .map((cell, c) =>
        alignCell(cell, widths[c] ?? 0, table.align[c] ?? null, c === cells.length - 1),
      )
      .join(chalk.dim(separator));
  const rule = chalk.dim(
    widths.map((w) => glyphs.rule.repeat(w)).join(`${glyphs.rule}┼${glyphs.rule}`),
  );
  return [renderRow(header), rule, ...rows.map(renderRow)];
}

function renderStackedTable(table: Tokens.Table, rows: Fragment[][][], width: number): string[] {
  const labels = table.header.map((cell) => fragmentsText(cellFragments(cell, {})));
  const out: string[] = [];
  rows.forEach((row, r) => {
    if (r > 0) out.push('');
    row.forEach((cell, c) => {
      const label: Fragment = { text: `${labels[c] ?? ''}:`, style: { dim: true } };
      out.push(...wrapFragments([label, plain(' '), ...cell], width));
    });
  });
  return out;
}

function cellFragments(cell: Tokens.TableCell | undefined, style: InlineStyle): Fragment[] {
  if (!cell) return [];
  return inlineFragments(cell.tokens, style).map((fragment) => ({
    ...fragment,
    text: fragment.text.replace(/\n/g, ' '),
  }));
}

function alignCell(
  cell: readonly Fragment[],
  width: number,
  align: 'center' | 'left' | 'right' | null,
  isLast: boolean,
): string {
  const text = paintFragments(cell);
  const gap = Math.max(0, width - fragmentsWidth(cell));
  if (align === 'right') return ' '.repeat(gap) + text;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + text + (isLast ? '' : ' '.repeat(gap - left));
  }
  return isLast ? text : text + ' '.repeat(gap);
}

function renderPlainText(text: string, width: number): string[] {
  return text
    .replace(/\n+$/, '')
    .split('\n')
    .flatMap((line) => wrapAtWhitespace(line.trimEnd(), width));
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start++;
  while (end > start && lines[end - 1] === '') end--;
  return lines.slice(start, end);
}

// ---------------------------------------------------------------------------------------------
// Inline content

function plain(text: string): Fragment {
  return { text, style: {} };
}

function inlineFragments(tokens: readonly Token[] | undefined, style: InlineStyle): Fragment[] {
  const out: Fragment[] = [];
  for (const token of tokens ?? []) out.push(...inlineToken(token, style));
  return out;
}

function inlineToken(token: Token, style: InlineStyle): Fragment[] {
  const inline = token as MarkedToken;
  switch (inline.type) {
    case 'text':
      return inline.tokens?.length
        ? inlineFragments(inline.tokens, style)
        : [{ text: decodeEntities(inline.text), style }];
    case 'escape':
      return [{ text: decodeEntities(inline.text), style }];
    case 'strong':
      return inlineFragments(inline.tokens, { ...style, bold: true });
    case 'em':
      return inlineFragments(inline.tokens, { ...style, italic: true });
    case 'del':
      return inlineFragments(inline.tokens, { ...style, strikethrough: true });
    case 'codespan':
      return [
        {
          text: inline.text.replace(/\n/g, ' '),
          style: { ...style, color: theme.code },
          literal: true,
        },
      ];
    case 'br':
      return [{ text: '\n', style }];
    case 'link':
      return linkFragments(inline, style);
    case 'image':
      return imageFragments(inline, style);
    case 'html':
      return [{ text: inline.text, style }];
    default:
      return [{ text: token.raw, style }];
  }
}

function linkFragments(link: Tokens.Link, style: InlineStyle): Fragment[] {
  const linkStyle: InlineStyle = { ...style, color: theme.link };
  const label = inlineFragments(link.tokens, linkStyle);
  const text = fragmentsText(label);
  if (text.trim() === '') return [{ text: link.href, style: linkStyle }];
  if (!link.href || link.href === text || link.href === `mailto:${text}`) return label;
  return [...label, { text: ' ', style }, { text: `(${link.href})`, style: { dim: true } }];
}

function imageFragments(image: Tokens.Image, style: InlineStyle): Fragment[] {
  const url: Fragment = { text: `(${image.href})`, style: { dim: true } };
  const alt = decodeEntities(image.text).trim();
  return alt ? [{ text: alt, style }, { text: ' ', style }, url] : [url];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** marked keeps a few entities encoded for HTML output; the terminal needs the characters. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      const printable =
        code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && code !== 0x7f;
      return printable ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

// ---------------------------------------------------------------------------------------------
// Wrapping

interface Word {
  parts: Fragment[];
  width: number;
}

type Unit =
  { kind: 'word'; word: Word } | { kind: 'space'; fragment: Fragment } | { kind: 'break' };

/** Splits fragments into words (which may span styles, e.g. "**bold**,"), spaces and breaks. */
function toUnits(fragments: readonly Fragment[]): Unit[] {
  const units: Unit[] = [];
  const current: Word = { parts: [], width: 0 };
  const flushWord = (): void => {
    if (current.parts.length === 0) return;
    units.push({ kind: 'word', word: { parts: current.parts, width: current.width } });
    current.parts = [];
    current.width = 0;
  };
  for (const fragment of fragments) {
    for (const piece of fragment.text.split(/(\n| +)/)) {
      if (piece === '') continue;
      if (piece === '\n') {
        flushWord();
        units.push({ kind: 'break' });
      } else if (piece.startsWith(' ')) {
        flushWord();
        units.push({
          kind: 'space',
          fragment: { ...fragment, text: fragment.literal ? piece : ' ' },
        });
      } else {
        current.parts.push({ ...fragment, text: piece });
        current.width += displayWidth(piece);
      }
    }
  }
  flushWord();
  return units;
}

/** Greedy word wrap. Words wider than the line are split on grapheme boundaries. */
function wrapFragments(fragments: readonly Fragment[], width: number): string[] {
  const lines: Fragment[][] = [];
  let line: Fragment[] = [];
  let lineWidth = 0;
  let pendingSpace: Fragment | null = null;
  for (const unit of toUnits(fragments)) {
    if (unit.kind === 'break') {
      lines.push(line);
      line = [];
      lineWidth = 0;
      pendingSpace = null;
      continue;
    }
    if (unit.kind === 'space') {
      if (line.length > 0) pendingSpace ??= unit.fragment;
      continue;
    }
    const { word } = unit;
    const spaceWidth = pendingSpace ? displayWidth(pendingSpace.text) : 0;
    if (lineWidth + spaceWidth + word.width <= width) {
      if (pendingSpace) line.push(pendingSpace);
      line.push(...word.parts);
      lineWidth += spaceWidth + word.width;
    } else if (word.width <= width) {
      lines.push(line);
      line = [...word.parts];
      lineWidth = word.width;
    } else {
      if (line.length > 0) lines.push(line);
      const chunks = splitWord(word.parts, width);
      lines.push(...chunks.slice(0, -1));
      line = chunks[chunks.length - 1] ?? [];
      lineWidth = fragmentsWidth(line);
    }
    pendingSpace = null;
  }
  if (line.length > 0) lines.push(line);
  return lines.map(paintFragments);
}

function splitWord(parts: readonly Fragment[], width: number): Fragment[][] {
  const chunks: Fragment[][] = [];
  let chunk: Fragment[] = [];
  let used = 0;
  for (const part of parts) {
    let text = '';
    for (const grapheme of graphemes(part.text)) {
      const w = displayWidth(grapheme);
      if (used + w > width && used > 0) {
        if (text !== '') chunk.push({ ...part, text });
        chunks.push(chunk);
        chunk = [];
        text = '';
        used = 0;
      }
      text += grapheme;
      used += w;
    }
    if (text !== '') chunk.push({ ...part, text });
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function fragmentsText(fragments: readonly Fragment[]): string {
  return fragments.map((fragment) => fragment.text).join('');
}

function fragmentsWidth(fragments: readonly Fragment[]): number {
  return displayWidth(fragmentsText(fragments));
}

function sameStyle(a: InlineStyle, b: InlineStyle): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strikethrough === b.strikethrough &&
    a.dim === b.dim &&
    a.color === b.color
  );
}

function paintFragments(fragments: readonly Fragment[]): string {
  let out = '';
  let run = '';
  let runStyle: InlineStyle | null = null;
  for (const fragment of fragments) {
    if (runStyle && sameStyle(runStyle, fragment.style)) {
      run += fragment.text;
      continue;
    }
    if (runStyle) out += paint(run, runStyle);
    run = fragment.text;
    runStyle = fragment.style;
  }
  if (runStyle) out += paint(run, runStyle);
  return out;
}

function paint(text: string, style: InlineStyle): string {
  let painter: ChalkInstance = chalk;
  if (style.color) painter = painter[style.color];
  if (style.bold) painter = painter.bold;
  if (style.italic) painter = painter.italic;
  if (style.strikethrough) painter = painter.strikethrough;
  if (style.dim) painter = painter.dim;
  return painter === chalk ? text : painter(text);
}

// ---------------------------------------------------------------------------------------------
// Streaming

interface SourceLine {
  start: number;
  /** Index of the terminating "\n" (or text length for the last line). */
  end: number;
  /** Start of the following line. */
  next: number;
  /** False for the trailing line that is still being written. */
  complete: boolean;
}

interface OpenFence {
  char: string;
  length: number;
  /** Inside a list or indented: its closing line is not a commit point. */
  nested: boolean;
}

interface BlockState {
  started: boolean;
  /** End of the block's last content line. */
  lastEnd: number;
  inList: boolean;
  indentedCode: boolean;
}

const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const INDENTED_CODE = /^(?: {4}|\t)/;
const LEADING_BLANK_LINES = /^(?:[ \t]*\r?\n)+/;

/**
 * Splits streaming Markdown into a prefix that can be committed to the scrollback now and a
 * remainder still being written. The commit point is the end of the last complete block:
 * a blank line outside a fenced code block, or the line after a closing fence. Text inside an
 * unclosed fence is never committed. Returns `{ commit: '', rest: text }` when no boundary.
 * `commit` has trailing blank lines trimmed; `rest` has leading blank lines trimmed.
 *
 * Lists and indented code are handled conservatively: a blank line inside them only commits once
 * the next line has started and is not indented (an indented line continues the item or the
 * code), and fences nested in them never end a block on their own.
 */
export function splitCommittable(text: string): { commit: string; rest: string } {
  const lines = scanLines(text);
  let boundary: { commitEnd: number; restStart: number } | null = null;
  let fence: OpenFence | null = null;
  let block = newBlock();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.complete) break;
    const content = lineText(text, line);

    if (fence) {
      block.lastEnd = line.end;
      if (closesFence(content, fence)) {
        const nested = fence.nested;
        fence = null;
        if (!nested) {
          boundary = { commitEnd: line.end, restStart: line.next };
          block = newBlock();
        }
      }
      continue;
    }

    if (content.trim() === '') {
      if (!block.started) continue;
      if (block.inList || block.indentedCode) {
        const next = nextContentIndent(text, lines, i + 1);
        if (next === 'unknown') break;
        if (next === 'indented') continue;
      }
      boundary = { commitEnd: block.lastEnd, restStart: line.next };
      block = newBlock();
      continue;
    }

    if (!block.started) {
      block.started = true;
      block.indentedCode = INDENTED_CODE.test(content);
    }
    if (LIST_ITEM.test(content)) block.inList = true;
    block.lastEnd = line.end;
    const opener = parseFenceOpener(content);
    if (opener) {
      fence = {
        char: opener.char,
        length: opener.length,
        nested: block.inList || block.indentedCode || opener.indent > 3,
      };
    }
  }

  if (!boundary) return { commit: '', rest: text };
  return {
    commit: text.slice(0, boundary.commitEnd).replace(LEADING_BLANK_LINES, '').replace(/\s+$/, ''),
    rest: text.slice(boundary.restStart).replace(LEADING_BLANK_LINES, ''),
  };
}

function newBlock(): BlockState {
  return { started: false, lastEnd: 0, inList: false, indentedCode: false };
}

function scanLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) {
      lines.push({ start, end: text.length, next: text.length, complete: false });
      return lines;
    }
    lines.push({ start, end: newline, next: newline + 1, complete: true });
    start = newline + 1;
  }
}

function lineText(text: string, line: SourceLine): string {
  return text.slice(line.start, line.end).replace(/\r$/, '');
}

function parseFenceOpener(
  content: string,
): { char: string; length: number; indent: number } | null {
  const match = FENCE_OPEN.exec(content);
  if (!match) return null;
  const [, indent = '', marker = '', info = ''] = match;
  const char = marker[0] ?? '`';
  // A backtick fence's info string cannot contain backticks (that would be inline code).
  if (char === '`' && info.includes('`')) return null;
  return { char, length: marker.length, indent: indent.length };
}

function closesFence(content: string, fence: OpenFence): boolean {
  const marker = FENCE_CLOSE.exec(content)?.[1];
  return marker !== undefined && marker[0] === fence.char && marker.length >= fence.length;
}

/** Whether the next non-blank line is indented, or 'unknown' if it has not started yet. */
function nextContentIndent(
  text: string,
  lines: readonly SourceLine[],
  from: number,
): 'indented' | 'flush' | 'unknown' {
  for (let j = from; j < lines.length; j++) {
    const line = lines[j];
    if (!line) break;
    const content = lineText(text, line);
    if (content.trim() === '') {
      if (!line.complete) return 'unknown';
      continue;
    }
    return /^[ \t]/.test(content) ? 'indented' : 'flush';
  }
  return 'unknown';
}
