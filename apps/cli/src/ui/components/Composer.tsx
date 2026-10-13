import { Box, Text, useInput, type Key } from 'ink';
import { useCallback, useRef, useState } from 'react';
import { imageLine, pastedImagePath } from '../../images.js';
import {
  applyKey,
  attachmentsInText,
  editorCellWidth,
  setText,
  type ComposerEffect,
  type ComposerState,
} from '../composer-state.js';
import { glyphs, theme } from '../theme.js';
import {
  displayWidth,
  graphemes,
  TAB_WIDTH,
  toDisplayText,
  truncateToWidth,
} from '../text-layout.js';
import type { ComposerProps, SlashCommandInfo } from './props.js';

const PROMPT_WIDTH = 2;
const MENU_SIZE = 6;
/** Attachment lines shown under the text; more are counted in the last one. */
const MAX_ATTACHMENT_ROWS = 3;
/** Taller input is scrolled around the cursor so the live region stays shorter than a screen. */
const MAX_VISIBLE_ROWS = 16;
const MIN_CONTENT_WIDTH = 8;
const MIN_DESCRIPTION_WIDTH = 10;

interface MenuState {
  /** The slash query the highlight belongs to; a different query resets the highlight. */
  query: string | null;
  index: number;
}

/**
 * Multi-line prompt: "› " + text with a block cursor, a dim placeholder when empty, a slash
 * command menu while a command name is being typed, and a "!" marker in shell mode (the leading
 * "!" of the text is drawn as the marker). The owner holds the state and receives every change.
 */
export function Composer(props: ComposerProps) {
  const { state, commands, isActive, placeholder, width, busy } = props;
  const [menu, setMenu] = useState<MenuState>({ query: null, index: 0 });
  const matches = matchSlashCommands(state.text, commands);
  const highlight = highlightIndex(menu, slashQuery(state.text), matches?.length ?? 0);

  // Several key events can arrive before React re-renders (fast typing, a key right after a
  // paste); the handler always works from the newest state rather than a stale render's props.
  const latest = useRef({ state, menu, props });
  latest.current = { state, menu, props };

  const handleInput = useCallback((input: string, key: Key) => {
    const { state: current, menu: menuState, props: owner } = latest.current;
    // Terminals that report focus changes (ESC [ I, ESC [ O) are not typing.
    if (input === '[I' || input === '[O') return;
    if (owner.onKey?.(input, key, current)) return;
    const found = matchSlashCommands(current.text, owner.commands) ?? [];
    const query = slashQuery(current.text);
    const selected = found[highlightIndex(menuState, query, found.length)];
    const update = (next: ComposerState): void => {
      const nextQuery = slashQuery(next.text);
      if (nextQuery !== query) {
        const freshMenu = { query: nextQuery, index: 0 };
        latest.current = { ...latest.current, menu: freshMenu };
        setMenu(freshMenu);
      }
      latest.current = { ...latest.current, state: next };
      owner.onChange(next);
      if (query === null && nextQuery !== null) owner.onMenuOpen?.();
    };

    // Shift+Tab switches modes even while the menu is open.
    if (key.tab && !key.shift && selected) {
      update(setText(`/${selected.name} `));
      return;
    }
    // A paste arrives as one multi-character input. One that is exactly a path to an image (a
    // dropped file) goes to the owner, which attaches the image or inserts the text after all.
    const pastedPath = isPaste(input, key) ? pastedImagePath(input) : undefined;
    if (pastedPath !== undefined && owner.onPastePath) {
      owner.onPastePath(pastedPath, input);
      return;
    }
    const result = applyKey(current, input, key, {
      history: owner.history,
      menuOpen: found.length > 0,
    });
    if (result.state !== current) update(result.state);
    const effect: ComposerEffect = result.effect;
    switch (effect.type) {
      case 'none':
      case 'tab':
        return;
      case 'menu-up':
      case 'menu-down': {
        const step = effect.type === 'menu-up' ? -1 : 1;
        const index = highlightIndex(menuState, query, found.length);
        const next = { query, index: (index + step + found.length) % found.length };
        latest.current = { ...latest.current, menu: next };
        setMenu(next);
        return;
      }
      case 'submit': {
        const runSelected = selected !== undefined && !isExactCommand(effect.text, owner.commands);
        if (runSelected) owner.onSubmit(`/${selected.name}`);
        else if (effect.images) owner.onSubmit(effect.text, effect.images);
        else owner.onSubmit(effect.text);
        return;
      }
      default:
        owner.onEffect(effect);
    }
  }, []);

  useInput(handleInput, { isActive });

  const contentWidth = Math.max(MIN_CONTENT_WIDTH, width - PROMPT_WIDTH);
  const shell = state.text.startsWith('!');
  const marker = (
    <Text color={shell ? theme.warning : theme.accent} dimColor={busy}>
      {`${shell ? '!' : glyphs.prompt} `}
    </Text>
  );

  const layout = layoutComposer(state, width, commands, isActive, props.maxRows);
  const view = layout.view;
  if (view === null) {
    return (
      <Text>
        {marker}
        <Placeholder text={placeholder ?? ''} width={contentWidth} showCursor={isActive} />
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      {view.hiddenAbove > 0 && (
        <Text>
          {marker}
          <Text dimColor>{`↑ ${moreLines(view.hiddenAbove)}`}</Text>
        </Text>
      )}
      {view.rows.map((row, i) => (
        <Text key={i}>
          {i === 0 && view.hiddenAbove === 0 ? marker : ' '.repeat(PROMPT_WIDTH)}
          {row.before}
          {row.cursor !== null && <Text inverse>{row.cursor}</Text>}
          {row.after}
        </Text>
      ))}
      {view.hiddenBelow > 0 && (
        <Text dimColor>{`${' '.repeat(PROMPT_WIDTH)}↓ ${moreLines(view.hiddenBelow)}`}</Text>
      )}
      {layout.attachments.map((line, i) => (
        <Text key={`attachment-${i}`} dimColor wrap="truncate-end">
          {' '.repeat(PROMPT_WIDTH) + truncateToWidth(line, contentWidth)}
        </Text>
      ))}
      {isActive && matches && (
        <SlashMenu
          matches={matches}
          highlight={highlight}
          width={contentWidth}
          size={layout.menuSize}
        />
      )}
    </Box>
  );
}

interface ComposerLayout {
  /** Null when the text is empty (the placeholder takes one row). */
  view: TextView | null;
  /** Dim lines under the text describing the attached images, one row each. */
  attachments: string[];
  /** Commands the slash menu lists at once. */
  menuSize: number;
  /** Terminal rows the composer takes. */
  height: number;
}

/** Terminal rows the Composer takes with these props. */
export function composerHeight(
  props: Pick<ComposerProps, 'state' | 'width' | 'commands' | 'isActive' | 'maxRows'>,
): number {
  return layoutComposer(props.state, props.width, props.commands, props.isActive, props.maxRows)
    .height;
}

function layoutComposer(
  state: ComposerState,
  width: number,
  commands: readonly SlashCommandInfo[],
  isActive: boolean,
  maxRows: number | undefined,
): ComposerLayout {
  if (state.text === '') return { view: null, attachments: [], menuSize: MENU_SIZE, height: 1 };
  const budget = Math.max(1, maxRows ?? MAX_VISIBLE_ROWS + MENU_SIZE);
  const contentWidth = Math.max(MIN_CONTENT_WIDTH, width - PROMPT_WIDTH);
  // The attachment lines take rows from the text's budget, but never its last row (with the
  // "N more lines" indicators it may need).
  const wanted = Math.min(MAX_ATTACHMENT_ROWS, attachmentsInText(state).length, budget - 1);
  const textBudget = budget - Math.max(0, wanted);
  const shell = state.text.startsWith('!');
  const shown = shell ? state.text.slice(1) : state.text;
  const cursor = isActive ? Math.max(0, state.cursor - (shell ? 1 : 0)) : null;
  const textRows = Math.min(MAX_VISIBLE_ROWS, textBudget);
  let view = layoutText(shown, cursor, contentWidth, textRows);
  // The "↑/↓ N more lines" indicators take rows of their own.
  const indicators = (view.hiddenAbove > 0 ? 1 : 0) + (view.hiddenBelow > 0 ? 1 : 0);
  if (indicators > 0 && view.rows.length + indicators > textBudget) {
    view = layoutText(shown, cursor, contentWidth, Math.max(1, textRows - 2));
  }
  const textRowsUsed =
    view.rows.length + (view.hiddenAbove > 0 ? 1 : 0) + (view.hiddenBelow > 0 ? 1 : 0);
  const attachments = attachmentLines(state, Math.min(wanted, budget - textRowsUsed));
  const textHeight = textRowsUsed + attachments.length;
  const menuSize = Math.max(1, Math.min(MENU_SIZE, budget - textHeight));
  const matches = isActive ? matchSlashCommands(state.text, commands) : null;
  const menuHeight = matches ? Math.max(1, Math.min(matches.length, menuSize)) : 0;
  return { view, attachments, menuSize, height: textHeight + menuHeight };
}

/**
 * "[Image #1] screenshot.png · 1280×720 · 84 KB" for each attachment whose token is in the text,
 * at most `maxRows` lines (the last one counts the rest when they do not fit).
 */
function attachmentLines(state: ComposerState, maxRows: number): string[] {
  if (maxRows <= 0) return [];
  const lines = attachmentsInText(state).map((attachment) =>
    toDisplayText(imageLine(attachment.id, attachment.description)).replace(/\n/g, ' '),
  );
  if (lines.length <= maxRows) return lines;
  const kept = lines.slice(0, maxRows - 1);
  const rest = lines.length - kept.length;
  return [...kept, kept.length > 0 ? `+ ${rest} more images` : `${rest} images attached`];
}

/** Several characters in one input event: a paste (or a terminal's dropped-file path). */
function isPaste(input: string, key: Key): boolean {
  return input.length > 1 && !key.ctrl && !key.meta && !key.return && !key.escape;
}

function Placeholder({
  text,
  width,
  showCursor,
}: {
  text: string;
  width: number;
  showCursor: boolean;
}) {
  const shown = truncateToWidth(text.replace(/\s+/g, ' '), Math.max(1, width - 1));
  if (!showCursor) return <Text dimColor>{shown}</Text>;
  const [first = ' ', ...rest] = graphemes(shown);
  return (
    <>
      <Text inverse>{first}</Text>
      <Text dimColor>{rest.join('')}</Text>
    </>
  );
}

function moreLines(count: number): string {
  return `${count} more ${count === 1 ? 'line' : 'lines'}`;
}

// ---------------------------------------------------------------------------------------------
// Slash commands

/** The text after "/" while a command name is being typed (no whitespace yet), else null. */
function slashQuery(text: string): string | null {
  return text.startsWith('/') && !/\s/.test(text) ? text.slice(1).toLowerCase() : null;
}

/**
 * Commands matching a partially typed "/name" (null when the text is not a command being typed):
 * exact name or alias first, then name prefix, alias prefix, name substring, alias substring.
 * Ties keep the order of `commands`.
 */
export function matchSlashCommands(
  text: string,
  commands: readonly SlashCommandInfo[],
): SlashCommandInfo[] | null {
  const query = slashQuery(text);
  if (query === null) return null;
  return commands
    .map((command, order) => ({ command, order, rank: matchRank(command, query) }))
    .filter(
      (entry): entry is { command: SlashCommandInfo; order: number; rank: number } =>
        entry.rank !== null,
    )
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((entry) => entry.command);
}

function matchRank(command: SlashCommandInfo, query: string): number | null {
  const name = command.name.toLowerCase();
  const aliases = (command.aliases ?? []).map((alias) => alias.toLowerCase());
  if (name === query || aliases.includes(query)) return 0;
  if (name.startsWith(query)) return 1;
  if (aliases.some((alias) => alias.startsWith(query))) return 2;
  if (name.includes(query)) return 3;
  if (aliases.some((alias) => alias.includes(query))) return 4;
  return null;
}

function isExactCommand(text: string, commands: readonly SlashCommandInfo[]): boolean {
  const query = slashQuery(text);
  return query !== null && commands.some((command) => matchRank(command, query) === 0);
}

function highlightIndex(menu: MenuState, query: string | null, count: number): number {
  if (count === 0 || menu.query !== query) return 0;
  return Math.min(Math.max(0, menu.index), count - 1);
}

function SlashMenu({
  matches,
  highlight,
  width,
  size,
}: {
  matches: readonly SlashCommandInfo[];
  highlight: number;
  width: number;
  size: number;
}) {
  const pad = ' '.repeat(PROMPT_WIDTH);
  if (matches.length === 0) {
    return <Text dimColor wrap="truncate-end">{`${pad}No matching commands`}</Text>;
  }
  // When not all of them fit, the last row says how many are left out.
  const shown = matches.length > size && size > 1 ? size - 1 : size;
  const start = Math.min(Math.max(0, highlight - shown + 1), Math.max(0, matches.length - shown));
  const visible = matches.slice(start, start + shown);
  const labelWidth = Math.max(...visible.map((command) => displayWidth(commandLabel(command))));
  const descriptionWidth = width - labelWidth - PROMPT_WIDTH;
  return (
    <Box flexDirection="column">
      {visible.map((command, i) => {
        const selected = start + i === highlight;
        const gap = labelWidth - displayWidth(commandLabel(command)) + PROMPT_WIDTH;
        return (
          <Text key={command.name} wrap="truncate-end">
            {pad}
            <Text color={selected ? theme.accent : undefined} bold={selected}>
              {`/${command.name}`}
            </Text>
            {command.args && <Text dimColor>{` ${command.args}`}</Text>}
            {descriptionWidth >= MIN_DESCRIPTION_WIDTH && (
              <Text dimColor>
                {' '.repeat(gap) + truncateToWidth(describeCommand(command), descriptionWidth)}
              </Text>
            )}
          </Text>
        );
      })}
      {matches.length > visible.length && (
        <Text
          dimColor
          wrap="truncate-end"
        >{`${pad}… ${matches.length - visible.length} more`}</Text>
      )}
    </Box>
  );
}

function commandLabel(command: SlashCommandInfo): string {
  return `/${command.name}${command.args ? ` ${command.args}` : ''}`;
}

/** The description with the command's tag: "Review the diff (project)". */
function describeCommand(command: SlashCommandInfo): string {
  return command.tag ? `${command.description} (${command.tag})` : command.description;
}

// ---------------------------------------------------------------------------------------------
// Text layout: logical lines are wrapped to the width (preferring spaces), the cursor is a cell
// drawn in inverse video, and only a window of rows around the cursor is laid out.

interface Cell {
  /** What is drawn (tabs become spaces). */
  text: string;
  /** Offset of the grapheme in the full text. */
  start: number;
  length: number;
  width: number;
}

interface Row {
  before: string;
  /** The cell drawn under the cursor, or null when the cursor is not on this row. */
  cursor: string | null;
  after: string;
}

interface TextView {
  rows: Row[];
  hiddenAbove: number;
  hiddenBelow: number;
}

function layoutText(text: string, cursor: number | null, width: number, maxRows: number): TextView {
  const lines = text.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const focusLine =
    cursor === null ? lines.length - 1 : text.slice(0, cursor).split('\n').length - 1;
  const firstExact = Math.max(0, focusLine - maxRows);
  const lastExact = Math.min(lines.length - 1, focusLine + maxRows);

  // Lines far from the cursor can never be visible; only their approximate height matters.
  const approxRows = (line: string): number => Math.max(1, Math.ceil(line.length / width));
  const above = lines.slice(0, firstExact).reduce((sum, line) => sum + approxRows(line), 0);
  const below = lines.slice(lastExact + 1).reduce((sum, line) => sum + approxRows(line), 0);

  const rows: Row[] = [];
  let focusRow = 0;
  for (let i = firstExact; i <= lastExact; i++) {
    const lineRows = layoutLine(lines[i] ?? '', starts[i] ?? 0, cursor, width);
    if (i === focusLine) {
      const withCursor = lineRows.findIndex((row) => row.cursor !== null);
      focusRow = rows.length + (withCursor === -1 ? lineRows.length - 1 : withCursor);
    }
    rows.push(...lineRows);
  }
  if (above + rows.length + below <= maxRows) return { rows, hiddenAbove: 0, hiddenBelow: 0 };
  const start = Math.min(
    Math.max(0, focusRow - Math.floor(maxRows / 2)),
    Math.max(0, rows.length - maxRows),
  );
  const end = Math.min(rows.length, start + maxRows);
  return {
    rows: rows.slice(start, end),
    hiddenAbove: above + start,
    hiddenBelow: below + rows.length - end,
  };
}

function layoutLine(line: string, lineStart: number, cursor: number | null, width: number): Row[] {
  const cells = toCells(line, lineStart);
  const rows = wrapCells(cells, width);
  const lineEnd = lineStart + line.length;
  const cursorAtEnd = cursor === lineEnd;
  const result: Row[] = [];
  rows.forEach((row, k) => {
    const at =
      cursor === null
        ? -1
        : row.findIndex((cell) => cursor >= cell.start && cursor < cell.start + cell.length);
    const cell = row[at];
    if (cell) {
      result.push({
        before: joinCells(row.slice(0, at)),
        cursor: cell.width === 0 ? ' ' : cell.text,
        after: joinCells(row.slice(at + 1)),
      });
      return;
    }
    const isLast = k === rows.length - 1;
    if (isLast && cursorAtEnd) {
      const used = row.reduce((sum, c) => sum + c.width, 0);
      if (used + 1 <= width) {
        result.push({ before: joinCells(row), cursor: ' ', after: '' });
      } else {
        result.push({ before: joinCells(row), cursor: null, after: '' });
        result.push({ before: '', cursor: ' ', after: '' });
      }
      return;
    }
    result.push({ before: joinCells(row), cursor: null, after: '' });
  });
  return result;
}

function toCells(line: string, lineStart: number): Cell[] {
  const cells: Cell[] = [];
  let offset = lineStart;
  for (const grapheme of graphemes(line)) {
    cells.push({
      text: grapheme === '\t' ? ' '.repeat(TAB_WIDTH) : grapheme,
      start: offset,
      length: grapheme.length,
      width: editorCellWidth(grapheme),
    });
    offset += grapheme.length;
  }
  return cells;
}

/** Greedy wrap that breaks after the last space of a full row, or mid-word when there is none. */
function wrapCells(cells: readonly Cell[], width: number): Cell[][] {
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let rowWidth = 0;
  for (const cell of cells) {
    if (row.length > 0 && rowWidth + cell.width > width) {
      const breakAt = cell.text === ' ' ? row.length : breakAfterLastSpace(row);
      const carry = breakAt > 0 ? row.slice(breakAt) : [];
      rows.push(breakAt > 0 ? row.slice(0, breakAt) : row);
      row = carry;
      rowWidth = carry.reduce((sum, c) => sum + c.width, 0);
      if (row.length > 0 && rowWidth + cell.width > width) {
        rows.push(row);
        row = [];
        rowWidth = 0;
      }
    }
    row.push(cell);
    rowWidth += cell.width;
  }
  rows.push(row);
  return rows;
}

function breakAfterLastSpace(row: readonly Cell[]): number {
  for (let i = row.length - 1; i > 0; i--) {
    if (row[i - 1]?.text === ' ') return i;
  }
  return 0;
}

function joinCells(cells: readonly Cell[]): string {
  return cells.map((cell) => cell.text).join('');
}
