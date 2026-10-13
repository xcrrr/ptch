/**
 * Serves a scripted conversation from the mock Anthropic API, for offline manual testing:
 *
 *   node packages/provider-anthropic/src/testing/serve.ts [--port 4010] [--lenient] [script.json]
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:4010 ANTHROPIC_API_KEY=mock ptch
 *
 * The script is a JSON array of MockResponse objects (see mock-server.ts), answered in order;
 * once it is used up every request gets a short text reply. Requests and conformance violations
 * are logged to stderr. `--lenient` records violations without rejecting requests.
 *
 * Runs on Node versions with built-in TypeScript type stripping (22.18+ / 23.6+).
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type * as MockServerModule from './mock-server.js';
import type { MockResponse, RecordedRequest } from './mock-server.js';

export const DEFAULT_PORT = 4010;

export interface ServeOptions {
  port: number;
  strict: boolean;
  scriptPath?: string;
}

const USAGE = 'Usage: serve.ts [--port <port>] [--lenient] [script.json]';
const BLOCK_TYPES = new Set([
  'text',
  'tool_use',
  'thinking',
  'redacted_thinking',
  'fallback',
  'server_tool_use',
  'web_search_tool_result',
  'web_fetch_tool_result',
]);

export function parseServeArgs(argv: string[]): ServeOptions {
  const options: ServeOptions = { port: DEFAULT_PORT, strict: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--port') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error(`--port needs a port number between 0 and 65535.\n${USAGE}`);
      }
      options.port = value;
    } else if (arg === '--lenient') {
      options.strict = false;
    } else if (arg.startsWith('-') || options.scriptPath !== undefined) {
      throw new Error(`Unexpected argument: ${arg}\n${USAGE}`);
    } else {
      options.scriptPath = arg;
    }
  }
  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scriptItemProblem(item: unknown): string | undefined {
  if (!isRecord(item)) return 'must be an object';
  if ('status' in item || 'error' in item) {
    const error = item['error'];
    if (typeof item['status'] !== 'number') return 'an error response needs a numeric "status"';
    if (
      !isRecord(error) ||
      typeof error['type'] !== 'string' ||
      typeof error['message'] !== 'string'
    ) {
      return 'an error response needs "error": {"type", "message"}';
    }
    return undefined;
  }
  const content = item['content'];
  if (!Array.isArray(content)) return 'a message response needs a "content" array';
  const badBlock = content.findIndex(
    (block: unknown) => !isRecord(block) || !BLOCK_TYPES.has(String(block['type'])),
  );
  if (badBlock >= 0) {
    return `content[${badBlock}] must have a type of ${[...BLOCK_TYPES].join(', ')}`;
  }
  return undefined;
}

/** Parses and validates a script file's text: a JSON array of MockResponse objects. */
export function parseScript(text: string, source: string): MockResponse[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${source} is not valid JSON: ${reason}`, { cause: error });
  }
  if (!Array.isArray(value)) throw new Error(`${source} must contain a JSON array of responses.`);
  value.forEach((item: unknown, index: number) => {
    const problem = scriptItemProblem(item);
    if (problem) throw new Error(`${source}: response ${index} ${problem}.`);
  });
  return value as MockResponse[];
}

function describeRequest(request: RecordedRequest): string {
  const { model, messages, tools } = request.body;
  const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  return `${String(model ?? '?')}, ${count(messages)} message(s), ${count(tools)} tool(s)`;
}

async function loadMockServer(): Promise<typeof MockServerModule> {
  // Imported by URL with the real .ts extension: Node's type stripping does not map the .js
  // specifiers used elsewhere in this package onto .ts sources.
  return (await import(
    new URL('./mock-server.ts', import.meta.url).href
  )) as typeof MockServerModule;
}

export async function serve(options: ServeOptions): Promise<MockServerModule.MockAnthropicServer> {
  const script = options.scriptPath
    ? parseScript(readFileSync(options.scriptPath, 'utf8'), options.scriptPath)
    : [];
  const { startMockAnthropicServer } = await loadMockServer();
  let requestCount = 0;
  const server = await startMockAnthropicServer({
    port: options.port,
    strict: options.strict,
    onRequest: (request) => {
      requestCount += 1;
      process.stderr.write(`request ${requestCount}: ${describeRequest(request)}\n`);
    },
    onViolation: (violation) => process.stderr.write(`VIOLATION ${violation}\n`),
  });
  server.enqueue(...script);
  server.setFallbackResponder(() => ({
    content: [{ type: 'text', text: 'The scripted conversation has ended.' }],
  }));
  process.stderr.write(
    `Mock Anthropic API listening on ${server.url} (${script.length} scripted response(s))\n` +
      `  ANTHROPIC_BASE_URL=${server.url} ANTHROPIC_API_KEY=mock ptch\n`,
  );
  return server;
}

async function main(): Promise<void> {
  const server = await serve(parseServeArgs(process.argv.slice(2)));
  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function canonicalPath(path: string): string {
  const real = realpathSync(path);
  return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
}

/** True when this file is the program node was started with (not imported by a test). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return canonicalPath(entry) === canonicalPath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
