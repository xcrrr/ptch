import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import spawn from 'cross-spawn';
import { killProcessTree, trackProcessTree } from '../shell/process.js';

/** After stdin is closed, how long a server gets to exit by itself before its tree is killed. */
const EXIT_GRACE_MS = 1_000;
/** After the server exits, how long to wait for its output pipes (held by leftover children). */
const PIPE_GRACE_MS = 500;
/** Longest stderr line passed on; servers can print anything. */
const MAX_STDERR_LINE_CHARS = 2_000;

export interface McpStdioTransportOptions {
  command: string;
  args: readonly string[];
  /** Added to the minimal environment the MCP SDK passes to servers (PATH, HOME, ...). */
  env: Readonly<Record<string, string>>;
  cwd: string;
  /** Each line the server writes to stderr (servers log there). */
  onStderr?: (line: string) => void;
}

/** How the server process ended. */
export interface McpProcessExit {
  code: number | null;
  signal: string | null;
}

/**
 * The MCP stdio transport (newline-delimited JSON-RPC over the server's stdin and stdout), built
 * on the SDK's message framing. It differs from the SDK's StdioClientTransport in how the process
 * is run and stopped, so that stopping a server always stops everything it started (`npx` runs
 * the server as a child of its own):
 *  - on POSIX the server leads its own process group (spawned detached), so the whole group is
 *    signalled; on Windows `taskkill /T` ends the tree (see killProcessTree);
 *  - the tree is registered with the exit hook that kills running commands when Patch exits
 *    (trackProcessTree);
 *  - stderr is piped (never inherited: it would draw over the terminal UI) and passed on by line.
 * Like the SDK's transport, it resolves the command on PATH with Windows `.cmd` shims (via
 * cross-spawn) and gives the server only a minimal environment plus the configured variables, so
 * Patch's own credentials never reach it.
 */
export class McpStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly options: McpStdioTransportOptions;
  private readonly buffer = new ReadBuffer();
  private child: ChildProcess | undefined;
  private untrack: (() => void) | undefined;
  private exitStatus: McpProcessExit | undefined;
  private exited: Promise<void> | undefined;
  private markExited: ((status: McpProcessExit) => void) | undefined;
  private notFound = false;
  private closing: Promise<void> | undefined;
  private finished = false;

  constructor(options: McpStdioTransportOptions) {
    this.options = options;
  }

  /** The server's process id once started. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** How the process ended, once it has. */
  get exit(): McpProcessExit | undefined {
    return this.exitStatus;
  }

  /** The command does not exist (the spawn failed, or on Windows cmd.exe could not find it). */
  get commandNotFound(): boolean {
    return this.notFound;
  }

  start(): Promise<void> {
    if (this.child) throw new Error('McpStdioTransport already started');
    const { command, args, env, cwd } = this.options;
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(command, [...args], {
          cwd,
          env: { ...getDefaultEnvironment(), ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.child = child;
      let spawned = false;
      this.exited = new Promise((done) => {
        this.markExited = (status) => {
          if (this.exitStatus) return;
          this.exitStatus = status;
          this.untrack?.();
          // Pipes stay open while a leftover child holds them; stop waiting for them soon.
          setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
          }, PIPE_GRACE_MS).unref();
          done();
        };
        child.once('exit', (code, signal) => this.markExited?.({ code, signal }));
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (!spawned) {
          this.notFound = error.code === 'ENOENT';
          this.finish();
          reject(error);
        } else if (error.code === 'ENOENT') {
          // Windows: cross-spawn reports a command cmd.exe could not find this way, in place
          // of the exit.
          this.notFound = true;
          this.markExited?.({ code: 1, signal: null });
        } else {
          this.onerror?.(error);
        }
      });
      child.once('spawn', () => {
        spawned = true;
        if (child.pid !== undefined) this.untrack = trackProcessTree(child.pid);
        resolve();
      });
      child.once('close', () => this.finish());
      child.stdin?.on('error', (error) => this.onerror?.(error));
      child.stdout?.on('error', (error) => this.onerror?.(error));
      child.stdout?.on('data', (chunk: Buffer) => this.receive(chunk));
      this.readStderr(child);
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || this.exitStatus || this.finished) {
      return Promise.reject(new Error('Not connected'));
    }
    return new Promise((resolve) => {
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once('drain', resolve);
    });
  }

  /**
   * Stops the server: closes its stdin (the MCP way to ask it to exit), then kills the process
   * tree if it has not exited within a second. Resolves once it has stopped (or the kill is
   * done). Safe to call more than once.
   */
  close(): Promise<void> {
    this.closing ??= this.stop();
    return this.closing;
  }

  private async stop(): Promise<void> {
    const child = this.child;
    if (child && this.exited && !this.exitStatus) {
      try {
        child.stdin?.end();
      } catch {
        // Already closed.
      }
      const exitedInTime = await Promise.race([
        this.exited.then(() => true),
        delay(EXIT_GRACE_MS).then(() => false),
      ]);
      // Only a process known to run is killed: on Windows a pid is reused quickly.
      if (!exitedInTime && child.pid !== undefined) {
        await killProcessTree(child.pid);
        await Promise.race([this.exited, delay(EXIT_GRACE_MS)]);
      }
    }
    this.untrack?.();
    this.finish();
  }

  private receive(chunk: Buffer): void {
    try {
      this.buffer.append(chunk);
    } catch (error) {
      // A message larger than the buffer: the stream cannot be trusted any more.
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      void this.close();
      return;
    }
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.buffer.readMessage();
      } catch (error) {
        // A line that is not JSON-RPC (a server logging to stdout): skip it.
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  private readStderr(child: ChildProcess): void {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const emit = (line: string) => {
      const text = line.replace(/\r$/, '');
      if (text.trim() === '') return;
      try {
        this.options.onStderr?.(text.slice(0, MAX_STDERR_LINE_CHARS));
      } catch {
        // A failing observer must not break the transport.
      }
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      const lines = (pending + decoder.write(chunk)).split('\n');
      pending = lines.pop() ?? '';
      if (pending.length > MAX_STDERR_LINE_CHARS) {
        emit(pending);
        pending = '';
      }
      for (const line of lines) emit(line);
    });
    child.stderr?.on('end', () => emit(pending + decoder.end()));
    child.stderr?.on('error', () => undefined);
  }

  /** Reports the end of the connection once. */
  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.buffer.clear();
    try {
      this.onclose?.();
    } catch {
      // The listener's problem.
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
