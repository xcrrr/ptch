import type { ResolvedPath } from '../fs/paths.js';
import type {
  PermissionClass,
  PermissionSubject,
  ToolCallSummary,
  ToolPreview,
} from '../tools/types.js';
import {
  RISK_ORDER,
  type CommandAnalysis,
  type CommandRisk,
  type CommandSegment,
} from './command-risk.js';
import { shapeOf, withinShape } from './grant-shape.js';
import type { PermissionMode } from './modes.js';
import { isCaseInsensitivePlatform, isWithin, pathApi, samePath } from './path-utils.js';
import {
  commandMatchesPrefix,
  describeRule,
  mcpRuleMatches,
  normalizeCommandText,
  parsePermissionRule,
  type PermissionRule,
} from './rules.js';

/**
 * A permission grant remembered for the rest of the session (never persisted).
 *  - all-edits:      allow file creation/modification inside the project
 *  - command-prefix: allow shell commands whose normalized text starts with `prefix` (word-boundary)
 *  - read-path:      allow reads of this file or anything under this directory
 *  - mcp-tool:       allow calls to one tool of one MCP server (`tool`: its name on the server)
 */
export type SessionGrant =
  | { kind: 'all-edits' }
  | {
      kind: 'command-prefix';
      prefix: string;
      /**
       * Option names the approved command used after the prefix. When present, a later command
       * is covered only if it uses no other options (new options ask again). Absent: any options.
       */
      options?: string[];
      /** Variable names the approved command set (`CI` in `CI=1 pnpm test`); same rule. */
      variables?: string[];
    }
  | { kind: 'read-path'; path: string }
  | { kind: 'mcp-tool'; server: string; tool: string };

/**
 * Config/flag rule syntax (strings in ~/.patch/config.json "permissions.allow" / "deny"):
 *   "edit"                  all file writes inside the project
 *   "bash:<prefix>"         commands starting with <prefix> (e.g. "bash:pnpm test")
 *   "bash:*"                every command that is not blocked (allow only; use with care)
 *   "read:<absolute dir>"   reads under a directory outside the project
 *   "mcp:<server>"          every tool of an MCP server
 *   "mcp:<server>__<tool>"  one tool of an MCP server
 * Deny rules win over allow rules. Blocked commands can never be allowed.
 */
export interface PermissionRules {
  allow: string[];
  deny: string[];
}

export type Severity = 'normal' | 'warning' | 'danger';

export interface PermissionPrompt {
  /** e.g. "Patch wants to run a command", "Potentially destructive command", "Patch wants to edit src/a.ts" */
  title: string;
  /** The thing being approved, shown prominently (a command, a path). */
  subjectLine: string;
  severity: Severity;
  /** Extra explanation, e.g. "Deletes files (rm)" or "This file may contain secrets." */
  reason?: string;
  /**
   * Present when the user may approve for the rest of the session. `grant` is the primary grant;
   * `grants`, when set, lists every grant the option applies (a chained command may need one per
   * segment, e.g. "git add" and "git commit"). Callers apply `grants ?? [grant]`.
   */
  sessionOption?: { label: string; grant: SessionGrant; grants?: SessionGrant[] };
}

export type PermissionDecision =
  | { type: 'allow'; reason: string }
  | { type: 'deny'; reason: string; /** Text returned to the model. */ message: string }
  | { type: 'ask'; prompt: PermissionPrompt };

export interface PermissionRequest {
  id: string;
  toolName: string;
  summary: ToolCallSummary;
  subject: PermissionSubject;
  prompt: PermissionPrompt;
  preview?: ToolPreview;
}

export type PermissionResponse =
  | { decision: 'allow_once' }
  | { decision: 'allow_session' }
  | { decision: 'deny'; feedback?: string };

export interface PermissionRuleView {
  source: 'default' | 'config' | 'flag' | 'session';
  effect: 'allow' | 'ask' | 'deny';
  description: string;
}

export interface PermissionManagerOptions {
  /** Rules from ~/.patch/config.json. */
  config?: PermissionRules;
  /** Rules from CLI flags (print mode: --allow-edits → "edit", --allow-command X → "bash:X"). */
  flags?: PermissionRules;
  /** The mode to start in (default `default`). */
  mode?: PermissionMode;
}

interface CompiledRule {
  /** The rule as the user wrote it (trimmed). */
  text: string;
  rule: PermissionRule;
  source: 'config' | 'flag';
}

const PLATFORM = process.platform;

const SENSITIVE_READ_REASON =
  'This file may contain secrets. Its contents will be sent to the model provider.';
const GIT_DIR_MESSAGE = 'Patch does not modify files inside .git. Use git commands instead.';
const BLOCKED_USER_MESSAGE =
  'Patch does not run commands that require elevated privileges. Run it in your own terminal.';

const PLAN_MODE_REASON = 'Plan mode (read-only)';
const AUTO_MODE_REASON = 'Auto mode';
const PLAN_MODE_NEXT =
  'Keep researching with read-only tools, then present your plan with present_plan instead.';
/** What the model is told about a call plan mode denies, by what the call would have done. */
const PLAN_MODE_MESSAGES = {
  write: `Plan mode is on: the user wants to see a plan before anything changes, so files cannot be edited yet. ${PLAN_MODE_NEXT}`,
  command: `Plan mode is on: the user wants to see a plan before anything changes, so only read-only commands run, and this one could change something. ${PLAN_MODE_NEXT}`,
  tool: `Plan mode is on: the user wants to see a plan before anything changes, so tools that could change something do not run yet. ${PLAN_MODE_NEXT}`,
} as const;

const DEFAULT_RULES: PermissionRuleView[] = [
  { source: 'default', effect: 'allow', description: 'Read files inside the project' },
  { source: 'default', effect: 'ask', description: 'Ask before reading files outside the project' },
  {
    source: 'default',
    effect: 'ask',
    description: 'Ask before reading sensitive files (.env, keys, credentials)',
  },
  { source: 'default', effect: 'ask', description: 'Ask before editing files' },
  { source: 'default', effect: 'deny', description: 'Never modify files inside .git' },
  {
    source: 'default',
    effect: 'allow',
    description: 'Run read-only commands (ls, cat, git status, rg, ...)',
  },
  { source: 'default', effect: 'ask', description: 'Ask before running other commands' },
  {
    source: 'default',
    effect: 'ask',
    description: 'Always ask before potentially destructive commands',
  },
  {
    source: 'default',
    effect: 'deny',
    description: 'Never run commands that need elevated privileges or damage the system',
  },
  { source: 'default', effect: 'ask', description: 'Ask before calling tools of MCP servers' },
];

/** Characters of an MCP tool's name shown in a session option before it is cut. */
const MCP_LABEL_TOOL_CHARS = 48;

/**
 * Decides whether a tool call may proceed.
 *
 * Defaults:
 *  - read inside project, not sensitive            → allow
 *  - read outside project or sensitive file        → ask (session option: read-path for the file/dir)
 *  - write inside project                          → ask (session option: all-edits)
 *  - write outside project                         → ask, severity danger, no session option
 *  - write to a sensitive file                     → ask, severity warning, no session option
 *  - write inside .git/                            → deny
 *  - execute safe                                  → allow
 *  - execute normal/network                        → ask (session option: command-prefix when
 *                                                    analysis.rulePrefix is set)
 *  - execute destructive                           → ask, severity danger, no session option
 *  - execute blocked                               → deny with explanation for the model
 *  - MCP tool call (execute class)                 → ask (session option: that tool of that
 *                                                    server); "mcp:" rules allow or deny
 * Order: blocked/deny rules → session grants & allow rules → defaults. A compound command is
 * allowed by grants/rules only if every segment is covered.
 * User-originated commands (`origin: 'user'`, the `!` escape) follow the same rules.
 *
 * Details:
 *  - Writes inside .git are denied before any rule is consulted, like blocked commands.
 *  - "edit" grants and rules cover writes inside the project only, never sensitive files.
 *  - Directory read grants and rules never cover sensitive files; only a grant or rule naming
 *    that exact file does.
 *  - Session command grants cover only normal/network segments of parsable commands without
 *    substitutions; config/flag "bash:" rules also cover destructive segments (the user wrote
 *    them explicitly). Deny prefixes match any segment, also when options sit between the words
 *    ("bash:git push" denies "git -C x push").
 *  - User-typed commands that are safe, normal or network are allowed ("typed by the user");
 *    destructive ones ask; blocked ones are denied.
 *
 * Modes (see PermissionMode) apply on top:
 *  - acceptEdits allows what an all-edits grant would: writes inside the project that are not
 *    sensitive (writes outside the project and to sensitive files still ask).
 *  - plan works by permission class, the tool's and its subject's, so tools added later are
 *    covered by the class they declare: read and `none` calls follow the rules above; write
 *    calls are denied; execute calls are denied unless they are commands that run without asking
 *    anyway (read-only commands that pass the strict gate, i.e. risk "safe"). Grants and allow
 *    rules do not lift this. Denials keep their own message (deny rules still win), and commands
 *    the user typed (`!`) are theirs to run.
 *  - auto allows what would ask, whatever its class (reads and writes outside the project,
 *    normal and network commands, execute-class tools), except the guardrails, which ask as
 *    before: destructive commands, and commands Patch cannot fully analyze (they might be
 *    destructive); commands that may read or print secrets; and sensitive files. Denials never
 *    change (blocked commands, writes inside .git, deny rules). Nothing is remembered: leaving
 *    auto mode asks again.
 */
export class PermissionManager {
  private readonly grants: SessionGrant[] = [];
  private readonly config: PermissionRules;
  private readonly flags: PermissionRules;
  private readonly allowRules: CompiledRule[];
  private readonly denyRules: CompiledRule[];
  private currentMode: PermissionMode;

  constructor(options: PermissionManagerOptions = {}) {
    this.config = options.config ?? { allow: [], deny: [] };
    this.flags = options.flags ?? { allow: [], deny: [] };
    this.allowRules = [
      ...compile(this.config.allow, 'config'),
      ...compile(this.flags.allow, 'flag'),
    ];
    this.denyRules = [...compile(this.config.deny, 'config'), ...compile(this.flags.deny, 'flag')];
    this.currentMode = options.mode ?? 'default';
  }

  /**
   * Decides a call. `permissionClass` is the class of the tool making it (by default the class
   * the subject implies); plan mode goes by the stricter of the two.
   */
  evaluate(
    subject: PermissionSubject,
    permissionClass: PermissionClass = permissionClassOf(subject),
  ): PermissionDecision {
    const decision = this.decide(subject);
    switch (this.currentMode) {
      case 'plan':
        return planGate(subject, permissionClass, decision);
      case 'auto':
        return autoGate(subject, decision);
      default:
        return decision;
    }
  }

  /** The mode in effect. */
  get mode(): PermissionMode {
    return this.currentMode;
  }

  /** Switches modes for the calls evaluated from now on (session grants are kept). */
  setMode(mode: PermissionMode): void {
    this.currentMode = mode;
  }

  private decide(subject: PermissionSubject): PermissionDecision {
    switch (subject.kind) {
      case 'read':
        return combine(subject.paths.map((path) => this.decideRead(path)));
      case 'write':
        return combine(subject.paths.map((path) => this.decideWrite(path)));
      case 'execute':
        return this.decideCommand(subject.command, subject.analysis, subject.origin);
      case 'mcp':
        return this.decideMcp(subject);
      case 'none':
        return { type: 'allow', reason: 'Nothing to approve' };
    }
  }

  grant(grant: SessionGrant): void {
    if (!this.grants.some((existing) => sameGrant(existing, grant))) this.grants.push(grant);
  }

  sessionGrants(): readonly SessionGrant[] {
    return this.grants;
  }

  /** Clears session grants (used by /clear and /permissions reset). */
  resetSession(): void {
    this.grants.length = 0;
  }

  /** Everything that currently applies, for /permissions. */
  listRules(): PermissionRuleView[] {
    const fromRules = (rules: CompiledRule[], effect: 'allow' | 'deny'): PermissionRuleView[] =>
      rules.map(({ rule, source }) => {
        const verb = effect === 'allow' ? 'Allow' : 'Deny';
        const origin = source === 'config' ? 'config' : 'command line';
        return { source, effect, description: `${verb}: ${describeRule(rule)} (${origin})` };
      });
    const bySource = (source: CompiledRule['source']) => (rule: CompiledRule) =>
      rule.source === source;
    return [
      ...DEFAULT_RULES,
      ...modeRules(this.currentMode),
      ...fromRules(this.allowRules.filter(bySource('config')), 'allow'),
      ...fromRules(this.denyRules.filter(bySource('config')), 'deny'),
      ...fromRules(this.allowRules.filter(bySource('flag')), 'allow'),
      ...fromRules(this.denyRules.filter(bySource('flag')), 'deny'),
      ...this.grants.map((grant): PermissionRuleView => ({
        source: 'session',
        effect: 'allow',
        description: `Allow: ${describeGrant(grant)} (session)`,
      })),
    ];
  }

  // ---------------------------------------------------------------------------------------------
  // Files

  private decideRead(path: ResolvedPath): PermissionDecision {
    const denied = this.denyRules.find(
      ({ rule }) => rule.kind === 'read' && isWithin(path.absolute, rule.path, PLATFORM),
    );
    if (denied) return configDenial(denied);
    if (path.insideProject && !path.sensitive) {
      return { type: 'allow', reason: 'Inside the project' };
    }
    const covered = this.readCoverage(path);
    if (covered) return { type: 'allow', reason: covered };
    return { type: 'ask', prompt: readPrompt(path) };
  }

  private readCoverage(path: ResolvedPath): string | undefined {
    const covers = (directory: string): boolean =>
      samePath(directory, path.absolute, PLATFORM) ||
      (!path.sensitive && isWithin(path.absolute, directory, PLATFORM));
    const grant = this.grants.find((g) => g.kind === 'read-path' && covers(g.path));
    if (grant?.kind === 'read-path') return `Allowed for this session (reading ${grant.path})`;
    const rule = this.allowRules.find(({ rule }) => rule.kind === 'read' && covers(rule.path));
    return rule ? ruleAllowance(rule) : undefined;
  }

  private decideWrite(path: ResolvedPath): PermissionDecision {
    if (path.insideGitDir) return { type: 'deny', reason: 'Inside .git', message: GIT_DIR_MESSAGE };
    const denied = this.denyRules.find(({ rule }) => rule.kind === 'edit');
    if (denied) return configDenial(denied);
    if (path.insideProject && !path.sensitive) {
      if (this.grants.some((grant) => grant.kind === 'all-edits')) {
        return { type: 'allow', reason: 'Allowed for this session (all edits)' };
      }
      if (this.currentMode === 'acceptEdits') {
        return { type: 'allow', reason: 'Accepting edits (permission mode)' };
      }
      const rule = this.allowRules.find(({ rule }) => rule.kind === 'edit');
      if (rule) return { type: 'allow', reason: ruleAllowance(rule) };
    }
    return { type: 'ask', prompt: writePrompt(path) };
  }

  // ---------------------------------------------------------------------------------------------
  // Commands

  private decideCommand(
    command: string,
    analysis: CommandAnalysis,
    origin: 'agent' | 'user',
  ): PermissionDecision {
    if (analysis.risk === 'blocked') return blockedDenial(analysis, origin);
    const denied = this.commandDenial(command, analysis);
    if (denied) return configDenial(denied);
    const covered = this.commandCoverage(analysis);
    if (covered) return { type: 'allow', reason: covered };
    if (origin === 'user' && analysis.risk !== 'destructive') {
      return { type: 'allow', reason: 'typed by the user' };
    }
    if (analysis.risk === 'safe') return { type: 'allow', reason: 'Read-only command' };
    return { type: 'ask', prompt: commandPrompt(command.trim(), analysis) };
  }

  private commandDenial(command: string, analysis: CommandAnalysis): CompiledRule | undefined {
    return this.denyRules.find(({ rule }) => {
      if (rule.kind === 'bash-all') return true;
      if (rule.kind !== 'bash-prefix') return false;
      return (
        commandMatchesPrefix(command, rule.prefix) ||
        analysis.segments.some(
          (segment) =>
            commandMatchesPrefix(matchText(segment), rule.prefix) ||
            containsWordsInOrder(segment, rule.prefix),
        )
      );
    });
  }

  /** Allow reason when grants/rules cover every non-safe segment, else undefined. */
  private commandCoverage(analysis: CommandAnalysis): string | undefined {
    const everything = this.allowRules.find(({ rule }) => rule.kind === 'bash-all');
    if (everything) return ruleAllowance(everything);
    const pending = analysis.segments.filter((segment) => segment.risk !== 'safe');
    if (analysis.unparsable || pending.length === 0) return undefined;
    const attributed = Math.max(...pending.map((segment) => RISK_ORDER[segment.risk]));
    if (RISK_ORDER[analysis.risk] > attributed) return undefined;
    let reason: string | undefined;
    for (const segment of pending) {
      const covered = this.segmentCoverage(segment, analysis);
      if (covered === undefined) return undefined;
      reason ??= covered;
    }
    return reason;
  }

  private segmentCoverage(segment: CommandSegment, analysis: CommandAnalysis): string | undefined {
    const text = matchText(segment);
    const rule = this.allowRules.find(
      ({ rule }) => rule.kind === 'bash-prefix' && commandMatchesPrefix(text, rule.prefix),
    );
    if (rule) return ruleAllowance(rule);
    const rememberable =
      analysis.rememberable !== false &&
      segment.rulePrefix !== undefined &&
      isRememberableRisk(segment.risk) &&
      isRememberableRisk(analysis.risk);
    if (!rememberable) return undefined;
    const grant = this.grants.find(
      (g) =>
        g.kind === 'command-prefix' &&
        commandMatchesPrefix(text, g.prefix) &&
        withinShape(g, text, g.prefix, analysis.command),
    );
    return grant?.kind === 'command-prefix'
      ? `Allowed for this session ("${grant.prefix}")`
      : undefined;
  }

  // ---------------------------------------------------------------------------------------------
  // MCP tools

  /**
   * MCP tools run on servers with the user's privileges, so every call asks unless a session
   * grant for that tool or an "mcp:" allow rule covers it. Deny rules win.
   */
  private decideMcp(subject: Extract<PermissionSubject, { kind: 'mcp' }>): PermissionDecision {
    const covers = ({ rule }: CompiledRule) => rule.kind === 'mcp' && mcpRuleMatches(rule, subject);
    const denied = this.denyRules.find(covers);
    if (denied) return configDenial(denied);
    const granted = this.grants.some(
      (grant) =>
        grant.kind === 'mcp-tool' && grant.server === subject.server && grant.tool === subject.tool,
    );
    if (granted) return { type: 'allow', reason: 'Allowed for this session' };
    const rule = this.allowRules.find(covers);
    if (rule) return { type: 'allow', reason: ruleAllowance(rule) };
    return { type: 'ask', prompt: mcpPrompt(subject) };
  }
}

/** Validates rule strings; returns human-readable problems for invalid entries. */
export function validateRules(rules: PermissionRules): string[] {
  const problems: string[] = [];
  for (const [list, entries] of [
    ['allow', rules.allow],
    ['deny', rules.deny],
  ] as const) {
    for (const entry of entries) {
      const parsed = parsePermissionRule(entry, PLATFORM);
      if (!parsed.ok) problems.push(`Invalid ${list} rule "${entry}": ${parsed.problem}.`);
    }
  }
  return problems;
}

/** The permission class a subject implies. */
export function permissionClassOf(subject: PermissionSubject): PermissionClass {
  switch (subject.kind) {
    case 'read':
      return 'read';
    case 'write':
      return 'write';
    case 'execute':
    case 'mcp':
      return 'execute';
    case 'none':
      return 'none';
  }
}

// -----------------------------------------------------------------------------------------------

/**
 * Plan mode on top of the regular decision: writes are denied, and so are execute-class calls
 * other than commands that run without asking anyway. Reads and `none` calls keep their decision.
 */
function planGate(
  subject: PermissionSubject,
  permissionClass: PermissionClass,
  decision: PermissionDecision,
): PermissionDecision {
  if (decision.type === 'deny') return decision;
  if (subject.kind === 'execute' && subject.origin === 'user') return decision;
  const classes = new Set([permissionClass, permissionClassOf(subject)]);
  if (classes.has('write')) return planDenial(PLAN_MODE_MESSAGES.write);
  if (!classes.has('execute')) return decision;
  // Only what the strict gate lets run without a prompt: read-only programs in plain syntax.
  if (subject.kind === 'execute' && subject.analysis.risk === 'safe') return decision;
  return planDenial(
    subject.kind === 'execute' ? PLAN_MODE_MESSAGES.command : PLAN_MODE_MESSAGES.tool,
  );
}

function planDenial(message: string): PermissionDecision {
  return { type: 'deny', reason: PLAN_MODE_REASON, message };
}

/**
 * Auto mode on top of the regular decision: a call that would ask runs without asking unless a
 * guardrail applies; then it asks with the regular prompt. Allows and denials are kept.
 */
function autoGate(subject: PermissionSubject, decision: PermissionDecision): PermissionDecision {
  if (decision.type !== 'ask' || autoGuardrail(subject)) return decision;
  return { type: 'allow', reason: AUTO_MODE_REASON };
}

/** What still asks in auto mode. */
function autoGuardrail(subject: PermissionSubject): boolean {
  switch (subject.kind) {
    case 'read':
    case 'write':
      return subject.paths.some((path) => Boolean(path.sensitive));
    case 'execute': {
      const { analysis } = subject;
      // A command Patch cannot fully analyze could be destructive or read secrets.
      return (
        RISK_ORDER[analysis.risk] >= RISK_ORDER.destructive ||
        analysis.unparsable ||
        (analysis.concerns?.length ?? 0) > 0
      );
    }
    // MCP tools are execute-class tools: auto mode calls them without asking ("mcp:" deny rules
    // still deny). Starting a repository's servers is not a tool call and still asks.
    case 'mcp':
    case 'none':
      return false;
  }
}

/** What the mode adds to /permissions. */
function modeRules(mode: PermissionMode): PermissionRuleView[] {
  switch (mode) {
    case 'default':
      return [];
    case 'acceptEdits':
      return [
        {
          source: 'session',
          effect: 'allow',
          description: 'Allow: editing files inside the project (accepting edits)',
        },
      ];
    case 'plan':
      return [
        {
          source: 'session',
          effect: 'deny',
          description: 'Deny: edits, and commands that are not read-only (plan mode)',
        },
      ];
    case 'auto':
      return [
        {
          source: 'session',
          effect: 'allow',
          description:
            'Allow: reads, edits, commands and other tools without asking, except destructive commands and sensitive files (auto mode)',
        },
      ];
  }
}

function compile(entries: readonly string[], source: CompiledRule['source']): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const entry of entries) {
    const parsed = parsePermissionRule(entry, PLATFORM);
    if (parsed.ok) compiled.push({ text: entry.trim(), rule: parsed.rule, source });
  }
  return compiled;
}

function configDenial(rule: CompiledRule): PermissionDecision {
  const where = rule.source === 'config' ? 'configuration' : 'command-line';
  return {
    type: 'deny',
    reason: `Denied by ${where} rule "${rule.text}"`,
    message: `This action is denied by the user's Patch configuration (rule ${rule.text}).`,
  };
}

function ruleAllowance(rule: CompiledRule): string {
  return `Allowed by ${rule.source === 'config' ? 'configuration' : 'command-line'} rule "${rule.text}"`;
}

function isRememberableRisk(risk: CommandRisk): boolean {
  return risk === 'normal' || risk === 'network';
}

function matchText(segment: CommandSegment): string {
  return normalizeCommandText(segment.matchText ?? [segment.program, ...segment.args].join(' '));
}

/** "git push" matches a segment running git whose arguments contain "push" (after options). */
function containsWordsInOrder(segment: CommandSegment, prefix: string): boolean {
  const [program, ...rest] = normalizeCommandText(prefix).split(' ');
  const sameProgram = isCaseInsensitivePlatform(PLATFORM)
    ? segment.program.toLowerCase() === program.toLowerCase()
    : segment.program === program;
  if (!sameProgram) return false;
  let position = 0;
  for (const arg of segment.args) {
    if (position < rest.length && arg === rest[position]) position++;
  }
  return position === rest.length;
}

function blockedDenial(analysis: CommandAnalysis, origin: 'agent' | 'user'): PermissionDecision {
  const reason = reasonsAt(analysis, 'blocked');
  const message =
    origin === 'user'
      ? BLOCKED_USER_MESSAGE
      : `This command was blocked: ${reason}. Patch never runs commands that require elevated privileges or perform system-level destructive operations. If it is truly needed, tell the user the exact command to run themselves.`;
  return { type: 'deny', reason: `Blocked: ${reason}`, message };
}

const COMMAND_PROMPTS: Record<
  'normal' | 'network' | 'destructive',
  { title: string; severity: Severity }
> = {
  normal: { title: 'Patch wants to run a command', severity: 'normal' },
  network: { title: 'Patch wants to run a command that uses the network', severity: 'warning' },
  destructive: { title: 'Potentially destructive command', severity: 'danger' },
};

/** Most prefixes offered in one option before it would be unreadable; above this, none is. */
const MAX_PREFIX_GRANTS = 4;

/** Normal and network commands may be remembered by their rule prefix; destructive ones never. */
function commandPrompt(subjectLine: string, analysis: CommandAnalysis): PermissionPrompt {
  const risk = analysis.risk === 'safe' || analysis.risk === 'blocked' ? 'normal' : analysis.risk;
  const prompt: PermissionPrompt = {
    ...COMMAND_PROMPTS[risk],
    subjectLine,
    reason: reasonsAt(analysis, risk),
  };
  const prefixes = (analysis.rulePrefixes ?? [])
    .map((prefix) => ({ prefix, normalized: normalizeCommandText(prefix) }))
    .filter((entry) => entry.normalized !== '');
  if (risk === 'destructive' || prefixes.length === 0 || prefixes.length > MAX_PREFIX_GRANTS) {
    return prompt;
  }
  // Each grant records the options and variables the user saw, so it never covers riskier variants.
  const grants = prefixes.map((entry): SessionGrant => {
    const shapes = analysis.segments
      .map((segment) => matchText(segment))
      .filter((text) => commandMatchesPrefix(text, entry.prefix))
      .map((text) => shapeOf(text, entry.prefix, analysis.command));
    return {
      kind: 'command-prefix',
      prefix: entry.prefix,
      options: [...new Set(shapes.flatMap((shape) => shape.options))],
      variables: [...new Set(shapes.flatMap((shape) => shape.variables))],
    };
  });
  const quoted = prefixes.map((entry) => `"${entry.prefix}"`);
  return {
    ...prompt,
    sessionOption: {
      label: `Yes, and don't ask again for ${joinQuoted(quoted)} this session`,
      grant: grants[0],
      ...(grants.length > 1 ? { grants } : {}),
    },
  };
}

/** "a", "a and b", "a, b and c". */
function joinQuoted(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Joins the reasons of the segments at `risk` (or the overall top reason). */
function reasonsAt(analysis: CommandAnalysis, risk: CommandRisk): string {
  const reasons = analysis.segments
    .filter((segment) => segment.risk === risk && segment.reason)
    .map((segment) => segment.reason as string);
  const unique = [...new Set(reasons)];
  return unique.length > 0 ? unique.join('; ') : (analysis.reasons[0] ?? 'Unknown risk');
}

function readPrompt(path: ResolvedPath): PermissionPrompt {
  if (path.sensitive) {
    return {
      title: 'Patch wants to read a sensitive file',
      subjectLine: path.display,
      severity: 'warning',
      reason: SENSITIVE_READ_REASON,
      sessionOption: {
        label: `Yes, allow reading ${path.display} this session`,
        grant: { kind: 'read-path', path: path.absolute },
      },
    };
  }
  const api = pathApi(PLATFORM);
  const directory = path.isDirectory ? path.absolute : api.dirname(path.absolute);
  const directoryDisplay = path.isDirectory ? path.display : api.dirname(path.display);
  return {
    title: 'Patch wants to read outside the project',
    subjectLine: path.display,
    severity: 'normal',
    reason: 'Outside the project root',
    sessionOption: {
      label: `Yes, allow reading ${directoryDisplay} this session`,
      grant: { kind: 'read-path', path: directory },
    },
  };
}

/**
 * An MCP tool call: the server and tool as the subject (the tool's preview shows the arguments).
 * The session option covers that one tool of that server.
 */
function mcpPrompt(subject: Extract<PermissionSubject, { kind: 'mcp' }>): PermissionPrompt {
  const { server, tool } = subject;
  const shownTool =
    tool.length > MCP_LABEL_TOOL_CHARS ? `${tool.slice(0, MCP_LABEL_TOOL_CHARS - 1)}…` : tool;
  return {
    title: 'Patch wants to use an MCP tool',
    subjectLine: `${server} · ${tool}`,
    severity: 'normal',
    reason: `The MCP server "${server}" runs this tool with your privileges and receives the arguments below.`,
    sessionOption: {
      label: `Yes, don't ask again for ${server}'s ${shownTool} this session`,
      grant: { kind: 'mcp-tool', server, tool },
    },
  };
}

function writePrompt(path: ResolvedPath): PermissionPrompt {
  const verb = path.exists ? 'edit' : 'create';
  if (!path.insideProject) {
    return {
      title: 'Patch wants to write outside the project',
      subjectLine: path.display,
      severity: 'danger',
      reason: path.sensitive
        ? 'Outside the project root. This file may contain secrets.'
        : 'Outside the project root',
    };
  }
  if (path.sensitive) {
    return {
      title: `Patch wants to ${verb} a sensitive file`,
      subjectLine: path.display,
      severity: 'warning',
      reason: 'This file may contain secrets.',
    };
  }
  return {
    title: `Patch wants to ${verb} ${path.display}`,
    subjectLine: path.display,
    severity: 'normal',
    sessionOption: { label: 'Yes, allow all edits this session', grant: { kind: 'all-edits' } },
  };
}

const SEVERITY_ORDER: Record<Severity, number> = { normal: 0, warning: 1, danger: 2 };

/** Combines per-path decisions: any deny wins, then one prompt for everything that asks. */
function combine(decisions: PermissionDecision[]): PermissionDecision {
  if (decisions.length === 0) return { type: 'allow', reason: 'No files involved' };
  const denial = decisions.find((decision) => decision.type === 'deny');
  if (denial) return denial;
  const prompts = decisions.flatMap((decision) =>
    decision.type === 'ask' ? [decision.prompt] : [],
  );
  if (prompts.length === 0) return decisions[0];
  if (prompts.length === 1) return { type: 'ask', prompt: prompts[0] };
  const primary = prompts.reduce((best, prompt) =>
    SEVERITY_ORDER[prompt.severity] > SEVERITY_ORDER[best.severity] ? prompt : best,
  );
  const options = prompts.map((prompt) => prompt.sessionOption);
  const shared = options.every(
    (option) => option && options[0] && sameGrant(option.grant, options[0].grant),
  );
  const allEdits = shared && options[0]?.grant.kind === 'all-edits';
  return {
    type: 'ask',
    prompt: {
      ...primary,
      title: allEdits ? `Patch wants to edit ${prompts.length} files` : primary.title,
      subjectLine: [...new Set(prompts.map((prompt) => prompt.subjectLine))].join(', '),
      sessionOption: shared ? options[0] : undefined,
    },
  };
}

function sameGrant(a: SessionGrant, b: SessionGrant): boolean {
  if (a.kind === 'all-edits' || b.kind === 'all-edits') return a.kind === b.kind;
  if (a.kind === 'command-prefix' && b.kind === 'command-prefix') {
    const sameSet = (x?: string[], y?: string[]) =>
      x === undefined || y === undefined
        ? x === y
        : x.length === y.length && x.every((item) => y.includes(item));
    return (
      normalizeCommandText(a.prefix) === normalizeCommandText(b.prefix) &&
      sameSet(a.options, b.options) &&
      sameSet(a.variables, b.variables)
    );
  }
  if (a.kind === 'read-path' && b.kind === 'read-path') return samePath(a.path, b.path, PLATFORM);
  if (a.kind === 'mcp-tool' && b.kind === 'mcp-tool') {
    return a.server === b.server && a.tool === b.tool;
  }
  return false;
}

function describeGrant(grant: SessionGrant): string {
  switch (grant.kind) {
    case 'all-edits':
      return 'editing files inside the project';
    case 'command-prefix':
      return `commands starting with "${grant.prefix}"`;
    case 'read-path':
      return `reading ${grant.path}`;
    case 'mcp-tool':
      return `the MCP tool ${grant.tool} of ${grant.server}`;
  }
}
