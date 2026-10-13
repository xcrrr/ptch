import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Creates a fresh temp directory (realpath-resolved) and returns it with a cleanup function. */
export function makeTempDir(prefix = 'patch-test-'): { dir: string; cleanup: () => void } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Best effort (Windows may hold handles briefly).
      }
    },
  };
}

/** Writes files relative to `root`, creating directories as needed. */
export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Patch Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Patch Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Initializes a git repo with an initial commit containing `files`. */
export function makeGitRepo(
  files: Record<string, string> = { 'README.md': '# fixture\n' },
  options: { branch?: string; commit?: boolean } = {},
): { dir: string; cleanup: () => void } {
  const temp = makeTempDir('patch-repo-');
  git(temp.dir, 'init', '-q', '-b', options.branch ?? 'main');
  git(temp.dir, 'config', 'core.autocrlf', 'false');
  git(temp.dir, 'config', 'commit.gpgsign', 'false');
  writeFiles(temp.dir, files);
  if (options.commit !== false) {
    git(temp.dir, 'add', '-A');
    git(temp.dir, 'commit', '-q', '-m', 'initial commit');
  }
  return temp;
}
