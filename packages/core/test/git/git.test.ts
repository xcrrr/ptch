import path from 'node:path';
import { isAbortError } from '@patch/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectGitRepo,
  GitCommandError,
  GitUnavailableError,
  isGitAvailable,
  runGit,
} from '../../src/git/git.js';
import { git, makeGitRepo, makeTempDir, writeFiles } from '../../src/testing/index.js';
import { useIsolatedGitConfig, withRepo } from './git-env.js';

useIsolatedGitConfig();

const originalCeiling = process.env.GIT_CEILING_DIRECTORIES;

afterEach(() => {
  if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
});

/** Keeps git from discovering a repository above `dir` (in case the temp dir sits in one). */
function stopDiscoveryAbove(dir: string): void {
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir);
}

function withoutGitOnPath<T>(fn: () => Promise<T>): Promise<T> {
  const empty = makeTempDir('patch-nopath-');
  const original = process.env.PATH;
  process.env.PATH = empty.dir;
  return fn().finally(() => {
    process.env.PATH = original;
    empty.cleanup();
  });
}

describe('runGit', () => {
  it('returns stdout with exit code 0', async () => {
    await withRepo(makeGitRepo(), async (dir) => {
      const result = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
      expect(result).toMatchObject({ stdout: 'true\n', exitCode: 0 });
      expect(result.truncated).toBeUndefined();
    });
  });

  it('resolves with the exit code instead of throwing on failure', async () => {
    await withRepo(makeGitRepo(), async (dir) => {
      const quiet = await runGit(['rev-parse', '--verify', '-q', 'no-such-ref'], { cwd: dir });
      expect(quiet.exitCode).toBe(1);

      const fatal = await runGit(['log', 'no-such-ref'], { cwd: dir });
      expect(fatal.exitCode).toBe(128);
      expect(fatal.stderr).toMatch(/unknown revision/);
    });
  });

  it('runs non-interactively with stable, unquoted output', async () => {
    await withRepo(makeGitRepo({ 'naïve résumé.txt': 'x\n' }), async (dir) => {
      expect((await runGit(['var', 'GIT_PAGER'], { cwd: dir })).stdout.trim()).toBe('cat');
      expect((await runGit(['config', 'core.quotepath'], { cwd: dir })).stdout.trim()).toBe('off');
      const files = await runGit(['ls-files'], { cwd: dir });
      expect(files.stdout).toBe('naïve résumé.txt\n');
    });
  });

  it('throws GitUnavailableError when git is not on PATH', async () => {
    const temp = makeTempDir();
    try {
      await withoutGitOnPath(async () => {
        await expect(runGit(['--version'], { cwd: temp.dir })).rejects.toBeInstanceOf(
          GitUnavailableError,
        );
      });
    } finally {
      temp.cleanup();
    }
  });

  it('reports a missing working directory instead of a missing git', async () => {
    const temp = makeTempDir();
    const missing = path.join(temp.dir, 'does-not-exist');
    try {
      const error = await runGit(['status'], { cwd: missing }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitCommandError);
      expect((error as Error).message).toContain('directory not found');
    } finally {
      temp.cleanup();
    }
  });

  it('times out commands that do not finish', async () => {
    await withRepo(makeGitRepo(), async (dir) => {
      // Waits for stdin, which is never closed.
      const error = await runGit(['hash-object', '--stdin'], { cwd: dir, timeoutMs: 300 }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(GitCommandError);
      expect((error as GitCommandError).message).toMatch(/git hash-object timed out after 300ms/);
      expect((error as GitCommandError).exitCode).toBeNull();
    });
  });

  it('stops git and throws AbortError when the signal fires', async () => {
    await withRepo(makeGitRepo(), async (dir) => {
      const controller = new AbortController();
      const pending = runGit(['hash-object', '--stdin'], { cwd: dir, signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      const error = await pending.catch((e: unknown) => e);
      expect(isAbortError(error)).toBe(true);
    });
  });

  it('throws AbortError without spawning when the signal already fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await runGit(['--version'], { cwd: '.', signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    expect(isAbortError(error)).toBe(true);
  });

  it('keeps output up to maxBuffer and flags it as truncated', async () => {
    const big = `${'0123456789'.repeat(1000)}\n`;
    await withRepo(makeGitRepo({ 'big.txt': big }), async (dir) => {
      const result = await runGit(['show', 'HEAD:big.txt'], { cwd: dir, maxBuffer: 1000 });
      expect(result.truncated).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBeLessThanOrEqual(1000);
      expect(big.startsWith(result.stdout)).toBe(true);
    });
  });
});

describe('isGitAvailable', () => {
  it('is true when git is installed and caches the answer', async () => {
    const first = isGitAvailable();
    expect(await first).toBe(true);
    expect(await isGitAvailable()).toBe(true);
  });
});

describe('detectGitRepo', () => {
  it('describes a repository from its root', async () => {
    await withRepo(makeGitRepo(), async (dir) => {
      const info = await detectGitRepo(dir);
      expect(info).toEqual({
        root: dir,
        branch: 'main',
        head: git(dir, 'rev-parse', '--short', 'HEAD').trim(),
        detached: false,
        hasCommits: true,
      });
    });
  });

  it('finds the root from a subdirectory', async () => {
    await withRepo(makeGitRepo({ 'src/deep/a.ts': 'a\n' }), async (dir) => {
      const info = await detectGitRepo(path.join(dir, 'src', 'deep'));
      expect(info?.root).toBe(dir);
    });
  });

  it('returns null outside a repository', async () => {
    const temp = makeTempDir();
    try {
      stopDiscoveryAbove(temp.dir);
      expect(await detectGitRepo(temp.dir)).toBeNull();
    } finally {
      temp.cleanup();
    }
  });

  it('reports a repository without commits', async () => {
    await withRepo(
      makeGitRepo({ 'a.txt': 'a\n' }, { commit: false, branch: 'trunk' }),
      async (dir) => {
        expect(await detectGitRepo(dir)).toEqual({
          root: dir,
          branch: 'trunk',
          head: null,
          detached: false,
          hasCommits: false,
        });
      },
    );
  });

  it('reports a detached HEAD', async () => {
    await withRepo(makeGitRepo(), async (dir) => {
      git(dir, 'checkout', '-q', '--detach');
      const info = await detectGitRepo(dir);
      expect(info).toMatchObject({ branch: null, detached: true, hasCommits: true });
      expect(info?.head).toBe(git(dir, 'rev-parse', '--short', 'HEAD').trim());
    });
  });

  it('returns null inside the .git directory', async () => {
    await withRepo(makeGitRepo(), async (dir) => {
      expect(await detectGitRepo(path.join(dir, '.git'))).toBeNull();
    });
  });

  it('returns null in a bare repository', async () => {
    const temp = makeTempDir();
    try {
      git(temp.dir, 'init', '-q', '--bare');
      stopDiscoveryAbove(temp.dir);
      expect(await detectGitRepo(temp.dir)).toBeNull();
    } finally {
      temp.cleanup();
    }
  });

  it('handles paths with spaces and unicode', async () => {
    const temp = makeTempDir();
    try {
      const dir = path.join(temp.dir, 'my repö');
      writeFiles(dir, { 'README.md': '# x\n' });
      git(dir, 'init', '-q', '-b', 'main');
      const info = await detectGitRepo(dir);
      expect(info?.root).toBe(dir);
      expect(info?.hasCommits).toBe(false);
    } finally {
      temp.cleanup();
    }
  });

  it('returns null when git is unavailable', async () => {
    await withRepo(makeGitRepo(), async (dir) => {
      await withoutGitOnPath(async () => {
        expect(await detectGitRepo(dir)).toBeNull();
      });
    });
  });
});
