import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, vi } from 'vitest';
import { makeTempDir } from '../../src/testing/index.js';

/**
 * Isolates git from the developer's global and system configuration (rename settings, signing,
 * autocrlf, ...) for the current test file, so results do not depend on the machine.
 */
export function useIsolatedGitConfig(): void {
  let temp: { dir: string; cleanup: () => void } | undefined;
  beforeAll(() => {
    temp = makeTempDir('patch-gitconfig-');
    const config = join(temp.dir, 'gitconfig');
    writeFileSync(config, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    temp?.cleanup();
  });
}

/** Runs `fn` with a temp repository and always removes it afterwards. */
export async function withRepo<T>(
  repo: { dir: string; cleanup: () => void },
  fn: (dir: string) => Promise<T> | T,
): Promise<T> {
  try {
    return await fn(repo.dir);
  } finally {
    repo.cleanup();
  }
}
