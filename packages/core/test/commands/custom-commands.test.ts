import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_COMMAND_FILE_BYTES,
  commandNameFor,
  expandCustomCommand,
  loadCustomCommands,
  parseCommandFile,
  splitCommandArguments,
} from '../../src/commands/custom-commands.js';
import { makeTempDir, writeFiles } from '../../src/testing/index.js';

let root: string;
let cleanup: () => void;
let project: string;
let home: string;
let userDir: string;

beforeEach(() => {
  ({ dir: root, cleanup } = makeTempDir('patch-commands-'));
  project = join(root, 'project');
  home = join(root, 'home');
  userDir = join(home, '.patch', 'commands');
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => cleanup());

function load() {
  return loadCustomCommands({ projectRoot: project, userDir, home });
}

describe('loadCustomCommands', () => {
  it('names commands after their path and reads their frontmatter', async () => {
    writeFiles(project, {
      '.patch/commands/review.md':
        '---\ndescription: Review code for bugs\nargument-hint: [path]\n---\n\nReview $ARGUMENTS carefully.\n',
      '.patch/commands/frontend/test.md': 'Run the frontend tests.',
      '.patch/commands/Lint.md': 'Lint everything.',
      '.patch/commands/notes.txt': 'not a command',
      '.patch/commands/.hidden.md': 'hidden',
    });
    const { commands, warnings } = await load();
    expect(warnings).toEqual([]);
    expect(commands.map((c) => c.name)).toEqual(['frontend:test', 'lint', 'review']);
    const review = commands.find((c) => c.name === 'review');
    expect(review).toMatchObject({
      scope: 'project',
      source: '.patch/commands/review.md',
      path: join(project, '.patch', 'commands', 'review.md'),
      description: 'Review code for bugs',
      argumentHint: '[path]',
      body: 'Review $ARGUMENTS carefully.',
    });
    expect(commands.find((c) => c.name === 'frontend:test')).toMatchObject({
      source: '.patch/commands/frontend/test.md',
      body: 'Run the frontend tests.',
    });
    expect(commands.find((c) => c.name === 'frontend:test')?.description).toBeUndefined();
  });

  it('prefers .patch/commands over .claude/commands over the user directory', async () => {
    writeFiles(project, {
      '.patch/commands/review.md': 'patch review',
      '.claude/commands/review.md': 'claude review',
      '.claude/commands/deploy-notes.md': 'claude deploy notes',
    });
    writeFiles(userDir, {
      'review.md': 'user review',
      'deploy-notes.md': 'user deploy notes',
      'standup.md': 'user standup',
    });
    const { commands, warnings } = await load();
    expect(warnings).toEqual([]);
    expect(commands.map((c) => [c.name, c.scope, c.source, c.body])).toEqual([
      ['deploy-notes', 'project', '.claude/commands/deploy-notes.md', 'claude deploy notes'],
      ['review', 'project', '.patch/commands/review.md', 'patch review'],
      ['standup', 'user', '~/.patch/commands/standup.md', 'user standup'],
    ]);
  });

  it('reads the user directory once when the project is the home directory', async () => {
    project = home;
    writeFiles(userDir, { 'standup.md': 'user standup' });
    const { commands } = await load();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ name: 'standup', scope: 'user' });
  });

  it('skips unusable files with a warning and keeps the others', async () => {
    writeFiles(project, {
      '.patch/commands/ok.md': 'Fine.',
      '.patch/commands/my command.md': 'Bad name.',
      '.patch/commands/empty.md': '---\ndescription: Nothing here\n---\n\n',
      '.patch/commands/open.md': '---\ndescription: never closed\nBody.',
      '.patch/commands/yaml.md': '---\ntags:\n  - a\n---\nBody.',
      '.patch/commands/big.md': `${'x'.repeat(MAX_COMMAND_FILE_BYTES)}y`,
      '.patch/commands/extra.md': '---\ncolor: blue\nallowed-tools: Bash(git:*)\n---\nBody.',
    });
    const { commands, warnings } = await load();
    expect(commands.map((c) => c.name)).toEqual(['extra', 'ok']);
    expect(warnings).toEqual([
      'Skipped .patch/commands/big.md: it is larger than 64 KB.',
      'Skipped .patch/commands/empty.md: it has no prompt text.',
      'In .patch/commands/extra.md: unknown frontmatter key "color" (ignored).',
      expect.stringMatching(/^Skipped \.patch\/commands\/my command\.md: command names may only/),
      'Skipped .patch/commands/open.md: its frontmatter has no closing "---" line.',
      'Skipped .patch/commands/yaml.md: line 3 of its frontmatter is not "key: value".',
    ]);
  });

  it('is empty without command directories', async () => {
    expect(await load()).toEqual({ commands: [], warnings: [] });
  });

  it('does not follow symbolic links in project commands', async (context) => {
    writeFiles(root, { 'outside/secret.md': 'secret' });
    mkdirSync(join(project, '.patch', 'commands'), { recursive: true });
    try {
      // A junction on Windows (no privilege needed), a symbolic link elsewhere.
      symlinkSync(join(root, 'outside'), join(project, '.patch', 'commands', 'team'), 'junction');
    } catch {
      context.skip();
    }
    const { commands, warnings } = await load();
    expect(commands).toEqual([]);
    expect(warnings).toEqual([
      'Skipped .patch/commands/team: symbolic links are not followed in project commands.',
    ]);
  });

  it('follows symbolic links in the user directory', async (context) => {
    writeFiles(root, { 'shared/standup.md': 'Standup notes.' });
    mkdirSync(userDir, { recursive: true });
    try {
      symlinkSync(join(root, 'shared'), join(userDir, 'team'), 'junction');
    } catch {
      context.skip();
    }
    const { commands } = await load();
    expect(commands.map((c) => [c.name, c.source])).toEqual([
      ['team:standup', '~/.patch/commands/team/standup.md'],
    ]);
  });

  it('skips a project commands directory that leads outside the project', async (context) => {
    writeFiles(root, { 'outside/commands/leak.md': 'secret' });
    try {
      symlinkSync(join(root, 'outside'), join(project, '.patch'), 'junction');
    } catch {
      context.skip();
    }
    const { commands, warnings } = await load();
    expect(commands).toEqual([]);
    expect(warnings).toEqual(['Skipped .patch/commands: it leads outside the project.']);
  });
});

describe('commandNameFor', () => {
  it.each([
    ['review.md', 'review'],
    ['frontend/test.md', 'frontend:test'],
    ['Frontend\\Test.MD', 'frontend:test'],
    ['v1.2.md', 'v1.2'],
    ['a/b/c/d/e.md', 'a:b:c:d:e'],
  ])('%s → /%s', (path, name) => {
    expect(commandNameFor(path)).toBe(name);
  });

  it.each(['my command.md', 'ünicode.md', '-dash.md', 'a/b/c/d/e/f.md'])('rejects %s', (path) => {
    expect(commandNameFor(path)).toBeUndefined();
  });
});

describe('parseCommandFile', () => {
  it('reads quoted values, comments and a body without frontmatter', () => {
    expect(
      parseCommandFile(
        '\uFEFF---\r\n# comment\r\ndescription: "Quoted: value"\r\nargument-hint: \'[a] [b]\'\r\n---\r\nBody\r\n',
      ),
    ).toEqual({
      description: 'Quoted: value',
      argumentHint: '[a] [b]',
      body: 'Body',
      warnings: [],
    });
    expect(parseCommandFile('  indented first line\n')).toEqual({
      body: '  indented first line',
      warnings: [],
    });
  });

  it('rejects an unterminated quote', () => {
    expect(parseCommandFile('---\ndescription: "open\n---\nBody')).toEqual({
      error: 'line 2 has an unterminated quote',
    });
  });
});

describe('expandCustomCommand', () => {
  const command = (body: string) => ({ body });

  it('replaces $ARGUMENTS with everything after the command name', () => {
    expect(expandCustomCommand(command('Review $ARGUMENTS now.'), '  src/auth  lib ')).toBe(
      'Review src/auth  lib now.',
    );
  });

  it('replaces $1 to $9 with quote-aware arguments, missing ones with nothing', () => {
    expect(expandCustomCommand(command('from $1 to $2, note: $3.'), '"src/old dir" \'new\'')).toBe(
      'from src/old dir to new, note: .',
    );
  });

  it('appends the arguments after a blank line when the prompt has no placeholder', () => {
    expect(expandCustomCommand(command('Review the code.'), 'src/auth')).toBe(
      'Review the code.\n\nsrc/auth',
    );
    expect(expandCustomCommand(command('Review the code.'), '   ')).toBe('Review the code.');
  });

  it('never expands placeholders that come from the arguments', () => {
    expect(expandCustomCommand(command('Say $ARGUMENTS and $1'), '$1 $ARGUMENTS')).toBe(
      'Say $1 $ARGUMENTS and $1',
    );
  });
});

describe('splitCommandArguments', () => {
  it.each([
    ['a b  c', ['a', 'b', 'c']],
    ['"two words" three', ['two words', 'three']],
    ["'single quoted' x", ['single quoted', 'x']],
    ["don't stop", ["don't", 'stop']],
    ['C:\\dir\\file.ts "C:\\Program Files"', ['C:\\dir\\file.ts', 'C:\\Program Files']],
    ['"unterminated quote', ['"unterminated', 'quote']],
    ['say "it"s fine"', ['say', 'it"s fine']],
    ['', []],
  ])('%j', (text, args) => {
    expect(splitCommandArguments(text)).toEqual(args);
  });
});
