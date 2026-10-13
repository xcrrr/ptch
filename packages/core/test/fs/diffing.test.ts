import { describe, expect, it } from 'vitest';
import { computeFileDiff, formatFileDiff } from '../../src/fs/diffing.js';

const numbered = (count: number, prefix = 'line') =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n') + '\n';

describe('computeFileDiff', () => {
  it('describes a modification with three lines of context', () => {
    const before = numbered(10);
    const after = before.replace('line 5\n', 'line five\nline 5.5\n');
    const diff = computeFileDiff('src/a.ts', before, after);
    expect(diff).toMatchObject({ path: 'src/a.ts', added: 2, removed: 1, isNew: false });
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]).toEqual({
      oldStart: 2,
      oldLines: 7,
      newStart: 2,
      newLines: 8,
      lines: [
        ' line 2',
        ' line 3',
        ' line 4',
        '-line 5',
        '+line five',
        '+line 5.5',
        ' line 6',
        ' line 7',
        ' line 8',
      ],
    });
  });

  it('splits distant changes into separate hunks', () => {
    const before = numbered(40);
    const after = before.replace('line 3\n', 'LINE 3\n').replace('line 30\n', 'LINE 30\n');
    const diff = computeFileDiff('a.txt', before, after);
    expect(diff.hunks).toHaveLength(2);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(2);
  });

  it('treats an undefined old text as a new file', () => {
    const diff = computeFileDiff('new.ts', undefined, 'a\nb\n');
    expect(diff).toMatchObject({ isNew: true, added: 2, removed: 0 });
    expect(diff.hunks[0].lines).toEqual(['+a', '+b']);
  });

  it('reports no hunks for identical content', () => {
    const diff = computeFileDiff('a.txt', 'same\n', 'same\n');
    expect(diff).toMatchObject({ added: 0, removed: 0, hunks: [] });
    expect(formatFileDiff(diff)).toBe('');
  });

  it('keeps "no newline at end of file" markers out of the counts', () => {
    const diff = computeFileDiff('a.txt', 'a\nb', 'a\nc');
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.hunks[0].lines).toContain('\\ No newline at end of file');
  });

  it('describes deleting everything', () => {
    const diff = computeFileDiff('a.txt', 'a\nb\n', '');
    expect(diff).toMatchObject({ added: 0, removed: 2, isNew: false });
  });
});

describe('formatFileDiff', () => {
  it('renders a unified diff', () => {
    const diff = computeFileDiff('src/a.ts', 'a\nb\nc\n', 'a\nB\nc\n');
    expect(formatFileDiff(diff)).toBe(
      ['--- src/a.ts', '+++ src/a.ts', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'].join('\n'),
    );
  });

  it('renders new files against /dev/null with an empty old range', () => {
    const diff = computeFileDiff('new.ts', undefined, 'x\n');
    expect(formatFileDiff(diff)).toBe(
      ['--- /dev/null', '+++ new.ts', '@@ -0,0 +1,1 @@', '+x'].join('\n'),
    );
  });
});
