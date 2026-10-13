import { resolve } from 'node:path';
import { WORKING_DIRECTORY_TAG, type Session } from '@patch/core';
import type { Message } from '@patch/shared';

/**
 * Notes that tell the model the working directory changed (a session resumed from another
 * directory) start with this tag. They are sent as a text block before the user's prompt, in the
 * same message (see `UserTurn.notes`); the transcript and session titles skip them.
 */
export { WORKING_DIRECTORY_TAG };

/** Where Patch runs: the directory tools resolve relative paths against, and its project. */
export interface DirectoryContext {
  cwd: string;
  projectRoot: string;
}

/** True when two paths name the same directory (case-insensitive on Windows and macOS). */
export function samePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return platform === 'win32' || platform === 'darwin'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function sameDirectory(a: DirectoryContext, b: DirectoryContext): boolean {
  return samePath(a.cwd, b.cwd) && samePath(a.projectRoot, b.projectRoot);
}

/** The directory the session was recorded in. */
export function recordedDirectory(session: Session): DirectoryContext {
  return { cwd: session.meta.cwd, projectRoot: session.meta.projectRoot };
}

/**
 * The directory the model currently believes it works in: the newest update note in its context,
 * else the one the frozen system prompt names. A compaction drops older notes from the context, so
 * after one the system prompt's directory applies again.
 */
export function modelDirectory(session: Session): DirectoryContext {
  const history = session.history();
  for (let i = history.length - 1; i >= 0; i--) {
    const update = parseDirectoryUpdate(history[i]);
    if (update) return update;
  }
  return recordedDirectory(session);
}

/**
 * The note that moves the model to `current`, sent with the user's next prompt. The system prompt
 * and earlier messages are never edited (the conversation is append-only), so this note supersedes
 * them instead.
 */
export function directoryUpdateNote(current: DirectoryContext, previous: DirectoryContext): string {
  return [
    WORKING_DIRECTORY_TAG,
    'This session was resumed in a different directory. These replace the working directory and project root given in the system prompt:',
    `Working directory: ${current.cwd}`,
    `Project root: ${current.projectRoot}`,
    `Relative paths and commands now resolve against this working directory. Earlier messages may use paths relative to the previous working directory (${previous.cwd}).`,
    WORKING_DIRECTORY_TAG.replace('<', '</'),
  ].join('\n');
}

function parseDirectoryUpdate(message: Message | undefined): DirectoryContext | undefined {
  if (message?.role !== 'user') return undefined;
  for (const block of message.content) {
    if (block.type !== 'text' || !block.text.startsWith(WORKING_DIRECTORY_TAG)) continue;
    const cwd = /^Working directory: (.+)$/m.exec(block.text)?.[1];
    const projectRoot = /^Project root: (.+)$/m.exec(block.text)?.[1];
    if (cwd && projectRoot) return { cwd, projectRoot };
  }
  return undefined;
}
