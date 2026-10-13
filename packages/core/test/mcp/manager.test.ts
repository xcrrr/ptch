import { afterEach, describe, expect, it } from 'vitest';
import type { McpServerConfig } from '../../src/mcp/config.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolError, type ToolDefinition } from '../../src/tools/types.js';
import { isProcessAlive, waitFor } from '../shell/helpers.js';
import { mcpFixture, testServers, toolContext, type McpFixture } from './helpers.js';

let fixture: McpFixture;
afterEach(async () => {
  await fixture?.cleanup();
});

function setup(): McpFixture {
  fixture = mcpFixture();
  return fixture;
}

function byName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool ${name} in ${tools.map((t) => t.name).join(', ')}`);
  return tool;
}

async function call(tool: ToolDefinition, input: Record<string, unknown>, dir: string) {
  return tool.execute(tool.inputSchema.parse(input), toolContext(dir));
}

describe('McpManager', () => {
  it('connects to a stdio server and exposes its tools', async () => {
    const { manager, dir } = setup();
    const mcp = manager(testServers({ test: [] }));
    const { tools, notices } = await mcp.start({ reservedNames: ['bash'] });
    expect(notices).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp__test__echo',
      'mcp__test__pixel',
      'mcp__test__huge_image',
      'mcp__test__fail',
      'mcp__test__big',
      'mcp__test__sleep',
      'mcp__test__stats',
      'mcp__test__env',
    ]);
    const echo = byName(tools, 'mcp__test__echo');
    expect(echo.description).toBe('test (MCP server): Echoes the text back.');
    expect(echo.permissionClass).toBe('execute');
    // The server's schema reaches the model as is.
    expect(new ToolRegistry(tools).specs()[0]?.inputSchema).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
    const result = await call(echo, { text: 'hello' }, dir);
    expect(result).toMatchObject({ content: 'echo: hello', display: { summary: '1 line' } });
    expect(mcp.status()).toEqual([
      expect.objectContaining({
        name: 'test',
        origin: 'user',
        transport: 'stdio',
        state: 'connected',
        tools: expect.arrayContaining(['echo', 'pixel', 'fail']),
      }),
    ]);
    expect(mcp.summary()).toEqual({ value: '1 server connected · 8 tools' });
  });

  it('follows tools/list pagination and starts only once', async () => {
    const { manager } = setup();
    const mcp = manager(testServers({ paged: ['--page-size=3'] }));
    const first = await mcp.start();
    expect(first.tools).toHaveLength(8);
    expect(await mcp.start()).toBe(first);
  });

  it('skips tools without a name or an object schema and sanitizes names', async () => {
    const { manager } = setup();
    const mcp = manager(testServers({ odd: ['--bad-tools'] }));
    const { tools, notices } = await mcp.start();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('mcp__odd__get_file_v2');
    expect(names).not.toContain('mcp__odd__stringly');
    expect(notices.map((notice) => notice.text)).toEqual([
      'MCP server "odd": left out the tool "stringly": its input schema is not an object schema.',
      'MCP server "odd": left out the tool without a name: it has no name.',
    ]);
  });

  it('reports a server that does not answer in time without holding up the others', async () => {
    const { manager } = setup();
    const mcp = manager(testServers({ slow: ['--slow-start=20000'], quick: [] }), {
      connectTimeoutMs: 1_500,
    });
    const started = Date.now();
    const { tools, notices } = await mcp.start();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(tools.some((tool) => tool.name === 'mcp__quick__echo')).toBe(true);
    expect(tools.some((tool) => tool.name.startsWith('mcp__slow__'))).toBe(false);
    expect(notices).toEqual([
      expect.objectContaining({
        level: 'warn',
        text: 'MCP server "slow" could not start: no answer within 2s.',
      }),
    ]);
    const slow = mcp.status().find((status) => status.name === 'slow');
    expect(slow).toMatchObject({ state: 'failed', reason: 'no answer within 2s', tools: [] });
    expect(mcp.summary()).toEqual({
      value: '1 server connected · 8 tools',
      detail: '1 failed: slow',
    });
  });

  it('explains a server that exits or cannot be found', async () => {
    const { manager } = setup();
    const mcp = manager([
      ...testServers({ crashing: ['--crash'] }),
      ...testServers({ missing: { command: 'patch-no-such-mcp-server-command' } }),
    ]);
    await mcp.start();
    const [crashing, missing] = mcp.status();
    expect(crashing?.state).toBe('failed');
    expect(crashing?.reason).toMatch(/exited with code 3|closed the connection/);
    expect(crashing?.reason).toContain('patch-test: missing configuration, giving up');
    expect(missing).toMatchObject({ state: 'failed', reason: 'the command was not found' });
  });

  it('passes the configured environment, never Patch credentials', async () => {
    const { manager, dir } = setup();
    const previous = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-not-passed';
    try {
      const mcp = manager(
        testServers({
          envy: { ...entryFor([]), env: { GREETING: 'hi there' } },
        }),
      );
      const { tools } = await mcp.start();
      const env = byName(tools, 'mcp__envy__env');
      expect((await call(env, { name: 'GREETING' }, dir)).content).toBe('hi there');
      expect((await call(env, { name: 'ANTHROPIC_API_KEY' }, dir)).content).toBe('(unset)');
    } finally {
      if (previous === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = previous;
    }
  });

  it('turns a failing call into a tool error and an isError result into an error result', async () => {
    const { manager, dir } = setup();
    const mcp = manager(testServers({ test: [] }));
    const { tools } = await mcp.start();
    const failed = await call(byName(tools, 'mcp__test__fail'), {}, dir);
    expect(failed).toMatchObject({
      content: 'Something went wrong\nat step 2',
      isError: true,
      display: { summary: 'Something went wrong' },
    });
    await mcp.close();
    await expect(call(byName(tools, 'mcp__test__echo'), { text: 'x' }, dir)).rejects.toThrow(
      ToolError,
    );
  });

  it('cancels a call on the server when it is interrupted', async () => {
    const { manager, dir } = setup();
    const mcp = manager(testServers({ test: [] }));
    const { tools } = await mcp.start();
    const abort = new AbortController();
    const progress: string[] = [];
    const sleeping = byName(tools, 'mcp__test__sleep').execute(
      { ms: 30_000 },
      {
        ...toolContext(dir, abort.signal),
        onProgress: (update) => progress.push(...update.tail),
      },
    );
    await waitFor(() => progress.length > 0, 10_000);
    expect(progress).toEqual(['sleeping']);
    abort.abort();
    await expect(sleeping).rejects.toThrow(ToolError);
    // The server learns about the cancellation from a notification, so it may take a moment.
    const stats = byName(tools, 'mcp__test__stats');
    let cancelled = 0;
    for (let attempt = 0; attempt < 50 && cancelled === 0; attempt++) {
      ({ cancelled } = JSON.parse((await call(stats, {}, dir)).content) as { cancelled: number });
      if (cancelled === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(cancelled).toBe(1);
  });

  it('stops every server, with the processes they started, on close', async () => {
    const { manager, dir } = setup();
    const mcp = manager(testServers({ parent: ['--child'], plain: [] }));
    const { tools } = await mcp.start();
    const childPid = Number((await call(byName(tools, 'mcp__parent__child_pid'), {}, dir)).content);
    const pids = mcp.serverProcessIds();
    expect(pids).toHaveLength(2);
    expect(childPid).toBeGreaterThan(0);
    for (const pid of [...pids, childPid]) expect(isProcessAlive(pid)).toBe(true);
    await mcp.close();
    for (const pid of [...pids, childPid]) {
      await waitFor(() => !isProcessAlive(pid), 10_000);
    }
  });
});

describe('McpManager with project servers', () => {
  const project = (name = 'proj', ...options: string[]): McpServerConfig[] =>
    testServers({ [name]: options }, 'project');

  it('starts nothing from .mcp.json until the user approves it', async () => {
    const { manager } = setup();
    const mcp = manager([...testServers({ mine: [] }), ...project()]);
    expect(mcp.pendingApprovals().map((server) => server.name)).toEqual(['proj']);
    // Print mode: no prompt, so unapproved servers are skipped.
    const { tools } = await mcp.start();
    expect(tools.every((tool) => tool.name.startsWith('mcp__mine__'))).toBe(true);
    expect(mcp.status().find((status) => status.name === 'proj')).toMatchObject({
      state: 'skipped',
      reason: 'not approved (from .mcp.json)',
    });
    expect(mcp.serverProcessIds()).toHaveLength(1);
  });

  it('skips servers the user declined and starts the ones approved for this run', async () => {
    const { manager } = setup();
    const declined = manager(project());
    declined.answerApproval(declined.pendingApprovals(), 'no');
    expect((await declined.start()).tools).toEqual([]);
    expect(declined.status()[0]).toMatchObject({ state: 'skipped', reason: 'declined' });

    const approved = manager(project());
    approved.answerApproval(approved.pendingApprovals(), 'yes');
    expect((await approved.start()).tools.length).toBeGreaterThan(0);
    // Not remembered: the next run asks again.
    expect(manager(project()).pendingApprovals()).toHaveLength(1);
  });

  it('remembers approvals per project and definition', async () => {
    const { manager, approvals, dir } = setup();
    const first = manager(project());
    expect(first.answerApproval(first.pendingApprovals(), 'remember')).toEqual([]);
    expect(manager(project()).pendingApprovals()).toEqual([]);
    expect(approvals.isApproved(`${dir}-elsewhere`, project()[0]!)).toBe(false);
    // A changed definition asks again.
    expect(manager(project('proj', '--page-size=2')).pendingApprovals()).toHaveLength(1);
    const withEnv = testServers(
      { proj: { ...entryFor([]), env: { TOKEN: 'changed' } } },
      'project',
    );
    expect(manager(withEnv).pendingApprovals()).toHaveLength(1);
  });
});

function entryFor(options: string[]): { command: string; args: string[] } {
  const [server] = testServers({ x: options });
  if (server?.transport !== 'stdio') throw new Error('expected a stdio server');
  return { command: server.command, args: server.args };
}
