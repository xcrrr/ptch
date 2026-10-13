import { existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pngBytes } from '@patch/core/testing';
import {
  ClipboardError,
  readClipboardImage,
  runProgram,
  type ProgramResult,
  type RunProgramOptions,
} from '../src/clipboard.js';

const PNG = pngBytes(2, 2);

interface Call {
  file: string;
  args: string[];
  options: RunProgramOptions;
}

/** A runner that records calls and answers each with the next scripted result. */
function scriptedRunner(...results: Array<(call: Call) => Partial<ProgramResult>>) {
  const calls: Call[] = [];
  const run = async (file: string, args: string[], options: RunProgramOptions) => {
    const call = { file, args, options };
    calls.push(call);
    const next = results.shift();
    if (!next) throw new Error(`unexpected call: ${file} ${args.join(' ')}`);
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: '', ...next(call) };
  };
  return { run, calls };
}

const outputFile = (call: Call) => call.options.env['PATCH_CLIPBOARD_FILE'] ?? '';

describe('readClipboardImage on Windows', () => {
  const env = { SystemRoot: 'C:\\Windows', PATH: '' };

  it('saves the clipboard image through Windows PowerShell and removes the temp file', async () => {
    let written = '';
    const { run, calls } = scriptedRunner((call) => {
      written = outputFile(call);
      writeFileSync(written, PNG);
      return {};
    });
    const bytes = await readClipboardImage({ platform: 'win32', env, run });

    expect(bytes?.equals(PNG)).toBe(true);
    expect(calls[0]!.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(calls[0]!.args.slice(0, 4)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-STA',
    ]);
    expect(calls[0]!.args.at(-1)).toContain('Get-Clipboard -Format Image');
    expect(calls[0]!.options.timeoutMs).toBeGreaterThan(0);
    expect(existsSync(dirname(written))).toBe(false);
  });

  it('reports an empty clipboard', async () => {
    const { run } = scriptedRunner(() => ({ exitCode: 3 }));
    expect(await readClipboardImage({ platform: 'win32', env, run })).toBeUndefined();
  });

  it('turns failures and timeouts into a ClipboardError', async () => {
    const failing = scriptedRunner(() => ({ exitCode: 1, stderr: 'Exception: boom\nat line 3' }));
    await expect(readClipboardImage({ platform: 'win32', env, run: failing.run })).rejects.toThrow(
      new ClipboardError(
        'Could not read the clipboard (PowerShell exited with code 1: Exception: boom).',
      ),
    );
    const slow = scriptedRunner(() => ({ exitCode: null }));
    await expect(readClipboardImage({ platform: 'win32', env, run: slow.run })).rejects.toThrow(
      'Reading the clipboard took too long and was stopped.',
    );
  });
});

describe('readClipboardImage on macOS', () => {
  it('uses pngpaste when it is installed', async () => {
    const { run, calls } = scriptedRunner(() => ({ stdout: PNG }));
    const bytes = await readClipboardImage({
      platform: 'darwin',
      env: {},
      run,
      findProgram: async (name) => (name === 'pngpaste' ? '/opt/homebrew/bin/pngpaste' : undefined),
    });
    expect(bytes?.equals(PNG)).toBe(true);
    expect(calls.map((call) => [call.file, ...call.args])).toEqual([
      ['/opt/homebrew/bin/pngpaste', '-'],
    ]);
  });

  it('reports an empty clipboard from pngpaste', async () => {
    const { run } = scriptedRunner(() => ({
      exitCode: 1,
      stderr: 'No PNG data found on the clipboard!',
    }));
    const bytes = await readClipboardImage({
      platform: 'darwin',
      env: {},
      run,
      findProgram: async () => '/usr/local/bin/pngpaste',
    });
    expect(bytes).toBeUndefined();
  });

  it('falls back to osascript writing PNG data to a temp file', async () => {
    let script = '';
    const { run, calls } = scriptedRunner(
      (call) => {
        script = call.args[1] ?? '';
        writeFileSync(outputFile(call), PNG);
        return { stdout: Buffer.from('ok\n') };
      },
      () => ({ stdout: Buffer.from('none\n') }),
    );
    const options = {
      platform: 'darwin' as const,
      env: {},
      run,
      findProgram: async () => undefined,
    };

    expect((await readClipboardImage(options))?.equals(PNG)).toBe(true);
    expect(calls[0]!.file).toBe('/usr/bin/osascript');
    expect(script).toContain('\u00abclass PNGf\u00bb');
    expect(await readClipboardImage(options)).toBeUndefined();
  });
});

describe('readClipboardImage on Linux', () => {
  it('uses wl-paste on Wayland when the clipboard offers PNG', async () => {
    const { run, calls } = scriptedRunner(
      () => ({ stdout: Buffer.from('text/plain\nimage/png\n') }),
      () => ({ stdout: PNG }),
    );
    const bytes = await readClipboardImage({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      run,
      findProgram: async (name) => `/usr/bin/${name}`,
    });
    expect(bytes?.equals(PNG)).toBe(true);
    expect(calls.map((call) => call.args)).toEqual([
      ['--list-types'],
      ['--no-newline', '--type', 'image/png'],
    ]);
  });

  it('uses xclip on X11 and reports a clipboard without an image', async () => {
    const { run, calls } = scriptedRunner(() => ({
      stdout: Buffer.from('TARGETS\nUTF8_STRING\n'),
    }));
    const bytes = await readClipboardImage({
      platform: 'linux',
      env: { DISPLAY: ':0' },
      run,
      findProgram: async (name) => (name === 'xclip' ? '/usr/bin/xclip' : undefined),
    });
    expect(bytes).toBeUndefined();
    expect(calls[0]!.args).toEqual(['-selection', 'clipboard', '-t', 'TARGETS', '-o']);
  });

  it('says which tool to install when none is available', async () => {
    const { run } = scriptedRunner();
    await expect(
      readClipboardImage({
        platform: 'linux',
        env: { WAYLAND_DISPLAY: 'wayland-0' },
        run,
        findProgram: async () => undefined,
      }),
    ).rejects.toThrow('Pasting images needs wl-paste (from wl-clipboard) or xclip.');
  });
});

describe('runProgram', () => {
  it('collects output and the exit code without a shell', async () => {
    const result = await runProgram(
      process.execPath,
      ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(4)'],
      { env: process.env, timeoutMs: 10_000 },
    );
    expect(result).toEqual({ exitCode: 4, stdout: Buffer.from('out'), stderr: 'err' });
  });

  it('stops a program at the timeout', async () => {
    const result = await runProgram(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: process.env,
      timeoutMs: 200,
    });
    expect(result.exitCode).toBeNull();
  });

  it('reports a program that cannot start', async () => {
    const result = await runProgram('/definitely/not/a/program', [], {
      env: process.env,
      timeoutMs: 1_000,
    });
    expect(result.exitCode).toBe(-1);
  });
});
