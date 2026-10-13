import { render } from 'ink-testing-library';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyComposer,
  setText,
  type ComposerEffect,
  type ComposerState,
} from '../../src/ui/composer-state.js';
import { Composer, composerHeight, matchSlashCommands } from '../../src/ui/components/Composer.js';
import type { SlashCommandInfo } from '../../src/ui/components/props.js';
import { keys, plainFrame, plainLines, sgr, tick, withColors } from './helpers.js';

const commands: SlashCommandInfo[] = [
  { name: 'help', description: 'Show commands and keys' },
  { name: 'compact', description: 'Summarize the conversation', args: '[instructions]' },
  { name: 'clear', description: 'Start a new conversation', aliases: ['reset'] },
  { name: 'config', description: 'Show configuration' },
  { name: 'cost', description: 'Show token usage and cost' },
  { name: 'diff', description: 'Show uncommitted changes' },
  { name: 'model', description: 'Switch the model' },
  { name: 'resume', description: 'Resume a previous session', aliases: ['continue'] },
];

interface HarnessProps {
  initial?: ComposerState;
  onSubmit?: (text: string) => void;
  onEffect?: (effect: ComposerEffect) => void;
  onState?: (state: ComposerState) => void;
  history?: string[];
  isActive?: boolean;
  width?: number;
  busy?: boolean;
  placeholder?: string;
}

function Harness({
  initial = emptyComposer,
  onSubmit = () => {},
  onEffect = () => {},
  onState = () => {},
  history = [],
  isActive = true,
  width = 60,
  busy,
  placeholder,
}: HarnessProps) {
  const [state, setState] = useState(initial);
  return (
    <Composer
      state={state}
      onChange={(next) => {
        onState(next);
        setState(next);
      }}
      onSubmit={onSubmit}
      onEffect={onEffect}
      history={history}
      commands={commands}
      isActive={isActive}
      width={width}
      busy={busy}
      placeholder={placeholder}
    />
  );
}

async function setup(props: HarnessProps = {}) {
  const instance = render(<Harness {...props} />);
  await tick();
  const type = async (...inputs: string[]) => {
    for (const input of inputs) {
      instance.stdin.write(input);
      await tick(input === keys.escape ? 50 : 15);
    }
  };
  return { ...instance, type, text: () => plainFrame(instance.lastFrame()) };
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe('Composer rendering', () => {
  it('shows the prompt marker and a dim placeholder when empty', async () => {
    const view = await setup({ placeholder: 'Ask Patch anything' });
    cleanup = view.unmount;
    expect(view.text()).toBe('› Ask Patch anything');
  });

  it('renders text after the marker and continuation lines aligned under it', async () => {
    const view = await setup({ initial: setText('first line\nsecond line') });
    cleanup = view.unmount;
    expect(plainLines(view.lastFrame())).toEqual(['› first line', '  second line']);
  });

  it('wraps long lines at spaces within the width', async () => {
    const view = await setup({ initial: setText('alpha beta gamma delta epsilon'), width: 20 });
    cleanup = view.unmount;
    expect(plainLines(view.lastFrame())).toEqual(['› alpha beta gamma', '  delta epsilon']);
  });

  it('breaks words that are longer than the row', async () => {
    const view = await setup({ initial: setText('x'.repeat(30)), width: 12, isActive: false });
    cleanup = view.unmount;
    expect(plainLines(view.lastFrame())).toEqual([
      `› ${'x'.repeat(10)}`,
      `  ${'x'.repeat(10)}`,
      `  ${'x'.repeat(10)}`,
    ]);
  });

  it('puts an end-of-line cursor on its own row when the last row is full', async () => {
    const view = await setup({ initial: setText('x'.repeat(20)), width: 12 });
    cleanup = view.unmount;
    expect(plainLines(view.lastFrame())).toEqual([
      `› ${'x'.repeat(10)}`,
      `  ${'x'.repeat(10)}`,
      '',
    ]);
  });

  it('switches to the shell marker for "!" input', async () => {
    const view = await setup({ initial: setText('!git status') });
    cleanup = view.unmount;
    expect(view.text()).toBe('! git status');
  });

  it('scrolls very tall input around the cursor', async () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    const view = await setup({ initial: setText(text) });
    cleanup = view.unmount;
    const lines = plainLines(view.lastFrame());
    expect(lines.length).toBeLessThanOrEqual(18);
    expect(lines[0]).toMatch(/^› ↑ \d+ more lines$/);
    expect(lines[lines.length - 1]).toBe('  line 40');
  });

  describe('with colors', () => {
    withColors();

    it('draws the cursor in inverse video at its position', async () => {
      const view = await setup({ initial: { ...setText('abc'), cursor: 1 } });
      cleanup = view.unmount;
      expect(view.lastFrame()).toContain(`a${sgr.inverse}b`);
    });

    it('draws an inverse space when the cursor is at the end', async () => {
      const view = await setup({ initial: setText('abc') });
      cleanup = view.unmount;
      expect(view.lastFrame()).toContain(`abc${sgr.inverse} `);
    });

    it('marks the first placeholder character as the cursor', async () => {
      const view = await setup({ placeholder: 'Ask' });
      cleanup = view.unmount;
      expect(view.lastFrame()).toContain(`${sgr.inverse}A`);
    });

    it('hides the cursor when inactive', async () => {
      const view = await setup({ initial: setText('abc'), isActive: false });
      cleanup = view.unmount;
      expect(view.lastFrame()).not.toContain(sgr.inverse);
    });

    it('uses the accent marker normally, warning in shell mode and dim when busy', async () => {
      const normal = await setup({ initial: setText('hi') });
      expect(normal.lastFrame()).toContain(`${sgr.green}›`);
      normal.unmount();
      const shell = await setup({ initial: setText('!ls') });
      expect(shell.lastFrame()).toContain(`${sgr.yellow}!`);
      shell.unmount();
      expect(normal.lastFrame()?.split('›')[0]).not.toContain(sgr.dim);
      const busy = await setup({ initial: setText('hi'), busy: true });
      cleanup = busy.unmount;
      expect(busy.lastFrame()?.split('›')[0]).toContain(sgr.dim);
    });
  });
});

describe('Composer editing', () => {
  it('edits through onChange and submits on Enter', async () => {
    const onSubmit = vi.fn();
    const view = await setup({ onSubmit });
    cleanup = view.unmount;
    await view.type('h', 'e', 'l', 'l', 'o', keys.backspace, keys.backspace, 'p');
    expect(view.text()).toBe('› help');
    await view.type(keys.left, keys.left, 'X');
    expect(view.text()).toBe('› heXlp');
    await view.type(keys.enter);
    expect(onSubmit).toHaveBeenCalledWith('heXlp');
    expect(view.text()).toBe('›');
  });

  it('keeps every key when several arrive before a re-render', async () => {
    const onSubmit = vi.fn();
    const view = await setup({ onSubmit });
    cleanup = view.unmount;
    for (const char of 'quick') view.stdin.write(char);
    view.stdin.write(keys.enter);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('quick');
  });

  it('inserts pastes verbatim and adds newlines with Ctrl+J and Alt+Enter', async () => {
    const onSubmit = vi.fn();
    const view = await setup({ onSubmit });
    cleanup = view.unmount;
    await view.type('pasted\r\ntext', keys.ctrlJ, 'more', keys.altEnter, 'end');
    expect(plainLines(view.lastFrame())).toEqual(['› pasted', '  text', '  more', '  end']);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('continues onto a new line after a trailing backslash', async () => {
    const onSubmit = vi.fn();
    const view = await setup({ onSubmit });
    cleanup = view.unmount;
    await view.type('one\\', keys.enter, 'two', keys.enter);
    expect(onSubmit).toHaveBeenCalledWith('one\ntwo');
  });

  it('recalls history with Up and restores the draft with Down', async () => {
    const view = await setup({ history: ['latest prompt', 'older prompt'] });
    cleanup = view.unmount;
    await view.type('draft', keys.up);
    expect(view.text()).toBe('› latest prompt');
    await view.type(keys.up);
    expect(view.text()).toBe('› older prompt');
    await view.type(keys.down, keys.down);
    expect(view.text()).toBe('› draft');
  });

  it('forwards non-editing effects to the owner', async () => {
    const onEffect = vi.fn();
    const view = await setup({ onEffect, initial: setText('text') });
    cleanup = view.unmount;
    await view.type(keys.ctrlC, keys.ctrlO, keys.escape);
    expect(onEffect.mock.calls.map(([effect]) => effect.type)).toEqual([
      'interrupt',
      'expand',
      'escape',
    ]);
  });

  it('reports exit for Ctrl+D on empty input', async () => {
    const onEffect = vi.fn();
    const view = await setup({ onEffect });
    cleanup = view.unmount;
    await view.type(keys.ctrlD);
    expect(onEffect).toHaveBeenCalledWith({ type: 'exit' });
  });

  it('ignores input while inactive', async () => {
    const onState = vi.fn();
    const view = await setup({ onState, isActive: false });
    cleanup = view.unmount;
    await view.type('abc', keys.enter);
    expect(onState).not.toHaveBeenCalled();
  });
});

describe('slash command menu', () => {
  it('matches by name prefix, then alias prefix, then substring', () => {
    expect(matchSlashCommands('/co', commands)?.map((c) => c.name)).toEqual([
      'compact',
      'config',
      'cost',
      'resume',
    ]);
    expect(matchSlashCommands('/reset', commands)?.map((c) => c.name)).toEqual(['clear']);
    expect(matchSlashCommands('/ff', commands)?.map((c) => c.name)).toEqual(['diff']);
    expect(matchSlashCommands('/zzz', commands)).toEqual([]);
    expect(matchSlashCommands('/co x', commands)).toBeNull();
    expect(matchSlashCommands('co', commands)).toBeNull();
  });

  it('shows up to six commands with descriptions while typing a command', async () => {
    const view = await setup();
    cleanup = view.unmount;
    await view.type('/');
    const lines = plainLines(view.lastFrame());
    expect(lines[0]).toBe('› /');
    expect(lines).toHaveLength(7);
    expect(lines[1]).toBe('  /help                    Show commands and keys');
    expect(lines[2]).toBe('  /compact [instructions]  Summarize the conversation');
  });

  it('filters as the name is typed and hides once arguments start', async () => {
    const view = await setup();
    cleanup = view.unmount;
    await view.type('/co');
    expect(
      plainLines(view.lastFrame())
        .slice(1)
        .map((line) => line.trim().split(/\s+/)[0]),
    ).toEqual(['/compact', '/config', '/cost', '/resume']);
    await view.type('mpact now');
    expect(view.text()).toBe('› /compact now');
  });

  it('says when nothing matches and submits the text as typed', async () => {
    const onSubmit = vi.fn();
    const view = await setup({ onSubmit });
    cleanup = view.unmount;
    await view.type('/usr/bin');
    expect(plainLines(view.lastFrame())).toEqual(['› /usr/bin', '  No matching commands']);
    await view.type(keys.enter);
    expect(onSubmit).toHaveBeenCalledWith('/usr/bin');
  });

  it('completes the highlighted command with Tab', async () => {
    const view = await setup();
    cleanup = view.unmount;
    await view.type('/con', keys.tab);
    expect(view.text()).toBe('› /config');
    await view.type('x');
    expect(view.text()).toBe('› /config x');
  });

  it('moves the highlight with Up/Down (wrapping) and runs it with Enter', async () => {
    const onSubmit = vi.fn();
    const view = await setup({ onSubmit });
    cleanup = view.unmount;
    await view.type('/co', keys.down, keys.down);
    await view.type(keys.enter);
    expect(onSubmit).toHaveBeenCalledWith('/cost');
    expect(view.text()).toBe('›');
    await view.type('/co', keys.up, keys.enter);
    expect(onSubmit).toHaveBeenLastCalledWith('/resume');
  });

  it('resets the highlight when the query changes', async () => {
    const onSubmit = vi.fn();
    const view = await setup({ onSubmit });
    cleanup = view.unmount;
    await view.type('/c', keys.down, 'o', keys.enter);
    expect(onSubmit).toHaveBeenCalledWith('/compact');
  });

  it('runs an exactly typed command or alias as typed', async () => {
    const onSubmit = vi.fn();
    const view = await setup({ onSubmit });
    cleanup = view.unmount;
    await view.type('/cost', keys.enter);
    expect(onSubmit).toHaveBeenCalledWith('/cost');
    await view.type('/reset', keys.enter);
    expect(onSubmit).toHaveBeenLastCalledWith('/reset');
  });

  describe('with colors', () => {
    withColors();

    it('highlights the selected command in the accent color', async () => {
      const view = await setup();
      cleanup = view.unmount;
      await view.type('/co', keys.down);
      const config = view
        .lastFrame()
        ?.split('\n')
        .find((line) => line.includes('/config'));
      expect(config).toContain(sgr.green);
      const compact = view
        .lastFrame()
        ?.split('\n')
        .find((line) => line.includes('/compact'));
      expect(compact).not.toContain(sgr.green);
    });
  });
});

describe('composerHeight', () => {
  const tall = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  const cases: Array<[string, ComposerState, number | undefined]> = [
    ['empty', emptyComposer, undefined],
    ['one line', setText('hello'), undefined],
    ['a long wrapped line', setText('word '.repeat(40)), undefined],
    ['tall text', setText(tall), undefined],
    ['tall text in 10 rows', setText(tall), 10],
    ['tall text in 3 rows', setText(tall), 3],
    ['tall text in 1 row', setText(tall), 1],
    ['a slash menu', setText('/c'), undefined],
    ['a slash menu in 3 rows', setText('/c'), 3],
    ['no matching command', setText('/zzz'), 2],
  ];

  it.each(cases)('matches the rendered rows for %s', (_, state, maxRows) => {
    const { lastFrame, unmount } = render(
      <Composer
        state={state}
        onChange={() => {}}
        onSubmit={() => {}}
        onEffect={() => {}}
        history={[]}
        commands={commands}
        isActive
        width={40}
        maxRows={maxRows}
      />,
    );
    const rows = plainLines(lastFrame()).length;
    unmount();
    expect(rows).toBe(composerHeight({ state, width: 40, commands, isActive: true, maxRows }));
    if (maxRows !== undefined) expect(rows).toBeLessThanOrEqual(Math.max(maxRows, 3));
  });
});
