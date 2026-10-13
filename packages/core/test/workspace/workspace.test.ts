import { symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectWorkspace } from '../../src/workspace/workspace.js';
import { git, makeGitRepo, makeTempDir, writeFiles } from '../../src/testing/index.js';
import { useIsolatedGitConfig } from '../git/git-env.js';

useIsolatedGitConfig();

const cleanups: (() => void)[] = [];
const originalCeiling = process.env.GIT_CEILING_DIRECTORIES;

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
});

function track<T extends { cleanup: () => void }>(resource: T): T {
  cleanups.push(resource.cleanup);
  return resource;
}

describe('detectWorkspace', () => {
  it('spells the start directory like the Git root when it is reached through a link', async () => {
    const repo = track(makeGitRepo({ 'src/index.ts': 'export {};\n' }));
    const links = track(makeTempDir('patch-link-'));
    const link = path.join(links.dir, 'repo-link');
    symlinkSync(repo.dir, link, process.platform === 'win32' ? 'junction' : 'dir');
    const home = track(makeTempDir('patch-home-'));

    const workspace = await detectWorkspace({
      cwd: path.join(link, 'src'),
      home: home.dir,
      userInstructionsPath: path.join(home.dir, '.patch', 'PATCH.md'),
    });

    // Windows short names (C:\Users\RUNNER~1) behave the same way: Git reports the long, real path.
    expect(path.relative(workspace.projectRoot, workspace.cwd)).toBe('src');
  });

  it('describes a Git project from a subdirectory', async () => {
    const repo = track(
      makeGitRepo({
        'package.json': JSON.stringify({ name: 'acme', scripts: { test: 'vitest', build: 'tsc' } }),
        'pnpm-lock.yaml': '',
        'PATCH.md': 'Root rules.\n',
        'README.md': '# Acme\n',
        'CONTRIBUTING.md': 'PRs welcome.\n',
        'packages/api/CLAUDE.md': 'API rules.\n',
        'packages/api/index.ts': 'export {};\n',
      }),
    );
    const home = track(makeTempDir('patch-home-'));
    writeFiles(home.dir, { '.patch/PATCH.md': 'Personal rules.\n' });
    const cwd = path.join(repo.dir, 'packages', 'api');

    const workspace = await detectWorkspace({
      cwd,
      home: home.dir,
      userInstructionsPath: path.join(home.dir, '.patch', 'PATCH.md'),
    });

    expect(workspace).toMatchObject({
      cwd,
      projectRoot: repo.dir,
      home: home.dir,
      platform: process.platform,
      isGit: true,
      git: {
        root: repo.dir,
        branch: 'main',
        head: git(repo.dir, 'rev-parse', '--short', 'HEAD').trim(),
        detached: false,
        hasCommits: true,
      },
      project: {
        kinds: ['node'],
        label: 'Node.js (pnpm)',
        packageManager: 'pnpm',
        name: 'acme',
        scripts: ['build', 'test'],
        testCommand: 'pnpm test',
      },
      guidance: [
        { path: 'README.md', bytes: 7 },
        { path: 'CONTRIBUTING.md', bytes: 13 },
      ],
    });
    expect(workspace.instructions.map((f) => [f.scope, f.display, f.content])).toEqual([
      ['user', '~/.patch/PATCH.md', 'Personal rules.\n'],
      ['project', '../../PATCH.md', 'Root rules.\n'],
      ['project', 'CLAUDE.md', 'API rules.\n'],
    ]);
  });

  it('falls back to directory mode outside Git', async () => {
    const dir = track(makeTempDir('patch-dir-'));
    writeFiles(dir.dir, { 'go.mod': 'module example.com/tool\n', 'AGENTS.md': 'Agent notes.\n' });
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir.dir);
    const home = track(makeTempDir('patch-home-'));

    const workspace = await detectWorkspace({
      cwd: dir.dir,
      home: home.dir,
      userInstructionsPath: path.join(home.dir, '.patch', 'PATCH.md'),
      platform: 'linux',
    });

    expect(workspace).toEqual({
      cwd: dir.dir,
      projectRoot: dir.dir,
      home: home.dir,
      platform: 'linux',
      isGit: false,
      git: null,
      project: {
        kinds: ['go'],
        label: 'Go',
        packageManager: 'go',
        name: 'example.com/tool',
        scripts: [],
        testCommand: 'go test ./...',
      },
      instructions: [
        {
          path: path.join(dir.dir, 'AGENTS.md'),
          display: 'AGENTS.md',
          scope: 'project',
          source: 'AGENTS.md',
          content: 'Agent notes.\n',
          truncated: false,
        },
      ],
      guidance: [],
    });
  });

  it('works in a repository without commits and never throws for odd directories', async () => {
    const repo = track(
      makeGitRepo({ 'Cargo.toml': '[package]\nname = "fresh"\n' }, { commit: false }),
    );
    const home = track(makeTempDir('patch-home-'));
    const workspace = await detectWorkspace({
      cwd: repo.dir,
      home: home.dir,
      userInstructionsPath: path.join(home.dir, '.patch', 'PATCH.md'),
    });
    expect(workspace.git).toMatchObject({ branch: 'main', head: null, hasCommits: false });
    expect(workspace.project.label).toBe('Rust (cargo)');

    const missing = path.join(home.dir, 'does-not-exist');
    process.env.GIT_CEILING_DIRECTORIES = home.dir;
    const fallback = await detectWorkspace({
      cwd: missing,
      home: home.dir,
      userInstructionsPath: path.join(home.dir, '.patch', 'PATCH.md'),
    });
    expect(fallback).toMatchObject({
      cwd: missing,
      projectRoot: missing,
      isGit: false,
      project: { kinds: [], label: '', scripts: [] },
      instructions: [],
      guidance: [],
    });
  });
});
