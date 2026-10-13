import type * as fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, writeFiles } from '../../src/testing/index.js';
import {
  analyzeCommandDetailed as analyzeCommand,
  type AnalyzeCommandOptions,
} from '../../src/permissions/command-risk.js';

/**
 * File system calls made by the classifier, recorded through a mock of node:fs. Network paths are
 * never passed on to the real file system (opening one would contact the host), and paths under a
 * `locked` directory fail like unreadable directories.
 */
const probes = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const networkPath = (target: unknown): boolean => /^[\\/]{2}/.test(String(target));
  const denied = (target: unknown): boolean => String(target).includes('locked');
  const fail = (code: string): never => {
    throw Object.assign(new Error(code), { code });
  };
  const existsSync = (target: Parameters<typeof actual.existsSync>[0]): boolean => {
    probes.paths.push(String(target));
    return networkPath(target) ? false : actual.existsSync(target);
  };
  const readdirSync = ((target: string, ...rest: unknown[]) => {
    probes.paths.push(String(target));
    if (networkPath(target)) fail('ENOENT');
    if (denied(target)) fail('EACCES');
    return (actual.readdirSync as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof actual.readdirSync;
  const native = ((target: string, ...rest: unknown[]) => {
    probes.paths.push(String(target));
    if (networkPath(target)) fail('ENOENT');
    if (denied(target)) fail('EACCES');
    return (actual.realpathSync.native as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof actual.realpathSync.native;
  const realpathSync = Object.assign(
    ((target: string, ...rest: unknown[]) =>
      (actual.realpathSync as (...args: unknown[]) => unknown)(
        target,
        ...rest,
      )) as typeof actual.realpathSync,
    { native },
  );
  const mocked = { ...actual, existsSync, readdirSync, realpathSync };
  return { ...mocked, default: mocked };
});

describe('file system checks during classification', () => {
  let temp: { dir: string; cleanup: () => void };
  let host: AnalyzeCommandOptions;

  beforeAll(() => {
    temp = makeTempDir();
    host = { cwd: temp.dir, projectRoot: temp.dir, home: path.join(temp.dir, 'home') };
    writeFiles(temp.dir, { 'src/a.ts': 'x', 'locked/inner/a.ts': 'x', 'notes/app.md': 'x' });
  });

  afterAll(() => temp.cleanup());

  beforeEach(() => {
    probes.paths.length = 0;
  });

  it('checks existing files in the project (the mock sees the probes)', () => {
    analyzeCommand('cat notes/*.md', host);
    expect(probes.paths.length).toBeGreaterThan(0);
  });

  it.each([
    'cat //attacker.example/share/x',
    'cat \\\\attacker.example\\share\\x',
    'Get-Content \\\\host\\s\\x',
    'cat /\\host\\s\\x',
    'cat \\\\?\\UNC\\host\\s\\x',
    'cat \\\\.\\pipe\\x',
    'cp a //host/s/x',
    'echo hi > //host/s/x',
    'cat < //host/s/x',
    'cat //host/share/*.txt',
    'ls //host/share/dir/*',
    'git checkout //host/s/x',
    'cd //host/share && cat x',
  ])('never touches network paths: %s', (command) => {
    const analysis = analyzeCommand(command, host);
    expect(probes.paths.filter((probe) => /^[\\/]{2}/.test(probe))).toEqual([]);
    // Outside Windows a backslash is an escape, so only `//host` names another machine there.
    if (process.platform === 'win32' || !command.includes('\\')) {
      expect(analysis.risk).not.toBe('safe');
      expect(analysis.rulePrefix).toBeUndefined();
    }
  });

  it
    .skipIf(process.platform !== 'win32')
    .each(['cat NUL', 'type COM1', 'cat sub/con.txt', 'echo x > LPT1', 'cat aux*'])(
    'never opens Windows device names: %s',
    (command) => {
      analyzeCommand(command, host);
      const devices = probes.paths.filter((probe) =>
        probe
          .split(/[\\/]+/)
          .some((segment) => /^(con|prn|aux|nul|com\d|lpt\d)([.:].*)?$/i.test(segment)),
      );
      expect(devices).toEqual([]);
    },
  );

  it('copes with directories it cannot read, on every platform', () => {
    for (const command of ['cat locked/*', 'cat locked/*/.e*', 'ls locked/*/x', 'cat locked/a']) {
      const analysis = analyzeCommand(command, host);
      expect(['safe', 'normal']).toContain(analysis.risk);
    }
    expect(probes.paths.some((probe) => probe.includes('locked'))).toBe(true);
    // An unreadable directory cannot rule out a secret file.
    expect(analyzeCommand('cat locked/*', host).risk).toBe('normal');
  });
});
