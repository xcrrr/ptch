/**
 * Renders a headless xterm buffer as an SVG picture of a dark terminal window, so README
 * screenshots come from real sessions (see screenshots.ts) rather than mockups.
 *
 * Each run of identically styled cells is one <text> placed at its absolute cell position, with a
 * `textLength` of exactly its cell count: columns line up whatever monospace font the viewer has.
 */
import type { IBufferCell, IBufferLine, Terminal } from '@xterm/headless';

export interface SvgOptions {
  /** Shown in the title bar. */
  title?: string;
  /** First buffer line to render (absolute index, scrollback included). Default 0. */
  fromLine?: number;
  /** Line after the last one to render. Default: the end of the buffer. */
  toLine?: number;
}

export interface RenderedSvg {
  svg: string;
  width: number;
  height: number;
  /** Rendered buffer lines [from, to) after blank rows at either end were dropped. */
  from: number;
  to: number;
}

const CELL_WIDTH = 8.4;
const CELL_HEIGHT = 18;
const FONT_SIZE = 14;
/** Text baseline within a cell row. */
const BASELINE = 13;
const PAD_X = 18;
const PAD_TOP = 14;
const PAD_BOTTOM = 18;
const TITLE_BAR_HEIGHT = 36;
const RADIUS = 10;
/** Share of the foreground kept by dim text (the rest is the background). */
const DIM_RATIO = 0.6;

const MONO_FONT = `ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace`;
const UI_FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;

const WINDOW = {
  background: '#0d1117',
  titleBar: '#161b22',
  border: '#30363d',
  title: '#8b949e',
  buttons: ['#ff5f57', '#febc2e', '#28c840'],
};
const DEFAULT_FG = '#e6edf3';
const DEFAULT_BG = WINDOW.background;

/** GitHub Dark ANSI colors: 0-7 normal, 8-15 bright. */
const ANSI_16 = [
  '#484f58',
  '#ff7b72',
  '#3fb950',
  '#d29922',
  '#58a6ff',
  '#bc8cff',
  '#39c5cf',
  '#b1bac4',
  '#6e7681',
  '#ffa198',
  '#56d364',
  '#e3b341',
  '#79c0ff',
  '#d2a8ff',
  '#56d4dd',
  '#f0f6fc',
];
const PALETTE = buildPalette();

interface CellStyle {
  fg: string;
  /** Null for the terminal background. */
  bg: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  invisible: boolean;
}

/** Cells sharing one style; a wide (two-column) character is always a span of its own. */
interface Span {
  col: number;
  /** One string per narrow cell, or the single wide character. */
  cells: string[];
  /** Columns covered. */
  width: number;
  style: CellStyle;
  key: string;
  wide: boolean;
}

export function renderSvg(terminal: Terminal, options: SvgOptions = {}): RenderedSvg {
  const buffer = terminal.buffer.active;
  const cols = terminal.cols;
  let from = Math.max(0, options.fromLine ?? 0);
  let to = Math.min(buffer.length, options.toLine ?? buffer.length);
  const reusable = buffer.getNullCell();
  const rows: Span[][] = [];
  for (let y = from; y < to; y++) {
    const line = buffer.getLine(y);
    rows.push(line ? lineSpans(line, cols, reusable) : []);
  }
  while (rows.length > 0 && isBlank(rows[rows.length - 1]!)) {
    rows.pop();
    to--;
  }
  while (rows.length > 0 && isBlank(rows[0]!)) {
    rows.shift();
    from++;
  }

  const width = round(PAD_X * 2 + cols * CELL_WIDTH);
  const height = TITLE_BAR_HEIGHT + PAD_TOP + rows.length * CELL_HEIGHT + PAD_BOTTOM;
  const classes = new Map<string, { name: string; style: CellStyle }>();
  const backgrounds: string[] = [];
  const blocks: string[] = [];
  const texts: string[] = [];
  rows.forEach((spans, row) => {
    const top = TITLE_BAR_HEIGHT + PAD_TOP + row * CELL_HEIGHT;
    for (const rect of backgroundRuns(spans)) {
      backgrounds.push(
        `<rect x="${cellX(rect.col)}" y="${top}" width="${round(rect.width * CELL_WIDTH)}" height="${CELL_HEIGHT}" fill="${rect.color}"/>`,
      );
    }
    for (const span of spans) {
      blocks.push(...blockRects(span, top));
      const element = textElement(withoutBlocks(span), top + BASELINE, classes);
      if (element) texts.push(element);
    }
  });

  const title = options.title ?? '';
  const css = [
    `text{font-family:${MONO_FONT};font-size:${FONT_SIZE}px;white-space:pre;font-variant-ligatures:none}`,
    `.title{font-family:${UI_FONT};font-size:13px;fill:${WINDOW.title}}`,
    ...[...classes.values()].map(({ name, style }) => `.${name}{${declarations(style)}}`),
  ];
  const buttons = WINDOW.buttons.map(
    (color, i) =>
      `<circle cx="${20 + i * 20}" cy="${TITLE_BAR_HEIGHT / 2}" r="6" fill="${color}"/>`,
  );
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`,
    `<title>${escapeXml(title)}</title>`,
    `<style>${css.join('\n')}</style>`,
    `<clipPath id="window"><rect width="${width}" height="${height}" rx="${RADIUS}"/></clipPath>`,
    `<g clip-path="url(#window)">`,
    `<rect width="${width}" height="${height}" fill="${WINDOW.background}"/>`,
    `<rect width="${width}" height="${TITLE_BAR_HEIGHT}" fill="${WINDOW.titleBar}"/>`,
    `<path d="M0 ${TITLE_BAR_HEIGHT - 0.5}H${width}" stroke="${WINDOW.border}"/>`,
    ...buttons,
    title
      ? `<text class="title" x="${width / 2}" y="${TITLE_BAR_HEIGHT / 2 + 4.5}" text-anchor="middle">${escapeXml(title)}</text>`
      : '',
    ...backgrounds,
    `<g shape-rendering="crispEdges">`,
    ...blocks,
    `</g>`,
    `<g xml:space="preserve">`,
    ...texts,
    `</g>`,
    `</g>`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${RADIUS - 0.5}" fill="none" stroke="${WINDOW.border}"/>`,
    `</svg>`,
  ]
    .filter(Boolean)
    .join('\n');
  return { svg: `${svg}\n`, width, height, from, to };
}

function lineSpans(line: IBufferLine, cols: number, reusable: IBufferCell): Span[] {
  const spans: Span[] = [];
  let current: Span | undefined;
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x, reusable);
    if (!cell) break;
    const width = cell.getWidth();
    if (width === 0) continue; // the second column of a wide character
    const style = cellStyle(cell);
    const key = styleKey(style);
    const chars = xmlSafe(cell.getChars()) || ' ';
    if (width > 1 || !current || current.wide || current.key !== key) {
      current = { col: x, cells: [chars], width, style, key, wide: width > 1 };
      spans.push(current);
    } else {
      current.cells.push(chars);
      current.width += width;
    }
  }
  return spans;
}

function cellStyle(cell: IBufferCell): CellStyle {
  let fg = cell.isFgDefault() ? DEFAULT_FG : colorOf(cell.getFgColor(), cell.isFgRGB());
  let bg = cell.isBgDefault() ? null : colorOf(cell.getBgColor(), cell.isBgRGB());
  if (cell.isInverse()) [fg, bg] = [bg ?? DEFAULT_BG, fg];
  if (cell.isDim()) fg = mix(fg, bg ?? DEFAULT_BG, DIM_RATIO);
  return {
    fg,
    bg,
    bold: cell.isBold() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    strike: cell.isStrikethrough() !== 0,
    invisible: cell.isInvisible() !== 0,
  };
}

function styleKey(style: CellStyle): string {
  const flags = [style.bold, style.italic, style.underline, style.strike, style.invisible]
    .map((flag) => (flag ? 1 : 0))
    .join('');
  return `${style.fg}/${style.bg ?? ''}/${flags}`;
}

/** Text decorations show on spaces too; otherwise spaces draw nothing. */
function drawsNothing(span: Span): boolean {
  const { style } = span;
  if (style.invisible) return true;
  return !style.underline && !style.strike && span.cells.every((c) => c === ' ');
}

function isBlank(spans: Span[]): boolean {
  return spans.every((span) => span.style.bg === null && drawsNothing(span));
}

function backgroundRuns(spans: Span[]): Array<{ col: number; width: number; color: string }> {
  const runs: Array<{ col: number; width: number; color: string }> = [];
  for (const span of spans) {
    if (span.style.bg === null) continue;
    const last = runs[runs.length - 1];
    if (last && last.color === span.style.bg && last.col + last.width === span.col) {
      last.width += span.width;
    } else {
      runs.push({ col: span.col, width: span.width, color: span.style.bg });
    }
  }
  return runs;
}

/**
 * Block elements (the logo, bars) as rectangles: font glyphs leave hairline gaps between cells,
 * terminals draw them seamlessly. Horizontally adjacent equal blocks become one rectangle.
 */
const BLOCKS: Record<string, { x: number; y: number; w: number; h: number }> = {
  '█': { x: 0, y: 0, w: 1, h: 1 },
  '▀': { x: 0, y: 0, w: 1, h: 0.5 },
  '▄': { x: 0, y: 0.5, w: 1, h: 0.5 },
  '▌': { x: 0, y: 0, w: 0.5, h: 1 },
  '▐': { x: 0.5, y: 0, w: 0.5, h: 1 },
};

function blockRects(span: Span, top: number): string[] {
  if (span.wide || span.style.invisible) return [];
  const rects: string[] = [];
  let i = 0;
  while (i < span.cells.length) {
    const shape = BLOCKS[span.cells[i]!];
    if (!shape) {
      i++;
      continue;
    }
    let end = i + 1;
    // Full-width shapes join up with the same shape next to them.
    while (shape.w === 1 && end < span.cells.length && span.cells[end] === span.cells[i]) end++;
    const x = PAD_X + (span.col + i + shape.x) * CELL_WIDTH;
    const width = (end - i - 1 + shape.w) * CELL_WIDTH;
    rects.push(
      `<rect x="${round(x)}" y="${round(top + shape.y * CELL_HEIGHT)}" width="${round(width)}" height="${round(shape.h * CELL_HEIGHT)}" fill="${span.style.fg}"/>`,
    );
    i = end;
  }
  return rects;
}

function withoutBlocks(span: Span): Span {
  if (span.wide || !span.cells.some((c) => c in BLOCKS)) return span;
  return { ...span, cells: span.cells.map((c) => (c in BLOCKS ? ' ' : c)) };
}

function textElement(
  span: Span,
  baseline: number,
  classes: Map<string, { name: string; style: CellStyle }>,
): string | null {
  if (drawsNothing(span)) return null;
  let entry = classes.get(span.key);
  if (!entry) {
    entry = { name: `s${classes.size}`, style: span.style };
    classes.set(span.key, entry);
  }
  if (span.wide) {
    // Centered in its two columns: emoji and CJK glyphs rarely match the cell size exactly.
    const center = round(PAD_X + (span.col + span.width / 2) * CELL_WIDTH);
    return `<text class="${entry.name}" x="${center}" y="${baseline}" text-anchor="middle">${escapeXml(span.cells[0]!)}</text>`;
  }
  // Undecorated spaces at either end are background only.
  let start = 0;
  let end = span.cells.length;
  if (!span.style.underline && !span.style.strike) {
    while (span.cells[start] === ' ') start++;
    while (end > start && span.cells[end - 1] === ' ') end--;
  }
  const cells = span.cells.slice(start, end);
  const content = escapeXml(cells.join(''));
  const x = cellX(span.col + start);
  if (cells.length === 1) {
    return `<text class="${entry.name}" x="${x}" y="${baseline}">${content}</text>`;
  }
  // Box-drawing runs are stretched glyph and all so lines join up; text only gets spacing.
  const stretch = cells.every((c) => /^[─-▟]$/.test(c)) ? ' lengthAdjust="spacingAndGlyphs"' : '';
  const length = round(cells.length * CELL_WIDTH);
  return `<text class="${entry.name}" x="${x}" y="${baseline}" textLength="${length}"${stretch}>${content}</text>`;
}

function declarations(style: CellStyle): string {
  const parts = [`fill:${style.fg}`];
  if (style.bold) parts.push('font-weight:700');
  if (style.italic) parts.push('font-style:italic');
  const decorations = [style.underline && 'underline', style.strike && 'line-through'].filter(
    Boolean,
  );
  if (decorations.length > 0) parts.push(`text-decoration:${decorations.join(' ')}`);
  return parts.join(';');
}

function cellX(col: number): number {
  return round(PAD_X + col * CELL_WIDTH);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function colorOf(value: number, isRgb: boolean): string {
  if (isRgb) return `#${value.toString(16).padStart(6, '0')}`;
  return PALETTE[value] ?? DEFAULT_FG;
}

function buildPalette(): string[] {
  const colors = [...ANSI_16];
  const levels = [0, 95, 135, 175, 215, 255];
  for (const r of levels) {
    for (const g of levels) {
      for (const b of levels) colors.push(hex(r, g, b));
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    colors.push(hex(v, v, v));
  }
  return colors;
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** `ratio` of color `a` blended over color `b`. */
function mix(a: string, b: string, ratio: number): string {
  const channel = (color: string, i: number) => parseInt(color.slice(1 + i * 2, 3 + i * 2), 16);
  const [r, g, bl] = [0, 1, 2].map((i) =>
    Math.round(channel(a, i) * ratio + channel(b, i) * (1 - ratio)),
  );
  return hex(r!, g!, bl!);
}

/** Drops characters XML 1.0 does not allow. */
function xmlSafe(text: string): string {
  return text.replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
