import type { CommandRisk } from './command-risk.js';

/** One reason a command has a given risk. */
export interface Finding {
  risk: CommandRisk;
  reason: string;
  /**
   * Why the finding matters beyond its risk: `secret` when the command may read or print secrets
   * (a file that may hold them, environment variables, shell history); `opaque` when Patch cannot
   * tell what the command runs or touches (a program named by a variable, unknown paths, input
   * too large or nested too deeply to analyze). Auto mode asks before either.
   */
  concern?: FindingConcern;
}

export type FindingConcern = 'secret' | 'opaque';

/** Classification of one program invocation (program name + arguments). */
export interface Verdict extends Finding {
  /** Words, counted from the program word, that form the session rule prefix. Default 1. */
  prefixLength?: number;
  /** False when approvals of this invocation must never be remembered for the session. */
  rememberable?: boolean;
  /** Arguments to check for paths outside the project. Default: every non-option argument. */
  paths?: string[];
  /**
   * The program only shows names or metadata of the files it is given (`ls`, `du`, `stat`),
   * never their contents, so naming a secret file is not a read of it.
   */
  listsOnly?: boolean;
  /** A command string this program runs (`bash -c`, `eval`); analyzed in place of the program. */
  script?: string;
  /** Command lines this program runs per item (`find -exec`, `fd -x`); analyzed as extra segments. */
  nested?: string[][];
}

/** What program classifiers may ask about the environment. */
export interface ProgramContext {
  platform: NodeJS.Platform;
  /**
   * True when the argument resolves to the filesystem root, a top-level directory, the home
   * directory, or a directory containing the project or home (or could expand to one).
   */
  isCatastrophicTarget(word: string): boolean;
  /**
   * Whether the argument names an existing file or directory; undefined when that cannot be
   * checked (variables, network paths, paths outside the project, an exhausted budget).
   */
  pathExists(word: string): boolean | undefined;
  /**
   * Whether the current directory is inside a git work tree; undefined when it cannot be
   * determined. Used to tell `git diff a b` (reads tracked files) from `git diff`'s implicit
   * `--no-index`, which compares arbitrary directories when run outside a repository.
   */
  inGitWorkTree(): boolean | undefined;
  /**
   * Whether a `git` command that changes into the given `-C <dir>` values (applied against the
   * tracked cwd) operates on the project's own repository rather than a different one nested
   * inside it. `false` only on a positive mismatch; `undefined` when it cannot be determined
   * (treated as the project's repository, the previous behavior).
   */
  gitRepoIsProject(cValues: readonly string[]): boolean | undefined;
  /**
   * Whether a recursive search over `roots` (empty means the current directory) could read a file
   * re-included by an ignore-file negation (`.ignore`/`.gitignore` with a `!` line), which would
   * let it print a secret such as `.env`. `false` only when no reachable ignore file negates;
   * `undefined` when it cannot be determined (treated as a possible secret).
   */
  searchHasNegatedIgnore(roots: readonly string[]): boolean | undefined;
  /** The highest-risk finding for a command string (used for remote and piped scripts). */
  analyzeScript(script: string): Finding;
}

export type Classifier = (args: string[], ctx: ProgramContext, name: string) => Verdict;

export const RISK_RANK: Record<CommandRisk, number> = {
  safe: 0,
  normal: 1,
  network: 2,
  destructive: 3,
  blocked: 4,
};

export function verdict(risk: CommandRisk, reason: string, extra: Partial<Verdict> = {}): Verdict {
  return { risk, reason, ...extra };
}

export const safe = (reason: string, extra?: Partial<Verdict>): Verdict =>
  verdict('safe', reason, extra);
export const normal = (reason: string, extra?: Partial<Verdict>): Verdict =>
  verdict('normal', reason, extra);
export const network = (reason: string, extra?: Partial<Verdict>): Verdict =>
  verdict('network', reason, extra);
export const destructive = (reason: string, extra?: Partial<Verdict>): Verdict =>
  verdict('destructive', reason, extra);
export const blocked = (reason: string, extra?: Partial<Verdict>): Verdict =>
  verdict('blocked', reason, extra);

/**
 * Returns the higher-risk verdict (the first one on ties), keeping the first's prefix data. A
 * concern of either is kept.
 */
export function raise(base: Verdict, other: Finding): Verdict {
  const concern = base.concern ?? other.concern;
  const raised =
    RISK_RANK[other.risk] > RISK_RANK[base.risk]
      ? { ...base, risk: other.risk, reason: other.reason }
      : base;
  return concern === undefined || raised.concern === concern ? raised : { ...raised, concern };
}

export function highest(findings: readonly Finding[]): Finding | undefined {
  let best: Finding | undefined;
  for (const finding of findings) {
    if (!best || RISK_RANK[finding.risk] > RISK_RANK[best.risk]) best = finding;
  }
  return best;
}

const NO_VALUES: ReadonlySet<string> = new Set();

/** Options start with "-" ("-" alone means stdin and is an operand). */
export function isOption(word: string): boolean {
  return word.length > 1 && word.startsWith('-');
}

/**
 * Index of the first operand at or after `from`, skipping options (and the separate values of
 * options listed in `valueOptions`). Returns -1 when there is none.
 */
export function firstOperandIndex(
  args: readonly string[],
  valueOptions: ReadonlySet<string> = NO_VALUES,
  from = 0,
): number {
  for (let i = from; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return i + 1 < args.length ? i + 1 : -1;
    if (isOption(arg)) {
      if (valueOptions.has(arg)) i++;
      continue;
    }
    return i;
  }
  return -1;
}

/** All operands (non-option arguments), honoring `--` and options that take a separate value. */
export function operands(
  args: readonly string[],
  valueOptions: ReadonlySet<string> = NO_VALUES,
): string[] {
  const result: string[] = [];
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (endOfOptions) {
      result.push(arg);
    } else if (arg === '--') {
      endOfOptions = true;
    } else if (isOption(arg)) {
      if (valueOptions.has(arg)) i++;
    } else {
      result.push(arg);
    }
  }
  return result;
}

/** Values given to `names` either as a separate word (`-o x`) or inline (`--out=x`, `-ox`). */
export function optionValues(args: readonly string[], names: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    for (const name of names) {
      if (arg === name && i + 1 < args.length) values.push(args[i + 1]);
      else if (name.startsWith('--') && arg.startsWith(`${name}=`))
        values.push(arg.slice(name.length + 1));
      else if (!name.startsWith('--') && arg.startsWith(name) && arg.length > name.length) {
        values.push(arg.slice(name.length));
      }
    }
  }
  return values;
}

/**
 * True when POSIX-style `args` contain one of the `long` options (with or without `=value`) or a
 * short-option cluster (`-rf`) containing one of the `short` letters. Stops at `--`.
 */
export function hasOption(
  args: readonly string[],
  { short = '', long = [] }: { short?: string; long?: readonly string[] },
): boolean {
  for (const arg of args) {
    if (arg === '--') return false;
    if (arg.startsWith('--')) {
      if (long.includes(arg.split('=')[0])) return true;
    } else if (/^-[A-Za-z]+$/.test(arg)) {
      for (const letter of arg.slice(1)) if (short.includes(letter)) return true;
    }
  }
  return false;
}

/**
 * True when `arg` (before `--`) is one of the long options `names` or an abbreviation of one
 * (`--use-comp=x` for `--use-compress-program`), with or without `=value`: programs built on
 * getopt_long or git's parse-options accept any unambiguous prefix, so a check for the full name
 * alone is easy to get around. Prefixes of at least two letters count.
 */
export function abbreviatesLong(arg: string, names: readonly string[]): boolean {
  if (!arg.startsWith('--')) return false;
  const written = arg.split('=')[0];
  return written.length >= 4 && names.some((name) => name.startsWith(written));
}

/** Index of `--` in `args`, or `args.length` when there is none. */
export function endOfOptions(args: readonly string[]): number {
  const index = args.indexOf('--');
  return index < 0 ? args.length : index;
}

/** Value of a PowerShell-style parameter (`-Verb RunAs` or `-Verb:RunAs`). */
export function parameterValue(args: readonly string[], ...names: string[]): string | undefined {
  const wanted = names.map((name) => name.toLowerCase());
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = splitOnce(args[i].toLowerCase(), ':');
    if (!wanted.includes(name)) continue;
    if (inline !== undefined) return args[i].slice(name.length + 1);
    return args[i + 1];
  }
  return undefined;
}

function splitOnce(text: string, separator: string): [string, string | undefined] {
  const index = text.indexOf(separator);
  return index < 0 ? [text, undefined] : [text.slice(0, index), text.slice(index + 1)];
}

/**
 * Looks up `key` in a plain-object table, ignoring inherited properties, so words such as
 * "constructor" or "__proto__" in a command never resolve to Object.prototype members.
 */
export function own<T>(table: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}
