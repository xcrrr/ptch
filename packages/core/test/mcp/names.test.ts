import { describe, expect, it } from 'vitest';
import { MAX_TOOL_NAME_LENGTH, mcpToolName, sanitizeToolNamePart } from '../../src/mcp/names.js';

describe('mcpToolName', () => {
  it('prefixes the server and keeps valid names as they are', () => {
    expect(mcpToolName('github', 'create_issue', new Set())).toBe('mcp__github__create_issue');
    expect(mcpToolName('my-server', 'Get-Thing', new Set())).toBe('mcp__my-server__Get-Thing');
  });

  it('replaces characters tool names cannot hold', () => {
    expect(sanitizeToolNamePart('get.file/v2 (beta)')).toBe('get_file_v2__beta_');
    expect(sanitizeToolNamePart('')).toBe('_');
    expect(mcpToolName('fs', 'read file', new Set())).toBe('mcp__fs__read_file');
    expect(mcpToolName('fs', 'ünïcode', new Set())).toBe('mcp__fs___n_code');
  });

  it('cuts long names to 64 characters', () => {
    const name = mcpToolName('server', 'x'.repeat(100), new Set());
    expect(name).toHaveLength(MAX_TOOL_NAME_LENGTH);
    expect(name.startsWith('mcp__server__xxx')).toBe(true);
  });

  it('makes names unique with a numbered suffix, within the length limit', () => {
    const taken = new Set(['mcp__fs__read_file']);
    expect(mcpToolName('fs', 'read.file', taken)).toBe('mcp__fs__read_file_2');
    taken.add('mcp__fs__read_file_2');
    expect(mcpToolName('fs', 'read/file', taken)).toBe('mcp__fs__read_file_3');

    const long = 'y'.repeat(80);
    const first = mcpToolName('server', long, new Set());
    const second = mcpToolName('server', `${long}z`, new Set([first]));
    expect(second).not.toBe(first);
    expect(second).toHaveLength(MAX_TOOL_NAME_LENGTH);
    expect(second.endsWith('_2')).toBe(true);
    for (const name of [first, second]) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});
