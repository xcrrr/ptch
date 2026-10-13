// A tiny MCP server for Patch's tests and end-to-end scenarios, on the official SDK's server API
// over stdio. Run it with Node: `node mcp-test-server.mjs [options]`.
//
// Tools: echo {text}, pixel {} (a 1×1 PNG), huge_image {} (over the image size limit),
// fail {} (an isError result), big {lines} (long output), sleep {ms} (cancellable; reports
// progress), stats {} (calls and cancellations so far), env {name} (one environment variable).
//
// Options:
//   --slow-start=<ms>   wait before answering anything (a slow server)
//   --crash             print to stderr and exit with code 3 at once
//   --page-size=<n>     list the tools <n> per page (pagination)
//   --bad-tools         also list a tool with a non-object schema, one without a name and one
//                       whose name needs sanitizing ("get.file/v2")
//   --child             start a child process that runs until killed; the child_pid tool
//                       returns its pid
//   --name=<name>       the server's name in its handshake (default "patch-test")
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }),
);

if (options.crash) {
  process.stderr.write('patch-test: missing configuration, giving up\n');
  process.exit(3);
}

/** A valid 1×1 PNG. */
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const object = (properties = {}, required = []) => ({ type: 'object', properties, required });

const tools = [
  {
    name: 'echo',
    description: 'Echoes the text back.',
    inputSchema: object({ text: { type: 'string' } }, ['text']),
  },
  { name: 'pixel', description: 'Returns a 1×1 PNG image.', inputSchema: object() },
  { name: 'huge_image', description: 'Returns an image that is too large.', inputSchema: object() },
  { name: 'fail', description: 'Always fails.', inputSchema: object() },
  {
    name: 'big',
    description: 'Returns many lines.',
    inputSchema: object({ lines: { type: 'number' } }, ['lines']),
  },
  {
    name: 'sleep',
    description: 'Waits, until cancelled.',
    inputSchema: object({ ms: { type: 'number' } }),
  },
  { name: 'stats', description: 'Calls and cancellations so far.', inputSchema: object() },
  {
    name: 'env',
    description: 'Returns an environment variable.',
    inputSchema: object({ name: { type: 'string' } }, ['name']),
  },
];
if (options['bad-tools']) {
  tools.push(
    { name: 'stringly', description: 'Bad schema.', inputSchema: { type: 'string' } },
    { description: 'No name.', inputSchema: object() },
    { name: 'get.file/v2', description: 'A name to sanitize.', inputSchema: object() },
  );
}

let child;
if (options.child) {
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  tools.push({ name: 'child_pid', description: 'The child process id.', inputSchema: object() });
}

const stats = { calls: 0, cancelled: 0 };
const text = (value) => ({ content: [{ type: 'text', text: value }] });

const server = new Server(
  { name: typeof options.name === 'string' ? options.name : 'patch-test', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const size = Number(options['page-size']) || tools.length;
  const start = Number(request.params?.cursor ?? 0);
  const page = tools.slice(start, start + size);
  const next = start + size < tools.length ? String(start + size) : undefined;
  return { tools: page, ...(next ? { nextCursor: next } : {}) };
});

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  stats.calls += 1;
  const args = request.params.arguments ?? {};
  switch (request.params.name) {
    case 'echo':
      return text(`echo: ${args.text}`);
    case 'pixel':
      return {
        content: [
          { type: 'text', text: 'a pixel' },
          { type: 'image', data: PIXEL_PNG, mimeType: 'image/png' },
        ],
      };
    case 'huge_image': {
      const header = Buffer.from(PIXEL_PNG, 'base64').subarray(0, 33);
      const data = Buffer.concat([header, Buffer.alloc(4 * 1024 * 1024)]).toString('base64');
      return { content: [{ type: 'image', data, mimeType: 'image/png' }] };
    }
    case 'fail':
      return {
        content: [{ type: 'text', text: 'Something went wrong\nat step 2' }],
        isError: true,
      };
    case 'big':
      return text(Array.from({ length: Number(args.lines) }, (_, i) => `line ${i + 1}`).join('\n'));
    case 'sleep': {
      const token = request.params._meta?.progressToken;
      if (token !== undefined) {
        await extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken: token, progress: 1, total: 2, message: 'sleeping' },
        });
      }
      try {
        await sleep(Number(args.ms ?? 60_000), undefined, { signal: extra.signal });
      } catch {
        stats.cancelled += 1;
        return text('cancelled');
      }
      return text('awake');
    }
    case 'stats':
      return text(JSON.stringify(stats));
    case 'env':
      return text(process.env[String(args.name)] ?? '(unset)');
    case 'child_pid':
      return text(String(child?.pid ?? ''));
    default:
      return {
        content: [{ type: 'text', text: `Unknown tool ${request.params.name}` }],
        isError: true,
      };
  }
});

if (options['slow-start']) await sleep(Number(options['slow-start']));
process.stderr.write('patch-test MCP server ready\n');
await server.connect(new StdioServerTransport());
