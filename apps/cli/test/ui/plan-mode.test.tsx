import type { PlanReviewRequest } from '@patch/core';
import { render } from 'ink-testing-library';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyComposer, type ComposerEffect } from '../../src/ui/composer-state.js';
import { Composer } from '../../src/ui/components/Composer.js';
import { Footer } from '../../src/ui/components/Footer.js';
import { PlanPrompt, layoutPlanPrompt } from '../../src/ui/components/PlanPrompt.js';
import { TranscriptItemView } from '../../src/ui/components/TranscriptItemView.js';
import { permissionModeAccent } from '../../src/ui/permission-mode.js';
import { theme } from '../../src/ui/theme.js';
import { keys, plainFrame, plainLines, sgr, tick, withColors } from './helpers.js';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function mount(element: React.ReactElement) {
  const instance = render(element);
  cleanup = instance.unmount;
  await tick();
  const type = async (...inputs: string[]) => {
    for (const input of inputs) {
      instance.stdin.write(input);
      await tick(input === keys.escape ? 50 : 15);
    }
  };
  return { ...instance, type, text: () => plainFrame(instance.lastFrame()) };
}

function frameOf(element: React.ReactElement): string {
  const { lastFrame, unmount } = render(element);
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

const SHIFT_TAB = '\u001b[Z';
const PLAN = '## Cache the config\n\n1. Read it once in `src/config.ts`.\n2. Run the tests.';
const request: PlanReviewRequest = { id: 'plan1', plan: PLAN };

describe('the footer in a permission mode', () => {
  it('leads with the mode, then the hints, with the status on the right', () => {
    const accent = permissionModeAccent('plan');
    const [line] = plainLines(
      frameOf(
        <Footer left="shift+tab to change" right="main · 3% context" width={70} accent={accent} />,
      ),
    );
    expect(line).toBe(`  ⏸ plan mode · shift+tab to change${' '.repeat(17)}main · 3% context`);
    expect(line).toHaveLength(69);
    expect(permissionModeAccent('acceptEdits')?.text).toBe('⏵⏵ accepting edits');
    expect(permissionModeAccent('default')).toBeUndefined();
  });

  it('gives up the hints, then the mode, before the status', () => {
    const accent = permissionModeAccent('plan');
    const line = (width: number) =>
      plainLines(
        frameOf(
          <Footer left="shift+tab to change" right="3% context" width={width} accent={accent} />,
        ),
      )[0];
    expect(line(36)).toBe('  ⏸ plan mode · shift+…  3% context');
    expect(line(26)).toBe('  ⏸ plan mode  3% context');
    expect(line(20)).toBe('  ⏸ pl…  3% context');
  });

  describe('with colors', () => {
    withColors();

    it('colors the mode and dims the rest', () => {
      const frame = frameOf(
        <Footer
          left="shift+tab to change"
          right="3% context"
          width={60}
          accent={permissionModeAccent('acceptEdits')}
        />,
      );
      expect(theme.acceptEdits).toBe('magenta');
      expect(frame).toContain('\u001b[35m⏵⏵ accepting edits\u001b[39m');
      expect(frame).toContain(`${sgr.dim} · shift+tab to change`);
      const plan = frameOf(
        <Footer left="" right="" width={60} accent={permissionModeAccent('plan')} />,
      );
      expect(plan).toContain(`${sgr.cyan}⏸ plan mode`);
    });
  });
});

describe('Shift+Tab in the composer', () => {
  function Harness({ onEffect }: { onEffect: (effect: ComposerEffect) => void }) {
    const [state, setState] = useState(emptyComposer);
    return (
      <Composer
        state={state}
        onChange={setState}
        onSubmit={() => {}}
        onEffect={onEffect}
        history={[]}
        commands={[{ name: 'plan', description: 'Turn plan mode on or off' }]}
        isActive
        width={60}
      />
    );
  }

  it('asks to cycle the mode, also while the slash menu is open, and edits nothing', async () => {
    const onEffect = vi.fn();
    const view = await mount(<Harness onEffect={onEffect} />);
    await view.type(SHIFT_TAB);
    await view.type('/pl', SHIFT_TAB);
    expect(onEffect.mock.calls.map(([effect]) => effect)).toEqual([
      { type: 'cycle-mode' },
      { type: 'cycle-mode' },
    ]);
    // Not completed to "/plan ".
    expect(view.text().split('\n')[0]).toBe('› /pl');
  });
});

describe('PlanPrompt', () => {
  it('shows the plan in a frame and the three choices', async () => {
    const view = await mount(<PlanPrompt request={request} onRespond={() => {}} width={60} />);
    expect(plainLines(view.lastFrame())).toEqual([
      '  Patch has a plan',
      '  ╭────────────────────────────────────────────────────────╮',
      '  │ Cache the config                                       │',
      '  │                                                        │',
      '  │ 1. Read it once in src/config.ts.                      │',
      '  │ 2. Run the tests.                                      │',
      '  ╰────────────────────────────────────────────────────────╯',
      '',
      '  › 1. Yes, and accept edits',
      '    2. Yes, and ask before each edit',
      '    3. No, keep planning',
      '  enter confirm · esc keep planning',
    ]);
    expect(layoutPlanPrompt(PLAN, 60).height).toBe(12);
  });

  it('approves with accept edits on Enter, asks before edits with 2, keeps planning on esc', async () => {
    const onRespond = vi.fn();
    const view = await mount(<PlanPrompt request={request} onRespond={onRespond} width={60} />);
    await view.type(keys.enter, '2', keys.escape);
    expect(onRespond.mock.calls.map(([response]) => response)).toEqual([
      { decision: 'approve', mode: 'acceptEdits' },
      { decision: 'approve', mode: 'default' },
      { decision: 'keep_planning' },
    ]);
  });

  it('asks what to change after "No, keep planning"', async () => {
    const onRespond = vi.fn();
    const view = await mount(<PlanPrompt request={request} onRespond={onRespond} width={60} />);
    await view.type('3');
    expect(plainLines(view.lastFrame()).slice(-4)).toEqual([
      '',
      '  What should Patch change?',
      '  ›',
      '  enter send · esc back',
    ]);
    expect(onRespond).not.toHaveBeenCalled();
    // Typing (j, k and digits are text here), a paste with a line break, Backspace, Enter.
    await view.type('j', 'k', '1', keys.backspace, keys.backspace, keys.backspace);
    await view.type('Use zod\nfor it', 'x', keys.backspace);
    expect(view.text()).toContain('› Use zod for it');
    await view.type(keys.enter);
    expect(onRespond).toHaveBeenLastCalledWith({
      decision: 'keep_planning',
      feedback: 'Use zod for it',
    });
  });

  it('goes back to the choices on esc, and keeps planning without feedback on an empty answer', async () => {
    const onRespond = vi.fn();
    const view = await mount(<PlanPrompt request={request} onRespond={onRespond} width={60} />);
    await view.type('3', 'abc', keys.escape);
    expect(view.text()).toContain('3. No, keep planning');
    expect(onRespond).not.toHaveBeenCalled();
    await view.type('3', keys.enter);
    expect(onRespond).toHaveBeenLastCalledWith({ decision: 'keep_planning' });
  });

  it('cuts a long plan to fit its rows and offers ctrl+o', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `${i + 1}. Step ${i + 1}`).join('\n');
    const layout = layoutPlanPrompt(long, 60, 20);
    expect(layout).toMatchObject({ truncated: true, height: 20 });
    const view = await mount(
      <PlanPrompt request={{ id: 'p', plan: long }} onRespond={() => {}} width={60} maxRows={20} />,
    );
    const lines = plainLines(view.lastFrame());
    expect(lines).toHaveLength(20);
    expect(lines).toContain('  │ … 29 more lines                                        │');
    expect(lines.at(-1)).toBe('  enter confirm · esc keep planning · ctrl+o show in full');
  });
});

describe('a plan in the transcript', () => {
  it('stays under its row, in a frame', () => {
    const lines = plainLines(
      frameOf(
        <TranscriptItemView
          item={{
            kind: 'tool',
            id: 't1',
            name: 'present_plan',
            summary: { verb: 'plan', target: 'Cache the config' },
            status: 'done',
            display: { plan: PLAN, summary: 'approved · accepting edits' },
            first: true,
          }}
          width={60}
        />,
      ),
    );
    expect(lines).toEqual([
      '',
      '  plan    Cache the config · approved · accepting edits',
      '  ╭────────────────────────────────────────────────────────╮',
      '  │ Cache the config                                       │',
      '  │                                                        │',
      '  │ 1. Read it once in src/config.ts.                      │',
      '  │ 2. Run the tests.                                      │',
      '  ╰────────────────────────────────────────────────────────╯',
    ]);
  });
});
