/** Longest tool name model APIs accept (Anthropic: ^[a-zA-Z0-9_-]{1,64}$). */
export const MAX_TOOL_NAME_LENGTH = 64;
/** Prefix of every MCP tool's name. */
export const MCP_TOOL_PREFIX = 'mcp__';

/** Replaces every character a tool name cannot hold with "_". */
export function sanitizeToolNamePart(text: string): string {
  const sanitized = text.replace(/[^A-Za-z0-9_-]/g, '_');
  return sanitized === '' ? '_' : sanitized;
}

/**
 * The name the model sees for a server's tool: `mcp__<server>__<tool>`, sanitized, cut to
 * MAX_TOOL_NAME_LENGTH characters and made unique against `taken` with a `_2`, `_3`, ... suffix.
 * Does not add the name to `taken`.
 */
export function mcpToolName(server: string, tool: string, taken: ReadonlySet<string>): string {
  const base = `${MCP_TOOL_PREFIX}${sanitizeToolNamePart(server)}__${sanitizeToolNamePart(tool)}`;
  let name = base.slice(0, MAX_TOOL_NAME_LENGTH);
  for (let n = 2; taken.has(name); n++) {
    const suffix = `_${n}`;
    name = base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) + suffix;
  }
  return name;
}
