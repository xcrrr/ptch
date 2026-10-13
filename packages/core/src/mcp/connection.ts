import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Logger } from '../logging/logger.js';
import { PATCH_VERSION } from '../version.js';
import { redactServerSecrets, type McpServerConfig } from './config.js';
import { McpStdioTransport } from './stdio-transport.js';

/** Pages of tools/list followed at most (a server that keeps returning cursors stops here). */
const MAX_TOOL_PAGES = 100;
/** stderr lines of a stdio server kept for explaining a failure. */
const STDERR_TAIL_LINES = 20;
/** Characters of a failure reason shown to the user. */
const MAX_REASON_CHARS = 300;

/** One page of tools/list, read leniently: each tool is validated on its own (see McpManager). */
const ToolsPageSchema = z.looseObject({
  tools: z.array(z.unknown()),
  nextCursor: z.string().optional(),
});

export type McpConnectionState = 'idle' | 'connecting' | 'connected' | 'failed' | 'closed';

export interface McpCallOptions {
  signal: AbortSignal;
  /** Without progress notifications from the server, the call fails after this long. */
  timeoutMs: number;
  /** Progress notifications ("Indexing 40/120"); requesting them also resets the timeout. */
  onProgress?: (text: string) => void;
}

/** A failure to reach or use a server, with a short reason fit for the user (and the model). */
export class McpConnectionError extends Error {
  override readonly name = 'McpConnectionError';
}

/**
 * One MCP server: its transport (a process for stdio, HTTP requests otherwise) and the SDK
 * client speaking the protocol over it. Connects once; never reconnects. Every message it
 * produces has the server's environment and header values removed.
 */
export class McpConnection {
  readonly server: McpServerConfig;
  private readonly cwd: string;
  private readonly logger: Logger;
  private client: Client | undefined;
  private transport: Transport | undefined;
  private readonly stderrTail: string[] = [];
  private currentState: McpConnectionState = 'idle';
  private failure: string | undefined;
  private closing: Promise<void> | undefined;

  constructor(server: McpServerConfig, options: { cwd: string; logger: Logger }) {
    this.server = server;
    this.cwd = options.cwd;
    this.logger = options.logger;
  }

  get state(): McpConnectionState {
    return this.currentState;
  }

  /** Why the server failed or stopped, when it did. */
  get reason(): string | undefined {
    return this.failure;
  }

  /** The stdio server's process id, while it runs. */
  get pid(): number | undefined {
    return this.transport instanceof McpStdioTransport ? this.transport.pid : undefined;
  }

  /**
   * Starts the server (or opens the HTTP session) and completes the MCP handshake. Throws an
   * McpConnectionError with a short reason; the connection is closed then.
   */
  async connect(signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (this.currentState !== 'idle') throw new Error('An MCP connection connects only once.');
    this.currentState = 'connecting';
    const client = new Client({ name: 'patch', version: PATCH_VERSION }, { capabilities: {} });
    const transport = this.createTransport();
    this.client = client;
    this.transport = transport;
    client.onerror = (error) =>
      this.logger.debug('mcp transport error', this.redact(String(error)));
    client.onclose = () => this.closed();
    try {
      await client.connect(transport, { signal, timeout: timeoutMs });
      this.currentState = 'connected';
      this.logger.info('mcp server connected', {
        server: this.server.name,
        version: client.getServerVersion(),
      });
    } catch (error) {
      const reason = this.withStderr(this.describeFailure(error, signal));
      await this.close();
      this.fail(reason);
      throw new McpConnectionError(reason);
    }
  }

  /** The server's tools (raw tools/list entries, every page). Throws McpConnectionError. */
  async listTools(signal: AbortSignal, timeoutMs: number): Promise<unknown[]> {
    const client = this.connectedClient();
    if (!client.getServerCapabilities()?.tools) return [];
    const tools: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    try {
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const result = await client.request(
          { method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) },
          ToolsPageSchema,
          { signal, timeout: timeoutMs },
        );
        tools.push(...result.tools);
        cursor = result.nextCursor;
        if (cursor === undefined || cursors.has(cursor)) break;
        cursors.add(cursor);
      }
    } catch (error) {
      throw new McpConnectionError(this.describeFailure(error, signal));
    }
    return tools;
  }

  /**
   * Calls a tool. Resolves with the server's result (an isError result included); throws an
   * McpConnectionError when the call itself fails (server gone, timeout, protocol error). An
   * abort cancels the request on the server.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpCallOptions,
  ): Promise<CallToolResult> {
    const client = this.connectedClient();
    const { onProgress } = options;
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        signal: options.signal,
        timeout: options.timeoutMs,
        ...(onProgress
          ? {
              resetTimeoutOnProgress: true,
              onprogress: (progress) => {
                const total = progress.total === undefined ? '' : `/${progress.total}`;
                onProgress(progress.message ?? `${progress.progress}${total}`);
              },
            }
          : {}),
      });
      if (!('content' in result)) {
        throw new McpConnectionError('the server answered in an outdated result format');
      }
      return result as CallToolResult;
    } catch (error) {
      if (error instanceof McpConnectionError) throw error;
      throw new McpConnectionError(this.describeFailure(error, options.signal, options.timeoutMs));
    }
  }

  /**
   * Stops the server (its process tree, for stdio) or ends the HTTP session. Never throws; safe
   * to call more than once.
   */
  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    const { client, transport } = this;
    if (this.currentState === 'connected' || this.currentState === 'connecting') {
      this.currentState = 'closed';
    }
    try {
      if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
        await transport.terminateSession().catch(() => undefined);
      }
      // Closing the client closes its transport.
      if (client) await client.close();
      else await transport?.close();
    } catch (error) {
      this.logger.debug('mcp close failed', this.redact(String(error)));
    }
  }

  private connectedClient(): Client {
    if (this.currentState !== 'connected' || !this.client) {
      const why = this.failure ? `: ${this.failure}` : '';
      throw new McpConnectionError(`the server is not running${why}`);
    }
    return this.client;
  }

  private createTransport(): Transport {
    const { server } = this;
    if (server.transport === 'http') {
      return new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { ...server.headers } },
      });
    }
    return new McpStdioTransport({
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: this.cwd,
      onStderr: (line) => {
        const redacted = this.redact(line);
        this.stderrTail.push(redacted);
        if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
        this.logger.debug('mcp server stderr', { server: server.name, line: redacted });
      },
    });
  }

  /** The transport closed: the server exited or the session ended. */
  private closed(): void {
    if (this.currentState !== 'connected') return;
    const exit = this.transport instanceof McpStdioTransport ? this.transport.exit : undefined;
    const how = exit
      ? exit.code !== null
        ? `exited with code ${exit.code}`
        : `was stopped (${exit.signal ?? 'killed'})`
      : 'closed the connection';
    this.fail(this.withStderr(`the server ${how}`));
    this.client = undefined;
  }

  private fail(reason: string): void {
    this.currentState = 'failed';
    this.failure = reason;
    this.logger.warn('mcp server failed', { server: this.server.name, reason });
  }

  /** A short reason for a failed connection, request or call (redacted, one line). */
  private describeFailure(error: unknown, signal: AbortSignal, timeoutMs?: number): string {
    if (signal.aborted) return 'interrupted';
    const stdio = this.transport instanceof McpStdioTransport ? this.transport : undefined;
    const exit = stdio?.exit;
    let reason: string;
    if (stdio?.commandNotFound || isErrno(error, 'ENOENT')) {
      reason = 'the command was not found';
    } else if (exit && this.currentState === 'connecting') {
      reason =
        exit.code !== null
          ? `the server exited with code ${exit.code}`
          : `the server was stopped (${exit.signal ?? 'killed'})`;
    } else if (error instanceof McpError) {
      reason =
        error.code === ErrorCode.RequestTimeout
          ? timeoutMs !== undefined
            ? `no answer within ${Math.round(timeoutMs / 1000)}s`
            : 'the server did not answer in time'
          : error.code === ErrorCode.ConnectionClosed
            ? 'the server closed the connection'
            : error.message.replace(/^MCP error -?\d+: /, '');
    } else if (error instanceof StreamableHTTPError) {
      reason =
        error.code === 401 || error.code === 403
          ? `the server refused the request (HTTP ${error.code}); check the "headers" of this server`
          : `HTTP ${error.code ?? 'error'}: ${error.message}`;
    } else if (error instanceof Error && error.name === 'UnauthorizedError') {
      reason = 'the server needs authorization; Patch supports headers (no OAuth sign-in)';
    } else {
      reason = error instanceof Error ? error.message || error.name : String(error);
    }
    return this.oneLine(reason);
  }

  /** Adds the server's last stderr line, which usually says why it could not start or stopped. */
  private withStderr(reason: string): string {
    const notFound = this.transport instanceof McpStdioTransport && this.transport.commandNotFound;
    const last = notFound || reason === 'interrupted' ? undefined : this.stderrTail.at(-1);
    return this.oneLine(last ? `${reason}: ${last.trim()}` : reason);
  }

  private oneLine(text: string): string {
    const line = this.redact(text).replace(/\s+/g, ' ').trim();
    return line.length > MAX_REASON_CHARS ? `${line.slice(0, MAX_REASON_CHARS - 1)}…` : line;
  }

  private redact(text: string): string {
    return redactServerSecrets(this.server, text);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}
