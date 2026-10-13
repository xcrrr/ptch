import type { FileDiff } from '@patch/core';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { DiffView, measureDiffView } from '../../src/ui/components/DiffView.js';
import { GitDiffView } from '../../src/ui/components/GitDiffView.js';
import type { ToolRowProps } from '../../src/ui/components/props.js';
import { ToolRow, toolRowHeight } from '../../src/ui/components/ToolRow.js';
import { plainLines, sgr, withColors } from './helpers.js';

function frameOf(element: React.ReactElement): string {
  const { lastFrame, unmount } = render(element);
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

const linesOf = (element: React.ReactElement): string[] => plainLines(frameOf(element));

const editDiff: FileDiff = {
  path: 'src/auth/session.ts',
  added: 2,
  removed: 1,
  isNew: false,
  hunks: [
    {
      oldStart: 9,
      oldLines: 3,
      newStart: 9,
      newLines: 4,
      lines: [
        '   const a = 1;',
        '-  const b = 2;',
        '+  const b = 3;',
        '+  const c = 4;',
        '   return a;',
      ],
    },
  ],
};

function row(props: Partial<ToolRowProps>): React.ReactElement {
  return (
    <ToolRow
      name="read_file"
      summary={{ verb: 'read', target: 'src/auth/session.ts' }}
      status="done"
      width={80}
      {...props}
    />
  );
}

describe('ToolRow', () => {
  it('renders a read with its summary on one line', () => {
    expect(linesOf(row({ display: { summary: '120 lines' } }))).toEqual([
      '  read    src/auth/session.ts · 120 lines',
    ]);
  });

  it('shows the call detail dim after the target', () => {
    expect(
      linesOf(
        row({
          summary: { verb: 'read', target: 'src/a.ts', detail: 'lines 40-120' },
          display: { summary: '81 lines' },
        }),
      ),
    ).toEqual(['  read    src/a.ts  lines 40-120 · 81 lines']);
  });

  it('renders an edit with change counts and a compact diff', () => {
    expect(
      linesOf(
        row({
          name: 'edit_file',
          summary: { verb: 'edit', target: 'src/auth/session.ts' },
          display: { diff: editDiff },
        }),
      ),
    ).toEqual([
      '  edit    src/auth/session.ts  +2 -1',
      '           9     const a = 1;',
      '          10 -   const b = 2;',
      '          10 +   const b = 3;',
      '          11 +   const c = 4;',
      '          12     return a;',
    ]);
  });

  it('caps the compact diff at 8 lines', () => {
    const big: FileDiff = {
      path: 'a.ts',
      added: 12,
      removed: 0,
      isNew: true,
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 12,
          lines: Array.from({ length: 12 }, (_, i) => `+line ${i + 1}`),
        },
      ],
    };
    const lines = linesOf(
      row({
        name: 'write_file',
        summary: { verb: 'create', target: 'a.ts' },
        display: { diff: big },
      }),
    );
    expect(lines[0]).toBe('  create  a.ts  +12');
    expect(lines).toHaveLength(10);
    expect(lines[9]).toBe('          … 4 more lines');
  });

  it('puts command outcomes and durations on a second line aligned to the target', () => {
    expect(
      linesOf(
        row({
          name: 'bash',
          summary: { verb: 'bash', target: 'pnpm test' },
          display: { summary: '42 passed · 1 failed' },
          durationMs: 8100,
        }),
      ),
    ).toEqual(['  bash    pnpm test', '          42 passed · 1 failed · 8.1s']);
  });

  it('does not repeat a duration the outcome already ends with', () => {
    expect(
      linesOf(
        row({
          name: 'bash',
          summary: { verb: 'bash', target: 'npm test' },
          display: { summary: '4 passed · 1.0s' },
          durationMs: 1040,
        }),
      )[1],
    ).toBe('          4 passed · 1.0s');
  });

  it('omits sub-second durations and empty outcomes', () => {
    expect(
      linesOf(row({ name: 'bash', summary: { verb: 'bash', target: 'ls' }, durationMs: 40 })),
    ).toEqual(['  bash    ls']);
  });

  it('summarizes multi-line commands by their first line', () => {
    expect(
      linesOf(row({ name: 'bash', summary: { verb: 'bash', target: 'cat <<EOF\nhello\nEOF' } }))[0],
    ).toBe('  bash    cat <<EOF …');
  });

  it('moves long summaries to the second line instead of overflowing', () => {
    const lines = linesOf(
      row({
        summary: { verb: 'grep', target: 'some-quite-long-pattern-here' },
        display: { summary: '1,204 matches in 312 files (showing the first 100)' },
        width: 60,
      }),
    );
    expect(lines).toEqual([
      '  grep    some-quite-long-pattern-here',
      '          1,204 matches in 312 files (showing the first 100)',
    ]);
  });

  it('truncates long paths in the middle and long commands at the end', () => {
    const path = `src/${'deeply/nested/'.repeat(8)}file.ts`;
    const pathRow = linesOf(row({ summary: { verb: 'read', target: path }, width: 50 }))[0] ?? '';
    expect(pathRow).toMatch(/^ {2}read {4}src\/deeply.*….*file\.ts$/);
    expect(pathRow.length).toBeLessThanOrEqual(50);

    const command = `echo ${'word '.repeat(30)}`.trim();
    const commandRow =
      linesOf(row({ name: 'bash', summary: { verb: 'bash', target: command }, width: 50 }))[0] ??
      '';
    expect(commandRow.startsWith('  bash    echo word')).toBe(true);
    expect(commandRow.endsWith('…')).toBe(true);
    expect(commandRow.length).toBeLessThanOrEqual(50);
  });

  it('renders errors with their summary and up to four detail lines', () => {
    const lines = linesOf(
      row({
        name: 'bash',
        status: 'error',
        summary: { verb: 'bash', target: 'pnpm lint' },
        display: { summary: 'exit 1', lines: ['one', 'two', 'three', 'four', 'five', 'six'] },
      }),
    );
    expect(lines).toEqual([
      '  bash    pnpm lint',
      '          exit 1',
      '          one',
      '          two',
      '          three',
      '          … 3 more lines',
    ]);
  });

  it('puts web search and fetch outcomes on a second line', () => {
    expect(
      linesOf(
        row({
          name: 'web_search',
          summary: { verb: 'search', target: 'vitest 4 release notes' },
          display: { summary: '8 results' },
          durationMs: 2300,
        }),
      ),
    ).toEqual(['  search  vitest 4 release notes', '          8 results · 2.3s']);
    expect(
      linesOf(
        row({
          name: 'web_fetch',
          status: 'error',
          summary: { verb: 'fetch', target: 'example.com/docs/a.html' },
          display: { summary: 'page not accessible' },
        }),
      ),
    ).toEqual(['  fetch   example.com/docs/a.html', '          page not accessible']);
  });

  it('shortens long fetched URLs in the middle', () => {
    const target = `docs.example.com/${'section/'.repeat(12)}page.html`;
    const [first] = linesOf(
      row({ name: 'web_fetch', summary: { verb: 'fetch', target }, width: 60 }),
    );
    expect(first).toMatch(/^ {2}fetch {3}docs\.example\.com\/section\/.*….*\/page\.html$/);
    expect(first?.length).toBeLessThanOrEqual(60);
  });

  it('falls back to "failed" for errors without a summary', () => {
    expect(linesOf(row({ status: 'error' }))).toEqual(['  read    src/auth/session.ts · failed']);
  });

  it('marks declined and interrupted calls', () => {
    expect(linesOf(row({ status: 'denied' }))).toEqual([
      '  read    src/auth/session.ts · declined',
    ]);
    expect(
      linesOf(
        row({ name: 'bash', status: 'interrupted', summary: { verb: 'bash', target: 'sleep 99' } }),
      ),
    ).toEqual(['  bash    sleep 99', '          interrupted']);
  });

  it('shows the spinner and the live output tail while running', () => {
    const lines = linesOf(
      row({
        name: 'bash',
        status: 'running',
        spinnerFrame: '⠹',
        summary: { verb: 'bash', target: 'pnpm build' },
        progress: { tail: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'], totalLines: 7 },
      }),
    );
    expect(lines).toEqual([
      '⠹ bash    pnpm build',
      '          l3',
      '          l4',
      '          l5',
      '          l6',
      '          l7',
    ]);
  });

  it('shows the spinner while waiting for approval without a tail', () => {
    expect(
      linesOf(
        row({
          status: 'waiting',
          spinnerFrame: '⠋',
          progress: { tail: ['should not show'], totalLines: 1 },
        }),
      ),
    ).toEqual(['⠋ read    src/auth/session.ts']);
  });

  describe('with colors', () => {
    withColors();

    it('dims the verb normally and colors it red on error', () => {
      expect(frameOf(row({}))).toContain(`${sgr.dim}read`);
      const error = frameOf(row({ status: 'error', display: { summary: 'not found' } }));
      expect(error).toMatch(/\u001b\[31m[^\u001b]*read/);
      expect(error).toMatch(/\u001b\[31m[^\u001b]*not found/);
    });

    it('colors a failed web fetch in the danger color', () => {
      const frame = frameOf(
        row({
          name: 'web_fetch',
          status: 'error',
          summary: { verb: 'fetch', target: 'example.com' },
          display: { summary: 'rate limited' },
        }),
      );
      expect(frame).toMatch(/\u001b\[31m[^\u001b]*fetch/);
      expect(frame).toMatch(/\u001b\[31m[^\u001b]*rate limited/);
    });

    it('colors change counts and declines', () => {
      const edit = frameOf(row({ display: { diff: editDiff } }));
      expect(edit).toContain(`${sgr.green}+2`);
      expect(edit).toContain(`${sgr.red}-1`);
      expect(frameOf(row({ status: 'denied' }))).toContain(`${sgr.yellow}declined`);
    });
  });
});

describe('toolRowHeight', () => {
  const tail = { tail: ['one', 'two', 'three', 'four', 'five', 'six'], totalLines: 6 };
  it.each<[string, Partial<ToolRowProps>]>([
    ['a read', { display: { summary: '120 lines' } }],
    [
      'an edit with a diff',
      {
        name: 'edit_file',
        summary: { verb: 'edit', target: 'src/a.ts' },
        display: { diff: editDiff },
      },
    ],
    [
      'a command',
      {
        name: 'bash',
        summary: { verb: 'bash', target: 'pnpm test' },
        display: { summary: '42 passed' },
        durationMs: 8100,
      },
    ],
    [
      'a running command',
      {
        name: 'bash',
        summary: { verb: 'bash', target: 'pnpm test' },
        status: 'running',
        progress: tail,
        spinnerFrame: '⠋',
      },
    ],
    [
      'an error',
      { status: 'error', display: { summary: 'failed', lines: ['a', 'b', 'c', 'd', 'e', 'f'] } },
    ],
    ['a long summary', { display: { summary: 'x'.repeat(90) }, width: 60 }],
    [
      'a web search',
      {
        name: 'web_search',
        summary: { verb: 'search', target: 'q' },
        display: { summary: '3 results' },
      },
    ],
  ])('matches the rendered rows for %s', (_, props) => {
    const element = row(props);
    expect(toolRowHeight(element.props as ToolRowProps)).toBe(linesOf(element).length);
  });
});

describe('DiffView', () => {
  const twoHunks: FileDiff = {
    path: 'a.ts',
    added: 2,
    removed: 2,
    isNew: false,
    hunks: [
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a', '-b', '+B'] },
      {
        oldStart: 98,
        oldLines: 3,
        newStart: 98,
        newLines: 3,
        lines: [' x', '-y', '+Y', ' z', '\\ No newline at end of file'],
      },
    ],
  };

  it('renders numbered lines with hunk separators', () => {
    expect(linesOf(<DiffView diff={twoHunks} width={40} indent={2} />)).toEqual([
      '    1   a',
      '    2 - b',
      '    2 + B',
      '    ⋮',
      '   98   x',
      '   99 - y',
      '   99 + Y',
      '  100   z',
      '        \\ No newline at end of file',
    ]);
  });

  it('truncates after maxLines with a count of the rest', () => {
    expect(linesOf(<DiffView diff={twoHunks} width={40} indent={0} maxLines={4} />)).toEqual([
      ' 1   a',
      ' 2 - b',
      ' 2 + B',
      ' ⋮',
      '98   x',
      '… 4 more lines',
    ]);
  });

  it('shows fewer lines to stay within maxRows, counting wrapped rows', () => {
    expect(linesOf(<DiffView diff={twoHunks} width={40} indent={0} maxRows={4} />)).toEqual([
      '1   a',
      '2 - b',
      '2 + B',
      '… 5 more lines',
    ]);
    const wide: FileDiff = {
      ...twoHunks,
      hunks: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 3,
          lines: ['+' + 'x'.repeat(30), '+y', '+z'],
        },
      ],
    };
    expect(linesOf(<DiffView diff={wide} width={20} indent={0} maxRows={3} />)).toHaveLength(3);
    expect(linesOf(<DiffView diff={wide} width={20} indent={0} maxRows={0} />)).toEqual(['']);
  });

  it.each([
    ['wrap', undefined],
    ['wrap', 5],
    ['truncate', 5],
    ['truncate', undefined],
  ] as const)('measures its height (%s, maxRows %s)', (overflow, maxRows) => {
    const options = { width: 16, indent: 2, overflow, maxRows, maxLines: 6 };
    const lines = linesOf(<DiffView diff={twoHunks} {...options} />);
    expect(measureDiffView(twoHunks, options).height).toBe(lines.length);
  });

  it('wraps long lines under the text column by default', () => {
    const diff: FileDiff = {
      path: 'a.ts',
      added: 1,
      removed: 0,
      isNew: false,
      hunks: [
        { oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [`+${'x'.repeat(30)}`] },
      ],
    };
    expect(linesOf(<DiffView diff={diff} width={20} indent={0} />)).toEqual([
      `1 + ${'x'.repeat(16)}`,
      `    ${'x'.repeat(14)}`,
    ]);
    expect(linesOf(<DiffView diff={diff} width={20} indent={0} overflow="truncate" />)).toEqual([
      `1 + ${'x'.repeat(15)}…`,
    ]);
  });

  it('expands tabs and strips control sequences from diff text', () => {
    const diff: FileDiff = {
      path: 'a.ts',
      added: 1,
      removed: 0,
      isNew: false,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+\tx\u001b[31m'] }],
    };
    expect(linesOf(<DiffView diff={diff} width={40} indent={0} />)).toEqual(['1 +     x']);
  });

  describe('with colors', () => {
    withColors();

    it('colors additions green, removals red and context dim', () => {
      const frame = frameOf(<DiffView diff={twoHunks} width={40} indent={0} />);
      const [context, removed, added] = frame.split('\n');
      expect(context).toContain(sgr.dim);
      expect(context).not.toMatch(/\u001b\[3[12]m/);
      expect(removed).toContain(`${sgr.red} - b`);
      expect(added).toContain(`${sgr.green} + B`);
    });
  });
});

describe('GitDiffView', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    'index 1111111..2222222 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,2 +1,2 @@',
    ' keep',
    '-old',
    '+new',
  ].join('\n');

  it('prints the diff and lists untracked files', () => {
    expect(
      linesOf(<GitDiffView diff={diff} untracked={['notes.md', 'tmp.txt']} width={60} />),
    ).toEqual([...diff.split('\n'), '', 'Untracked: notes.md, tmp.txt']);
  });

  it('truncates with a pointer to git diff', () => {
    expect(linesOf(<GitDiffView diff={diff} untracked={[]} maxLines={3} width={60} />)).toEqual([
      'diff --git a/a.ts b/a.ts',
      'index 1111111..2222222 100644',
      '--- a/a.ts',
      '… 5 more lines (run git diff for the full output)',
    ]);
  });

  it('caps long untracked lists', () => {
    const files = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
    const text = linesOf(<GitDiffView diff="" untracked={files} width={400} />).join('\n');
    expect(text).toContain('f19.ts and 5 more');
    expect(text).not.toContain('f20.ts');
  });

  it('says when there is nothing to show', () => {
    expect(linesOf(<GitDiffView diff="" untracked={[]} width={60} />)).toEqual(['No changes.']);
  });

  describe('with colors', () => {
    withColors();

    it('colors headers, hunks, additions and deletions', () => {
      const lines = frameOf(<GitDiffView diff={diff} untracked={[]} width={60} />).split('\n');
      expect(lines[0]).toContain(`${sgr.bold}diff --git`);
      expect(lines[1]).not.toContain('\u001b[');
      expect(lines[2]).toContain(`${sgr.bold}---`);
      expect(lines[3]).toContain(`${sgr.bold}+++`);
      expect(lines[4]).toContain(`${sgr.cyan}@@`);
      expect(lines[5]).not.toContain('\u001b[');
      expect(lines[6]).toContain(`${sgr.red}-old`);
      expect(lines[7]).toContain(`${sgr.green}+new`);
    });
  });
});
