import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';
import {
  applyKey,
  cursorPosition,
  emptyComposer,
  setText,
  type ComposerOptions,
  type ComposerState,
} from '../../src/ui/composer-state.js';

function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...overrides,
  };
}

const noHistory: ComposerOptions = { history: [] };

/** Builds a state from text with "|" marking the cursor. */
function at(marked: string): ComposerState {
  const cursor = marked.indexOf('|');
  return { text: marked.replace('|', ''), cursor, historyIndex: null, draft: '' };
}

/** Renders a state back to the "|" notation. */
function show(state: ComposerState): string {
  return `${state.text.slice(0, state.cursor)}|${state.text.slice(state.cursor)}`;
}

function press(
  state: ComposerState,
  input: string,
  overrides: Partial<Key> = {},
  options: ComposerOptions = noHistory,
) {
  return applyKey(state, input, key(overrides), options);
}

function type(state: ComposerState, text: string): ComposerState {
  let current = state;
  for (const char of text) current = press(current, char).state;
  return current;
}

describe('applyKey: inserting text', () => {
  it('inserts typed characters at the cursor', () => {
    expect(show(type(emptyComposer, 'hello'))).toBe('hello|');
    expect(show(press(at('he|llo'), 'X').state)).toBe('heX|llo');
  });

  it('inserts uppercase input reported with shift', () => {
    expect(show(press(at('a|'), 'B', { shift: true }).state)).toBe('aB|');
  });

  it('inserts a paste verbatim with CRLF and CR normalized, without submitting', () => {
    const result = press(at('x|y'), 'one\r\ntwo\rthree\n');
    expect(result.effect).toEqual({ type: 'none' });
    expect(show(result.state)).toBe('xone\ntwo\nthree\n|y');
  });

  it('keeps tabs but drops other control characters from pastes', () => {
    expect(show(press(at('|'), 'a\tb\u0007c\u001b').state)).toBe('a\tbc|');
  });

  it('ignores empty input from function keys', () => {
    const state = at('ab|');
    expect(press(state, '', { pageUp: true }).state).toBe(state);
    expect(press(state, '').state).toBe(state);
  });

  it('inserts surrogate pairs as a unit', () => {
    const state = press(at('a|b'), '😀').state;
    expect(show(state)).toBe('a😀|b');
    expect(state.cursor).toBe(3);
  });
});

describe('applyKey: Enter and newlines', () => {
  it('submits the right-trimmed text and resets the state', () => {
    const result = press(at('  fix the bug  \n\n|'), '\r', { return: true });
    expect(result.effect).toEqual({ type: 'submit', text: '  fix the bug' });
    expect(result.state).toEqual(emptyComposer);
  });

  it('submits from any cursor position', () => {
    expect(press(at('hel|lo'), '\r', { return: true }).effect).toEqual({
      type: 'submit',
      text: 'hello',
    });
  });

  it('does nothing for empty or whitespace-only input', () => {
    const state = at('   \n |');
    const result = press(state, '\r', { return: true });
    expect(result.effect).toEqual({ type: 'none' });
    expect(result.state).toBe(state);
  });

  it('turns a trailing backslash into a newline instead of submitting', () => {
    const result = press(at('first line\\|'), '\r', { return: true });
    expect(result.effect).toEqual({ type: 'none' });
    expect(show(result.state)).toBe('first line\n|');
  });

  it('only treats the backslash right before the cursor as a continuation', () => {
    const result = press(at('a\\b|'), '\r', { return: true });
    expect(result.effect).toEqual({ type: 'submit', text: 'a\\b' });
    expect(show(press(at('a\\|b'), '\r', { return: true }).state)).toBe('a\n|b');
  });

  it('inserts a newline for Alt+Enter, Shift+Enter and Ctrl+J', () => {
    expect(show(press(at('a|b'), '\r', { return: true, meta: true }).state)).toBe('a\n|b');
    expect(show(press(at('a|b'), '\r', { return: true, shift: true }).state)).toBe('a\n|b');
    const ctrlJ = press(at('a|b'), '\n');
    expect(ctrlJ.effect).toEqual({ type: 'none' });
    expect(show(ctrlJ.state)).toBe('a\n|b');
  });
});

describe('applyKey: deleting', () => {
  it('deletes the character before the cursor for Backspace and Delete', () => {
    expect(show(press(at('ab|c'), '', { backspace: true }).state)).toBe('a|c');
    expect(show(press(at('ab|c'), '', { delete: true }).state)).toBe('a|c');
  });

  it('does nothing at the start of the text', () => {
    const state = at('|abc');
    expect(press(state, '', { delete: true }).state).toBe(state);
  });

  it('joins lines when deleting a newline', () => {
    expect(show(press(at('ab\n|cd'), '', { delete: true }).state)).toBe('ab|cd');
  });

  it('deletes whole surrogate pairs and grapheme clusters', () => {
    expect(show(press(at('a😀|'), '', { delete: true }).state)).toBe('a|');
    const family = '👨‍👩‍👧';
    expect(show(press(at(`x${family}|`), '', { delete: true }).state)).toBe('x|');
    expect(show(press(at('café|'), '', { delete: true }).state)).toBe('caf|');
  });

  it('Ctrl+D deletes the character under the cursor when there is text', () => {
    const result = press(at('a|😀b'), 'd', { ctrl: true });
    expect(result.effect).toEqual({ type: 'none' });
    expect(show(result.state)).toBe('a|b');
    const atEnd = at('ab|');
    expect(press(atEnd, 'd', { ctrl: true }).state).toBe(atEnd);
  });

  it('Ctrl+D on empty input exits', () => {
    expect(press(emptyComposer, 'd', { ctrl: true }).effect).toEqual({ type: 'exit' });
  });

  it('Ctrl+W and Alt+Backspace delete the previous word', () => {
    expect(show(press(at('git commit -m|'), 'w', { ctrl: true }).state)).toBe('git commit -|');
    expect(show(press(at('git commit |'), 'w', { ctrl: true }).state)).toBe('git |');
    expect(show(press(at('git commit|'), '', { delete: true, meta: true }).state)).toBe('git |');
    expect(show(press(at('git commit|'), '', { backspace: true, meta: true }).state)).toBe('git |');
  });

  it('treats punctuation runs and words separately', () => {
    expect(show(press(at('src/auth.ts|'), 'w', { ctrl: true }).state)).toBe('src/auth.|');
    expect(show(press(at('src/auth.|'), 'w', { ctrl: true }).state)).toBe('src/auth|');
    expect(show(press(at('foo(); |'), 'w', { ctrl: true }).state)).toBe('foo|');
  });

  it('Ctrl+W at the start of a line removes only the newline', () => {
    expect(show(press(at('one two\n|three'), 'w', { ctrl: true }).state)).toBe('one two|three');
  });

  it('Ctrl+U deletes to the start of the line', () => {
    expect(show(press(at('one\ntwo th|ree'), 'u', { ctrl: true }).state)).toBe('one\n|ree');
    expect(show(press(at('one\n|two'), 'u', { ctrl: true }).state)).toBe('one|two');
    const start = at('|abc');
    expect(press(start, 'u', { ctrl: true }).state).toBe(start);
  });

  it('Ctrl+K deletes to the end of the line', () => {
    expect(show(press(at('one t|wo\nthree'), 'k', { ctrl: true }).state)).toBe('one t|\nthree');
    expect(show(press(at('one|\ntwo'), 'k', { ctrl: true }).state)).toBe('one|two');
    const end = at('abc|');
    expect(press(end, 'k', { ctrl: true }).state).toBe(end);
  });
});

describe('applyKey: cursor movement', () => {
  it('moves left and right by grapheme', () => {
    expect(show(press(at('ab|c'), '', { leftArrow: true }).state)).toBe('a|bc');
    expect(show(press(at('ab|c'), '', { rightArrow: true }).state)).toBe('abc|');
    expect(show(press(at('a😀|b'), '', { leftArrow: true }).state)).toBe('a|😀b');
    expect(show(press(at('a|😀b'), '', { rightArrow: true }).state)).toBe('a😀|b');
  });

  it('stays put at the edges', () => {
    const start = at('|ab');
    const end = at('ab|');
    expect(press(start, '', { leftArrow: true }).state).toBe(start);
    expect(press(end, '', { rightArrow: true }).state).toBe(end);
  });

  it('moves word-wise with Alt or Ctrl arrows and Alt+B/Alt+F', () => {
    expect(show(press(at('one two|'), '', { leftArrow: true, meta: true }).state)).toBe('one |two');
    expect(show(press(at('one |two'), '', { leftArrow: true, ctrl: true }).state)).toBe('|one two');
    expect(show(press(at('|one two'), '', { rightArrow: true, meta: true }).state)).toBe(
      'one| two',
    );
    expect(show(press(at('one| two'), 'f', { meta: true }).state)).toBe('one two|');
    expect(show(press(at('one two|'), 'b', { meta: true }).state)).toBe('one |two');
  });

  it('word motions stop at line breaks', () => {
    expect(show(press(at('one\n|two'), 'b', { meta: true }).state)).toBe('one|\ntwo');
    expect(show(press(at('one|\ntwo'), 'f', { meta: true }).state)).toBe('one\n|two');
  });

  it('Home/End and Ctrl+A/Ctrl+E work on the current line', () => {
    const state = at('first\nsec|ond\nthird');
    expect(show(press(state, '', { home: true }).state)).toBe('first\n|second\nthird');
    expect(show(press(state, '', { end: true }).state)).toBe('first\nsecond|\nthird');
    expect(show(press(state, 'a', { ctrl: true }).state)).toBe('first\n|second\nthird');
    expect(show(press(state, 'e', { ctrl: true }).state)).toBe('first\nsecond|\nthird');
  });

  it('Up/Down move between lines keeping the column', () => {
    expect(show(press(at('abcdef\nab|c'), '', { upArrow: true }).state)).toBe('ab|cdef\nabc');
    expect(show(press(at('ab|cdef\nabc'), '', { downArrow: true }).state)).toBe('abcdef\nab|c');
  });

  it('clamps the column to shorter lines', () => {
    expect(show(press(at('ab\nabcdef|'), '', { upArrow: true }).state)).toBe('ab|\nabcdef');
    expect(show(press(at('abcdef|\n\nx'), '', { downArrow: true }).state)).toBe('abcdef\n|\nx');
  });

  it('matches display columns across wide characters', () => {
    // "日本" is four columns wide; column 2 falls after the first character.
    expect(show(press(at('日本語\nab|cd'), '', { upArrow: true }).state)).toBe('日|本語\nabcd');
  });

  it('Up on the first line without history moves to the start; Down on the last moves to the end', () => {
    expect(show(press(at('ab|c'), '', { upArrow: true }).state)).toBe('|abc');
    expect(show(press(at('a|bc'), '', { downArrow: true }).state)).toBe('abc|');
  });
});

describe('applyKey: history', () => {
  const history = ['third prompt', 'second\nprompt', 'first prompt'];
  const options: ComposerOptions = { history };
  const up = (state: ComposerState) => press(state, '', { upArrow: true }, options).state;
  const down = (state: ComposerState) => press(state, '', { downArrow: true }, options).state;

  it('recalls older entries on Up and saves the draft', () => {
    const first = up(at('my dra|ft'));
    expect(first).toEqual({ text: 'third prompt', cursor: 12, historyIndex: 0, draft: 'my draft' });
    // A recalled multi-line entry puts the cursor at its end; Up then moves inside it first.
    const second = up(first);
    expect(show(second)).toBe('second\nprompt|');
    expect(second.historyIndex).toBe(1);
    const insideEntry = up(second);
    expect(show(insideEntry)).toBe('second|\nprompt');
    expect(insideEntry.historyIndex).toBe(1);
    const third = up(insideEntry);
    expect(third.text).toBe('first prompt');
    expect(third.draft).toBe('my draft');
  });

  it('stops at the oldest entry', () => {
    let state = at('|');
    for (let i = 0; i < 5; i++) state = up(state);
    expect(state.text).toBe('first prompt');
    expect(state.historyIndex).toBe(2);
    expect(state.cursor).toBe(0);
  });

  it('Down walks back toward newer entries and finally restores the draft', () => {
    let state = up(up(at('draft|')));
    expect(state.historyIndex).toBe(1);
    // The recalled entry has two lines and the cursor is on the last: Down goes newer.
    state = down(state);
    expect(state).toEqual({ text: 'third prompt', cursor: 12, historyIndex: 0, draft: 'draft' });
    state = down(state);
    expect(state).toEqual({ text: 'draft', cursor: 5, historyIndex: null, draft: '' });
  });

  it('keeps browsing from an edited entry', () => {
    let state = up(at('|'));
    state = type(state, '!');
    expect(state.text).toBe('third prompt!');
    expect(state.historyIndex).toBe(0);
    state = down(state);
    expect(state).toEqual({ text: '', cursor: 0, historyIndex: null, draft: '' });
  });

  it('reports menu navigation instead of moving when a menu is open', () => {
    const state = at('/co|');
    const menu: ComposerOptions = { history, menuOpen: true };
    expect(press(state, '', { upArrow: true }, menu)).toEqual({
      state,
      effect: { type: 'menu-up' },
    });
    expect(press(state, '', { downArrow: true }, menu)).toEqual({
      state,
      effect: { type: 'menu-down' },
    });
  });
});

describe('applyKey: effects', () => {
  const state = at('some text|');

  it.each([
    ['c', 'interrupt'],
    ['l', 'clear-screen'],
    ['o', 'expand'],
  ])('Ctrl+%s reports %s without editing', (input, type) => {
    expect(press(state, input, { ctrl: true })).toEqual({ state, effect: { type } });
  });

  it('reports Esc, Tab and Shift+Tab (which cycles the permission mode)', () => {
    expect(press(state, '', { escape: true, meta: true }).effect).toEqual({ type: 'escape' });
    expect(press(state, '', { tab: true })).toEqual({ state, effect: { type: 'tab' } });
    expect(press(state, '', { tab: true, shift: true })).toEqual({
      state,
      effect: { type: 'cycle-mode' },
    });
  });

  it('ignores unknown control and meta combinations', () => {
    expect(press(state, 'x', { ctrl: true })).toEqual({ state, effect: { type: 'none' } });
    expect(press(state, 'z', { meta: true })).toEqual({ state, effect: { type: 'none' } });
  });
});

describe('setText and cursorPosition', () => {
  it('setText puts the cursor at the end and leaves history browsing', () => {
    expect(setText('/compact ')).toEqual({
      text: '/compact ',
      cursor: 9,
      historyIndex: null,
      draft: '',
    });
  });

  it('cursorPosition reports the line and column', () => {
    expect(cursorPosition(at('ab\ncd|e'))).toEqual({ line: 1, column: 2 });
    expect(cursorPosition(at('|'))).toEqual({ line: 0, column: 0 });
  });
});
