import { plural } from '@patch/shared';
import type { Logger } from '../logging/logger.js';
import type { ToolDefinition } from '../tools/types.js';
import type { McpApprovalStore } from './approvals.js';
import {
  describeMcpServer,
  PROJECT_MCP_FILE,
  type McpServerConfig,
  type McpServerOrigin,
} from './config.js';
import { McpConnection } from './connection.js';
import { mcpToolName } from './names.js';
import { createMcpTool, type McpToolInfo } from './tool.js';

/** How long one server gets to start, complete the handshake and list its tools. */
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 15_000;
/** How long a tool call may go without an answer or a progress notification. */
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 10 * 60_000;

export type McpServerState = 'pending' | 'connecting' | 'connected' | 'failed' | 'skipped';

/** One server as /mcp shows it. */
export interface McpServerStatus {
  name: string;
  origin: McpServerOrigin;
  transport: 'stdio' | 'http';
  /** Its command line or URL (never environment variables or headers). */
  target: string;
  state: McpServerState;
  /** Why it failed or was skipped. */
  reason?: string;
  /** Its tools, as the server names them (connected servers). */
  tools: string[];
}

/** The answer to the approval prompt for a project's servers. */
export type McpApprovalAnswer = 'yes' | 'remember' | 'no';

export interface McpNotice {
  level: 'info' | 'warn';
  text: string;
  hint?: string;
}

export interface McpManagerOptions {
  /** The user's servers, then the project's (see mergeMcpServers). */
  servers: readonly McpServerConfig[];
  projectRoot: string;
  approvals: McpApprovalStore;
  logger: Logger;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
}

export interface McpStartOptions {
  /** Stops connecting: servers still starting are stopped and reported as skipped. */
  signal?: AbortSignal;
  /** Tool names already in use (the built-in tools). */
  reservedNames?: Iterable<string>;
}

export interface McpStartResult {
  /** The servers' tools, in configuration order, each server's in its own order. */
  tools: ToolDefinition[];
  /** Failures and skipped tools, worth showing once. */
  notices: McpNotice[];
}

interface ServerEntry {
  config: McpServerConfig;
  state: McpServerState;
  reason?: string;
  connection?: McpConnection;
  tools: McpToolInfo[];
}

/**
 * The MCP servers of this process. Servers from the user's configuration start without asking;
 * servers from the project's .mcp.json start only once approved, for this run or remembered
 * per project root and definition (McpApprovalStore). `start` connects to all of them in
 * parallel, each within a timeout (a failed or slow server is reported and skipped, never
 * holding up the rest), and lists their tools once: the tool list is fixed for the process (it
 * is part of every session's cached prompt). `close` stops them all.
 */
export class McpManager {
  private readonly options: McpManagerOptions;
  private readonly logger: Logger;
  private readonly entries: ServerEntry[];
  /** Project servers the user approved for this run only. */
  private readonly approvedThisRun = new Set<string>();
  /** Notices about tools left out (invalid entries of tools/list). */
  private readonly toolNotices: McpNotice[] = [];
  private starting: Promise<McpStartResult> | undefined;
  private stopped = false;

  constructor(options: McpManagerOptions) {
    this.options = options;
    this.logger = options.logger;
    this.entries = options.servers.map((config) => ({
      config,
      state: 'pending',
      tools: [],
    }));
  }

  /** True when any server is configured (approved or not). */
  get configured(): boolean {
    return this.entries.length > 0;
  }

  /** True once start() was called. */
  get started(): boolean {
    return this.starting !== undefined;
  }

  /** Project servers that need the user's approval before they may start. */
  pendingApprovals(): McpServerConfig[] {
    return this.entries
      .filter(
        (entry) =>
          entry.state === 'pending' &&
          entry.config.origin === 'project' &&
          !this.options.approvals.isApproved(this.options.projectRoot, entry.config),
      )
      .map((entry) => entry.config);
  }

  /**
   * Applies the user's answer to the servers pendingApprovals() returned: 'remember' also stores
   * the approval for this project; 'no' skips them. Returns a notice when the approval could not
   * be saved (the servers still start this time).
   */
  answerApproval(servers: readonly McpServerConfig[], answer: McpApprovalAnswer): McpNotice[] {
    if (answer === 'no') {
      this.skip(servers, 'declined');
      return [];
    }
    for (const server of servers) this.approvedThisRun.add(server.name);
    if (answer !== 'remember') return [];
    try {
      this.options.approvals.remember(this.options.projectRoot, servers);
      return [];
    } catch (error) {
      this.logger.warn('could not remember MCP approvals', error);
      return [{ level: 'warn', text: error instanceof Error ? error.message : String(error) }];
    }
  }

  /** Marks servers as skipped (declined, or not approved in print mode). */
  skip(servers: readonly McpServerConfig[], reason: string): void {
    for (const entry of this.entries) {
      if (servers.some((server) => server.name === entry.config.name)) {
        entry.state = 'skipped';
        entry.reason = reason;
      }
    }
  }

  /**
   * Connects to every server that may start (user servers, approved project servers) in
   * parallel and builds their tools. Project servers neither approved nor skipped yet are
   * skipped as not approved. Called once; later calls return the first result.
   */
  start(options: McpStartOptions = {}): Promise<McpStartResult> {
    this.starting ??= this.connectAll(options);
    return this.starting;
  }

  /** The servers and their state, in configuration order. */
  status(): McpServerStatus[] {
    return this.entries.map((entry) => ({
      name: entry.config.name,
      origin: entry.config.origin,
      transport: entry.config.transport,
      target: describeMcpServer(entry.config),
      state:
        entry.state === 'connected' && entry.connection?.state === 'failed'
          ? 'failed'
          : entry.state,
      ...(this.reasonOf(entry) ? { reason: this.reasonOf(entry) } : {}),
      tools: entry.state === 'connected' ? entry.tools.map((tool) => tool.name) : [],
    }));
  }

  /** One line for /status, e.g. "2 servers · 14 tools" and "1 failed: docs". */
  summary(): { value: string; detail?: string } {
    if (this.entries.length === 0) return { value: 'none' };
    const statuses = this.status();
    const connected = statuses.filter((status) => status.state === 'connected');
    const tools = connected.reduce((sum, status) => sum + status.tools.length, 0);
    const failed = statuses.filter((status) => status.state === 'failed');
    const skipped = statuses.filter((status) => status.state === 'skipped');
    const waiting = statuses.filter(
      (status) => status.state === 'pending' || status.state === 'connecting',
    );
    const value = `${plural(connected.length, 'server')} connected · ${plural(tools, 'tool')}`;
    const detail = [
      failed.length > 0 ? `${failed.length} failed: ${names(failed)}` : '',
      skipped.length > 0 ? `${skipped.length} skipped: ${names(skipped)}` : '',
      waiting.length > 0 ? `${waiting.length} starting` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return { value, ...(detail ? { detail } : {}) };
  }

  /** Process ids of the stdio servers that run. */
  serverProcessIds(): number[] {
    return this.entries.flatMap((entry) => {
      const pid = entry.state === 'connected' ? entry.connection?.pid : undefined;
      return pid === undefined ? [] : [pid];
    });
  }

  /** Stops every server (process trees for stdio servers). Never throws. */
  async close(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.entries.map((entry) => entry.connection?.close() ?? Promise.resolve()));
  }

  private mayStart(entry: ServerEntry): boolean {
    if (entry.state !== 'pending') return false;
    if (entry.config.origin === 'user') return true;
    return (
      this.approvedThisRun.has(entry.config.name) ||
      this.options.approvals.isApproved(this.options.projectRoot, entry.config)
    );
  }

  private async connectAll(options: McpStartOptions): Promise<McpStartResult> {
    const notices: McpNotice[] = [];
    const startable = this.entries.filter((entry) => this.mayStart(entry));
    for (const entry of this.entries) {
      if (entry.state === 'pending' && !startable.includes(entry)) {
        entry.state = 'skipped';
        entry.reason = `not approved (from ${PROJECT_MCP_FILE})`;
      }
    }
    await Promise.all(startable.map((entry) => this.connectOne(entry, options.signal)));

    const taken = new Set(options.reservedNames ?? []);
    const tools: ToolDefinition[] = [];
    for (const entry of this.entries) {
      if (entry.state === 'failed') {
        notices.push({
          level: 'warn',
          text: `MCP server "${entry.config.name}" could not start: ${entry.reason ?? 'unknown error'}.`,
          hint: 'Patch continues without it. /mcp shows the servers.',
        });
      }
      if (entry.state !== 'connected' || !entry.connection) continue;
      for (const info of entry.tools) {
        const exposedName = mcpToolName(entry.config.name, info.name, taken);
        taken.add(exposedName);
        tools.push(
          createMcpTool(entry.connection, info, {
            exposedName,
            callTimeoutMs: this.options.callTimeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS,
          }),
        );
      }
    }
    this.logger.info('mcp servers started', {
      servers: this.entries.map((entry) => ({
        name: entry.config.name,
        state: entry.state,
        tools: entry.tools.length,
      })),
    });
    return { tools, notices: [...notices, ...this.toolNotices] };
  }

  private async connectOne(entry: ServerEntry, outer: AbortSignal | undefined): Promise<void> {
    const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    outer?.addEventListener('abort', onAbort, { once: true });
    if (outer?.aborted) controller.abort();

    const connection = new McpConnection(entry.config, {
      cwd: this.options.projectRoot,
      logger: this.logger.child(`mcp:${entry.config.name}`),
    });
    entry.connection = connection;
    entry.state = 'connecting';
    try {
      await connection.connect(controller.signal, timeoutMs);
      const listed = await connection.listTools(controller.signal, timeoutMs);
      entry.tools = this.validTools(entry.config.name, listed);
      if (this.stopped) throw new Error('stopped');
      entry.state = 'connected';
    } catch (error) {
      await connection.close();
      const interrupted = outer?.aborted === true || this.stopped;
      entry.state = interrupted ? 'skipped' : 'failed';
      entry.reason = timedOut
        ? `no answer within ${Math.round(timeoutMs / 1000)}s`
        : interrupted
          ? 'interrupted while starting'
          : error instanceof Error
            ? error.message
            : String(error);
      entry.tools = [];
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    }
  }

  /** The entries of tools/list that are usable; the others are reported and left out. */
  private validTools(server: string, listed: readonly unknown[]): McpToolInfo[] {
    const tools: McpToolInfo[] = [];
    const seen = new Set<string>();
    for (const raw of listed) {
      const tool = parseTool(raw);
      if ('problem' in tool) {
        this.toolNotices.push({
          level: 'warn',
          text: `MCP server "${server}": left out the tool ${tool.name ? `"${tool.name}"` : 'without a name'}: ${tool.problem}.`,
        });
        continue;
      }
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      tools.push(tool);
    }
    return tools;
  }

  private reasonOf(entry: ServerEntry): string | undefined {
    if (entry.state === 'connected' && entry.connection?.state === 'failed') {
      return entry.connection.reason;
    }
    return entry.reason;
  }
}

/** One entry of tools/list, validated: a name and an object input schema. */
function parseTool(raw: unknown): McpToolInfo | { name?: string; problem: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { problem: 'the entry is not an object' };
  }
  const record = raw as Record<string, unknown>;
  const name = typeof record['name'] === 'string' ? record['name'] : undefined;
  if (!name || name.trim() === '') return { problem: 'it has no name' };
  const schema = record['inputSchema'];
  if (
    typeof schema !== 'object' ||
    schema === null ||
    Array.isArray(schema) ||
    (schema as Record<string, unknown>)['type'] !== 'object'
  ) {
    return { name, problem: 'its input schema is not an object schema' };
  }
  const description = typeof record['description'] === 'string' ? record['description'] : undefined;
  return {
    name,
    ...(description ? { description } : {}),
    inputSchema: schema as Record<string, unknown>,
  };
}

function names(statuses: readonly McpServerStatus[]): string {
  return statuses.map((status) => status.name).join(', ');
}
