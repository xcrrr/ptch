import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProject } from '../../src/workspace/workspace.js';
import { makeTempDir, writeFiles } from '../../src/testing/index.js';

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** A temp project root containing `files` (and `dirs`). */
function project(files: Record<string, string>, dirs: string[] = []): string {
  const temp = makeTempDir('patch-project-');
  cleanups.push(temp.cleanup);
  writeFiles(temp.dir, files);
  for (const dir of dirs) mkdirSync(path.join(temp.dir, dir), { recursive: true });
  return temp.dir;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

describe('detectProject', () => {
  it('returns an empty description for an unknown or missing directory', async () => {
    const empty = { kinds: [], label: '', scripts: [] };
    expect(await detectProject(project({ 'notes.txt': 'hi\n' }))).toEqual(empty);
    expect(await detectProject(path.join(project({}), 'missing'))).toEqual(empty);
  });

  describe('Node.js', () => {
    it('reads name, sorted scripts and the npm test command', async () => {
      const root = project({
        'package.json': json({
          name: 'acme-web',
          scripts: { test: 'vitest run', build: 'tsc', 'lint:fix': 'eslint --fix', dev: 'vite' },
        }),
      });
      expect(await detectProject(root)).toEqual({
        kinds: ['node'],
        label: 'Node.js (npm)',
        packageManager: 'npm',
        name: 'acme-web',
        scripts: ['build', 'dev', 'lint:fix', 'test'],
        testCommand: 'npm test',
      });
    });

    it.each([
      ['pnpm-lock.yaml', 'pnpm', 'pnpm test'],
      ['yarn.lock', 'yarn', 'yarn test'],
      ['bun.lockb', 'bun', 'bun run test'],
      ['bun.lock', 'bun', 'bun run test'],
      ['package-lock.json', 'npm', 'npm test'],
    ])('detects %s as %s', async (lockfile, manager, testCommand) => {
      const root = project({
        'package.json': json({ scripts: { test: 'jest' } }),
        [lockfile]: '',
      });
      expect(await detectProject(root)).toMatchObject({
        label: `Node.js (${manager})`,
        packageManager: manager,
        testCommand,
      });
    });

    it('prefers the packageManager field over lockfiles', async () => {
      const root = project({
        'package.json': json({ packageManager: 'pnpm@9.1.0+sha512.abc', scripts: { test: 'x' } }),
        'package-lock.json': '{}',
      });
      expect(await detectProject(root)).toMatchObject({
        packageManager: 'pnpm',
        testCommand: 'pnpm test',
      });
    });

    it('ignores an unknown packageManager value', async () => {
      const root = project({
        'package.json': json({ packageManager: 'npx@1' }),
        'yarn.lock': '',
      });
      expect((await detectProject(root)).packageManager).toBe('yarn');
    });

    it('has no test command without a real test script', async () => {
      const none = project({ 'package.json': json({ scripts: { build: 'tsc' } }) });
      expect((await detectProject(none)).testCommand).toBeUndefined();
      const placeholder = project({
        'package.json': json({
          scripts: { test: 'echo "Error: no test specified" && exit 1' },
        }),
      });
      expect((await detectProject(placeholder)).testCommand).toBeUndefined();
    });

    it('caps scripts at 30, sorted', async () => {
      const scripts = Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`s${String(i).padStart(2, '0')}`, 'x']),
      );
      const root = project({ 'package.json': json({ scripts }) });
      const info = await detectProject(root);
      expect(info.scripts).toHaveLength(30);
      expect(info.scripts[0]).toBe('s00');
      expect(info.scripts[29]).toBe('s29');
    });

    it('survives a malformed package.json', async () => {
      const root = project({ 'package.json': '{ "name": "broken", ' });
      expect(await detectProject(root)).toEqual({
        kinds: ['node'],
        label: 'Node.js (npm)',
        packageManager: 'npm',
        scripts: [],
      });
      const notAnObject = project({ 'package.json': '[1, 2]', 'pnpm-lock.yaml': '' });
      expect(await detectProject(notAnObject)).toMatchObject({ label: 'Node.js (pnpm)' });
    });
  });

  describe('Python', () => {
    it('uses uv when uv.lock exists', async () => {
      const root = project({
        'pyproject.toml': '[project]\nname = "acme-api"\nversion = "1.0"\n',
        'uv.lock': '',
      });
      expect(await detectProject(root)).toEqual({
        kinds: ['python'],
        label: 'Python (uv)',
        packageManager: 'uv',
        name: 'acme-api',
        scripts: [],
        testCommand: 'uv run pytest',
      });
    });

    it('uses poetry when poetry.lock exists', async () => {
      const root = project({
        'pyproject.toml': "[tool.poetry]\nname = 'poetic'\n\n[tool.poetry.dependencies]\n",
        'poetry.lock': '',
      });
      expect(await detectProject(root)).toMatchObject({
        label: 'Python (poetry)',
        packageManager: 'poetry',
        name: 'poetic',
        testCommand: 'poetry run pytest',
      });
    });

    it('falls back to pip and suggests pytest only with evidence', async () => {
      const withRequirement = project({ 'requirements-dev.txt': 'pytest==8.0\nblack\n' });
      expect(await detectProject(withRequirement)).toMatchObject({
        label: 'Python (pip)',
        packageManager: 'pip',
        testCommand: 'pytest',
      });
      const withTestsDir = project({ 'setup.py': 'from setuptools import setup\n' }, ['tests']);
      expect((await detectProject(withTestsDir)).testCommand).toBe('pytest');
      const withIni = project({ 'requirements.txt': 'requests\n', 'pytest.ini': '[pytest]\n' });
      expect((await detectProject(withIni)).testCommand).toBe('pytest');
      const inPyproject = project({
        'pyproject.toml': '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n',
      });
      expect((await detectProject(inPyproject)).testCommand).toBe('pytest');
      const noEvidence = project({ 'requirements.txt': 'requests\n' });
      expect(await detectProject(noEvidence)).toEqual({
        kinds: ['python'],
        label: 'Python (pip)',
        packageManager: 'pip',
        scripts: [],
      });
    });
  });

  it('detects Rust', async () => {
    const root = project({
      'Cargo.toml': '[workspace]\nmembers = ["x"]\n\n[package]\nname = "ripper" # the crate\n',
    });
    expect(await detectProject(root)).toEqual({
      kinds: ['rust'],
      label: 'Rust (cargo)',
      packageManager: 'cargo',
      name: 'ripper',
      scripts: [],
      testCommand: 'cargo test',
    });
    const workspaceOnly = project({ 'Cargo.toml': '[workspace]\nmembers = ["a"]\n' });
    expect((await detectProject(workspaceOnly)).name).toBeUndefined();
  });

  it('detects Go', async () => {
    const root = project({ 'go.mod': 'module github.com/acme/tool\n\ngo 1.22\n' });
    expect(await detectProject(root)).toEqual({
      kinds: ['go'],
      label: 'Go',
      packageManager: 'go',
      name: 'github.com/acme/tool',
      scripts: [],
      testCommand: 'go test ./...',
    });
  });

  it('detects Maven, preferring the wrapper when present', async () => {
    expect(await detectProject(project({ 'pom.xml': '<project/>' }))).toEqual({
      kinds: ['java'],
      label: 'Java (Maven)',
      packageManager: 'maven',
      scripts: [],
      testCommand: 'mvn test',
    });
    const wrapped = project({ 'pom.xml': '<project/>', mvnw: '#!/bin/sh\n' });
    expect((await detectProject(wrapped)).testCommand).toBe('./mvnw test');
  });

  it('detects Gradle, preferring the wrapper when present', async () => {
    const wrapped = project({
      'build.gradle.kts': 'plugins {}\n',
      'settings.gradle.kts': 'rootProject.name = "acme-service"\n',
      gradlew: '#!/bin/sh\n',
    });
    expect(await detectProject(wrapped)).toEqual({
      kinds: ['java'],
      label: 'Java (Gradle)',
      packageManager: 'gradle',
      name: 'acme-service',
      scripts: [],
      testCommand: './gradlew test',
    });
    const plain = project({ 'build.gradle': "apply plugin: 'java'\n" });
    expect((await detectProject(plain)).testCommand).toBe('gradle test');
  });

  it('detects Ruby with RSpec or Rake', async () => {
    const rspec = project({ Gemfile: "source 'https://rubygems.org'\n" }, ['spec']);
    expect(await detectProject(rspec)).toEqual({
      kinds: ['ruby'],
      label: 'Ruby (Bundler)',
      packageManager: 'bundler',
      scripts: [],
      testCommand: 'bundle exec rspec',
    });
    const rake = project({ Gemfile: '' });
    expect((await detectProject(rake)).testCommand).toBe('bundle exec rake test');
  });

  it('detects PHP with or without a composer test script', async () => {
    const scripted = project({
      'composer.json': json({ name: 'acme/shop', scripts: { test: 'phpunit' } }),
    });
    expect(await detectProject(scripted)).toEqual({
      kinds: ['php'],
      label: 'PHP (Composer)',
      packageManager: 'composer',
      name: 'acme/shop',
      scripts: [],
      testCommand: 'composer test',
    });
    const plain = project({ 'composer.json': '{ not json' });
    expect(await detectProject(plain)).toMatchObject({ testCommand: 'vendor/bin/phpunit' });
  });

  it('detects .NET solutions and projects', async () => {
    const solution = project({ 'Acme.sln': '', 'Acme.Tests.csproj': '' });
    expect(await detectProject(solution)).toEqual({
      kinds: ['dotnet'],
      label: '.NET',
      packageManager: 'dotnet',
      name: 'Acme',
      scripts: [],
      testCommand: 'dotnet test',
    });
    const projectOnly = project({ 'Lib.fsproj': '' });
    expect((await detectProject(projectOnly)).name).toBe('Lib');
  });

  it('detects Deno', async () => {
    const root = project({ 'deno.json': json({ name: '@acme/deno-app', tasks: {} }) });
    expect(await detectProject(root)).toEqual({
      kinds: ['deno'],
      label: 'Deno',
      packageManager: 'deno',
      name: '@acme/deno-app',
      scripts: [],
      testCommand: 'deno test',
    });
    const jsonc = project({ 'deno.jsonc': '// config\n{ "name": "x" }\n' });
    expect(await detectProject(jsonc)).toMatchObject({ label: 'Deno', testCommand: 'deno test' });
  });

  describe('Make', () => {
    it('suggests make test only when a test target exists', async () => {
      const withTarget = project({
        Makefile: 'build:\n\tcc main.c\n\nunit test: build\n\t./run\n',
      });
      expect(await detectProject(withTarget)).toEqual({
        kinds: ['make'],
        label: 'Make',
        scripts: [],
        testCommand: 'make test',
      });
      const noTarget = project({
        Makefile:
          '.PHONY: test\ntest := 1\nTEST_FLAGS ?= -v\n# test: commented\nall:\n\techo test:\n',
      });
      expect((await detectProject(noTarget)).testCommand).toBeUndefined();
    });

    it('defers to the test command of another ecosystem', async () => {
      const root = project({
        'package.json': json({ scripts: { test: 'vitest' } }),
        Makefile: 'test:\n\tnpm test\n',
      });
      expect(await detectProject(root)).toMatchObject({
        kinds: ['node', 'make'],
        label: 'Node.js (npm) + Make',
        testCommand: 'npm test',
      });
    });

    it('provides the test command when the other ecosystem has none', async () => {
      const root = project({
        'package.json': json({ scripts: { build: 'tsc' } }),
        'pnpm-lock.yaml': '',
        Makefile: 'test:\n\t./scripts/test.sh\n',
      });
      expect(await detectProject(root)).toMatchObject({
        kinds: ['node', 'make'],
        label: 'Node.js (pnpm) + Make',
        packageManager: 'pnpm',
        testCommand: 'make test',
      });
    });
  });

  it('labels several ecosystems with the first two, most significant first', async () => {
    const root = project({
      'Cargo.toml': '[package]\nname = "core"\n',
      'pyproject.toml': '[project]\nname = "bindings"\n',
      'package.json': json({ name: 'web' }),
    });
    expect(await detectProject(root)).toMatchObject({
      kinds: ['node', 'python', 'rust'],
      label: 'Node.js (npm) + Python (pip)',
      packageManager: 'npm',
      name: 'web',
      testCommand: 'cargo test',
    });
  });
});
