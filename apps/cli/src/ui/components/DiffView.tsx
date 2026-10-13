import type { FileDiff } from '@patch/core';
import { plural } from '@patch/shared';
import { Box, Text } from 'ink';
import { glyphs, theme } from '../theme.js';
import {
  displayWidth,
  hardWrap,
  padStartToWidth,
  toDisplayText,
  truncateToWidth,
} from '../text-layout.js';
import type { DiffViewProps } from './props.js';

const DEFAULT_INDENT = 10;
const HUNK_SEPARATOR = '⋮';
/** Line number, a space, the sign and a space. */
const SIGN_COLUMNS = 3;

export interface DiffViewOptions extends DiffViewProps {
  /** How long lines fit the width: wrapped under the text column (default) or cut with "…". */
  overflow?: 'wrap' | 'truncate';
  /**
   * Most terminal rows to use, counting wrapped rows, hunk separators and the "more lines" row.
   * Fewer diff lines are shown when needed.
   */
  maxRows?: number;
}

type DiffLayoutOptions = Pick<
  DiffViewOptions,
  'maxLines' | 'maxRows' | 'width' | 'indent' | 'overflow'
>;

interface DiffLayout {
  entries: DiffEntry[];
  hidden: number;
  numberWidth: number;
  textWidth: number;
  /** Terminal rows the view takes. */
  height: number;
}

type DiffLineKind = 'context' | 'added' | 'removed' | 'note';

interface DiffLine {
  kind: DiffLineKind;
  /** New line number for context/added lines, old line number for removed lines. */
  number?: number;
  text: string;
}

type DiffEntry = DiffLine | { kind: 'separator' };

/**
 * File diff with a line-number gutter: context lines dim, "-" lines red, "+" lines green; hunks
 * separated by a dim "⋮". When more than `maxLines` diff lines, shows the first ones and
 * "… N more lines" (dim).
 */
export function DiffView({
  diff,
  maxLines,
  maxRows,
  width,
  indent = DEFAULT_INDENT,
  overflow = 'wrap',
}: DiffViewOptions) {
  const { entries, hidden, numberWidth, textWidth, height } = layoutDiff(diff, {
    maxLines,
    maxRows,
    width,
    indent,
    overflow,
  });
  if (height === 0) return null;
  const pad = ' '.repeat(indent);
  return (
    <Box flexDirection="column">
      {entries.map((entry, i) => {
        if (entry.kind === 'separator') {
          return (
            <Text key={i} dimColor>
              {pad + padStartToWidth(HUNK_SEPARATOR, numberWidth)}
            </Text>
          );
        }
        const number = padStartToWidth(entry.number ? String(entry.number) : '', numberWidth);
        return entryRows(entry, textWidth, overflow).map((row, r) => (
          <DiffRow
            key={`${i}:${r}`}
            kind={entry.kind}
            prefix={
              pad +
              (r === 0
                ? `${number} ${signOf(entry.kind)} `
                : ' '.repeat(numberWidth + SIGN_COLUMNS))
            }
            numberColumns={r === 0 ? pad.length + numberWidth : 0}
            text={row}
          />
        ));
      })}
      {hidden > 0 && (
        <Text dimColor>
          {pad}
          {glyphs.ellipsis} {plural(hidden, 'more line')}
        </Text>
      )}
    </Box>
  );
}

interface DiffRowProps {
  kind: DiffLineKind;
  prefix: string;
  /** Leading columns of `prefix` holding the (always dim) line number. */
  numberColumns: number;
  text: string;
}

function DiffRow({ kind, prefix, numberColumns, text }: DiffRowProps) {
  if (kind === 'context' || kind === 'note') {
    return <Text dimColor>{prefix + text}</Text>;
  }
  const color = kind === 'added' ? theme.added : theme.removed;
  return (
    <Text>
      <Text dimColor>{prefix.slice(0, numberColumns)}</Text>
      <Text color={color}>{prefix.slice(numberColumns) + text}</Text>
    </Text>
  );
}

/**
 * Terminal rows a DiffView with these options takes, and whether it shows the whole diff (no
 * lines left out, no line cut short).
 */
export function measureDiffView(
  diff: FileDiff,
  options: DiffLayoutOptions,
): { height: number; complete: boolean } {
  const layout = layoutDiff(diff, options);
  const overflow = options.overflow ?? 'wrap';
  const cut =
    overflow === 'truncate' &&
    layout.entries.some(
      (entry) => entry.kind !== 'separator' && displayWidth(entry.text) > layout.textWidth,
    );
  const total = diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  const shown = layout.entries.filter((entry) => entry.kind !== 'separator').length;
  return { height: layout.height, complete: !cut && shown === total };
}

/** The diff lines to show: at most `maxLines`, and fewer when they need more than `maxRows`. */
function layoutDiff(diff: FileDiff, options: DiffLayoutOptions): DiffLayout {
  const indent = options.indent ?? DEFAULT_INDENT;
  const overflow = options.overflow ?? 'wrap';
  const maxRows = Math.max(0, options.maxRows ?? Number.POSITIVE_INFINITY);
  // Every shown line takes at least one row.
  let lines = Math.min(options.maxLines ?? Number.POSITIVE_INFINITY, maxRows);
  for (;;) {
    const { entries, hidden } = collectEntries(diff, lines);
    const numberWidth = Math.max(
      1,
      ...entries.map((entry) =>
        'number' in entry && entry.number ? String(entry.number).length : 0,
      ),
    );
    const textWidth = Math.max(1, options.width - indent - numberWidth - SIGN_COLUMNS);
    let height = hidden > 0 ? 1 : 0;
    for (const entry of entries) {
      height += entry.kind === 'separator' ? 1 : entryRows(entry, textWidth, overflow).length;
    }
    if (height <= maxRows) return { entries, hidden, numberWidth, textWidth, height };
    if (lines <= 0) return { entries: [], hidden: 0, numberWidth, textWidth, height: 0 };
    lines -= 1;
  }
}

function entryRows(entry: DiffLine, textWidth: number, overflow: 'wrap' | 'truncate'): string[] {
  return overflow === 'wrap'
    ? hardWrap(entry.text, textWidth)
    : [truncateToWidth(entry.text, textWidth)];
}

function signOf(kind: DiffLineKind): string {
  if (kind === 'added') return '+';
  if (kind === 'removed') return '-';
  return ' ';
}

function collectEntries(
  diff: FileDiff,
  maxLines: number,
): { entries: DiffEntry[]; hidden: number } {
  const entries: DiffEntry[] = [];
  let shown = 0;
  let total = 0;
  diff.hunks.forEach((hunk, h) => {
    let oldNumber = hunk.oldStart;
    let newNumber = hunk.newStart;
    if (h > 0 && shown < maxLines) entries.push({ kind: 'separator' });
    for (const raw of hunk.lines) {
      const line = parseLine(raw, oldNumber, newNumber);
      if (line.kind === 'removed') oldNumber++;
      else if (line.kind === 'added') newNumber++;
      else if (line.kind === 'context') {
        oldNumber++;
        newNumber++;
      }
      total++;
      if (shown < maxLines) {
        entries.push(line);
        shown++;
      }
    }
  });
  return { entries, hidden: total - shown };
}

function parseLine(raw: string, oldNumber: number, newNumber: number): DiffLine {
  const text = toDisplayText(raw.slice(1)).replace(/\n/g, ' ');
  switch (raw[0]) {
    case '+':
      return { kind: 'added', number: newNumber, text };
    case '-':
      return { kind: 'removed', number: oldNumber, text };
    case '\\':
      return { kind: 'note', text: toDisplayText(raw) };
    default:
      return { kind: 'context', number: newNumber, text };
  }
}
