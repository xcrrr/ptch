import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  countChanges,
  describeStatus,
  getFileGitStatus,
  getGitStatus,
  parsePorcelainV2,
  type GitFileStatus,
  type GitStatus,
} from '../../src/git/status.js';
import { git, makeGitRepo, makeTempDir, writeFiles } from '../../src/testing/index.js';
import { useIsolatedGitConfig, withRepo } from './git-env.js';

useIsolatedGitConfig();

const OID = '1234567890abcdef1234567890abcdef12345678';
const H1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const H2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const H3 = 'cccccccccccccccccccccccccccccccccccccccc';

/** Builds a NUL-terminated porcelain v2 stream from records. */
function porcelain(...records: string[]): string {
  return records.map((r) => `${r}\0`).join('');
}

const ordinary = (xy: string, file: string) =>
  `1 ${xy} N... 100644 100644 100644 ${H1} ${H2} ${file}`;

function sortedFiles(status: GitStatus): GitFileStatus[] {
  return [...status.files].sort((a, b) => a.path.localeCompare(b.path));
}

describe('parsePorcelainV2', () => {
  it('parses branch headers and every record type', () => {
    const output = porcelain(
      `# branch.oid ${OID}`,
      '# branch.head feature/login',
      '# branch.upstream origin/feature/login',
      '# branch.ab +2 -1',
      ordinary('M.', 'src/staged.ts'),
      ordinary('.M', 'src/unstaged file.ts'),
      ordinary('MM', 'both.ts'),
      `1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 ${H2} new.ts`,
      `1 .D N... 100644 100644 000000 ${H1} ${H1} gone.ts`,
      ordinary('T.', 'link'),
      `2 R. N... 100644 100644 100644 ${H1} ${H1} R100 new näme.ts`,
      'old name.ts',
      `2 C. N... 100644 100644 100644 ${H1} ${H1} C75 copy.ts`,
      'orig.ts',
      `u UU N... 100644 100644 100644 100644 ${H1} ${H2} ${H3} conflict.ts`,
      `u AA N... 000000 100644 100644 100644 ${H1} ${H2} ${H3} both added.ts`,
      `u UD N... 100644 100644 000000 100644 ${H1} ${H2} ${H3} theirs-deleted.ts`,
      '? untracked dir/',
      '? notes – ü.md',
      '? line\nbreak.txt',
      '! build/',
    );
    const status = parsePorcelainV2(output);
    expect(status).toMatchObject({
      branch: 'feature/login',
      detached: false,
      head: OID,
      upstream: 'origin/feature/login',
      ahead: 2,
      behind: 1,
    });
    expect(status.upstreamGone).toBeUndefined();
    expect(status.files).toEqual([
      { path: 'src/staged.ts', index: 'modified', worktree: 'unmodified' },
      { path: 'src/unstaged file.ts', index: 'unmodified', worktree: 'modified' },
      { path: 'both.ts', index: 'modified', worktree: 'modified' },
      { path: 'new.ts', index: 'added', worktree: 'unmodified' },
      { path: 'gone.ts', index: 'unmodified', worktree: 'deleted' },
      { path: 'link', index: 'type-changed', worktree: 'unmodified' },
      { path: 'new näme.ts', origPath: 'old name.ts', index: 'renamed', worktree: 'unmodified' },
      { path: 'copy.ts', origPath: 'orig.ts', index: 'copied', worktree: 'unmodified' },
      { path: 'conflict.ts', index: 'unmerged', worktree: 'unmerged', conflict: 'both-modified' },
      { path: 'both added.ts', index: 'unmerged', worktree: 'unmerged', conflict: 'both-added' },
      {
        path: 'theirs-deleted.ts',
        index: 'unmerged',
        worktree: 'unmerged',
        conflict: 'deleted-by-them',
      },
      { path: 'untracked dir/', index: 'untracked', worktree: 'untracked' },
      { path: 'notes – ü.md', index: 'untracked', worktree: 'untracked' },
      { path: 'line\nbreak.txt', index: 'untracked', worktree: 'untracked' },
      { path: 'build/', index: 'ignored', worktree: 'ignored' },
    ]);
  });

  it('maps every conflict code', () => {
    const codes = {
      DD: 'both-deleted',
      AU: 'added-by-us',
      UA: 'added-by-them',
      DU: 'deleted-by-us',
    };
    for (const [xy, conflict] of Object.entries(codes)) {
      const status = parsePorcelainV2(
        porcelain(`u ${xy} N... 100644 100644 100644 100644 ${H1} ${H2} ${H3} f.ts`),
      );
      expect(status.files[0]?.conflict).toBe(conflict);
    }
  });

  it('parses a rename that is also modified in the work tree', () => {
    const status = parsePorcelainV2(
      porcelain(`2 RM N... 100644 100644 100644 ${H1} ${H1} R87 dir/b.ts`, 'dir/a.ts'),
    );
    expect(status.files).toEqual([
      { path: 'dir/b.ts', origPath: 'dir/a.ts', index: 'renamed', worktree: 'modified' },
    ]);
  });

  it('reports a repository without commits', () => {
    const status = parsePorcelainV2(
      porcelain('# branch.oid (initial)', '# branch.head main', '? a.txt'),
    );
    expect(status).toMatchObject({ branch: 'main', head: null, detached: false, upstream: null });
  });

  it('reports a detached HEAD', () => {
    const status = parsePorcelainV2(porcelain(`# branch.oid ${OID}`, '# branch.head (detached)'));
    expect(status).toMatchObject({ branch: null, detached: true, head: OID });
  });

  it('defaults upstream fields when there is no upstream', () => {
    const status = parsePorcelainV2(porcelain(`# branch.oid ${OID}`, '# branch.head main'));
    expect(status).toEqual({
      branch: 'main',
      detached: false,
      head: OID,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
    });
  });

  it('flags an upstream whose branch is gone (no ahead/behind line)', () => {
    const status = parsePorcelainV2(
      porcelain(`# branch.oid ${OID}`, '# branch.head main', '# branch.upstream origin/old'),
    );
    expect(status).toMatchObject({ upstream: 'origin/old', upstreamGone: true, ahead: 0 });
  });

  it('ignores unknown headers, empty input and malformed records', () => {
    expect(parsePorcelainV2('').files).toEqual([]);
    const status = parsePorcelainV2(
      porcelain('# stash 3', '1 M. N... 100644', '2 R. N...', 'x unknown', ordinary('.M', 'ok.ts')),
    );
    expect(status.files).toEqual([{ path: 'ok.ts', index: 'unmodified', worktree: 'modified' }]);
  });
});

describe('countChanges / describeStatus', () => {
  const status = parsePorcelainV2(
    porcelain(
      ordinary('M.', 'a.ts'),
      ordinary('A.', 'b.ts'),
      ordinary('MM', 'c.ts'),
      ordinary('.M', 'd.ts'),
      ordinary('.D', 'e.ts'),
      ordinary('.M', 'f.ts'),
      `u UU N... 100644 100644 100644 100644 ${H1} ${H2} ${H3} g.ts`,
      '? h.ts',
      '! i.log',
    ),
  );

  it('counts staged, unstaged, untracked and conflicted paths', () => {
    expect(countChanges(status)).toEqual({
      staged: 3,
      unstaged: 4,
      untracked: 1,
      conflicted: 1,
      total: 8,
    });
  });

  it('describes the counts', () => {
    expect(describeStatus(status)).toBe('3 staged, 4 modified, 1 untracked, 1 conflicted');
    const simple = parsePorcelainV2(
      porcelain(ordinary('M.', 'a'), ordinary('A.', 'b'), ordinary('.M', 'c'), '? d'),
    );
    expect(describeStatus(simple)).toBe('2 staged, 1 modified, 1 untracked');
  });

  it('is clean when only ignored files are present', () => {
    const clean = parsePorcelainV2(porcelain('# branch.head main', '! dist/'));
    expect(countChanges(clean).total).toBe(0);
    expect(describeStatus(clean)).toBe('clean');
  });
});

describe('getGitStatus', () => {
  it('reports staged, unstaged, renamed, untracked and unicode paths; skips ignored', async () => {
    const repo = makeGitRepo({
      'a.txt': 'a\n',
      'b.txt': 'b\n',
      'old name.txt': 'rename me\n'.repeat(5),
      'del.txt': 'delete me\n',
      '.gitignore': '*.log\n',
    });
    await withRepo(repo, async (dir) => {
      writeFiles(dir, {
        'a.txt': 'a2\n',
        'b.txt': 'b2\n',
        'ünïcode file.txt': 'u\n',
        'newdir/x.ts': 'x\n',
        'debug.log': 'ignored\n',
      });
      git(dir, 'add', 'a.txt');
      git(dir, 'mv', 'old name.txt', 'new näme.txt');
      rmSync(path.join(dir, 'del.txt'));

      const status = await getGitStatus(dir);
      expect(status).toMatchObject({
        branch: 'main',
        detached: false,
        head: git(dir, 'rev-parse', 'HEAD').trim(),
        upstream: null,
      });
      expect(sortedFiles(status)).toEqual([
        { path: 'a.txt', index: 'modified', worktree: 'unmodified' },
        { path: 'b.txt', index: 'unmodified', worktree: 'modified' },
        { path: 'del.txt', index: 'unmodified', worktree: 'deleted' },
        {
          path: 'new näme.txt',
          origPath: 'old name.txt',
          index: 'renamed',
          worktree: 'unmodified',
        },
        { path: 'newdir/', index: 'untracked', worktree: 'untracked' },
        { path: 'ünïcode file.txt', index: 'untracked', worktree: 'untracked' },
      ]);
      expect(describeStatus(status)).toBe('2 staged, 2 modified, 2 untracked');
    });
  });

  it('reports a repository without commits', async () => {
    await withRepo(makeGitRepo({ 'a.txt': 'a\n' }, { commit: false }), async (dir) => {
      git(dir, 'add', 'a.txt');
      const status = await getGitStatus(dir);
      expect(status).toMatchObject({ branch: 'main', head: null, detached: false });
      expect(status.files).toEqual([{ path: 'a.txt', index: 'added', worktree: 'unmodified' }]);
    });
  });

  it('reports a detached HEAD', async () => {
    await withRepo(makeGitRepo(), async (dir) => {
      git(dir, 'checkout', '-q', '--detach');
      const status = await getGitStatus(dir);
      expect(status).toMatchObject({ branch: null, detached: true });
      expect(status.head).toBe(git(dir, 'rev-parse', 'HEAD').trim());
    });
  });

  it('reports merge conflicts by kind', async () => {
    const repo = makeGitRepo({ 'both.txt': 'base\n', 'theirs-deleted.txt': 'base\n' });
    await withRepo(repo, async (dir) => {
      git(dir, 'checkout', '-q', '-b', 'feature');
      writeFiles(dir, { 'both.txt': 'feature\n', 'added.txt': 'feature\n' });
      rmSync(path.join(dir, 'theirs-deleted.txt'));
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'feature');
      git(dir, 'checkout', '-q', 'main');
      writeFiles(dir, {
        'both.txt': 'main\n',
        'added.txt': 'main\n',
        'theirs-deleted.txt': 'changed on main\n',
      });
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'main');
      expect(() => git(dir, 'merge', '-q', 'feature')).toThrow();

      const status = await getGitStatus(dir);
      expect(sortedFiles(status)).toEqual([
        { path: 'added.txt', index: 'unmerged', worktree: 'unmerged', conflict: 'both-added' },
        { path: 'both.txt', index: 'unmerged', worktree: 'unmerged', conflict: 'both-modified' },
        {
          path: 'theirs-deleted.txt',
          index: 'unmerged',
          worktree: 'unmerged',
          conflict: 'deleted-by-them',
        },
      ]);
      expect(countChanges(status)).toMatchObject({ conflicted: 3, staged: 0, unstaged: 0 });
    });
  });

  it('reports upstream tracking with ahead/behind counts', async () => {
    const origin = makeGitRepo({ 'a.txt': 'a\n' });
    const clone = makeTempDir('patch-clone-');
    try {
      const dir = path.join(clone.dir, 'work');
      git(clone.dir, 'clone', '-q', origin.dir, dir);
      writeFiles(dir, { 'mine.txt': 'mine\n' });
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'local');
      writeFiles(origin.dir, { 'theirs.txt': 'theirs\n' });
      git(origin.dir, 'add', '-A');
      git(origin.dir, 'commit', '-q', '-m', 'remote');
      git(dir, 'fetch', '-q');

      const status = await getGitStatus(dir);
      expect(status).toMatchObject({
        branch: 'main',
        upstream: 'origin/main',
        ahead: 1,
        behind: 1,
      });
      expect(status.upstreamGone).toBeUndefined();
    } finally {
      clone.cleanup();
      origin.cleanup();
    }
  });

  it('throws a GitCommandError outside a repository', async () => {
    const temp = makeTempDir();
    try {
      const original = process.env.GIT_CEILING_DIRECTORIES;
      process.env.GIT_CEILING_DIRECTORIES = path.dirname(temp.dir);
      try {
        await expect(getGitStatus(temp.dir)).rejects.toThrow(/git status failed: not a git/i);
      } finally {
        if (original === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
        else process.env.GIT_CEILING_DIRECTORIES = original;
      }
    } finally {
      temp.cleanup();
    }
  });
});

describe('getFileGitStatus', () => {
  it('returns the status of a changed file and null for a clean one', async () => {
    await withRepo(makeGitRepo({ 'a.txt': 'a\n', 'src/b.ts': 'b\n' }), async (dir) => {
      writeFileSync(path.join(dir, 'src', 'b.ts'), 'b2\n');
      expect(await getFileGitStatus(dir, path.join(dir, 'src', 'b.ts'))).toEqual({
        path: 'src/b.ts',
        index: 'unmodified',
        worktree: 'modified',
      });
      expect(await getFileGitStatus(dir, path.join(dir, 'a.txt'))).toBeNull();
    });
  });

  it('reports untracked files, including inside untracked directories', async () => {
    await withRepo(makeGitRepo(), async (dir) => {
      writeFiles(dir, { 'new dir/x y.ts': 'x\n', 'top.txt': 't\n' });
      expect(await getFileGitStatus(dir, path.join(dir, 'new dir', 'x y.ts'))).toEqual({
        path: 'new dir/x y.ts',
        index: 'untracked',
        worktree: 'untracked',
      });
      expect(await getFileGitStatus(dir, path.join(dir, 'top.txt'))).toMatchObject({
        index: 'untracked',
      });
    });
  });

  it('returns null for ignored files, the root itself, and paths outside the repository', async () => {
    await withRepo(makeGitRepo({ '.gitignore': '*.log\n' }), async (dir) => {
      writeFiles(dir, { 'debug.log': 'x\n' });
      expect(await getFileGitStatus(dir, path.join(dir, 'debug.log'))).toBeNull();
      expect(await getFileGitStatus(dir, dir)).toBeNull();
      expect(await getFileGitStatus(dir, path.join(path.dirname(dir), 'elsewhere.txt'))).toBeNull();
    });
  });

  it('matches glob characters in file names literally', async () => {
    await withRepo(makeGitRepo({ 'app/[id].ts': 'id\n', 'app/i.ts': 'i\n' }), async (dir) => {
      writeFileSync(path.join(dir, 'app', 'i.ts'), 'changed\n');
      expect(await getFileGitStatus(dir, path.join(dir, 'app', '[id].ts'))).toBeNull();
      writeFileSync(path.join(dir, 'app', '[id].ts'), 'changed\n');
      expect(await getFileGitStatus(dir, path.join(dir, 'app', '[id].ts'))).toMatchObject({
        path: 'app/[id].ts',
        worktree: 'modified',
      });
    });
  });

  it('reports a staged rename under its new path', async () => {
    await withRepo(makeGitRepo({ 'old.ts': 'content\n' }), async (dir) => {
      git(dir, 'mv', 'old.ts', 'new.ts');
      const status = await getFileGitStatus(dir, path.join(dir, 'new.ts'));
      expect(status?.path).toBe('new.ts');
      expect(['added', 'renamed']).toContain(status?.index);
    });
  });

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')(
    'matches paths case-insensitively where the file system does',
    async () => {
      await withRepo(makeGitRepo({ 'Src/Main.ts': 'm\n' }), async (dir) => {
        writeFileSync(path.join(dir, 'Src', 'Main.ts'), 'changed\n');
        expect(await getFileGitStatus(dir, path.join(dir, 'src', 'main.ts'))).toMatchObject({
          path: 'Src/Main.ts',
          worktree: 'modified',
        });
      });
    },
  );
});
