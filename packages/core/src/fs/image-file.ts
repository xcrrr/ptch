import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { formatBytes, type ImageBlock, type ImageMediaType } from '@patch/shared';
import { ToolError } from '../tools/types.js';
import { describeFsError, errorCode, isMissingError } from './fs-errors.js';

/** Largest base64 payload the model API accepts for one image. */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;
/** Largest image file that stays within MAX_IMAGE_BASE64_BYTES once base64-encoded (3.75 MB). */
export const MAX_IMAGE_FILE_BYTES = (MAX_IMAGE_BASE64_BYTES / 4) * 3;

/** Bytes read to recognize an image by its magic number. */
const SNIFF_BYTES = 16;
/** Base64 characters decoded when looking for the dimensions of a stored image. */
const HEADER_SCAN_BASE64_CHARS = 256 * 1024;

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;

export interface ImageDimensions {
  width: number;
  height: number;
}

/** A loaded image: the block to send plus what the UI shows about it. */
export interface ImageFile extends Partial<ImageDimensions> {
  image: ImageBlock;
  /** Size of the image in bytes (not base64-encoded). */
  size: number;
}

/** True when the path names a supported image format by its extension (a cheap first filter). */
export function hasImageExtension(file: string): boolean {
  return IMAGE_EXTENSION.test(file);
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** The image format of `bytes` by its magic number, or undefined when it is not a supported one. */
export function detectImageType(bytes: Uint8Array): ImageMediaType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

/** Common image formats the model cannot take, named so the error says what the file is. */
function unsupportedFormat(bytes: Uint8Array): string | undefined {
  // "BM", the file size, then four reserved zero bytes.
  if (startsWith(bytes, [0x42, 0x4d]) && startsWith(bytes, [0, 0, 0, 0], 6)) return 'BMP';
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'TIFF';
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'HEIC';
    if (brand === 'avif' || brand === 'avis') return 'AVIF';
  }
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('utf8').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'SVG';
  return undefined;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return readUint16LE(bytes, offset) | ((bytes[offset + 2] ?? 0) << 16);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return readUint16BE(bytes, offset) * 0x10000 + readUint16BE(bytes, offset + 2);
}

function dimensions(width: number, height: number): ImageDimensions | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** JPEG: the frame size from the first start-of-frame marker before the image data. */
function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] ?? 0;
    // Fill bytes before a marker, and markers without a length (TEM, RSTn).
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start of scan or end of image: no frame header before the image data.
    if (marker === 0xda || marker === 0xd9) return undefined;
    const length = readUint16BE(bytes, offset + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      if (offset + 9 > bytes.length) return undefined;
      return dimensions(readUint16BE(bytes, offset + 7), readUint16BE(bytes, offset + 5));
    }
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

/** WebP: the canvas size from the VP8X header, or the frame size of a simple VP8/VP8L file. */
function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 30) return undefined;
  switch (ascii(bytes, 12, 4)) {
    case 'VP8X':
      return dimensions(readUint24LE(bytes, 24) + 1, readUint24LE(bytes, 27) + 1);
    case 'VP8 ':
      if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return undefined;
      return dimensions(readUint16LE(bytes, 26) & 0x3fff, readUint16LE(bytes, 28) & 0x3fff);
    case 'VP8L': {
      if (bytes[20] !== 0x2f) return undefined;
      const bits =
        (bytes[21] ?? 0) |
        ((bytes[22] ?? 0) << 8) |
        ((bytes[23] ?? 0) << 16) |
        ((bytes[24] ?? 0) * 0x1000000);
      return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    default:
      return undefined;
  }
}

/**
 * Width and height from the image header (PNG IHDR, JPEG start-of-frame, GIF logical screen,
 * WebP VP8/VP8L/VP8X), without decoding the image. Undefined when the header is cut off or
 * malformed.
 */
export function imageDimensions(
  bytes: Uint8Array,
  type: ImageMediaType,
): ImageDimensions | undefined {
  switch (type) {
    case 'image/png':
      if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return undefined;
      return dimensions(readUint32BE(bytes, 16), readUint32BE(bytes, 20));
    case 'image/gif':
      if (bytes.length < 10) return undefined;
      return dimensions(readUint16LE(bytes, 6), readUint16LE(bytes, 8));
    case 'image/jpeg':
      return jpegDimensions(bytes);
    case 'image/webp':
      return webpDimensions(bytes);
  }
}

function tooLarge(display: string, size: number): ToolError {
  return new ToolError(
    `${display} is too large to send (${formatBytes(size)}). Images can be at most ${formatBytes(MAX_IMAGE_FILE_BYTES)} (5 MB once base64-encoded); resize or compress it first.`,
  );
}

/**
 * Turns image bytes into an ImageFile. The format comes from the magic number, never from a file
 * name. Throws ToolError (messages start with `display`) for images over MAX_IMAGE_FILE_BYTES
 * and for anything that is not a PNG, JPEG, GIF or WebP image.
 */
export function imageFromBytes(bytes: Uint8Array, display: string, label?: string): ImageFile {
  if (bytes.length > MAX_IMAGE_FILE_BYTES) throw tooLarge(display, bytes.length);
  const mediaType = detectImageType(bytes);
  if (!mediaType) {
    const format = unsupportedFormat(bytes);
    throw new ToolError(
      format
        ? `${display} is a ${format} image; only PNG, JPEG, GIF and WebP images are supported.`
        : `${display} is not a PNG, JPEG, GIF or WebP image.`,
    );
  }
  const image: ImageBlock = {
    type: 'image',
    mediaType,
    data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
    ...(label === undefined ? {} : { label }),
  };
  return { image, size: bytes.length, ...imageDimensions(bytes, mediaType) };
}

/**
 * Reads an image file (see imageFromBytes). Also throws ToolError for missing files, directories
 * and other non-regular files, checking the size before reading anything. The label defaults to
 * the file name.
 */
export async function readImageFile(
  absolutePath: string,
  display: string,
  label: string = path.basename(absolutePath),
): Promise<ImageFile> {
  let bytes: Buffer;
  try {
    const stats = await stat(absolutePath);
    if (stats.isDirectory()) throw new ToolError(`${display} is a directory, not a file.`);
    if (!stats.isFile()) throw new ToolError(`${display} is not a regular file.`);
    if (stats.size > MAX_IMAGE_FILE_BYTES) throw tooLarge(display, stats.size);
    bytes = await readFile(absolutePath);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (isMissingError(error)) throw new ToolError(`File not found: ${display}`);
    const code = errorCode(error);
    if (code === 'EACCES' || code === 'EPERM') throw new ToolError(`Permission denied: ${display}`);
    throw new ToolError(`Could not read ${display}: ${describeFsError(error)}.`);
  }
  return imageFromBytes(bytes, display, label);
}

/**
 * True when `absolutePath` is a regular file that starts like a supported image (by its magic
 * number; the extension does not matter). Never throws.
 */
export async function isImageFile(absolutePath: string): Promise<boolean> {
  try {
    // Checking the type before opening matters: opening a FIFO would block until a writer appears.
    if (!(await stat(absolutePath)).isFile()) return false;
    const file = await open(absolutePath, 'r');
    try {
      const header = new Uint8Array(SNIFF_BYTES);
      const { bytesRead } = await file.read(header, 0, SNIFF_BYTES, 0);
      return detectImageType(header.subarray(0, bytesRead)) !== undefined;
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
}

/** Size in bytes of the image a base64 string encodes. */
export function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * Size and (when the header shows them) dimensions of a stored image, decoding only the start of
 * its data.
 */
export function imageBlockInfo(image: ImageBlock): { size: number } & Partial<ImageDimensions> {
  const head = Buffer.from(image.data.slice(0, HEADER_SCAN_BASE64_CHARS), 'base64');
  return { size: base64ByteLength(image.data), ...imageDimensions(head, image.mediaType) };
}

/** "1280×720 · 84 KB" (dimensions left out when unknown). */
export function describeImageSize(info: { size: number } & Partial<ImageDimensions>): string {
  const size = formatBytes(info.size);
  return info.width && info.height ? `${info.width}×${info.height} · ${size}` : size;
}
