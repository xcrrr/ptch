import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoConfirmPrompt, layoutAutoConfirm } from '../../src/ui/components/AutoConfirmPrompt.js';
import { Footer } from '../../src/ui/components/Footer.js';
import { describePermissionMode, permissionModeAccent } from '../../src/ui/permission-mode.js';
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

describe('the footer in auto mode', () => {
  it('says that nothing asks, then how to change it', () => {
    const [line] = plainLines(
      frameOf(
        <Footer
          left="shift+tab to change"
          right="main · 3% context"
          width={100}
          accent={permissionModeAccent('auto')}
        />,
      ),
    );
    expect(line).toBe(
      `  ⏵⏵⏵ auto mode · no permission prompts · shift+tab to change${' '.repeat(21)}main · 3% context`,
    );
    expect(describePermissionMode('auto')).toBe('auto mode (no permission prompts)');
  });

  describe('with colors', () => {
    withColors();

    it('is red, the danger color', () => {
      expect(theme.autoMode).toBe('red');
      const frame = frameOf(
        <Footer left="" right="" width={60} accent={permissionModeAccent('auto')} />,
      );
      expect(frame).toContain(`${sgr.red}⏵⏵⏵ auto mode · no permission prompts`);
    });
  });
});

describe('AutoConfirmPrompt', () => {
  it('explains auto mode and its guardrails and asks', async () => {
    const view = await mount(<AutoConfirmPrompt onRespond={() => {}} width={80} />);
    expect(plainLines(view.lastFrame())).toEqual([
      '  Auto mode runs edits and commands without asking.',
      '  Destructive commands and secret files still ask. Turn it on?',
      '',
      '  › 1. Yes',
      '    2. No',
      '  enter confirm · esc cancel',
    ]);
    expect(layoutAutoConfirm(80).height).toBe(6);
  });

  it('answers yes on Enter or 1, no on 2 or esc', async () => {
    const onRespond = vi.fn();
    const view = await mount(<AutoConfirmPrompt onRespond={onRespond} width={80} />);
    await view.type(keys.enter, '2', '1', keys.escape);
    expect(onRespond.mock.calls.map(([yes]) => yes)).toEqual([true, false, true, false]);
  });

  it('wraps on a narrow terminal, with the height to match', async () => {
    const view = await mount(<AutoConfirmPrompt onRespond={() => {}} width={40} />);
    expect(plainLines(view.lastFrame())).toHaveLength(layoutAutoConfirm(40).height);
    expect(layoutAutoConfirm(40).height).toBeGreaterThan(6);
  });
});
