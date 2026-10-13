import { spawn } from 'node:child_process';
import { AbortError } from '@patch/shared';

export interface RipgrepRunOptions {
  cwd: string;
  signal: AbortSignal;
  /** Separator between output records: "\n" for lines (JSON, counts), "\0" with `--null`. */
  delimiter: '\n' | '\0';
  /** Called for every non-empty output record, in order. */
  onRecord: (record: string) => void;
}

export interface RipgrepRunResult {
  /** 0 = matches, 1 = no matches, 2 = error (possibly alongside results). */
  exitCode: number | null;
  /** First part of stderr (rg errors such as regex parse failures). */
  stderr: string;
}

const MAX_STDERR_CHARS = 16_000;

/**
 * Common flags for every Patch search: ignore user config files (they could change the output
 * format), search hidden files but never `.git`, and honor .gitignore even outside a repository
 * so results match the fallback walker.
 */
export const RIPGREP_BASE_ARGS: readonly string[] = [
  '--no-config',
  '--hidden',
  '--no-require-git',
  '--glob',
  '!.git',
  '--no-messages',
];

/**
 * Runs ripgrep without a shell and streams its stdout records to `onRecord`. The process is
 * killed when `signal` aborts, which rejects with AbortError. Spawn failures reject with the
 * underlying error.
 */
export function runRipgrep(
  rgPath: string,
  args: string[],
  options: RipgrepRunOptions,
): Promise<RipgrepRunResult> {
  const { signal, delimiter, onRecord } = options;
  if (signal.aborted) return Promise.reject(new AbortError());
  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let pending = '';
    let stderr = '';
    let failure: unknown;

    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });

    const emit = (record: string) => {
      if (record === '' || failure !== undefined) return;
      try {
        onRecord(record);
      } catch (error) {
        failure = error;
        child.kill();
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      let start = 0;
      for (
        let end = pending.indexOf(delimiter);
        end !== -1;
        end = pending.indexOf(delimiter, start)
      ) {
        emit(pending.slice(start, end));
        start = end + 1;
      }
      pending = pending.slice(start);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
    });

    child.on('error', (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.aborted ? new AbortError() : error);
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        reject(new AbortError());
        return;
      }
      emit(pending);
      if (failure !== undefined) reject(failure);
      else resolve({ exitCode: code, stderr: stderr.slice(0, MAX_STDERR_CHARS) });
    });
  });
}

/** rg's error text without the "rg: " prefixes, trimmed. */
export function cleanRipgrepError(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.replace(/^rg: /, ''))
    .join('\n')
    .trim();
}
