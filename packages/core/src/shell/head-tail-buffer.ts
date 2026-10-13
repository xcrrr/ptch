import { formatCount } from '@patch/shared';

const HEAD_RATIO = 0.4;
const NEWLINE_BYTE = 0x0a;

export interface BufferedText {
  text: string;
  /** True when the middle was dropped and replaced by a marker line. */
  truncated: boolean;
}

/**
 * Retains at most `maxBytes` (UTF-8) of appended text: the first 40% and the most recent 60%.
 * When text had to be dropped, `finish()` joins the two parts with an explicit
 * `... N bytes omitted ...` line. Cuts never split a multi-byte character and prefer line
 * boundaries.
 */
export class HeadTailBuffer {
  private head = '';
  private headBytes = 0;
  private headFull = false;
  private tail = '';
  private tailBytes = 0;
  /** True when the retained tail begins exactly at the start of a line. */
  private tailStartsLine = false;
  private totalBytes = 0;
  private readonly maxBytes: number;
  private readonly headLimit: number;
  private readonly tailLimit: number;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(2, Math.floor(maxBytes));
    this.headLimit = Math.floor(this.maxBytes * HEAD_RATIO);
    this.tailLimit = this.maxBytes - this.headLimit;
  }

  append(text: string): void {
    if (text === '') return;
    const bytes = Buffer.byteLength(text);
    this.totalBytes += bytes;
    if (!this.headFull) {
      if (this.headBytes + bytes <= this.headLimit) {
        this.head += text;
        this.headBytes += bytes;
        return;
      }
      const [first, rest] = splitAtByte(text, this.headLimit - this.headBytes);
      this.head += first;
      this.headBytes += Buffer.byteLength(first);
      this.headFull = true;
      text = rest;
    }
    this.tail += text;
    this.tailBytes += Buffer.byteLength(text);
    // Trimming lazily (at twice the limit) keeps appends amortized O(n).
    if (this.tailBytes > 2 * this.tailLimit) this.trimTail();
  }

  finish(): BufferedText {
    if (this.totalBytes <= this.maxBytes) return { text: this.head + this.tail, truncated: false };
    this.trimTail();
    const head = cutHeadAtLine(this.head);
    const tail = this.tailStartsLine ? this.tail : cutTailAtLine(this.tail);
    const omitted = this.totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail);
    const separator = head === '' || head.endsWith('\n') ? '' : '\n';
    return {
      text: `${head}${separator}... ${formatCount(omitted)} bytes omitted ...\n${tail}`,
      truncated: true,
    };
  }

  private trimTail(): void {
    if (this.tailBytes <= this.tailLimit) return;
    const bytes = Buffer.from(this.tail);
    let start = bytes.length - this.tailLimit;
    while (start < bytes.length && isContinuationByte(bytes[start])) start++;
    this.tailStartsLine = bytes[start - 1] === NEWLINE_BYTE;
    this.tail = bytes.subarray(start).toString('utf8');
    this.tailBytes = bytes.length - start;
  }
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/** Splits `text` so the first part has at most `maxBytes` bytes and ends on a character boundary. */
function splitAtByte(text: string, maxBytes: number): [string, string] {
  const bytes = Buffer.from(text);
  let end = Math.max(0, Math.min(maxBytes, bytes.length));
  while (end > 0 && end < bytes.length && isContinuationByte(bytes[end])) end--;
  return [bytes.subarray(0, end).toString('utf8'), bytes.subarray(end).toString('utf8')];
}

/** Ends the head after its last complete line, unless that would discard more than half of it. */
function cutHeadAtLine(head: string): string {
  const newline = head.lastIndexOf('\n');
  return newline >= head.length / 2 ? head.slice(0, newline + 1) : head;
}

/** Starts the tail at its first complete line, unless that would discard more than half of it. */
function cutTailAtLine(tail: string): string {
  const newline = tail.indexOf('\n');
  return newline !== -1 && newline < tail.length / 2 ? tail.slice(newline + 1) : tail;
}
