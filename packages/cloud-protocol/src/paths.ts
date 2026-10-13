/**
 * File names are data, never markup or terminal input. A name with a control character (newline,
 * ESC, NUL), a C1 control, a zero-width or bidirectional-override character can forge a line in a
 * log, a diff header or a Markdown document, or hide its real extension. These helpers decide
 * which names are safe to print and store raw.
 */

/** Code point ranges that are never printed raw: C0 and C1 controls, zero-width, line/paragraph
 * separators, bidirectional embeddings, overrides and isolates, and the byte order mark. */
const UNPRINTABLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function isUnprintable(codePoint: number): boolean {
  return UNPRINTABLE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
}

/** True when the name contains a control, zero-width or bidirectional-override character. */
export function hasUnprintableChars(text: string): boolean {
  for (const ch of text) {
    if (isUnprintable(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/**
 * The name made printable: unprintable characters become `\uXXXX` escapes (a newline becomes
 * `\u000a`), the result is cut to `max` characters. Safe to put in a log line or a skipped-file
 * note; not for use as a real path.
 */
export function printablePath(text: string, max = 200): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    out += isUnprintable(cp) ? `\\u${cp.toString(16).padStart(4, '0')}` : ch;
    if (out.length > max * 6) break;
  }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
