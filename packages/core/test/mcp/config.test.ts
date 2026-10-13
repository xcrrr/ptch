import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import {
  describeMcpServer,
  loadProjectMcpServers,
  mcpServerFingerprint,
  mergeMcpServers,
  parseMcpServers,
  redactServerSecrets,
  type McpServerConfig,
} from '../../src/mcp/config.js';
import { makeTempDir } from '../../src/testing/fixtures.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function parse(raw: unknown, origin: 'user' | 'project' = 'user') {
  const warnings: string[] = [];
  const servers = parseMcpServers(raw, { origin, source: '~/.patch/config.json' }, warnings);
  return { servers, warnings };
}

const SECRET = 'ghp_secretvalue123456';

describe('parseMcpServers', () => {
  it('reads stdio and HTTP servers in the Claude Code shapes', () => {
    const { servers, warnings } = parse({
      github: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: SECRET },
      },
      local: { type: 'stdio', command: ' node ', args: ['server.js'] },
      docs: {
        type: 'http',
        url: 'https://docs.example.com/mcp',
        headers: { Authorization: SECRET },
      },
      inferred: { url: 'http://localhost:3000/mcp' },
    });
    expect(warnings).toEqual([]);
    expect(servers).toEqual([
      {
        name: 'github',
        origin: 'user',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: SECRET },
      },
      {
        name: 'local',
        origin: 'user',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: {},
      },
      {
        name: 'docs',
        origin: 'user',
        transport: 'http',
        url: 'https://docs.example.com/mcp',
        headers: { Authorization: SECRET },
      },
      {
        name: 'inferred',
        origin: 'user',
        transport: 'http',
        url: 'http://localhost:3000/mcp',
        headers: {},
      },
    ]);
  });

  it('skips invalid entries with a warning and never echoes env or header values', () => {
    const { servers, warnings } = parse({
      'bad name': { command: 'x' },
      ok: { command: 'node' },
      nocommand: { args: ['x'] },
      badargs: { command: 'node', args: 'server.js' },
      badenv: { command: 'node', env: { TOKEN: 42, OTHER: SECRET } },
      badheaders: { type: 'http', url: 'https://x.example.com', headers: { Authorization: 7 } },
      badurl: { type: 'http', url: `ftp://user:${SECRET}@x.example.com` },
      sse: { type: 'sse', url: 'https://x.example.com/sse' },
      weird: { type: 'websocket', url: 'wss://x' },
      notobject: 'node server.js',
      extra: { command: 'node', cwd: '/tmp', timeout: 5 },
      placeholders: { command: 'node', env: { TOKEN: '${GITHUB_TOKEN}' } },
    });
    expect(servers.map((server) => server.name)).toEqual(['ok', 'extra', 'placeholders']);
    expect(warnings).toEqual([
      'Invalid MCP server name "bad name" in ~/.patch/config.json: use letters, digits, "_" and "-". Skipping it.',
      'MCP server "nocommand" in ~/.patch/config.json: "command" must be a non-empty string. Skipping it.',
      'MCP server "badargs" in ~/.patch/config.json: "args" must be a list of strings. Skipping it.',
      'MCP server "badenv" in ~/.patch/config.json: "env.TOKEN" must be a string. Skipping it.',
      'MCP server "badheaders" in ~/.patch/config.json: "headers.Authorization" must be a string. Skipping it.',
      'MCP server "badurl" in ~/.patch/config.json: "url" must be an http:// or https:// URL. Skipping it.',
      'MCP server "sse" in ~/.patch/config.json: the "sse" transport is not supported; use "type": "http" (streamable HTTP). Skipping it.',
      'MCP server "weird" in ~/.patch/config.json: "type" must be "stdio" or "http". Skipping it.',
      'MCP server "notobject" in ~/.patch/config.json: expected an object. Skipping it.',
      'MCP server "extra" in ~/.patch/config.json: ignoring unknown setting "cwd".',
      'MCP server "extra" in ~/.patch/config.json: ignoring unknown setting "timeout".',
      'MCP server "placeholders" in ~/.patch/config.json: ${...} placeholders are not expanded; the values are used as written.',
    ]);
    expect(warnings.join('\n')).not.toContain(SECRET);
  });

  it('rejects a value that is not an object', () => {
    expect(parse(['github']).warnings).toEqual([
      '"mcpServers" in ~/.patch/config.json must be an object of servers. Ignoring it.',
    ]);
    expect(parse(undefined)).toEqual({ servers: [], warnings: [] });
  });
});

describe('MCP servers in the configuration', () => {
  it('loads "mcpServers" from ~/.patch/config.json without echoing values', () => {
    const home = makeTempDir('patch-mcp-config-');
    cleanups.push(home.cleanup);
    writeFileSync(
      join(home.dir, 'config.json'),
      JSON.stringify({
        mcpServers: {
          github: { command: 'npx', env: { GITHUB_TOKEN: SECRET } },
          broken: { command: 'npx', env: { GITHUB_TOKEN: { value: SECRET } } },
        },
      }),
    );
    const config = loadConfig({
      env: { PATCH_HOME: home.dir },
      defaultModel: 'm',
      homeDir: home.dir,
    });
    expect(config.mcpServers.map((server) => server.name)).toEqual(['github']);
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain('"env.GITHUB_TOKEN" must be a string');
    expect(config.warnings.join('\n')).not.toContain(SECRET);
    expect(config.paths.mcpApprovals).toBe(join(home.dir, 'mcp-approvals.json'));
  });

  it('warns when "mcpServers" is not an object', () => {
    const home = makeTempDir('patch-mcp-config-');
    cleanups.push(home.cleanup);
    writeFileSync(join(home.dir, 'config.json'), JSON.stringify({ mcpServers: ['github'] }));
    const config = loadConfig({
      env: { PATCH_HOME: home.dir },
      defaultModel: 'm',
      homeDir: home.dir,
    });
    expect(config.mcpServers).toEqual([]);
    expect(config.warnings.join('\n')).toContain('"mcpServers"');
  });
});

describe('loadProjectMcpServers', () => {
  function project(content?: string) {
    const temp = makeTempDir('patch-mcp-project-');
    cleanups.push(temp.cleanup);
    if (content !== undefined) writeFileSync(join(temp.dir, '.mcp.json'), content);
    return temp.dir;
  }

  it('reads .mcp.json at the project root as project servers', () => {
    const warnings: string[] = [];
    const dir = project(JSON.stringify({ mcpServers: { db: { command: 'db-mcp' } } }));
    const result = loadProjectMcpServers(dir, warnings);
    expect(warnings).toEqual([]);
    expect(result.servers).toEqual([
      { name: 'db', origin: 'project', transport: 'stdio', command: 'db-mcp', args: [], env: {} },
    ]);
    expect(result.file).toBe(join(dir, '.mcp.json'));
  });

  it('treats a missing file as no servers and reports a broken one', () => {
    const warnings: string[] = [];
    expect(loadProjectMcpServers(project(), warnings)).toEqual({ servers: [] });
    expect(loadProjectMcpServers(project('{ nope'), warnings).servers).toEqual([]);
    expect(loadProjectMcpServers(project('[]'), warnings).servers).toEqual([]);
    const dir = project();
    mkdirSync(join(dir, '.mcp.json'));
    expect(loadProjectMcpServers(dir, warnings).servers).toEqual([]);
    expect(warnings).toEqual([
      expect.stringMatching(/^Could not parse \.mcp\.json: .*\. Ignoring it\.$/),
      '.mcp.json must be a JSON object. Ignoring it.',
      '.mcp.json is not a regular file. Ignoring it.',
    ]);
  });
});

describe('MCP server helpers', () => {
  const stdio: McpServerConfig = {
    name: 'fs',
    origin: 'user',
    transport: 'stdio',
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['server.js', '--root', 'my dir'],
    env: { API_TOKEN: SECRET },
  };
  const http: McpServerConfig = {
    name: 'docs',
    origin: 'project',
    transport: 'http',
    url: `https://user:${SECRET}@docs.example.com/mcp?key=${SECRET}#x`,
    headers: { Authorization: `Bearer ${SECRET}` },
  };

  it('describes a server by its command line or its URL, without secrets', () => {
    expect(describeMcpServer(stdio)).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" server.js --root "my dir"',
    );
    expect(describeMcpServer(http)).toBe('https://docs.example.com/mcp?…');
  });

  it('redacts env and header values and URL credentials from text', () => {
    expect(redactServerSecrets(stdio, `token ${SECRET} rejected`)).toBe(
      'token [REDACTED] rejected',
    );
    expect(redactServerSecrets(http, `got Bearer ${SECRET}`)).toBe('got [REDACTED]');
    expect(redactServerSecrets(http, `bad token ${SECRET}`)).toBe('bad token [REDACTED]');
    const keyed: McpServerConfig = { ...http, url: 'https://x.example.com/mcp?apiKey=k3y-v4lue' };
    expect(redactServerSecrets(keyed, 'GET /mcp?apiKey=k3y-v4lue failed')).toBe(
      'GET /mcp?apiKey=[REDACTED] failed',
    );
  });

  it('fingerprints the whole definition', () => {
    const same = mcpServerFingerprint({ ...stdio });
    expect(mcpServerFingerprint(stdio)).toBe(same);
    expect(mcpServerFingerprint({ ...stdio, origin: 'project' })).toBe(same);
    expect(mcpServerFingerprint({ ...stdio, args: ['server.js'] })).not.toBe(same);
    expect(mcpServerFingerprint({ ...stdio, env: { API_TOKEN: 'other' } })).not.toBe(same);
    expect(mcpServerFingerprint(stdio)).not.toContain(SECRET);
  });

  it('lets the user configuration win over a project server of the same name', () => {
    const warnings: string[] = [];
    const project: McpServerConfig = { ...stdio, origin: 'project', command: 'evil' };
    const other: McpServerConfig = { ...http, name: 'other' };
    expect(mergeMcpServers([stdio], [project, other], warnings)).toEqual([stdio, other]);
    expect(warnings).toEqual([
      'The MCP server "fs" in .mcp.json has the name of one in your configuration; using yours.',
    ]);
  });
});
