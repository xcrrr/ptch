import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getDiffNumstat,
  getGitDiff,
  getGitLog,
  parseGitLog,
  parseNumstat,
} from '../../src/git/history.js';
import { git, makeGitRepo, writeFiles } from '../../src/testing/index.js';
import { useIsolatedGitConfig, withRepo } from './git-env.js';

useIsolatedGitConfig();

/** A repo with one staged change (staged.txt) and one unstaged change (unstaged.txt). */
function makeChangedRepo() {
  const repo = makeGitRepo({
    'staged.txt': 'one\ntwo\n',
    'unstaged.txt': 'alpha\nbeta\n',
    'clean.txt': 'clean\n',
  });
  writeFiles(repo.dir, { 'staged.txt': 'one\nTWO\nthree\n', 'unstaged.txt': 'alpha\n' });
  git(repo.dir, 'add', 'staged.txt');
  return repo;
}

function filesInDiff(diff: string): string[] {
  return [...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]!);
}

describe('getGitDiff', () => {
  it('limits each scope to the right side of the index', async () => {
    await withRepo(makeChangedRepo(), async (dir) => {
      const unstaged = await getGitDiff(dir, { scope: 'unstaged' });
      const staged = await getGitDiff(dir, { scope: 'staged' });
      const all = await getGitDiff(dir, { scope: 'all' });
      expect(filesInDiff(unstaged)).toEqual(['unstaged.txt']);
      expect(unstaged).toContain('-beta');
      expect(filesInDiff(staged)).toEqual(['staged.txt']);
      expect(staged).toContain('+TWO');
      expect(filesInDiff(all)).toEqual(['staged.txt', 'unstaged.txt']);
    });
  });

  it('includes changes that are both staged and modified again when scope is all', async () => {
    await withRepo(makeChangedRepo(), async (dir) => {
      writeFileSync(path.join(dir, 'staged.txt'), 'one\nTWO\nthree\nfour\n');
      const all = await getGitDiff(dir, { scope: 'all' });
      expect(all).toContain('+TWO');
      expect(all).toContain('+four');
    });
  });

  it('limits the diff to absolute or root-relative paths', async () => {
    await withRepo(makeChangedRepo(), async (dir) => {
      const absolute = await getGitDiff(dir, {
        scope: 'all',
        paths: [path.join(dir, 'unstaged.txt')],
      });
      expect(filesInDiff(absolute)).toEqual(['unstaged.txt']);
      const relative = await getGitDiff(dir, { scope: 'all', paths: ['staged.txt'] });
      expect(filesInDiff(relative)).toEqual(['staged.txt']);
      expect(await getGitDiff(dir, { scope: 'all', paths: ['clean.txt'] })).toBe('');
    });
  });

  it('treats glob characters in paths literally', async () => {
    await withRepo(makeGitRepo({ 'app/[id].ts': 'id\n', 'app/i.ts': 'i\n' }), async (dir) => {
      writeFileSync(path.join(dir, 'app', 'i.ts'), 'changed\n');
      expect(await getGitDiff(dir, { scope: 'all', paths: ['app/[id].ts'] })).toBe('');
    });
  });

  it('rejects paths outside the repository', async () => {
    await withRepo(makeChangedRepo(), async (dir) => {
      await expect(
        getGitDiff(dir, { scope: 'all', paths: [path.join(path.dirname(dir), 'x.txt')] }),
      ).rejects.toThrow(/outside the Git repository/);
    });
  });

  it('returns --stat output when requested', async () => {
    await withRepo(makeChangedRepo(), async (dir) => {
      const stat = await getGitDiff(dir, { scope: 'all', stat: true });
      expect(stat).toMatch(/staged\.txt\s+\|\s+3 \+\+-/);
      expect(stat).toMatch(/unstaged\.txt\s+\|\s+1 -/);
      expect(stat).toContain('2 files changed, 2 insertions(+), 2 deletions(-)');
      expect(stat).not.toContain('diff --git');
    });
  });

  it('ignores color, external diff and textconv configuration', async () => {
    await withRepo(makeChangedRepo(), async (dir) => {
      git(dir, 'config', 'color.ui', 'always');
      git(dir, 'config', 'diff.external', 'patch-no-such-diff-tool');
      writeFiles(dir, { '.gitattributes': '*.txt diff=upper\n' });
      git(dir, 'config', 'diff.upper.textconv', 'patch-no-such-textconv');
      const diff = await getGitDiff(dir, { scope: 'unstaged' });
      expect(diff).toContain('-beta');
      expect(diff).not.toContain('\u001b[');
    });
  });

  it('prints unicode and spaced paths unquoted', async () => {
    await withRepo(makeGitRepo({ 'dir ü/file ö.txt': 'a\n' }), async (dir) => {
      writeFileSync(path.join(dir, 'dir ü', 'file ö.txt'), 'b\n');
      const diff = await getGitDiff(dir, { scope: 'unstaged' });
      expect(diff).toContain('diff --git a/dir ü/file ö.txt b/dir ü/file ö.txt');
    });
  });

  describe('in a repository without commits', () => {
    function makeUnbornRepo() {
      const repo = makeGitRepo({ 'a.txt': 'first\n', 'b.txt': 'bee\n' }, { commit: false });
      git(repo.dir, 'add', 'a.txt', 'b.txt');
      writeFileSync(path.join(repo.dir, 'a.txt'), 'first\nsecond\n');
      return repo;
    }

    it('shows staged changes followed by unstaged ones for scope all', async () => {
      await withRepo(makeUnbornRepo(), async (dir) => {
        const all = await getGitDiff(dir, { scope: 'all' });
        const staged = await getGitDiff(dir, { scope: 'staged' });
        const unstaged = await getGitDiff(dir, { scope: 'unstaged' });
        expect(staged).toContain('new file mode');
        expect(filesInDiff(staged)).toEqual(['a.txt', 'b.txt']);
        expect(filesInDiff(unstaged)).toEqual(['a.txt']);
        expect(all).toBe(staged + unstaged);
      });
    });

    it('supports --stat for scope all', async () => {
      await withRepo(makeUnbornRepo(), async (dir) => {
        const stat = await getGitDiff(dir, { scope: 'all', stat: true });
        expect(stat).toContain('2 files changed, 2 insertions(+)');
        expect(stat).toContain('1 file changed, 1 insertion(+)');
      });
    });
  });
});

describe('parseNumstat', () => {
  it('parses counts, binary files, renames and unusual names', () => {
    const output = [
      '3\t1\tsrc/a.ts',
      '-\t-\timg/logo.png',
      '2\t0\t',
      'old name.ts',
      'new näme.ts',
      '1\t1\ttab\tname.txt',
      '',
    ].join('\0');
    expect(parseNumstat(output)).toEqual([
      { path: 'src/a.ts', added: 3, removed: 1, binary: false },
      { path: 'img/logo.png', added: 0, removed: 0, binary: true },
      { path: 'new näme.ts', added: 2, removed: 0, binary: false },
      { path: 'tab\tname.txt', added: 1, removed: 1, binary: false },
    ]);
    expect(parseNumstat('')).toEqual([]);
  });
});

describe('getDiffNumstat', () => {
  it('counts lines per file for each scope', async () => {
    await withRepo(makeChangedRepo(), async (dir) => {
      expect(await getDiffNumstat(dir, 'staged')).toEqual([
        { path: 'staged.txt', added: 2, removed: 1, binary: false },
      ]);
      expect(await getDiffNumstat(dir, 'unstaged')).toEqual([
        { path: 'unstaged.txt', added: 0, removed: 1, binary: false },
      ]);
      expect(await getDiffNumstat(dir, 'all')).toHaveLength(2);
      expect(await getDiffNumstat(dir, 'all', undefined, ['unstaged.txt'])).toEqual([
        { path: 'unstaged.txt', added: 0, removed: 1, binary: false },
      ]);
    });
  });

  it('reports binary files and staged renames', async () => {
    const repo = makeGitRepo({
      'logo.bin': '\u0000\u0001bin',
      'old name.txt': 'line\n'.repeat(10),
    });
    await withRepo(repo, async (dir) => {
      writeFileSync(path.join(dir, 'logo.bin'), '\u0000\u0002bin');
      git(dir, 'mv', 'old name.txt', 'new name.txt');
      writeFileSync(path.join(dir, 'new name.txt'), `${'line\n'.repeat(10)}extra\n`);
      git(dir, 'add', '-A');
      const stats = await getDiffNumstat(dir, 'staged');
      expect(stats).toEqual(
        expect.arrayContaining([
          { path: 'logo.bin', added: 0, removed: 0, binary: true },
          { path: 'new name.txt', added: 1, removed: 0, binary: false },
        ]),
      );
      expect(stats).toHaveLength(2);
    });
  });

  it('sums staged and unstaged counts in a repository without commits', async () => {
    await withRepo(makeGitRepo({ 'a.txt': 'one\ntwo\n' }, { commit: false }), async (dir) => {
      git(dir, 'add', 'a.txt');
      writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
      writeFiles(dir, { 'b.txt': 'b\n' });
      git(dir, 'add', 'b.txt');
      const stats = await getDiffNumstat(dir, 'all');
      expect(stats).toEqual([
        { path: 'a.txt', added: 3, removed: 0, binary: false },
        { path: 'b.txt', added: 1, removed: 0, binary: false },
      ]);
    });
  });
});

describe('parseGitLog', () => {
  it('splits fields and keeps separators inside subjects', () => {
    const output =
      'abc1234\x1f2024-01-02\x1fAda Lovelace\x1ffix: a\x1fb\ndef5678\x1f2024-01-01\x1fBob\x1finit';
    expect(parseGitLog(output)).toEqual([
      { sha: 'abc1234', date: '2024-01-02', author: 'Ada Lovelace', subject: 'fix: a\x1fb' },
      { sha: 'def5678', date: '2024-01-01', author: 'Bob', subject: 'init' },
    ]);
    expect(parseGitLog('')).toEqual([]);
    expect(parseGitLog('garbage line')).toEqual([]);
  });
});

describe('getGitLog', () => {
  function commit(dir: string, message: string, options: string[] = []): void {
    git(dir, 'commit', '-q', '--allow-empty', '-m', message, ...options);
  }

  it('returns recent commits newest first with short sha, date, author and subject', async () => {
    await withRepo(makeGitRepo(), async (dir) => {
      commit(dir, 'feat: ünïcode — subject', [
        '--author=Ada Lovelace <ada@example.com>',
        '--date=2024-01-15T12:00:00',
      ]);
      const log = await getGitLog(dir);
      expect(log).toHaveLength(2);
      expect(log[0]).toEqual({
        sha: git(dir, 'rev-parse', '--short', 'HEAD').trim(),
        date: '2024-01-15',
        author: 'Ada Lovelace',
        subject: 'feat: ünïcode — subject',
      });
      expect(log[1]).toMatchObject({ author: 'Patch Test', subject: 'initial commit' });
      expect(log[1]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  it('defaults to 10 commits and clamps the limit to 1..100', async () => {
    await withRepo(makeGitRepo(), async (dir) => {
      for (let i = 1; i <= 11; i++) commit(dir, `commit ${i}`);
      expect(await getGitLog(dir)).toHaveLength(10);
      expect((await getGitLog(dir, { limit: 3 })).map((c) => c.subject)).toEqual([
        'commit 11',
        'commit 10',
        'commit 9',
      ]);
      expect(await getGitLog(dir, { limit: -5 })).toHaveLength(1);
      expect(await getGitLog(dir, { limit: 500 })).toHaveLength(12);
    });
  });

  it('limits commits to a path, literally', async () => {
    await withRepo(makeGitRepo({ 'a.txt': 'a\n', 'app/[id].ts': 'x\n' }), async (dir) => {
      writeFiles(dir, { 'b.txt': 'b\n' });
      git(dir, 'add', 'b.txt');
      commit(dir, 'add b');
      writeFiles(dir, { 'app/i.ts': 'i\n' });
      git(dir, 'add', '-A');
      commit(dir, 'add i');
      expect((await getGitLog(dir, { path: 'b.txt' })).map((c) => c.subject)).toEqual(['add b']);
      expect(
        (await getGitLog(dir, { path: path.join(dir, 'app', '[id].ts') })).map((c) => c.subject),
      ).toEqual(['initial commit']);
      expect(await getGitLog(dir, { path: 'missing.txt' })).toEqual([]);
    });
  });

  it('returns [] for a repository without commits', async () => {
    await withRepo(makeGitRepo({}, { commit: false }), async (dir) => {
      expect(await getGitLog(dir)).toEqual([]);
    });
  });

  it('rejects paths outside the repository', async () => {
    await withRepo(makeGitRepo(), async (dir) => {
      await expect(
        getGitLog(dir, { path: path.join(path.dirname(dir), 'outside.txt') }),
      ).rejects.toThrow(/outside the Git repository/);
    });
  });
});
