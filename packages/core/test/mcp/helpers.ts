import { join } from 'node:path';
import { McpApprovalStore } from '../../src/mcp/approvals.js';
import { parseMcpServers, type McpServerConfig } from '../../src/mcp/config.js';
import { McpManager, type McpManagerOptions } from '../../src/mcp/manager.js';
import { noopLogger } from '../../src/logging/logger.js';
import { makeTempDir } from '../../src/testing/fixtures.js';
import { mcpTestServerEntry } from '../../src/testing/mcp.js';
import type { ToolContext } from '../../src/tools/types.js';
import { makeToolContext } from '../tools/context.js';

export interface McpFixture {
  dir: string;
  approvals: McpApprovalStore;
  /** Managers created by `manager`, closed by `cleanup`. */
  managers: McpManager[];
  manager: (
    servers: McpServerConfig[],
    options?: Partial<Omit<McpManagerOptions, 'servers'>>,
  ) => McpManager;
  cleanup: () => Promise<void>;
}

/** A temp project directory and approval store; every manager made here is closed on cleanup. */
export function mcpFixture(): McpFixture {
  const temp = makeTempDir('patch-mcp-');
  const approvals = new McpApprovalStore(join(temp.dir, 'home', 'mcp-approvals.json'));
  const managers: McpManager[] = [];
  return {
    dir: temp.dir,
    approvals,
    managers,
    manager: (servers, options = {}) => {
      const manager = new McpManager({
        servers,
        projectRoot: temp.dir,
        approvals,
        logger: noopLogger,
        ...options,
      });
      managers.push(manager);
      return manager;
    },
    cleanup: async () => {
      await Promise.all(managers.map((manager) => manager.close()));
      temp.cleanup();
    },
  };
}

/** Server definitions running the test server, as parsed from an "mcpServers" object. */
export function testServers(
  entries: Record<string, string[] | Record<string, unknown>>,
  origin: 'user' | 'project' = 'user',
): McpServerConfig[] {
  const raw = Object.fromEntries(
    Object.entries(entries).map(([name, value]) => [
      name,
      Array.isArray(value) ? mcpTestServerEntry(...value) : value,
    ]),
  );
  const warnings: string[] = [];
  const servers = parseMcpServers(raw, { origin, source: 'test' }, warnings);
  if (warnings.length > 0) throw new Error(warnings.join('\n'));
  return servers;
}

/** A tool context in `dir` with its own abort signal. */
export function toolContext(dir: string, signal?: AbortSignal): ToolContext {
  return makeToolContext({ cwd: dir, ...(signal ? { signal } : {}) });
}
