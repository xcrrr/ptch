import { createRequire } from 'node:module';
import { render } from 'ink';
import type * as XtermHeadless from '@xterm/headless';
import { CloudApp } from '../../src/cloudview/CloudApp.js';
import type { CloudViewController } from '../../src/cloudview/controller.js';
import { emptyComposer } from '../../src/ui/composer-state.js';
import { FakeTtyInput, FakeTtyOutput } from '../app/fake-tty.js';

const require = createRequire(import.meta.url);
const xterm = require('@xterm/headless') as typeof XtermHeadless;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A terminal output that also feeds a headless xterm, so tests read the real screen. */
class ScreenOutput extends FakeTtyOutput {
  readonly term: InstanceType<typeof xterm.Terminal>;

  constructor(columns: number, rows: number) {
    super(columns, rows);
    this.term = new xterm.Terminal({
      cols: columns,
      rows,
      allowProposedApi: true,
      scrollback: 5_000,
    });
  }

  override write = (
    chunk: string | Uint8Array,
    encoding?: unknown,
    callback?: unknown,
  ): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    this.output += text;
    // A terminal turns LF into CR LF on output (a pseudo-terminal does it for the real thing).
    this.term.write(text.replace(/\r?\n/g, '\r\n'));
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') (done as () => void)();
    return true;
  };
}

export interface MountedView {
  /** Types keys the way a terminal delivers them. */
  type(...inputs: string[]): Promise<void>;
  /** The visible screen (viewport) as text, trailing spaces removed. */
  screen(): Promise<string>;
  /** Everything: scrollback and screen. */
  transcript(): Promise<string>;
  /** Waits until the screen contains `text`. */
  waitFor(text: string, timeoutMs?: number): Promise<string>;
  /** Waits until the view has exited. */
  exited(): Promise<void>;
  stdout: ScreenOutput;
  unmount(): void;
}

export const KEY = {
  enter: '\r',
  esc: '\u001b',
  up: '\u001b[A',
  down: '\u001b[B',
  ctrlC: '\u0003',
  shiftEnter: '\u001b\r',
} as const;

/** Runs the real cloud view in a headless terminal of the given size. */
export function mountView(
  controller: CloudViewController,
  options: { columns?: number; rows?: number; splash?: boolean } = {},
): MountedView {
  const stdout = new ScreenOutput(options.columns ?? 80, options.rows ?? 30);
  const stdin = new FakeTtyInput();
  let exit: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (exit = resolve));
  const instance = render(
    <CloudApp
      controller={controller}
      initialComposer={emptyComposer}
      splash={options.splash ?? false}
      onRemount={() => undefined}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new FakeTtyOutput() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: 60,
    },
  );
  void instance.waitUntilExit().then(exit);

  const screen = async (): Promise<string> => {
    await sleep(40);
    await new Promise<void>((resolve) => stdout.term.write('', resolve));
    const buffer = stdout.term.buffer.active;
    const lines: string[] = [];
    for (let i = buffer.viewportY; i < buffer.viewportY + stdout.rows; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    }
    return lines.join('\n').replace(/\n+$/, '');
  };
  const transcript = async (): Promise<string> => {
    await screen();
    const buffer = stdout.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++)
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n').replace(/\n+$/, '');
  };
  return {
    stdout,
    screen,
    transcript,
    async type(...inputs) {
      for (const input of inputs) {
        stdin.type(input);
        await sleep(input === KEY.esc ? 60 : 25);
      }
    },
    async waitFor(text, timeoutMs = 4_000) {
      const deadline = Date.now() + timeoutMs;
      let last = '';
      while (Date.now() < deadline) {
        last = await transcript();
        if (last.includes(text)) return last;
        await sleep(20);
      }
      throw new Error(
        `Timed out waiting for "${text}".\n----- screen -----\n${last}\n------------------`,
      );
    },
    exited: () => done,
    unmount: () => instance.unmount(),
  };
}
