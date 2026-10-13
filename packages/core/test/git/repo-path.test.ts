import { describe, expect, it } from 'vitest';
import {
  literalPathspec,
  nativePathFromGit,
  relativeInside,
  repoRelativePath,
  toPosixPath,
} from '../../src/git/repo-path.js';

describe('nativePathFromGit', () => {
  it('converts Git for Windows output to a native path', () => {
    expect(nativePathFromGit('C:/Users/dev/repo\n', 'win32')).toBe('C:\\Users\\dev\\repo');
  });

  it('converts MSYS and Cygwin drive paths on Windows', () => {
    expect(nativePathFromGit('/c/work/repo\n', 'win32')).toBe('C:\\work\\repo');
    expect(nativePathFromGit('/cygdrive/d/src/app', 'win32')).toBe('D:\\src\\app');
    expect(nativePathFromGit('/c', 'win32')).toBe('C:\\');
  });

  it('keeps UNC paths', () => {
    expect(nativePathFromGit('//server/share/repo\n', 'win32')).toBe('\\\\server\\share\\repo');
  });

  it('only strips the trailing newline on POSIX (names may end in spaces)', () => {
    expect(nativePathFromGit('/home/dev/my repo \n', 'linux')).toBe('/home/dev/my repo ');
    expect(nativePathFromGit('/Users/dev/repo\r\n', 'darwin')).toBe('/Users/dev/repo');
  });
});

describe('relativeInside', () => {
  it('returns the relative path for children and "" for the directory itself', () => {
    expect(relativeInside('/repo', '/repo/src/a.ts', 'linux')).toBe('src/a.ts');
    expect(relativeInside('/repo', '/repo', 'linux')).toBe('');
    expect(relativeInside('/repo/', '/repo/x', 'linux')).toBe('x');
  });

  it('rejects siblings that share a prefix and parents', () => {
    expect(relativeInside('/repo', '/repository/a.ts', 'linux')).toBeUndefined();
    expect(relativeInside('/repo/sub', '/repo', 'linux')).toBeUndefined();
  });

  it('compares case-insensitively on Windows and macOS only', () => {
    expect(relativeInside('C:\\Repo', 'c:\\repo\\Src\\A.ts', 'win32')).toBe('Src\\A.ts');
    expect(relativeInside('/Users/Dev/Repo', '/users/dev/repo/a.ts', 'darwin')).toBe('a.ts');
    expect(relativeInside('/home/Dev', '/home/dev/a.ts', 'linux')).toBeUndefined();
  });

  it('handles drive roots on Windows', () => {
    expect(relativeInside('C:\\', 'C:\\a\\b', 'win32')).toBe('a\\b');
    expect(relativeInside('C:\\a', 'D:\\a\\b', 'win32')).toBeUndefined();
  });
});

describe('repoRelativePath', () => {
  it('accepts absolute and root-relative paths and returns forward slashes', () => {
    expect(repoRelativePath('C:\\repo', 'C:\\repo\\src\\a.ts', 'win32')).toBe('src/a.ts');
    expect(repoRelativePath('C:\\repo', 'src\\b.ts', 'win32')).toBe('src/b.ts');
    expect(repoRelativePath('/repo', './src/../lib/c.ts', 'linux')).toBe('lib/c.ts');
  });

  it('throws for paths outside the repository', () => {
    expect(() => repoRelativePath('/repo', '../other/a.ts', 'linux')).toThrow(/outside the Git/);
    expect(() => repoRelativePath('/repo', '/etc/passwd', 'linux')).toThrow(/outside the Git/);
  });
});

describe('literalPathspec', () => {
  it('disables glob matching and folds case where the file system does', () => {
    expect(literalPathspec('app/[id].tsx', 'linux')).toBe(':(literal)app/[id].tsx');
    expect(literalPathspec('src/a.ts', 'win32')).toBe(':(literal,icase)src/a.ts');
    expect(literalPathspec('', 'linux')).toBe(':(literal).');
  });
});

describe('toPosixPath', () => {
  it('converts separators on Windows only', () => {
    expect(toPosixPath('a\\b\\c', 'win32')).toBe('a/b/c');
    expect(toPosixPath('a\\b', 'linux')).toBe('a\\b');
  });
});
