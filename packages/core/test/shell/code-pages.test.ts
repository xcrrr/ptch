import { describe, expect, it } from 'vitest';
import {
  codePageDecoder,
  ConsoleOutputDecoder,
  parseActiveCodePage,
  UTF8_CODE_PAGE,
  windowsConsoleCodePage,
} from '../../src/shell/code-pages.js';

const bytes = (...values: number[]) => Buffer.from(values);
const upperHalf = bytes(...Array.from({ length: 128 }, (_, i) => 0x80 + i));

describe('codePageDecoder', () => {
  it('decodes the OEM code pages of Windows consoles', () => {
    // "zażółć" as cmd's built-ins write it on a Polish system.
    expect(codePageDecoder(852)!(bytes(0x7a, 0x61, 0xbe, 0xa2, 0x88, 0x86))).toBe('zażółć');
    expect(codePageDecoder(437)!(bytes(0x63, 0x61, 0x66, 0x82, 0x20, 0x81, 0xe1))).toBe('café üß');
    expect(codePageDecoder(850)!(bytes(0x90, 0xa5, 0xd5))).toBe('ÉÑı');
    expect(codePageDecoder(858)!(bytes(0xd5))).toBe('€');
    expect(codePageDecoder(866)!(bytes(0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2))).toBe('Привет');
  });

  it('maps every byte of the single-byte code pages to one character, keeping ASCII', () => {
    const ascii = bytes(...Array.from({ length: 128 }, (_, i) => i));
    for (const codePage of [437, 720, 737, 775, 850, 852, 855, 857, 858, 860, 861, 862, 863]) {
      const decode = codePageDecoder(codePage)!;
      expect(decode(ascii)).toBe(ascii.toString('latin1'));
      const high = decode(upperHalf);
      expect(high).toHaveLength(128);
      expect(high).not.toContain('�');
    }
    for (const codePage of [864, 865, 866, 869]) {
      expect(codePageDecoder(codePage)!(upperHalf)).toHaveLength(128);
    }
  });

  it('decodes multi-byte console code pages with TextDecoder', () => {
    expect(codePageDecoder(932)!(bytes(0x93, 0xfa, 0x96, 0x7b))).toBe('日本');
    expect(codePageDecoder(936)!(bytes(0xd6, 0xd0, 0xce, 0xc4))).toBe('中文');
    expect(codePageDecoder(1250)!(bytes(0xb3, 0xbf))).toBe('łż');
  });

  it('returns undefined for UTF-8 and unknown code pages', () => {
    expect(codePageDecoder(UTF8_CODE_PAGE)).toBeUndefined();
    expect(codePageDecoder(12_345)).toBeUndefined();
  });
});

describe('ConsoleOutputDecoder', () => {
  const cp852 = codePageDecoder(852)!;
  const utf8 = (text: string) => Buffer.from(text, 'utf8');
  const oem = (...values: number[]) => bytes(...values);

  function decodeAll(chunks: Buffer[]): { text: string; parts: string[] } {
    const decoder = new ConsoleOutputDecoder(cp852);
    const parts = chunks.map((chunk) => decoder.write(chunk));
    parts.push(decoder.end());
    return { text: parts.join(''), parts };
  }

  it('decodes each line as UTF-8 when it is valid UTF-8 and in the code page otherwise', () => {
    const output = Buffer.concat([
      utf8('git: zażółć 日本\n'),
      oem(0x63, 0x6d, 0x64, 0x3a, 0x20, 0x7a, 0x61, 0xbe, 0xa2, 0x88, 0x86, 0x0d, 0x0a),
      utf8('🎉 done\n'),
    ]);
    expect(decodeAll([output]).text).toBe('git: zażółć 日本\ncmd: zażółć\r\n🎉 done\n');
  });

  it('keeps UTF-8 characters split across chunks intact', () => {
    const text = 'zażółć gęślą jaźń 日本語 🎉\n';
    const encoded = utf8(text);
    const { text: decoded } = decodeAll([...encoded].map((byte) => bytes(byte)));
    expect(decoded).toBe(text);
  });

  it('passes ASCII on at once and holds other bytes until their line ends', () => {
    const decoder = new ConsoleOutputDecoder(cp852);
    expect(decoder.write(utf8('progress '))).toBe('progress ');
    expect(decoder.write(oem(0xbe, 0x20))).toBe('');
    expect(decoder.write(oem(0x35, 0x30, 0x25, 0x0d))).toBe('ż 50%\r');
    expect(decoder.write(utf8('ż 100%'))).toBe('');
    expect(decoder.end()).toBe('ż 100%');
  });

  it('passes on redraws that use escape sequences instead of line breaks', () => {
    const decoder = new ConsoleOutputDecoder(cp852);
    // A spinner that moves the cursor back (ESC [1G) and redraws, in the console code page.
    expect(decoder.write(Buffer.concat([oem(0xbe), utf8(' 1/2 \u001b[1G')]))).toBe(
      'ż 1/2 \u001b[1G',
    );
    expect(decoder.write(utf8('⠙ 2/2 \u001b[1G'))).toBe('⠙ 2/2 \u001b[1G');
    expect(decoder.end()).toBe('');
  });

  it('decodes an unfinished line at the end of the stream', () => {
    expect(decodeAll([oem(0x61, 0x88)]).text).toBe('ał');
    // A UTF-8 character cut off by the end of the stream becomes U+FFFD, the rest stays UTF-8.
    expect(decodeAll([utf8('zażółć'), bytes(0xe6, 0x97)]).text).toBe('zażółć�');
  });

  it('does not hold more than 64 KiB of an unfinished line', () => {
    const line = utf8('ż'.repeat(40_000));
    const decoder = new ConsoleOutputDecoder(cp852);
    // The chunk ends inside the last character, which stays held.
    const first = decoder.write(line.subarray(0, line.length - 1));
    expect(first).toBe('ż'.repeat(39_999));
    expect(decoder.write(line.subarray(line.length - 1))).toBe('');
    expect(decoder.end()).toBe('ż');

    const legacy = new ConsoleOutputDecoder(cp852);
    expect(legacy.write(Buffer.alloc(70_000, 0xbe))).toBe('ż'.repeat(70_000));
    expect(legacy.end()).toBe('');
  });
});

describe('parseActiveCodePage', () => {
  it("reads the code page from chcp's output in any language", () => {
    expect(parseActiveCodePage('Active code page: 437\r\n')).toBe(437);
    expect(parseActiveCodePage('Aktywna strona kodowa: 852.\r\n')).toBe(852);
    expect(parseActiveCodePage('Page de codes active : 850\r\n')).toBe(850);
    expect(parseActiveCodePage('')).toBeUndefined();
    expect(parseActiveCodePage('no number')).toBeUndefined();
  });
});

describe('windowsConsoleCodePage', () => {
  it('reports the console code page on Windows only, and queries it once', async () => {
    const codePage = await windowsConsoleCodePage();
    if (process.platform === 'win32') {
      expect(Number.isInteger(codePage) && codePage! > 0).toBe(true);
    } else {
      expect(codePage).toBeUndefined();
    }
    expect(windowsConsoleCodePage()).toBe(windowsConsoleCodePage());
  });
});
