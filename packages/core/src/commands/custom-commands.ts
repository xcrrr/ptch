import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeNewlines } from '@patch/shared';
import { isCaseInsensitivePlatform, relativeInside } from '../git/repo-path.js';

/**
 * Custom slash commands: reusable prompts the user writes as Markdown files. `review.md` is
 * `/review`, `frontend/test.md` is `/frontend:test`. A command is prompt text only: running one
 * sends its expanded text as an ordinary user message, so it never runs anything and never
 * grants a permission.
 */

/** Largest command file loaded; larger files are skipped with a warning. */
export const MAX_COMMAND_FILE_BYTES = 64 * 1024;
/** Most segments of a command name ("a:b:c" has three), i.e. directory levels plus one. */
const MAX_NAME_SEGMENTS = 5;
/** Files considered per commands directory at most, so a huge tree cannot slow startup. */
const MAX_COMMAND_FILES = 500;
/** One segment of a command name ("frontend" and "test" in /frontend:test), after lowercasing. */
const NAME_SEGMENT = /^[a-z0-9][a-z0-9_.-]*$/;
/**
 * Frontmatter keys of other agents' command files (.claude/commands) that Patch ignores without
 * a warning. Commands never grant tools or change the model.
 */
const IGNORED_FRONTMATTER_KEYS = new Set(['allowed-tools', 'model', 'disable-model-invocation']);
/** `$ARGUMENTS` and `$1` to `$9`. */
const PLACEHOLDER = /\$(ARGUMENTS|[1-9])/g;

export type CustomCommandScope = 'project' | 'user';

export interface CustomCommand {
  /** Without the slash, lowercase: "review", "frontend:test". */
  name: string;
  scope: CustomCommandScope;
  /** Absolute path of the Markdown file. */
  path: string;
  /** The file for display: ".patch/commands/review.md", "~/.patch/commands/review.md". */
  source: string;
  description?: string;
  /** How to call it, e.g. "[path]". */
  argumentHint?: string;
  /** The prompt template: the file without its frontmatter. */
  body: string;
}

export interface CustomCommandSet {
  /** Sorted by name, one command per name (see loadCustomCommands for precedence). */
  commands: CustomCommand[];
  /** Files that were skipped or only partly understood, and why. Never fatal. */
  warnings: string[];
}

export interface LoadCustomCommandsOptions {
  projectRoot: string;
  /** The user's commands directory, ~/.patch/commands (PatchPaths.commandsDir). */
  userDir: string;
  /** The user's home directory, for display paths. */
  home: string;
}

export interface ParsedCommandFile {
  description?: string;
  argumentHint?: string;
  body: string;
  /** Problems that did not keep the file from loading (unknown frontmatter keys). */
  warnings: string[];
}

interface CommandDir {
  scope: CustomCommandScope;
  dir: string;
  /** The directory for display, with forward slashes. */
  display: string;
}

interface CommandFile {
  file: string;
  /** Path below the commands directory, with forward slashes ("frontend/test.md"). */
  relative: string;
}

/**
 * Loads the custom commands, in precedence order (the first file with a name wins):
 *  1. `<project root>/.patch/commands/**\/*.md`
 *  2. `<project root>/.claude/commands/**\/*.md` (compatibility, like CLAUDE.md for PATCH.md)
 *  3. `~/.patch/commands/**\/*.md` (the user's commands, in every project)
 * Names are the path below the directory without `.md`, lowercase, with `:` between directories.
 * Files and directories starting with "." are ignored. Project directories must stay inside the
 * project (symbolic links there are not followed), so a repository cannot make Patch read files
 * from elsewhere. Unusable files (invalid name or frontmatter, empty, over MAX_COMMAND_FILE_BYTES)
 * are skipped with a warning. Never throws.
 */
export async function loadCustomCommands(
  options: LoadCustomCommandsOptions,
): Promise<CustomCommandSet> {
  const warnings: string[] = [];
  const commands = new Map<string, CustomCommand>();
  for (const location of commandDirs(options)) {
    for (const command of await loadDirectory(location, options.projectRoot, warnings)) {
      if (!commands.has(command.name)) commands.set(command.name, command);
    }
  }
  return {
    commands: [...commands.values()].sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
  };
}

/**
 * Parses a command file: optional frontmatter between `---` lines with `description` and
 * `argument-hint` (one `key: value` per line, values optionally quoted; blank lines and `#`
 * comments allowed), then the prompt. Deliberately strict and small: anything else in the
 * frontmatter is an error, except unknown keys, which are reported and ignored.
 */
export function parseCommandFile(raw: string): ParsedCommandFile | { error: string } {
  const lines = normalizeNewlines(raw.replace(/^\uFEFF/, '')).split('\n');
  const parsed: ParsedCommandFile = { body: '', warnings: [] };
  let bodyStart = 0;
  if (lines[0]?.trimEnd() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---');
    if (end === -1) return { error: 'its frontmatter has no closing "---" line' };
    for (let index = 1; index < end; index++) {
      const line = lines[index] ?? '';
      if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
      const match = /^([A-Za-z][\w-]*)[ \t]*:(.*)$/.exec(line);
      if (!match) return { error: `line ${index + 1} of its frontmatter is not "key: value"` };
      const key = (match[1] ?? '').toLowerCase();
      const value = unquote((match[2] ?? '').trim());
      if (value === undefined) return { error: `line ${index + 1} has an unterminated quote` };
      if (key === 'description') {
        if (value) parsed.description = value;
      } else if (key === 'argument-hint') {
        if (value) parsed.argumentHint = value;
      } else if (!IGNORED_FRONTMATTER_KEYS.has(key)) {
        parsed.warnings.push(`unknown frontmatter key "${key}" (ignored)`);
      }
    }
    bodyStart = end + 1;
  }
  parsed.body = lines
    .slice(bodyStart)
    .join('\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd();
  if (parsed.body === '') return { error: 'it has no prompt text' };
  return parsed;
}

/**
 * The prompt a command sends for `args` (everything typed after its name): `$ARGUMENTS` becomes
 * the whole argument text, `$1` to `$9` the arguments split at whitespace (quotes group words;
 * missing ones become empty). A prompt without placeholders gets the arguments appended after a
 * blank line. Substitution is a single pass: placeholders inside the arguments stay as typed.
 */
export function expandCustomCommand(command: Pick<CustomCommand, 'body'>, args: string): string {
  const text = args.trim();
  const positional = splitCommandArguments(text);
  let substituted = false;
  const expanded = command.body.replace(PLACEHOLDER, (_match, name: string) => {
    substituted = true;
    return name === 'ARGUMENTS' ? text : (positional[Number(name) - 1] ?? '');
  });
  if (substituted || text === '') return expanded;
  return `${expanded}\n\n${text}`;
}

/**
 * Splits command arguments at whitespace. An argument that starts with a double or single quote
 * runs to the matching quote that ends a word (`"two words"` is one argument, without the
 * quotes); quotes anywhere else are ordinary characters, so `don't` and `C:\dir` stay intact.
 */
export function splitCommandArguments(text: string): string[] {
  const args: string[] = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index]!)) index++;
    if (index >= text.length) break;
    const char = text[index]!;
    if (char === '"' || char === "'") {
      const close = closingQuote(text, index + 1, char);
      if (close !== -1) {
        args.push(text.slice(index + 1, close));
        index = close + 1;
        continue;
      }
    }
    let end = index;
    while (end < text.length && !/\s/.test(text[end]!)) end++;
    args.push(text.slice(index, end));
    index = end;
  }
  return args;
}

/** The command name for a path below a commands directory, or undefined when it is not valid. */
export function commandNameFor(relativePath: string): string | undefined {
  const segments = relativePath.replace(/\.md$/i, '').split(/[\\/]/);
  if (segments.length > MAX_NAME_SEGMENTS) return undefined;
  const lower = segments.map((segment) => segment.toLowerCase());
  return lower.every((segment) => NAME_SEGMENT.test(segment)) ? lower.join(':') : undefined;
}

function commandDirs(options: LoadCustomCommandsOptions): CommandDir[] {
  const { projectRoot, userDir, home } = options;
  const project: CommandDir[] = [
    {
      scope: 'project',
      dir: path.join(projectRoot, '.patch', 'commands'),
      display: '.patch/commands',
    },
    {
      scope: 'project',
      dir: path.join(projectRoot, '.claude', 'commands'),
      display: '.claude/commands',
    },
  ];
  const user: CommandDir = { scope: 'user', dir: userDir, display: displayUserPath(userDir, home) };
  // Started in the home directory, ~/.patch/commands is both: it belongs to the user.
  return [...project.filter((location) => !samePath(location.dir, userDir)), user];
}

async function loadDirectory(
  location: CommandDir,
  projectRoot: string,
  warnings: string[],
): Promise<CustomCommand[]> {
  if (location.scope === 'project' && !(await staysInside(location.dir, projectRoot))) {
    warnings.push(`Skipped ${location.display}: it leads outside the project.`);
    return [];
  }
  const commands = new Map<string, CustomCommand>();
  for (const { file, relative } of await findCommandFiles(location, warnings)) {
    const source = `${location.display}/${relative}`;
    const name = commandNameFor(relative);
    if (name === undefined) {
      warnings.push(
        `Skipped ${source}: command names may only use letters, digits, "-", "_" and "." (and at most ${MAX_NAME_SEGMENTS - 1} directory levels).`,
      );
      continue;
    }
    const existing = commands.get(name);
    if (existing) {
      warnings.push(`Skipped ${source}: /${name} is already defined by ${existing.source}.`);
      continue;
    }
    const read = await readCommandFile(file);
    const parsed = 'error' in read ? read : parseCommandFile(read.text);
    if ('error' in parsed) {
      warnings.push(`Skipped ${source}: ${parsed.error}.`);
      continue;
    }
    for (const warning of parsed.warnings) warnings.push(`In ${source}: ${warning}.`);
    commands.set(name, {
      name,
      scope: location.scope,
      path: file,
      source,
      ...(parsed.description ? { description: parsed.description } : {}),
      ...(parsed.argumentHint ? { argumentHint: parsed.argumentHint } : {}),
      body: parsed.body,
    });
  }
  return [...commands.values()];
}

/** The `.md` files below a commands directory, in a stable order. */
async function findCommandFiles(location: CommandDir, warnings: string[]): Promise<CommandFile[]> {
  const files: CommandFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (depth === 0 && !isMissing(error)) {
        warnings.push(`Could not read ${location.display}: ${errorCode(error)}.`);
      }
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || files.length >= MAX_COMMAND_FILES) continue;
      const full = path.join(dir, entry.name);
      const relative = toSlashes(path.relative(location.dir, full));
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        if (location.scope === 'project') {
          warnings.push(
            `Skipped ${location.display}/${relative}: symbolic links are not followed in project commands.`,
          );
          continue;
        }
        const target = await stat(full).catch(() => undefined);
        isDirectory = target?.isDirectory() ?? false;
        isFile = target?.isFile() ?? false;
      }
      if (isDirectory && depth + 1 < MAX_NAME_SEGMENTS) await walk(full, depth + 1);
      else if (isFile && /\.md$/i.test(entry.name)) files.push({ file: full, relative });
    }
  };
  await walk(location.dir, 0);
  if (files.length >= MAX_COMMAND_FILES) {
    warnings.push(
      `${location.display} holds more than ${MAX_COMMAND_FILES} command files; only the first ${MAX_COMMAND_FILES} were loaded.`,
    );
  }
  return files;
}

async function readCommandFile(file: string): Promise<{ text: string } | { error: string }> {
  const tooLarge = `it is larger than ${MAX_COMMAND_FILE_BYTES / 1024} KB`;
  try {
    if ((await stat(file)).size > MAX_COMMAND_FILE_BYTES) return { error: tooLarge };
    const bytes = await readFile(file);
    if (bytes.length > MAX_COMMAND_FILE_BYTES) return { error: tooLarge };
    return { text: bytes.toString('utf8') };
  } catch (error) {
    return { error: `it could not be read (${errorCode(error)})` };
  }
}

/**
 * True when `dir`, followed through symbolic links, is inside the project (or does not exist,
 * leaving nothing to read).
 */
async function staysInside(dir: string, projectRoot: string): Promise<boolean> {
  let real: string;
  try {
    real = await realpath(dir);
  } catch {
    return true;
  }
  const root = await realpath(projectRoot).catch(() => projectRoot);
  return relativeInside(root, real) !== undefined;
}

/** A value starting with a quote must end with the same quote, which is removed. */
function unquote(value: string): string | undefined {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return value;
  if (value.length < 2 || !value.endsWith(quote)) return undefined;
  return value.slice(1, -1);
}

/** Index of the quote closing an argument: the next `quote` followed by whitespace or the end. */
function closingQuote(text: string, from: number, quote: string): number {
  for (
    let index = text.indexOf(quote, from);
    index !== -1;
    index = text.indexOf(quote, index + 1)
  ) {
    if (index + 1 >= text.length || /\s/.test(text[index + 1]!)) return index;
  }
  return -1;
}

function displayUserPath(dir: string, home: string): string {
  const relative = relativeInside(home, dir);
  if (relative === undefined) return toSlashes(dir);
  return relative === '' ? '~' : `~/${toSlashes(relative)}`;
}

function toSlashes(value: string): string {
  return value.split(path.sep).join('/');
}

function samePath(a: string, b: string): boolean {
  const fold = (value: string) =>
    isCaseInsensitivePlatform(process.platform) ? value.toLowerCase() : value;
  return fold(path.resolve(a)) === fold(path.resolve(b));
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? String(error);
}
