import type { FileDiff, PermissionRequest, SessionSummary, Severity } from '@patch/core';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PermissionPrompt,
  layoutPermissionPrompt,
} from '../../src/ui/components/PermissionPrompt.js';
import type { SelectOption } from '../../src/ui/components/props.js';
import { Select } from '../../src/ui/components/Select.js';
import { SessionPicker } from '../../src/ui/components/SessionPicker.js';
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

const fruits: Array<SelectOption<string>> = [
  { label: 'Apple', value: 'apple' },
  { label: 'Banana', value: 'banana', hint: 'ripe' },
  { label: 'Cherry', value: 'cherry' },
];

describe('Select', () => {
  it('renders options with a pointer on the initial selection', async () => {
    const view = await mount(<Select options={fruits} onSelect={() => {}} initialIndex={1} />);
    expect(plainLines(view.lastFrame())).toEqual(['  Apple', '› Banana  ripe', '  Cherry']);
  });

  it('moves with arrows and j/k, wrapping at the ends, and selects with Enter', async () => {
    const onSelect = vi.fn();
    const view = await mount(<Select options={fruits} onSelect={onSelect} />);
    await view.type(keys.up);
    expect(view.text()).toContain('› Cherry');
    await view.type('j', keys.down, 'k');
    expect(view.text()).toContain('› Apple');
    await view.type(keys.down, keys.enter);
    expect(onSelect).toHaveBeenCalledWith('banana');
  });

  it('selects directly with number keys when numbered', async () => {
    const onSelect = vi.fn();
    const view = await mount(<Select options={fruits} onSelect={onSelect} numbered />);
    expect(plainLines(view.lastFrame())).toEqual([
      '› 1. Apple',
      '  2. Banana  ripe',
      '  3. Cherry',
    ]);
    await view.type('4');
    expect(onSelect).not.toHaveBeenCalled();
    await view.type('3');
    expect(onSelect).toHaveBeenCalledWith('cherry');
  });

  it('ignores number keys when not numbered', async () => {
    const onSelect = vi.fn();
    const view = await mount(<Select options={fruits} onSelect={onSelect} />);
    await view.type('2');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('cancels with Esc', async () => {
    const onCancel = vi.fn();
    const view = await mount(<Select options={fruits} onSelect={() => {}} onCancel={onCancel} />);
    await view.type(keys.escape);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('scrolls a long list and shows how many items are hidden', async () => {
    const options = Array.from({ length: 12 }, (_, i) => ({ label: `Item ${i + 1}`, value: i }));
    const onSelect = vi.fn();
    const view = await mount(<Select options={options} onSelect={onSelect} maxVisible={3} />);
    expect(plainLines(view.lastFrame())).toEqual([
      '› Item 1',
      '  Item 2',
      '  Item 3',
      '  ↓ 9 more',
    ]);
    await view.type(keys.down, keys.down, keys.down);
    expect(plainLines(view.lastFrame())).toEqual([
      '  ↑ 1 more',
      '  Item 2',
      '  Item 3',
      '› Item 4',
      '  ↓ 8 more',
    ]);
    await view.type(keys.up, keys.up);
    expect(plainLines(view.lastFrame())[1]).toBe('› Item 2');
    await view.type(keys.up, keys.enter);
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it('does not react while inactive', async () => {
    const onSelect = vi.fn();
    const view = await mount(<Select options={fruits} onSelect={onSelect} isActive={false} />);
    await view.type(keys.down, keys.enter);
    expect(onSelect).not.toHaveBeenCalled();
    expect(view.text()).toContain('› Apple');
  });

  it('renders nothing selectable for an empty list', async () => {
    const onSelect = vi.fn();
    const view = await mount(<Select options={[]} onSelect={onSelect} />);
    await view.type(keys.enter);
    expect(onSelect).not.toHaveBeenCalled();
  });

  describe('with colors', () => {
    withColors();

    it('colors the selection with the accent and danger options in red', async () => {
      const view = await mount(
        <Select
          options={[
            { label: 'Delete', value: 'delete', tone: 'danger' },
            { label: 'Keep', value: 'keep' },
          ]}
          onSelect={() => {}}
          initialIndex={1}
        />,
      );
      const [danger, keep] = (view.lastFrame() ?? '').split('\n');
      expect(danger).toMatch(/\u001b\[31m[^\u001b]*Delete/);
      expect(keep).toMatch(/\u001b\[32m[^\u001b]*Keep/);
      expect(danger).not.toContain(sgr.green);
    });
  });
});

const diff: FileDiff = {
  path: 'src/a.ts',
  added: 1,
  removed: 1,
  isNew: false,
  hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' keep', '-old', '+new'] }],
};

function request(
  severity: Severity,
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    id: 'req-1',
    toolName: 'bash',
    summary: { verb: 'bash', target: 'pnpm test' },
    subject: { kind: 'write', paths: [] },
    prompt: {
      title:
        severity === 'danger' ? 'Potentially destructive command' : 'Patch wants to run a command',
      subjectLine: 'pnpm test --filter auth',
      severity,
      reason: 'Runs project code',
      sessionOption: {
        label: "Yes, and don't ask again for pnpm test",
        grant: { kind: 'command-prefix', prefix: 'pnpm test' },
      },
    },
    ...overrides,
  };
}

describe('PermissionPrompt', () => {
  it('lays out title, subject, reason, options and hint', async () => {
    const view = await mount(
      <PermissionPrompt request={request('normal')} onRespond={() => {}} width={80} />,
    );
    expect(plainLines(view.lastFrame())).toEqual([
      '  Patch wants to run a command',
      '',
      '    pnpm test --filter auth',
      '  Runs project code',
      '',
      '  › 1. Yes',
      "    2. Yes, and don't ask again for pnpm test",
      '    3. No, tell Patch what to do instead',
      '  enter confirm · esc decline',
    ]);
  });

  it('allows once on Enter, for the session with 2 and denies with 3 or Esc', async () => {
    const onRespond = vi.fn();
    const view = await mount(
      <PermissionPrompt request={request('normal')} onRespond={onRespond} width={80} />,
    );
    await view.type(keys.enter, '2', '3', keys.escape);
    expect(onRespond.mock.calls.map(([response]) => response)).toEqual([
      { decision: 'allow_once' },
      { decision: 'allow_session' },
      { decision: 'deny' },
      { decision: 'deny' },
    ]);
  });

  it('omits the session option when the prompt has none', async () => {
    const onRespond = vi.fn();
    const base = request('warning');
    const view = await mount(
      <PermissionPrompt
        request={{
          ...base,
          prompt: { ...base.prompt, sessionOption: undefined, reason: undefined },
        }}
        onRespond={onRespond}
        width={80}
      />,
    );
    expect(plainLines(view.lastFrame()).slice(3)).toEqual([
      '',
      '  › 1. Yes',
      '    2. No, tell Patch what to do instead',
      '  enter confirm · esc decline',
    ]);
    await view.type('2');
    expect(onRespond).toHaveBeenCalledWith({ decision: 'deny' });
  });

  it('shows a diff preview capped at 20 lines', async () => {
    const big: FileDiff = {
      ...diff,
      added: 30,
      hunks: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 30,
          lines: Array.from({ length: 30 }, (_, i) => `+line ${i + 1}`),
        },
      ],
    };
    const view = await mount(
      <PermissionPrompt
        request={request('normal', { preview: { diff: big } })}
        onRespond={() => {}}
        width={80}
      />,
    );
    const lines = plainLines(view.lastFrame());
    expect(lines).toContain('     1 + line 1');
    expect(lines).toContain('    20 + line 20');
    expect(lines).not.toContain('    21 + line 21');
    expect(lines).toContain('    … 10 more lines');
  });

  it('shows the first 12 lines of a text preview', async () => {
    const text = Array.from({ length: 15 }, (_, i) => `row ${i + 1}`).join('\n');
    const view = await mount(
      <PermissionPrompt
        request={request('normal', { preview: { text } })}
        onRespond={() => {}}
        width={80}
      />,
    );
    const lines = plainLines(view.lastFrame());
    expect(lines).toContain('    row 12');
    expect(lines).not.toContain('    row 13');
    expect(lines).toContain('    … 3 more lines');
  });

  it('wraps long subjects such as commands verbatim', async () => {
    const base = request('normal');
    const command = 'find . -name "*.log" -mtime +7 -print0 | xargs -0 rm -f';
    const view = await mount(
      <PermissionPrompt
        request={{ ...base, prompt: { ...base.prompt, subjectLine: command } }}
        onRespond={() => {}}
        width={40}
      />,
    );
    const subject = plainLines(view.lastFrame())
      .slice(2, 4)
      .map((line) => line.trim());
    expect(subject.join(' ')).toBe(command);
  });

  it('fits a long multi-line command into maxRows and offers ctrl+o', async () => {
    const base = request('normal');
    const body = Array.from({ length: 60 }, (_, i) => `entry ${i + 1}`).join('\n');
    const subjectLine = `cat > notes.txt <<'EOF'\n${body}\nEOF`;
    const prompt = { ...base, prompt: { ...base.prompt, subjectLine } };
    const view = await mount(
      <PermissionPrompt request={prompt} onRespond={() => {}} width={80} maxRows={20} />,
    );
    const lines = plainLines(view.lastFrame());
    expect(lines).toHaveLength(20);
    expect(layoutPermissionPrompt(prompt, 80, 20).height).toBe(20);
    expect(lines[0]).toBe('  Patch wants to run a command');
    expect(lines[2]).toBe("    cat > notes.txt <<'EOF'");
    // 62 subject rows; 12 rows are left after the title, reason, options and hint.
    expect(lines).toContain('    … 51 more lines');
    expect(lines).toContain('  › 1. Yes');
    expect(lines.at(-1)).toBe('  enter confirm · esc decline · ctrl+o show in full');
  });

  it('cuts long diff lines to the width and the diff to maxRows', async () => {
    const wide: FileDiff = {
      ...diff,
      added: 20,
      removed: 0,
      hunks: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 20,
          lines: Array.from({ length: 20 }, (_, i) => `+${`line ${i + 1} `.repeat(24)}`),
        },
      ],
    };
    const edit = request('normal', { preview: { diff: wide } });
    const view = await mount(
      <PermissionPrompt request={edit} onRespond={() => {}} width={80} maxRows={18} />,
    );
    const lines = plainLines(view.lastFrame());
    expect(lines).toHaveLength(layoutPermissionPrompt(edit, 80, 18).height);
    expect(lines.length).toBeLessThanOrEqual(18);
    expect(lines.every((line) => line.length <= 80)).toBe(true);
    expect(lines.some((line) => /^ {4}… \d+ more lines$/.test(line))).toBe(true);
    expect(lines.at(-1)).toContain('ctrl+o show in full');
  });

  it('reports its exact height for any budget', () => {
    const base = request('danger');
    const command = Array.from({ length: 30 }, (_, i) => `echo step ${i} && sleep 1`).join(' && ');
    const big = { ...base, prompt: { ...base.prompt, subjectLine: command } };
    for (const maxRows of [8, 12, 16, 24, 40]) {
      const { lastFrame, unmount } = render(
        <PermissionPrompt request={big} onRespond={() => {}} width={60} maxRows={maxRows} />,
      );
      const height = plainLines(lastFrame()).length;
      unmount();
      expect(height).toBe(layoutPermissionPrompt(big, 60, maxRows).height);
      // Title, reason, options, hint, blank lines and one subject row with its "more" row.
      expect(height).toBeLessThanOrEqual(Math.max(maxRows, 10));
    }
  });

  describe('with colors', () => {
    withColors();

    it.each([
      ['normal', null],
      ['warning', sgr.yellow],
      ['danger', sgr.red],
    ] as const)('colors the %s title', async (severity, color) => {
      const view = await mount(
        <PermissionPrompt request={request(severity)} onRespond={() => {}} width={80} />,
      );
      const title = (view.lastFrame() ?? '').split('\n')[0] ?? '';
      expect(title).toContain(sgr.bold);
      if (color) expect(title).toContain(color);
      else expect(title).not.toMatch(/\u001b\[3\dm/);
    });

    it('keeps the cursor on Yes but renders it red for danger', async () => {
      const onRespond = vi.fn();
      const view = await mount(
        <PermissionPrompt request={request('danger')} onRespond={onRespond} width={80} />,
      );
      const yes = (view.lastFrame() ?? '').split('\n').find((line) => line.includes('Yes'));
      expect(yes).toContain(`${sgr.red}Yes`);
      await view.type(keys.enter);
      expect(onRespond).toHaveBeenCalledWith({ decision: 'allow_once' });
    });
  });
});

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: '82af31aa-1111-2222-3333-444455556666',
    title: 'Fix the failing auth test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    cwd: '/code/project',
    projectRoot: '/code/project',
    branch: 'main',
    model: 'claude-opus-5-5',
    messageCount: 24,
    projectExists: true,
    filePath: '/sessions/82af31.jsonl',
    ...overrides,
  };
}

describe('SessionPicker', () => {
  const sessions = [
    session({}),
    session({
      id: '1c9e02bb-0000-0000-0000-000000000000',
      title: 'Add retry to the provider',
      updatedAt: new Date(Date.now() - 30 * 3_600_000).toISOString(),
      branch: null,
      messageCount: 1,
      projectExists: false,
    }),
  ];

  it('lists sessions with id, title and metadata', async () => {
    const view = await mount(
      <SessionPicker
        sessions={sessions}
        onSelect={() => {}}
        onCancel={() => {}}
        width={90}
        projectLabel="~/code/project"
      />,
    );
    expect(plainLines(view.lastFrame())).toEqual([
      '  Resume a session',
      '  ~/code/project',
      '',
      '  › 82af31  Fix the failing auth test  2h ago · main · 24 msgs',
      '    1c9e02  Add retry to the provider  yesterday · 1 msg (missing)',
      '',
      '  enter resume · esc cancel',
    ]);
  });

  it('resumes the selected session and cancels with Esc', async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const view = await mount(
      <SessionPicker
        sessions={sessions}
        onSelect={onSelect}
        onCancel={onCancel}
        width={90}
        projectLabel="~/code/project"
      />,
    );
    await view.type(keys.down, keys.enter);
    expect(onSelect).toHaveBeenCalledWith('1c9e02bb-0000-0000-0000-000000000000');
    await view.type(keys.escape);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('truncates long titles to keep the metadata column', async () => {
    const view = await mount(
      <SessionPicker
        sessions={[session({ title: 'A very long session title '.repeat(5) })]}
        onSelect={() => {}}
        onCancel={() => {}}
        width={70}
        projectLabel="~/p"
      />,
    );
    const row = plainLines(view.lastFrame())[3] ?? '';
    expect(row).toContain('…');
    expect(row.endsWith('2h ago · main · 24 msgs')).toBe(true);
    expect(row.length).toBeLessThan(70);
  });

  it('explains when there are no sessions', async () => {
    const onCancel = vi.fn();
    const view = await mount(
      <SessionPicker
        sessions={[]}
        onSelect={() => {}}
        onCancel={onCancel}
        width={80}
        projectLabel="~/p"
      />,
    );
    expect(view.text()).toContain('No previous sessions for this project.');
    await view.type(keys.enter, keys.escape);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
