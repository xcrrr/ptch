import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../config/config.js';
import { mcpServerFingerprint, type McpServerConfig } from './config.js';

const FORMAT_VERSION = 1;
const DIR_MODE = 0o700;

/** ~/.patch/mcp-approvals.json: per project root, the approved servers' names and fingerprints. */
interface ApprovalsFile {
  version: number;
  projects: Record<string, Record<string, string>>;
}

/**
 * Project MCP servers (from a repository's .mcp.json) the user approved with "Yes, and remember
 * for this project". An approval holds for one project root and one exact definition: it is
 * keyed by the root and stores the server's fingerprint (see mcpServerFingerprint), so a changed
 * command, URL, environment or header asks again. Lives under ~/.patch, never in the repository.
 */
export class McpApprovalStore {
  constructor(private readonly file: string) {}

  /** True when `server` was approved for `projectRoot` as it is defined now. */
  isApproved(projectRoot: string, server: McpServerConfig): boolean {
    const approved = this.read().projects[projectKey(projectRoot)]?.[server.name];
    return approved === mcpServerFingerprint(server);
  }

  /**
   * Remembers the servers' current definitions for `projectRoot`. Throws an Error with a
   * user-presentable message when the file cannot be written.
   */
  remember(projectRoot: string, servers: readonly McpServerConfig[]): void {
    const data = this.read();
    const key = projectKey(projectRoot);
    const project = { ...data.projects[key] };
    for (const server of servers) project[server.name] = mcpServerFingerprint(server);
    data.projects[key] = project;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: DIR_MODE });
      writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not save the MCP approval to ${this.file}: ${reason}`, {
        cause: error,
      });
    }
  }

  /** The stored approvals; a missing, unreadable or malformed file counts as none. */
  private read(): ApprovalsFile {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return emptyFile();
    }
    try {
      const value = JSON.parse(text) as Partial<ApprovalsFile> | null;
      if (!value || value.version !== FORMAT_VERSION || !isRecord(value.projects)) {
        return emptyFile();
      }
      const projects: ApprovalsFile['projects'] = {};
      for (const [root, servers] of Object.entries(value.projects)) {
        if (!isRecord(servers)) continue;
        projects[root] = Object.fromEntries(
          Object.entries(servers).filter((entry): entry is [string, string] => {
            return typeof entry[1] === 'string';
          }),
        );
      }
      return { version: FORMAT_VERSION, projects };
    } catch {
      return emptyFile();
    }
  }
}

function emptyFile(): ApprovalsFile {
  return { version: FORMAT_VERSION, projects: {} };
}

/** Windows paths compare case-insensitively. */
function projectKey(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
