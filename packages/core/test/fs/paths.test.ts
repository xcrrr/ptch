import { mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPathInside, PathPolicy, sensitivePathReason } from '../../src/fs/paths.js';
import { makeTempDir, writeFiles } from '../../src/testing/index.js';
import { ToolError } from '../../src/tools/types.js';

/** Creates a directory symlink (a junction on Windows, which needs no privileges). */
function linkDirectory(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** File symlinks need Developer Mode or admin rights on Windows; returns false when refused. */
function tryLinkFile(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, 'file');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}

describe('PathPolicy on the host file system', () => {
  let temp: { dir: string; cleanup: () => void };
  let project: string;
  let home: string;
  let policy: PathPolicy;

  beforeEach(() => {
    temp = makeTempDir();
    project = path.join(temp.dir, 'project');
    home = path.join(temp.dir, 'home');
    writeFiles(project, { 'src/a.ts': 'export {};\n', 'README.md': '# hi\n' });
    writeFiles(home, { 'notes.txt': 'notes\n' });
    writeFiles(temp.dir, { 'outside/secret.txt': 'secret\n' });
    policy = new PathPolicy({ cwd: project, projectRoot: project, home });
  });

  afterEach(() => temp.cleanup());

  it('resolves relative paths against cwd with a forward-slash display', async () => {
    const resolved = await policy.resolve('src/a.ts');
    expect(resolved).toMatchObject({
      input: 'src/a.ts',
      absolute: path.join(project, 'src', 'a.ts'),
      display: 'src/a.ts',
      insideProject: true,
      exists: true,
      isDirectory: false,
      insideGitDir: false,
    });
    expect(resolved.sensitive).toBeUndefined();
  });

  it('displays the working directory itself as "."', async () => {
    const resolved = await policy.resolve('.');
    expect(resolved.display).toBe('.');
    expect(resolved.isDirectory).toBe(true);
    expect((await policy.resolve(project)).display).toBe('.');
  });

  it('normalizes ".." segments and reports traversal out of the project', async () => {
    expect((await policy.resolve('src/../README.md')).display).toBe('README.md');
    const escaped = await policy.resolve('../../../../etc/passwd');
    expect(escaped.insideProject).toBe(false);
    expect(path.isAbsolute(escaped.absolute)).toBe(true);
    expect(escaped.display).toBe(escaped.absolute);
  });

  it('treats absolute paths by containment, not by how they were written', async () => {
    const inside = await policy.resolve(path.join(project, 'src', 'a.ts'));
    expect(inside.insideProject).toBe(true);
    expect(inside.display).toBe('src/a.ts');

    const outside = await policy.resolve(path.join(temp.dir, 'outside', 'secret.txt'));
    expect(outside.insideProject).toBe(false);
    expect(outside.exists).toBe(true);
    expect(outside.display).toBe(path.join(temp.dir, 'outside', 'secret.txt'));

    // A sibling whose name starts with the project's name is not inside it.
    const sibling = await policy.resolve(`${project}-other${path.sep}x.txt`);
    expect(sibling.insideProject).toBe(false);
  });

  it('expands "~" to the home directory and displays home paths with "~"', async () => {
    const notes = await policy.resolve('~/notes.txt');
    expect(notes.absolute).toBe(path.join(home, 'notes.txt'));
    expect(notes.exists).toBe(true);
    expect(notes.insideProject).toBe(false);
    expect(notes.display).toBe(`~${path.sep}notes.txt`);
    expect((await policy.resolve('~')).display).toBe('~');
    // "~user" is not expanded: it is an ordinary relative name.
    expect((await policy.resolve('~other/x')).absolute).toBe(path.join(project, '~other', 'x'));
  });

  it('reports existence and directories, and resolves paths that do not exist yet', async () => {
    const dir = await policy.resolve('src');
    expect(dir).toMatchObject({ exists: true, isDirectory: true, display: 'src' });
    const missing = await policy.resolve('src/new/file.ts');
    expect(missing).toMatchObject({
      exists: false,
      isDirectory: false,
      insideProject: true,
      display: 'src/new/file.ts',
    });
  });

  it('rejects empty paths and NUL bytes with a ToolError', async () => {
    await expect(policy.resolve('')).rejects.toBeInstanceOf(ToolError);
    await expect(policy.resolve('   ')).rejects.toThrow('Path must not be empty.');
    await expect(policy.resolve('src/a.ts\0.png')).rejects.toThrow(/NUL byte/);
  });

  it('flags paths inside .git, including nested repositories', async () => {
    mkdirSync(path.join(project, '.git'));
    expect((await policy.resolve('.git/config')).insideGitDir).toBe(true);
    expect((await policy.resolve('.git')).insideGitDir).toBe(true);
    expect((await policy.resolve('vendor/lib/.git/hooks/pre-commit')).insideGitDir).toBe(true);
    expect((await policy.resolve('.github/workflows/ci.yml')).insideGitDir).toBe(false);
    expect((await policy.resolve('src/a.ts')).insideGitDir).toBe(false);
  });

  it('marks sensitive files', async () => {
    writeFiles(project, { '.env': 'TOKEN=1\n', '.env.example': 'TOKEN=\n' });
    expect((await policy.resolve('.env')).sensitive).toMatch(/secrets/);
    expect((await policy.resolve('.env.example')).sensitive).toBeUndefined();
  });

  it('displays project paths relative to a cwd below the project root', async () => {
    const nested = new PathPolicy({ cwd: path.join(project, 'src'), projectRoot: project, home });
    const readme = await nested.resolve('../README.md');
    expect(readme.insideProject).toBe(true);
    expect(readme.display).toBe('../README.md');
    expect((await nested.resolve('a.ts')).display).toBe('a.ts');
  });

  it('reports a symlinked directory pointing outside the project as outside', async () => {
    linkDirectory(path.join(temp.dir, 'outside'), path.join(project, 'escape'));
    const viaLink = await policy.resolve('escape/secret.txt');
    expect(viaLink.insideProject).toBe(false);
    expect(viaLink.exists).toBe(true);
    expect(viaLink.absolute).toBe(path.join(temp.dir, 'outside', 'secret.txt'));
    // Files that do not exist yet behind the link resolve outside too (a write would land there).
    const newFile = await policy.resolve('escape/new.txt');
    expect(newFile.insideProject).toBe(false);
    expect(newFile.exists).toBe(false);
  });

  it('follows dangling symlinks to where a write would land', async (context) => {
    const target = path.join(temp.dir, 'outside', 'created-later.txt');
    if (!tryLinkFile(target, path.join(project, 'dangling'))) {
      context.skip();
    }
    const resolved = await policy.resolve('dangling');
    expect(resolved.exists).toBe(false);
    expect(resolved.absolute).toBe(target);
    expect(resolved.insideProject).toBe(false);
  });

  it('keeps symlinks that stay inside the project inside', async () => {
    linkDirectory(path.join(project, 'src'), path.join(project, 'alias'));
    const resolved = await policy.resolve('alias/a.ts');
    expect(resolved.insideProject).toBe(true);
    expect(resolved.display).toBe('src/a.ts');
  });

  it.runIf(process.platform === 'win32')(
    'accepts Windows separators and drive casing',
    async () => {
      const resolved = await policy.resolve('src\\a.ts');
      expect(resolved.display).toBe('src/a.ts');
      const upper = await policy.resolve(path.join(project, 'SRC', 'A.TS').toUpperCase());
      expect(upper.insideProject).toBe(true);
      expect(upper.exists).toBe(true);
    },
  );
});

describe('PathPolicy path flavors', () => {
  it('handles Windows drive letters, both separators and case-insensitive containment', async () => {
    const policy = new PathPolicy({
      cwd: 'C:\\Users\\me\\proj',
      projectRoot: 'C:\\Users\\me\\proj',
      home: 'C:\\Users\\me',
      platform: 'win32',
    });
    const mixed = await policy.resolve('c:/users/ME/Proj/src\\index.ts');
    expect(mixed.insideProject).toBe(true);
    expect(mixed.display).toBe('src/index.ts');

    const otherDrive = await policy.resolve('D:\\data\\file.txt');
    expect(otherDrive.insideProject).toBe(false);
    expect(otherDrive.display).toBe('D:\\data\\file.txt');

    const homeFile = await policy.resolve('~\\.gitconfig');
    expect(homeFile.insideProject).toBe(false);
    expect(homeFile.display).toBe('~\\.gitconfig');

    const escaped = await policy.resolve('..\\..\\..\\..\\Windows\\System32');
    expect(escaped.insideProject).toBe(false);
  });

  it('refuses network and device paths outside the project on Windows', async () => {
    const policy = new PathPolicy({
      cwd: 'C:\\Users\\me\\proj',
      projectRoot: 'C:\\Users\\me\\proj',
      home: 'C:\\Users\\me',
      platform: 'win32',
    });
    await expect(policy.resolve('\\\\attacker.example\\share\\x.txt')).rejects.toThrow(
      /network or device path/,
    );
    await expect(policy.resolve('//attacker.example/share/x.txt')).rejects.toThrow(ToolError);
    await expect(policy.resolve('\\\\.\\PhysicalDrive0')).rejects.toThrow(ToolError);
    // A project that lives on a share keeps working: containment is decided lexically.
    expect(
      isPathInside('\\\\fileserver\\team\\proj\\a.ts', '\\\\fileserver\\team\\proj', 'win32'),
    ).toBe(true);
  });

  it('converts Git Bash drive paths on Windows', () => {
    const policy = new PathPolicy({
      cwd: 'C:\\Users\\me\\proj',
      projectRoot: 'C:\\Users\\me\\proj',
      home: 'C:\\Users\\me',
      platform: 'win32',
    });
    expect(policy.resolveLexically('/c/Users/me/proj/src/a.ts')).toBe(
      'C:\\Users\\me\\proj\\src\\a.ts',
    );
    expect(policy.resolveLexically('/d')).toBe('D:\\');
  });

  it('is case-sensitive on Linux', async () => {
    const policy = new PathPolicy({
      cwd: '/home/me/proj',
      projectRoot: '/home/me/proj',
      home: '/home/me',
      platform: 'linux',
    });
    expect(policy.isInsideProject('/home/me/proj/src/a.ts')).toBe(true);
    expect(policy.isInsideProject('/home/me/PROJ/src/a.ts')).toBe(false);
    expect(policy.display('/home/me/other/x.ts')).toBe('~/other/x.ts');
    expect(policy.display('/etc/hosts')).toBe('/etc/hosts');
    expect(policy.display('/home/me/proj')).toBe('.');
    expect(policy.resolveLexically('/c/Users')).toBe('/c/Users');
  });

  it('never displays everything as "~" when home is the file system root', () => {
    const policy = new PathPolicy({
      cwd: '/srv/app',
      projectRoot: '/srv/app',
      home: '/',
      platform: 'linux',
    });
    expect(policy.display('/etc/hosts')).toBe('/etc/hosts');
  });
});

describe('isPathInside', () => {
  it('accepts equal paths and descendants only', () => {
    expect(isPathInside('/a/b', '/a/b', 'linux')).toBe(true);
    expect(isPathInside('/a/b/c', '/a/b', 'linux')).toBe(true);
    expect(isPathInside('/a/b/', '/a/b', 'linux')).toBe(true);
    expect(isPathInside('/a/bc', '/a/b', 'linux')).toBe(false);
    expect(isPathInside('/a', '/a/b', 'linux')).toBe(false);
    expect(isPathInside('/anything', '/', 'linux')).toBe(true);
  });

  it('compares case-insensitively on win32 and darwin only', () => {
    expect(isPathInside('C:\\Repo\\src', 'c:\\repo', 'win32')).toBe(true);
    expect(isPathInside('C:/Repo/src', 'c:\\repo\\', 'win32')).toBe(true);
    expect(isPathInside('D:\\repo', 'C:\\', 'win32')).toBe(false);
    expect(isPathInside('C:\\x', 'C:\\', 'win32')).toBe(true);
    expect(isPathInside('/Users/Me/Repo', '/users/me', 'darwin')).toBe(true);
    expect(isPathInside('/home/Me/repo', '/home/me', 'linux')).toBe(false);
  });
});

describe('sensitivePathReason', () => {
  it.each([
    '/p/.env',
    '/p/.env.local',
    '/p/.env.production',
    '/p/.ENV',
    '/p/.envrc',
    '/p/certs/server.pem',
    '/p/tls.key',
    '/p/store.p12',
    '/p/store.pfx',
    '/p/app.keystore',
    '/home/me/.ssh/id_rsa',
    '/p/deploy/id_ed25519',
    '/p/id_ecdsa_backup',
    '/home/me/.ssh/config',
    '/home/me/.aws/config',
    '/home/me/.gnupg/pubring.kbx',
    '/home/me/.netrc',
    '/p/.npmrc',
    '/p/.pypirc',
    '/home/me/.git-credentials',
    '/p/credentials',
    '/p/credentials.json',
    'C:\\Users\\me\\.ssh\\known_hosts',
  ])('flags %s', (file) => {
    expect(sensitivePathReason(file)).toBeTypeOf('string');
  });

  it.each([
    '/p/.env.example',
    '/p/.env.sample',
    '/p/.env.template',
    '/p/.env.defaults',
    '/p/.env.local.example',
    '/p/id_rsa.pub',
    '/p/src/env.ts',
    '/p/src/keys.ts',
    '/p/environment.md',
    '/p/credentials.md',
    '/p/README.md',
  ])('does not flag %s', (file) => {
    expect(sensitivePathReason(file)).toBeUndefined();
  });
});
