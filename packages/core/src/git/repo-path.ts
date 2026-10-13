import path from 'node:path';

/** Platforms whose default file systems compare paths case-insensitively. */
export function isCaseInsensitivePlatform(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

function pathModule(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

const MSYS_DRIVE_PATH = /^\/(?:cygdrive\/)?([a-zA-Z])(?:\/(.*))?$/;

/**
 * Converts a directory printed by git into a native absolute path. Git for Windows prints
 * "C:/repo"; MSYS2 and Cygwin builds print "/c/repo" and "/cygdrive/c/repo".
 */
export function nativePathFromGit(
  output: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const printed = output.replace(/\r?\n$/, '');
  if (platform !== 'win32') return path.posix.normalize(printed);
  const msys = MSYS_DRIVE_PATH.exec(printed);
  const windowsForm = msys ? `${msys[1].toUpperCase()}:/${msys[2] ?? ''}` : printed;
  return path.win32.normalize(windowsForm);
}

/**
 * Returns `child` relative to `parent` (native separators, '' when equal), or undefined when
 * `child` is outside `parent`. Both must be absolute. Case-insensitive on win32/darwin.
 */
export function relativeInside(
  parent: string,
  child: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const p = pathModule(platform);
  const fold = (value: string) =>
    isCaseInsensitivePlatform(platform) ? value.toLowerCase() : value;
  const base = p.resolve(parent);
  const target = p.resolve(child);
  if (fold(target) === fold(base)) return '';
  const prefix = base.endsWith(p.sep) ? base : base + p.sep;
  if (!fold(target).startsWith(fold(prefix))) return undefined;
  return target.slice(prefix.length);
}

/** Native relative path → forward-slash form used by git. */
export function toPosixPath(
  relative: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? relative.replace(/\\/g, '/') : relative;
}

/**
 * Converts a path (absolute, or relative to the repository root) into a root-relative,
 * forward-slash path. Throws when it points outside the repository.
 */
export function repoRelativePath(
  root: string,
  input: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const p = pathModule(platform);
  const relative = relativeInside(root, p.resolve(root, input), platform);
  if (relative === undefined) {
    throw new Error(`Path is outside the Git repository at ${root}: ${input}`);
  }
  return toPosixPath(relative, platform);
}

/**
 * A pathspec that matches `relative` (root-relative, forward slashes) literally, so names such
 * as "[id].tsx" are not treated as globs. Case-insensitive on win32/darwin, matching the file
 * system. Directories match everything below them.
 */
export function literalPathspec(
  relative: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const magic = isCaseInsensitivePlatform(platform) ? 'literal,icase' : 'literal';
  return `:(${magic})${relative === '' ? '.' : relative}`;
}
