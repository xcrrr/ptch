import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

/** How long a clipboard command may run (Windows PowerShell alone takes about half a second). */
export const CLIPBOARD_TIMEOUT_MS = 10_000;
/** Output kept from a clipboard command; an image beyond this is far over the size limit anyway. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_CHARS = 10_000;
/** Exit code of the Windows script when the clipboard holds no image. */
const NO_IMAGE_EXIT_CODE = 3;
/** Environment variable that passes the output file to the Windows and macOS scripts. */
const OUTPUT_FILE_VARIABLE = 'PATCH_CLIPBOARD_FILE';

/**
 * Windows PowerShell 5.1 (it ships with Windows; PowerShell 7 dropped `Get-Clipboard -Format`):
 * saves the clipboard image as PNG, or exits with NO_IMAGE_EXIT_CODE.
 */
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Drawing',
  '$image = Get-Clipboard -Format Image',
  `if ($null -eq $image) { exit ${NO_IMAGE_EXIT_CODE} }`,
  `$image.Save($env:${OUTPUT_FILE_VARIABLE}, [System.Drawing.Imaging.ImageFormat]::Png)`,
].join('\n');

/** macOS: writes the clipboard's PNG data to the output file; prints "none" when there is none. */
const MACOS_SCRIPT = [
  'try',
  '  set png to (the clipboard as \u00abclass PNGf\u00bb)',
  'on error',
  '  return "none"',
  'end try',
  `set target to POSIX file (system attribute "${OUTPUT_FILE_VARIABLE}")`,
  'set handle to open for access target with write permission',
  'write png to handle',
  'close access handle',
  'return "ok"',
].join('\n');

export interface ProgramResult {
  /** null when the program was killed (timeout). */
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
}

export interface RunProgramOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type ProgramRunner = (
  file: string,
  args: string[],
  options: RunProgramOptions,
) => Promise<ProgramResult>;

export interface ClipboardOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Runs a program (injected by tests). */
  run?: ProgramRunner;
  /** Absolute path of a program on PATH, or undefined (injected by tests). */
  findProgram?: (name: string) => Promise<string | undefined>;
  timeoutMs?: number;
}

/** Reading the clipboard failed for a reason worth telling the user. */
export class ClipboardError extends Error {
  override readonly name = 'ClipboardError';
}

/**
 * Reads an image from the system clipboard: the image bytes, or undefined when the clipboard
 * holds no image. Uses tools that ship with the OS or are common:
 *  - Windows: Windows PowerShell's `Get-Clipboard -Format Image`, saved as PNG to a temp file.
 *  - macOS: `pngpaste` when installed, else `osascript` («class PNGf») into a temp file.
 *  - Linux: `wl-paste --type image/png` on Wayland, else `xclip -selection clipboard -t image/png`.
 * Programs run without a shell or a console window, with a timeout; temp files go to a fresh
 * directory in the OS temp directory that is always removed. Throws ClipboardError when no
 * clipboard tool is available or one fails.
 */
export async function readClipboardImage(
  options: ClipboardOptions = {},
): Promise<Buffer | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const context: ReadContext = {
    env,
    run: options.run ?? runProgram,
    findProgram: options.findProgram ?? ((name) => findOnPath(name, env)),
    timeoutMs: options.timeoutMs ?? CLIPBOARD_TIMEOUT_MS,
  };
  switch (platform) {
    case 'win32':
      return readWindowsClipboard(context);
    case 'darwin':
      return readMacClipboard(context);
    default:
      return readLinuxClipboard(context);
  }
}

interface ReadContext {
  env: NodeJS.ProcessEnv;
  run: ProgramRunner;
  findProgram: (name: string) => Promise<string | undefined>;
  timeoutMs: number;
}

async function readWindowsClipboard(context: ReadContext): Promise<Buffer | undefined> {
  const systemRoot = context.env['SystemRoot'] ?? context.env['windir'] ?? 'C:\\Windows';
  const powershell = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return withOutputFile(async (file) => {
    const result = await runChecked(
      context,
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_SCRIPT],
      file,
    );
    if (result.exitCode === NO_IMAGE_EXIT_CODE) return undefined;
    if (result.exitCode !== 0) throw failure('PowerShell', result);
    return readFile(file);
  });
}

async function readMacClipboard(context: ReadContext): Promise<Buffer | undefined> {
  const pngpaste = await context.findProgram('pngpaste');
  if (pngpaste) {
    const result = await runChecked(context, pngpaste, ['-']);
    // pngpaste exits with 1 and "No PNG data found on the clipboard!" when there is no image.
    if (result.exitCode === 0 && result.stdout.length > 0) return result.stdout;
    if (/no .*data found/i.test(result.stderr)) return undefined;
    throw failure('pngpaste', result);
  }
  return withOutputFile(async (file) => {
    const result = await runChecked(context, '/usr/bin/osascript', ['-e', MACOS_SCRIPT], file);
    if (result.exitCode !== 0) throw failure('osascript', result);
    if (result.stdout.toString('utf8').trim() === 'none') return undefined;
    return readFile(file);
  });
}

async function readLinuxClipboard(context: ReadContext): Promise<Buffer | undefined> {
  const wayland = Boolean(context.env['WAYLAND_DISPLAY']);
  const wlPaste = wayland ? await context.findProgram('wl-paste') : undefined;
  if (wlPaste) {
    const types = await runChecked(context, wlPaste, ['--list-types']);
    // Fails (with "No selection") when the clipboard is empty.
    if (types.exitCode !== 0 || !hasPngType(types.stdout)) return undefined;
    const image = await runChecked(context, wlPaste, ['--no-newline', '--type', 'image/png']);
    if (image.exitCode !== 0) throw failure('wl-paste', image);
    return image.stdout.length > 0 ? image.stdout : undefined;
  }
  const xclip = await context.findProgram('xclip');
  if (xclip) {
    const selection = ['-selection', 'clipboard'];
    const targets = await runChecked(context, xclip, [...selection, '-t', 'TARGETS', '-o']);
    if (targets.exitCode !== 0 || !hasPngType(targets.stdout)) return undefined;
    const image = await runChecked(context, xclip, [...selection, '-t', 'image/png', '-o']);
    if (image.exitCode !== 0) throw failure('xclip', image);
    return image.stdout.length > 0 ? image.stdout : undefined;
  }
  throw new ClipboardError(
    wayland
      ? 'Pasting images needs wl-paste (from wl-clipboard) or xclip.'
      : 'Pasting images needs xclip.',
  );
}

function hasPngType(list: Buffer): boolean {
  return list
    .toString('utf8')
    .split(/\r?\n/)
    .some((type) => type.trim() === 'image/png');
}

/** Runs a clipboard program; a timeout becomes a ClipboardError. */
async function runChecked(
  context: ReadContext,
  file: string,
  args: string[],
  outputFile?: string,
): Promise<ProgramResult> {
  const env = outputFile ? { ...context.env, [OUTPUT_FILE_VARIABLE]: outputFile } : context.env;
  const result = await context.run(file, args, { env, timeoutMs: context.timeoutMs });
  if (result.exitCode === null) {
    throw new ClipboardError('Reading the clipboard took too long and was stopped.');
  }
  return result;
}

function failure(program: string, result: ProgramResult): ClipboardError {
  const detail = result.stderr.trim().split(/\r?\n/)[0]?.trim();
  return new ClipboardError(
    `Could not read the clipboard (${program} exited with code ${result.exitCode}${detail ? `: ${detail}` : ''}).`,
  );
}

/** Runs `work` with a path for an output file in a fresh temp directory, then removes it. */
async function withOutputFile<T>(work: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'patch-clipboard-'));
  try {
    return await work(path.join(dir, 'clipboard.png'));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}

/** Absolute path of an executable named `name` in an absolute PATH directory. */
async function findOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const dirs = (env['PATH'] ?? '')
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter((dir) => dir !== '' && path.isAbsolute(dir));
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/**
 * Runs a program without a shell and without a console window, stdin closed, from the OS temp
 * directory (never the project, where a planted DLL or script could be picked up). Kills it after
 * `timeoutMs` (exitCode null). Never rejects for a failing program: a failure to start is reported
 * like an exit code of -1.
 */
export function runProgram(
  file: string,
  args: string[],
  options: RunProgramOptions,
): Promise<ProgramResult> {
  return new Promise((resolve) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(file, args, {
        cwd: tmpdir(),
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ exitCode: -1, stdout: Buffer.alloc(0), stderr: String(error) });
      return;
    }
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let oversized = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    const finish = (result: ProgramResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) {
        stdout.push(chunk);
      } else if (!oversized) {
        oversized = true;
        child.kill();
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
    });
    child.once('error', (error) => {
      finish({ exitCode: -1, stdout: Buffer.alloc(0), stderr: error.message });
    });
    child.once('close', (code) => {
      if (oversized) {
        finish({ exitCode: -1, stdout: Buffer.alloc(0), stderr: 'the output was too large' });
        return;
      }
      finish({ exitCode: timedOut ? null : (code ?? -1), stdout: Buffer.concat(stdout), stderr });
    });
  });
}
