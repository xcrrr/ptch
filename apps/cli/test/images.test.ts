import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_FILE_BYTES,
  PathPolicy,
  PermissionManager,
  type PermissionRequest,
  type PermissionResponse,
} from '@patch/core';
import {
  ScriptedProvider,
  makeGitRepo,
  makeTempDir,
  pngBytes,
  textResponse,
} from '@patch/core/testing';
import { stripAnsi } from '@patch/shared';
import { runCli, type CliIO } from '../src/cli.js';
import {
  attachImageFile,
  describeStoredImage,
  imageLine,
  imageMentions,
  pastedImagePath,
} from '../src/images.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('pastedImagePath', () => {
  it('takes a pasted path to an image, quoted or not', () => {
    expect(pastedImagePath('docs/shot.png', 'linux')).toBe('docs/shot.png');
    expect(pastedImagePath('  /tmp/shot.PNG \n', 'linux')).toBe('/tmp/shot.PNG');
    expect(pastedImagePath("'/Users/me/My Shot.jpg' ", 'darwin')).toBe('/Users/me/My Shot.jpg');
    expect(pastedImagePath('"C:\\Users\\me\\My Shot.webp"', 'win32')).toBe(
      'C:\\Users\\me\\My Shot.webp',
    );
    expect(pastedImagePath('C:\\Users\\me\\shot.gif', 'win32')).toBe('C:\\Users\\me\\shot.gif');
  });

  it('unescapes paths that macOS and Linux terminals insert for a dropped file', () => {
    expect(pastedImagePath('/Users/me/Screen\\ Shot\\ 2026.png ', 'darwin')).toBe(
      '/Users/me/Screen Shot 2026.png',
    );
  });

  it('turns file:// URLs into paths', () => {
    expect(pastedImagePath('file:///home/me/a%20b.png', 'linux')).toBe('/home/me/a b.png');
    expect(pastedImagePath('file:///C:/Users/me/a.png', 'win32')).toBe('C:\\Users\\me\\a.png');
  });

  it('ignores anything that is not a single image path', () => {
    expect(pastedImagePath('src/index.ts', 'linux')).toBeUndefined();
    expect(pastedImagePath('a.png\nb.png', 'linux')).toBeUndefined();
    expect(pastedImagePath('   ', 'linux')).toBeUndefined();
    expect(pastedImagePath('file://%zz.png', 'linux')).toBeUndefined();
  });
});

describe('imageMentions', () => {
  it('finds @path mentions of image files in order, once each', () => {
    expect(
      imageMentions(
        'Compare @docs/a.png with @b.JPG, then @docs/a.png again (and @"my shot.gif").',
      ),
    ).toEqual(['docs/a.png', 'b.JPG', 'my shot.gif']);
    expect(imageMentions('@start.webp is first')).toEqual(['start.webp']);
  });

  it('ignores other mentions and addresses', () => {
    expect(imageMentions('ask @alice about src/app.ts and mail me@example.png')).toEqual([]);
    expect(imageMentions('see @src/app.ts')).toEqual([]);
  });
});

describe('image lines', () => {
  it('number images and describe stored ones from their data', () => {
    const data = pngBytes(64, 48).toString('base64');
    const line = imageLine(
      2,
      describeStoredImage({ type: 'image', mediaType: 'image/png', data, label: 'a.png' }),
    );
    expect(line).toMatch(/^\[Image #2\] a\.png · 64×48 · \d+ B$/);
    expect(describeStoredImage({ type: 'image', mediaType: 'image/png', data })).toMatch(
      /^image · 64×48/,
    );
  });
});

describe('attachImageFile', () => {
  function setup() {
    const project = makeTempDir('patch-project-');
    const outside = makeTempDir('patch-outside-');
    cleanups.push(project.cleanup, outside.cleanup);
    writeFileSync(join(project.dir, 'shot.png'), pngBytes(1280, 720));
    writeFileSync(join(project.dir, 'notes.png'), 'not an image');
    mkdirSync(join(project.dir, 'folder.png'));
    writeFileSync(join(outside.dir, 'desktop.png'), pngBytes(10, 10));
    mkdirSync(join(project.dir, '.ssh'));
    writeFileSync(join(project.dir, '.ssh', 'key.png'), pngBytes(1, 1));
    const permissions = new PermissionManager();
    const asked: PermissionRequest[] = [];
    const answers: PermissionResponse[] = [];
    const deps = {
      paths: new PathPolicy({ cwd: project.dir, projectRoot: project.dir, home: outside.dir }),
      permissions,
      requestPermission: async (request: PermissionRequest) => {
        asked.push(request);
        return answers.shift() ?? { decision: 'deny' as const };
      },
    };
    return { project: project.dir, outside: outside.dir, deps, asked, answers, permissions };
  }

  it('attaches an image inside the project without asking', async () => {
    const { deps, asked } = setup();
    const result = await attachImageFile('shot.png', deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment.image).toMatchObject({ mediaType: 'image/png', label: 'shot.png' });
    expect(result.attachment.description).toMatch(/^shot\.png · 1280×720 · \d+(\.\d)? KB$/);
    expect(asked).toEqual([]);
  });

  it('asks before reading an image outside the project, like read_file', async () => {
    const { deps, asked, answers, outside } = setup();
    const target = join(outside, 'desktop.png');
    const declined = await attachImageFile(target, deps);
    expect(declined).toEqual({
      ok: false,
      reason: 'denied',
      message: expect.stringMatching(/^Reading .*desktop\.png was not approved\.$/),
    });
    expect(asked[0]).toMatchObject({
      toolName: 'image',
      subject: { kind: 'read' },
      prompt: { title: 'Patch wants to read outside the project' },
    });

    answers.push({ decision: 'allow_once' });
    expect((await attachImageFile(target, deps)).ok).toBe(true);
    expect(asked).toHaveLength(2);
  });

  it('remembers a session approval the way read_file does', async () => {
    const { deps, asked, answers, outside, permissions } = setup();
    answers.push({ decision: 'allow_session' });
    expect((await attachImageFile(join(outside, 'desktop.png'), deps)).ok).toBe(true);
    expect(permissions.sessionGrants()).toEqual([{ kind: 'read-path', path: expect.any(String) }]);
    expect((await attachImageFile(join(outside, 'desktop.png'), deps)).ok).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it('asks for sensitive paths even inside the project', async () => {
    const { deps, asked } = setup();
    const result = await attachImageFile('.ssh/key.png', deps);
    expect(result).toMatchObject({ ok: false, reason: 'denied' });
    expect(asked[0]?.prompt.title).toBe('Patch wants to read a sensitive file');
  });

  it('follows deny rules without asking', async () => {
    const { deps, asked, outside } = setup();
    const strict = new PermissionManager({ config: { allow: [], deny: [`read:${outside}`] } });
    const result = await attachImageFile(join(outside, 'desktop.png'), {
      ...deps,
      permissions: strict,
    });
    expect(result).toMatchObject({ ok: false, reason: 'denied' });
    expect(asked).toEqual([]);
  });

  it('explains files that cannot be attached', async () => {
    const { deps } = setup();
    expect(await attachImageFile('missing.png', deps)).toEqual({
      ok: false,
      reason: 'missing',
      message: 'File not found: missing.png',
    });
    expect(await attachImageFile('folder.png', deps)).toMatchObject({
      reason: 'invalid',
      message: 'folder.png is a directory, not an image.',
    });
    expect(await attachImageFile('notes.png', deps)).toMatchObject({
      reason: 'invalid',
      message: 'notes.png is not a PNG, JPEG, GIF or WebP image.',
    });
  });

  it('refuses images over the size limit', async () => {
    const { deps, project } = setup();
    const big = Buffer.alloc(MAX_IMAGE_FILE_BYTES + 10);
    pngBytes(1, 1).copy(big);
    writeFileSync(join(project, 'big.png'), big);
    expect(await attachImageFile('big.png', deps)).toMatchObject({
      reason: 'invalid',
      message: expect.stringMatching(/^big\.png is too large to send/),
    });
  });
});

class Capture extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _encoding: string, callback: () => void): void {
    this.text += chunk.toString();
    callback();
  }
}

describe('print mode @mentions', () => {
  async function print(argv: string[], provider: ScriptedProvider) {
    const repo = makeGitRepo({ 'README.md': '# demo\n' });
    const home = makeTempDir('patch-home-');
    cleanups.push(repo.cleanup, home.cleanup);
    mkdirSync(join(repo.dir, 'docs'));
    writeFileSync(join(repo.dir, 'docs', 'shot.png'), pngBytes(320, 200));
    const stdout = new Capture();
    const stderr = new Capture();
    const io: Partial<CliIO> = {
      stdin: Readable.from([]) as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      env: { PATH: process.env.PATH, PATCH_HOME: home.dir },
      cwd: repo.dir,
      homeDir: home.dir,
      providerFactory: () => provider,
      assumeCredentials: true,
    };
    const code = await runCli(['-p', ...argv], io);
    return { code, stdout: stdout.text, stderr: stripAnsi(stderr.text) };
  }

  it('attaches mentioned images and keeps the prompt as typed', async () => {
    const provider = new ScriptedProvider([textResponse('A black rectangle.')]);
    const run = await print(['What is in @docs/shot.png? Not @missing.png.'], provider);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('A black rectangle.');
    expect(run.stderr).toMatch(/attached shot\.png · 320×200/);
    expect(run.stderr).toContain('@missing.png was not attached. File not found: missing.png');
    const message = provider.requests[0]!.messages.at(-1)!;
    expect(message.content.map((block) => block.type)).toEqual(['image', 'text']);
    expect(message.content[0]).toMatchObject({ type: 'image', label: 'shot.png' });
    expect(message.content[1]).toEqual({
      type: 'text',
      text: 'What is in @docs/shot.png? Not @missing.png.',
    });
  });
});
