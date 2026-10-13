import { describe, expect, it } from 'vitest';
import {
  collapseCarriageReturns,
  LineSplitter,
  stripTerminalEscapes,
  TerminalStreamSanitizer,
} from '../../src/shell/terminal-text.js';

describe('stripTerminalEscapes', () => {
  it('removes SGR colors, cursor movement and erase sequences', () => {
    expect(stripTerminalEscapes('\x1b[1;31mError\x1b[0m: \x1b[2K\x1b[1Afailed\x1b[?25l')).toBe(
      'Error: failed',
    );
  });

  it('removes OSC titles and hyperlinks terminated by BEL or ST', () => {
    expect(stripTerminalEscapes('\x1b]0;my title\x07ok')).toBe('ok');
    expect(
      stripTerminalEscapes('see \x1b]8;;https://example.com/a?b=c\x1b\\docs\x1b]8;;\x1b\\ here'),
    ).toBe('see docs here');
  });

  it('removes stray control characters but keeps tabs, newlines and carriage returns', () => {
    expect(stripTerminalEscapes('a\x07b\x00c\x08d\x7fe\tf\r\ng\rh')).toBe('abcde\tf\r\ng\rh');
  });

  it('leaves plain and non-ASCII text untouched', () => {
    const text = 'zażółć 日本 🎉 [not an escape] 100%';
    expect(stripTerminalEscapes(text)).toBe(text);
  });
});

describe('collapseCarriageReturns', () => {
  it('keeps the text after the last lone carriage return', () => {
    expect(collapseCarriageReturns('10%\r50%\r100%')).toBe('100%');
  });

  it('ignores trailing carriage returns such as the CR of CRLF', () => {
    expect(collapseCarriageReturns('done\r')).toBe('done');
    expect(collapseCarriageReturns('a\rb\r\r')).toBe('b');
  });

  it('returns lines without carriage returns unchanged', () => {
    expect(collapseCarriageReturns('plain line')).toBe('plain line');
    expect(collapseCarriageReturns('')).toBe('');
  });

  it('returns an empty string for a line of only carriage returns', () => {
    expect(collapseCarriageReturns('\r\r')).toBe('');
  });
});

describe('TerminalStreamSanitizer', () => {
  function feed(chunks: string[]): string[] {
    const sanitizer = new TerminalStreamSanitizer();
    const out = chunks.map((chunk) => sanitizer.push(chunk));
    out.push(sanitizer.flush());
    return out;
  }

  it('holds back a CSI sequence split across chunks', () => {
    expect(feed(['\x1b[3', '1mred\x1b', '[0m done'])).toEqual(['', 'red', ' done', '']);
  });

  it('holds back an OSC sequence until its terminator arrives', () => {
    expect(feed(['a\x1b]8;;https://exa', 'mple.com\x07link', '\n'])).toEqual([
      'a',
      'link',
      '\n',
      '',
    ]);
  });

  it('drops an unfinished escape sequence at the end of the stream', () => {
    expect(feed(['text\x1b[3'])).toEqual(['text', '']);
  });

  it('releases text after an escape character that cannot start a sequence', () => {
    const sanitizer = new TerminalStreamSanitizer();
    expect(sanitizer.push('a\x1b')).toBe('a');
    expect(sanitizer.push('[31mb')).toBe('b');
    const longTail = `\x1b]${'x'.repeat(300)}`;
    expect(sanitizer.push(longTail)).toBe(stripTerminalEscapes(longTail));
  });

  it('passes text without escapes through immediately', () => {
    expect(feed(['hello ', 'world\r\n'])).toEqual(['hello ', 'world\r\n', '']);
  });
});

describe('LineSplitter', () => {
  function collect(chunks: string[], maxPending?: number) {
    const splitter = new LineSplitter(maxPending);
    const lines: Array<[string, boolean]> = [];
    for (const chunk of chunks)
      splitter.push(chunk, (line, terminated) => lines.push([line, terminated]));
    splitter.flush((line, terminated) => lines.push([line, terminated]));
    return lines;
  }

  it('joins lines split across chunks and reports the unterminated rest on flush', () => {
    expect(collect(['al', 'pha\nbe', 'ta\ngam', 'ma'])).toEqual([
      ['alpha', true],
      ['beta', true],
      ['gamma', false],
    ]);
  });

  it('keeps a CRLF split across chunks intact', () => {
    expect(collect(['one\r', '\ntwo\r\n'])).toEqual([
      ['one\r', true],
      ['two\r', true],
    ]);
  });

  it('drops overwritten progress text while the line is still pending', () => {
    const splitter = new LineSplitter();
    for (let i = 0; i <= 10_000; i++) splitter.push(`\rprogress ${i}`, () => {});
    expect(splitter.pending).toBe('progress 10000');
    splitter.push('\r', () => {});
    expect(splitter.pending).toBe('progress 10000\r');
    const lines: string[] = [];
    splitter.push('\n', (line) => lines.push(collapseCarriageReturns(line)));
    expect(lines).toEqual(['progress 10000']);
  });

  it('hands out an overlong pending line early', () => {
    expect(collect(['x'.repeat(5), 'y'.repeat(6), 'z\n'], 8)).toEqual([
      ['xxxxxyyyyyy', false],
      ['z', true],
    ]);
  });

  it('emits empty lines for consecutive newlines', () => {
    expect(collect(['a\n\n\nb\n'])).toEqual([
      ['a', true],
      ['', true],
      ['', true],
      ['b', true],
    ]);
  });
});
