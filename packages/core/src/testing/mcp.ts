import { fileURLToPath } from 'node:url';

/** The MCP test server (see mcp-test-server.mjs for its tools and options). */
export const MCP_TEST_SERVER = fileURLToPath(new URL('./mcp-test-server.mjs', import.meta.url));

/** An "mcpServers" entry that runs the test server with the current Node binary. */
export function mcpTestServerEntry(...options: string[]): { command: string; args: string[] } {
  return { command: process.execPath, args: [MCP_TEST_SERVER, ...options] };
}
