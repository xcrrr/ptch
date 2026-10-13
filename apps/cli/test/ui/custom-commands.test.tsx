import { render } from 'ink-testing-library';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyComposer } from '../../src/ui/composer-state.js';
import { Composer } from '../../src/ui/components/Composer.js';
import { TranscriptItemView } from '../../src/ui/components/TranscriptItemView.js';
import type { SlashCommandInfo } from '../../src/ui/components/props.js';
import { keys, plainFrame, plainLines, sgr, tick, withColors } from './helpers.js';

const commands: SlashCommandInfo[] = [
  { name: 'help', description: 'Show commands and keys' },
  { name: 'review', description: 'Review the diff', args: '[path]', tag: 'project' },
  { name: 'standup', description: 'Summarize yesterday', tag: 'user' },
];

function Harness({ onMenuOpen }: { onMenuOpen: () => void }) {
  const [state, setState] = useState(emptyComposer);
  return (
    <Composer
      state={state}
      onChange={setState}
      onSubmit={() => {}}
      onEffect={() => {}}
      onMenuOpen={onMenuOpen}
      history={[]}
      commands={commands}
      isActive
      width={70}
    />
  );
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe('slash menu with custom commands', () => {
  it('shows a custom command with its argument hint and a tag', async () => {
    let opened = 0;
    const instance = render(<Harness onMenuOpen={() => opened++} />);
    cleanup = instance.unmount;
    await tick();
    for (const input of ['/', 'r', 'e']) {
      instance.stdin.write(input);
      await tick(15);
    }
    const frame = plainFrame(instance.lastFrame());
    expect(frame).toMatch(/\/review \[path\]\s+Review the diff \(project\)/);
    expect(opened).toBe(1);
  });

  it('reports each time the menu opens', async () => {
    let opened = 0;
    const instance = render(<Harness onMenuOpen={() => opened++} />);
    cleanup = instance.unmount;
    await tick();
    for (const input of ['/', 's', keys.backspace, keys.backspace, '/', 's', ' ', 'x']) {
      instance.stdin.write(input);
      await tick(15);
    }
    expect(opened).toBe(2);
    expect(plainFrame(instance.lastFrame())).not.toContain('Summarize yesterday');
  });
});

describe('a custom command in the transcript', () => {
  withColors();

  it('shows what was typed with the command file dim below', () => {
    const { lastFrame, unmount } = render(
      <TranscriptItemView
        item={{
          kind: 'user',
          id: 'u1',
          text: '/review src/auth',
          source: '.patch/commands/review.md',
        }}
        width={60}
      />,
    );
    const frame = lastFrame() ?? '';
    unmount();
    expect(plainLines(frame)).toEqual(['', '› /review src/auth', '  .patch/commands/review.md']);
    expect(frame.split('\n').at(-1)).toContain(sgr.dim);
  });
});
