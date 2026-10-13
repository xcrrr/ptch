import { pathApi } from './path-utils.js';

/** A parsed permission rule from config or CLI flags (see `PermissionRules`). */
export type PermissionRule =
  | { kind: 'edit' }
  | { kind: 'bash-all' }
  | { kind: 'bash-prefix'; prefix: string }
  | { kind: 'read'; path: string }
  /**
   * MCP tools: `target` is a server name (every tool of the server) or `<server>__<tool>`. Server
   * names may themselves contain "__", so a rule is matched against each call (see
   * mcpRuleMatches) rather than split here.
   */
  | { kind: 'mcp'; target: string };

export type RuleParseResult = { ok: true; rule: PermissionRule } | { ok: false; problem: string };

const RULE_FORMS =
  '"edit", "bash:<command prefix>", "bash:*", "read:<absolute directory>", "mcp:<server>" or "mcp:<server>__<tool>"';

/** "mcp:<server>" or "mcp:<server>__<tool>": a server name, then optionally "__" and a tool name. */
const MCP_RULE_TARGET = /^[A-Za-z0-9_-]+(?:__\S+)?$/;

/**
 * Parses one rule string: "edit", "bash:<prefix>", "bash:*", "read:<absolute dir>",
 * "mcp:<server>" or "mcp:<server>__<tool>". Rule types are case-insensitive; a trailing "*" on a
 * bash prefix ("bash:npm run *") is accepted and means the same as the bare prefix.
 */
export function parsePermissionRule(
  text: string,
  platform: NodeJS.Platform = process.platform,
): RuleParseResult {
  const rule = text.trim();
  if (rule === '') return { ok: false, problem: `the rule is empty; expected ${RULE_FORMS}` };
  const colon = rule.indexOf(':');
  const type = (colon < 0 ? rule : rule.slice(0, colon)).trim().toLowerCase();
  const value = colon < 0 ? '' : rule.slice(colon + 1).trim();
  switch (type) {
    case 'edit':
      return colon < 0
        ? { ok: true, rule: { kind: 'edit' } }
        : { ok: false, problem: '"edit" does not take a value' };
    case 'bash':
      return parseBashRule(value);
    case 'read':
      return parseReadRule(value, platform);
    case 'mcp':
      return parseMcpRule(value);
    default:
      return { ok: false, problem: `unknown rule type "${type}"; expected ${RULE_FORMS}` };
  }
}

function parseMcpRule(value: string): RuleParseResult {
  if (value === '') {
    return { ok: false, problem: 'expected a server name after "mcp:", e.g. "mcp:github"' };
  }
  if (value.includes('*')) {
    return {
      ok: false,
      problem:
        'wildcards are not supported; "mcp:<server>" covers every tool of a server, "mcp:<server>__<tool>" one tool',
    };
  }
  if (!MCP_RULE_TARGET.test(value)) {
    return {
      ok: false,
      problem:
        'expected "mcp:<server>" or "mcp:<server>__<tool>" (server names use A-Z, a-z, 0-9, _ and -)',
    };
  }
  return { ok: true, rule: { kind: 'mcp', target: value } };
}

/**
 * True when an "mcp:" rule covers a call: its target is the server's name, or the server's name,
 * "__" and the tool's name (as the server calls it, or as the model sees it after the
 * "mcp__<server>__" prefix).
 */
export function mcpRuleMatches(
  rule: Extract<PermissionRule, { kind: 'mcp' }>,
  call: { server: string; tool: string; exposedName: string },
): boolean {
  const { target } = rule;
  if (target === call.server) return true;
  const exposedTool = call.exposedName.startsWith(`mcp__${call.server}__`)
    ? call.exposedName.slice(`mcp__${call.server}__`.length)
    : undefined;
  return target === `${call.server}__${call.tool}` || target === `${call.server}__${exposedTool}`;
}

function parseBashRule(value: string): RuleParseResult {
  if (value === '*') return { ok: true, rule: { kind: 'bash-all' } };
  const prefix = normalizeCommandText(value.replace(/\s*:?\*$/, ''));
  if (prefix === '') {
    return { ok: false, problem: 'expected a command prefix after "bash:", e.g. "bash:pnpm test"' };
  }
  if (/[;&|<>`]|\$\(/.test(prefix)) {
    return {
      ok: false,
      problem: 'a command prefix cannot contain shell operators; add one rule per command',
    };
  }
  if (prefix.includes('*')) {
    return {
      ok: false,
      problem: 'wildcards are only supported at the end ("bash:npm run *") or alone ("bash:*")',
    };
  }
  return { ok: true, rule: { kind: 'bash-prefix', prefix } };
}

function parseReadRule(value: string, platform: NodeJS.Platform): RuleParseResult {
  const api = pathApi(platform);
  if (value === '') return { ok: false, problem: 'expected an absolute directory after "read:"' };
  if (!api.isAbsolute(value)) {
    return { ok: false, problem: `read rules need an absolute directory, not "${value}"` };
  }
  return { ok: true, rule: { kind: 'read', path: api.resolve(value) } };
}

/** Plain-language description, e.g. 'commands starting with "pnpm test"'. */
export function describeRule(rule: PermissionRule): string {
  switch (rule.kind) {
    case 'edit':
      return 'editing files inside the project';
    case 'bash-all':
      return 'all commands except blocked ones';
    case 'bash-prefix':
      return `commands starting with "${rule.prefix}"`;
    case 'read':
      return `reading files under ${rule.path}`;
    case 'mcp':
      return rule.target.includes('__')
        ? `the MCP tool ${rule.target}`
        : `every tool of the MCP server ${rule.target}`;
  }
}

/** Collapses runs of whitespace to single spaces and trims. */
export function normalizeCommandText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** True when `text` is `prefix` or starts with `prefix` followed by a space (word boundary). */
export function commandMatchesPrefix(text: string, prefix: string): boolean {
  const command = normalizeCommandText(text);
  const wanted = normalizeCommandText(prefix);
  return wanted !== '' && (command === wanted || command.startsWith(`${wanted} `));
}
