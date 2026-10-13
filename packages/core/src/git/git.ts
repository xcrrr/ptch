import { execFile, type ExecFileException } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AbortError, formatBytes, formatDuration, throwIfAborted } from '@patch/shared';
import { nativePathFromGit } from './repo-path.js';

export interface GitRepoInfo {
  /** Absolute repository root (native path separators). */
  root: string;
  /** Current branch, or null when detached. */
  branch: string | null;
  /** Short HEAD sha, or null for a repository without commits. */
  head: string | null;
  detached: boolean;
  hasCommits: boolean;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * True when stdout exceeded `maxBuffer`: git was stopped, `stdout` holds the first `maxBuffer`
   * bytes and `exitCode` is 0.
   */
  truncated?: boolean;
}

export interface GitRunOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Default 15s. */
  timeoutMs?: number;
  /** Max stdout bytes kept (default 20 MB). */
  maxBuffer?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;

/** A git invocation that could not complete (timeout, crash) or failed in a way callers report. */
export class GitCommandError extends Error {
  override readonly name = 'GitCommandError';
  /** Exit code, or null when git did not exit normally (timeout, signal). */
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(message: string, exitCode: number | null, stderr = '') {
    super(message);
    this.exitCode = exitCode;
    this.stderr = stderr;
  }

  /** Builds an error from a non-zero exit, using git's own first diagnostic line. */
  static fromResult(subcommand: string, result: GitRunResult): GitCommandError {
    const reason = firstDiagnostic(result.stderr) ?? `exit code ${result.exitCode}`;
    return new GitCommandError(
      `git ${subcommand} failed: ${reason}`,
      result.exitCode,
      result.stderr,
    );
  }
}

function firstDiagnostic(stderr: string): string | undefined {
  const line = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('warning:') && !l.startsWith('hint:'));
  return line?.replace(/^(fatal|error):\s*/, '');
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
  };
}

interface ExecOutcome {
  error: ExecFileException | null;
  stdout: string;
  stderr: string;
}

function execGit(args: string[], options: GitRunOptions, timeoutMs: number, maxBuffer: number) {
  return new Promise<ExecOutcome>((resolve, reject) => {
    try {
      execFile(
        'git',
        args,
        {
          cwd: options.cwd,
          env: gitEnvironment(),
          encoding: 'utf8',
          windowsHide: true,
          timeout: timeoutMs,
          maxBuffer,
          signal: options.signal,
        },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }),
      );
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Runs `git` without a shell (execFile), with GIT_OPTIONAL_LOCKS=0, GIT_TERMINAL_PROMPT=0,
 * GIT_PAGER=cat, LC_ALL=C and `-c core.quotepath=off` so output is stable and non-interactive.
 * Resolves with the exit code instead of throwing on non-zero exit. Throws `GitUnavailableError`
 * if the git binary cannot be found.
 *
 * Also throws `AbortError` when `signal` fires and `GitCommandError` when git times out or is
 * killed. Output beyond `maxBuffer` is dropped and reported with `truncated: true`.
 */
export async function runGit(args: string[], options: GitRunOptions): Promise<GitRunResult> {
  throwIfAborted(options.signal);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const { error, stdout, stderr } = await execGit(
    ['-c', 'core.quotepath=off', ...args],
    options,
    timeoutMs,
    maxBuffer,
  );
  if (!error) return { stdout, stderr, exitCode: 0 };

  const subcommand = args.find((arg) => !arg.startsWith('-')) ?? 'git';
  if (options.signal?.aborted || error.name === 'AbortError') throw new AbortError();
  if (error.code === 'ENOENT') {
    // Node reports a missing working directory as ENOENT for the binary, too.
    if (!(await isDirectory(options.cwd))) {
      throw new GitCommandError(`Cannot run git: directory not found: ${options.cwd}`, null);
    }
    throw new GitUnavailableError('Git is not installed or not on PATH.');
  }
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    // Node names the overflowing stream first: "stdout maxBuffer length exceeded".
    if (error.message.startsWith('stdout')) return { stdout, stderr, exitCode: 0, truncated: true };
    throw new GitCommandError(
      `git ${subcommand} wrote more than ${formatBytes(maxBuffer)} of diagnostics`,
      null,
    );
  }
  if (typeof error.code === 'number') return { stdout, stderr, exitCode: error.code };
  if (error.killed) {
    throw new GitCommandError(
      `git ${subcommand} timed out after ${formatDuration(timeoutMs)}`,
      null,
      stderr,
    );
  }
  const reason = error.signal ? `was terminated by ${error.signal}` : 'could not be run';
  throw new GitCommandError(`git ${subcommand} ${reason}`, null, stderr);
}

export class GitUnavailableError extends Error {
  override readonly name = 'GitUnavailableError';
}

let gitAvailability: Promise<boolean> | undefined;

function probeDirectory(): string {
  try {
    return process.cwd();
  } catch {
    return tmpdir();
  }
}

/** True when a git binary is on PATH. Cached. */
export async function isGitAvailable(): Promise<boolean> {
  gitAvailability ??= runGit(['--version'], { cwd: probeDirectory(), timeoutMs: 5_000 }).then(
    (result) => result.exitCode === 0,
    () => false,
  );
  return gitAvailability;
}

function firstLine(output: string): string | null {
  const line = output.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return line === '' ? null : line;
}

/** Returns repository info for `cwd`, or null when not inside a work tree or git is unavailable. */
export async function detectGitRepo(cwd: string): Promise<GitRepoInfo | null> {
  try {
    const toplevel = await runGit(['rev-parse', '--show-toplevel'], { cwd });
    const printedRoot = toplevel.stdout.replace(/\r?\n$/, '');
    // Bare repositories and the inside of .git fail here ("must be run in a work tree").
    if (toplevel.exitCode !== 0 || printedRoot === '') return null;

    const [symbolicRef, headRev] = await Promise.all([
      runGit(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd }),
      runGit(['rev-parse', '--short', '--verify', '-q', 'HEAD'], { cwd }),
    ]);
    const branch = symbolicRef.exitCode === 0 ? firstLine(symbolicRef.stdout) : null;
    const head = headRev.exitCode === 0 ? firstLine(headRev.stdout) : null;
    return {
      root: nativePathFromGit(printedRoot),
      branch,
      head,
      detached: branch === null,
      hasCommits: head !== null,
    };
  } catch {
    return null;
  }
}
