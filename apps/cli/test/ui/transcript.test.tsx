import type { FileDiff } from '@patch/core';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Footer } from '../../src/ui/components/Footer.js';
import { StatusLine } from '../../src/ui/components/StatusLine.js';
import { TranscriptItemView } from '../../src/ui/components/TranscriptItemView.js';
import { Welcome } from '../../src/ui/components/Welcome.js';
import { useTerminalSize } from '../../src/ui/hooks/useTerminalSize.js';
import type { TranscriptItem, WelcomeInfo } from '../../src/ui/transcript.js';
import { plainLines, sgr, tick, withColors } from './helpers.js';

const WIDTH = 80;

function frameOf(element: React.ReactElement): string {
  const { lastFrame, unmount } = render(element);
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

function itemLines(item: TranscriptItem, width = WIDTH): string[] {
  return plainLines(frameOf(<TranscriptItemView item={item} width={width} />));
}

const welcomeInfo: WelcomeInfo = {
  version: '0.1.0',
  location: '~/code/project',
  branch: 'main',
  isGit: true,
  changedFiles: 3,
  model: 'claude-opus-5-5',
  status: 'ready',
  statusLevel: 'ok',
  instructionFiles: ['PATCH.md'],
  notes: [],
};

const diff: FileDiff = {
  path: 'src/a.ts',
  added: 1,
  removed: 1,
  isNew: false,
  hunks: [{ oldStart: 4, oldLines: 2, newStart: 4, newLines: 2, lines: [' keep', '-old', '+new'] }],
};

describe('Welcome', () => {
  it('prints the three-line header', () => {
    expect(plainLines(frameOf(<Welcome info={welcomeInfo} />))).toEqual([
      '  ptch 0.1.0',
      '  ~/code/project · main · 3 changed',
      '  claude-opus-5-5 · ready · PATCH.md',
    ]);
  });

  it('describes clean trees, non-git directories and notes', () => {
    expect(plainLines(frameOf(<Welcome info={{ ...welcomeInfo, changedFiles: 0 }} />))[1]).toBe(
      '  ~/code/project · main · clean',
    );
    const outside = plainLines(
      frameOf(
        <Welcome
          info={{
            ...welcomeInfo,
            isGit: false,
            branch: null,
            changedFiles: null,
            instructionFiles: [],
            status: 'no API key',
            statusLevel: 'error',
            notes: ['Running in your home directory.'],
          }}
        />,
      ),
    );
    expect(outside).toEqual([
      '  ptch 0.1.0',
      '  ~/code/project · not a git repository',
      '  claude-opus-5-5 · no API key',
      '  Running in your home directory.',
    ]);
  });

  describe('with colors', () => {
    withColors();

    it('dims a ready status and colors problems', () => {
      const status = (level: WelcomeInfo['statusLevel']) =>
        frameOf(<Welcome info={{ ...welcomeInfo, status: 'state', statusLevel: level }} />).split(
          '\n',
        )[2] ?? '';
      expect(status('ok')).toMatch(/\u001b\[2m[^\u001b]*state/);
      expect(status('warn')).toContain(`${sgr.yellow}state`);
      expect(status('error')).toContain(`${sgr.red}state`);
    });
  });
});

describe('TranscriptItemView', () => {
  it('renders the welcome header', () => {
    expect(itemLines({ kind: 'welcome', id: 'w', info: welcomeInfo })[0]).toBe('  ptch 0.1.0');
  });

  it('renders user messages behind the prompt marker with aligned continuation lines', () => {
    expect(itemLines({ kind: 'user', id: 'u', text: 'first line\nsecond line' })).toEqual([
      '',
      '› first line',
      '  second line',
    ]);
  });

  it('wraps long user messages under the text', () => {
    const lines = itemLines({ kind: 'user', id: 'u', text: 'word '.repeat(10).trim() }, 22);
    expect(lines).toEqual(['', '› word word word word', '  word word word word', '  word word']);
  });

  it('renders assistant markdown indented with a top gap', () => {
    expect(
      itemLines({ kind: 'assistant', id: 'a', first: true, markdown: '**Done.**\n\n- one\n- two' }),
    ).toEqual(['', '  Done.', '', '  • one', '  • two']);
  });

  it('wraps assistant markdown to the indented width', () => {
    const lines = itemLines(
      { kind: 'assistant', id: 'a', first: false, markdown: 'alpha beta gamma delta epsilon' },
      20,
    );
    expect(lines).toEqual(['', '  alpha beta gamma', '  delta epsilon']);
  });

  it('renders progress notes dim and indented', () => {
    expect(itemLines({ kind: 'progress', id: 'p', text: 'Checking the tests.' })).toEqual([
      '',
      '  Checking the tests.',
    ]);
  });

  it('gives tool rows a top gap only when first', () => {
    const tool = (first: boolean): TranscriptItem => ({
      kind: 'tool',
      id: 't',
      name: 'read_file',
      summary: { verb: 'read', target: 'a.ts' },
      status: 'done',
      display: { summary: '3 lines' },
      first,
    });
    expect(itemLines(tool(true))).toEqual(['', '  read    a.ts · 3 lines']);
    expect(itemLines(tool(false))).toEqual(['  read    a.ts · 3 lines']);
  });

  it('renders notices by level with an indented hint', () => {
    expect(
      itemLines({
        kind: 'notice',
        id: 'n',
        level: 'error',
        text: 'Request failed.',
        hint: 'Try again.',
      }),
    ).toEqual(['', '  ✗ Request failed.', '    Try again.']);
    expect(itemLines({ kind: 'notice', id: 'n', level: 'warn', text: 'Context is full.' })).toEqual(
      ['', '  ! Context is full.'],
    );
    expect(
      itemLines({
        kind: 'notice',
        id: 'n',
        level: 'info',
        text: 'Model changed.',
        hint: 'Applies now.',
      }),
    ).toEqual(['', '  Model changed.', '    Applies now.']);
  });

  it('renders shell commands with output and a failing exit status', () => {
    expect(
      itemLines({
        kind: 'shell',
        id: 's',
        command: 'git status --short',
        exitCode: 1,
        output: ' M a.ts\r\n?? b.ts\n',
        durationMs: 300,
      }),
    ).toEqual(['', '! git status --short', '   M a.ts', '  ?? b.ts', '  exit 1 · 300ms']);
  });

  it('omits the status line for successful commands and empty output', () => {
    expect(
      itemLines({
        kind: 'shell',
        id: 's',
        command: 'true',
        exitCode: 0,
        output: '',
        durationMs: 5,
      }),
    ).toEqual(['', '! true']);
    expect(
      itemLines({
        kind: 'shell',
        id: 's',
        command: 'sleep 9',
        exitCode: null,
        output: '',
        durationMs: 1500,
      }),
    ).toEqual(['', '! sleep 9', '  terminated · 1.5s']);
  });

  it('caps shell output at 30 lines with an omission note', () => {
    const output = Array.from({ length: 100 }, (_, i) => `out ${i + 1}`).join('\n');
    const lines = itemLines({
      kind: 'shell',
      id: 's',
      command: 'seq',
      exitCode: 0,
      output,
      durationMs: 1,
    });
    expect(lines).toHaveLength(2 + 31);
    expect(lines[2]).toBe('  out 1');
    expect(lines).toContain('  ... 70 lines omitted ...');
    expect(lines[lines.length - 1]).toBe('  out 100');
  });

  it('renders status rows with aligned labels', () => {
    expect(
      itemLines({
        kind: 'status',
        id: 'st',
        title: 'Status',
        rows: [
          { label: 'Model', value: 'claude-opus-5-5' },
          { label: 'Permissions', value: 'ask', detail: 'edits allowed' },
        ],
      }),
    ).toEqual([
      '',
      '  Status',
      '  Model        claude-opus-5-5',
      '  Permissions  ask  edits allowed',
    ]);
  });

  it('renders help sections with aligned keys', () => {
    expect(
      itemLines({
        kind: 'help',
        id: 'h',
        sections: [
          { title: 'Commands', rows: [{ key: '/compact', description: 'Summarize' }] },
          { title: 'Keys', rows: [{ key: 'esc', description: 'Interrupt' }] },
        ],
      }),
    ).toEqual(['', '  Commands', '  /compact  Summarize', '', '  Keys', '  esc       Interrupt']);
  });

  it('renders git diffs under a dim title', () => {
    expect(
      itemLines({
        kind: 'git-diff',
        id: 'g',
        title: 'Uncommitted changes',
        diff: '@@ -1 +1 @@\n-a\n+b',
        untracked: [],
      }),
    ).toEqual(['', '  Uncommitted changes', '  @@ -1 +1 @@', '  -a', '  +b']);
  });

  it('renders details as text or as a diff', () => {
    expect(
      itemLines({ kind: 'detail', id: 'd', title: 'bash pnpm test', text: 'line 1\nline 2' }),
    ).toEqual(['', '  bash pnpm test', '  line 1', '  line 2']);
    expect(itemLines({ kind: 'detail', id: 'd', title: 'edit src/a.ts', text: '', diff })).toEqual([
      '',
      '  edit src/a.ts',
      '  4   keep',
      '  5 - old',
      '  5 + new',
    ]);
  });

  it('caps detail text at 400 lines', () => {
    const text = Array.from({ length: 450 }, (_, i) => `l${i}`).join('\n');
    const lines = itemLines({ kind: 'detail', id: 'd', title: 't', text });
    expect(lines).toHaveLength(2 + 400 + 1);
    expect(lines[lines.length - 1]).toBe('  … 50 more lines');
  });

  it('renders dividers that fill the width', () => {
    const [blank, divider] = itemLines({ kind: 'divider', id: 'dv', label: 'Resumed' }, 40);
    expect(blank).toBe('');
    expect(divider).toBe(`  ── Resumed ${'─'.repeat(26)}`);
    expect(divider).toHaveLength(39);
  });

  it('renders compaction summaries trimmed to six lines', () => {
    const summary = Array.from({ length: 8 }, (_, i) => `point ${i + 1}`).join('\n\n');
    const lines = itemLines({
      kind: 'compaction',
      id: 'c',
      summary,
      auto: true,
      messagesCompacted: 31,
    });
    expect(lines).toEqual([
      '',
      '  Conversation compacted · 31 messages summarized · automatic',
      '    point 1',
      '    point 2',
      '    point 3',
      '    point 4',
      '    point 5',
      '    point 6',
      '    …',
    ]);
  });

  it('strips control sequences from item text', () => {
    expect(itemLines({ kind: 'progress', id: 'p', text: '\u001b[31mred\u001b[0m\tok' })).toEqual([
      '',
      '  red ok',
    ]);
  });
});

describe('Footer', () => {
  it('right-aligns the status and keeps a column free at the edge', () => {
    const [line] = plainLines(
      frameOf(<Footer left="? for shortcuts" right="18% context" width={40} />),
    );
    expect(line).toBe(`  ? for shortcuts${' '.repeat(11)}18% context`);
    expect(line).toHaveLength(39);
  });

  it('truncates the hints before the status when space runs out', () => {
    const [line] = plainLines(
      frameOf(
        <Footer left="enter send · esc interrupt · ctrl+o expand" right="18% context" width={32} />,
      ),
    );
    expect(line).toBe('  enter send · es…  18% context');
  });
});

describe('StatusLine', () => {
  it('shows spinner, label, elapsed time, detail and hint', () => {
    const [line] = plainLines(
      frameOf(
        <StatusLine
          label="Running pnpm test"
          startedAt={Date.now() - 14_200}
          detail="↓ 1.2k tokens"
          hint="esc to interrupt"
        />,
      ),
    );
    expect(line).toBe('⠋ Running pnpm test  14s · ↓ 1.2k tokens · esc to interrupt');
  });

  it('animates the spinner and stops its timers on unmount', async () => {
    const view = render(<StatusLine label="Thinking" startedAt={Date.now()} />);
    const first = plainLines(view.lastFrame())[0];
    await tick(400);
    expect(plainLines(view.lastFrame())[0]).not.toBe(first);
    view.unmount();
    const written = view.frames.length;
    await tick(200);
    expect(view.frames.length).toBe(written);
  });
});

describe('useTerminalSize', () => {
  function Size() {
    const { columns, rows } = useTerminalSize();
    return <Text>{`${columns}x${rows}`}</Text>;
  }

  it('reads the stream size, defaults missing values and follows resizes', async () => {
    const view = render(<Size />);
    // The test stream reports 100 columns and no rows.
    expect(plainLines(view.lastFrame())[0]).toBe('100x24');
    Object.defineProperty(view.stdout, 'columns', { value: 120, configurable: true });
    Object.defineProperty(view.stdout, 'rows', { value: 40, configurable: true });
    view.stdout.emit('resize');
    await tick();
    expect(plainLines(view.lastFrame())[0]).toBe('120x40');
    view.unmount();
    expect(view.stdout.listenerCount('resize')).toBe(0);
  });
});

describe('sample transcript', () => {
  const items: TranscriptItem[] = [
    { kind: 'welcome', id: 'w', info: welcomeInfo },
    { kind: 'user', id: 'u', text: 'The refresh test fails. Find out why and fix it.' },
    { kind: 'progress', id: 'p', text: 'Reading the auth module first.' },
    {
      kind: 'tool',
      id: 't1',
      name: 'read_file',
      first: true,
      status: 'done',
      summary: { verb: 'read', target: 'src/auth/session.ts' },
      display: { summary: '120 lines' },
    },
    {
      kind: 'tool',
      id: 't2',
      name: 'edit_file',
      first: false,
      status: 'done',
      summary: { verb: 'edit', target: 'src/a.ts' },
      display: { diff },
    },
    {
      kind: 'tool',
      id: 't3',
      name: 'bash',
      first: false,
      status: 'done',
      summary: { verb: 'bash', target: 'pnpm test' },
      display: { summary: '42 passed' },
      durationMs: 8100,
    },
    {
      kind: 'assistant',
      id: 'a',
      first: true,
      markdown: 'Fixed. `refresh()` now returns `null` on expiry.\n\n```ts\nreturn null;\n```',
    },
    { kind: 'notice', id: 'n', level: 'warn', text: 'Context is 82% full.', hint: 'Run /compact.' },
  ];

  it('has exactly one blank line between blocks and none between tool rows', () => {
    const lines = plainLines(
      frameOf(
        <Box flexDirection="column" width={100}>
          {items.map((item) => (
            <TranscriptItemView key={item.id} item={item} width={100} />
          ))}
        </Box>,
      ),
    );
    expect(lines).toEqual([
      '  ptch 0.1.0',
      '  ~/code/project · main · 3 changed',
      '  claude-opus-5-5 · ready · PATCH.md',
      '',
      '› The refresh test fails. Find out why and fix it.',
      '',
      '  Reading the auth module first.',
      '',
      '  read    src/auth/session.ts · 120 lines',
      '  edit    src/a.ts  +1 -1',
      '          4   keep',
      '          5 - old',
      '          5 + new',
      '  bash    pnpm test',
      '          42 passed · 8.1s',
      '',
      '  Fixed. refresh() now returns null on expiry.',
      '',
      '  │ ts',
      '  │ return null;',
      '',
      '  ! Context is 82% full.',
      '    Run /compact.',
    ]);
  });
});
