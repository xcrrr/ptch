import { parseCommand } from './command-parser.js';
import { normalizeCommandText } from './rules.js';

/**
 * The shape of an approved command, so a session approval covers the command the user actually
 * saw and not riskier variants: "don't ask again for `npm test`" must not later allow
 * `npm test --script-shell=./hook.sh` or `NODE_OPTIONS=... npm test`.
 */
export interface GrantShape {
  /** Option names used after the prefix (`--coverage`, `-run`, `-Dkey`, `-p:Prop`). */
  options: string[];
  /** Names of variables the command sets for the program (`CI` in `CI=1 pnpm test`). */
  variables: string[];
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/** Option names (the part before `=`) among `words`, up to a `--` that ends the options. */
export function optionNames(words: readonly string[]): string[] {
  const names: string[] = [];
  for (const word of words) {
    if (word === '--') break;
    if (!word.startsWith('-') || word === '-') continue;
    const eq = word.indexOf('=');
    names.push(eq > 0 ? word.slice(0, eq) : word);
  }
  return names;
}

/** Variable names set for programs in `command`: leading assignments and `env NAME=value`. */
export function variableNames(command: string): string[] {
  const parsed = parseCommand(command);
  const names: string[] = [];
  for (const simple of parsed.commands) {
    for (const assignment of simple.assignments) {
      const name = ASSIGNMENT.exec(assignment)?.[1];
      if (name) names.push(name);
    }
    if (simple.words[0] === 'env') {
      for (const word of simple.words.slice(1)) {
        if (word.startsWith('-')) continue;
        const name = ASSIGNMENT.exec(word)?.[1];
        if (!name) break;
        names.push(name);
      }
    }
  }
  return names;
}

/** The words of `text` after the words of `prefix` (both normalized). */
export function wordsAfterPrefix(text: string, prefix: string): string[] {
  const words = normalizeCommandText(text).split(' ');
  const count = normalizeCommandText(prefix).split(' ').length;
  return words.slice(count);
}

/** The shape a grant records for a segment of an approved command. */
export function shapeOf(segmentText: string, prefix: string, command: string): GrantShape {
  return {
    options: [...new Set(optionNames(wordsAfterPrefix(segmentText, prefix)))],
    variables: [...new Set(variableNames(command))],
  };
}

/** True when a later segment stays within the options and variables the approved command used. */
export function withinShape(
  shape: Partial<GrantShape>,
  segmentText: string,
  prefix: string,
  command: string,
): boolean {
  if (shape.options) {
    const allowed = new Set(shape.options);
    if (!optionNames(wordsAfterPrefix(segmentText, prefix)).every((name) => allowed.has(name))) {
      return false;
    }
  }
  if (shape.variables) {
    const allowed = new Set(shape.variables);
    if (!variableNames(command).every((name) => allowed.has(name))) return false;
  }
  return true;
}
