import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ScriptedProvider,
  makeGitRepo,
  makeTempDir,
  pngBytes,
  textResponse,
  toolResponse,
  type ScriptStep,
} from '@patch/core/testing';
import { formatBytes, type ContentBlock, type ModelRequest } from '@patch/shared';
import { parseArgs } from '../../src/args.js';
import { ClipboardError } from '../../src/clipboard.js';
import { AppController, type ControllerOptions } from '../../src/app/controller.js';
import { buildTranscriptFromEntries } from '../../src/app/transcript-builder.js';
import type { ImageAttachment } from '../../src/images.js';
import { Runtime } from '../../src/runtime.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function setup(steps: ScriptStep[], options: ControllerOptions = {}) {
  const repo = makeGitRepo({ 'README.md': '# demo\n' });
  const home = makeTempDir('patch-home-');
  const outside = makeTempDir('patch-outside-');
  cleanups.push(repo.cleanup, home.cleanup, outside.cleanup);
  mkdirSync(join(repo.dir, 'docs'));
  writeFileSync(join(repo.dir, 'docs', 'shot.png'), pngBytes(1280, 720));
  writeFileSync(join(outside.dir, 'desktop.png'), pngBytes(10, 10));
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
  const controller = new AppController(runtime, handle, options);
  cleanups.push(() => controller.close());
  return { controller, provider, repo: repo.dir, outside: outside.dir };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Block types of the last user message of a request. */
function lastUserBlocks(request: ModelRequest | undefined): ContentBlock[] {
  return request?.messages.filter((m) => m.role === 'user').at(-1)?.content ?? [];
}

const PASTED_BYTES = pngBytes(2, 2);
const PASTED_LINE = `[Image #1] clipboard · 2×2 · ${formatBytes(PASTED_BYTES.length)}`;
const pasted: ImageAttachment = {
  image: {
    type: 'image',
    mediaType: 'image/png',
    data: PASTED_BYTES.toString('base64'),
    label: 'clipboard',
  },
  description: `clipboard · 2×2 · ${formatBytes(PASTED_BYTES.length)}`,
};

function userItems(controller: AppController) {
  return controller.getState().items.flatMap((item) => (item.kind === 'user' ? [item] : []));
}

describe('AppController images', () => {
  it('sends attached images before the text and lists them under the echoed prompt', async () => {
    const { controller, provider } = await setup([textResponse('A tiny image.')]);
    controller.submit('What is [Image #1]?', [pasted]);
    await controller.idle();

    expect(lastUserBlocks(provider.requests[0])).toEqual([
      pasted.image,
      { type: 'text', text: 'What is [Image #1]?' },
    ]);
    expect(userItems(controller)).toEqual([
      expect.objectContaining({
        text: 'What is [Image #1]?',
        images: [PASTED_LINE],
      }),
    ]);
  });

  it('attaches @mentioned images and keeps the text as typed', async () => {
    const { controller, provider } = await setup([textResponse('Looks fine.')]);
    controller.submit('Check [Image #1] against @docs/shot.png.', [pasted]);
    await controller.idle();

    const blocks = lastUserBlocks(provider.requests[0]);
    expect(blocks.map((b) => b.type)).toEqual(['image', 'image', 'text']);
    expect(blocks[1]).toMatchObject({ type: 'image', label: 'shot.png' });
    expect(blocks[2]).toEqual({ type: 'text', text: 'Check [Image #1] against @docs/shot.png.' });
    expect(userItems(controller)[0]?.images).toEqual([
      PASTED_LINE,
      expect.stringMatching(/^\[Image #2\] shot\.png · 1280×720 · /),
    ]);
  });

  it('asks before attaching a mentioned image outside the project', async () => {
    const { controller, provider, outside } = await setup([
      textResponse('Without it.'),
      textResponse('With it.'),
    ]);
    const target = join(outside, 'desktop.png');
    controller.submit(`Look at @"${target}"`);
    await waitFor(() => controller.getState().mode === 'permission');
    expect(controller.getState().permission?.prompt.title).toBe(
      'Patch wants to read outside the project',
    );
    controller.respondPermission({ decision: 'deny' });
    await controller.idle();
    expect(lastUserBlocks(provider.requests[0]).map((b) => b.type)).toEqual(['text']);
    const notice = controller
      .getState()
      .items.find((i) => i.kind === 'notice' && i.level === 'warn');
    expect(notice?.kind === 'notice' && notice.text).toMatch(
      /was not attached\. Reading .* was not approved\.$/,
    );

    controller.submit(`Look at @"${target}"`);
    await waitFor(() => controller.getState().mode === 'permission');
    controller.respondPermission({ decision: 'allow_once' });
    await controller.idle();
    expect(lastUserBlocks(provider.requests[1]).map((b) => b.type)).toEqual(['image', 'text']);
  });

  it('notes mentions of missing files without stopping the prompt', async () => {
    const { controller, provider } = await setup([textResponse('ok')]);
    controller.submit('See @nope.png');
    await controller.idle();
    expect(provider.requests).toHaveLength(1);
    const notice = controller.getState().items.find((i) => i.kind === 'notice');
    expect(notice).toMatchObject({
      level: 'info',
      text: '@nope.png was not attached. File not found: nope.png',
    });
  });

  it('attaches a pasted path inside the project without asking', async () => {
    const { controller } = await setup([]);
    const result = await controller.attachImage('docs/shot.png');
    expect(result).toMatchObject({
      ok: true,
      attachment: { description: expect.stringMatching(/^shot\.png · 1280×720 · /) },
    });
    expect(controller.getState().mode).toBe('idle');
  });

  it("shows an image approval after the running turn's own request", async () => {
    const { controller, outside } = await setup([
      toolResponse([{ name: 'bash', input: { command: 'npm test' } }]),
      textResponse('Done.'),
    ]);
    controller.submit('Run the tests.');
    await waitFor(() => controller.getState().mode === 'permission');
    const toolRequest = controller.getState().permission;
    const attaching = controller.attachImage(join(outside, 'desktop.png'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(controller.getState().permission).toBe(toolRequest);

    controller.respondPermission({ decision: 'allow_once' });
    await waitFor(() => controller.getState().permission?.toolName === 'image');
    expect(controller.getState().mode).toBe('permission');
    controller.respondPermission({ decision: 'allow_once' });
    expect((await attaching).ok).toBe(true);
    await controller.idle();
    expect(controller.getState().mode).toBe('idle');
  });

  it('keeps the images of a prompt queued while busy', async () => {
    const { controller, provider } = await setup([
      { text: 'First answer, streaming slowly.', chunkSize: 4, chunkDelayMs: 20 },
      textResponse('Second answer.'),
    ]);
    controller.submit('first');
    controller.submit('second [Image #1]', [pasted]);
    expect(controller.getState().queue).toEqual(['second [Image #1]']);
    await waitFor(() => provider.requests.length === 2 && !controller.isBusy());
    await controller.idle();
    expect(lastUserBlocks(provider.requests[1])).toEqual([
      pasted.image,
      { type: 'text', text: 'second [Image #1]' },
    ]);
  });

  it('pastes an image from the clipboard', async () => {
    const reads: Array<() => Promise<Buffer | undefined>> = [
      async () => pngBytes(640, 480),
      async () => undefined,
      async () => {
        throw new ClipboardError('Pasting images needs xclip.');
      },
      async () => Buffer.from('plain text'),
    ];
    const { controller } = await setup([], { readClipboard: () => reads.shift()!() });

    const image = await controller.pasteClipboardImage();
    expect(image).toMatchObject({
      ok: true,
      attachment: {
        image: { type: 'image', mediaType: 'image/png', label: 'clipboard' },
        description: expect.stringMatching(/^clipboard · 640×480 · /),
      },
    });
    expect(await controller.pasteClipboardImage()).toEqual({
      ok: false,
      empty: true,
      message: 'No image in the clipboard',
    });
    expect(await controller.pasteClipboardImage()).toEqual({
      ok: false,
      empty: false,
      message: 'Pasting images needs xclip.',
    });
    expect(await controller.pasteClipboardImage()).toEqual({
      ok: false,
      empty: false,
      message: 'The clipboard image is not a PNG, JPEG, GIF or WebP image.',
    });
  });

  it('sends images attached to a custom command with its prompt', async () => {
    const { controller, provider, repo } = await setup([textResponse('Looked.')]);
    mkdirSync(join(repo, '.patch', 'commands'), { recursive: true });
    writeFileSync(
      join(repo, '.patch', 'commands', 'look.md'),
      '---\ndescription: Look closely\n---\nLook closely at $ARGUMENTS.\n',
    );
    controller.submit('/look [Image #1]', [pasted]);
    await controller.idle();

    expect(lastUserBlocks(provider.requests[0])).toEqual([
      pasted.image,
      { type: 'text', text: expect.stringContaining('Look closely at [Image #1].') },
    ]);
    expect(userItems(controller)).toEqual([
      expect.objectContaining({
        text: '/look [Image #1]',
        source: expect.stringContaining('look.md'),
        images: [PASTED_LINE],
      }),
    ]);
  });

  it('shows the image lines again when a session is resumed', async () => {
    const { controller } = await setup([textResponse('ok')]);
    controller.submit('What is [Image #1]?', [pasted]);
    await controller.idle();
    let next = 0;
    const items = buildTranscriptFromEntries(controller.session.entries(), () => `r${++next}`);
    expect(items.find((item) => item.kind === 'user')).toMatchObject({
      text: 'What is [Image #1]?',
      images: [PASTED_LINE],
    });
  });
});
