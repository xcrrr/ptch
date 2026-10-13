import path from 'node:path';

/** Path functions for `platform` (lets analysis of Windows commands run on any host and vice versa). */
export function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Windows and macOS file systems compare paths case-insensitively by default. */
export function isCaseInsensitivePlatform(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

function comparable(absolutePath: string, platform: NodeJS.Platform): string {
  const resolved = pathApi(platform).resolve(absolutePath);
  return isCaseInsensitivePlatform(platform) ? resolved.toLowerCase() : resolved;
}

export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return comparable(a, platform) === comparable(b, platform);
}

/** True if `child` equals `parent` or is inside it. Both must be absolute. */
export function isWithin(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform);
  const from = comparable(parent, platform);
  const to = comparable(child, platform);
  if (from === to) return true;
  const relative = api.relative(from, to);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${api.sep}`) &&
    !api.isAbsolute(relative)
  );
}

/** True if `ancestor` contains `descendant` and is not the same path. */
export function isStrictAncestor(
  ancestor: string,
  descendant: string,
  platform: NodeJS.Platform,
): boolean {
  return isWithin(descendant, ancestor, platform) && !samePath(ancestor, descendant, platform);
}
