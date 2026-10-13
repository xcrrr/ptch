import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ScriptedProvider,
  makeGitRepo,
  makeTempDir,
  mcpTestServerEntry,
  textResponse,
  toolResponse,
  type ScriptStep,
} from '@patch/core/testing';
import { stripAnsi } from '@patch/shared';
import { runCli, type CliIO } from '../src/cli.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

class Capture extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _encoding: string, callback: () => void): void {
    this.text += chunk.toString();
    callback();
  }
}

function workspace(config: unknown, project?: Record<string, unknown>) {
  const repo = makeGitRepo({ 'README.md': '# demo\n' });
  const home = makeTempDir('patch-home-');
  cleanups.push(repo.cleanup, home.cleanup);
  writeFileSync(join(home.dir, 'config.json'), JSON.stringify(config));
  if (project) writeFileSync(join(repo.dir, '.mcp.json'), JSON.stringify({ mcpServers: project }));
  return { repo: repo.dir, home: home.dir };
}

async function print(prompt: string, dirs: { repo: string; home: string }, steps: ScriptStep[]) {
  const provider = new ScriptedProvider(steps);
  const stdout = new Capture();
  const stderr = new Capture();
  const io: Partial<CliIO> = {
    stdin: Readable.from([]) as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    env: { PATH: process.env.PATH, PATCH_HOME: dirs.home },
    cwd: dirs.repo,
    homeDir: dirs.home,
    providerFactory: () => provider,
    assumeCredentials: true,
  };
  const code = await runCli(['-p', prompt], io);
  return { code, provider, stdout: stdout.text, stderr: stripAnsi(stderr.text) };
}

describe('print mode with MCP servers', () => {
  it('skips calls that need approval and says which rule allows them', async () => {
    const dirs = workspace({ mcpServers: { test: mcpTestServerEntry() } });
    const run = await print('say hi', dirs, [
      toolResponse([{ name: 'mcp__test__echo', input: { text: 'hi' } }]),
      textResponse('I could not call the tool.'),
    ]);
    expect(run.code).toBe(0);
    expect(run.provider.requests[0]?.tools.map((tool) => tool.name)).toContain('mcp__test__echo');
    expect(run.stderr).toContain(
      'Needs approval: Patch wants to use an MCP tool — test · echo. Skipped; add "mcp:test__echo" (or "mcp:test") to "permissions.allow" in ~/.patch/config.json to allow it.',
    );
  });

  it('runs calls an "mcp:" rule allows', async () => {
    const dirs = workspace({
      mcpServers: { test: mcpTestServerEntry() },
      permissions: { allow: ['mcp:test'] },
    });
    const run = await print('say hi', dirs, [
      toolResponse([{ name: 'mcp__test__echo', input: { text: 'hi' } }]),
      textResponse('The server said hi.'),
    ]);
    expect(run.code).toBe(0);
    expect(run.stderr).toMatch(/mcp\s+test · echo text: "hi" · 1 line/);
    expect(JSON.stringify(run.provider.requests[1]?.messages.at(-1))).toContain('echo: hi');
  });

  it('never prompts for project servers: unapproved ones are skipped with a notice', async () => {
    const dirs = workspace({}, { proj: mcpTestServerEntry() });
    const run = await print('hi', dirs, [textResponse('ok')]);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain(
      'Skipping the MCP server "proj" from .mcp.json: it is not approved for this project.',
    );
    const tools = run.provider.requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(tools.some((name) => name.startsWith('mcp__'))).toBe(false);
  });

  it('reports a server that cannot start and still answers', async () => {
    const dirs = workspace({ mcpServers: { broken: mcpTestServerEntry('--crash') } });
    const run = await print('hi', dirs, [textResponse('ok')]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('ok\n');
    expect(run.stderr).toContain('MCP server "broken" could not start:');
  });
});
