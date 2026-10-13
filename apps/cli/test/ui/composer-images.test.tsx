import type { Key } from 'ink';
import { render } from 'ink-testing-library';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImageAttachment } from '../../src/images.js';
import {
  applyKey,
  attachImage,
  attachmentsInText,
  emptyComposer,
  insertText,
  setText,
  takeAttachments,
  type ComposerEffect,
  type ComposerState,
} from '../../src/ui/composer-state.js';
import { Composer, composerHeight } from '../../src/ui/components/Composer.js';
import { keys, plainLines, tick } from './helpers.js';

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

function press(state: ComposerState, input: string, overrides: Partial<Key> = {}) {
  return applyKey(state, input, key(overrides), { history: ['an older prompt'] });
}

function image(name: string): ImageAttachment {
  return {
    image: { type: 'image', mediaType: 'image/png', data: `${name}-data`, label: name },
    description: `${name} · 1280×720 · 84 KB`,
  };
}

const A = image('a.png');
const B = image('b.png');

describe('attachments in the composer state', () => {
  it('inserts a token at the cursor, spaced from the text around it', () => {
    const typed = setText('look at');
    const one = attachImage(typed, A);
    expect(one.text).toBe('look at [Image #1] ');
    expect(one.cursor).toBe(one.text.length);
    expect(one.attachments).toEqual([{ ...A, id: 1 }]);

    const two = attachImage({ ...one, cursor: 0 }, B);
    expect(two.text).toBe('[Image #2] look at [Image #1] ');
    expect(attachmentsInText(two).map((a) => a.id)).toEqual([2, 1]);
  });

  it('removes a token and its image with one backspace', () => {
    const state = attachImage(attachImage(setText('compare'), A), B);
    // "compare [Image #1] [Image #2] |"
    const afterSpace = press(state, '', { backspace: true }).state;
    expect(afterSpace.text).toBe('compare [Image #1] [Image #2]');
    const removed = press(afterSpace, '', { backspace: true }).state;
    expect(removed.text).toBe('compare [Image #1] ');
    expect(removed.attachments?.map((a) => a.id)).toEqual([1]);
    // Typing goes on as usual afterwards.
    expect(press(removed, '', { backspace: true }).state.text).toBe('compare [Image #1]');
  });

  it('deletes token text without an attachment one character at a time', () => {
    const state = setText('[Image #1]');
    expect(press(state, '', { backspace: true }).state.text).toBe('[Image #1');
  });

  it('keeps an image whose token is still in the text elsewhere', () => {
    const state = attachImage(setText(''), A);
    const doubled = insertText(state, '[Image #1]');
    const next = press(doubled, '', { backspace: true }).state;
    expect(next.text).toBe('[Image #1] ');
    expect(next.attachments).toHaveLength(1);
  });

  it('submits the images whose tokens are in the text, renumbered in order', () => {
    let state = attachImage(attachImage(attachImage(setText('x'), A), B), image('c.png'));
    // Remove "[Image #1]" by editing the text directly: its image is left behind, unsent.
    state = setTextKeeping(state, 'second [Image #3] then [Image #2] ');
    const { effect, state: after } = press(state, '', { return: true });
    expect(effect).toEqual({
      type: 'submit',
      text: 'second [Image #1] then [Image #2]',
      images: [image('c.png'), B],
    });
    expect(after).toEqual(emptyComposer);
    expect(takeAttachments(setText('plain [Image #9]'))).toEqual({
      text: 'plain [Image #9]',
      images: [],
    });
  });

  it('submits plain text without an images field', () => {
    expect(press(setText('hello'), '', { return: true }).effect).toEqual({
      type: 'submit',
      text: 'hello',
    });
  });

  it('asks for a clipboard image on Alt+V and Ctrl+V without editing', () => {
    const state = setText('abc');
    for (const modifier of [{ meta: true }, { ctrl: true }]) {
      const result = press(state, 'v', modifier);
      expect(result.effect).toEqual({ type: 'paste-image' });
      expect(result.state).toBe(state);
    }
  });

  it('keeps the draft attachments while browsing history', () => {
    const draft = attachImage(setText('draft'), A);
    const browsing = press({ ...draft, cursor: 0 }, '', { upArrow: true }).state;
    expect(browsing.text).toBe('an older prompt');
    expect(attachmentsInText(browsing)).toEqual([]);
    const back = press(browsing, '', { downArrow: true }).state;
    expect(back.text).toBe('draft [Image #1] ');
    expect(attachmentsInText(back)).toEqual([{ ...A, id: 1 }]);
  });
});

/** Replaces the text while keeping the attachments (as editing keys would). */
function setTextKeeping(state: ComposerState, text: string): ComposerState {
  return { ...state, text, cursor: text.length };
}

const commands = [{ name: 'help', description: 'Show commands and keys' }];

interface HarnessProps {
  initial?: ComposerState;
  onSubmit?: (text: string, images?: ImageAttachment[]) => void;
  onEffect?: (effect: ComposerEffect) => void;
  onPastePath?: (path: string, raw: string) => void;
  onState?: (state: ComposerState) => void;
}

function Harness({
  initial = emptyComposer,
  onSubmit,
  onEffect,
  onPastePath,
  onState,
}: HarnessProps) {
  const [state, setState] = useState(initial);
  return (
    <Composer
      state={state}
      onChange={(next) => {
        onState?.(next);
        setState(next);
      }}
      onSubmit={onSubmit ?? (() => {})}
      onEffect={onEffect ?? (() => {})}
      onPastePath={onPastePath}
      history={[]}
      commands={commands}
      isActive
      width={60}
    />
  );
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe('Composer with images', () => {
  it('hands a pasted image path to the owner instead of inserting it', async () => {
    const onPastePath = vi.fn();
    const onState = vi.fn();
    const view = render(<Harness onPastePath={onPastePath} onState={onState} />);
    cleanup = view.unmount;
    await tick();
    view.stdin.write('"/home/me/Screen Shot.png"');
    await tick();
    expect(onPastePath).toHaveBeenCalledWith(
      '/home/me/Screen Shot.png',
      '"/home/me/Screen Shot.png"',
    );
    expect(onState).not.toHaveBeenCalled();
  });

  it('inserts other pastes, and typed paths, as text', async () => {
    const onPastePath = vi.fn();
    const view = render(<Harness onPastePath={onPastePath} />);
    cleanup = view.unmount;
    await tick();
    view.stdin.write('src/app.ts');
    await tick();
    for (const char of ' a.png') {
      view.stdin.write(char);
      await tick(5);
    }
    expect(onPastePath).not.toHaveBeenCalled();
    expect(plainLines(view.lastFrame())[0]).toBe('› src/app.ts a.png');
  });

  it('lists the attachments under the text and submits them', async () => {
    const onSubmit = vi.fn();
    const initial = attachImage(attachImage(setText('compare'), A), B);
    const view = render(<Harness initial={initial} onSubmit={onSubmit} />);
    cleanup = view.unmount;
    await tick();
    expect(plainLines(view.lastFrame())).toEqual([
      '› compare [Image #1] [Image #2]',
      '  [Image #1] a.png · 1280×720 · 84 KB',
      '  [Image #2] b.png · 1280×720 · 84 KB',
    ]);
    view.stdin.write(keys.backspace);
    await tick();
    view.stdin.write(keys.backspace);
    await tick();
    expect(plainLines(view.lastFrame())).toEqual([
      '› compare [Image #1]',
      '  [Image #1] a.png · 1280×720 · 84 KB',
    ]);
    view.stdin.write(keys.enter);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('compare [Image #1]', [A]);
  });

  it('asks the owner for a clipboard image on Alt+V', async () => {
    const onEffect = vi.fn();
    const view = render(<Harness onEffect={onEffect} />);
    cleanup = view.unmount;
    await tick();
    view.stdin.write('\u001bv');
    await tick(50);
    expect(onEffect).toHaveBeenCalledWith({ type: 'paste-image' });
  });

  it('counts the attachment lines in its height, within the row budget', () => {
    let state = setText('many');
    for (const name of ['a', 'b', 'c', 'd', 'e']) state = attachImage(state, image(`${name}.png`));
    for (const maxRows of [undefined, 6, 3, 2, 1]) {
      const { lastFrame, unmount } = render(
        <Composer
          state={state}
          onChange={() => {}}
          onSubmit={() => {}}
          onEffect={() => {}}
          history={[]}
          commands={commands}
          isActive
          width={60}
          maxRows={maxRows}
        />,
      );
      const lines = plainLines(lastFrame());
      unmount();
      expect(lines.length).toBe(
        composerHeight({ state, width: 60, commands, isActive: true, maxRows }),
      );
      // Like text alone, the text may need a row and two "more lines" indicators.
      if (maxRows !== undefined) expect(lines.length).toBeLessThanOrEqual(Math.max(maxRows, 3));
      if (maxRows === undefined || maxRows >= 4) {
        expect(lines.slice(-3)).toEqual([
          '  [Image #1] a.png · 1280×720 · 84 KB',
          '  [Image #2] b.png · 1280×720 · 84 KB',
          '  + 3 more images',
        ]);
      }
    }
  });
});
