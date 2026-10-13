import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpApprovalStore } from '../../src/mcp/approvals.js';
import type { McpServerConfig } from '../../src/mcp/config.js';
import { makeTempDir } from '../../src/testing/fixtures.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const server: McpServerConfig = {
  name: 'db',
  origin: 'project',
  transport: 'stdio',
  command: 'db-mcp',
  args: ['--readonly'],
  env: { DB_PASSWORD: 'hunter2-secret' },
};

function store() {
  const temp = makeTempDir('patch-approvals-');
  cleanups.push(temp.cleanup);
  const file = join(temp.dir, 'home', 'mcp-approvals.json');
  return { store: new McpApprovalStore(file), file, dir: temp.dir };
}

describe('McpApprovalStore', () => {
  it('remembers servers per project root and definition, storing only digests', () => {
    const { store: approvals, file, dir } = store();
    const project = join(dir, 'repo');
    expect(approvals.isApproved(project, server)).toBe(false);
    approvals.remember(project, [server]);
    expect(approvals.isApproved(project, server)).toBe(true);
    expect(approvals.isApproved(join(dir, 'other'), server)).toBe(false);
    expect(approvals.isApproved(project, { ...server, args: [] })).toBe(false);
    expect(approvals.isApproved(project, { ...server, name: 'db2' })).toBe(false);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('hunter2-secret');
    expect(text).not.toContain('db-mcp');
    // A second project keeps the first one's approvals.
    approvals.remember(join(dir, 'other'), [server]);
    expect(approvals.isApproved(project, server)).toBe(true);
  });

  it('treats a damaged file as no approvals and replaces it', () => {
    const { store: approvals, file, dir } = store();
    approvals.remember(dir, [server]);
    writeFileSync(file, '{ not json');
    expect(approvals.isApproved(dir, server)).toBe(false);
    approvals.remember(dir, [server]);
    expect(approvals.isApproved(dir, server)).toBe(true);
  });

  it('explains when an approval cannot be saved', () => {
    const { dir } = store();
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'a file where the directory should be');
    const approvals = new McpApprovalStore(join(blocker, 'mcp-approvals.json'));
    expect(() => approvals.remember(dir, [server])).toThrow(/^Could not save the MCP approval to /);
  });
});
