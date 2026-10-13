import { execFile } from 'node:child_process';
import { constants, type Dirent } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import ignore, { type Ignore } from 'ignore';
import { throwIfAborted } from '@patch/shared';

const execFileAsync = promisify(execFile);

/** Directories never descended into by the fallback walker (rg uses .gitignore instead). */
export const DEFAULT_IGNORED_DIRS = [
  '.git',
  'node_modules',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'target',
  '.gradle',
  '.idea',
];

export interface WalkOptions {
  root: string;
  signal?: AbortSignal;
  /** Respect .gitignore files (root and nested). Default true. */
  respectGitignore?: boolean;
  /** Include hidden files (dotfiles). Default true (but .git is always skipped). */
  includeHidden?: boolean;
  /** Stop after this many files. */
  maxFiles?: number;
}

export interface WalkEntry {
  absolute: string;
  /** Relative to `root`, forward slashes. */
  relative: string;
  isDirectory: boolean;
}

function isCaseInsensitive(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** True when `name` is one of DEFAULT_IGNORED_DIRS (case-insensitive on win32/darwin). */
export function isDefaultIgnoredDir(
  name: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!isCaseInsensitive(platform)) return DEFAULT_IGNORED_DIRS.includes(name);
  const lower = name.toLowerCase();
  return DEFAULT_IGNORED_DIRS.some((dir) => dir === lower);
}

/** Rules of one ignore file and how to express walk-relative paths relative to its directory. */
interface RuleSet {
  rules: Ignore;
  /** Prepended to the path (ignore files in ancestors of the walk root). */
  prefix: string;
  /** Characters removed from the front of the path (ignore files in subdirectories). */
  strip: number;
}

function parentOf(relative: string): string {
  const slash = relative.lastIndexOf('/');
  return slash === -1 ? '' : relative.slice(0, slash);
}

async function loadRules(file: string, platform: NodeJS.Platform): Promise<Ignore | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  return ignore({ ignorecase: isCaseInsensitive(platform) }).add(text);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function testRules(rules: Ignore, candidate: string): { ignored: boolean; unignored: boolean } {
  try {
    return rules.test(candidate);
  } catch {
    // Paths the ignore library cannot represent (e.g. names with trailing spaces) are kept.
    return { ignored: false, unignored: false };
  }
}

/**
 * Evaluates .gitignore rules for paths below a root directory: `.gitignore` files in the root and
 * its subdirectories, plus those of ancestor directories up to the enclosing repository (and its
 * `.git/info/exclude`). Deeper files take precedence, as in Git. Paths are relative to the root
 * with forward slashes.
 */
export class GitignoreFilter {
  private readonly chains = new Map<string, Promise<RuleSet[]>>();
  private readonly directoryVerdicts = new Map<string, Promise<boolean>>();

  private constructor(
    private readonly root: string,
    private readonly inherited: RuleSet[],
    private readonly platform: NodeJS.Platform,
  ) {}

  static async create(
    root: string,
    platform: NodeJS.Platform = process.platform,
  ): Promise<GitignoreFilter> {
    return new GitignoreFilter(root, await inheritedRuleSets(root, platform), platform);
  }

  /** Whether `relative` is ignored, assuming its parent directory is not (walkers check that). */
  async ignoresEntry(relative: string, isDirectory: boolean): Promise<boolean> {
    const chain = await this.chainFor(parentOf(relative));
    let ignored = false;
    for (const set of chain) {
      const candidate = `${set.prefix}${relative.slice(set.strip)}${isDirectory ? '/' : ''}`;
      const result = testRules(set.rules, candidate);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return ignored;
  }

  /** Whether `relative` or any directory between the root and it is ignored. */
  async ignores(relative: string, isDirectory: boolean): Promise<boolean> {
    const parent = parentOf(relative);
    if (parent !== '' && (await this.directoryIgnored(parent))) return true;
    return this.ignoresEntry(relative, isDirectory);
  }

  private directoryIgnored(relative: string): Promise<boolean> {
    let verdict = this.directoryVerdicts.get(relative);
    if (!verdict) {
      verdict = this.ignores(relative, true);
      this.directoryVerdicts.set(relative, verdict);
    }
    return verdict;
  }

  private chainFor(directory: string): Promise<RuleSet[]> {
    let chain = this.chains.get(directory);
    if (!chain) {
      chain = this.buildChain(directory);
      this.chains.set(directory, chain);
    }
    return chain;
  }

  private async buildChain(directory: string): Promise<RuleSet[]> {
    const base = directory === '' ? this.inherited : await this.chainFor(parentOf(directory));
    const rules = await loadRules(path.join(this.root, directory, '.gitignore'), this.platform);
    if (!rules) return base;
    return [...base, { rules, prefix: '', strip: directory === '' ? 0 : directory.length + 1 }];
  }
}

/**
 * Rules that apply to `root` from outside it: the repository's `.git/info/exclude` and the
 * `.gitignore` files of ancestors up to the directory that contains `.git` (lowest precedence
 * first). Outside a repository nothing is inherited. A rule set that ignores the root itself is
 * dropped, because a root that was asked for explicitly is always searched.
 */
async function inheritedRuleSets(root: string, platform: NodeJS.Platform): Promise<RuleSet[]> {
  const ancestors: string[] = [];
  let repositoryRoot: string | undefined;
  for (let dir = root; ;) {
    if (await exists(path.join(dir, '.git'))) {
      repositoryRoot = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    ancestors.push(parent);
    dir = parent;
  }
  if (repositoryRoot === undefined) return [];

  const sources = [
    { dir: repositoryRoot, file: path.join(repositoryRoot, '.git', 'info', 'exclude') },
    ...ancestors.reverse().map((dir) => ({ dir, file: path.join(dir, '.gitignore') })),
  ];
  const sets: RuleSet[] = [];
  for (const { dir, file } of sources) {
    const rules = await loadRules(file, platform);
    if (!rules) continue;
    const relative = path.relative(dir, root).split(path.sep).join('/');
    const prefix = relative === '' ? '' : `${relative}/`;
    if (prefix !== '' && testRules(rules, prefix).ignored) continue;
    sets.push({ rules, prefix, strip: 0 });
  }
  return sets;
}

function compareNames(a: Dirent, b: Dirent): number {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

interface PendingEntry {
  absolute: string;
  relative: string;
  isDirectory: boolean;
}

/**
 * Pure-JS recursive file walker (fallback when ripgrep is unavailable). Yields files only.
 * Traversal is depth-first in name order (the order `rg --sort path` uses). Symbolic links are
 * not followed, unreadable directories are skipped, and DEFAULT_IGNORED_DIRS are never entered.
 * When `root` is a file, that file is the only entry.
 */
export async function* walkFiles(options: WalkOptions): AsyncGenerator<WalkEntry> {
  const root = path.resolve(options.root);
  const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
  const includeHidden = options.includeHidden ?? true;
  if (maxFiles <= 0) return;
  throwIfAborted(options.signal);
  const rootStats = await stat(root).catch(() => undefined);
  if (rootStats?.isFile()) {
    yield { absolute: root, relative: path.basename(root), isDirectory: false };
    return;
  }
  if (!rootStats?.isDirectory()) return;

  const gitignore =
    (options.respectGitignore ?? true) ? await GitignoreFilter.create(root) : undefined;

  const children = async (directory: PendingEntry): Promise<PendingEntry[]> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory.absolute, { withFileTypes: true });
    } catch {
      return [];
    }
    const result: PendingEntry[] = [];
    for (const entry of entries.sort(compareNames)) {
      const isDirectory = entry.isDirectory();
      if (!isDirectory && !entry.isFile()) continue;
      if (!includeHidden && entry.name.startsWith('.')) continue;
      if (isDirectory && isDefaultIgnoredDir(entry.name)) continue;
      const relative =
        directory.relative === '' ? entry.name : `${directory.relative}/${entry.name}`;
      if (gitignore && (await gitignore.ignoresEntry(relative, isDirectory))) continue;
      result.push({ absolute: path.join(directory.absolute, entry.name), relative, isDirectory });
    }
    return result;
  };

  const stack = (await children({ absolute: root, relative: '', isDirectory: true })).reverse();
  let yielded = 0;
  while (stack.length > 0) {
    throwIfAborted(options.signal);
    const entry = stack.pop() as PendingEntry;
    if (entry.isDirectory) {
      const nested = await children(entry);
      for (let index = nested.length - 1; index >= 0; index--) stack.push(nested[index]);
      continue;
    }
    yield entry;
    if (++yielded >= maxFiles) return;
  }
}

const RIPGREP_VERSION_TIMEOUT_MS = 5_000;

let ripgrepLookup: { key: string; result: Promise<string | null> } | undefined;

function ripgrepDisabled(): boolean {
  const value = process.env.PATCH_NO_RG?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

async function isRipgrep(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    if (process.platform !== 'win32') await access(file, constants.X_OK);
    const { stdout } = await execFileAsync(file, ['--version'], {
      timeout: RIPGREP_VERSION_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout.startsWith('ripgrep');
  } catch {
    return false;
  }
}

function pathCandidates(): string[] {
  // Only real executables: .cmd/.bat shims cannot be spawned without a shell.
  const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir !== '' && path.isAbsolute(dir))
    .map((dir) => path.join(dir, name));
}

async function locateRipgrep(): Promise<string | null> {
  const override = process.env.PATCH_RG_PATH?.trim();
  if (override && path.isAbsolute(override) && (await isRipgrep(override))) return override;
  for (const candidate of pathCandidates()) {
    if (await isRipgrep(candidate)) return candidate;
  }
  return null;
}

/**
 * Absolute path of `rg` if available on PATH (cached), else null. `PATCH_NO_RG=1` disables it
 * (checked on every call). `PATCH_RG_PATH` may name a ripgrep binary outside PATH. Candidates are
 * verified with `rg --version`; the result is cached per PATH / PATCH_RG_PATH value.
 */
export async function findRipgrep(): Promise<string | null> {
  if (ripgrepDisabled()) return null;
  const key = `${process.env.PATCH_RG_PATH ?? ''}\0${process.env.PATH ?? ''}`;
  if (ripgrepLookup?.key !== key) ripgrepLookup = { key, result: locateRipgrep() };
  return ripgrepLookup.result;
}
