import type { Key } from 'ink';
import { imageToken, type ImageAttachment } from '../images.js';
import {
  displayWidth,
  graphemes,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
  snapToCodePoint,
  TAB_WIDTH,
} from './text-layout.js';

/** An image attached to the draft, shown in the text as its token `[Image #<id>]`. */
export interface ComposerAttachment extends ImageAttachment {
  id: number;
}

/** Editor state for the multi-line prompt. Pure data so it can be tested without a terminal. */
export interface ComposerState {
  text: string;
  /** Cursor offset into `text` (0..text.length), in UTF-16 code units, never inside a surrogate pair. */
  cursor: number;
  /** Index into history while browsing (0 = most recent), or null when editing a fresh draft. */
  historyIndex: number | null;
  /** The draft saved when history browsing started. */
  draft: string;
  /**
   * Images attached to the draft (absent: none). An attachment is sent only while its token is in
   * the text; it is kept while browsing history, so the draft's tokens still work when restored.
   */
  attachments?: readonly ComposerAttachment[];
}

export const emptyComposer: ComposerState = { text: '', cursor: 0, historyIndex: null, draft: '' };

/** Matches attachment tokens; group 1 is the number. */
const IMAGE_TOKEN = /\[Image #(\d+)\]/g;

/**
 * What the key did beyond editing, for the owner component to act on:
 *  - submit:     Enter on a line not ending in "\" (text is the trimmed-right input; empty text
 *                submits nothing → 'none'), with the images whose tokens it contains when there
 *                are any (see takeAttachments: tokens are renumbered 1..n in order of appearance)
 *  - tab:        Tab pressed (autocomplete is decided by the owner)
 *  - cycle-mode: Shift+Tab (terminals send ESC [ Z, which Ink reports as tab with shift)
 *  - escape:     Esc pressed
 *  - interrupt:  Ctrl+C pressed
 *  - exit:       Ctrl+D on an empty input
 *  - clear-screen: Ctrl+L
 *  - expand:     Ctrl+O
 *  - paste-image: Alt+V, or Ctrl+V when the terminal passes it through (paste a clipboard image)
 *  - menu-up / menu-down: Up/Down while the owner reports an open menu (see options.menuOpen)
 */
export type ComposerEffect =
  | { type: 'none' }
  | { type: 'submit'; text: string; images?: ImageAttachment[] }
  | { type: 'tab' }
  | { type: 'cycle-mode' }
  | { type: 'escape' }
  | { type: 'interrupt' }
  | { type: 'exit' }
  | { type: 'clear-screen' }
  | { type: 'expand' }
  | { type: 'paste-image' }
  | { type: 'menu-up' }
  | { type: 'menu-down' };

export interface ComposerOptions {
  /** Submitted prompts, most recent first. */
  history: readonly string[];
  /** When true, Up/Down produce menu-up/menu-down instead of moving the cursor/history. */
  menuOpen?: boolean;
}

type KeyResult = { state: ComposerState; effect: ComposerEffect };

const NONE: ComposerEffect = { type: 'none' };

/**
 * Applies one Ink input event.
 * Editing keys:
 *  - printable input inserts at the cursor; multi-character input (paste) is inserted verbatim
 *    with CRLF/CR normalized to LF (a paste never submits)
 *  - Enter: submit; if the character before the cursor is "\", replace it with a newline instead
 *  - Alt/Option+Enter (key.return && key.meta) and Ctrl+J (input "\n"): insert newline
 *  - Backspace and Delete keys (Ink reports the Backspace key as `delete` on many terminals):
 *    delete the character before the cursor, or the whole attachment token (`[Image #N]`) that
 *    ends there together with its attachment; Ctrl+D with text: delete the character under the
 *    cursor
 *  - Alt+V and Ctrl+V: the paste-image effect (no edit)
 *  - Left/Right, Home/End (line-wise), Ctrl+A/Ctrl+E (line start/end), Alt+Left/Right or
 *    Alt+B/Alt+F (word-wise)
 *  - Ctrl+U (delete to line start), Ctrl+K (delete to line end), Ctrl+W / Alt+Backspace
 *    (delete previous word)
 *  - Up/Down: move between lines of a multi-line input; on the first line Up recalls the
 *    previous history entry (saving the draft); on the last line Down moves toward newer
 *    history and finally restores the draft. Cursor goes to the end of a recalled entry.
 * Never throws; unknown keys are ignored.
 *
 * Details beyond the list above: "characters" are grapheme clusters (an emoji with modifiers is
 * deleted as one); Shift+Enter (reported by terminals with enhanced keyboard support) also
 * inserts a newline; Ctrl+Left/Right move word-wise like Alt; Ctrl+U at a line start and Ctrl+K
 * at a line end join the adjacent line; Up on the first line with no older history moves to the
 * start and Down on the last line outside history moves to the end. Submitting resets the state.
 */
export function applyKey(
  state: ComposerState,
  input: string,
  key: Key,
  options: ComposerOptions,
): { state: ComposerState; effect: ComposerEffect } {
  if (key.escape) return effect(state, { type: 'escape' });
  if (key.return) return key.meta || key.shift ? edited(insert(state, '\n')) : enter(state);
  if (key.tab) return effect(state, { type: key.shift ? 'cycle-mode' : 'tab' });
  if (key.upArrow) {
    return options.menuOpen ? effect(state, { type: 'menu-up' }) : edited(moveUp(state, options));
  }
  if (key.downArrow) {
    return options.menuOpen
      ? effect(state, { type: 'menu-down' })
      : edited(moveDown(state, options));
  }
  const wordWise = key.meta || key.ctrl;
  if (key.leftArrow) {
    const target = wordWise
      ? wordStartBefore(state.text, state.cursor)
      : previousGraphemeBoundary(state.text, state.cursor);
    return edited(moveCursor(state, target));
  }
  if (key.rightArrow) {
    const target = wordWise
      ? wordEndAfter(state.text, state.cursor)
      : nextGraphemeBoundary(state.text, state.cursor);
    return edited(moveCursor(state, target));
  }
  if (key.home) return edited(moveCursor(state, lineStart(state.text, state.cursor)));
  if (key.end) return edited(moveCursor(state, lineEnd(state.text, state.cursor)));
  if (key.backspace || key.delete) {
    if (!key.meta) {
      const removed = removeTokenBefore(state);
      if (removed) return edited(removed);
    }
    const from = key.meta
      ? wordStartBefore(state.text, state.cursor)
      : previousGraphemeBoundary(state.text, state.cursor);
    return edited(deleteRange(state, from, state.cursor));
  }
  if (key.ctrl) return controlKey(state, input);
  if (key.meta) return metaKey(state, input);
  return edited(insert(state, input));
}

/** Replaces the whole text (e.g. after autocomplete) and puts the cursor at the end. */
export function setText(text: string): ComposerState {
  return { text, cursor: text.length, historyIndex: null, draft: '' };
}

/** Inserts text at the cursor as typed or pasted (e.g. a paste that did not become an image). */
export function insertText(state: ComposerState, text: string): ComposerState {
  return insert(state, text);
}

/**
 * Attaches an image: its token goes in at the cursor (with a space on either side where the
 * neighbouring text has none), numbered one above the highest number in use.
 */
export function attachImage(state: ComposerState, attachment: ImageAttachment): ComposerState {
  const attachments = state.attachments ?? [];
  const id = Math.max(0, ...attachments.map((a) => a.id)) + 1;
  const before = state.text.slice(0, state.cursor);
  const after = state.text.slice(state.cursor);
  const lead = before === '' || /\s$/.test(before) ? '' : ' ';
  const trail = /^\s/.test(after) ? '' : ' ';
  const token = `${lead}${imageToken(id)}${trail}`;
  return {
    ...state,
    text: before + token + after,
    cursor: state.cursor + token.length,
    attachments: [...attachments, { ...attachment, id }],
  };
}

/** The attachments whose tokens are in the text, in order of first appearance. */
export function attachmentsInText(state: ComposerState): ComposerAttachment[] {
  const attachments = state.attachments ?? [];
  const found: ComposerAttachment[] = [];
  for (const match of state.text.matchAll(IMAGE_TOKEN)) {
    const attachment = attachments.find((a) => a.id === Number(match[1]));
    if (attachment && !found.includes(attachment)) found.push(attachment);
  }
  return found;
}

/**
 * The text and images to send: attachments whose tokens are in the text, in order of first
 * appearance, with their tokens renumbered 1..n in that order (so "[Image #1]" is the first
 * image the model sees, also after earlier attachments were removed). Other tokens stay as typed.
 */
export function takeAttachments(state: ComposerState): { text: string; images: ImageAttachment[] } {
  const sent = attachmentsInText(state);
  const text = state.text.replace(IMAGE_TOKEN, (token, digits: string) => {
    const index = sent.findIndex((a) => a.id === Number(digits));
    return index === -1 ? token : imageToken(index + 1);
  });
  return { text, images: sent.map(({ image, description }) => ({ image, description })) };
}

/** Backspace right after an attachment's token: removes the token and the attachment. */
function removeTokenBefore(state: ComposerState): ComposerState | undefined {
  const attachments = state.attachments ?? [];
  if (attachments.length === 0) return undefined;
  const match = /\[Image #(\d+)\]$/.exec(state.text.slice(0, state.cursor));
  const id = Number(match?.[1]);
  if (!match || !attachments.some((a) => a.id === id)) return undefined;
  const next = deleteRange(state, state.cursor - match[0].length, state.cursor);
  // The same token may appear twice; the image goes with its last one.
  if (next.text.includes(match[0])) return next;
  return { ...next, attachments: attachments.filter((a) => a.id !== id) };
}

/** Line/column of the cursor (0-based) for rendering. */
export function cursorPosition(state: ComposerState): { line: number; column: number } {
  const before = state.text.slice(0, state.cursor);
  const lines = before.split('\n');
  return { line: lines.length - 1, column: lines[lines.length - 1]?.length ?? 0 };
}

/** Columns a grapheme occupies in the composer (tabs are shown as TAB_WIDTH spaces). */
export function editorCellWidth(grapheme: string): number {
  return grapheme === '\t' ? TAB_WIDTH : displayWidth(grapheme);
}

function effect(state: ComposerState, value: ComposerEffect): KeyResult {
  return { state, effect: value };
}

function edited(state: ComposerState): KeyResult {
  return { state, effect: NONE };
}

function enter(state: ComposerState): KeyResult {
  const { text, cursor } = state;
  if (cursor > 0 && text[cursor - 1] === '\\') {
    return edited({ ...state, text: `${text.slice(0, cursor - 1)}\n${text.slice(cursor)}` });
  }
  if (text.trimEnd() === '') return edited(state);
  const { text: sent, images } = takeAttachments(state);
  return {
    state: emptyComposer,
    effect: { type: 'submit', text: sent.trimEnd(), ...(images.length > 0 ? { images } : {}) },
  };
}

function controlKey(state: ComposerState, input: string): KeyResult {
  const { text, cursor } = state;
  switch (input.toLowerCase()) {
    case 'c':
      return effect(state, { type: 'interrupt' });
    case 'd':
      if (text === '') return effect(state, { type: 'exit' });
      return edited(deleteRange(state, cursor, nextGraphemeBoundary(text, cursor)));
    case 'l':
      return effect(state, { type: 'clear-screen' });
    case 'o':
      return effect(state, { type: 'expand' });
    case 'v':
      return effect(state, { type: 'paste-image' });
    case 'a':
      return edited(moveCursor(state, lineStart(text, cursor)));
    case 'e':
      return edited(moveCursor(state, lineEnd(text, cursor)));
    case 'u': {
      const start = lineStart(text, cursor);
      return edited(deleteRange(state, start === cursor ? Math.max(0, cursor - 1) : start, cursor));
    }
    case 'k': {
      const end = lineEnd(text, cursor);
      return edited(
        deleteRange(state, cursor, end === cursor ? Math.min(text.length, end + 1) : end),
      );
    }
    case 'w':
      return edited(deleteRange(state, wordStartBefore(text, cursor), cursor));
    default:
      return edited(state);
  }
}

function metaKey(state: ComposerState, input: string): KeyResult {
  if (input === 'b') return edited(moveCursor(state, wordStartBefore(state.text, state.cursor)));
  if (input === 'f') return edited(moveCursor(state, wordEndAfter(state.text, state.cursor)));
  if (input === 'v') return effect(state, { type: 'paste-image' });
  return edited(state);
}

function insert(state: ComposerState, raw: string): ComposerState {
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  if (text === '') return state;
  return {
    ...state,
    text: state.text.slice(0, state.cursor) + text + state.text.slice(state.cursor),
    cursor: state.cursor + text.length,
  };
}

function moveCursor(state: ComposerState, cursor: number): ComposerState {
  return cursor === state.cursor ? state : { ...state, cursor };
}

function deleteRange(state: ComposerState, from: number, to: number): ComposerState {
  if (from >= to) return state;
  return { ...state, text: state.text.slice(0, from) + state.text.slice(to), cursor: from };
}

function lineStart(text: string, index: number): number {
  return index <= 0 ? 0 : text.lastIndexOf('\n', index - 1) + 1;
}

function lineEnd(text: string, index: number): number {
  const newline = text.indexOf('\n', index);
  return newline === -1 ? text.length : newline;
}

// ---------------------------------------------------------------------------------------------
// Vertical movement and history

function moveUp(state: ComposerState, options: ComposerOptions): ComposerState {
  const { text, cursor } = state;
  const start = lineStart(text, cursor);
  if (start > 0) {
    const column = columnOf(text, start, cursor);
    return moveCursor(state, offsetAtColumn(text, lineStart(text, start - 1), start - 1, column));
  }
  const older = state.historyIndex === null ? 0 : state.historyIndex + 1;
  const entry = options.history[older];
  if (entry === undefined) return moveCursor(state, 0);
  return {
    ...keptAttachments(state),
    text: entry,
    cursor: entry.length,
    historyIndex: older,
    draft: state.historyIndex === null ? text : state.draft,
  };
}

function moveDown(state: ComposerState, options: ComposerOptions): ComposerState {
  const { text, cursor } = state;
  const end = lineEnd(text, cursor);
  if (end < text.length) {
    const column = columnOf(text, lineStart(text, cursor), cursor);
    return moveCursor(state, offsetAtColumn(text, end + 1, lineEnd(text, end + 1), column));
  }
  if (state.historyIndex === null) return moveCursor(state, text.length);
  const newer = state.historyIndex - 1;
  const entry = newer >= 0 ? options.history[newer] : undefined;
  if (entry !== undefined) {
    return {
      ...keptAttachments(state),
      text: entry,
      cursor: entry.length,
      historyIndex: newer,
      draft: state.draft,
    };
  }
  return {
    ...keptAttachments(state),
    text: state.draft,
    cursor: state.draft.length,
    historyIndex: null,
    draft: '',
  };
}

/** The draft's attachments, carried over while browsing history. */
function keptAttachments(state: ComposerState): Pick<ComposerState, 'attachments'> {
  return state.attachments ? { attachments: state.attachments } : {};
}

function columnOf(text: string, from: number, to: number): number {
  let width = 0;
  for (const grapheme of graphemes(text.slice(from, to))) width += editorCellWidth(grapheme);
  return width;
}

/** Offset in [from, to] whose display column is the closest one not past `column`. */
function offsetAtColumn(text: string, from: number, to: number, column: number): number {
  let offset = from;
  let used = 0;
  for (const grapheme of graphemes(text.slice(from, to))) {
    const width = editorCellWidth(grapheme);
    if (used + width > column) break;
    used += width;
    offset += grapheme.length;
  }
  return offset;
}

// ---------------------------------------------------------------------------------------------
// Words: a run of letters/digits/underscores, or a run of other non-space characters. Word
// motions stop at line boundaries so Ctrl+W at the start of a line only removes the newline.

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;

function isBlank(char: string | undefined): boolean {
  return char === ' ' || char === '\t';
}

function isWordChar(char: string): boolean {
  return WORD_CHAR.test(char);
}

function codePointBefore(text: string, index: number): string {
  return text.slice(snapToCodePoint(text, index - 1), index);
}

function codePointAt(text: string, index: number): string {
  const code = text.codePointAt(index);
  return code === undefined ? '' : String.fromCodePoint(code);
}

function wordStartBefore(text: string, index: number): number {
  let i = index;
  if (i > 0 && text[i - 1] === '\n') return i - 1;
  while (i > 0 && isBlank(text[i - 1])) i--;
  if (i === 0 || text[i - 1] === '\n') return i;
  const word = isWordChar(codePointBefore(text, i));
  while (i > 0) {
    const char = codePointBefore(text, i);
    if (char === '\n' || isBlank(char) || isWordChar(char) !== word) break;
    i -= char.length;
  }
  return i;
}

function wordEndAfter(text: string, index: number): number {
  let i = index;
  if (i < text.length && text[i] === '\n') return i + 1;
  while (i < text.length && isBlank(text[i])) i++;
  if (i >= text.length || text[i] === '\n') return i;
  const word = isWordChar(codePointAt(text, i));
  while (i < text.length) {
    const char = codePointAt(text, i);
    if (char === '\n' || isBlank(char) || isWordChar(char) !== word) break;
    i += char.length;
  }
  return i;
}
