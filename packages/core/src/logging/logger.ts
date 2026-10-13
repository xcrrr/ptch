import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from './redact.js';
import { serializeLogData, truncateForLog } from './serialize.js';

export { redactSecrets };

/**
 * Debug logging. Disabled by default; enabled with `PATCH_DEBUG=1` or `--debug`.
 * Logs go to a file under ~/.patch/logs (never to the interactive terminal) and are redacted.
 */
export interface Logger {
  readonly enabled: boolean;
  /** Absolute path of the log file when enabled. */
  readonly filePath?: string;
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  /** Returns a logger that prefixes messages with `[scope]`. */
  child(scope: string): Logger;
}

export const noopLogger: Logger = {
  enabled: false,
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

export interface CreateLoggerOptions {
  enabled: boolean;
  /** Directory for log files, e.g. ~/.patch/logs. Created on demand. */
  dir: string;
  /** Injected clock for tests. */
  now?: () => Date;
}

/** Logs can contain code and command output: keep them private to the user. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * Creates a file logger writing one line per entry to `<dir>/patch-YYYY-MM-DD.log`:
 * `2026-10-07T12:00:00.000Z DEBUG [scope] message {"json":"data"}`.
 * Must redact secrets (see `redactSecrets`) in both message and data. Must never throw
 * (logging failures are swallowed). Returns `noopLogger` when disabled.
 *
 * The file name uses the UTC date at creation, like the line timestamps. Line breaks in messages
 * are escaped so every entry stays on one line. Nested children prefix every scope:
 * `[agent] [tools]`.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  if (!options.enabled) return noopLogger;
  const now = options.now ?? (() => new Date());
  const filePath = join(options.dir, `patch-${now().toISOString().slice(0, 10)}.log`);
  return new FileLogger(new LogFile(options.dir, filePath), now, '');
}

/** Appends lines to the log file, creating its directory on first use (and again if removed). */
class LogFile {
  private dirReady = false;

  constructor(
    private readonly dir: string,
    readonly path: string,
  ) {}

  append(line: string): void {
    if (this.tryAppend(line)) return;
    // The directory may have been removed while Patch runs: recreate it and retry once.
    this.dirReady = false;
    this.tryAppend(line);
  }

  private tryAppend(line: string): boolean {
    try {
      if (!this.dirReady) {
        mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
        this.dirReady = true;
      }
      appendFileSync(this.path, line, { mode: FILE_MODE });
      return true;
    } catch {
      return false; // Logging must never disturb Patch.
    }
  }
}

class FileLogger implements Logger {
  readonly enabled = true;

  constructor(
    private readonly file: LogFile,
    private readonly now: () => Date,
    /** Rendered scopes, e.g. "[agent] [tools] ". */
    private readonly prefix: string,
  ) {}

  get filePath(): string {
    return this.file.path;
  }

  debug(message: string, data?: unknown): void {
    this.write('DEBUG', message, data);
  }

  info(message: string, data?: unknown): void {
    this.write('INFO', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.write('WARN', message, data);
  }

  error(message: string, data?: unknown): void {
    this.write('ERROR', message, data);
  }

  child(scope: string): Logger {
    return new FileLogger(this.file, this.now, `${this.prefix}[${singleLine(scope)}] `);
  }

  private write(level: Level, message: string, data: unknown): void {
    try {
      let line = `${this.now().toISOString()} ${level} ${this.prefix}${singleLine(message)}`;
      if (data !== undefined) line += ` ${serializeLogData(data)}`;
      this.file.append(`${redactSecrets(line)}\n`);
    } catch {
      // Logging must never disturb Patch (e.g. a broken clock or a hostile toString).
    }
  }
}

function singleLine(text: unknown): string {
  return truncateForLog(String(text)).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}
