import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findGuidanceFiles,
  loadInstructions,
  MAX_INSTRUCTION_BYTES,
} from '../../src/workspace/workspace.js';
import { makeTempDir, writeFiles } from '../../src/testing/index.js';

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const temp = makeTempDir('patch-instructions-');
  cleanups.push(temp.cleanup);
  return temp.dir;
}

/** A project root and a separate home directory with ~/.patch/PATCH.md as the user file. */
function setup(projectFiles: Record<string, string> = {}, homeFiles: Record<string, string> = {}) {
  const root = tempDir();
  const home = tempDir();
  writeFiles(root, projectFiles);
  writeFiles(home, homeFiles);
  const userInstructionsPath = path.join(home, '.patch', 'PATCH.md');
  const load = (cwd = root) =>
    loadInstructions({ projectRoot: root, cwd, home, userInstructionsPath });
  return { root, home, userInstructionsPath, load };
}

describe('loadInstructions', () => {
  it('loads the user file first, then the project file', async () => {
    const { root, userInstructionsPath, load } = setup(
      { 'PATCH.md': '# Project rules\nUse pnpm.\n' },
      { '.patch/PATCH.md': 'Be terse.\n' },
    );
    expect(await load()).toEqual([
      {
        path: userInstructionsPath,
        display: '~/.patch/PATCH.md',
        scope: 'user',
        source: 'PATCH.md',
        content: 'Be terse.\n',
        truncated: false,
      },
      {
        path: path.join(root, 'PATCH.md'),
        display: 'PATCH.md',
        scope: 'project',
        source: 'PATCH.md',
        content: '# Project rules\nUse pnpm.\n',
        truncated: false,
      },
    ]);
  });

  it('returns nothing when no instruction files exist', async () => {
    expect(await setup({ 'README.md': '# x\n' }).load()).toEqual([]);
  });

  it('prefers PATCH.md over CLAUDE.md and AGENTS.md', async () => {
    const { load } = setup({ 'PATCH.md': 'patch', 'CLAUDE.md': 'claude', 'AGENTS.md': 'agents' });
    const files = await load();
    expect(files.map((f) => [f.source, f.content])).toEqual([['PATCH.md', 'patch']]);
  });

  it('falls back to CLAUDE.md, then AGENTS.md, when PATCH.md is absent', async () => {
    const both = setup({ 'CLAUDE.md': 'claude', 'AGENTS.md': 'agents' });
    expect((await both.load()).map((f) => f.source)).toEqual(['CLAUDE.md']);
    const agentsOnly = setup({ 'AGENTS.md': 'agents' });
    expect(await agentsOnly.load()).toMatchObject([
      { source: 'AGENTS.md', display: 'AGENTS.md', content: 'agents', scope: 'project' },
    ]);
  });

  it('lets a blank PATCH.md opt out of the fallbacks without loading anything', async () => {
    const { load } = setup({ 'PATCH.md': '  \n', 'CLAUDE.md': 'claude' });
    expect(await load()).toEqual([]);
  });

  it('ignores a directory named like an instruction file', async () => {
    const { root, load } = setup({ 'CLAUDE.md': 'claude' });
    mkdirSync(path.join(root, 'PATCH.md'));
    expect((await load()).map((f) => f.source)).toEqual(['CLAUDE.md']);
  });

  it('adds the instruction file of a subdirectory cwd last', async () => {
    const { root, load } = setup({
      'PATCH.md': 'root rules',
      'packages/app/AGENTS.md': 'app rules',
      'packages/app/src/index.ts': '',
    });
    const cwd = path.join(root, 'packages', 'app');
    expect(await load(cwd)).toEqual([
      {
        path: path.join(root, 'PATCH.md'),
        display: '../../PATCH.md',
        scope: 'project',
        source: 'PATCH.md',
        content: 'root rules',
        truncated: false,
      },
      {
        path: path.join(cwd, 'AGENTS.md'),
        display: 'AGENTS.md',
        scope: 'project',
        source: 'AGENTS.md',
        content: 'app rules',
        truncated: false,
      },
    ]);
    // Only cwd itself is consulted, not directories between it and the root.
    expect((await load(path.join(cwd, 'src'))).map((f) => f.display)).toEqual([
      '../../../PATCH.md',
    ]);
  });

  it('applies precedence in the subdirectory too', async () => {
    const { root, load } = setup({
      'sub/PATCH.md': 'sub patch',
      'sub/CLAUDE.md': 'sub claude',
    });
    expect((await load(path.join(root, 'sub'))).map((f) => f.content)).toEqual(['sub patch']);
  });

  it('cuts files over the size cap and flags them', async () => {
    const line = `${'x'.repeat(99)}\n`;
    const big = line.repeat(1000);
    const { load } = setup({ 'PATCH.md': big });
    const [file] = await load();
    expect(file?.truncated).toBe(true);
    expect(Buffer.byteLength(file!.content)).toBeLessThanOrEqual(MAX_INSTRUCTION_BYTES);
    expect(file!.content.length).toBeGreaterThan(MAX_INSTRUCTION_BYTES * 0.8);
    // Cut at a line break, so the last line is complete.
    expect(file!.content.endsWith('x\n')).toBe(true);
    expect(big.startsWith(file!.content)).toBe(true);
  });

  it('never splits a multi-byte character when cutting', async () => {
    const big = 'é'.repeat(MAX_INSTRUCTION_BYTES); // 2 bytes each, no line breaks
    const { load } = setup({ 'PATCH.md': `a${big}` }); // odd offset puts the cap mid-character
    const [file] = await load();
    expect(file?.truncated).toBe(true);
    expect(file!.content).not.toContain('�');
    expect(Buffer.byteLength(file!.content)).toBe(MAX_INSTRUCTION_BYTES - 1);
  });

  it('does not flag a file exactly at the cap', async () => {
    const { load } = setup({ 'PATCH.md': 'y'.repeat(MAX_INSTRUCTION_BYTES) });
    const [file] = await load();
    expect(file?.truncated).toBe(false);
    expect(file?.content).toHaveLength(MAX_INSTRUCTION_BYTES);
  });

  it('normalizes CRLF line endings and strips a byte order mark', async () => {
    const { load } = setup({ 'CLAUDE.md': '\uFEFFline one\r\nline two\r\n' });
    expect((await load())[0]?.content).toBe('line one\nline two\n');
  });

  it('shows a user file outside home as an absolute path and skips blank user files', async () => {
    const root = tempDir();
    const elsewhere = tempDir();
    writeFiles(elsewhere, { 'PATCH.md': 'global rules' });
    const outside = await loadInstructions({
      projectRoot: root,
      cwd: root,
      home: tempDir(),
      userInstructionsPath: path.join(elsewhere, 'PATCH.md'),
    });
    expect(outside).toMatchObject([{ display: path.join(elsewhere, 'PATCH.md'), scope: 'user' }]);

    const blank = setup({}, { '.patch/PATCH.md': '\n\n' });
    expect(await blank.load()).toEqual([]);
  });

  it('does not load the same file twice', async () => {
    const root = tempDir();
    writeFiles(root, { 'PATCH.md': 'shared' });
    const files = await loadInstructions({
      projectRoot: root,
      cwd: root,
      home: root,
      userInstructionsPath: path.join(root, 'PATCH.md'),
    });
    expect(files).toMatchObject([{ scope: 'user', display: '~/PATCH.md' }]);
  });
});

describe('findGuidanceFiles', () => {
  it('lists guidance files in a fixed order with their sizes', async () => {
    const root = tempDir();
    writeFiles(root, {
      'HACKING.md': 'h',
      'README.md': '# Readme\n',
      'ARCHITECTURE.md': 'arch',
      'CONTRIBUTING.md': 'contrib',
      'DEVELOPMENT.md': 'dev!',
      'CHANGELOG.md': 'not guidance',
      'docs/README.md': 'nested',
    });
    expect(await findGuidanceFiles(root)).toEqual([
      { path: 'README.md', bytes: 9 },
      { path: 'CONTRIBUTING.md', bytes: 7 },
      { path: 'ARCHITECTURE.md', bytes: 4 },
      { path: 'DEVELOPMENT.md', bytes: 4 },
      { path: 'HACKING.md', bytes: 1 },
    ]);
  });

  it('reports a single README, preferring README.md', async () => {
    const root = tempDir();
    writeFiles(root, { README: 'plain', 'README.md': 'md', 'README.rst': 'rst' });
    expect(await findGuidanceFiles(root)).toEqual([{ path: 'README.md', bytes: 2 }]);

    const rst = tempDir();
    writeFiles(rst, { 'README.rst': 'rst', 'README.txt': 'txt' });
    expect(await findGuidanceFiles(rst)).toEqual([{ path: 'README.rst', bytes: 3 }]);
  });

  it('reports the real name of differently cased files', async () => {
    const root = tempDir();
    writeFiles(root, { 'readme.md': 'lower', 'Contributing.md': 'c' });
    expect(await findGuidanceFiles(root)).toEqual([
      { path: 'readme.md', bytes: 5 },
      { path: 'Contributing.md', bytes: 1 },
    ]);
  });

  it('skips directories and handles a missing root', async () => {
    const root = tempDir();
    mkdirSync(path.join(root, 'README.md'));
    writeFiles(root, { 'README.txt': 'text' });
    expect(await findGuidanceFiles(root)).toEqual([{ path: 'README.txt', bytes: 4 }]);
    expect(await findGuidanceFiles(path.join(root, 'missing'))).toEqual([]);
  });
});
