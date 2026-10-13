import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionMode } from '@patch/core';
import {
  ScriptedProvider,
  makeGitRepo,
  makeTempDir,
  mcpTestServerEntry,
  textResponse,
  toolResponse,
  type ScriptStep,
} from '@patch/core/testing';
import { parseArgs } from '../../src/args.js';
import { AppController, type ControllerOptions } from '../../src/app/controller.js';
import { Runtime } from '../../src/runtime.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Setup {
  /** "mcpServers" of ~/.patch/config.json. */
  user?: Record<string, unknown>;
  /** "mcpServers" of the project's .mcp.json. */
  project?: Record<string, unknown>;
}

function workspace({ user, project }: Setup) {
  const repo = makeGitRepo({ 'README.md': '# demo\n' });
  const home = makeTempDir('patch-home-');
  cleanups.push(repo.cleanup, home.cleanup);
  if (user) writeFileSync(join(home.dir, 'config.json'), JSON.stringify({ mcpServers: user }));
  if (project) writeFileSync(join(repo.dir, '.mcp.json'), JSON.stringify({ mcpServers: project }));
  return { repo: repo.dir, home: home.dir };
}

async function open(
  dirs: { repo: string; home: string },
  steps: ScriptStep[] = [],
  options: ControllerOptions = {},
  /** The permission mode the session starts in (`ptch --auto`, say). */
  mode?: PermissionMode,
) {
  const provider = new ScriptedProvider(steps);
  const runtime = await Runtime.create({
    cwd: dirs.repo,
    env: { PATH: process.env.PATH, PATCH_HOME: dirs.home },
    args: parseArgs([]),
    homeDir: dirs.home,
    providerFactory: () => provider,
    assumeCredentials: true,
  });
  cleanups.push(() => runtime.close());
  const handle = await runtime.newSession();
  cleanups.push(() => handle.session.close());
  if (mode) handle.permissions.setMode(mode);
  const controller = new AppController(runtime, handle, options);
  cleanups.push(() => controller.close());
  return { controller, provider, runtime };
}

function notices(controller: AppController): string[] {
  return controller.getState().items.flatMap((item) => (item.kind === 'notice' ? [item.text] : []));
}

function statusTable(controller: AppController, title: string) {
  const table = controller
    .getState()
    .items.filter((item) => item.kind === 'status' && item.title === title)
    .at(-1);
  return table?.kind === 'status' ? table.rows : [];
}

describe('AppController with MCP servers', () => {
  it('asks before starting the project’s servers and remembers the approval', async () => {
    const dirs = workspace({ project: { proj: mcpTestServerEntry() } });
    const first = await open(dirs);
    const state = first.controller.getState();
    expect(state.mode).toBe('mcp-approval');
    expect(state.mcpApproval?.servers).toEqual([
      { name: 'proj', target: expect.stringContaining('mcp-test-server.mjs') },
    ]);
    // Nothing runs before the answer.
    expect(first.runtime.mcp.serverProcessIds()).toEqual([]);
    first.controller.respondMcpApproval('remember');
    await first.controller.idle();
    expect(first.controller.getState().mode).toBe('idle');
    expect(first.runtime.tools.names()).toContain('mcp__proj__echo');
    expect(existsSync(join(dirs.home, 'mcp-approvals.json'))).toBe(true);

    const second = await open(dirs);
    expect(second.controller.getState().mode).not.toBe('mcp-approval');
    await second.controller.idle();
    expect(second.runtime.tools.names()).toContain('mcp__proj__echo');
  });

  it('skips the project’s servers when the user declines', async () => {
    const dirs = workspace({
      user: { mine: mcpTestServerEntry() },
      project: { proj: mcpTestServerEntry() },
    });
    const { controller, runtime } = await open(dirs);
    controller.respondMcpApproval('no');
    await controller.idle();
    const names = runtime.tools.names();
    expect(names).toContain('mcp__mine__echo');
    expect(names.some((name) => name.startsWith('mcp__proj__'))).toBe(false);
    controller.submit('/mcp');
    await controller.idle();
    const rows = statusTable(controller, 'MCP servers');
    expect(rows.find((row) => row.label === 'mine')).toMatchObject({
      value: 'connected · stdio · 8 tools',
    });
    expect(rows.find((row) => row.label === 'proj')).toMatchObject({
      value: 'skipped · stdio · .mcp.json',
      detail: 'declined',
    });
    expect(rows.some((row) => row.detail?.startsWith('echo, pixel'))).toBe(true);
    // Approving nothing for good: the next start asks again.
    const again = await open(dirs);
    expect(again.controller.getState().mode).toBe('mcp-approval');
    again.controller.respondMcpApproval('no');
    await again.controller.idle();
  });

  it('holds the first prompt until the servers are ready, then asks before each call', async () => {
    const dirs = workspace({ user: { test: mcpTestServerEntry('--slow-start=300') } });
    const { controller, provider } = await open(
      dirs,
      [
        toolResponse([{ name: 'mcp__test__echo', input: { text: 'hello' } }]),
        textResponse('The server said hello.'),
      ],
      { initialPrompt: 'Say hello through MCP.' },
    );
    expect(controller.getState().activity?.label).toBe('Starting MCP servers');
    await waitFor(() => controller.getState().mode === 'permission');
    const request = controller.getState().permission;
    expect(request?.prompt).toMatchObject({
      title: 'Patch wants to use an MCP tool',
      subjectLine: 'test · echo',
      sessionOption: { label: "Yes, don't ask again for test's echo this session" },
    });
    expect(request?.preview?.text).toBe('{"text":"hello"}');
    // The very first request already offered the MCP tools.
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toContain('mcp__test__echo');
    controller.respondPermission({ decision: 'allow_once' });
    await controller.idle();
    const row = controller.getState().items.find((item) => item.kind === 'tool');
    expect(row).toMatchObject({
      kind: 'tool',
      status: 'done',
      summary: { verb: 'mcp', target: 'test · echo', detail: 'text: "hello"' },
      display: { summary: '1 line' },
    });
    const sent = JSON.stringify(provider.requests[1]?.messages.at(-1));
    expect(sent).toContain('echo: hello');

    controller.submit('/status');
    await controller.idle();
    expect(statusTable(controller, 'Status').find((r) => r.label === 'MCP')).toEqual({
      label: 'MCP',
      value: '1 server connected · 8 tools',
    });
  });

  it('reports a server that fails to start and carries on', async () => {
    const dirs = workspace({
      user: { broken: mcpTestServerEntry('--crash'), test: mcpTestServerEntry() },
    });
    const { controller, runtime } = await open(dirs, [textResponse('ok')]);
    controller.submit('hi');
    await controller.idle();
    expect(
      notices(controller).some((text) => text.startsWith('MCP server "broken" could not start:')),
    ).toBe(true);
    expect(runtime.tools.names()).toContain('mcp__test__echo');
    expect(runtime.mcp.summary()).toEqual({
      value: '1 server connected · 8 tools',
      detail: '1 failed: broken',
    });
  });

  it('in auto mode still asks before starting the project’s servers, then calls their tools without asking', async () => {
    const dirs = workspace({ project: { proj: mcpTestServerEntry() } });
    const { controller, provider, runtime } = await open(
      dirs,
      [toolResponse([{ name: 'mcp__proj__echo', input: { text: 'hi' } }]), textResponse('Echoed.')],
      {},
      'auto',
    );
    expect(controller.getState().mode).toBe('mcp-approval');
    expect(runtime.mcp.serverProcessIds()).toEqual([]);
    controller.respondMcpApproval('yes');
    await controller.idle();
    controller.submit('Echo hi.');
    await controller.idle();
    const tool = controller.getState().items.find((item) => item.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.status).toBe('done');
    const results = provider.requests[1]?.messages.at(-1)?.content ?? [];
    expect(results).toMatchObject([{ type: 'tool_result', content: 'echo: hi' }]);
    expect(controller.sessionHandle.permissions.sessionGrants()).toEqual([]);
  });

  it('lists no servers when none are configured', async () => {
    const dirs = workspace({});
    const { controller } = await open(dirs);
    expect(controller.getState().mode).toBe('idle');
    controller.submit('/mcp');
    await controller.idle();
    const [row] = statusTable(controller, 'MCP servers');
    expect(row?.label).toBe('none');
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
