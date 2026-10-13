import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ToolError,
  describeImageSize,
  hasImageExtension,
  imageBlockInfo,
  readImageFile,
  type ImageFile,
  type PathPolicy,
  type PermissionManager,
  type PermissionRequest,
  type PermissionResponse,
  type ResolvedPath,
} from '@patch/core';
import type { ImageBlock } from '@patch/shared';

/** An image attached to a prompt, with what the UI shows about it. */
export interface ImageAttachment {
  image: ImageBlock;
  /** e.g. "screenshot.png · 1280×720 · 84 KB" */
  description: string;
}

export type AttachResult =
  | { ok: true; attachment: ImageAttachment }
  /**
   * missing: no such file (a paste is then just text); denied: the read was not approved;
   * invalid: not an image, too large or unreadable.
   */
  | { ok: false; reason: 'missing' | 'denied' | 'invalid'; message: string };

export interface AttachDeps {
  paths: PathPolicy;
  permissions: PermissionManager;
  /** Asks the user to approve a read. Non-interactive callers decline. */
  requestPermission: (request: PermissionRequest) => Promise<PermissionResponse>;
}

let nextRequestId = 0;

/** "screenshot.png · 1280×720 · 84 KB" for a freshly loaded image. */
export function describeImageFile(file: ImageFile): string {
  return `${file.image.label ?? 'image'} · ${describeImageSize(file)}`;
}

/** The same description for an image stored in a session (decodes only its header). */
export function describeStoredImage(image: ImageBlock): string {
  return `${image.label ?? 'image'} · ${describeImageSize(imageBlockInfo(image))}`;
}

/** "[Image #1] screenshot.png · 1280×720 · 84 KB" (numbers start at 1). */
export function imageLine(number: number, description: string): string {
  return `${imageToken(number)} ${description}`;
}

/** The placeholder for an attached image in the prompt text: "[Image #1]". */
export function imageToken(number: number): string {
  return `[Image #${number}]`;
}

/**
 * Loads an image the user named (a pasted or dropped path, an `@path` mention) for a prompt.
 * Reading it follows read_file's rules, decided by the PermissionManager: allowed inside the
 * project; outside the project and for sensitive files the user is asked (through
 * `requestPermission`), and a session approval is remembered like one given to read_file.
 */
export async function attachImageFile(input: string, deps: AttachDeps): Promise<AttachResult> {
  let resolved: ResolvedPath;
  try {
    resolved = await deps.paths.resolve(input);
  } catch (error) {
    if (error instanceof ToolError) return { ok: false, reason: 'invalid', message: error.message };
    throw error;
  }
  const { display } = resolved;
  if (!resolved.exists) {
    return { ok: false, reason: 'missing', message: `File not found: ${display}` };
  }
  if (resolved.isDirectory) {
    return { ok: false, reason: 'invalid', message: `${display} is a directory, not an image.` };
  }
  const subject = { kind: 'read' as const, paths: [resolved] };
  const decision = deps.permissions.evaluate(subject);
  if (decision.type === 'deny') {
    return { ok: false, reason: 'denied', message: decision.message };
  }
  if (decision.type === 'ask') {
    nextRequestId += 1;
    const response = await deps.requestPermission({
      id: `image-${nextRequestId}`,
      toolName: 'image',
      summary: { verb: 'image', target: display },
      subject,
      prompt: decision.prompt,
    });
    if (response.decision === 'deny') {
      return { ok: false, reason: 'denied', message: `Reading ${display} was not approved.` };
    }
    if (response.decision === 'allow_session' && decision.prompt.sessionOption) {
      const { grant, grants } = decision.prompt.sessionOption;
      for (const one of grants ?? [grant]) deps.permissions.grant(one);
    }
  }
  try {
    const file = await readImageFile(resolved.absolute, display, path.basename(resolved.absolute));
    return { ok: true, attachment: { image: file.image, description: describeImageFile(file) } };
  } catch (error) {
    if (error instanceof ToolError) return { ok: false, reason: 'invalid', message: error.message };
    throw error;
  }
}

/**
 * The image a paste names when the pasted text is exactly one path to an image file (judged by
 * its extension; the file itself is checked when it is loaded): optionally quoted, a file:// URL,
 * or with backslash-escaped spaces as macOS and Linux terminals insert a dropped file. Undefined
 * for anything else.
 */
export function pastedImagePath(
  text: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  let candidate = text.trim();
  if (candidate === '' || /[\r\n]/.test(candidate)) return undefined;
  const quoted = /^(['"])(.+)\1$/.exec(candidate);
  if (quoted) candidate = quoted[2] ?? '';
  else if (platform !== 'win32') candidate = candidate.replace(/\\(.)/g, '$1');
  if (/^file:\/\//i.test(candidate)) {
    try {
      candidate = fileURLToPath(candidate, { windows: platform === 'win32' });
    } catch {
      return undefined;
    }
  }
  return hasImageExtension(candidate) ? candidate : undefined;
}

/** Characters that end a sentence rather than a path: "look at @shot.png." */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/**
 * Paths of the images a prompt mentions as `@path` (or `@"path with spaces"`), relative to the
 * working directory, in order and without duplicates. A mention starts the text or follows
 * whitespace; only names with an image extension count.
 */
export function imageMentions(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)@(?:"([^"\r\n]+)"|(\S+))/g)) {
    const mention = match[1] ?? (match[2] ?? '').replace(TRAILING_PUNCTUATION, '');
    if (hasImageExtension(mention) && !found.includes(mention)) found.push(mention);
  }
  return found;
}
