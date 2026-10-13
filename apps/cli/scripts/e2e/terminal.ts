/**
 * Drives the built `ptch` binary in a real pseudo-terminal and renders its output with a
 * headless xterm, so scenarios can read exactly what a user would see on screen.
 */
import type * as NodePty from '@lydell/node-pty';
import type * as XtermHeadless from '@xterm/headless';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderSvg, type RenderedSvg, type SvgOptions } from './svg.js';

type IPty = NodePty.IPty;

// Both packages are CommonJS with dynamically assigned exports; require them directly.
const require = createRequire(import.meta.url);
const { spawn } = require('@lydell/node-pty') as typeof NodePty;
const xterm = require('@xterm/headless') as typeof XtermHeadless;

const here = dirname(fileURLToPath(import.meta.url));
export const MAIN_JS = join(here, '..', '..', 'dist', 'main.js');

const KEYS = {
  enter: '\r',
  esc: '\u001B',
  up: '\u001B[A',
  down: '\u001B[B',
  left: '\u001B[D',
  right: '\u001B[C',
  tab: '\t',
  'shift-tab': '\u001B[Z',
  backspace: '\u007F',
  'ctrl-c': '\u0003',
  'ctrl-d': '\u0004',
  'ctrl-l': '\u000C',
  'ctrl-o': '\u000F',
  'alt-enter': '\u001B\r',
} as const;

export type KeyName = keyof typeof KEYS;

export interface TerminalOptions {
  cwd: string;
  args?: string[];
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /** Run the cloud view (the default `ptch`). Otherwise the local agent UI is switched on. */
  cloud?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TerminalSession {
  readonly cols: number;
  readonly rows: number;
  private readonly pty: IPty;
  private readonly term: InstanceType<typeof xterm.Terminal>;
  private exitCode: number | null = null;
  readonly exited: Promise<number>;
  private rawOutput = '';

  private constructor(options: TerminalOptions) {
    this.cols = options.cols ?? 100;
    this.rows = options.rows ?? 32;
    this.term = new xterm.Terminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: 20_000,
      allowProposedApi: true,
    });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      // CI variables are left out too: Ink renders only the final frame when it detects CI.
      const ci = key === 'CI' || key === 'CONTINUOUS_INTEGRATION';
      if (
        value !== undefined &&
        !ci &&
        !key.startsWith('ANTHROPIC_') &&
        !key.startsWith('PATCH_')
      ) {
        env[key] = value;
      }
    }
    // `ptch` opens Patch Cloud; the local agent UI needs the developers' switch.
    Object.assign(
      env,
      { FORCE_COLOR: '1', TERM: 'xterm-256color' },
      options.cloud ? {} : { PATCH_ENABLE_LOCAL: '1' },
      options.env ?? {},
    );
    this.pty = spawn(process.execPath, [MAIN_JS, ...(options.args ?? [])], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: options.cwd,
      env,
    });
    this.pty.onData((data) => {
      this.rawOutput += data;
      this.term.write(data);
    });
    this.exited = new Promise((resolve) => {
      this.pty.onExit(({ exitCode }) => {
        this.exitCode = exitCode;
        resolve(exitCode);
      });
    });
  }

  static start(options: TerminalOptions): TerminalSession {
    return new TerminalSession(options);
  }

  get hasExited(): boolean {
    return this.exitCode !== null;
  }

  /** Writes raw input (one chunk; multi-character input is seen as a paste by the app). */
  write(data: string): void {
    this.pty.write(data);
  }

  /** Types text one character at a time, like a person. */
  async type(text: string, delayMs = 4): Promise<void> {
    for (const char of text) {
      this.pty.write(char);
      await sleep(delayMs);
    }
  }

  async press(key: KeyName, times = 1): Promise<void> {
    for (let i = 0; i < times; i++) {
      this.pty.write(KEYS[key]);
      await sleep(60);
    }
  }

  /** Types a line and presses Enter. */
  async submit(text: string): Promise<void> {
    await this.type(text);
    await sleep(80);
    await this.press('enter');
  }

  private flush(): Promise<void> {
    return new Promise((resolve) => this.term.write('', () => resolve()));
  }

  /** Visible screen (viewport) as text, trailing spaces trimmed. */
  async screen(): Promise<string> {
    await this.flush();
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = buffer.viewportY; i < buffer.viewportY + this.rows; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    }
    return lines.join('\n').replace(/\n+$/, '');
  }

  /** Whole buffer including scrollback. */
  async transcript(): Promise<string> {
    await this.flush();
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    }
    return lines.join('\n').replace(/\n+$/, '');
  }

  /** The buffer (scrollback included, blank rows at either end dropped) as an SVG picture. */
  async svg(options: SvgOptions = {}): Promise<RenderedSvg> {
    await this.flush();
    return renderSvg(this.term, options);
  }

  /** Waits until the screen (or whole transcript) matches. */
  async waitFor(
    match: string | RegExp | ((screen: string) => boolean),
    options: { timeoutMs?: number; inTranscript?: boolean } = {},
  ): Promise<string> {
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    let last = '';
    while (Date.now() < deadline) {
      last = options.inTranscript ? await this.transcript() : await this.screen();
      const ok =
        typeof match === 'string'
          ? last.includes(match)
          : match instanceof RegExp
            ? match.test(last)
            : match(last);
      if (ok) return last;
      if (this.hasExited && !options.inTranscript) break;
      await sleep(50);
    }
    throw new Error(
      `Timed out waiting for ${String(match)}.\n----- screen -----\n${last}\n------------------`,
    );
  }

  /** Raw bytes written by the app (for flicker/clear-screen analysis). */
  get raw(): string {
    return this.rawOutput;
  }

  kill(): void {
    if (!this.hasExited) this.pty.kill();
  }
}
