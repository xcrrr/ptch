import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/tools/registry.js';
import { defineTool, type ToolDefinition } from '../../src/tools/types.js';

function tool(name: string, jsonSchema?: Record<string, unknown>): ToolDefinition {
  return defineTool({
    name,
    description: `The ${name} tool.`,
    inputSchema: z.object({ value: z.string() }),
    ...(jsonSchema ? { jsonSchema } : {}),
    permissionClass: 'read',
    summarize: () => ({ verb: name, target: '' }),
    permission: () => ({ kind: 'read', paths: [] }),
    execute: async () => ({ content: '' }),
  }) as ToolDefinition;
}

describe('ToolRegistry', () => {
  it('sends a tool’s own JSON schema when it has one', () => {
    const schema = { type: 'object', properties: { q: { type: 'string', format: 'uri' } } };
    const [plain, raw] = new ToolRegistry([tool('plain'), tool('raw', schema)]).specs();
    expect(plain?.inputSchema).toMatchObject({ type: 'object', required: ['value'] });
    expect(raw?.inputSchema).toEqual(schema);
  });

  it('takes more tools only until a request used the list', () => {
    const registry = new ToolRegistry([tool('a')]);
    registry.extend([tool('b'), tool('c')]);
    expect(registry.names()).toEqual(['a', 'b', 'c']);
    expect(() => registry.extend([tool('a')])).toThrow('Duplicate tool name: a');
    // A rejected batch adds nothing.
    expect(() => registry.extend([tool('d'), tool('d')])).toThrow('Duplicate tool name: d');
    expect(registry.names()).toEqual(['a', 'b', 'c']);
    registry.specs();
    expect(() => registry.extend([tool('e')])).toThrow(
      'The tool list is fixed once a request has used it.',
    );
  });
});
