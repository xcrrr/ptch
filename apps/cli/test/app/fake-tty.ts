import { EventEmitter } from 'node:events';

/** Ink's "repaint everything" path starts with this (ansi-escapes clearTerminal), as does ours. */
export const CLEAR = '\u001b[2J';

/** A terminal output stream that records everything written to it. */
export class FakeTtyOutput extends EventEmitter {
  readonly isTTY = true;
  columns: number;
  rows: number;
  output = '';

  constructor(columns = 80, rows = 24) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  write = (chunk: string | Uint8Array, encoding?: unknown, callback?: unknown): boolean => {
    this.output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') (done as () => void)();
    return true;
  };

  /** How many times the screen was cleared in the output written after `from`. */
  clearsSince(from: number): number {
    return this.output.slice(from).split(CLEAR).length - 1;
  }
}

/** A raw-mode terminal input stream; `type` delivers keys the way a terminal does. */
export class FakeTtyInput extends EventEmitter {
  readonly isTTY = true;
  private data: string | null = null;

  type(text: string): void {
    this.data = text;
    this.emit('readable');
    this.emit('data', text);
  }

  read = (): string | null => {
    const { data } = this;
    this.data = null;
    return data;
  };

  setEncoding(): this {
    return this;
  }
  setRawMode(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

export function fakeTerminal(columns = 80, rows = 24) {
  const stdout = new FakeTtyOutput(columns, rows);
  const stdin = new FakeTtyInput();
  const stderr = new FakeTtyOutput(columns, rows);
  return {
    stdout,
    stdin,
    stderr,
    /** The streams typed as Node's, for runInteractive/runCli. */
    io: {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
    },
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
