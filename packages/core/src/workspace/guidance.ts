import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { GuidanceFile } from './types.js';

/**
 * Root-level guidance documents in reporting order. Each group yields at most one file: the first
 * candidate present (matched case-insensitively, reported with its real name).
 */
const GUIDANCE_GROUPS: readonly (readonly string[])[] = [
  ['README.md', 'README', 'README.rst', 'README.txt', 'readme.md'],
  ['CONTRIBUTING.md'],
  ['ARCHITECTURE.md'],
  ['DEVELOPMENT.md'],
  ['HACKING.md'],
];

/** Entry names matching `candidate`: an exact match first, then case variants. */
function matchingNames(entries: string[], candidate: string): string[] {
  const lower = candidate.toLowerCase();
  const variants = entries.filter((name) => name !== candidate && name.toLowerCase() === lower);
  return entries.includes(candidate) ? [candidate, ...variants] : variants;
}

async function fileSize(file: string): Promise<number | undefined> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

async function firstPresent(
  projectRoot: string,
  entries: string[],
  candidates: readonly string[],
): Promise<GuidanceFile | undefined> {
  for (const candidate of candidates) {
    for (const name of matchingNames(entries, candidate)) {
      const bytes = await fileSize(path.join(projectRoot, name));
      if (bytes !== undefined) return { path: name, bytes };
    }
  }
  return undefined;
}

/**
 * Finds README/CONTRIBUTING/ARCHITECTURE/docs-index style files at the project root (not loaded).
 * Looks for README (README.md, README, README.rst, README.txt), CONTRIBUTING.md, ARCHITECTURE.md,
 * DEVELOPMENT.md and HACKING.md. Never throws.
 */
export async function findGuidanceFiles(projectRoot: string): Promise<GuidanceFile[]> {
  let entries: string[];
  try {
    entries = await readdir(projectRoot);
  } catch {
    return [];
  }
  const found = await Promise.all(
    GUIDANCE_GROUPS.map((candidates) => firstPresent(projectRoot, entries, candidates)),
  );
  return found.filter((file): file is GuidanceFile => file !== undefined);
}
