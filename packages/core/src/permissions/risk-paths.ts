import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { GLOB_CHARS, segmentMatcher, type SegmentMatchOptions } from './glob.js';
import { isOption } from './risk-helpers.js';
import {
  isCaseInsensitivePlatform,
  isStrictAncestor,
  isWithin,
  pathApi,
  samePath,
} from './path-utils.js';

/** Where command arguments are resolved. */
export interface PathEnvironment {
  platform: NodeJS.Platform;
  projectRoot: string;
  home: string;
  /**
   * Directories a relative argument may be resolved against: the starting cwd plus every `cd`
   * target seen so far. An argument is outside when it is outside for any of them.
   */
  cwds: string[];
  /** Work left for filesystem checks and pattern analysis (created on first use when absent). */
  budget?: AnalysisBudget;
  /** Symlink-free form of projectRoot, computed once per analysis (see canonicalProjectRoot). */
  canonicalRoot?: string;
  /**
   * On win32, whether the shell treats an unquoted backslash as an escape (a POSIX shell such as
   * Git Bash, the Windows default) rather than a path separator. When true, words with backslashes
   * are also read the POSIX way, so `cat .\env` is seen to read `.env` (see command-risk.ts).
   */
  backslashEscapes?: boolean;
}

export type PathLocation = 'inside' | 'outside' | 'variable';

// -----------------------------------------------------------------------------------------------
// Budget

/**
 * A hard limit on the work one classification may do, shared by every argument, brace
 * alternative, nested script and cwd: filesystem calls and directory entries, pattern candidates,
 * and wall-clock time. Classification is synchronous and runs before the user is asked, so it
 * must stay fast whatever the command. Checks that run out assume the worst (the argument may
 * name a secret or a file inside `.git`) and set `exhausted`.
 */
export interface AnalysisBudget {
  /** Filesystem calls and directory entries left. */
  fs: number;
  /** Pattern candidates (brace alternatives and filename patterns, per cwd) left. */
  patterns: number;
  /** `performance.now()` after which checks stop. */
  deadline: number;
  /** Units of work done so far. */
  work: number;
  /** True once a check was skipped because the budget ran out. */
  exhausted: boolean;
}

const FS_BUDGET = 4000;
const PATTERN_BUDGET = 2048;
const TIME_BUDGET_MS = 10;
/** Work done before the clock is consulted, so ordinary commands never depend on timing. */
const UNTIMED_WORK = 256;

export function createBudget(): AnalysisBudget {
  return {
    fs: FS_BUDGET,
    patterns: PATTERN_BUDGET,
    deadline: performance.now() + TIME_BUDGET_MS,
    work: 0,
    exhausted: false,
  };
}

/** Spends budget; false (and `exhausted`) when the work must be skipped. */
function spend(env: PathEnvironment, kind: 'fs' | 'patterns' | 'work', amount = 1): boolean {
  const budget = (env.budget ??= createBudget());
  if (budget.exhausted) return false;
  if (kind !== 'work') budget[kind] -= amount;
  budget.work += amount;
  if (
    (kind !== 'work' && budget[kind] < 0) ||
    (budget.work > UNTIMED_WORK && performance.now() > budget.deadline)
  ) {
    budget.exhausted = true;
    return false;
  }
  return true;
}

/**
 * Counts units of analysis work (a command, a redirection, 256 characters of script) against the
 * time budget. False once the budget has run out: the caller then skips detailed checks and
 * assumes the worst.
 */
export function spendWork(env: PathEnvironment, amount = 1): boolean {
  return spend(env, 'work', amount);
}

/** True once the analysis budget has run out (see AnalysisBudget). */
export function budgetExhausted(env: PathEnvironment): boolean {
  return env.budget?.exhausted === true;
}

/** Windows reserved device names (`NUL`, `COM1`, `CON.txt`): opening them opens the device. */
const WINDOWS_DEVICE =
  /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)([.:].*)?\s*$/i;

/**
 * Whether `absolute` may be checked on disk: only when analyzing commands for the host platform,
 * only inside the project or the home directory, and never for network or device paths. On a
 * Windows host every path starting with two separators (`\\host\share`, `//host/share`, `\\?\`,
 * `\\.\`, also `/\host`) is refused unless it is inside the project: merely opening a network path
 * sends the user's credentials to the host, and an unreachable host blocks for many seconds.
 * Windows device names (`NUL`, `COM1`) are refused anywhere. Paths that are not checked are
 * treated as unknown by the callers, never as harmless.
 */
function mayProbe(absolute: string, env: PathEnvironment): boolean {
  const { platform, projectRoot, home } = env;
  if (platform !== process.platform) return false;
  const inProject = isWithin(absolute, projectRoot, platform);
  if (platform === 'win32') {
    if (/^[\\/]{2}/.test(absolute) && !inProject) return false;
    if (absolute.split(/[\\/]+/).some((segment) => WINDOWS_DEVICE.test(segment))) return false;
  }
  return inProject || isWithin(absolute, home, platform);
}

// -----------------------------------------------------------------------------------------------
// Working directories

/** `cd` targets tracked per analysis; more make relative paths count as outside the project. */
const MAX_WORKING_DIRECTORIES = 16;

/**
 * Records a working directory the rest of the command may run in (`cd dir`); it becomes the
 * current one (the last in `env.cwds`). `undefined` means the directory is unknown (`cd -`,
 * `cd "$dir"`): from then on relative paths also resolve against the filesystem root, so they
 * count as outside the project. So does every new directory beyond MAX_WORKING_DIRECTORIES.
 */
export function enterDirectory(env: PathEnvironment, directory: string | undefined): void {
  const { platform, cwds } = env;
  const indexOf = (path: string): number => cwds.findIndex((cwd) => samePath(cwd, path, platform));
  let target = directory;
  if (target === undefined || (indexOf(target) < 0 && cwds.length >= MAX_WORKING_DIRECTORIES)) {
    const api = pathApi(platform);
    target = api.parse(api.resolve(env.projectRoot)).root;
  }
  const index = indexOf(target);
  if (index >= 0) cwds.splice(index, 1);
  cwds.push(target);
}

// -----------------------------------------------------------------------------------------------
// Locations

const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
/** `user@host:path`, `host:path`, `HEAD:file`, `Header: value` (but not `C:` drive letters). */
const REMOTE_PATTERN = /^(?:[\w.-]+@[\w.-]+:|[A-Za-z0-9._-]{2,}:)/;
const SUBSTITUTION_PATTERN = /\$\(|`|[<>]\(/;
const HOME_VARIABLE =
  /^(?:\$HOME|\$\{HOME\}|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%|\$env:USERPROFILE|\$env:HOME)(?=$|[\\/])/i;
const VARIABLE_PATTERN = /\$\{?[A-Za-z_]|%[A-Za-z_][A-Za-z0-9_]*%|\$env:/i;
/** `--opt=value`, `-opt=value` and PowerShell's `-Param:value`. */
const INLINE_OPTION_VALUE = /^--?[A-Za-z][\w-]*[=:](.*)$/s;
const INLINE_OPTION_NAME = /^--?[A-Za-z][\w-]*[=:]/;
/** Attached short-option values worth checking: paths, home and variable references. */
const PATHLIKE = /^[~.$%\\/]|[\\/]|^[A-Za-z]:/;
const MAX_ATTACHED_CANDIDATES = 8;
const HARMLESS_DEVICES = new Set([
  '/dev/null',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  'nul',
  'con',
  '$null',
]);

/** True for `/dev/null`, `/dev/stdout`, `NUL`, `$null` and similar pseudo-files. */
export function isHarmlessDevice(target: string): boolean {
  const lower = target.toLowerCase();
  return HARMLESS_DEVICES.has(lower) || /^\/dev\/fd\/\d+$/.test(lower);
}

/** True for real devices such as `/dev/sda` or `\\.\PhysicalDrive0` (writing to them destroys disks). */
export function isRawDevice(target: string): boolean {
  if (isHarmlessDevice(target)) return false;
  return /^\/dev\//.test(target) || /^\\\\\.\\/.test(target);
}

/**
 * Where an argument points, or undefined when it is not a local path (options, URLs, remote
 * specs, substitutions, pseudo-devices). `--opt=value`, PowerShell's `-Param:value`, curl-style
 * `@file` and attached short-option values (`-o/home/u/.bashrc`) are unwrapped. Never touches
 * the file system.
 */
export function locatePathArgument(word: string, env: PathEnvironment): PathLocation | undefined {
  let location: PathLocation | undefined;
  for (const candidate of pathCandidates(word, env.platform)) {
    const located = locateCandidate(candidate, env);
    if (located === 'outside') return 'outside';
    if (located === 'variable' || location === undefined) location = located;
  }
  return location;
}

function locateCandidate(candidate: string, env: PathEnvironment): PathLocation {
  const expanded = expandHome(candidate, env.home);
  if (expanded === undefined) return 'outside';
  if (VARIABLE_PATTERN.test(expanded)) return 'variable';
  // A relative `name:`-prefixed path with a `..` segment may escape the project through a symlink
  // named `name:` (`ab: -> /`), which the lexical isWithin check below cannot see: assume outside.
  if (remoteLikeMayEscape(expanded, env.platform)) return 'outside';
  for (const cwd of env.cwds) {
    const absolute = resolveArgument(expanded, cwd, env.platform);
    // Lexically inside is not enough: a symlink or junction inside the project can point out of
    // it (`docs -> /home/user`), so the path is checked after resolving links as well.
    if (!isWithin(absolute, env.projectRoot, env.platform)) return 'outside';
    if (resolvesOutsideProject(absolute, env)) return 'outside';
  }
  return 'inside';
}

/**
 * The local paths an argument may name: the word itself, the value of `--opt=value` or
 * `-Param:value`, the file of a curl-style form field (`name=@file`, `name=<file`), or for short
 * options with an attached value (`-o.git/hooks/x`, `-vt/etc`) every path-like tail after the
 * option letters. `file://` URLs name local files too. Empty for other options, URLs, remote
 * specs, substitutions and pseudo-devices.
 */
function pathCandidates(word: string, platform: NodeJS.Platform = process.platform): string[] {
  const inline = INLINE_OPTION_VALUE.exec(word);
  const field = /^[\w.-]+=[@<](.+)$/s.exec(word)?.[1];
  let raw: string[];
  if (inline) {
    raw = [inline[1]];
  } else if (field !== undefined) {
    raw = [field];
  } else if (/^-[A-Za-z]/.test(word)) {
    raw = [];
    for (let i = 2; i < word.length && raw.length < MAX_ATTACHED_CANDIDATES; i++) {
      if (!/[A-Za-z0-9]/.test(word[i - 1])) break;
      const tail = word.slice(i).replace(/^=/, '');
      if (PATHLIKE.test(tail) || looksSensitive(tail)) raw.push(tail);
    }
  } else if (isOption(word)) {
    return [];
  } else {
    raw = [word];
  }
  return raw
    .map((candidate) => cleanCandidate(candidate, platform))
    .filter((candidate) => candidate !== undefined);
}

/** The bare `host:path` form of REMOTE_PATTERN (no `user@`), which is also a valid POSIX filename. */
const REMOTE_BARE = /^[A-Za-z0-9._-]{2,}:/;

/**
 * True when `candidate` looks like a bare `host:path` remote spec but, on a POSIX platform, is also
 * a valid local file name (`:` cannot appear in a Windows file name, and a planted directory or
 * symlink named `host:` makes it a real local path). A genuine remote spec resolved locally stays
 * inside the project (`host:b` → `<cwd>/host:b`), so keeping it as a candidate is harmless, while
 * `ab:/../../etc/passwd` is caught as outside. `user@host:` specs are left as remote.
 */
function remoteLocalCandidate(candidate: string, platform: NodeJS.Platform): boolean {
  return platform !== 'win32' && REMOTE_BARE.test(candidate);
}

/** True when a bare `host:`-prefixed relative path has a `..` segment (see locateCandidate). */
export function remoteLikeMayEscape(candidate: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32' || !REMOTE_BARE.test(candidate)) return false;
  return candidate.split('/').includes('..');
}

function cleanCandidate(value: string, platform: NodeJS.Platform): string | undefined {
  let candidate = value.startsWith('@') ? value.slice(1) : value;
  // `file:///etc/passwd` and `file://localhost/x` are local paths; `file://host/x` is on `host`.
  const local = /^file:\/\/(localhost(?=\/))?/i.exec(candidate);
  if (local) {
    const rest = candidate.slice(local[0].length);
    candidate = rest.startsWith('/') ? rest : `//${rest}`;
  }
  if (candidate === '' || candidate === '-') return undefined;
  if (URL_PATTERN.test(candidate)) return undefined;
  if (REMOTE_PATTERN.test(candidate) && !remoteLocalCandidate(candidate, platform))
    return undefined;
  if (SUBSTITUTION_PATTERN.test(candidate) || isHarmlessDevice(candidate)) return undefined;
  return candidate;
}

/**
 * True when deleting or re-permissioning `word` would be catastrophic: the filesystem root, a
 * top-level directory, the home directory, a directory containing the project or home, another
 * user's home (`~user`), or `$VAR/` (which becomes `/` when the variable is empty).
 */
export function isCatastrophicTarget(word: string, env: PathEnvironment): boolean {
  let candidate = word.trim();
  if (candidate === '') return false;
  if (/^\$\{?[A-Za-z_]\w*\}?[\\/]+\*?$/.test(candidate) && !HOME_VARIABLE.test(candidate)) {
    return true;
  }
  candidate = candidate.replace(/(^|[\\/])\*+$/, '$1') || '.';
  const expanded = expandHome(candidate, env.home);
  if (expanded === undefined) return true;
  if (VARIABLE_PATTERN.test(expanded)) return false;
  const { platform, home, projectRoot } = env;
  return env.cwds.some((cwd) => {
    const absolute = resolveArgument(expanded, cwd, platform);
    if (samePath(absolute, home, platform)) return true;
    if (isWithin(absolute, projectRoot, platform)) return false;
    return (
      isTopLevel(absolute, platform) ||
      isStrictAncestor(absolute, home, platform) ||
      isStrictAncestor(absolute, projectRoot, platform)
    );
  });
}

/**
 * Whether the argument names an existing file or directory (relative to the latest cwd), or
 * undefined when that cannot be checked: variables, network and device paths, paths outside the
 * project and home, or an exhausted budget. Analyses for another platform than the host's (tests)
 * see an empty file system, here and in every other check: nothing exists.
 */
export function pathExists(word: string, env: PathEnvironment): boolean | undefined {
  const expanded = expandHome(word, env.home);
  if (expanded === undefined || VARIABLE_PATTERN.test(expanded)) return undefined;
  if (env.platform !== process.platform) return false;
  const absolute = resolveArgument(expanded, env.cwds[env.cwds.length - 1], env.platform);
  if (!mayProbe(absolute, env) || !spend(env, 'fs')) return undefined;
  try {
    return existsSync(absolute);
  } catch {
    return false;
  }
}

/**
 * Whether the current directory is inside a git work tree, found by looking for a `.git` entry
 * from the latest cwd upward. Bounded and local-only (never UNC/device paths, see mayProbe), and
 * `undefined` when it cannot be determined (another platform, budget exhausted, or the search
 * leaves the paths it may probe). Callers treat `undefined` as "not a work tree" (assume the
 * worst), so a command that only reads inside a repo is not wrongly allowed outside one.
 */
export function inGitWorkTree(env: PathEnvironment): boolean | undefined {
  if (env.platform !== process.platform) return undefined;
  const api = pathApi(env.platform);
  let dir = api.resolve(env.cwds[env.cwds.length - 1]);
  for (let depth = 0; depth < MAX_WORKING_DIRECTORIES; depth++) {
    if (!mayProbe(dir, env) || !spend(env, 'fs')) return undefined;
    try {
      if (existsSync(api.join(dir, '.git'))) return true;
    } catch {
      return undefined;
    }
    const parent = api.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return undefined;
}

/**
 * The directory holding the git repository that governs `start` (the nearest ancestor with a
 * `.git` entry, or that is itself a bare repository committed as ordinary files — HEAD, objects/
 * and refs/, which is how an embedded repo gets past git's `.git` path ban). `undefined` when
 * there is none up to the filesystem root; UNKNOWN when it cannot be determined (another platform,
 * budget exhausted, or the walk leaves the paths it may probe).
 */
function repoRoot(start: string, env: PathEnvironment): string | undefined | typeof UNKNOWN {
  const api = pathApi(env.platform);
  let dir = api.resolve(start);
  for (let depth = 0; depth <= MAX_WORKING_DIRECTORIES; depth++) {
    if (!mayProbe(dir, env) || !spend(env, 'fs')) return UNKNOWN;
    try {
      if (existsSync(api.join(dir, '.git'))) return dir;
      if (
        existsSync(api.join(dir, 'HEAD')) &&
        existsSync(api.join(dir, 'objects')) &&
        existsSync(api.join(dir, 'refs'))
      ) {
        return dir;
      }
    } catch {
      return UNKNOWN;
    }
    const parent = api.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return UNKNOWN;
}

/**
 * Whether a `git` command that changes into `cValues` (the `-C <dir>` values, applied in order
 * against the tracked cwd) operates on the project's own repository rather than a different one
 * nested inside it. `false` only when it positively resolves to another repository (so a safe
 * read would run that repo's textconv/filter code); `true` when it is the project's; `undefined`
 * when it cannot be determined, which callers treat as the project's (the previous behavior).
 */
export function gitRepositoryIsProject(
  env: PathEnvironment,
  cValues: readonly string[],
): boolean | undefined {
  if (env.platform !== process.platform) return undefined;
  const api = pathApi(env.platform);
  let effective = api.resolve(env.cwds[env.cwds.length - 1]);
  for (const value of cValues) {
    const expanded = expandHome(value, env.home);
    if (expanded === undefined || VARIABLE_PATTERN.test(expanded)) return undefined;
    effective = resolveArgument(expanded, effective, env.platform);
  }
  const here = repoRoot(effective, env);
  if (here === UNKNOWN) return undefined;
  const project = repoRoot(api.resolve(env.projectRoot), env);
  if (project === UNKNOWN) return undefined;
  if (here === undefined || project === undefined) return here === project ? true : undefined;
  return samePath(here, project, env.platform);
}

/** Resolves a (home-expanded) argument; Git Bash drive paths (`/c/Users`) become `C:\Users`. */
export function resolveArgument(argument: string, cwd: string, platform: NodeJS.Platform): string {
  let target = argument;
  if (platform === 'win32') {
    const drive = /^\/([A-Za-z])(?=\/|$)/.exec(target);
    if (drive) target = `${drive[1]}:\\${target.slice(2)}`;
  }
  return pathApi(platform).resolve(cwd, target);
}

/** Expands `~`, `~/x`, `$HOME`, `%USERPROFILE%`; undefined for `~user` (unknown home). */
export function expandHome(word: string, home: string): string | undefined {
  if (word === '~') return home;
  if (/^~[\\/]/.test(word)) return home + word.slice(1);
  if (word.startsWith('~')) return undefined;
  const variable = HOME_VARIABLE.exec(word);
  return variable ? home + word.slice(variable[0].length) : word;
}

function isTopLevel(absolute: string, platform: NodeJS.Platform): boolean {
  const { root } = pathApi(platform).parse(absolute);
  return absolute.slice(root.length).split(/[\\/]/).filter(Boolean).length <= 1;
}

// -----------------------------------------------------------------------------------------------
// Secrets

const SECRET_DIRECTORIES = new Set(['.ssh', '.aws', '.gnupg']);
const SECRET_FILES = new Set([
  '.netrc',
  '_netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  'credentials',
  'credentials.json',
]);

/**
 * True when an argument names a file that commonly holds secrets: `.env*` (except
 * `.env.example`/`.sample`/`.template`/`.defaults`), keys and certificates (`*.pem`, `*.key`,
 * `*.p12`, `*.pfx`, `*.keystore`, `id_rsa*`... but not `*.pub`), credential files, and `.ssh`,
 * `.aws` or `.gnupg` directories and anything under them. Mirrors the file tools'
 * sensitive-path policy so shell reads cannot bypass it. Revision and remote prefixes
 * (`HEAD:.env`), NTFS stream suffixes (`.env::$DATA`) and the trailing dots and spaces Windows
 * ignores (`server.key.`) do not hide a name.
 */
export function looksSensitive(word: string): boolean {
  const value = word.replace(INLINE_OPTION_NAME, '').replace(/^@/, '');
  // Git pathspec magic (`:(literal).env`, `:(icase,top).npmrc`, `:/.env`, `:!x`) names the path
  // that follows it.
  const pathspec = value.replace(/^:\([^)]*\)/, '').replace(/^:[/!^]+/, '');
  const forms = value.includes(':') ? [value, pathspec, ...value.split(':')] : [value];
  return forms.some(namesSecret);
}

function namesSecret(value: string): boolean {
  const parts = value
    .split(/[\\/]/)
    .map((part) => part.replace(/[. ]+$/, '').toLowerCase())
    .filter(Boolean);
  if (parts.some((part) => SECRET_DIRECTORIES.has(part))) return true;
  const base = parts[parts.length - 1] ?? '';
  if (base.startsWith('.env') && !/^\.env\.(example|sample|template|defaults)$/.test(base))
    return true;
  if (/\.(pem|key|p12|pfx|keystore)$/.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base) && !base.endsWith('.pub')) return true;
  return SECRET_FILES.has(base);
}

// -----------------------------------------------------------------------------------------------
// Shell expansion: filename patterns and brace expansion

/** Words a brace expansion may produce before Patch stops expanding and assumes the worst. */
const MAX_BRACE_WORDS = 256;
/** Longest pattern analyzed; longer ones are assumed to match secrets. */
const MAX_PATTERN_LENGTH = 4096;

/**
 * True when the shell may rewrite the word before the program sees it: filename patterns (`*`,
 * `?`, `[...]`) and brace expansion (`{a,b}`, `{1..3}`). On POSIX only unquoted, unescaped
 * characters of `raw` (the word as written) count. On Windows quoting does not matter: PowerShell
 * expands wildcards in quoted `-Path` values, and the command may run in Git Bash or PowerShell.
 */
export function shellMayExpand(
  value: string,
  raw: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (platform === 'win32' || raw === undefined) {
    // A `{` with a `}` after it (what `/\{[^}]*\}/` matches), found in linear time: the regular
    // expression rescans the rest of the word from every `{` when there is no `}`.
    const open = value.indexOf('{');
    return GLOB_CHARS.test(value) || (open >= 0 && value.indexOf('}', open + 1) > 0);
  }
  let quote: string | undefined;
  let openBrace = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (quote === "'") {
      if (char === "'") quote = undefined;
    } else if (char === '\\') {
      i++;
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (GLOB_CHARS.test(char)) {
      return true;
    } else if (char === '{' && raw[i - 1] !== '$') {
      openBrace = true;
    } else if (char === '}' && openBrace) {
      return true;
    }
  }
  return false;
}

/**
 * Bash brace expansion: `a{b,c}d` gives `abd acd`, in that order. Sequences (`{1..9}`, `{a..z}`)
 * become a `*` wildcard. Returns undefined when the expansion would produce too many words.
 */
export function expandBraces(word: string): string[] | undefined {
  if (word.length > MAX_PATTERN_LENGTH) return undefined;
  const results: string[] = [];
  const pending = [word];
  for (let steps = 0; pending.length > 0; steps++) {
    if (steps > MAX_BRACE_WORDS * 4) return undefined;
    const current = pending.pop() as string;
    const group = findBraceGroup(current);
    if (!group) {
      results.push(current);
      if (results.length > MAX_BRACE_WORDS) return undefined;
      continue;
    }
    if (pending.length + group.items.length > MAX_BRACE_WORDS) return undefined;
    const before = current.slice(0, group.start);
    const after = current.slice(group.end + 1);
    // Pushed in reverse, so the stack yields the alternatives in bash's order.
    for (let i = group.items.length - 1; i >= 0; i--) pending.push(before + group.items[i] + after);
  }
  return results;
}

/** Words a command may have after brace expansion before Patch stops and assumes the worst. */
const MAX_EXPANDED_WORDS = 1024;

export interface ExpandedWords {
  words: string[];
  /** The expanded words as written; for expanded words the same as the words. */
  rawWords: string[];
  /** True when some word was expanded. */
  expanded: boolean;
}

/**
 * Applies bash brace expansion to a command's words, as bash does before running it:
 * `cp a{,.bak}` runs `cp a a.bak`, `{rm,-rf,x}` runs `rm -rf x` and `cat {/etc/passwd,x}` reads
 * /etc/passwd. Only unquoted braces expand. Undefined when the result cannot be known exactly:
 * expanding braces in a word that also has quotes, escapes or expansions (`"$d"/{a,b}`), or more
 * than MAX_EXPANDED_WORDS words.
 */
export function expandCommandBraces(
  words: readonly string[],
  rawWords: readonly string[],
): ExpandedWords | undefined {
  if (!words.some((word) => word.includes('{'))) {
    return { words: [...words], rawWords: [...rawWords], expanded: false };
  }
  const result: ExpandedWords = { words: [], rawWords: [], expanded: false };
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const raw = rawWords[i] ?? word;
    const alternatives = raw.includes('{') ? braceAlternatives(word, raw) : [word];
    if (alternatives === undefined) return undefined;
    if (alternatives.length === 1 && alternatives[0] === word) {
      result.words.push(word);
      result.rawWords.push(raw);
      continue;
    }
    result.expanded = true;
    result.words.push(...alternatives);
    result.rawWords.push(...alternatives);
    if (result.words.length > MAX_EXPANDED_WORDS) return undefined;
  }
  return result;
}

/** The words brace expansion makes of one word, undefined when that cannot be known exactly. */
function braceAlternatives(word: string, raw: string): string[] | undefined {
  const plain = !/['"\\$`]/.test(raw);
  // Quoted and escaped characters never expand: test the word with them masked out.
  const skeleton = plain ? raw : maskQuoted(raw);
  const expanded = expandBraces(skeleton);
  if (expanded === undefined) return undefined;
  if (expanded.length === 1 && expanded[0] === skeleton) return [word];
  // Without quotes, escapes and expansions the word is exactly what was written.
  return plain ? expandBraces(word) : undefined;
}

/**
 * `raw` with quoted strings, escaped characters and `$...` expansions replaced by `_` (same
 * length), so only the characters bash interprets as brace syntax remain.
 */
function maskQuoted(raw: string): string {
  let result = '';
  for (let i = 0; i < raw.length;) {
    const char = raw[i];
    let end = i + 1;
    if (char === '\\') {
      end = i + 2;
    } else if (char === "'") {
      const close = raw.indexOf("'", i + 1);
      end = close < 0 ? raw.length : close + 1;
    } else if (char === '"' || char === '`') {
      end = closingQuote(raw, i, char);
    } else if (char === '$' && /[{(]/.test(raw[i + 1] ?? '')) {
      end = closingBracket(raw, i + 1);
    } else if (char === '$' && /['"]/.test(raw[i + 1] ?? '')) {
      end = closingQuote(raw, i + 1, raw[i + 1]);
    } else if (char !== '$') {
      result += char;
      i++;
      continue;
    }
    result += '_'.repeat(Math.min(end, raw.length) - i);
    i = Math.min(end, raw.length);
  }
  return result;
}

/** Index after the quote closing the one at `start` (backslashes escape inside). */
function closingQuote(raw: string, start: number, quote: string): number {
  for (let i = start + 1; i < raw.length; i++) {
    if (raw[i] === '\\') i++;
    else if (raw[i] === quote) return i + 1;
  }
  return raw.length;
}

/** Index after the bracket closing the `(` or `{` at `start`, counting nesting. */
function closingBracket(raw: string, start: number): number {
  const open = raw[start];
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '\\') i++;
    else if (raw[i] === open) depth++;
    else if (raw[i] === close && --depth === 0) return i + 1;
  }
  return raw.length;
}

function findBraceGroup(word: string): { start: number; end: number; items: string[] } | undefined {
  for (let start = word.indexOf('{'); start >= 0; start = word.indexOf('{', start + 1)) {
    if (word[start - 1] === '$') continue;
    let depth = 0;
    const commas: number[] = [];
    for (let end = start; end < word.length; end++) {
      const char = word[end];
      if (char === ',' && depth === 1) commas.push(end);
      if (char === '{') depth++;
      if (char !== '}') continue;
      depth--;
      if (depth > 0) continue;
      if (commas.length > 0) {
        const bounds = [start, ...commas, end];
        const items = bounds.slice(1).map((bound, i) => word.slice(bounds[i] + 1, bound));
        return { start, end, items };
      }
      const body = word.slice(start + 1, end);
      if (/^(-?\d+\.\.-?\d+|[A-Za-z]\.\.[A-Za-z])(\.\.-?\d+)?$/.test(body)) {
        return { start, end, items: ['*'] };
      }
      break;
    }
  }
  return undefined;
}

/** Representative secret file names that filename patterns are tested against. */
// prettier-ignore
const SENSITIVE_NAME_PROBES = [
  '.env', '.env.local', '.env.production', '.envrc', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'server.pem', 'key.pem', 'server.key', 'private.key', 'cert.p12', 'cert.pfx', 'release.keystore',
  ...SECRET_FILES, ...SECRET_DIRECTORIES,
];

/** Names that commonly live inside `.ssh`, `.aws` and `.gnupg`. */
// prettier-ignore
const SECRET_DIRECTORY_CONTENTS = [
  'id_rsa', 'id_ecdsa', 'id_ed25519', 'config', 'credentials', 'known_hosts', 'authorized_keys',
  'secring.gpg', 'pubring.kbx', 'trustdb.gpg', 'private-keys-v1.d', 'sso',
];

/**
 * Windows 8.3 short names of the probes (`.env` → `ENV~1`, `credentials.json` → `CREDEN~1.JSO`).
 * cmd and the Win32 file APIs also match wildcards against short names, so `type ENV*` reads
 * `.env`.
 */
function shortNames(names: readonly string[]): string[] {
  const result: string[] = [];
  for (const name of names) {
    const stripped = name.replace(/^\.+/, '');
    const dot = stripped.lastIndexOf('.');
    const clean = (text: string): string => text.replace(/[.\s+,;=[\]]/g, '').toUpperCase();
    const base = clean(dot < 0 ? stripped : stripped.slice(0, dot));
    const extension = dot < 0 ? '' : clean(stripped.slice(dot + 1)).slice(0, 3);
    const valid =
      stripped === name && base.length <= 8 && (dot < 0 || stripped.indexOf('.') === dot);
    if (valid && (dot < 0 || stripped.length - dot - 1 <= 3)) continue;
    for (let n = 1; n <= 4; n++) {
      result.push(`${base.slice(0, 6)}~${n}${extension === '' ? '' : `.${extension}`}`);
    }
  }
  return result;
}

const PROBES = {
  posix: { names: SENSITIVE_NAME_PROBES, directories: [...SECRET_DIRECTORIES] },
  win32: {
    names: [...SENSITIVE_NAME_PROBES, ...shortNames(SENSITIVE_NAME_PROBES)],
    directories: [...SECRET_DIRECTORIES, ...shortNames([...SECRET_DIRECTORIES])],
  },
};

export interface PatternOptions {
  /** Whether wildcards at the start of a name match a leading dot (PowerShell, ripgrep globs). */
  dot: boolean;
  platform: NodeJS.Platform;
  /** Ignore `**` directory segments (ripgrep globs: they do not re-include hidden directories). */
  skipGlobstar?: boolean;
  /** Whether `\x` escapes `x` (ripgrep globs on POSIX); otherwise `\` separates on Windows. */
  escapes?: boolean;
}

/**
 * True when a filename pattern could match a typical secret file name (`.en*`, `*.pem`, `id_*`,
 * `*`, and on Windows short names such as `ENV*`), or a file inside a directory that holds secrets
 * (`.ss?/config`, `.s*h/id_*`). Segments with wildcards are tested against representative names,
 * ignoring case. Pure computation in time linear in the pattern; very long patterns are assumed
 * to match.
 */
export function globMayMatchSensitive(pattern: string, options: PatternOptions): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return true;
  const separators = options.platform === 'win32' ? /[\\/]+/ : /\/+/;
  const segments = pattern.split(separators).filter(Boolean);
  const probes = options.platform === 'win32' ? PROBES.win32 : PROBES.posix;
  const matchOptions: SegmentMatchOptions = {
    dot: options.dot,
    nocase: true,
    escapes: options.escapes,
  };
  const matchesAny = (segment: string, names: readonly string[]): boolean => {
    const matches = segmentMatcher(segment, matchOptions);
    return names.some((name) => matches(name));
  };
  return segments.some((segment, i) => {
    if (!GLOB_CHARS.test(segment)) return false;
    if (i === segments.length - 1) return matchesAny(segment, probes.names);
    if (options.skipGlobstar && segment === '**') return false;
    if (!matchesAny(segment, probes.directories)) return false;
    // A directory that may be `.ssh`: secret when the rest may name a file kept there.
    const rest = segments.slice(i + 1);
    if (rest.length !== 1) return true;
    const [tail] = rest;
    if (GLOB_CHARS.test(tail))
      return matchesAny(tail, [...SECRET_DIRECTORY_CONTENTS, ...probes.names]);
    return SECRET_DIRECTORY_CONTENTS.includes(tail.toLowerCase()) || namesSecret(tail);
  });
}

/**
 * True when an argument names, or may expand to, a file that commonly holds secrets (see
 * looksSensitive). Existing paths are also checked after resolving symlinks and Windows short
 * names (`ENV~1`). With `expands` (see shellMayExpand), brace expansions and filename patterns
 * count too: a pattern does when it could match a typical secret name or matches an existing
 * secret file. On Windows, PowerShell lists (`a.txt,.env`) are checked item by item. Attached
 * short-option values (`-T.env`) count. When the analysis budget runs out, assumes the worst.
 */
export function mayNameSensitive(word: string, env: PathEnvironment, expands: boolean): boolean {
  if (looksSensitive(word)) return true;
  if (budgetExhausted(env)) return true;
  const values = [
    word.replace(INLINE_OPTION_NAME, '').replace(/^@/, ''),
    ...pathCandidates(word, env.platform),
  ];
  const items = env.platform === 'win32' ? values.flatMap(listItems) : values;
  return [...new Set(items)].some((item) => {
    const candidates = expands ? expandBraces(item) : [item];
    if (candidates === undefined) return true;
    return candidates.some((candidate) => {
      if (looksSensitive(candidate)) return true;
      if (!spend(env, 'patterns')) return true;
      if (expands && GLOB_CHARS.test(candidate)) return patternMayMatchSensitive(candidate, env);
      return resolvesToSensitive(candidate, env);
    });
  });
}

function listItems(value: string): string[] {
  return value.includes(',') ? [value, ...value.split(',').filter(Boolean)] : [value];
}

function patternMayMatchSensitive(pattern: string, env: PathEnvironment): boolean {
  const dot = env.platform === 'win32';
  if (globMayMatchSensitive(pattern, { dot, platform: env.platform })) return true;
  const expanded = expandHome(pattern, env.home);
  if (expanded === undefined || VARIABLE_PATTERN.test(expanded)) return false;
  return env.cwds.some((cwd) => {
    const matches = expandOnDisk(resolveArgument(expanded, cwd, env.platform), env);
    // A match may itself be a symlink to a secret file (`k*/config` where `keys -> ~/.ssh`), so
    // each match is also resolved before deciding.
    return (
      matches === undefined ||
      matches.some((match) => looksSensitive(match) || resolvesToSensitive(match, env))
    );
  });
}

/**
 * The files an absolute pattern matches on disk, or undefined when the analysis budget runs out.
 * Patterns that may not be checked on disk (see mayProbe) match nothing here.
 */
function expandOnDisk(pattern: string, env: PathEnvironment): string[] | undefined {
  if (!mayProbe(pattern, env)) return [];
  const api = pathApi(env.platform);
  const { root } = api.parse(pattern);
  const segments = pattern
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean);
  const matchOptions: SegmentMatchOptions = { dot: env.platform === 'win32', nocase: true };
  let current = [root];
  for (const segment of segments) {
    if (!GLOB_CHARS.test(segment)) {
      current = current.map((dir) => api.join(dir, segment));
      continue;
    }
    const matches = segmentMatcher(segment, matchOptions);
    const next: string[] = [];
    for (const dir of current) {
      if (!mayProbe(dir, env)) continue;
      if (!spend(env, 'fs')) return undefined;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      if (!spend(env, 'fs', entries.length)) return undefined;
      for (const entry of entries) {
        if (matches(entry)) next.push(api.join(dir, entry));
      }
    }
    current = next;
    if (current.length === 0) break;
  }
  return current;
}

/**
 * True when an existing path is really a secret file, reached through a symlink or short name.
 * Assumes the worst when the analysis budget runs out.
 */
function resolvesToSensitive(candidate: string, env: PathEnvironment): boolean {
  if (env.platform !== process.platform) return false;
  const expanded = expandHome(candidate, env.home);
  if (expanded === undefined || VARIABLE_PATTERN.test(expanded)) return false;
  return env.cwds.some((cwd) => {
    const absolute = resolveArgument(expanded, cwd, env.platform);
    if (!mayProbe(absolute, env)) return false;
    if (!spend(env, 'fs')) return true;
    const real = realPath(absolute);
    return real !== undefined && !samePath(real, absolute, env.platform) && looksSensitive(real);
  });
}

function realPath(absolute: string): string | undefined {
  try {
    return realpathSync.native(absolute);
  } catch {
    return undefined;
  }
}

// -----------------------------------------------------------------------------------------------
// The .git directory

/**
 * True when an argument resolves inside a `.git` directory (the project's or another one)
 * against any directory in `env.cwds`, so a preceding `cd .git` counts. Segments compare
 * case-insensitively on Windows and macOS, like PathPolicy; on Windows the trailing dots and
 * spaces and NTFS stream suffixes the file system ignores (`.git.`, `.git::$INDEX_ALLOCATION`)
 * do not hide the name. Filename patterns that could match `.git` (`.gi?`), brace expansions
 * (with `expands`), and symlinks and Windows short names (`GIT~1`) of existing paths count too.
 * `--opt=value`, `-Param:value`, `name=value` (`dd of=`), `@file` and attached short-option
 * values (`-o.git/hooks/x`) are unwrapped. When the analysis budget has run out, returns false:
 * the analysis as a whole then asks with a "too many parts to check" reason and cannot be
 * remembered, which is conservative without claiming a `.git` write that was never established.
 */
export function touchesGitDir(word: string, env: PathEnvironment, expands: boolean): boolean {
  const assigned = /^[\w.-]+=(.+)$/s.exec(word)?.[1];
  const values = [
    ...pathCandidates(word, env.platform),
    ...(assigned === undefined ? [] : [assigned]),
  ];
  const items = env.platform === 'win32' ? values.flatMap(listItems) : values;
  if (items.length > 0 && budgetExhausted(env)) return false;
  return [...new Set(items)].some((item) => {
    const candidates = expands ? expandBraces(item) : [item];
    if (candidates === undefined) return true;
    return candidates.some((candidate) => {
      const expanded = expandHome(candidate, env.home);
      if (expanded === undefined || VARIABLE_PATTERN.test(expanded)) return false;
      // Out of budget: the whole analysis asks and is not remembered (see the doc comment).
      if (!spend(env, 'patterns')) return false;
      return env.cwds.some((cwd) => {
        const absolute = resolveArgument(expanded, cwd, env.platform);
        if (insideGitDir(absolute, env)) return true;
        const canonical = canonicalForm(absolute, env);
        return canonical === UNKNOWN || (canonical !== undefined && insideGitDir(canonical, env));
      });
    });
  });
}

function insideGitDir(absolute: string, env: PathEnvironment): boolean {
  const { platform } = env;
  const api = pathApi(platform);
  const root = api.resolve(env.projectRoot);
  const rest = isWithin(absolute, root, platform)
    ? absolute.slice(root.length)
    : absolute.slice(api.parse(absolute).root.length);
  return rest.split(/[\\/]+/).some((segment) => isGitSegment(segment, platform));
}

function isGitSegment(segment: string, platform: NodeJS.Platform): boolean {
  const name = platform === 'win32' ? segment.replace(/:.*$/s, '').replace(/[. ]+$/, '') : segment;
  const caseInsensitive = isCaseInsensitivePlatform(platform);
  if ((caseInsensitive ? name.toLowerCase() : name) === '.git') return true;
  if (!GLOB_CHARS.test(name)) return false;
  const matches = segmentMatcher(name, { dot: platform === 'win32', nocase: caseInsensitive });
  return matches('.git') || (platform === 'win32' && matches('GIT~1'));
}

const UNKNOWN = Symbol('unknown');

/** A path longer than this, or deeper than MAX_CANONICAL_SEGMENTS, is not walked (assume UNKNOWN). */
const MAX_CANONICAL_LENGTH = 4096;
const MAX_CANONICAL_SEGMENTS = 256;

/** Budget units for one filesystem call on `path`, so work on long paths is charged in proportion. */
function fsUnits(path: string): number {
  return Math.max(1, Math.ceil(path.length / 256));
}

/**
 * The symlink-free, long-name form of a path whose leading part exists, undefined when it does
 * not differ from the path or may not be checked on disk (see mayProbe), or UNKNOWN when the
 * analysis budget runs out or the path is too long or deep to walk. Each filesystem call is
 * charged in proportion to the path length, and an absurdly long or deep path is refused before
 * any probing, so a pathological argument (thousands of directories deep) stays fast.
 */
function canonicalForm(
  absolute: string,
  env: PathEnvironment,
): string | undefined | typeof UNKNOWN {
  if (!mayProbe(absolute, env)) return undefined;
  if (absolute.length > MAX_CANONICAL_LENGTH) return UNKNOWN;
  const api = pathApi(env.platform);
  let existing = absolute;
  const tail: string[] = [];
  for (;;) {
    if (!spend(env, 'fs', fsUnits(existing))) return UNKNOWN;
    if (existsSync(existing)) break;
    const parent = api.dirname(existing);
    if (parent === existing || !mayProbe(parent, env)) return undefined;
    tail.unshift(api.basename(existing));
    if (tail.length > MAX_CANONICAL_SEGMENTS) return UNKNOWN;
    existing = parent;
  }
  if (!spend(env, 'fs', fsUnits(existing))) return UNKNOWN;
  const real = realPath(existing);
  if (real === undefined) return undefined;
  const canonical = api.join(real, ...tail);
  return samePath(canonical, absolute, env.platform) ? undefined : canonical;
}

// -----------------------------------------------------------------------------------------------
// Ignore-file whitelists

/** Ignore files whose negation (`!`) lines re-include hidden or ignored files such as `.env`. */
const IGNORE_FILE_NAMES = ['.ignore', '.rgignore', '.gitignore'];
const MAX_IGNORE_BYTES = 1 << 16;
/** Directories a recursive search's ignore-file check may read before assuming the worst. */
const MAX_IGNORE_DIRS = 64;

/** True when an ignore file has a negation (`!`) rule that could re-include a secret file. */
function ignoreFileNegates(file: string, env: PathEnvironment): boolean | undefined {
  if (!spend(env, 'fs')) return undefined;
  let text: string;
  try {
    text = readFileSync(file, { encoding: 'utf8' }).slice(0, MAX_IGNORE_BYTES);
  } catch {
    return false;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('!')) continue;
    const pattern = line.slice(1).trim();
    // Only a negation that could re-include a hidden or secret file (`!.env`, `!*`) matters; a
    // negation of an ordinary tracked file (`!src/keep.js`) cannot expose a secret.
    if (
      pattern !== '' &&
      (looksSensitive(pattern) ||
        globMayMatchSensitive(pattern, {
          dot: true,
          platform: env.platform,
        }))
    ) {
      return true;
    }
  }
  return false;
}

/** True when `dir` holds an ignore file with a negation rule. */
function dirHasNegatedIgnore(dir: string, env: PathEnvironment): boolean | undefined {
  if (!mayProbe(dir, env)) return undefined;
  const api = pathApi(env.platform);
  const files = [
    ...IGNORE_FILE_NAMES.map((name) => api.join(dir, name)),
    api.join(dir, '.git', 'info', 'exclude'),
  ];
  for (const file of files) {
    if (!spend(env, 'fs')) return undefined;
    let exists: boolean;
    try {
      exists = existsSync(file);
    } catch {
      return undefined;
    }
    if (!exists) continue;
    const negates = ignoreFileNegates(file, env);
    if (negates !== false) return negates === true ? true : undefined;
  }
  return false;
}

/** File-system operations and time the ignore-file walk of one search may use. */
const NEGATION_WALK_FS_BUDGET = 400;
const NEGATION_WALK_TIME_MS = 4;

/**
 * Whether a recursive search over `roots` (empty means the current directory) could read a file
 * re-included by an ignore-file negation (`.ignore`/`.rgignore`/`.gitignore` with a `!` line),
 * which overrides the hidden-file and ignore rules a search relies on. Checks each directory root,
 * its ancestors (ripgrep reads parent ignore files) and a bounded descent into the tree. `false`
 * only when every reachable ignore file was read and none negates; `true` on a negation; and,
 * conservatively, `undefined` (treated by callers as a possible secret) when the walk's own budget
 * runs out (large trees), a read fails, or a root is unknown. File roots are not walked.
 *
 * The walk has its own small budget: a large tree makes this one search ask (as a possible
 * secret read) without exhausting the budget of the rest of the analysis, whose exhaustion would
 * otherwise turn unrelated checks conservative.
 */
export function searchHasNegatedIgnore(
  env: PathEnvironment,
  roots: readonly string[],
): boolean | undefined {
  if (budgetExhausted(env)) return undefined;
  const outer = env.budget;
  env.budget = {
    fs: NEGATION_WALK_FS_BUDGET,
    patterns: PATTERN_BUDGET,
    deadline: performance.now() + NEGATION_WALK_TIME_MS,
    work: 0,
    exhausted: false,
  };
  try {
    return walkForNegatedIgnore(env, roots);
  } finally {
    env.budget = outer;
  }
}

function walkForNegatedIgnore(env: PathEnvironment, roots: readonly string[]): boolean | undefined {
  // A cross-platform analysis (tests) sees an empty file system: no ignore files, so no negation.
  if (env.platform !== process.platform) return false;
  const api = pathApi(env.platform);
  const cwd = env.cwds[env.cwds.length - 1];
  const dirRoots: string[] = [];
  for (const root of roots.length > 0 ? roots : ['.']) {
    const expanded = expandHome(root, env.home);
    if (expanded === undefined || VARIABLE_PATTERN.test(expanded)) return undefined;
    if (GLOB_CHARS.test(expanded)) return undefined;
    const absolute = resolveArgument(expanded, cwd, env.platform);
    if (!mayProbe(absolute, env) || !spend(env, 'fs')) return undefined;
    try {
      if (statSync(absolute).isDirectory()) dirRoots.push(absolute);
    } catch {
      // A non-existent or unreadable root: a search would walk nothing or fail, so skip it.
    }
  }
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const root of dirRoots) {
    // Ancestors first: ripgrep reads ignore files in parent directories.
    let dir = root;
    for (let depth = 0; depth <= MAX_WORKING_DIRECTORIES; depth++) {
      if (!visited.has(dir)) {
        const negated = dirHasNegatedIgnore(dir, env);
        if (negated !== false) return negated === true ? true : undefined;
        visited.add(dir);
      }
      const parent = api.dirname(dir);
      if (parent === dir || !mayProbe(parent, env)) break;
      dir = parent;
    }
    queue.push(root);
  }
  // Bounded descent into the searched tree for nested ignore files.
  while (queue.length > 0) {
    if (visited.size > MAX_IGNORE_DIRS || !spend(env, 'fs')) return undefined;
    const dir = queue.shift() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    if (!spend(env, 'fs', entries.length)) return undefined;
    for (const entry of entries) {
      const child = api.join(dir, entry);
      if (visited.has(child) || !mayProbe(child, env)) continue;
      try {
        if (!statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      const negated = dirHasNegatedIgnore(child, env);
      if (negated !== false) return negated === true ? true : undefined;
      visited.add(child);
      queue.push(child);
    }
  }
  return false;
}

/** The symlink-free form of projectRoot, computed once per analysis. */
function canonicalProjectRoot(env: PathEnvironment): string {
  if (env.canonicalRoot === undefined) {
    const root = pathApi(env.platform).resolve(env.projectRoot);
    env.canonicalRoot = (env.platform === process.platform ? realPath(root) : undefined) ?? root;
  }
  return env.canonicalRoot;
}

/**
 * True when `absolute`, though lexically inside the project, actually resolves (through a symlink
 * or junction) outside it — the same thing the file tools do before deciding insideProject.
 * UNKNOWN (budget exhausted or path too deep) counts as outside, assuming the worst.
 */
export function resolvesOutsideProject(absolute: string, env: PathEnvironment): boolean {
  const canonical = canonicalForm(absolute, env);
  if (canonical === undefined) return false;
  if (canonical === UNKNOWN) return true;
  return !isWithin(canonical, canonicalProjectRoot(env), env.platform);
}
