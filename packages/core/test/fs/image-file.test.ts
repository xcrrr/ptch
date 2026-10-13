import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_BASE64_BYTES,
  MAX_IMAGE_FILE_BYTES,
  base64ByteLength,
  describeImageSize,
  detectImageType,
  hasImageExtension,
  imageBlockInfo,
  imageDimensions,
  imageFromBytes,
  isImageFile,
  readImageFile,
} from '../../src/fs/image-file.js';
import { makeTempDir, pngBytes } from '../../src/testing/index.js';
import { ToolError } from '../../src/tools/types.js';

/** SOI, a JFIF APP0 segment, then a baseline start-of-frame with the given size. */
function jpegBytes(width: number, height: number, extraSegment = 0): Buffer {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0, 0, 1, 0, 1, 0, 0,
  ]);
  // An APP1 segment of `extraSegment` bytes (like an Exif block) before the frame header.
  const app1 =
    extraSegment > 0
      ? Buffer.concat([
          Buffer.from([0xff, 0xe1, (extraSegment + 2) >> 8, (extraSegment + 2) & 0xff]),
          Buffer.alloc(extraSegment),
        ])
      : Buffer.alloc(0);
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    ...Array<number>(9).fill(0),
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, sof, Buffer.from([0xff, 0xd9])]);
}

function gifBytes(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'latin1');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return Buffer.concat([header, Buffer.from([0x3b])]);
}

function webp(chunkType: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(12 + payload.length, 4);
  head.write('WEBP', 8, 'latin1');
  head.write(chunkType, 12, 'latin1');
  head.writeUInt32LE(payload.length, 16);
  return Buffer.concat([head, payload, Buffer.alloc(16)]);
}

function webpExtended(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return webp('VP8X', payload);
}

function webpLossless(width: number, height: number): Buffer {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  payload.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  return webp('VP8L', payload);
}

function webpLossy(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  payload.set([0x9d, 0x01, 0x2a], 3);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return webp('VP8 ', payload);
}

describe('image detection', () => {
  it('recognizes PNG, JPEG, GIF and WebP by their magic numbers', () => {
    expect(detectImageType(pngBytes(2, 2))).toBe('image/png');
    expect(detectImageType(jpegBytes(2, 2))).toBe('image/jpeg');
    expect(detectImageType(gifBytes(2, 2))).toBe('image/gif');
    expect(detectImageType(webpExtended(2, 2))).toBe('image/webp');
    expect(detectImageType(Buffer.from('GIF87a'))).toBe('image/gif');
  });

  it('recognizes nothing else', () => {
    expect(detectImageType(Buffer.from('just some text\n'))).toBeUndefined();
    expect(detectImageType(Buffer.alloc(0))).toBeUndefined();
    expect(detectImageType(Buffer.from([0x89, 0x50, 0x4e]))).toBeUndefined();
    expect(detectImageType(Buffer.from('RIFF\0\0\0\0WAVEfmt '))).toBeUndefined();
  });

  it('reads the dimensions from each format header', () => {
    expect(imageDimensions(pngBytes(1280, 720), 'image/png')).toEqual({ width: 1280, height: 720 });
    expect(imageDimensions(jpegBytes(640, 480), 'image/jpeg')).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(gifBytes(32, 16), 'image/gif')).toEqual({ width: 32, height: 16 });
    expect(imageDimensions(webpExtended(1920, 1080), 'image/webp')).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(imageDimensions(webpLossless(300, 200), 'image/webp')).toEqual({
      width: 300,
      height: 200,
    });
    expect(imageDimensions(webpLossy(800, 600), 'image/webp')).toEqual({ width: 800, height: 600 });
  });

  it('finds the JPEG frame after large metadata segments', () => {
    expect(imageDimensions(jpegBytes(4032, 3024, 30_000), 'image/jpeg')).toEqual({
      width: 4032,
      height: 3024,
    });
  });

  it('gives no dimensions for cut-off or malformed headers', () => {
    expect(imageDimensions(pngBytes(10, 10).subarray(0, 20), 'image/png')).toBeUndefined();
    expect(imageDimensions(jpegBytes(10, 10).subarray(0, 25), 'image/jpeg')).toBeUndefined();
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0x00, 0x00]), 'image/jpeg')).toBeUndefined();
    expect(imageDimensions(webp('ALPH', Buffer.alloc(10)), 'image/webp')).toBeUndefined();
  });

  it('filters candidate paths by extension, ignoring case', () => {
    for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'shots/e.WebP']) {
      expect(hasImageExtension(name)).toBe(true);
    }
    for (const name of ['a.svg', 'b.bmp', 'png', 'notes.png.txt', 'heic.heic']) {
      expect(hasImageExtension(name)).toBe(false);
    }
  });
});

describe('imageFromBytes', () => {
  it('builds a base64 image block with the label, size and dimensions', () => {
    const bytes = pngBytes(3, 2);
    const file = imageFromBytes(bytes, 'shot.png', 'shot.png');
    expect(file).toEqual({
      image: {
        type: 'image',
        mediaType: 'image/png',
        data: bytes.toString('base64'),
        label: 'shot.png',
      },
      size: bytes.length,
      width: 3,
      height: 2,
    });
  });

  it('takes the format from the bytes, not the name', () => {
    expect(imageFromBytes(jpegBytes(4, 4), 'photo.png').image.mediaType).toBe('image/jpeg');
  });

  it('names unsupported image formats', () => {
    const bmp = Buffer.concat([Buffer.from('BM'), Buffer.alloc(12)]);
    expect(() => imageFromBytes(bmp, 'a.bmp')).toThrow(
      'a.bmp is a BMP image; only PNG, JPEG, GIF and WebP images are supported.',
    );
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic')]);
    expect(() => imageFromBytes(heic, 'IMG_1.HEIC')).toThrow('IMG_1.HEIC is a HEIC image');
    const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(() => imageFromBytes(svg, 'logo.svg')).toThrow('logo.svg is a SVG image');
    expect(() => imageFromBytes(Buffer.from('hello'), 'x.png')).toThrow(
      'x.png is not a PNG, JPEG, GIF or WebP image.',
    );
  });

  it('refuses images that would exceed 5 MB once base64-encoded', () => {
    expect(MAX_IMAGE_FILE_BYTES).toBe(3_932_160);
    expect(Math.ceil(MAX_IMAGE_FILE_BYTES / 3) * 4).toBe(MAX_IMAGE_BASE64_BYTES);
    const big = Buffer.concat([pngBytes(1, 1), Buffer.alloc(MAX_IMAGE_FILE_BYTES)]);
    expect(() => imageFromBytes(big, 'The clipboard image')).toThrow(
      /^The clipboard image is too large to send \(3\.8 MB\)\. Images can be at most 3\.8 MB \(5 MB once base64-encoded\)/,
    );
  });
});

describe('readImageFile', () => {
  let temp: { dir: string; cleanup: () => void };
  const file = (name: string) => path.join(temp.dir, name);

  beforeEach(() => {
    temp = makeTempDir();
  });

  afterEach(() => temp.cleanup());

  it('loads an image with its file name as the label', async () => {
    writeFileSync(file('screen shot.png'), pngBytes(1280, 720));
    const loaded = await readImageFile(file('screen shot.png'), 'docs/screen shot.png');
    expect(loaded.image.label).toBe('screen shot.png');
    expect(loaded.image.mediaType).toBe('image/png');
    expect([loaded.width, loaded.height]).toEqual([1280, 720]);
    expect(Buffer.from(loaded.image.data, 'base64').equals(pngBytes(1280, 720))).toBe(true);
  });

  it('checks the size before reading the file', async () => {
    const big = Buffer.alloc(MAX_IMAGE_FILE_BYTES + 1);
    pngBytes(1, 1).copy(big);
    writeFileSync(file('huge.png'), big);
    await expect(readImageFile(file('huge.png'), 'huge.png')).rejects.toThrow(
      'huge.png is too large to send (3.8 MB).',
    );
  });

  it('explains missing files, directories and non-images', async () => {
    mkdirSync(file('dir.png'));
    writeFileSync(file('pointer.png'), 'version https://git-lfs.github.com/spec/v1\n');
    await expect(readImageFile(file('nope.png'), 'nope.png')).rejects.toThrow(
      'File not found: nope.png',
    );
    await expect(readImageFile(file('dir.png'), 'dir.png')).rejects.toThrow(
      'dir.png is a directory, not a file.',
    );
    const error = await readImageFile(file('pointer.png'), 'pointer.png').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as Error).message).toBe('pointer.png is not a PNG, JPEG, GIF or WebP image.');
  });

  it('tells images from other files by their content', async () => {
    writeFileSync(file('photo.dat'), jpegBytes(8, 8));
    writeFileSync(file('fake.png'), 'not an image');
    mkdirSync(file('folder'));
    expect(await isImageFile(file('photo.dat'))).toBe(true);
    expect(await isImageFile(file('fake.png'))).toBe(false);
    expect(await isImageFile(file('folder'))).toBe(false);
    expect(await isImageFile(file('missing.png'))).toBe(false);
  });
});

describe('stored images', () => {
  it('reports the size and dimensions of an image block from its data', () => {
    const bytes = pngBytes(64, 48);
    const info = imageBlockInfo({
      type: 'image',
      mediaType: 'image/png',
      data: bytes.toString('base64'),
    });
    expect(info).toEqual({ size: bytes.length, width: 64, height: 48 });
    expect(describeImageSize({ size: 86_016, width: 1280, height: 720 })).toBe('1280×720 · 84 KB');
    expect(describeImageSize({ size: 512 })).toBe('512 B');
  });

  it('computes decoded lengths from base64 padding', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 100]) {
      const data = Buffer.alloc(length, 7).toString('base64');
      expect(base64ByteLength(data)).toBe(length);
    }
  });
});
