import {
  formatBytes,
  oneLine,
  plural,
  splitLines,
  truncateMiddle,
  type ImageBlock,
} from '@patch/shared';
import { base64ByteLength, imageFromBytes } from '../fs/image-file.js';
import { ToolError, type ToolResult } from '../tools/types.js';

/** Model-facing text kept from one result (the middle of longer output is left out). */
export const MAX_MCP_RESULT_CHARS = 40_000;
const MAX_MCP_RESULT_LINES = 2_000;
/** Images passed on from one result; more are left out with a note. */
export const MAX_MCP_RESULT_IMAGES = 10;
const DETAIL_MAX_LINES = 200;
const DETAIL_MAX_CHARS = 20_000;
const ERROR_SUMMARY_CHARS = 160;

/** The parts of an MCP CallToolResult Patch reads (validated by the SDK, read leniently here). */
export interface McpCallResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpResultContext {
  server: string;
  tool: string;
}

/**
 * Turns an MCP tool result into a tool result for the model:
 *  - text blocks, and the text of embedded resources, become the text (resource links a short
 *    line each); `structuredContent` is used as JSON when there is no other text;
 *  - images (image blocks and image resources) become ImageBlocks, within the image size limit
 *    and MAX_MCP_RESULT_IMAGES; anything else (audio, other binary data) is described in a note;
 *  - `isError` makes it an error result;
 *  - text beyond MAX_MCP_RESULT_CHARS is cut in the middle, with a note.
 * Display: the outcome ("12 lines · 1 image", or the first line of an error) and the full text
 * for ctrl+o.
 */
export function mcpToolResult(result: McpCallResult, context: McpResultContext): ToolResult {
  const texts: string[] = [];
  const notes: string[] = [];
  const images: ImageBlock[] = [];
  let omittedImages = 0;
  const addImage = (data: string, mimeType: string) => {
    if (images.length >= MAX_MCP_RESULT_IMAGES) {
      omittedImages++;
      return;
    }
    const number = images.length + 1;
    try {
      const file = imageFromBytes(
        Buffer.from(data, 'base64'),
        `Image ${number} from ${context.server} · ${context.tool}`,
        `${context.tool} image ${number}`,
      );
      images.push(file.image);
    } catch (error) {
      const reason = error instanceof ToolError ? error.message : `the ${mimeType} data is invalid`;
      notes.push(`[An image was left out: ${reason}]`);
    }
  };

  for (const block of result.content ?? []) {
    if (!isRecord(block)) continue;
    switch (block['type']) {
      case 'text':
        if (typeof block['text'] === 'string') texts.push(block['text']);
        break;
      case 'image':
        addImage(stringField(block, 'data'), stringField(block, 'mimeType') || 'image');
        break;
      case 'audio':
        notes.push(
          `[Audio (${stringField(block, 'mimeType') || 'unknown type'}) was left out: Patch cannot pass audio to the model.]`,
        );
        break;
      case 'resource':
        readResource(block['resource'], texts, notes, addImage);
        break;
      case 'resource_link':
        texts.push(resourceLinkLine(block));
        break;
      default:
        notes.push(`[Content of type "${String(block['type'])}" was left out.]`);
        break;
    }
  }
  if (omittedImages > 0) {
    notes.push(
      `[${plural(omittedImages, 'more image')} left out: at most ${MAX_MCP_RESULT_IMAGES} images are passed on from one result.]`,
    );
  }
  if (texts.length === 0 && result.structuredContent !== undefined) {
    texts.push(JSON.stringify(result.structuredContent, null, 2));
  }

  const isError = result.isError === true;
  const text = texts.join('\n');
  const truncated = truncateMiddle(text, {
    maxLines: MAX_MCP_RESULT_LINES,
    maxChars: MAX_MCP_RESULT_CHARS,
    headRatio: 0.6,
  });
  if (truncated.truncated) {
    notes.push(
      `[Output truncated: the tool returned ${plural(truncated.totalLines, 'line')} (${formatBytes(Buffer.byteLength(text))}); the middle was left out. Ask for less (narrower arguments, a page or a filter) to see the rest.]`,
    );
  }
  const body = [truncated.text, ...notes].filter((part) => part !== '').join('\n\n');
  const content =
    body !== ''
      ? body
      : isError
        ? 'The MCP tool reported an error without details.'
        : images.length > 0
          ? `The tool returned ${plural(images.length, 'image')}.`
          : 'The tool returned no content.';

  const summary = isError
    ? oneLine(firstLine(text) || 'error', ERROR_SUMMARY_CHARS)
    : outcomeSummary(text, images.length);
  const detail =
    text === ''
      ? undefined
      : truncateMiddle(text, { maxLines: DETAIL_MAX_LINES, maxChars: DETAIL_MAX_CHARS }).text;
  return {
    content,
    ...(images.length > 0 ? { images } : {}),
    ...(isError ? { isError: true } : {}),
    display: { summary, ...(detail ? { detail } : {}) },
  };
}

/** An embedded resource: its text, an image, or a note about binary data left out. */
function readResource(
  resource: unknown,
  texts: string[],
  notes: string[],
  addImage: (data: string, mimeType: string) => void,
): void {
  if (!isRecord(resource)) return;
  const uri = stringField(resource, 'uri');
  const mimeType = stringField(resource, 'mimeType');
  if (typeof resource['text'] === 'string') {
    texts.push(`Resource ${uri}${mimeType ? ` (${mimeType})` : ''}:\n${resource['text']}`);
    return;
  }
  const blob = stringField(resource, 'blob');
  if (mimeType.startsWith('image/')) {
    addImage(blob, mimeType);
    return;
  }
  notes.push(
    `[Binary resource ${uri} (${mimeType || 'unknown type'}, ${formatBytes(base64ByteLength(blob))}) was left out.]`,
  );
}

function resourceLinkLine(block: Record<string, unknown>): string {
  const name = stringField(block, 'name');
  const uri = stringField(block, 'uri');
  const mimeType = stringField(block, 'mimeType');
  const description = stringField(block, 'description');
  const what = [name && name !== uri ? `${name}: ${uri}` : uri, mimeType ? `(${mimeType})` : '']
    .filter(Boolean)
    .join(' ');
  return `Resource link: ${what}${description ? ` — ${oneLine(description, 200)}` : ''}`;
}

/** "12 lines", "1 image", "3 lines · 2 images", "no output". */
function outcomeSummary(text: string, images: number): string {
  const parts: string[] = [];
  const lines = text.trim() === '' ? 0 : splitLines(text.trimEnd()).length;
  if (lines > 0) parts.push(plural(lines, 'line'));
  if (images > 0) parts.push(plural(images, 'image'));
  return parts.length > 0 ? parts.join(' · ') : 'no output';
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '') ?? '';
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
