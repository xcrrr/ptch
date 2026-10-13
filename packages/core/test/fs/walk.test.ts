import { mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { AbortError } from '@patch/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findRipgrep,
  GitignoreFilter,
  isDefaultIgnoredDir,
  walkFiles,
  type WalkOptions,
} from '../../src/fs/walk.js';
import { makeTempDir, writeFiles } from '../../src/testing/index.js';

async function walk(options: WalkOptions): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of walkFiles(options)) files.push(entry.relative);
  return files;
}

describe('walkFiles', () => {
  let temp: { dir: string; cleanup: () => void };

  beforeEach(() => {
    temp = makeTempDir();
  });

  afterEach(() => temp.cleanup());

  it('yields files depth-first in name order with forward-slash relative paths', async () => {
    writeFiles(temp.dir, {
      'b.txt': '',
      'a/z.txt': '',
      'a/m/n.txt': '',
      'a/b.txt': '',
      'c/d.txt': '',
      '.hidden': '',
    });
    expect(await walk({ root: temp.dir })).toEqual([
      '.hidden',
      'a/b.txt',
      'a/m/n.txt',
      'a/z.txt',
      'b.txt',
      'c/d.txt',
    ]);
    const first = await walkFiles({ root: temp.dir }).next();
    expect(first.value).toEqual({
      absolute: path.join(temp.dir, '.hidden'),
      relative: '.hidden',
      isDirectory: false,
    });
  });

  it('never enters default ignored directories', async () => {
    writeFiles(temp.dir, {
      'src/a.ts': '',
      'node_modules/pkg/index.js': '',
      'src/node_modules/x.js': '',
      '.git/config': '',
      'dist/out.js': '',
      '__pycache__/m.pyc': '',
    });
    expect(await walk({ root: temp.dir })).toEqual(['src/a.ts']);
  });

  it('respects root and nested .gitignore files, including negations', async () => {
    writeFiles(temp.dir, {
      '.gitignore': '*.log\nsecret/\n!keep.log\n',
      'app.log': '',
      'keep.log': '',
      'secret/a.txt': '',
      'src/.gitignore': 'generated.ts\n/local-only.ts\n',
      'src/generated.ts': '',
      'src/local-only.ts': '',
      'src/deep/local-only.ts': '',
      'src/deep/generated.ts': '',
      'src/main.ts': '',
    });
    expect(await walk({ root: temp.dir })).toEqual([
      '.gitignore',
      'keep.log',
      'src/.gitignore',
      'src/deep/local-only.ts',
      'src/main.ts',
    ]);
    expect(await walk({ root: temp.dir, respectGitignore: false })).toContain('app.log');
  });

  it('applies .gitignore files of parent directories inside a repository', async () => {
    writeFiles(temp.dir, {
      '.gitignore': '*.tmp\npackages/core/generated/\n',
      'packages/core/a.ts': '',
      'packages/core/b.tmp': '',
      'packages/core/generated/x.ts': '',
    });
    mkdirSync(path.join(temp.dir, '.git'));
    expect(await walk({ root: path.join(temp.dir, 'packages', 'core') })).toEqual(['a.ts']);
  });

  it('applies .git/info/exclude', async () => {
    writeFiles(temp.dir, { '.git/info/exclude': 'private.txt\n', 'private.txt': '', 'a.txt': '' });
    expect(await walk({ root: temp.dir })).toEqual(['a.txt']);
  });

  it('searches a root that a parent .gitignore ignores, since it was asked for explicitly', async () => {
    writeFiles(temp.dir, { '.gitignore': 'vendor/\n', 'vendor/lib/a.js': '' });
    mkdirSync(path.join(temp.dir, '.git'));
    expect(await walk({ root: path.join(temp.dir, 'vendor') })).toEqual(['lib/a.js']);
  });

  it('can skip hidden files and stop after maxFiles', async () => {
    writeFiles(temp.dir, { '.env': '', '.config/x': '', 'a.txt': '', 'b.txt': '', 'c.txt': '' });
    expect(await walk({ root: temp.dir, includeHidden: false })).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
    ]);
    expect(await walk({ root: temp.dir, maxFiles: 2 })).toEqual(['.config/x', '.env']);
    expect(await walk({ root: temp.dir, maxFiles: 0 })).toEqual([]);
  });

  it('yields a file root as the only entry and nothing for a missing root', async () => {
    writeFiles(temp.dir, { 'one.txt': '' });
    expect(await walk({ root: path.join(temp.dir, 'one.txt') })).toEqual(['one.txt']);
    expect(await walk({ root: path.join(temp.dir, 'missing') })).toEqual([]);
  });

  it('does not follow symbolic links', async () => {
    writeFiles(temp.dir, { 'real/a.txt': '', 'outside/b.txt': '' });
    symlinkSync(
      path.join(temp.dir, 'outside'),
      path.join(temp.dir, 'real', 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(await walk({ root: path.join(temp.dir, 'real') })).toEqual(['a.txt']);
  });

  it('stops with an AbortError when the signal fires', async () => {
    writeFiles(temp.dir, { 'a/1.txt': '', 'a/2.txt': '', 'b/3.txt': '' });
    const controller = new AbortController();
    const seen: string[] = [];
    const run = async () => {
      for await (const entry of walkFiles({ root: temp.dir, signal: controller.signal })) {
        seen.push(entry.relative);
        controller.abort();
      }
    };
    await expect(run()).rejects.toBeInstanceOf(AbortError);
    expect(seen).toEqual(['a/1.txt']);
  });
});

describe('GitignoreFilter', () => {
  let temp: { dir: string; cleanup: () => void };

  beforeEach(() => {
    temp = makeTempDir();
  });

  afterEach(() => temp.cleanup());

  it('checks arbitrary paths, including ignored ancestor directories', async () => {
    writeFiles(temp.dir, {
      '.gitignore': 'build/\n*.log\n',
      'src/.gitignore': '!important.log\n',
    });
    const filter = await GitignoreFilter.create(temp.dir);
    expect(await filter.ignores('build/out/app.js', false)).toBe(true);
    expect(await filter.ignores('src/app.log', false)).toBe(true);
    expect(await filter.ignores('src/important.log', false)).toBe(false);
    expect(await filter.ignores('src/main.ts', false)).toBe(false);
    expect(await filter.ignores('build', true)).toBe(true);
  });
});

describe('isDefaultIgnoredDir', () => {
  it('matches exact names, ignoring case on Windows and macOS', () => {
    expect(isDefaultIgnoredDir('node_modules', 'linux')).toBe(true);
    expect(isDefaultIgnoredDir('Node_Modules', 'linux')).toBe(false);
    expect(isDefaultIgnoredDir('Node_Modules', 'win32')).toBe(true);
    expect(isDefaultIgnoredDir('src', 'win32')).toBe(false);
  });
});

describe('findRipgrep', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is disabled by PATCH_NO_RG, checked on every call', async () => {
    vi.stubEnv('PATCH_NO_RG', '1');
    expect(await findRipgrep()).toBeNull();
    vi.stubEnv('PATCH_NO_RG', '');
    const found = await findRipgrep();
    expect(found === null || path.isAbsolute(found)).toBe(true);
  });

  it('only accepts binaries that identify as ripgrep', async () => {
    const empty = makeTempDir();
    try {
      vi.stubEnv('PATCH_NO_RG', '');
      vi.stubEnv('PATCH_RG_PATH', process.execPath);
      vi.stubEnv('PATH', empty.dir);
      expect(await findRipgrep()).toBeNull();
    } finally {
      empty.cleanup();
    }
  });
});
