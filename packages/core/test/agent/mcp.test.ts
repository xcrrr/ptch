import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/agent.js';
import { PermissionManager, type PermissionRules } from '../../src/permissions/manager.js';
import {
  ScriptedProvider,
  textResponse,
  toolResponse,
  type ScriptStep,
} from '../../src/testing/index.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { mcpFixture, testServers, type McpFixture } from '../mcp/helpers.js';
import {
  MemorySession,
  agentRequests,
  createToolContext,
  eventsOf,
  expectAppendOnly,
  runTurn,
} from './helpers.js';

let fixture: McpFixture | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

async function mcpAgent(steps: ScriptStep[], rules?: PermissionRules) {
  fixture = mcpFixture();
  const mcp = fixture.manager(testServers({ test: [] }));
  const { tools } = await mcp.start();
  const provider = new ScriptedProvider(steps);
  const session = new MemorySession();
  const permissions = new PermissionManager(rules ? { config: rules } : {});
  const agent = new Agent({
    provider,
    session,
    tools: new ToolRegistry(tools),
    permissions,
    toolContext: createToolContext(),
  });
  return { agent, provider, session, permissions, tools };
}

describe('MCP tools in a turn', () => {
  it('asks with the server, tool and arguments, then remembers the tool for the session', async () => {
    const { agent, provider } = await mcpAgent([
      toolResponse([{ name: 'mcp__test__echo', input: { text: 'one' } }]),
      toolResponse([{ name: 'mcp__test__echo', input: { text: 'two' } }]),
      textResponse('Done.'),
    ]);
    const recording = await runTurn(agent, 'echo twice', {
      respond: () => ({ decision: 'allow_session' }),
    });
    expect(recording.result.status).toBe('completed');
    // Only the first call asked.
    expect(recording.permissionRequests).toHaveLength(1);
    const [request] = recording.permissionRequests;
    expect(request).toMatchObject({
      toolName: 'mcp__test__echo',
      summary: { verb: 'mcp', target: 'test · echo', detail: 'text: "one"' },
      subject: { kind: 'mcp', server: 'test', tool: 'echo' },
      prompt: { title: 'Patch wants to use an MCP tool', subjectLine: 'test · echo' },
      preview: { text: '{"text":"one"}' },
    });
    const ends = eventsOf(recording.events, 'tool_end');
    expect(ends.map((end) => end.result.content)).toEqual(['echo: one', 'echo: two']);
    expect(ends[0]?.result.display?.summary).toBe('1 line');
    const requests = agentRequests(provider);
    expect(requests[0]?.tools.map((tool) => tool.name)).toContain('mcp__test__pixel');
    expectAppendOnly(requests);
  });

  it('runs allowed calls without asking and sends images to the model', async () => {
    const { agent, provider } = await mcpAgent(
      [toolResponse([{ name: 'mcp__test__pixel', input: {} }]), textResponse('A black pixel.')],
      { allow: ['mcp:test'], deny: [] },
    );
    const recording = await runTurn(agent, 'look');
    expect(recording.permissionRequests).toEqual([]);
    const last = agentRequests(provider).at(-1)?.messages.at(-1);
    const result = last?.content.find((block) => block.type === 'tool_result');
    expect(result).toMatchObject({
      type: 'tool_result',
      content: 'a pixel',
      images: [{ type: 'image', mediaType: 'image/png' }],
    });
  });

  it('denies MCP tools in plan mode without asking or calling the server', async () => {
    const { agent, permissions, tools } = await mcpAgent(
      [toolResponse([{ name: 'mcp__test__echo', input: { text: 'x' } }]), textResponse('ok')],
      { allow: ['mcp:test'], deny: [] },
    );
    expect(tools.find((tool) => tool.name === 'mcp__test__echo')?.permissionClass).toBe('execute');
    permissions.setMode('plan');
    const recording = await runTurn(agent, 'try');
    expect(recording.permissionRequests).toEqual([]);
    const [end] = eventsOf(recording.events, 'tool_end');
    expect(end).toMatchObject({ denied: true, result: { isError: true } });
    expect(end?.result.content).toContain('Plan mode is on');
    // The only call the server saw is this one.
    const stats = tools.find((tool) => tool.name === 'mcp__test__stats')!;
    const result = await stats.execute(
      {},
      { ...createToolContext(), signal: new AbortController().signal },
    );
    expect(JSON.parse(result.content)).toMatchObject({ calls: 1 });
  });

  it('reports a declined or denied call to the model without calling the server', async () => {
    const { agent } = await mcpAgent(
      [toolResponse([{ name: 'mcp__test__echo', input: { text: 'x' } }]), textResponse('ok')],
      { allow: [], deny: ['mcp:test__echo'] },
    );
    const recording = await runTurn(agent, 'try');
    expect(recording.permissionRequests).toEqual([]);
    const [end] = eventsOf(recording.events, 'tool_end');
    expect(end).toMatchObject({ denied: true, result: { isError: true } });
    expect(end?.result.content).toContain('rule mcp:test__echo');
  });
});
