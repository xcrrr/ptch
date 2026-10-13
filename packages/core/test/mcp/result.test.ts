import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_FILE_BYTES } from '../../src/fs/image-file.js';
import {
  MAX_MCP_RESULT_CHARS,
  MAX_MCP_RESULT_IMAGES,
  mcpToolResult,
} from '../../src/mcp/result.js';
import { argumentsPreview, summarizeArguments } from '../../src/mcp/tool.js';
import { pngBytes } from '../../src/testing/images.js';

const context = { server: 'test', tool: 'shot' };
const png = pngBytes(4, 2).toString('base64');

describe('mcpToolResult', () => {
  it('joins text blocks and shows the line count', () => {
    const result = mcpToolResult(
      {
        content: [
          { type: 'text', text: 'first\nsecond' },
          { type: 'text', text: 'third' },
        ],
      },
      context,
    );
    expect(result).toEqual({
      content: 'first\nsecond\nthird',
      display: { summary: '3 lines', detail: 'first\nsecond\nthird' },
    });
  });

  it('passes images on as image blocks', () => {
    const result = mcpToolResult(
      {
        content: [
          { type: 'text', text: 'a screenshot' },
          { type: 'image', data: png, mimeType: 'image/png' },
        ],
      },
      context,
    );
    expect(result.content).toBe('a screenshot');
    expect(result.images).toEqual([
      { type: 'image', mediaType: 'image/png', data: png, label: 'shot image 1' },
    ]);
    expect(result.display?.summary).toBe('1 line · 1 image');
  });

  it('describes an image-only result and leaves out images that are too large or invalid', () => {
    const tooLarge = Buffer.concat([pngBytes(1, 1), Buffer.alloc(MAX_IMAGE_FILE_BYTES)]);
    const result = mcpToolResult(
      {
        content: [
          { type: 'image', data: png, mimeType: 'image/png' },
          { type: 'image', data: tooLarge.toString('base64'), mimeType: 'image/png' },
          {
            type: 'image',
            data: Buffer.from('not an image').toString('base64'),
            mimeType: 'image/png',
          },
        ],
      },
      context,
    );
    expect(result.images).toHaveLength(1);
    expect(result.content).toContain(
      '[An image was left out: Image 2 from test · shot is too large',
    );
    expect(result.content).toContain(
      '[An image was left out: Image 2 from test · shot is not a PNG, JPEG, GIF or WebP image.]',
    );
    expect(result.display?.summary).toBe('1 image');

    const only = mcpToolResult(
      { content: [{ type: 'image', data: png, mimeType: 'image/png' }] },
      context,
    );
    expect(only.content).toBe('The tool returned 1 image.');
  });

  it('passes at most a fixed number of images', () => {
    const many = Array.from({ length: MAX_MCP_RESULT_IMAGES + 2 }, () => ({
      type: 'image',
      data: png,
      mimeType: 'image/png',
    }));
    const result = mcpToolResult({ content: many }, context);
    expect(result.images).toHaveLength(MAX_MCP_RESULT_IMAGES);
    expect(result.content).toContain('[2 more images left out');
  });

  it('reads embedded resources and resource links', () => {
    const result = mcpToolResult(
      {
        content: [
          {
            type: 'resource',
            resource: { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'A' },
          },
          {
            type: 'resource',
            resource: { uri: 'file:///b.png', mimeType: 'image/png', blob: png },
          },
          {
            type: 'resource',
            resource: { uri: 'file:///c.bin', mimeType: 'application/zip', blob: 'AAAA' },
          },
          {
            type: 'resource_link',
            uri: 'file:///d.md',
            name: 'Design notes',
            mimeType: 'text/markdown',
            description: 'The plan',
          },
          { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
        ],
      },
      context,
    );
    expect(result.content).toBe(
      [
        'Resource file:///a.txt (text/plain):\nA\nResource link: Design notes: file:///d.md (text/markdown) — The plan',
        '[Binary resource file:///c.bin (application/zip, 3 B) was left out.]',
        '[Audio (audio/wav) was left out: Patch cannot pass audio to the model.]',
      ].join('\n\n'),
    );
    expect(result.images).toHaveLength(1);
  });

  it('uses structured content when there is no text', () => {
    const result = mcpToolResult({ content: [], structuredContent: { count: 2 } }, context);
    expect(result.content).toBe('{\n  "count": 2\n}');
    expect(mcpToolResult({ content: [] }, context)).toMatchObject({
      content: 'The tool returned no content.',
      display: { summary: 'no output' },
    });
  });

  it('turns isError into an error result with the first line as its outcome', () => {
    const result = mcpToolResult(
      {
        content: [{ type: 'text', text: '\nPermission denied: repo\nmore detail' }],
        isError: true,
      },
      context,
    );
    expect(result).toMatchObject({
      content: '\nPermission denied: repo\nmore detail',
      isError: true,
      display: { summary: 'Permission denied: repo' },
    });
    expect(mcpToolResult({ content: [], isError: true }, context)).toMatchObject({
      content: 'The MCP tool reported an error without details.',
      isError: true,
    });
  });

  it('cuts long output in the middle with a note', () => {
    const lines = Array.from({ length: 5_000 }, (_, i) => `line ${i + 1} ${'x'.repeat(20)}`);
    const result = mcpToolResult({ content: [{ type: 'text', text: lines.join('\n') }] }, context);
    expect(result.content.length).toBeLessThan(MAX_MCP_RESULT_CHARS + 1_000);
    expect(result.content.startsWith('line 1 ')).toBe(true);
    expect(result.content).toMatch(/\.\.\. [\d,]+ (lines|characters) omitted \.\.\./);
    expect(result.content).toContain('line 5000 ');
    expect(result.content).toMatch(
      /\[Output truncated: the tool returned 5,000 lines \(.+\); the middle was left out\./,
    );
    expect(result.display?.detail?.length).toBeLessThanOrEqual(25_000);
  });
});

describe('MCP tool arguments', () => {
  it('summarizes the arguments in one short line', () => {
    expect(summarizeArguments({})).toBeUndefined();
    expect(summarizeArguments({ path: 'src/a.ts', limit: 10 })).toBe('path: "src/a.ts", limit: 10');
    expect(summarizeArguments({ query: 'x'.repeat(200) })).toHaveLength(80);
  });

  it('previews the arguments as compact JSON, cut when very long', () => {
    expect(argumentsPreview({})).toBe('(no arguments)');
    expect(argumentsPreview({ text: 'hi', n: [1, 2] })).toBe('{"text":"hi","n":[1,2]}');
    const long = argumentsPreview({ text: 'y'.repeat(10_000) });
    expect(long).toHaveLength(4_000);
    expect(long.endsWith('…')).toBe(true);
  });
});
