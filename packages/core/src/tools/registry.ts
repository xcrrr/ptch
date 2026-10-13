import { z } from 'zod';
import type { ToolSpec } from '@patch/shared';
import type { ToolDefinition } from './types.js';

/**
 * Holds the tool set for a session. Tools discovered at startup (MCP servers) can be added until
 * the specs are first taken for a request; from then on the set is fixed, since the tool list is
 * part of the cached prompt prefix.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private sealed = false;

  constructor(tools: ToolDefinition[]) {
    this.addAll(tools);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Adds tools after the default set (MCP tools, discovered before the first request). Throws once
   * specs() was called: the tool list never changes after a request used it.
   */
  extend(tools: ToolDefinition[]): void {
    if (this.sealed) throw new Error('The tool list is fixed once a request has used it.');
    this.addAll(tools);
  }

  /** Provider-neutral tool specs. Deterministic order and content (important for prompt caching). */
  specs(): ToolSpec[] {
    this.sealed = true;
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.jsonSchema
        ? structuredClone(tool.jsonSchema)
        : toJsonSchema(tool.inputSchema),
    }));
  }

  /** All or nothing: a duplicate name adds none of the tools. */
  private addAll(tools: ToolDefinition[]): void {
    const names = new Set(this.tools.keys());
    for (const tool of tools) {
      if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
      names.add(tool.name);
    }
    for (const tool of tools) this.tools.set(tool.name, tool);
  }
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  if (json.type !== 'object') {
    throw new Error('Tool input schemas must be objects');
  }
  return json;
}
