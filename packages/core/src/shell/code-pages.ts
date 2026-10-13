import { isUtf8 } from 'node:buffer';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { system32Path } from './system32.js';

/** Decodes a complete run of bytes (no partial characters at either end). */
export type BytesDecoder = (bytes: Uint8Array) => string;

/** Incremental decoder with the shape of Node's StringDecoder. */
export interface TextStreamDecoder {
  write(chunk: Buffer): string;
  end(): string;
}

/**
 * Bytes 0x80-0xFF of the single-byte OEM code pages that Windows consoles use, as Windows maps
 * them (taken from the system's code page tables). Bytes below 0x80 are ASCII in all of them.
 */
const OEM_UPPER_HALVES: Readonly<Record<number, string>> = {
  437:
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
    '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00A0',
  720:
    '\u0080\u0081éâ\u0084à\u0086çêëèïî\u008D\u008E\u008F\u0090\u0651\u0652ô¤ـûùءآأؤ£إئابةتثجحخدذرزسشص«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
    '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀ضطظعغفµقكلمنهوىي≡\u064B\u064C\u064D\u064E\u064F\u0650≈°∙·√ⁿ²■\u00A0',
  737:
    'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρσςτυφχψ░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
    '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀ωάέήϊίόύϋώΆΈΉΊΌΎΏ±≥≤ΪΫ÷≈°∙·√ⁿ²■\u00A0',
  775:
    'ĆüéāäģåćłēŖŗīŹÄÅÉæÆōöĢ¢ŚśÖÜø£Ø×¤ĀĪóŻżź”¦©®¬½¼Ł«»░▒▓│┤ĄČĘĖ╣║╗╝ĮŠ┐' +
    '└┴┬├─┼ŲŪ╚╔╩╦╠═╬Žąčęėįšųūž┘┌█▄▌▐▀ÓßŌŃõÕµńĶķĻļņĒŅ’\u00AD±“¾¶§÷„°∙·¹³²■\u00A0',
  850:
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' +
    '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00AD±‗¾¶§÷¸°¨·¹³²■\u00A0',
  852:
    'ÇüéâäůćçłëŐőîŹÄĆÉĹĺôöĽľŚśÖÜŤťŁ×čáíóúĄąŽžĘę¬źČş«»░▒▓│┤ÁÂĚŞ╣║╗╝Żż┐' +
    '└┴┬├─┼Ăă╚╔╩╦╠═╬¤đĐĎËďŇÍÎě┘┌█▄ŢŮ▀ÓßÔŃńňŠšŔÚŕŰýÝţ´\u00AD˝˛ˇ˘§÷¸°¨˙űŘř■\u00A0',
  855:
    'ђЂѓЃёЁєЄѕЅіІїЇјЈљЉњЊћЋќЌўЎџЏюЮъЪаАбБцЦдДеЕфФгГ«»░▒▓│┤хХиИ╣║╗╝йЙ┐' +
    '└┴┬├─┼кК╚╔╩╦╠═╬¤лЛмМнНоОп┘┌█▄Пя▀ЯрРсСтТуУжЖвВьЬ№\u00ADыЫзЗшШэЭщЩчЧ§■\u00A0',
  857:
    'ÇüéâäàåçêëèïîıÄÅÉæÆôöòûùİÖÜø£ØŞşáíóúñÑĞğ¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' +
    '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ºªÊËÈ\uF8BBÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµ\uF8BC×ÚÛÙìÿ¯´\u00AD±\uF8BD¾¶§÷¸°¨·¹³²■\u00A0',
  858:
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' +
    '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈ€ÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00AD±‗¾¶§÷¸°¨·¹³²■\u00A0',
  860:
    'ÇüéâãàÁçêÊèÍÔìÃÂÉÀÈôõòÚùÌÕÜ¢£Ù₧ÓáíóúñÑªº¿Ò¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
    '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00A0',
  861:
    'ÇüéâäàåçêëèÐðÞÄÅÉæÆôöþûÝýÖÜø£Ø₧ƒáíóúÁÍÓÚ¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
    '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00A0',
  862:
    'אבגדהוזחטיךכלםמןנסעףפץצקרשת¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
    '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00A0',
  863:
    'ÇüéâÂà¶çêëèïî‗À§ÉÈÊôËÏûù¤ÔÜ¢£ÙÛƒ¦´óú¨¸³¯Î⌐¬½¼¾«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
    '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00A0',
  864:
    '°·∙√▒─│┼┤┬├┴┐┌└┘β∞φ±½¼≈«»ﻷﻸ\u009B\u009Cﻻﻼ\u009F\u00A0\u00ADﺂ£¤ﺄ\uF8BE\uF8BFﺎﺏﺕﺙ،ﺝﺡﺥ٠١٢٣٤٥٦٧٨٩ﻑ؛ﺱﺵﺹ؟' +
    '¢ﺀﺁﺃﺅﻊﺋﺍﺑﺓﺗﺛﺟﺣﺧﺩﺫﺭﺯﺳﺷﺻﺿﻁﻅﻋﻏ¦¬÷×ﻉـﻓﻗﻛﻟﻣﻧﻫﻭﻯﻳﺽﻌﻎﻍﻡﹽ\u0651ﻥﻩﻬﻰﻲﻐﻕﻵﻶﻝﻙﻱ■\uF8C0',
  865:
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø₧ƒáíóúñÑªº¿⌐¬½¼¡«¤░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
    '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00A0',
  866:
    'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмноп░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
    '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀рстуфхцчшщъыьэюяЁёЄєЇїЎў°∙·√№¤■\u00A0',
  869:
    '\u0080\u0081\u0082\u0083\u0084\u0085Ά\u0087·¬¦‘’Έ―ΉΊΪΌ\u0093\u0094ΎΫ©Ώ²³ά£έήίϊΐόύΑΒΓΔΕΖΗ½ΘΙ«»░▒▓│┤ΚΛΜΝ╣║╗╝ΞΟ┐' +
    '└┴┬├─┼ΠΡ╚╔╩╦╠═╬ΣΤΥΦΧΨΩαβγ┘┌█▄δε▀ζηθικλμνξοπρσςτ΄\u00AD±υφχ§ψ΅°¨ωϋΰώ■\u00A0',
};

/** Other code pages a console can use, by their WHATWG encoding labels (see TextDecoder). */
const TEXT_DECODER_LABELS: Readonly<Record<number, string>> = {
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  20866: 'koi8-r',
  21866: 'koi8-u',
  28592: 'iso-8859-2',
  28593: 'iso-8859-3',
  28594: 'iso-8859-4',
  28595: 'iso-8859-5',
  28596: 'iso-8859-6',
  28597: 'iso-8859-7',
  28598: 'iso-8859-8',
  28603: 'iso-8859-13',
  28605: 'iso-8859-15',
  54936: 'gb18030',
};

/** Windows code page of UTF-8. */
export const UTF8_CODE_PAGE = 65001;

/**
 * A decoder for text in Windows code page `codePage`, or undefined for UTF-8 and for code pages
 * this module does not know (or that this Node build cannot decode).
 */
export function codePageDecoder(codePage: number): BytesDecoder | undefined {
  const upperHalf = OEM_UPPER_HALVES[codePage];
  if (upperHalf !== undefined) return singleByteDecoder(upperHalf);
  const label = TEXT_DECODER_LABELS[codePage];
  if (label === undefined) return undefined;
  try {
    const decoder = new TextDecoder(label);
    return (bytes) => decoder.decode(bytes);
  } catch {
    // Node built without full ICU knows only UTF-8 and UTF-16.
    return undefined;
  }
}

function singleByteDecoder(upperHalf: string): BytesDecoder {
  return (bytes) => {
    const units = new Uint16Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]!;
      units[i] = byte < 0x80 ? byte : upperHalf.charCodeAt(byte - 0x80);
    }
    let text = '';
    for (let start = 0; start < units.length; start += 8_192) {
      text += String.fromCharCode(...units.subarray(start, start + 8_192));
    }
    return text;
  };
}

/** Longest run of non-ASCII bytes held back while waiting for the end of its segment. */
const MAX_HELD_BYTES = 64 * 1024;
const LF = 0x0a;
const CR = 0x0d;
const ESC = 0x1b;

/**
 * Decodes command output on Windows, where programs write in different encodings: UTF-8 (Git
 * Bash's tools, git, node), or the console's code page (cmd and its built-ins, PowerShell
 * without UTF-8 setup, most other native programs). The output is cut into segments after each
 * line feed, carriage return and escape character (none of which occurs inside a character in
 * UTF-8 or a console code page), and each segment is decoded as UTF-8 when it is valid UTF-8 and
 * with `legacy` otherwise; in the console code pages, text that happens to be valid UTF-8 is
 * very unlikely.
 *
 * ASCII is passed on at once; non-ASCII bytes are held until their segment ends (at most
 * MAX_HELD_BYTES, after which they are decoded as they are), so live output that redraws a line
 * with carriage returns or cursor movement keeps flowing.
 */
export class ConsoleOutputDecoder implements TextStreamDecoder {
  private held: Buffer = Buffer.alloc(0);

  constructor(private readonly legacy: BytesDecoder) {}

  write(chunk: Buffer): string {
    let data = this.held.length === 0 ? chunk : Buffer.concat([this.held, chunk]);
    let text = '';
    const segmentsEnd = lastSegmentEnd(data);
    if (segmentsEnd >= 0) {
      text += this.decodeSegments(data.subarray(0, segmentsEnd + 1));
      data = data.subarray(segmentsEnd + 1);
    }
    let firstNonAscii = 0;
    while (firstNonAscii < data.length && data[firstNonAscii]! < 0x80) firstNonAscii++;
    text += data.toString('latin1', 0, firstNonAscii);
    // Copy, so a large chunk is not retained for a few held bytes.
    this.held = Buffer.from(data.subarray(firstNonAscii));
    if (this.held.length > MAX_HELD_BYTES) text += this.flushHeld(false);
    return text;
  }

  end(): string {
    return this.flushHeld(true);
  }

  /** Decodes complete segments, each on its own when they are not all UTF-8. */
  private decodeSegments(segments: Buffer): string {
    if (isUtf8(segments)) return segments.toString('utf8');
    let text = '';
    let start = 0;
    for (let i = 0; i < segments.length; i++) {
      if (!isSegmentEnd(segments[i]!)) continue;
      const segment = segments.subarray(start, i + 1);
      text += isUtf8(segment) ? segment.toString('utf8') : this.legacy(segment);
      start = i + 1;
    }
    return text;
  }

  /**
   * Decodes the held bytes of an unfinished segment. Unless the stream ends, a UTF-8 sequence cut
   * off at the end stays held for the next chunk.
   */
  private flushHeld(final: boolean): string {
    const held = this.held;
    if (held.length === 0) return '';
    const cut = held.length - incompleteUtf8Tail(held);
    let text: string;
    if (isUtf8(held.subarray(0, cut))) {
      // At the end of the stream a cut-off sequence becomes U+FFFD, like StringDecoder does.
      const end = final ? held.length : cut;
      text = held.toString('utf8', 0, end);
      this.held = Buffer.from(held.subarray(end));
    } else {
      text = this.legacy(held);
      this.held = Buffer.alloc(0);
    }
    return text;
  }
}

function isSegmentEnd(byte: number): boolean {
  return byte === LF || byte === CR || byte === ESC;
}

function lastSegmentEnd(data: Buffer): number {
  return Math.max(data.lastIndexOf(LF), data.lastIndexOf(CR), data.lastIndexOf(ESC));
}

/** Number of bytes at the end of `bytes` that start a UTF-8 sequence without finishing it. */
function incompleteUtf8Tail(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return length > back ? back : 0;
  }
  return 0;
}

/** How long the console code page query may take. */
const QUERY_TIMEOUT_MS = 5_000;

let consoleCodePage: Promise<number | undefined> | undefined;

/**
 * Windows: the code page of the hidden consoles that commands run in, which cmd's built-ins and
 * most native programs write redirected output in. Queried once, by running System32's chcp.com
 * the way runCommand starts shells (stdio not inherited, window hidden), so it gets the same kind
 * of console. Undefined on other platforms and when the query fails.
 */
export function windowsConsoleCodePage(): Promise<number | undefined> {
  consoleCodePage ??=
    process.platform === 'win32' ? queryConsoleCodePage() : Promise.resolve(undefined);
  return consoleCodePage;
}

function queryConsoleCodePage(): Promise<number | undefined> {
  return new Promise((resolve) => {
    const chcp = system32Path('chcp.com');
    let child: ChildProcess;
    try {
      child = spawn(chcp, [], {
        cwd: path.win32.dirname(chcp),
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve(undefined);
      return;
    }
    let output = '';
    child.stdout?.setEncoding('latin1');
    child.stdout?.on('data', (text: string) => (output += text));
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, QUERY_TIMEOUT_MS);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? parseActiveCodePage(output) : undefined);
    });
  });
}

/**
 * The code page in chcp's output, whose wording depends on the system language ("Active code
 * page: 437", "Aktywna strona kodowa: 852.").
 */
export function parseActiveCodePage(output: string): number | undefined {
  const match = /(\d+)\D*$/.exec(output.trim());
  const codePage = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(codePage) && codePage > 0 ? codePage : undefined;
}
