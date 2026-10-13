import { describe, expect, it } from 'vitest';
import {
  PermissionManager,
  validateRules,
  type PermissionDecision,
  type PermissionManagerOptions,
} from '../../src/permissions/manager.js';
import { parsePermissionRule } from '../../src/permissions/rules.js';
import type { PermissionSubject } from '../../src/tools/types.js';

function mcp(server: string, tool: string, exposedName?: string): PermissionSubject {
  return {
    kind: 'mcp',
    server,
    tool,
    exposedName: exposedName ?? `mcp__${server}__${tool}`,
    input: { text: 'hi' },
  };
}

function manager(options?: PermissionManagerOptions): PermissionManager {
  return new PermissionManager(options);
}

function expectAsk(decision: PermissionDecision) {
  if (decision.type !== 'ask') throw new Error(`expected ask, got ${JSON.stringify(decision)}`);
  return decision.prompt;
}

describe('PermissionManager with MCP tools', () => {
  it('asks before every MCP tool call, offering that tool for the session', () => {
    const prompt = expectAsk(manager().evaluate(mcp('github', 'create_issue')));
    expect(prompt).toEqual({
      title: 'Patch wants to use an MCP tool',
      subjectLine: 'github · create_issue',
      severity: 'normal',
      reason:
        'The MCP server "github" runs this tool with your privileges and receives the arguments below.',
      sessionOption: {
        label: "Yes, don't ask again for github's create_issue this session",
        grant: { kind: 'mcp-tool', server: 'github', tool: 'create_issue' },
      },
    });
  });

  it('remembers a session approval for that tool of that server only', () => {
    const permissions = manager();
    permissions.grant({ kind: 'mcp-tool', server: 'github', tool: 'create_issue' });
    permissions.grant({ kind: 'mcp-tool', server: 'github', tool: 'create_issue' });
    expect(permissions.sessionGrants()).toHaveLength(1);
    expect(permissions.evaluate(mcp('github', 'create_issue'))).toEqual({
      type: 'allow',
      reason: 'Allowed for this session',
    });
    expect(permissions.evaluate(mcp('github', 'delete_repo')).type).toBe('ask');
    expect(permissions.evaluate(mcp('gitlab', 'create_issue')).type).toBe('ask');
    permissions.resetSession();
    expect(permissions.evaluate(mcp('github', 'create_issue')).type).toBe('ask');
  });

  it('allows a whole server or one tool by configuration rule', () => {
    const permissions = manager({
      config: { allow: ['mcp:docs', 'mcp:github__get_issue', 'mcp:fs__read_file'], deny: [] },
    });
    expect(permissions.evaluate(mcp('docs', 'search'))).toEqual({
      type: 'allow',
      reason: 'Allowed by configuration rule "mcp:docs"',
    });
    expect(permissions.evaluate(mcp('github', 'get_issue')).type).toBe('allow');
    expect(permissions.evaluate(mcp('github', 'create_issue')).type).toBe('ask');
    // The rule may name the tool as the model sees it (sanitized) or as the server does.
    expect(permissions.evaluate(mcp('fs', 'read.file', 'mcp__fs__read_file')).type).toBe('allow');
    // A server whose name merely starts with an allowed one is not covered.
    expect(permissions.evaluate(mcp('docs2', 'search')).type).toBe('ask');
    expect(permissions.evaluate(mcp('doc', 's__search')).type).toBe('ask');
  });

  it('lets deny rules win over allow rules and session approvals', () => {
    const permissions = manager({
      config: { allow: ['mcp:github'], deny: ['mcp:github__delete_repo'] },
    });
    permissions.grant({ kind: 'mcp-tool', server: 'github', tool: 'delete_repo' });
    expect(permissions.evaluate(mcp('github', 'delete_repo'))).toEqual({
      type: 'deny',
      reason: 'Denied by configuration rule "mcp:github__delete_repo"',
      message:
        "This action is denied by the user's Patch configuration (rule mcp:github__delete_repo).",
    });
    expect(permissions.evaluate(mcp('github', 'get_issue')).type).toBe('allow');
    const server = manager({ config: { allow: [], deny: ['mcp:github'] } });
    expect(server.evaluate(mcp('github', 'get_issue')).type).toBe('deny');
  });

  it('denies MCP tools in plan mode, whatever rules or approvals allow them', () => {
    const permissions = manager({ config: { allow: ['mcp:github'], deny: [] }, mode: 'plan' });
    permissions.grant({ kind: 'mcp-tool', server: 'gitlab', tool: 'get_issue' });
    for (const subject of [mcp('github', 'get_issue'), mcp('gitlab', 'get_issue'), mcp('x', 'y')]) {
      const decision = permissions.evaluate(subject, 'execute');
      expect(decision).toMatchObject({ type: 'deny', reason: 'Plan mode (read-only)' });
      expect(decision.type === 'deny' && decision.message).toContain(
        'tools that could change something do not run yet',
      );
      // The subject alone says execute too, so a tool declaring a weaker class is still denied.
      expect(permissions.evaluate(subject, 'read').type).toBe('deny');
    }
    permissions.setMode('default');
    expect(permissions.evaluate(mcp('github', 'get_issue'), 'execute').type).toBe('allow');
    permissions.setMode('acceptEdits');
    expect(permissions.evaluate(mcp('x', 'y'), 'execute').type).toBe('ask');
  });

  it('never lets command or edit rules cover MCP tools', () => {
    const permissions = manager({ config: { allow: ['bash:*', 'edit'], deny: [] } });
    expect(permissions.evaluate(mcp('github', 'create_issue')).type).toBe('ask');
  });

  it('lists MCP rules and session approvals in plain language', () => {
    const permissions = manager({
      config: { allow: ['mcp:docs'], deny: ['mcp:github__delete_repo'] },
    });
    permissions.grant({ kind: 'mcp-tool', server: 'github', tool: 'create_issue' });
    const rules = permissions.listRules();
    expect(rules.filter((rule) => rule.source === 'default').map((r) => r.description)).toContain(
      'Ask before calling tools of MCP servers',
    );
    expect(rules.filter((rule) => rule.source !== 'default')).toEqual([
      {
        source: 'config',
        effect: 'allow',
        description: 'Allow: every tool of the MCP server docs (config)',
      },
      {
        source: 'config',
        effect: 'deny',
        description: 'Deny: the MCP tool github__delete_repo (config)',
      },
      {
        source: 'session',
        effect: 'allow',
        description: 'Allow: the MCP tool create_issue of github (session)',
      },
    ]);
  });
});

describe('mcp: permission rules', () => {
  it('parses server and tool rules', () => {
    expect(parsePermissionRule('mcp:github')).toEqual({
      ok: true,
      rule: { kind: 'mcp', target: 'github' },
    });
    expect(parsePermissionRule('MCP: github__get.file')).toEqual({
      ok: true,
      rule: { kind: 'mcp', target: 'github__get.file' },
    });
  });

  it('reports malformed rules', () => {
    expect(validateRules({ allow: ['mcp:', 'mcp:*'], deny: ['mcp:git hub', 'mcp:a.b'] })).toEqual([
      'Invalid allow rule "mcp:": expected a server name after "mcp:", e.g. "mcp:github".',
      'Invalid allow rule "mcp:*": wildcards are not supported; "mcp:<server>" covers every tool of a server, "mcp:<server>__<tool>" one tool.',
      'Invalid deny rule "mcp:git hub": expected "mcp:<server>" or "mcp:<server>__<tool>" (server names use A-Z, a-z, 0-9, _ and -).',
      'Invalid deny rule "mcp:a.b": expected "mcp:<server>" or "mcp:<server>__<tool>" (server names use A-Z, a-z, 0-9, _ and -).',
    ]);
  });
});
