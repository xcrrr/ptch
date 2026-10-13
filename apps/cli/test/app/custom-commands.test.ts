import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_OUTPUT_TAG, emptyHooks, type SessionEntry } from '@patch/core';
import {
  ScriptedProvider,
  makeGitRepo,
  makeTempDir,
  textResponse,
  writeFiles,
  type ScriptStep,
} from '@patch/core/testing';
import type { ModelRequest } from '@patch/shared';
import { parseArgs } from '../../src/args.js';
import { AppController } from '../../src/app/controller.js';
import { parseSlashInput } from '../../src/app/custom-commands.js';
import { buildTranscriptFromEntries } from '../../src/app/transcript-builder.js';
import { Runtime } from '../../src/runtime.js';
import type { TranscriptItem } from '../../src/ui/transcript.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const REVIEW =
  '---\ndescription: Review code for bugs\nargument-hint: [path]\n---\nReview $ARGUMENTS for bugs.\n';

interface SetupOptions {
  /** Files in the repository, committed. */
  files?: Record<string, string>;
  /** ~/.patch/config.json (PATCH_HOME is the temporary home directory). */
  config?: unknown;
  /** Files in PATCH_HOME. */
  homeFiles?: Record<string, string>;
}

async function setup(steps: ScriptStep[], options: SetupOptions = {}) {
  const repo = makeGitRepo({ 'README.md': '# demo\n', ...options.files });
  const home = makeTempDir('patch-home-');
  cleanups.push(repo.cleanup, home.cleanup);
  if (options.config !== undefined) {
    writeFileSync(join(home.dir, 'config.json'), JSON.stringify(options.config));
  }
  if (options.homeFiles) writeFiles(home.dir, options.homeFiles);
  const provider = new ScriptedProvider(steps);
  const runtime = await Runtime.create({
    cwd: repo.dir,
    env: { PATH: process.env.PATH, PATCH_HOME: home.dir },
    args: parseArgs([]),
    homeDir: home.dir,
    providerFactory: () => provider,
    assumeCredentials: true,
  });
  const handle = await runtime.newSession();
  cleanups.push(() => handle.session.close());
  const controller = new AppController(runtime, handle);
  cleanups.push(() => controller.close());
  return { controller, provider, runtime, repo: repo.dir, home: home.dir };
}

function lastUserTexts(request: ModelRequest | undefined): string[] {
  const message = request?.messages.filter((m) => m.role === 'user').at(-1);
  return (message?.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : []));
}

function users(items: readonly TranscriptItem[]) {
  return items.flatMap((item) =>
    item.kind === 'user' ? [{ text: item.text, source: item.source }] : [],
  );
}

function notices(items: readonly TranscriptItem[]): string[] {
  return items.flatMap((item) => (item.kind === 'notice' ? [item.text] : []));
}

describe('custom commands', () => {
  it('show what was typed and the file, and send the expanded prompt', async () => {
    const { controller, provider } = await setup([textResponse('Reviewed.')], {
      files: { '.patch/commands/review.md': REVIEW },
    });
    expect(controller.commandInfos).toContainEqual({
      name: 'review',
      description: 'Review code for bugs',
      args: '[path]',
      tag: 'project',
    });
    controller.submit('/review src/app.ts');
    await controller.idle();
    expect(users(controller.getState().items)).toEqual([
      { text: '/review src/app.ts', source: '.patch/commands/review.md' },
    ]);
    expect(lastUserTexts(provider.requests[0])).toEqual(['Review src/app.ts for bugs.']);
  });

  it('list user commands and use files added after startup', async () => {
    const { controller, provider, repo } = await setup([textResponse('Done.')], {
      homeFiles: { 'commands/standup.md': 'Summarize what changed since yesterday.' },
    });
    expect(controller.commandInfos.find((c) => c.name === 'standup')).toMatchObject({
      description: 'Summarize what changed since yesterday.',
      tag: 'user',
    });
    writeFiles(repo, { '.patch/commands/frontend/test.md': 'Run the frontend tests.' });
    controller.refreshCommands();
    await controller.idle();
    expect(controller.commandInfos.map((c) => c.name)).toContain('frontend:test');

    writeFiles(repo, { '.patch/commands/late.md': 'Late command.' });
    controller.submit('/late extra words');
    await controller.idle();
    expect(lastUserTexts(provider.requests[0])).toEqual(['Late command.\n\nextra words']);
  });

  it('never replace built-in commands, which is reported once', async () => {
    const { controller } = await setup([], {
      files: { '.patch/commands/status.md': 'Custom status.', '.patch/commands/q.md': 'Quit?' },
    });
    const expected = [
      'Custom command /q (.patch/commands/q.md) is not available: a built-in command has that name.',
      'Custom command /status (.patch/commands/status.md) is not available: a built-in command has that name.',
    ];
    expect(notices(controller.getState().items)).toEqual(expected);
    controller.submit('/status');
    await controller.reloadCustomCommands();
    await controller.idle();
    const items = controller.getState().items;
    expect(items.some((i) => i.kind === 'status' && i.title === 'Status')).toBe(true);
    expect(notices(items)).toEqual(expected);
    expect(controller.commandInfos.filter((c) => c.name === 'status')).toHaveLength(1);
  });

  it('wait in the queue like a message while Patch is busy', async () => {
    const { controller, provider } = await setup(
      [
        { text: 'First answer, streaming slowly.', chunkSize: 4, chunkDelayMs: 20 },
        textResponse('Reviewed.'),
      ],
      { files: { '.patch/commands/review.md': REVIEW } },
    );
    controller.submit('first');
    controller.submit('/review lib');
    controller.submit('/nope');
    expect(controller.getState().queue).toEqual(['/review lib']);
    expect(notices(controller.getState().items)).toEqual(['Unknown command: /nope']);
    await controller.idle();
    expect(users(controller.getState().items).map((u) => u.text)).toEqual(['first', '/review lib']);
    expect(lastUserTexts(provider.requests[1])).toEqual(['Review lib for bugs.']);
  });

  it('report problems with command files once', async () => {
    const { controller } = await setup([], {
      files: { '.patch/commands/empty.md': '---\ndescription: nothing\n---\n' },
    });
    const problem = 'Skipped .patch/commands/empty.md: it has no prompt text.';
    expect(notices(controller.getState().items)).toEqual([problem]);
    await controller.reloadCustomCommands();
    expect(notices(controller.getState().items)).toEqual([problem]);
  });

  it('appear in /help with their tag, with where commands live', async () => {
    const { controller } = await setup([], { files: { '.patch/commands/review.md': REVIEW } });
    controller.submit('/help');
    await controller.idle();
    const help = controller.getState().items.find((i) => i.kind === 'help');
    const section = help?.kind === 'help' ? help.sections[1] : undefined;
    expect(section).toEqual({
      title: 'Custom commands',
      rows: [
        { key: '/review [path]', description: 'Review code for bugs (project)' },
        {
          key: '.patch/commands/',
          description: 'Project commands: <name>.md holds the prompt that /<name> sends',
        },
        { key: '~/commands/', description: 'Your own commands, for every project' },
      ],
    });
  });
});

describe('hooks in the interactive session', () => {
  it('lists the configured hooks with /hooks', async () => {
    const { controller } = await setup([], {
      config: {
        hooks: {
          PreToolUse: [{ matcher: 'bash', command: './guard.sh', timeout: 5 }],
          PostToolUse: [{ command: 'pnpm prettier --write "$PATCH_FILE"' }],
          Stop: [{ command: 'notify-send done' }],
        },
      },
    });
    controller.submit('/hooks');
    await controller.idle();
    const table = controller.getState().items.find((i) => i.kind === 'status');
    expect(table?.kind === 'status' && table.rows).toEqual([
      { label: 'PreToolUse', value: './guard.sh', detail: 'matcher bash · timeout 5s' },
      {
        label: 'PostToolUse',
        value: 'pnpm prettier --write "$PATCH_FILE"',
        detail: 'all tools · timeout 60s',
      },
      { label: 'Stop', value: 'notify-send done', detail: 'timeout 60s' },
      {
        label: 'config',
        value: '~/config.json',
        detail: 'hooks run in the project root; only your user configuration can define them',
      },
    ]);
  });

  it('ignores hooks defined by a repository', async () => {
    const { controller, runtime } = await setup([], {
      files: {
        '.patch/config.json': JSON.stringify({
          hooks: { SessionStart: [{ command: 'echo pwned > pwned.txt' }] },
        }),
      },
    });
    expect(runtime.hooks.hooks).toEqual(emptyHooks());
    controller.submit('/hooks');
    await controller.idle();
    const table = controller.getState().items.find((i) => i.kind === 'status');
    expect(table?.kind === 'status' && table.rows).toEqual([
      { label: 'none', value: 'Add hooks under "hooks" in ~/config.json' },
    ]);
  });

  it('runs SessionStart hooks at startup and sends their output with the first message', async () => {
    const { controller, provider } = await setup([textResponse('Noted.')], {
      config: {
        hooks: {
          SessionStart: [
            { command: `node -e "process.stdout.write('Deploys are frozen today.')"` },
          ],
        },
      },
    });
    expect(controller.isBusy()).toBe(true);
    controller.submit('hello');
    expect(controller.getState().queue).toEqual(['hello']);
    await controller.idle();
    const [context, prompt] = lastUserTexts(provider.requests[0]);
    expect(context?.startsWith(`${HOOK_OUTPUT_TAG} event="SessionStart">`)).toBe(true);
    expect(context).toContain('Deploys are frozen today.');
    expect(prompt).toBe('hello');
    // Quiet on success: nothing but the conversation in the transcript.
    expect(notices(controller.getState().items)).toEqual([]);
  });
});

describe('a resumed transcript', () => {
  it('leaves hook output for the model out', () => {
    const ts = '2026-10-12T00:00:00.000Z';
    const hookText = (event: string) =>
      `${HOOK_OUTPUT_TAG} event="${event}">\nsomething\n</hook-output>`;
    const entries: SessionEntry[] = [
      {
        type: 'message',
        ts,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: hookText('SessionStart') },
            { type: 'text', text: 'hello' },
          ],
        },
      },
      {
        type: 'message',
        ts,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi.' }] },
      },
      { type: 'notice', ts, level: 'info', text: 'A Stop hook asked Patch to continue.' },
      {
        type: 'message',
        ts,
        message: { role: 'user', content: [{ type: 'text', text: hookText('Stop') }] },
      },
    ];
    let next = 0;
    const items = buildTranscriptFromEntries(entries, () => `i${next++}`);
    expect(items.map((item) => item.kind)).toEqual(['user', 'assistant', 'notice']);
    expect(items[0]).toMatchObject({ kind: 'user', text: 'hello' });
  });
});

describe('parseSlashInput', () => {
  it.each([
    ['/review src/auth', { name: 'review', args: 'src/auth' }],
    ['/Frontend:Test  a  b ', { name: 'frontend:test', args: 'a  b' }],
    ['/review\nmore text', { name: 'review', args: 'more text' }],
    ['//not a command', undefined],
    ['plain text', undefined],
  ])('%j', (text, expected) => {
    expect(parseSlashInput(text)).toEqual(expected);
  });
});
