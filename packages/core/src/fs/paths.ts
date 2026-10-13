import { realpath as realpathCallback, realpathSync, type Stats } from 'node:fs';
import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ToolError } from '../tools/types.js';
import { errorCode, isMissingError } from './fs-errors.js';

export interface ResolvedPath {
  /** Path exactly as provided by the model or user. */
  input: string;
  /**
   * Absolute, normalized path with symlinks resolved for the longest existing prefix
   * (so a symlink inside the project pointing outside is reported as outside).
   */
  absolute: string;
  /** Display form: relative to cwd when inside the project, otherwise absolute with `~`. */
  display: string;
  insideProject: boolean;
  exists: boolean;
  isDirectory: boolean;
  /** Set when the path looks like a secret (e.g. ".env", "id_rsa", "*.pem"); the value is a reason. */
  sensitive?: string;
  /** True when the path is inside the repository's `.git` directory. */
  insideGitDir: boolean;
}

export interface PathPolicyOptions {
  cwd: string;
  projectRoot: string;
  home: string;
  platform?: NodeJS.Platform;
}

type PathApi = path.PlatformPath;

/** Bound on symlink hops followed while resolving dangling links (matches common OS limits). */
const MAX_SYMLINK_HOPS = 40;

/** `/c/Users/me` (Git Bash / MSYS) and `/cygdrive/c/Users/me` (Cygwin) on Windows. */
const MSYS_DRIVE_PATH = /^\/(?:cygdrive\/)?([a-zA-Z])(?=\/|$)/;

const jsRealpath = promisify(realpathCallback);

function pathApiFor(platform: NodeJS.Platform): PathApi {
  return platform === 'win32' ? path.win32 : path.posix;
}

function isCaseInsensitive(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

function splitSegments(p: string, platform: NodeJS.Platform): string[] {
  return p.split(platform === 'win32' ? /[\\/]+/ : /\/+/).filter((segment) => segment !== '');
}

/** Removes trailing separators except the one that is part of a root ("/" or "C:\"). */
function trimTrailingSeparators(p: string, api: PathApi): string {
  const rootLength = api.parse(p).root.length;
  let end = p.length;
  while (end > rootLength && (p[end - 1] === '/' || p[end - 1] === api.sep)) end--;
  return p.slice(0, end);
}

/** Canonical (symlink-free) form of an existing path; falls back to the JS implementation on
 * volumes where the native call is unsupported (some Windows RAM disks and network shares). */
async function canonicalPath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch (error) {
    const code = errorCode(error);
    if (isMissingError(error) || code === 'ELOOP' || code === 'EACCES') throw error;
    return jsRealpath(p);
  }
}

function canonicalPathSync(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    try {
      return realpathSync(p);
    } catch {
      return undefined;
    }
  }
}

async function symlinkTarget(p: string): Promise<string | undefined> {
  try {
    const stats = await lstat(p);
    return stats.isSymbolicLink() ? await readlink(p) : undefined;
  } catch {
    return undefined;
  }
}

async function statOrUndefined(p: string): Promise<Stats | undefined> {
  try {
    return await stat(p);
  } catch {
    return undefined;
  }
}

/**
 * Resolves symlinks in the longest existing prefix of `target`, following dangling symlinks as
 * well, so that a path which does not exist yet still reports where a write would land.
 */
async function resolveSymlinks(target: string, api: PathApi, hops = 0): Promise<string> {
  try {
    return await canonicalPath(target);
  } catch (error) {
    if (!isMissingError(error)) return target;
  }
  const link = await symlinkTarget(target);
  if (link !== undefined && hops < MAX_SYMLINK_HOPS) {
    return resolveSymlinks(api.resolve(api.dirname(target), link), api, hops + 1);
  }
  const parent = api.dirname(target);
  if (parent === target) return target;
  return api.join(await resolveSymlinks(parent, api, hops), api.basename(target));
}

function validatePathInput(input: string): void {
  if (input.trim() === '') throw new ToolError('Path must not be empty.');
  if (input.includes('\0')) {
    throw new ToolError(`Path contains a NUL byte: ${JSON.stringify(input)}.`);
  }
}

/** The as-given and canonical (symlink-resolved) forms of an anchor directory. */
interface Anchor {
  lexical: string;
  canonical: string;
}

/**
 * Resolves model-supplied paths and decides containment. Handles `~`, relative paths
 * (against cwd), `..` traversal, symlinks, Windows drive letters and case-insensitive
 * comparison on win32/darwin. Does not grant or deny anything itself.
 */
export class PathPolicy {
  readonly cwd: string;
  readonly projectRoot: string;
  readonly home: string;
  private readonly platform: NodeJS.Platform;
  private readonly api: PathApi;
  /** Symlinks can only be resolved when the policy describes the host platform. */
  private readonly usesFilesystem: boolean;
  private readonly cwdAnchor: Anchor;
  private readonly projectAnchor: Anchor;
  private readonly homeAnchor: Anchor;

  constructor(options: PathPolicyOptions) {
    this.cwd = options.cwd;
    this.projectRoot = options.projectRoot;
    this.home = options.home;
    this.platform = options.platform ?? process.platform;
    this.api = pathApiFor(this.platform);
    this.usesFilesystem = this.platform === process.platform;
    this.cwdAnchor = this.anchor(options.cwd);
    this.projectAnchor = this.anchor(options.projectRoot);
    this.homeAnchor = this.anchor(options.home);
  }

  /**
   * Throws ToolError for empty paths or paths containing NUL bytes, and on Windows for network
   * (UNC) and device paths outside the project: merely resolving those would contact the server
   * and send the user's credentials before any permission prompt.
   */
  async resolve(input: string): Promise<ResolvedPath> {
    validatePathInput(input);
    const lexical = this.resolveLexically(input);
    if (this.platform === 'win32' && lexical.startsWith('\\\\') && !this.isInsideProject(lexical)) {
      throw new ToolError(
        `${input} is a network or device path outside the project; Patch only works with local paths there.`,
      );
    }
    const absolute = this.usesFilesystem ? await resolveSymlinks(lexical, this.api) : lexical;
    const stats = this.usesFilesystem ? await statOrUndefined(absolute) : undefined;
    const sensitive = sensitivePathReason(absolute) ?? sensitivePathReason(lexical);
    return {
      input,
      absolute,
      display: this.display(absolute),
      insideProject: this.isInsideProject(absolute),
      exists: stats !== undefined,
      isDirectory: stats?.isDirectory() ?? false,
      ...(sensitive === undefined ? {} : { sensitive }),
      insideGitDir: this.isInsideGitDir(absolute),
    };
  }

  /**
   * Absolute, normalized form of `input` without touching the file system: expands `~`, converts
   * Git Bash style drive paths (`/c/Users/...`) on Windows and resolves against cwd.
   */
  resolveLexically(input: string): string {
    let expanded = input;
    const separator = this.platform === 'win32' ? /^~[\\/]/ : /^~\//;
    if (input === '~') expanded = this.home;
    else if (separator.test(input)) expanded = this.api.join(this.home, input.slice(2));
    else if (this.platform === 'win32') {
      expanded = input.replace(
        MSYS_DRIVE_PATH,
        (_match, drive: string) => `${drive.toUpperCase()}:\\`,
      );
    }
    return this.api.resolve(this.cwd, expanded);
  }

  /** True when `absolutePath` is the project root or inside it. */
  isInsideProject(absolutePath: string): boolean {
    return this.anchorForms(this.projectAnchor).some((root) =>
      isPathInside(absolutePath, root, this.platform),
    );
  }

  /** Display form of an absolute path (see ResolvedPath.display). */
  display(absolutePath: string): string {
    const absolute = this.api.resolve(absolutePath);
    const bases: [cwd: string, root: string][] = [
      [this.cwdAnchor.canonical, this.projectAnchor.canonical],
      [this.cwdAnchor.lexical, this.projectAnchor.lexical],
    ];
    for (const [cwd, root] of bases) {
      if (isPathInside(absolute, root, this.platform)) return this.relativeDisplay(cwd, absolute);
    }
    for (const home of this.anchorForms(this.homeAnchor)) {
      if (this.api.parse(home).root === home) continue;
      if (!isPathInside(absolute, home, this.platform)) continue;
      const rest = absolute.slice(home.length).replace(/^[\\/]+/, '');
      return rest === '' ? '~' : `~${this.api.sep}${rest}`;
    }
    return absolute;
  }

  private isInsideGitDir(absolutePath: string): boolean {
    for (const root of this.anchorForms(this.projectAnchor)) {
      if (!isPathInside(absolutePath, root, this.platform)) continue;
      const rest = splitSegments(absolutePath.slice(root.length), this.platform);
      return rest.some((segment) => this.sameSegment(segment, '.git'));
    }
    return false;
  }

  private anchor(dir: string): Anchor {
    const lexical = trimTrailingSeparators(this.api.resolve(dir), this.api);
    const canonical = this.usesFilesystem ? canonicalPathSync(lexical) : undefined;
    return { lexical, canonical: canonical ?? lexical };
  }

  private anchorForms(anchor: Anchor): string[] {
    return anchor.canonical === anchor.lexical
      ? [anchor.lexical]
      : [anchor.canonical, anchor.lexical];
  }

  private sameSegment(a: string, b: string): boolean {
    return isCaseInsensitive(this.platform) ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  /** Relative path from `from` to `to` with forward slashes ("." when equal). */
  private relativeDisplay(from: string, to: string): string {
    const fromSegments = splitSegments(from, this.platform);
    const toSegments = splitSegments(to, this.platform);
    let common = 0;
    while (
      common < fromSegments.length &&
      common < toSegments.length &&
      this.sameSegment(fromSegments[common], toSegments[common])
    ) {
      common++;
    }
    const parts = [...fromSegments.slice(common).map(() => '..'), ...toSegments.slice(common)];
    return parts.length === 0 ? '.' : parts.join('/');
  }
}

const SENSITIVE_DIRECTORIES: Record<string, string> = {
  '.ssh': 'inside a .ssh directory (SSH keys and configuration)',
  '.aws': 'inside a .aws directory (cloud credentials)',
  '.gnupg': 'inside a .gnupg directory (GPG keys)',
};

const ENV_TEMPLATE_SUFFIXES = new Set(['example', 'sample', 'template', 'defaults']);
const KEY_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.keystore']);
const SSH_KEY_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];
const CREDENTIAL_FILES = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  'credentials',
  'credentials.json',
]);

function isEnvFile(name: string): boolean {
  if (name === '.env' || name === '.envrc') return true;
  if (!name.startsWith('.env.')) return false;
  const suffix = name.slice(name.lastIndexOf('.') + 1);
  return !ENV_TEMPLATE_SUFFIXES.has(suffix);
}

/**
 * Returns a human reason when the path looks like it holds secrets, else undefined.
 * Matches by basename: .env and .env.* (except .env.example/.sample/.template/.defaults),
 * *.pem, *.key, *.p12, *.pfx, *.keystore, id_rsa*, id_dsa*, id_ecdsa*, id_ed25519* (not *.pub),
 * .netrc, .npmrc, .pypirc, .git-credentials, credentials, credentials.json,
 * and anything under a `.ssh` or `.aws` or `.gnupg` directory.
 * (`.envrc`, direnv's environment file, is treated like `.env`.) Matching ignores case.
 */
export function sensitivePathReason(absolutePath: string): string | undefined {
  const segments = absolutePath
    .split(/[\\/]+/)
    .filter((segment) => segment !== '')
    .map((segment) => segment.toLowerCase());
  for (const segment of segments) {
    const reason = SENSITIVE_DIRECTORIES[segment];
    if (reason) return reason;
  }
  const name = segments.at(-1) ?? '';
  if (isEnvFile(name)) return 'environment file that may contain secrets';
  if (KEY_EXTENSIONS.has(path.posix.extname(name))) return 'private key or certificate file';
  if (SSH_KEY_PREFIXES.some((prefix) => name.startsWith(prefix)) && !name.endsWith('.pub')) {
    return 'SSH private key';
  }
  if (CREDENTIAL_FILES.has(name)) return 'credentials file';
  return undefined;
}

/** True if `child` equals `parent` or is inside it (both absolute, normalized). */
export function isPathInside(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const api = pathApiFor(platform);
  let normalizedChild = trimTrailingSeparators(api.normalize(child), api);
  let normalizedParent = trimTrailingSeparators(api.normalize(parent), api);
  if (isCaseInsensitive(platform)) {
    normalizedChild = normalizedChild.toLowerCase();
    normalizedParent = normalizedParent.toLowerCase();
  }
  if (normalizedChild === normalizedParent) return true;
  const prefix = normalizedParent.endsWith(api.sep) ? normalizedParent : normalizedParent + api.sep;
  return normalizedChild.startsWith(prefix);
}
