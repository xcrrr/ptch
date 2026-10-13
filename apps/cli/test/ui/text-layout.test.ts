import { describe, expect, it } from 'vitest';
import {
  displayWidth,
  expandTabs,
  hardWrap,
  nextGraphemeBoundary,
  padEndToWidth,
  padStartToWidth,
  previousGraphemeBoundary,
  snapToCodePoint,
  toDisplayText,
  truncateToWidth,
  wrapAtWhitespace,
} from '../../src/ui/text-layout.js';

describe('truncateToWidth', () => {
  it('leaves text that fits untouched', () => {
    expect(truncateToWidth('short', 5)).toBe('short');
  });

  it('cuts at the end, start or middle with an ellipsis', () => {
    expect(truncateToWidth('abcdefghij', 6)).toBe('abcde…');
    expect(truncateToWidth('abcdefghij', 6, 'start')).toBe('…fghij');
    expect(truncateToWidth('src/a/b/c/file.ts', 11, 'middle')).toBe('src/a…le.ts');
  });

  it('measures wide characters by columns and never splits graphemes', () => {
    const cut = truncateToWidth('日本語テキスト', 7);
    expect(cut).toBe('日本語…');
    expect(displayWidth(cut)).toBeLessThanOrEqual(7);
    expect(truncateToWidth('👍🏽👍🏽👍🏽', 5)).toBe('👍🏽👍🏽…');
  });

  it('handles degenerate widths', () => {
    expect(truncateToWidth('abc', 0)).toBe('');
    expect(truncateToWidth('abc', 1)).toBe('…');
  });
});

describe('wrapping', () => {
  it('hardWrap splits by columns', () => {
    expect(hardWrap('abcdefg', 3)).toEqual(['abc', 'def', 'g']);
    expect(hardWrap('日本語', 4)).toEqual(['日本', '語']);
    expect(hardWrap('', 3)).toEqual(['']);
  });

  it('wrapAtWhitespace breaks between words and drops trailing spaces', () => {
    expect(wrapAtWhitespace('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(wrapAtWhitespace('  indented code here', 12)).toEqual(['  indented', 'code here']);
  });

  it('wrapAtWhitespace splits words longer than the width as a last resort', () => {
    expect(wrapAtWhitespace('a bcdefghij k', 4)).toEqual(['a', 'bcde', 'fghi', 'j k']);
  });
});

describe('padding and cleanup', () => {
  it('pads by display width', () => {
    expect(padEndToWidth('日本', 6)).toBe('日本  ');
    expect(padStartToWidth('7', 3)).toBe('  7');
    expect(padEndToWidth('toolong', 3)).toBe('toolong');
  });

  it('expands tabs to tab stops', () => {
    expect(expandTabs('\tx')).toBe('    x');
    expect(expandTabs('ab\tc\n\td')).toBe('ab  c\n    d');
  });

  it('toDisplayText removes ANSI and control characters and normalizes newlines', () => {
    expect(toDisplayText('\u001b[1mbold\u001b[22m\r\nnext\rlast\u0007\tend')).toBe(
      'bold\nnext\nlast    end',
    );
  });
});

describe('grapheme boundaries', () => {
  it('steps over surrogate pairs and combined emoji', () => {
    const text = 'a😀b👨‍👩‍👧c';
    expect(nextGraphemeBoundary(text, 1)).toBe(3);
    expect(previousGraphemeBoundary(text, 3)).toBe(1);
    const familyStart = 4;
    const familyEnd = text.length - 1;
    expect(nextGraphemeBoundary(text, familyStart)).toBe(familyEnd);
    expect(previousGraphemeBoundary(text, familyEnd)).toBe(familyStart);
  });

  it('clamps at the ends', () => {
    expect(previousGraphemeBoundary('abc', 0)).toBe(0);
    expect(nextGraphemeBoundary('abc', 3)).toBe(3);
  });

  it('snapToCodePoint never points inside a surrogate pair', () => {
    expect(snapToCodePoint('a😀', 2)).toBe(1);
    expect(snapToCodePoint('a😀', 3)).toBe(3);
    expect(snapToCodePoint('abc', 9)).toBe(3);
  });
});
