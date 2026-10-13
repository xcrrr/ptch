import { describe, expect, it } from 'vitest';
import { HeadTailBuffer } from '../../src/shell/head-tail-buffer.js';

function fill(maxBytes: number, pieces: string[]) {
  const buffer = new HeadTailBuffer(maxBytes);
  for (const piece of pieces) buffer.append(piece);
  return buffer.finish();
}

function parseMarker(text: string): { omitted: number; marker: string } {
  const match = /\.\.\. ([\d,]+) bytes omitted \.\.\.\n/.exec(text);
  if (!match) throw new Error(`no marker in ${JSON.stringify(text)}`);
  return { omitted: Number(match[1]!.replace(/,/g, '')), marker: match[0] };
}

describe('HeadTailBuffer', () => {
  it('keeps everything when the total fits', () => {
    const pieces = ['first\n', 'second\n', 'third'];
    expect(fill(1024, pieces)).toEqual({ text: pieces.join(''), truncated: false });
  });

  it('keeps everything at exactly the limit', () => {
    const text = 'x'.repeat(100);
    expect(fill(100, [text.slice(0, 30), text.slice(30)])).toEqual({ text, truncated: false });
  });

  it('keeps the head and the most recent tail with an exact omitted-bytes marker', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${String(i).padStart(4, '0')}\n`);
    const total = lines.join('');
    const result = fill(1000, lines);

    expect(result.truncated).toBe(true);
    expect(result.text.startsWith('line 0000\nline 0001\n')).toBe(true);
    expect(result.text.endsWith('line 0998\nline 0999\n')).toBe(true);
    const { omitted, marker } = parseMarker(result.text);
    const kept = Buffer.byteLength(result.text) - Buffer.byteLength(marker);
    expect(kept + omitted).toBe(Buffer.byteLength(total));
    expect(kept).toBeLessThanOrEqual(1000);
    // Both cuts land on line boundaries.
    for (const line of result.text.split('\n').filter((l) => l && !l.startsWith('...'))) {
      expect(line).toMatch(/^line \d{4}$/);
    }
  });

  it('gives the tail more room than the head', () => {
    const result = fill(
      1000,
      Array.from({ length: 500 }, (_, i) => `${i}`.padEnd(9, '.') + '\n'),
    );
    const [head, tail] = result.text.split(/\.\.\. [\d,]+ bytes omitted \.\.\.\n/);
    expect(Buffer.byteLength(head!)).toBeLessThanOrEqual(400);
    expect(Buffer.byteLength(tail!)).toBeLessThanOrEqual(600);
    expect(Buffer.byteLength(tail!)).toBeGreaterThan(Buffer.byteLength(head!));
  });

  it('never splits multi-byte characters', () => {
    const piece = 'zażółć 日本 🎉 ';
    const result = fill(
      101,
      Array.from({ length: 200 }, () => piece),
    );
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain('�');
    const { omitted, marker } = parseMarker(result.text);
    const kept = Buffer.byteLength(result.text) - Buffer.byteLength(marker) - 1;
    expect(kept + omitted).toBe(Buffer.byteLength(piece) * 200);
  });

  it('handles a single append far larger than the limit', () => {
    const text = `${'a'.repeat(5000)}${'b'.repeat(5000)}`;
    const result = fill(100, [text]);
    expect(result.truncated).toBe(true);
    expect(result.text).toMatch(/^a{40}\n\.\.\. 9,900 bytes omitted \.\.\.\nb{60}$/);
  });
});
