import { stripAnsi } from '@patch/shared';

/** OSC sequences (window titles, hyperlinks) terminated by BEL or ST, which stripAnsi misses. */
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** C0 controls and DEL, except tab, LF and CR (CR is resolved per line, see below). */
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Unterminated CSI (`ESC [` / 0x9B plus parameter and intermediate bytes) or `ESC` + intermediates. */
const PARTIAL_CSI_OR_ESCAPE = /^(?:(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*|\x1b[\x20-\x2f]*)$/;
const OSC_TERMINATOR = /\x07|\x1b\\/;

/** Longest incomplete escape sequence held back between chunks before it is treated as text. */
const MAX_HELD_ESCAPE_CHARS = 256;

/**
 * Removes terminal escape sequences and stray control characters. Newlines, tabs and carriage
 * returns are preserved.
 */
export function stripTerminalEscapes(text: string): string {
  return stripAnsi(text.replace(OSC_SEQUENCE, '')).replace(CONTROL_CHARS, '');
}

/**
 * Resolves carriage-return overwrites the way a terminal shows them for a single line: the text
 * after the last lone `\r` wins. Trailing `\r`s (e.g. from CRLF) are ignored.
 */
export function collapseCarriageReturns(line: string): string {
  if (!line.includes('\r')) return line;
  const end = lastNonCarriageReturn(line);
  return line.slice(line.lastIndexOf('\r', end) + 1, end + 1);
}

function lastNonCarriageReturn(text: string): number {
  let index = text.length - 1;
  while (index >= 0 && text[index] === '\r') index--;
  return index;
}

/**
 * Strips escape sequences from streamed text. A sequence split across chunks is held back until
 * the next chunk completes it, so fragments like `[32m` never leak into the output.
 */
export class TerminalStreamSanitizer {
  private held = '';

  push(text: string): string {
    const input = this.held + text;
    const cut = incompleteEscapeStart(input);
    this.held = cut === -1 ? '' : input.slice(cut);
    return stripTerminalEscapes(cut === -1 ? input : input.slice(0, cut));
  }

  flush(): string {
    const rest = this.held;
    this.held = '';
    return stripTerminalEscapes(rest);
  }
}

function incompleteEscapeStart(text: string): number {
  const osc = text.lastIndexOf('\x1b]');
  if (
    osc !== -1 &&
    text.length - osc <= MAX_HELD_ESCAPE_CHARS &&
    !OSC_TERMINATOR.test(text.slice(osc + 2))
  ) {
    return osc;
  }
  const start = Math.max(text.lastIndexOf('\x1b'), text.lastIndexOf('\x9b'));
  if (start === -1 || text.length - start > MAX_HELD_ESCAPE_CHARS) return -1;
  return PARTIAL_CSI_OR_ESCAPE.test(text.slice(start)) ? start : -1;
}

/** Receives one line without its `\n`; `terminated` is false for text not followed by `\n`. */
export type LineHandler = (line: string, terminated: boolean) => void;

/**
 * Splits streamed text into lines. The unfinished last line is buffered; text overwritten by a
 * later lone `\r` is dropped as it arrives, so carriage-return progress bars never accumulate.
 * An unfinished line longer than `maxPendingChars` is handed out early (unterminated).
 */
export class LineSplitter {
  private partial = '';

  constructor(private readonly maxPendingChars = 64 * 1024) {}

  /** The buffered, unfinished last line. */
  get pending(): string {
    return this.partial;
  }

  push(text: string, onLine: LineHandler): void {
    let start = 0;
    let newline = text.indexOf('\n');
    if (newline !== -1) {
      onLine(this.partial + text.slice(0, newline), true);
      this.partial = '';
      start = newline + 1;
      while ((newline = text.indexOf('\n', start)) !== -1) {
        onLine(text.slice(start, newline), true);
        start = newline + 1;
      }
    }
    const rest = text.slice(start);
    const mayOverwrite = rest.includes('\r') || this.partial.endsWith('\r');
    this.partial += rest;
    if (mayOverwrite) this.partial = dropOverwrittenText(this.partial);
    if (this.partial.length > this.maxPendingChars) {
      onLine(this.partial, false);
      this.partial = '';
    }
  }

  flush(onLine: LineHandler): void {
    if (this.partial === '') return;
    const rest = this.partial;
    this.partial = '';
    onLine(rest, false);
  }
}

/** Keeps only the text after the last lone `\r`, plus any trailing `\r`s (a possible CRLF). */
function dropOverwrittenText(partial: string): string {
  const end = lastNonCarriageReturn(partial);
  const cr = partial.lastIndexOf('\r', end);
  return cr === -1 ? partial : partial.slice(cr + 1);
}
