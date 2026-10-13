import { oneLine } from '@patch/shared';
import { z } from 'zod';
import { defineTool, ToolError, type ToolDefinition } from '../tools/types.js';
import { McpConnectionError, type McpConnection } from './connection.js';
import { mcpToolResult } from './result.js';

/** Characters of a server's tool description kept (descriptions are part of every request). */
const MAX_DESCRIPTION_CHARS = 2_048;
/** Characters of the argument summary on a tool row. */
const MAX_ARGUMENT_SUMMARY_CHARS = 80;
/** Characters of the arguments shown at a permission prompt (ctrl+o shows them all up to this). */
const MAX_ARGUMENT_PREVIEW_CHARS = 4_000;

/** A tool as listed by a server's tools/list, after validation. */
export interface McpToolInfo {
  /** The tool's name on the server. */
  name: string;
  description?: string;
  /** JSON Schema of the arguments; always an object schema. */
  inputSchema: Record<string, unknown>;
}

export interface McpToolOptions {
  /** The name the model sees (see mcpToolName). */
  exposedName: string;
  /** Calls without progress notifications fail after this long. */
  callTimeoutMs: number;
}

/** Any JSON object: the server validates the arguments against its schema. */
const ArgumentsSchema = z.record(z.string(), z.unknown());

/**
 * A server's tool as a Patch tool. It is execute class: the server runs it with the user's
 * privileges, so every call goes through the permission manager (subject kind "mcp"). The
 * description names the server; the input schema is the server's own.
 *
 * Row: verb "mcp", target "<server> · <tool>", the arguments summarized as detail; the outcome
 * goes on a second line.
 */
export function createMcpTool(
  connection: McpConnection,
  info: McpToolInfo,
  options: McpToolOptions,
): ToolDefinition<Record<string, unknown>> {
  const server = connection.server.name;
  const description = info.description?.trim() || 'No description.';
  return defineTool({
    name: options.exposedName,
    description: `${server} (MCP server): ${truncate(description, MAX_DESCRIPTION_CHARS)}`,
    inputSchema: ArgumentsSchema,
    jsonSchema: info.inputSchema,
    permissionClass: 'execute',
    summarize(input) {
      const args = summarizeArguments(input);
      return { verb: 'mcp', target: `${server} · ${info.name}`, ...(args ? { detail: args } : {}) };
    },
    permission(input) {
      return { kind: 'mcp', server, tool: info.name, exposedName: options.exposedName, input };
    },
    async preview(input) {
      return { text: argumentsPreview(input) };
    },
    async execute(input, ctx) {
      try {
        const result = await connection.callTool(info.name, input, {
          signal: ctx.signal,
          timeoutMs: options.callTimeoutMs,
          onProgress: (text) => ctx.onProgress?.({ tail: [oneLine(text, 200)], totalLines: 1 }),
        });
        return mcpToolResult(result, { server, tool: info.name });
      } catch (error) {
        if (!(error instanceof McpConnectionError)) throw error;
        const message = `The MCP server "${server}" could not run ${info.name}: ${error.message}.`;
        throw new ToolError(message, { summary: error.message });
      }
    },
  });
}

/** `path: "src/a.ts", limit: 10` — the arguments in one short line. */
export function summarizeArguments(input: Record<string, unknown>): string | undefined {
  const entries = Object.entries(input);
  if (entries.length === 0) return undefined;
  const text = entries.map(([key, value]) => `${key}: ${compactJson(value)}`).join(', ');
  return oneLine(text, MAX_ARGUMENT_SUMMARY_CHARS);
}

/** The arguments as compact JSON, cut at MAX_ARGUMENT_PREVIEW_CHARS. */
export function argumentsPreview(input: Record<string, unknown>): string {
  if (Object.keys(input).length === 0) return '(no arguments)';
  return truncate(compactJson(input), MAX_ARGUMENT_PREVIEW_CHARS);
}

function compactJson(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}
