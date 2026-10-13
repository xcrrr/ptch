import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock, Usage } from '@patch/shared';
import {
  SESSION_FORMAT_VERSION,
  type AppendableEntry,
  type MessageEntry,
  type SessionMeta,
} from '../../src/session/schema.js';
import type { NewSessionMeta } from '../../src/session/store.js';

export function newMeta(
  projectRoot: string,
  overrides: Partial<NewSessionMeta> = {},
): NewSessionMeta {
  return {
    cwd: projectRoot,
    projectRoot,
    isGit: true,
    branch: 'main',
    provider: 'anthropic',
    model: 'model-a',
    patchVersion: '0.1.0',
    system: 'You are Patch.',
    ...overrides,
  };
}

export function fullMeta(
  id: string,
  projectRoot: string,
  overrides: Partial<SessionMeta> = {},
): SessionMeta {
  return {
    type: 'meta',
    v: SESSION_FORMAT_VERSION,
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...newMeta(projectRoot),
    ...overrides,
  };
}

export function userText(text: string): Omit<MessageEntry, 'ts'> {
  return { type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } };
}

export function userBlocks(content: ContentBlock[]): Omit<MessageEntry, 'ts'> {
  return { type: 'message', message: { role: 'user', content } };
}

export function assistantText(text: string): Omit<MessageEntry, 'ts'> {
  return { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

export function usageEntry(usage: Partial<Usage>, model = 'model-a'): AppendableEntry {
  return {
    type: 'usage',
    model,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...usage },
  };
}

/** An entry with an explicit timestamp (append keeps a caller-supplied `ts`). */
export function at(ts: string, entry: AppendableEntry): AppendableEntry {
  return Object.assign({ ...entry }, { ts });
}

/**
 * Writes a raw session file (creating the directory): each item becomes one line, serialized
 * unless it is already a string.
 */
export function writeSessionFile(
  dir: string,
  id: string,
  lines: unknown[],
  trailingNewline = true,
): string {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${id}.jsonl`);
  const body = lines
    .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
    .join('\n');
  writeFileSync(filePath, trailingNewline ? `${body}\n` : body);
  return filePath;
}
