import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PathPolicy, ResolvedPath } from '../../src/fs/paths.js';
import { git, makeGitRepo, makeTempDir, writeFiles } from '../../src/testing/index.js';
import {
  formatGitStatus,
  gitDiffTool,
  gitLogTool,
  gitStatusTool,
} from '../../src/tools/git-tools.js';
import { ToolError, type ToolContext } from '../../src/tools/types.js';
import type { GitStatus } from '../../src/git/status.js';
import { useIsolatedGitConfig } from '../git/git-env.js';

useIsolatedGitConfig();

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function track<T extends { dir: string; cleanup: () => void }>(resource: T): string {
  cleanups.push(resource.cleanup);
  return resource.dir;
}

/** Minimal PathPolicy stand-in: resolves against cwd, displays cwd-relative inside the project. */
function fakePaths(cwd: string, projectRoot: string): PathPolicy {
  return {
    cwd,
    projectRoot,
    home: projectRoot,
    async resolve(input: string): Promise<ResolvedPath> {
      const absolute = path.resolve(cwd, input);
      const relativeToRoot = path.relative(projectRoot, absolute);
      const insideProject = !relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot);
      const exists = existsSync(absolute);
      return {
        input,
        absolute,
        display: insideProject
          ? path.relative(cwd, absolute).split(path.sep).join('/') || '.'
          : absolute,
        insideProject,
        exists,
        isDirectory: exists && statSync(absolute).isDirectory(),
        insideGitDir: false,
      };
    },
  } as unknown as PathPolicy;
}

function context(options: { cwd: string; gitRoot: string | null }): ToolContext {
  const projectRoot = options.gitRoot ?? options.cwd;
  return {
    cwd: options.cwd,
    projectRoot,
    gitRoot: options.gitRoot,
    home: projectRoot,
    signal: new AbortController().signal,
    paths: fakePaths(options.cwd, projectRoot),
    fileState: {} as ToolContext['fileState'],
    shell: {} as ToolContext['shell'],
    logger: {} as ToolContext['logger'],
  };
}

function repoContext(dir: string, cwd = dir): ToolContext {
  return context({ cwd, gitRoot: dir });
}

const NOT_A_REPO = 'Not a Git repository (Patch is running in directory mode).';

describe('directory mode', () => {
  const ctx = () => context({ cwd: track(makeTempDir()), gitRoot: null });

  it('every git tool fails with a clear error', async () => {
    for (const [tool, input] of [
      [gitStatusTool, {}],
      [gitDiffTool, {}],
      [gitLogTool, {}],
    ] as const) {
      const c = ctx();
      await expect(tool.execute(input as never, c)).rejects.toThrow(new ToolError(NOT_A_REPO));
      await expect(
        Promise.resolve().then(() => tool.permission(input as never, c)),
      ).rejects.toThrow(NOT_A_REPO);
    }
  });
});

describe('git_status', () => {
  it('summarizes and asks for read access to the repository root', async () => {
    const dir = track(makeGitRepo());
    const ctx = repoContext(dir);
    expect(gitStatusTool.summarize({}, ctx)).toEqual({ verb: 'git', target: 'status' });
    const subject = await gitStatusTool.permission({}, ctx);
    expect(subject).toMatchObject({ kind: 'read', paths: [{ absolute: dir }] });
  });

  it('reports a clean working tree', async () => {
    const dir = track(makeGitRepo());
    const result = await gitStatusTool.execute({}, repoContext(dir));
    expect(result.content).toBe('On branch main (no upstream)\nWorking tree clean.');
    expect(result.display?.summary).toBe('clean');
  });

  it('lists staged, unstaged and untracked changes relative to cwd', async () => {
    const dir = track(
      makeGitRepo({
        'a.txt': 'a\n',
        'src/b.ts': 'b\n',
        'src/old name.ts': 'same content\n'.repeat(5),
        'gone.txt': 'bye\n',
      }),
    );
    writeFiles(dir, {
      'a.txt': 'a2\n',
      'src/b.ts': 'b2\n',
      'src/new file.ts': 'n\n',
      'tmp/x': 'x',
    });
    git(dir, 'add', 'a.txt');
    git(dir, 'mv', 'src/old name.ts', 'src/renamed ü.ts');
    rmSync(path.join(dir, 'gone.txt'));

    const fromRoot = await gitStatusTool.execute({}, repoContext(dir));
    expect(fromRoot.content).toBe(
      [
        'On branch main (no upstream)',
        'Staged:',
        '  modified: a.txt',
        '  renamed: src/old name.ts -> src/renamed ü.ts',
        'Unstaged:',
        '  deleted: gone.txt',
        '  modified: src/b.ts',
        'Untracked:',
        '  src/new file.ts',
        '  tmp/',
      ].join('\n'),
    );
    expect(fromRoot.display?.summary).toBe('6 changed');

    const fromSrc = await gitStatusTool.execute({}, repoContext(dir, path.join(dir, 'src')));
    expect(fromSrc.content).toContain('  modified: ../a.txt');
    expect(fromSrc.content).toContain('  renamed: old name.ts -> renamed ü.ts');
    expect(fromSrc.content).toContain('  ../tmp/');
  });

  it('lists merge conflicts', async () => {
    const dir = track(makeGitRepo({ 'c.txt': 'base\n' }));
    git(dir, 'checkout', '-q', '-b', 'other');
    writeFileSync(path.join(dir, 'c.txt'), 'other\n');
    git(dir, 'commit', '-q', '-am', 'other');
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(path.join(dir, 'c.txt'), 'main\n');
    git(dir, 'commit', '-q', '-am', 'main');
    expect(() => git(dir, 'merge', '-q', 'other')).toThrow();

    const result = await gitStatusTool.execute({}, repoContext(dir));
    expect(result.content).toBe('On branch main (no upstream)\nConflicts:\n  both modified: c.txt');
    expect(result.display?.summary).toBe('1 changed');
  });

  it('shows upstream tracking, unborn branches and detached HEAD', async () => {
    const origin = track(makeGitRepo());
    const clones = track(makeTempDir('patch-clone-'));
    const clone = path.join(clones, 'work');
    git(clones, 'clone', '-q', origin, clone);
    git(clone, 'commit', '-q', '--allow-empty', '-m', 'local');
    expect((await gitStatusTool.execute({}, repoContext(clone))).content).toBe(
      'On branch main, tracking origin/main (ahead 1)\nWorking tree clean.',
    );

    const unborn = track(makeGitRepo({}, { commit: false }));
    expect((await gitStatusTool.execute({}, repoContext(unborn))).content).toBe(
      'On branch main (no commits yet)\nWorking tree clean.',
    );

    git(origin, 'checkout', '-q', '--detach');
    const sha = git(origin, 'rev-parse', 'HEAD').trim();
    expect((await gitStatusTool.execute({}, repoContext(origin))).content).toBe(
      `HEAD detached at ${sha.slice(0, 7)}\nWorking tree clean.`,
    );
  });

  it('turns git failures into tool errors', async () => {
    const notARepo = track(makeTempDir());
    const original = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(notARepo);
    try {
      const error = await gitStatusTool
        .execute({}, context({ cwd: notARepo, gitRoot: notARepo }))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ToolError);
      expect((error as Error).message).toMatch(/^git status failed: not a git repository/);
    } finally {
      if (original === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = original;
    }
  });
});

describe('formatGitStatus', () => {
  const base: GitStatus = {
    branch: 'feature',
    detached: false,
    head: 'f'.repeat(40),
    upstream: 'origin/feature',
    ahead: 0,
    behind: 0,
    files: [],
  };
  const identity = (p: string) => p;

  it('describes every tracking state', () => {
    const line = (status: Partial<GitStatus>) =>
      formatGitStatus({ ...base, ...status }, identity).split('\n')[0];
    expect(line({})).toBe('On branch feature, tracking origin/feature (up to date)');
    expect(line({ behind: 3 })).toBe('On branch feature, tracking origin/feature (behind 3)');
    expect(line({ ahead: 2, behind: 5 })).toBe(
      'On branch feature, tracking origin/feature (ahead 2, behind 5)',
    );
    expect(line({ upstreamGone: true })).toBe(
      'On branch feature, tracking origin/feature (upstream gone)',
    );
  });

  it('labels every change and conflict kind', () => {
    const text = formatGitStatus(
      {
        ...base,
        files: [
          { path: 'a', index: 'added', worktree: 'unmodified' },
          { path: 'b', index: 'type-changed', worktree: 'unmodified' },
          { path: 'c', origPath: 'orig', index: 'copied', worktree: 'modified' },
          { path: 'd', index: 'unmerged', worktree: 'unmerged', conflict: 'deleted-by-us' },
          { path: 'e', index: 'unmerged', worktree: 'unmerged', conflict: 'added-by-them' },
          { path: 'f', index: 'ignored', worktree: 'ignored' },
        ],
      },
      identity,
    );
    expect(text).toBe(
      [
        'On branch feature, tracking origin/feature (up to date)',
        'Staged:',
        '  added: a',
        '  type changed: b',
        '  copied: orig -> c',
        'Unstaged:',
        '  modified: c',
        'Conflicts:',
        '  deleted by us: d',
        '  added by them: e',
      ].join('\n'),
    );
  });

  it('caps long sections with an explicit count', () => {
    const files = Array.from({ length: 205 }, (_, i) => ({
      path: `file-${i}.txt`,
      index: 'untracked' as const,
      worktree: 'untracked' as const,
    }));
    const lines = formatGitStatus({ ...base, files }, identity).split('\n');
    expect(lines).toHaveLength(1 + 1 + 200 + 1);
    expect(lines.at(-1)).toBe('  ... 5 more');
  });
});

describe('git_diff', () => {
  function changedRepo(): string {
    const dir = track(
      makeGitRepo({
        'staged.txt': 'one\ntwo\n',
        'src/unstaged.ts': 'alpha\nbeta\n',
        'keep.txt': 'k\n',
      }),
    );
    writeFiles(dir, {
      'staged.txt': 'one\nTWO\n',
      'src/unstaged.ts': 'alpha\nBETA\ngamma\n',
      'notes/new.md': 'new\n',
    });
    git(dir, 'add', 'staged.txt');
    return dir;
  }

  it('summarizes the call', () => {
    const ctx = context({ cwd: '.', gitRoot: '.' });
    expect(gitDiffTool.summarize({}, ctx)).toEqual({ verb: 'git', target: 'diff' });
    expect(gitDiffTool.summarize({ path: 'src/a.ts', scope: 'staged', stat: true }, ctx)).toEqual({
      verb: 'git',
      target: 'diff src/a.ts',
      detail: 'staged · stat',
    });
    expect(gitDiffTool.summarize({ scope: 'all' }, ctx)).toEqual({ verb: 'git', target: 'diff' });
  });

  it('shows all changes against HEAD and lists untracked files', async () => {
    const dir = changedRepo();
    const result = await gitDiffTool.execute({}, repoContext(dir));
    expect(result.content).toContain('diff --git a/staged.txt b/staged.txt');
    expect(result.content).toContain('diff --git a/src/unstaged.ts b/src/unstaged.ts');
    expect(result.content).toContain('+TWO');
    expect(result.content.endsWith('Untracked files (not included in the diff):\n  notes/')).toBe(
      true,
    );
    expect(result.display?.summary).toBe('2 files +3 -2 · 1 untracked');
  });

  it('limits staged diffs to the index and omits untracked files', async () => {
    const dir = changedRepo();
    const result = await gitDiffTool.execute({ scope: 'staged' }, repoContext(dir));
    expect(result.content).toContain('+TWO');
    expect(result.content).not.toContain('unstaged.ts');
    expect(result.content).not.toContain('Untracked files');
    expect(result.display?.summary).toBe('1 file +1 -1');
  });

  it('limits the diff to a path relative to cwd', async () => {
    const dir = changedRepo();
    const ctx = repoContext(dir, path.join(dir, 'src'));
    expect(await gitDiffTool.permission({ path: 'unstaged.ts' }, ctx)).toMatchObject({
      kind: 'read',
      paths: [{ absolute: path.join(dir, 'src', 'unstaged.ts') }],
    });
    const result = await gitDiffTool.execute({ path: 'unstaged.ts', scope: 'unstaged' }, ctx);
    expect(result.content).toContain('diff --git a/src/unstaged.ts b/src/unstaged.ts');
    expect(result.content).not.toContain('staged.txt');
    expect(result.content).not.toContain('Untracked');
    expect(result.content).toMatch(
      /\n\n\(Paths in the diff are relative to the repository root, \.\.\)$/,
    );
    expect(result.display?.summary).toBe('1 file +2 -1');
  });

  it('lists untracked files under the requested path', async () => {
    const dir = changedRepo();
    const result = await gitDiffTool.execute({ path: 'notes/new.md' }, repoContext(dir));
    expect(result.content).toBe(
      'No uncommitted changes to tracked files in notes/new.md.\n\nUntracked files (not included in the diff):\n  notes/',
    );
    expect(result.display?.summary).toBe('no changes · 1 untracked');
  });

  it('reports when there are no changes', async () => {
    const dir = track(makeGitRepo({ 'a.txt': 'a\n' }));
    const all = await gitDiffTool.execute({}, repoContext(dir));
    expect(all.content).toBe('No uncommitted changes to tracked files.');
    expect(all.display?.summary).toBe('no changes');
    const staged = await gitDiffTool.execute({ scope: 'staged', path: 'a.txt' }, repoContext(dir));
    expect(staged.content).toBe('No staged changes in a.txt.');
    const unstaged = await gitDiffTool.execute({ scope: 'unstaged' }, repoContext(dir));
    expect(unstaged.content).toBe('No unstaged changes.');
  });

  it('treats the repository root as no path filter', async () => {
    const dir = track(makeGitRepo({ 'src/a.ts': 'a\n' }));
    const ctx = repoContext(dir, path.join(dir, 'src'));
    const result = await gitDiffTool.execute({ path: '..' }, ctx);
    expect(result.content).toBe('No uncommitted changes to tracked files.');
  });

  it('returns a per-file overview with stat', async () => {
    const dir = changedRepo();
    const result = await gitDiffTool.execute({ stat: true }, repoContext(dir));
    expect(result.content).toMatch(/staged\.txt\s+\| 2 \+-/);
    expect(result.content).toContain('2 files changed, 3 insertions(+), 2 deletions(-)');
    expect(result.content).not.toContain('diff --git');
  });

  it('rejects paths outside the repository', async () => {
    const dir = changedRepo();
    const ctx = repoContext(dir);
    const outside = path.join(path.dirname(dir), 'elsewhere.txt');
    await expect(gitDiffTool.permission({ path: outside }, ctx)).rejects.toThrow(
      /is outside the Git repository/,
    );
    await expect(gitDiffTool.execute({ path: outside }, ctx)).rejects.toBeInstanceOf(ToolError);
  });

  it('truncates very large diffs with an explicit note', async () => {
    const lines = (prefix: string) =>
      Array.from({ length: 2000 }, (_, i) => `${prefix} ${i}`).join('\n');
    const dir = track(makeGitRepo({ 'big.txt': `${lines('old')}\n` }));
    writeFileSync(path.join(dir, 'big.txt'), `${lines('new')}\n`);
    const result = await gitDiffTool.execute({}, repoContext(dir));
    expect(result.content).toContain('lines omitted');
    expect(result.content).toMatch(
      /\[Diff truncated: [\d,]+ lines in total, the middle was omitted\. Pass `path` to focus on one file or directory, or `stat: true` for a per-file overview\.\]$/,
    );
    expect(result.content.length).toBeLessThan(65_000);
    expect(result.display?.summary).toBe('1 file +2000 -2000');
  });

  it('works in a repository without commits', async () => {
    const dir = track(makeGitRepo({ 'a.txt': 'first\n' }, { commit: false }));
    git(dir, 'add', 'a.txt');
    writeFileSync(path.join(dir, 'a.txt'), 'first\nsecond\n');
    const result = await gitDiffTool.execute({}, repoContext(dir));
    expect(result.content).toContain('new file mode');
    expect(result.content).toContain('+second');
    expect(result.display?.summary).toBe('1 file +2 -0');
  });
});

describe('git_log', () => {
  it('summarizes the call', () => {
    const ctx = context({ cwd: '.', gitRoot: '.' });
    expect(gitLogTool.summarize({}, ctx)).toEqual({ verb: 'git', target: 'log' });
    expect(gitLogTool.summarize({ path: 'src' }, ctx)).toEqual({ verb: 'git', target: 'log src' });
  });

  it('lists recent commits one per line', async () => {
    const dir = track(makeGitRepo());
    git(
      dir,
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'fix: handle CRLF',
      '--author=Ada Lovelace <ada@example.com>',
      '--date=2024-03-01T12:00:00',
    );
    const result = await gitLogTool.execute({}, repoContext(dir));
    const lines = result.content.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      `${git(dir, 'rev-parse', '--short', 'HEAD').trim()} 2024-03-01 Ada Lovelace  fix: handle CRLF`,
    );
    expect(lines[1]).toMatch(/^[0-9a-f]{7,} \d{4}-\d{2}-\d{2} Patch Test {2}initial commit$/);
    expect(result.display?.summary).toBe('2 commits');
  });

  it('notes when older commits are cut off by the limit', async () => {
    const dir = track(makeGitRepo());
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'second');
    const result = await gitLogTool.execute({ limit: 1 }, repoContext(dir));
    expect(result.content).toMatch(
      /^[0-9a-f]+ \S+ Patch Test {2}second\n\(Older commits not shown\. Raise limit \(max 50\) to see more\.\)$/,
    );
    expect(result.display?.summary).toBe('1 commit');
  });

  it('omits the note when the whole history fits the limit', async () => {
    const dir = track(makeGitRepo());
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'second');
    const result = await gitLogTool.execute({ limit: 2 }, repoContext(dir));
    expect(result.content).not.toContain('Older commits');
    expect(result.content.split('\n')).toHaveLength(2);
  });

  it('limits commits to a path', async () => {
    const dir = track(makeGitRepo({ 'a.txt': 'a\n' }));
    writeFiles(dir, { 'src/b.ts': 'b\n' });
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'add b');
    const ctx = repoContext(dir, path.join(dir, 'src'));
    const result = await gitLogTool.execute({ path: 'b.ts' }, ctx);
    expect(result.content).toMatch(/ {2}add b$/);
    expect((await gitLogTool.execute({ path: '../missing.txt' }, ctx)).content).toBe(
      'No commits touch ../missing.txt.',
    );
  });

  it('reports a repository without commits', async () => {
    const dir = track(makeGitRepo({}, { commit: false }));
    const result = await gitLogTool.execute({}, repoContext(dir));
    expect(result).toEqual({ content: 'No commits yet.', display: { summary: '0 commits' } });
  });
});
