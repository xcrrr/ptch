import { describe, expect, it } from 'vitest';
import { isStrictAncestor, isWithin, samePath } from '../../src/permissions/path-utils.js';
import {
  isCatastrophicTarget,
  locatePathArgument,
  looksSensitive,
} from '../../src/permissions/risk-paths.js';
import {
  commandMatchesPrefix,
  describeRule,
  parsePermissionRule,
} from '../../src/permissions/rules.js';

describe('parsePermissionRule', () => {
  it('parses every rule form', () => {
    expect(parsePermissionRule('edit')).toEqual({ ok: true, rule: { kind: 'edit' } });
    expect(parsePermissionRule('bash:*')).toEqual({ ok: true, rule: { kind: 'bash-all' } });
    expect(parsePermissionRule('  bash:  pnpm   test ')).toEqual({
      ok: true,
      rule: { kind: 'bash-prefix', prefix: 'pnpm test' },
    });
    expect(parsePermissionRule('BASH:npm run *')).toEqual({
      ok: true,
      rule: { kind: 'bash-prefix', prefix: 'npm run' },
    });
    expect(parsePermissionRule('read:/srv/data/', 'linux')).toEqual({
      ok: true,
      rule: { kind: 'read', path: '/srv/data' },
    });
    expect(parsePermissionRule('read:C:\\data', 'win32')).toEqual({
      ok: true,
      rule: { kind: 'read', path: 'C:\\data' },
    });
  });

  it('rejects relative read directories for the platform', () => {
    expect(parsePermissionRule('read:data', 'linux').ok).toBe(false);
    expect(parsePermissionRule('read:C:\\data', 'linux').ok).toBe(false);
  });

  it('describes rules in plain language', () => {
    expect(describeRule({ kind: 'bash-prefix', prefix: 'pnpm test' })).toBe(
      'commands starting with "pnpm test"',
    );
    expect(describeRule({ kind: 'bash-all' })).toBe('all commands except blocked ones');
  });
});

describe('commandMatchesPrefix', () => {
  it('matches on word boundaries and ignores extra whitespace', () => {
    expect(commandMatchesPrefix('pnpm test', 'pnpm test')).toBe(true);
    expect(commandMatchesPrefix('pnpm   test --run x', 'pnpm test')).toBe(true);
    expect(commandMatchesPrefix('pnpm testing', 'pnpm test')).toBe(false);
    expect(commandMatchesPrefix('npm run build:prod', 'npm run build')).toBe(false);
    expect(commandMatchesPrefix('anything', '  ')).toBe(false);
  });
});

describe('path helpers', () => {
  it('compares containment per platform', () => {
    expect(isWithin('/a/b/c', '/a/b', 'linux')).toBe(true);
    expect(isWithin('/a/b', '/a/b', 'linux')).toBe(true);
    expect(isWithin('/a/bc', '/a/b', 'linux')).toBe(false);
    expect(isWithin('/A/B/c', '/a/b', 'linux')).toBe(false);
    expect(isWithin('/A/B/c', '/a/b', 'darwin')).toBe(true);
    expect(isWithin('C:\\Proj\\src', 'c:\\proj', 'win32')).toBe(true);
    expect(isWithin('D:\\proj', 'C:\\proj', 'win32')).toBe(false);
    expect(samePath('C:\\x\\', 'c:\\X', 'win32')).toBe(true);
    expect(isStrictAncestor('/a', '/a/b', 'linux')).toBe(true);
    expect(isStrictAncestor('/a', '/a', 'linux')).toBe(false);
  });

  const env = {
    platform: 'linux' as const,
    projectRoot: '/work/proj',
    home: '/home/me',
    cwds: ['/work/proj'],
  };

  it('locates path arguments', () => {
    expect(locatePathArgument('src/a.ts', env)).toBe('inside');
    expect(locatePathArgument('../other', env)).toBe('outside');
    expect(locatePathArgument('~', env)).toBe('outside');
    expect(locatePathArgument('~root/x', env)).toBe('outside');
    expect(locatePathArgument('$DIR/x', env)).toBe('variable');
    expect(locatePathArgument('--file=/etc/x', env)).toBe('outside');
    expect(locatePathArgument('-la', env)).toBeUndefined();
    expect(locatePathArgument('https://example.com/a', env)).toBeUndefined();
    expect(locatePathArgument('git@github.com:o/r.git', env)).toBeUndefined();
    expect(locatePathArgument('/dev/null', env)).toBeUndefined();
  });

  it('recognizes catastrophic deletion targets', () => {
    for (const target of [
      '/',
      '/*',
      '/usr',
      '~',
      '~/',
      '$HOME',
      '${HOME}/*',
      '/home',
      '/work',
      '..',
      '$X/',
      '~bob',
    ]) {
      expect(isCatastrophicTarget(target, env), target).toBe(true);
    }
    for (const target of [
      '.',
      '*',
      'dist',
      '/work/proj/dist',
      '/tmp/build/x',
      '$X',
      '~/projects/old',
    ]) {
      expect(isCatastrophicTarget(target, env), target).toBe(false);
    }
  });

  it('recognizes file names that usually hold secrets', () => {
    for (const name of [
      '.env',
      '.env.production',
      'a/.envrc',
      'server.pem',
      'id_rsa',
      '.ssh/config',
      '.aws/config',
      '.npmrc',
      'credentials.json',
    ]) {
      expect(looksSensitive(name), name).toBe(true);
    }
    for (const name of ['.env.example', 'id_rsa.pub', 'src/env.ts', 'keys.ts', 'README.md']) {
      expect(looksSensitive(name), name).toBe(false);
    }
  });
});
