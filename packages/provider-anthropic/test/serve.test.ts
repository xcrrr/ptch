import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/provider.js';
import { DEFAULT_PORT, parseScript, parseServeArgs, serve } from '../src/testing/serve.js';
import { collect, makeRequest } from './helpers.js';

const SERVE_PATH = fileURLToPath(new URL('../src/testing/serve.ts', import.meta.url));

const SCRIPT = [
  {
    content: [
      { type: 'thinking', thinking: 'Reading.' },
      { type: 'text', text: 'Scripted reply.' },
    ],
  },
  { status: 529, error: { type: 'overloaded_error', message: 'Scripted overload' } },
];

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function writeScript(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'patch-mock-script-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'script.json');
  writeFileSync(file, JSON.stringify(content));
  return file;
}

describe('parseServeArgs', () => {
  it('uses defaults', () => {
    expect(parseServeArgs([])).toEqual({ port: DEFAULT_PORT, strict: true });
  });

  it('reads the port, lenient flag and script path', () => {
    expect(parseServeArgs(['--port', '0', '--lenient', 'script.json'])).toEqual({
      port: 0,
      strict: false,
      scriptPath: 'script.json',
    });
  });

  it.each([
    [['--port'], /--port needs a port number/],
    [['--port', 'abc'], /--port needs a port number/],
    [['--port', '70000'], /--port needs a port number/],
    [['--verbose'], /Unexpected argument: --verbose/],
    [['a.json', 'b.json'], /Unexpected argument: b\.json/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseServeArgs(argv)).toThrow(message);
  });
});

describe('parseScript', () => {
  it('accepts message and error responses', () => {
    expect(parseScript(JSON.stringify(SCRIPT), 's.json')).toEqual(SCRIPT);
  });

  it.each([
    ['{', /s\.json is not valid JSON/],
    ['{}', /must contain a JSON array/],
    ['[1]', /response 0 must be an object/],
    ['[{"content": "text"}]', /response 0 a message response needs a "content" array/],
    ['[{"content": [{"type": "image"}]}]', /content\[0\] must have a type of/],
    ['[{"status": "500", "error": {}}]', /needs a numeric "status"/],
    ['[{"status": 500, "error": {"type": "api_error"}}]', /needs "error": \{"type", "message"\}/],
  ])('rejects %s', (text, message) => {
    expect(() => parseScript(text, 's.json')).toThrow(message);
  });
});

describe('serve', () => {
  it('serves the script in order and logs requests', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const server = await serve({ port: 0, strict: true, scriptPath: writeScript(SCRIPT) });
    cleanups.push(() => server.close());
    const provider = new AnthropicProvider({ apiKey: 'mock', baseUrl: server.url, maxRetries: 0 });

    const { end } = await collect(provider.stream(makeRequest()));
    expect(end.message.content.at(-1)).toEqual({ type: 'text', text: 'Scripted reply.' });
    await expect(collect(provider.stream(makeRequest()))).rejects.toMatchObject({
      kind: 'overloaded',
    });
    const { end: after } = await collect(provider.stream(makeRequest()));
    expect(after.message.content).toEqual([
      { type: 'text', text: 'The scripted conversation has ended.' },
    ]);

    const output = lines.join('');
    expect(output).toContain(
      `Mock Anthropic API listening on ${server.url} (2 scripted response(s))`,
    );
    expect(output).toContain('request 1: claude-opus-5-5, 1 message(s), 1 tool(s)');
  });
});

const supportsTypeStripping = Boolean((process.features as { typescript?: unknown }).typescript);

describe.skipIf(!supportsTypeStripping)('serve.ts as a command', () => {
  it('runs directly under node and serves the script', async () => {
    const child = spawn(process.execPath, [SERVE_PATH, '--port', '0', writeScript(SCRIPT)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    cleanups.push(() => {
      child.kill();
    });
    let stderr = '';
    const url = await new Promise<string>((resolve, reject) => {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stderr);
        if (match?.[1]) resolve(match[1]);
      });
      child.once('exit', (code) => reject(new Error(`serve.ts exited with ${code}: ${stderr}`)));
    });

    const provider = new AnthropicProvider({ apiKey: 'mock', baseUrl: url, maxRetries: 0 });
    const { end } = await collect(provider.stream(makeRequest()));
    expect(end.message.content.at(-1)).toEqual({ type: 'text', text: 'Scripted reply.' });
  });

  it('exits with an error for an invalid script', async () => {
    const child = spawn(process.execPath, [SERVE_PATH, writeScript({ not: 'an array' })], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(1);
    expect(stderr).toContain('must contain a JSON array of responses');
  });
});
