import picomatch from 'picomatch';

/** Globs follow the usual file system case rules: case-insensitive on Windows and macOS. */
export function globsIgnoreCase(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/**
 * Normalizes a model-supplied glob: on Windows backslashes are path separators (models write
 * "src\\**\\*.ts"), and a leading "./" is redundant.
 */
export function normalizeGlob(
  pattern: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const slashes = platform === 'win32' ? pattern.replace(/\\/g, '/') : pattern;
  return slashes.replace(/^(\.\/)+/, '');
}

/**
 * Expresses a normalized glob with ripgrep `--glob` (gitignore) semantics as a pattern anchored
 * at the search root: a pattern without a slash matches the file name at any depth
 * ("*.ts" → "**\/*.ts"), a pattern with a slash is anchored at the root, and a leading "/" only
 * anchors.
 */
export function anchoredGlob(pattern: string): string {
  if (pattern.startsWith('/')) return pattern.replace(/^\/+/, '');
  const body = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  return body.includes('/') ? pattern : `**/${pattern}`;
}

/**
 * Matcher for root-relative, forward-slash paths with the semantics of `anchoredGlob`. Dotfiles
 * match like any other file; case sensitivity defaults to `globsIgnoreCase(platform)`.
 */
export function createGlobMatcher(
  pattern: string,
  options: { caseInsensitive?: boolean; platform?: NodeJS.Platform } = {},
): (relativePath: string) => boolean {
  const platform = options.platform ?? process.platform;
  const nocase = options.caseInsensitive ?? globsIgnoreCase(platform);
  return picomatch(anchoredGlob(normalizeGlob(pattern, platform)), { dot: true, nocase });
}
