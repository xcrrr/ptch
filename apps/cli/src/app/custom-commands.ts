import type { CustomCommand, CustomCommandSet } from '@patch/core';
import { oneLine } from '@patch/shared';
import type { SlashCommandInfo } from '../ui/components/props.js';

const DESCRIPTION_MAX_CHARS = 80;

/** A typed slash command: its name (lowercase) and everything after it. */
export interface SlashInput {
  name: string;
  args: string;
}

/** "/review src/auth" → { name: "review", args: "src/auth" }; undefined for other text ("//x"). */
export function parseSlashInput(text: string): SlashInput | undefined {
  if (!text.startsWith('/') || text.startsWith('//')) return undefined;
  const head = text.slice(1).split(/\s/, 1)[0] ?? '';
  return { name: head.toLowerCase(), args: text.slice(1 + head.length).trim() };
}

/** What the slash menu and /help show for a custom command. */
export function customCommandInfo(command: CustomCommand): SlashCommandInfo {
  return {
    name: command.name,
    description: describeCustomCommand(command),
    ...(command.argumentHint ? { args: command.argumentHint } : {}),
    tag: command.scope,
  };
}

/** Its frontmatter description, else the first line of its prompt. */
export function describeCustomCommand(command: CustomCommand): string {
  if (command.description) return oneLine(command.description, DESCRIPTION_MAX_CHARS);
  const first = command.body.split('\n').find((line) => line.trim() !== '') ?? '';
  return oneLine(first.replace(/^#+\s*/, ''), DESCRIPTION_MAX_CHARS);
}

/**
 * Splits loaded commands into those that can run and those named like a built-in command, which
 * always wins.
 */
export function partitionCustomCommands(
  set: CustomCommandSet,
  builtInNames: ReadonlySet<string>,
): { usable: CustomCommand[]; shadowed: CustomCommand[] } {
  const usable: CustomCommand[] = [];
  const shadowed: CustomCommand[] = [];
  for (const command of set.commands) {
    (builtInNames.has(command.name) ? shadowed : usable).push(command);
  }
  return { usable, shadowed };
}

/** The notice for a custom command a built-in command hides. */
export function shadowedNotice(command: CustomCommand): { text: string; hint: string } {
  return {
    text: `Custom command /${command.name} (${command.source}) is not available: a built-in command has that name.`,
    hint: 'Rename the file to use it.',
  };
}
