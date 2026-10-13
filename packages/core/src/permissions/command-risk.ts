import {
  parseCommand,
  type ParsedCommand,
  type Redirect,
  type SimpleCommand,
} from './command-parser.js';
import {
  CD_PROGRAMS,
  FETCHERS,
  FILE_LISTERS,
  INTERPRETER_PROGRAMS,
  PIPED_FILE_READERS,
  SHELL_PROGRAMS,
  alwaysBlockedNames,
  alwaysBlockedReason,
  classifyProgram,
  isDangerousVariable,
  isHarmlessVariable,
  isKnownProgram,
  isPublicVariable,
  isSwitchArgument,
} from './program-rules.js';
import { PRINTERS } from './read-only-rules.js';
import {
  RISK_RANK,
  blocked,
  destructive,
  highest,
  isOption,
  normal,
  safe,
  type Finding,
  type FindingConcern,
  type ProgramContext,
  type Verdict,
  own,
} from './risk-helpers.js';
import {
  budgetExhausted,
  createBudget,
  enterDirectory,
  expandCommandBraces,
  expandHome,
  isCatastrophicTarget,
  isHarmlessDevice,
  isRawDevice,
  inGitWorkTree,
  locatePathArgument,
  mayNameSensitive,
  gitRepositoryIsProject,
  pathExists,
  remoteLikeMayEscape,
  resolveArgument,
  searchHasNegatedIgnore,
  shellMayExpand,
  spendWork,
  touchesGitDir,
  type PathEnvironment,
} from './risk-paths.js';
import { gitSubcommandIndex } from './git-rules.js';
import { startsProjectCode } from './tool-rules.js';
import { WRAPPERS } from './wrappers.js';
import type { ShellKind } from '../shell/shell.js';
import { applyStrictGate } from './strict-gate.js';

/**
 * Risk levels, lowest to highest:
 *  - safe:        read-only inspection (ls, cat, git status/diff/log, rg ...). Runs without asking.
 *                 Safe is an allowlist: a known read-only program whose every option is on its
 *                 list of read-only options (see read-only-rules.ts, search-rules.ts,
 *                 git-rules.ts). Unknown programs and unlisted options are at least normal.
 *  - normal:      may change local state or run project code (tests, builds, git commit, mv,
 *                 redirects into files, unknown programs). Asks; can be remembered for the session.
 *  - network:     talks to the network (curl, wget, ssh, package installs, git fetch/pull/clone).
 *                 Asks; can be remembered for the session by prefix.
 *  - destructive: deletes or overwrites data, rewrites history, publishes, changes permissions
 *                 (rm, git reset --hard, git clean, git push, chmod, kill, npm publish, curl | sh).
 *                 Asks every time; never remembered.
 *  - blocked:     privilege escalation or system-level destruction (sudo, su, doas, runas,
 *                 rm -rf /, mkfs, dd to devices, shutdown, fork bombs). Never runs.
 */
export type CommandRisk = 'safe' | 'normal' | 'network' | 'destructive' | 'blocked';

export const RISK_ORDER: Record<CommandRisk, number> = RISK_RANK;

export type { FindingConcern };

export function maxRisk(a: CommandRisk, b: CommandRisk): CommandRisk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

export interface CommandSegment {
  /** Raw text of this simple command. */
  text: string;
  /** Program name (basename, lowercased on Windows, without .exe), after env assignments and wrappers. */
  program: string;
  args: string[];
  risk: CommandRisk;
  /** Why this segment has its risk, e.g. "Deletes files (rm)". */
  reason?: string;
  /**
   * The words prefix rules are matched against, single-spaced: the command from the program on
   * (or from a launcher such as `npx`/`uv run`), without assignments and transparent wrappers.
   */
  matchText?: string;
  /** This segment's own session rule prefix; undefined when approvals of it must not be remembered. */
  rulePrefix?: string;
}

export interface CommandAnalysis {
  command: string;
  risk: CommandRisk;
  /** De-duplicated human reasons for the overall risk (highest-risk reasons first). */
  reasons: string[];
  /**
   * Prefix to remember with "Yes, for this session", e.g. "pnpm test", "npm run build",
   * "git commit", "pytest". Set only when every non-safe segment shares one prefix; undefined
   * when the command must not be remembered (destructive/blocked, command substitution,
   * unparsable input) or when its non-safe segments have different prefixes (see rulePrefixes).
   */
  rulePrefix?: string;
  /**
   * The distinct, ordered session rule prefixes of a rememberable command's non-safe segments
   * (`git add . && git commit -m x` → ["git add", "git commit"]). A superset of rulePrefix (which
   * is set only when there is exactly one). Absent when the command cannot be remembered.
   */
  rulePrefixes?: string[];
  segments: CommandSegment[];
  /** True when the command could not be parsed reliably (unbalanced quotes etc.). */
  unparsable: boolean;
  /**
   * False when the command must never be covered by a session grant, even segment by segment:
   * it is unparsable, uses substitutions, or has a script-level finding above safe (a function
   * definition, a fork bomb, a loop that sets PATH). Session grants check this as well as each
   * segment's own prefix. Absent means no such restriction (treated as rememberable).
   */
  rememberable?: boolean;
  /**
   * The concerns of the command's findings (see Finding.concern), each once: `secret` when it
   * may read or print secrets, `opaque` when Patch cannot tell everything it runs or touches.
   * Auto mode asks before such commands. Absent when there are none.
   */
  concerns?: FindingConcern[];
}

export interface AnalyzeCommandOptions {
  cwd: string;
  projectRoot: string;
  home: string;
  platform?: NodeJS.Platform;
  /**
   * The shell that will run the command. On Windows the default is Git Bash (a POSIX shell), where
   * a backslash escapes the next character rather than separating path parts, so `cat .\env` reads
   * `.env`. When this is a POSIX shell, or unknown (the conservative default), both readings of a
   * word with backslashes are checked. PowerShell and cmd keep backslashes as separators.
   */
  shell?: ShellKind;
}

/**
 * Classifies a shell command. The overall risk is the maximum over all simple commands in
 * pipelines, lists (&&, ||, ;, &, newlines), subshells, `bash -c "..."`/`sh -c` payloads,
 * `xargs <cmd>`, `env <cmd>`, `time <cmd>`, `nice <cmd>`, `npx/pnpm exec <cmd>`.
 * Additional rules:
 *  - Output redirection to a file (`>`, `>>`, `&>`, not to /dev/null or `&1`/`&2`) is at least normal.
 *  - Command substitution `$(...)`, backticks, and process substitution are at least normal and
 *    disable `rulePrefix`.
 *  - Piping a network fetch into an interpreter (`curl ... | sh`, `wget -O- | bash`,
 *    `iwr | iex`) is destructive.
 *  - Arguments that are paths resolving outside `projectRoot` (absolute, `~`, `..`) raise a
 *    safe command to normal with reason "Accesses paths outside the project".
 *  - Arguments and input redirections that name, or through filename patterns and brace
 *    expansion may name, files that hold secrets (`.env`, `.en*`, `*.pem`, `{.e,}nv`) are at least
 *    normal and never remembered, unless the program only lists names or metadata (`ls`, `du`,
 *    `stat`). So are commands that feed files listed by one program into a PowerShell reader
 *    (`Get-ChildItem -Force | Select-String x`).
 *  - Variables set for a read-only command (`FOO=1 ls`, `env FOO=1 ls`) make it normal unless they
 *    only change locale or formatting (`LC_ALL=C`); variables that change which code runs or
 *    which configuration loads (`PATH`, `GIT_*`, `HOME`, `*_OPTIONS`, `*CONFIG*`) are never
 *    remembered.
 *  - A read-only command that expands environment variables other than public ones (`$HOME`,
 *    `$PATH`) or ones set earlier in the command (`for f in *.ts`, `x=1`) may print secrets
 *    (`echo $GITHUB_TOKEN`), like `printenv`: it is normal and never remembered.
 *  - Classification never throws and never contacts the network (Windows network and device paths
 *    are never opened). It has a fixed budget of filesystem checks, pattern candidates and time;
 *    when it runs out, the remaining checks assume the worst. Commands longer than
 *    MAX_COMMAND_LENGTH, or with more parts than the parser records, are only scanned for
 *    dangerous programs and always ask.
 *  - Brace expansion is applied to the words first (`cat {/etc/passwd,x}` reads /etc/passwd,
 *    `{rm,-rf,x}` runs rm); braces mixed with quotes or variables cannot be expanded reliably and
 *    make the command ask every time. So do program names that are only known when the command
 *    runs (`$cmd`, `/usr/bin/s?do`).
 *  - Writes inside a `.git` directory (redirections, and path arguments of programs that are not
 *    read-only, e.g. `cp x .git/hooks/pre-commit`, also after `cd .git`) are destructive and
 *    never remembered.
 *  - Windows/PowerShell equivalents are recognized (del, rd /s, Remove-Item, Stop-Process,
 *    Invoke-WebRequest, Start-Process -Verb RunAs, Set-ExecutionPolicy, reg delete, format).
 *  - Empty/whitespace commands are `normal` with reason "Empty command".
 * `Set-ExecutionPolicy` is blocked (a system security setting). Commands that touch paths outside
 * the project, use unknown variables in paths, or override variables such as PATH are never
 * remembered (no `rulePrefix`).
 *
 * Finally the conservative gate in strict-gate.ts applies: running without a prompt, or
 * remembering an approval, also requires plain shell syntax and a short list of known programs.
 */
export function analyzeCommand(command: string, options: AnalyzeCommandOptions): CommandAnalysis {
  const platform = options.platform ?? process.platform;
  return applyStrictGate(analyzeCommandDetailed(command, options), options.shell, platform);
}

/**
 * The detailed classification without the strict gate. Exposed for tests of the classifier itself;
 * callers deciding whether to run a command must use analyzeCommand.
 */
export function analyzeCommandDetailed(
  command: string,
  options: AnalyzeCommandOptions,
): CommandAnalysis {
  if (command.trim() === '') {
    return { command, risk: 'normal', reasons: ['Empty command'], segments: [], unparsable: false };
  }
  const platform = options.platform ?? process.platform;
  const env: PathEnvironment = {
    platform,
    projectRoot: options.projectRoot,
    home: options.home,
    cwds: [options.cwd],
    budget: createBudget(),
    // Git Bash (the Windows default) and other POSIX shells treat `\` as an escape. When the shell
    // is not known to be PowerShell or cmd, assume POSIX so `cat .\env` is seen to read `.env`.
    backslashEscapes:
      platform === 'win32' && options.shell !== 'powershell' && options.shell !== 'cmd',
  };
  const result =
    command.length > MAX_COMMAND_LENGTH
      ? analyzeOversized(command, env)
      : analyzeScript(command, env, 0);
  if (budgetExhausted(env)) {
    result.findings.push(
      normal('Has too many parts, paths or filename patterns to check in time', {
        concern: 'opaque',
      }),
    );
  }
  const findings = [...result.findings, ...result.segments.flatMap((segment) => segment.findings)];
  const risk = highest(findings)?.risk ?? 'normal';
  const segments = result.segments.map(toPublicSegment);
  // A script-level finding above safe (function definition, fork bomb, PATH-setting loop,
  // substitution) means even a per-segment session grant must not cover the command.
  const scriptLevelUnsafe = result.findings.some(
    (finding) => RISK_RANK[finding.risk] > RISK_RANK.safe,
  );
  const prefixes = rulePrefixesFor(result, segments, risk);
  const concerns = [
    ...new Set(findings.flatMap((finding) => (finding.concern ? [finding.concern] : []))),
  ];
  return {
    command,
    risk,
    reasons: summarizeReasons(findings, risk),
    rulePrefix: prefixes.length === 1 ? prefixes[0] : undefined,
    ...(prefixes.length > 0 ? { rulePrefixes: prefixes } : {}),
    segments,
    unparsable: result.unparsable,
    rememberable: !result.unparsable && !scriptLevelUnsafe,
    ...(concerns.length > 0 ? { concerns } : {}),
  };
}

// -----------------------------------------------------------------------------------------------

const MAX_SCRIPT_DEPTH = 8;
/** Longer commands are not parsed: they are scanned for dangerous programs and always ask. */
const MAX_COMMAND_LENGTH = 100_000;
/** Distinct program invocations scanUnparsable classifies before it assumes the worst. */
const MAX_SCANNED_INVOCATIONS = 256;
const SUBSTITUTION_START = /\$\(|`|<\(/;
const FETCHER_NAME =
  /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|xh|aria2c|downloadstring|downloadfile)\b/i;
/** A single argument that only prints a version or help text, for any known program. */
const VERSION_QUERIES = new Set([
  '--version',
  '-V',
  '-version',
  '--help',
  '-h',
  '-help',
  '-?',
  '/?',
]);
/**
 * Programs whose `-v` prints their version. Elsewhere `-v` often means verbose: `env -v` prints
 * the environment, `bash -v` and `python -v` start an interpreter.
 */
// prettier-ignore
const VERSION_FLAG_PROGRAMS = new Set([
  'node', 'nodejs', 'npm', 'pnpm', 'bun', 'deno', 'npx', 'pnpx', 'bunx', 'docker', 'podman', 'git',
  'tsc', 'php', 'perl', 'make', 'gmake', 'gcc', 'g++', 'cc', 'c++', 'clang', 'clang++', 'gradle',
]);

/** True when a word downloads something inside a substitution (`$(curl ...)`). */
function fetchesInSubstitution(word: string): boolean {
  const start = word.search(SUBSTITUTION_START);
  return start >= 0 && FETCHER_NAME.test(word.slice(start));
}

interface Segment {
  text: string;
  program: string;
  args: string[];
  findings: Finding[];
  matchText: string;
  rulePrefix?: string;
}

interface ScriptResult {
  segments: Segment[];
  /** Findings not tied to one segment (substitutions, parse errors, empty input). */
  findings: Finding[];
  unparsable: boolean;
}

interface Role {
  fetcher: boolean;
  interpreter: boolean;
  shell: boolean;
  /** For echo/printf: the text they print. */
  printed?: string;
  /** Runs a program or script whose text comes from a variable (`$cmd`, `sh -c "$script"`). */
  runsDynamicCode: boolean;
  /** Outputs file objects in PowerShell (`Get-ChildItem`). */
  listsFiles: boolean;
  /** Reads the contents of files piped into it in PowerShell (`Get-Content`, `Select-String`). */
  readsPipedFiles: boolean;
}

interface CommandResult extends ScriptResult {
  role: Role;
}

const NO_ROLE: Role = {
  fetcher: false,
  interpreter: false,
  shell: false,
  runsDynamicCode: false,
  listsFiles: false,
  readsPipedFiles: false,
};
const VARIABLE_REFERENCE = /\$[\w{]|%\w+%/;

/**
 * Wildcards that make a program word a filename pattern (a lone `[` is the test command): `*`,
 * `?`, or a `[` with a `]` somewhere after it. Linear, unlike a regular expression with `\[.+\]`,
 * which backtracks on a word full of `[`.
 */
function isProgramPattern(word: string): boolean {
  if (word.includes('*') || word.includes('?')) return true;
  const open = word.indexOf('[');
  return open >= 0 && word.lastIndexOf(']') > open + 1;
}

/**
 * Shell variables set earlier in the command: true when their value is not secret (`x=1`,
 * `for f in *.ts`, `read line`), false when it comes from a variable that may be (`x=$TOKEN`).
 */
type VariableScope = Map<string, boolean>;

function analyzeScript(
  text: string,
  env: PathEnvironment,
  depth: number,
  inherited: ReadonlyMap<string, boolean> = new Map(),
): ScriptResult {
  // Scripts inside commands (shell payloads, remote commands, printed scripts) are parsed again,
  // so their text counts against the budget; once it is spent they are only scanned.
  if (!spendWork(env, Math.ceil(text.length / 256)) && depth > 0) return analyzeUnchecked(text);
  const parsed = parseCommand(text);
  const findings: Finding[] = [];
  const scope: VariableScope = new Map(inherited);
  let dangerousLoop = false;
  for (const { name, rawItems } of parsed.loopVariables) {
    scope.set(
      name,
      rawItems.every((item) => printsOnlyPublicValues(item, env.platform, scope)),
    );
    // `for PATH in ...` / `select PATH in ...` set PATH (and so on) in the current shell, so an
    // unqualified command afterwards resolves through the loop-controlled value: treat it like a
    // leading `PATH=value cmd` assignment (normal, never remembered).
    if (isDangerousVariable(name)) {
      findings.push(normal(`Sets ${name} for the loop, which controls program loading`));
      dangerousLoop = true;
    }
  }
  if (definesForkBomb(parsed)) {
    findings.push(blocked('Defines a fork bomb that exhausts system resources'));
  }
  if (parsed.error !== undefined) {
    findings.push(normal(`Could not parse the command reliably (${parsed.error})`));
    findings.push(...scanUnparsable(text, env, depth));
  }
  if (parsed.hasCommandSubstitution) findings.push(normal('Uses command substitution'));
  if (parsed.hasProcessSubstitution) findings.push(normal('Uses process substitution'));
  if (parsed.hasFunctionDefinition) findings.push(normal('Defines a shell function'));
  if (parsed.commands.length === 0 && parsed.error === undefined) {
    findings.push(normal('Empty command'));
  }

  const results = parsed.commands.map((command) => {
    const result = analyzeSimpleCommand(command, env, depth, scope);
    noteVariables(command, env.platform, scope);
    return result;
  });
  applyPipeRules(parsed, results, env, depth, scope);
  if (results.some((r) => r.role.fetcher) && results.some((r) => r.role.runsDynamicCode)) {
    findings.push(destructive('May run code downloaded from the network'));
  }
  const segments = results.flatMap((result) => result.segments);
  for (const result of results) findings.push(...result.findings);
  const unparsable = parsed.error !== undefined || results.some((result) => result.unparsable);
  // A script that defines a function may redefine a granted program as something else (even a
  // fork bomb), so its segments must never be remembered; the same for substitutions and
  // unparsable input, and for a loop that sets PATH or another program-loading variable.
  if (
    unparsable ||
    parsed.hasCommandSubstitution ||
    parsed.hasProcessSubstitution ||
    parsed.hasFunctionDefinition ||
    dangerousLoop
  ) {
    for (const segment of segments) segment.rulePrefix = undefined;
  }
  return { segments, findings, unparsable };
}

/**
 * A function whose body pipes the function into itself (`:(){ :|:& };:`, `bomb() { bomb | bomb &
 * }`) multiplies processes until the system runs out. Found in the parsed structure, so text that
 * is only printed (`echo ':(){ :|:& };:'`) does not count, and the check is linear.
 */
function definesForkBomb(parsed: ParsedCommand): boolean {
  if (parsed.functions.length === 0) return false;
  const bodies = new Map<string, Array<[number, number]>>();
  for (const { name, body } of parsed.functions) {
    const list = bodies.get(name);
    if (list) list.push(body);
    else bodies.set(name, [body]);
  }
  const pipesIntoItself = parsed.pipes.some(([from, to]) => {
    const name = parsed.commands[from]?.words[0];
    if (name === undefined || parsed.commands[to]?.words[0] !== name) return false;
    return (bodies.get(name) ?? []).some(([first, end]) => from >= first && to < end);
  });
  if (pipesIntoItself) return true;
  // A function whose body invokes its own name more than once multiplies processes exponentially
  // (`:(){ :&:& };:`, `f(){ f & f & }`), whether the calls are piped or backgrounded.
  return parsed.functions.some(({ name, body: [first, end] }) => {
    let selfCalls = 0;
    for (let i = first; i < end && i < parsed.commands.length; i++) {
      if (parsed.commands[i]?.words[0] === name) selfCalls++;
    }
    return selfCalls >= 2;
  });
}

/** Builtins that take variables without printing their values (`[ -n "$TOKEN" ]`). */
// prettier-ignore
const VARIABLE_CONSUMERS = new Set([
  'test', '[', '[[', 'true', 'false', ':', 'sleep', 'wait', 'unset', 'export', 'readonly', 'local',
  'declare', 'typeset', 'read', 'set', 'shift', 'return', 'exit', 'cd', 'pushd', 'popd', 'chdir',
  'set-location', 'sl',
]);
/** Builtins that set or remove a variable in the current shell (`unset PATH`, `declare PATH=x`). */
const VARIABLE_MUTATORS = new Set(['unset', 'local', 'declare', 'typeset', 'readonly']);
/** Parameter-expansion assignments (`${NAME:=...}`, `${NAME=...}`, `${NAME::=...}`). */
const PARAMETER_ASSIGNMENT = /\$\{([A-Za-z_][A-Za-z0-9_]*):{0,2}=/g;
/** An arithmetic expansion body (`$((...))`); its assignments change shell variables too. */
const ARITHMETIC_EXPANSION = /\$\(\(([\s\S]*?)\)\)/g;
/** An assignment to a name inside arithmetic (`PATH=1`, `PATH+=1`), not `==`/`<=`/`>=`/`!=`. */
const ARITHMETIC_ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\*\*|<<|>>|[-+*/%&|^])?=(?!=)/g;

/**
 * The first program-loading variable (see isDangerousVariable) a word assigns through a parameter
 * expansion (`${PATH:=/evil}`) or arithmetic (`$((PATH=1))`): these assign in the current shell,
 * so a later unqualified command runs through the poisoned value.
 */
function dangerousExpansionAssignment(raw: string): string | undefined {
  if (!raw.includes('=')) return undefined;
  for (const match of raw.matchAll(PARAMETER_ASSIGNMENT)) {
    if (isDangerousVariable(match[1])) return match[1];
  }
  for (const arithmetic of raw.matchAll(ARITHMETIC_EXPANSION)) {
    for (const match of arithmetic[1].matchAll(ARITHMETIC_ASSIGNMENT)) {
      if (isDangerousVariable(match[1])) return match[1];
    }
  }
  return undefined;
}
/**
 * Arithmetic expansions and their bodies: `$((...))` and the old `$[...]`. A body that is not
 * purely digits, operators and parentheses names a variable (or an array subscript), whose value
 * bash re-parses as arithmetic and whose embedded command substitution it runs.
 */
const ARITHMETIC_BODIES = /\$\(\(([\s\S]*?)\)\)|\$\[([^\]]*)\]/g;

/**
 * True when a word contains an arithmetic expansion whose body is not purely numbers and
 * operators. Any identifier letter, `$`, backtick or `[` means the body names a variable or an
 * array subscript whose value bash re-parses (and whose command substitution it runs). A bare
 * hex literal is flagged too, which only makes the command ask.
 */
function dangerousArithmetic(raw: string): boolean {
  if (!raw.includes('$((') && !raw.includes('$[')) return false;
  for (const match of raw.matchAll(ARITHMETIC_BODIES)) {
    const body = match[1] ?? match[2] ?? '';
    if (/[A-Za-z$`[]/.test(body)) return true;
  }
  return false;
}

const ASSIGNING_BUILTINS = new Set(['export', 'readonly', 'local', 'declare', 'typeset']);
const READING_BUILTINS = new Set(['read', 'mapfile', 'readarray', 'getopts']);
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names of the variables a word expands, from the word as written: `$NAME`, `${NAME...}`,
 * `${#NAME}`, PowerShell's `$env:NAME` and, on Windows, cmd's `%NAME%`. `!` stands for an indirect
 * expansion (`${!name}`), whose variable is unknown. Single-quoted text and escaped `$` do not
 * expand; special parameters (`$1`, `$?`) are left out.
 */
function variableReads(raw: string, platform: NodeJS.Platform): string[] {
  const names: string[] = [];
  let doubleQuoted = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '\\') {
      i++;
    } else if (char === '"') {
      doubleQuoted = !doubleQuoted;
    } else if (char === "'" && !doubleQuoted) {
      const close = raw.indexOf("'", i + 1);
      if (close < 0) break;
      i = close;
    } else if (char === '%' && platform === 'win32') {
      const name = /^%([A-Za-z_][\w()]*)%/.exec(raw.slice(i, i + 258))?.[1];
      if (name !== undefined) {
        names.push(name);
        i += name.length + 1;
      }
    } else if (char === '$') {
      const name = expandedVariable(raw.slice(i + 1, i + 258));
      if (name !== undefined) names.push(name);
    }
  }
  return names;
}

/** The variable named after a `$` (`rest` is the text after it), `!` when it is indirect. */
function expandedVariable(rest: string): string | undefined {
  const environment = /^\{?env:([A-Za-z_]\w*)/i.exec(rest);
  if (environment) return environment[1];
  if (rest.startsWith('{!')) return '!';
  return /^\{#?([A-Za-z_]\w*)/.exec(rest)?.[1] ?? /^[A-Za-z_]\w*/.exec(rest)?.[0];
}

/** True when the word expands no variable that may hold a secret. */
function printsOnlyPublicValues(
  raw: string,
  platform: NodeJS.Platform,
  scope: ReadonlyMap<string, boolean>,
): boolean {
  return !/\$\(|`/.test(raw) && secretVariable(raw, platform, scope) === undefined;
}

/** The first variable the word expands that may hold a secret, if any. */
function secretVariable(
  raw: string,
  platform: NodeJS.Platform,
  scope: ReadonlyMap<string, boolean>,
): string | undefined {
  return variableReads(raw, platform).find(
    (name) => name === '!' || !(scope.get(name) ?? isPublicVariable(name)),
  );
}

/** Records the variables a command sets (`x=1`, `export x=$y`, `read line`) for later commands. */
function noteVariables(
  command: SimpleCommand,
  platform: NodeJS.Platform,
  scope: VariableScope,
): void {
  const record = (assignment: string): void => {
    const equals = assignment.indexOf('=');
    const name = assignment.slice(0, equals).replace(/\+$/, '').replace(/\[.*$/s, '');
    scope.set(name, printsOnlyPublicValues(assignment.slice(equals + 1), platform, scope));
  };
  const [program, ...args] = command.words;
  if (program === undefined) {
    command.assignments.forEach(record);
  } else if (ASSIGNING_BUILTINS.has(program)) {
    args.filter((arg) => /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(arg)).forEach(record);
  } else if (READING_BUILTINS.has(program)) {
    // stdin is closed: these leave their variables empty.
    for (const arg of args) if (VARIABLE_NAME.test(arg)) scope.set(arg, true);
  }
}

/**
 * Commands too long to analyze in time: their first MAX_COMMAND_LENGTH characters are scanned for
 * dangerous programs (see scanUnparsable), the rest only for programs that are always blocked.
 * They always ask (as destructive, since what they do is unknown) unless a blocked program is
 * found.
 */
function analyzeOversized(text: string, env: PathEnvironment): ScriptResult {
  const findings = [
    destructive('The command is too long to analyze reliably'),
    ...scanUnparsable(text.slice(0, MAX_COMMAND_LENGTH), env, 0),
    ...blockedProgramsIn(text.slice(MAX_COMMAND_LENGTH - 64)),
  ];
  return { segments: [], findings, unparsable: true };
}

/**
 * Scripts inside a command that the budget no longer allows to analyze: they ask every time (as
 * destructive, since what they do is unknown) unless they name a blocked program.
 */
function analyzeUnchecked(text: string): ScriptResult {
  return {
    segments: [],
    findings: [
      destructive('Runs commands too complex to analyze in time'),
      ...blockedProgramsIn(text),
    ],
    unparsable: true,
  };
}

let blockedProgramPattern: RegExp | undefined;

/** Programs that are always blocked named anywhere in `text`, in one linear pass. */
function blockedProgramsIn(text: string): Finding[] {
  blockedProgramPattern ??= new RegExp(
    `(?<![\\w.-])(${[...alwaysBlockedNames()]
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')}|mkfs[\\w.-]*)(?![\\w.-])`,
    'i',
  );
  const name = blockedProgramPattern.exec(text)?.[1]?.toLowerCase();
  return name === undefined ? [] : [blocked(`${alwaysBlockedReason(name) ?? 'Blocked'} (${name})`)];
}

/** Findings that make a segment riskier, and whether its approval may still be remembered. */
interface Concerns {
  findings: Finding[];
  rememberable: boolean;
  /** Variables set for the command that may change what a read-only program does. */
  variables: string[];
}

function analyzeSimpleCommand(
  command: SimpleCommand,
  env: PathEnvironment,
  depth: number,
  scope: ReadonlyMap<string, boolean>,
): CommandResult {
  const { platform } = env;
  spendWork(env);
  const concerns = environmentConcerns(command, env);
  const literal =
    platform === 'win32'
      ? command.words.map((word, i) => windowsLiteral(word, command.rawWords[i]))
      : command.words;
  const braced = expandCommandBraces(literal, command.rawWords);
  if (braced === undefined) {
    concerns.findings.push(
      normal('Uses brace expansion that cannot be analyzed reliably', { concern: 'opaque' }),
    );
    concerns.rememberable = false;
  }
  const words = braced?.words ?? literal;
  const rawWords = braced?.rawWords ?? command.rawWords;
  const expands = expansionCheck(words, rawWords, platform);
  if (words.length === 0) {
    if (concerns.findings.length === 0) {
      const reason = command.assignments.length > 0 ? 'Sets shell variables' : 'Read-only command';
      concerns.findings.push(safe(reason));
    }
    const segment: Segment = {
      text: command.text,
      program: '',
      args: [],
      findings: concerns.findings,
      matchText: '',
    };
    return { segments: [segment], findings: [], unparsable: false, role: NO_ROLE };
  }

  const { index, launcherStart } = unwrap(words, platform, concerns);
  const programWord = words[index];
  const program = programName(programWord, platform);
  const key = lookupKey(program, platform);
  const args = words.slice(index + 1);
  const verdict = classifyInvocation(programWord, program, key, args, env, depth);
  const role = roleOf(key, programWord, args, verdict);
  const { findings } = concerns;
  if (hasPathSeparator(programWord, platform)) {
    findings.push(normal(`Runs a program by path (${programWord})`));
  }
  const programPattern =
    isProgramPattern(programWord) && shellMayExpand(programWord, rawWords[index], platform);
  if (VARIABLE_REFERENCE.test(programWord) || programPattern) {
    findings.push(
      normal(`Runs a program whose name is only known when it runs (${programWord})`, {
        concern: 'opaque',
      }),
    );
    concerns.rememberable = false;
  }
  if (platform === 'win32' && braced?.expanded && !PRINTERS.has(key)) {
    // In PowerShell `{...}` is a script block, which cmdlets may run (delay-bind parameters).
    findings.push(normal(`Uses braces, which PowerShell may run as a script block (${program})`));
    concerns.rememberable = false;
  }
  const runsDownload = words.some(
    (word, i) => (i === index || (role.interpreter && i > index)) && fetchesInSubstitution(word),
  );
  if (runsDownload) findings.push(destructive('Runs code downloaded from the network'));
  // A read-only command that expands environment variables may print them (`echo $TOKEN`, or an
  // error message quoting a bad argument), like `printenv`.
  if (verdict.risk === 'safe' && !VARIABLE_CONSUMERS.has(key)) {
    const secret = rawWords
      .slice(index)
      .map((raw) => secretVariable(raw, platform, scope))
      .find((name) => name !== undefined);
    if (secret !== undefined) {
      const shown = secret === '!' ? 'an indirect expansion' : `$${secret}`;
      findings.push(
        normal(`Expands environment variables, which may contain secrets (${shown})`, {
          concern: 'secret',
        }),
      );
      concerns.rememberable = false;
    }
  }
  // `unset PATH`, `declare PATH=x`: changing a program-loading variable is never remembered, like
  // a leading `PATH=x cmd` assignment. `${PATH:=/evil}` and `$((PATH=1))` assign in the shell too.
  if (VARIABLE_MUTATORS.has(key)) {
    const mutated = args
      .filter((arg) => !isOption(arg))
      .map((arg) => arg.split('=', 1)[0])
      .find((name) => VARIABLE_NAME.test(name) && isDangerousVariable(name));
    if (mutated !== undefined) {
      findings.push(normal(`Changes ${mutated}, which controls program loading`));
      concerns.rememberable = false;
    }
  }
  for (const raw of [...command.assignments, ...rawWords]) {
    const assigned = dangerousExpansionAssignment(raw);
    if (assigned !== undefined) {
      findings.push(normal(`Assigns ${assigned} in an expansion, which controls program loading`));
      concerns.rememberable = false;
      break;
    }
  }
  // An arithmetic expansion (`$((...))`, `$[...]`) whose body is not purely numeric re-parses the
  // value of any variable it names and runs command substitution hidden in an array subscript
  // (`x='a[$(cmd)]'; echo $((x))`), even when the variable was single-quoted: never safe, never
  // remembered. Pure numeric arithmetic (`$((1+2))`) is harmless.
  if ([...command.assignments, ...rawWords].some(dangerousArithmetic)) {
    findings.push(
      normal('Evaluates arithmetic that can run commands hidden in a variable', {
        concern: 'opaque',
      }),
    );
    concerns.rememberable = false;
  }

  if (verdict.script !== undefined) {
    if (RISK_RANK[verdict.risk] > RISK_RANK.safe) findings.push(verdict);
    return analyzeNestedScript(verdict, command, concerns, env, depth, role, scope);
  }
  findings.push(verdict);
  if (role.shell && depth < MAX_SCRIPT_DEPTH) {
    // `bash <<< "rm -rf ~"` feeds the here-string to the shell as its script: analyze it like
    // text piped into a shell, so it is blocked/flagged rather than running unseen.
    const here = command.redirects.find((redirect) => redirect.op.replace(/^\d+/, '') === '<<<');
    if (here !== undefined) {
      const nested = analyzeScript(here.target, env, depth + 1, scope);
      const top = highest([
        ...nested.findings,
        ...nested.segments.flatMap((segment) => segment.findings),
      ]);
      if (top && RISK_RANK[top.risk] > RISK_RANK.safe) {
        findings.push({
          risk: top.risk,
          reason: `Runs a here-string as a shell script: ${top.reason}`,
        });
      }
    }
  }
  if (concerns.variables.length > 0 && highest(findings)?.risk === 'safe') {
    findings.push(
      normal(
        `Sets variables that may change what the command does (${concerns.variables.join(', ')})`,
      ),
    );
  }
  const nested = analyzeNestedArgv(verdict.nested ?? [], env, depth, scope);
  const pathWords = verdict.paths ?? defaultPathArguments(args, key, platform);
  checkArgumentPaths(pathWords, env, concerns, expands, verdict.listsOnly === true);
  if (RISK_RANK[verdict.risk] > RISK_RANK.safe) {
    const targets = key === 'git' ? gitWriteTargets(args) : pathWords;
    checkGitDirWrites(targets, env, concerns, expands, key);
  }
  if (CD_PROGRAMS.has(key)) trackDirectoryChange(key, args, env);
  // On a POSIX shell on Windows (Git Bash, the default) `\` escapes rather than separates, so the
  // program sees a different word (`.\env` → `.env`). `command.words` holds that reading; check
  // the same path arguments and `cd` targets under it too, so a backslash cannot hide a secret
  // file, an outside path, or a `.git` write (see windowsLiteral).
  if (env.backslashEscapes === true && braced?.expanded !== true) {
    const altArgs = command.words.slice(index + 1);
    // The POSIX reading of each windows path word, kept only when the backslash made it differ.
    const altOf = (windowsWords: readonly string[]): string[] =>
      windowsWords
        .map((word) => {
          const i = args.indexOf(word);
          return i >= 0 ? altArgs[i] : undefined;
        })
        .filter((word, k): word is string => word !== undefined && word !== windowsWords[k]);
    const altExpands = expansionCheck(altArgs, altArgs, platform);
    checkArgumentPaths(altOf(pathWords), env, concerns, altExpands, verdict.listsOnly === true);
    if (RISK_RANK[verdict.risk] > RISK_RANK.safe) {
      const targets = key === 'git' ? gitWriteTargets(args) : pathWords;
      checkGitDirWrites(altOf(targets), env, concerns, altExpands, key);
    }
    if (CD_PROGRAMS.has(key)) trackDirectoryChange(key, altArgs, env);
  }

  const start = launcherStart ?? index;
  const matchWords = words
    .slice(start)
    .map((word, i) =>
      i === 0 && !hasPathSeparator(word, platform) ? programName(word, platform) : word,
    );
  const risk = highest(findings)?.risk ?? 'normal';
  const remember =
    concerns.rememberable && verdict.rememberable !== false && RISK_RANK[risk] <= RISK_RANK.network;
  const prefixLength = index - start + (verdict.prefixLength ?? 1);
  // An empty or whitespace-containing word in the prefix window would normalize to a broader
  // grant than the command shown (`pnpm "" test` → "pnpm", `"npm install" x` → "npm install"),
  // and a window shorter than prefixLength (`npx ""`) has no stable words: offer no prefix then.
  const prefixWindow = matchWords.slice(0, prefixLength);
  const validPrefix =
    prefixWindow.length === prefixLength &&
    prefixWindow.every((word) => word !== '' && !/\s/.test(word));
  const segment: Segment = {
    text: command.text,
    program,
    args,
    findings,
    matchText: matchWords.join(' '),
    rulePrefix: remember && validPrefix ? prefixWindow.join(' ') : undefined,
  };
  return { ...nested, segments: [segment, ...nested.segments], role };
}

/** Assignments such as `PATH=...` and redirections, which apply whatever the program is. */
function environmentConcerns(command: SimpleCommand, env: PathEnvironment): Concerns {
  const concerns: Concerns = { findings: [], rememberable: true, variables: [] };
  for (const assignment of command.assignments) noteAssignment(assignment, concerns);
  for (const redirect of command.redirects) {
    spendWork(env);
    const outcome = analyzeRedirect(redirect, env);
    if (!outcome) continue;
    concerns.findings.push(outcome.finding);
    if (outcome.forget) concerns.rememberable = false;
  }
  return concerns;
}

/**
 * `NAME=value` for the command (leading, or through `env`): variables that change which code
 * runs or which configuration loads are never remembered; other variables, except locale and
 * formatting ones, keep a read-only command from being safe.
 */
function noteAssignment(assignment: string, concerns: Concerns): void {
  const name = assignment.slice(0, assignment.indexOf('=')).replace(/\+$/, '').replace(/\[.*$/, '');
  if (isDangerousVariable(name)) {
    concerns.findings.push(normal(`Overrides ${name} for the command`));
    concerns.rememberable = false;
  } else if (!isHarmlessVariable(name)) {
    concerns.variables.push(name);
  }
}

/** Steps over wrappers (`env`, `timeout 5`, `xargs`) and launchers (`npx`, `uv run`). */
function unwrap(
  words: readonly string[],
  platform: NodeJS.Platform,
  concerns: Concerns,
): { index: number; launcherStart?: number } {
  let index = 0;
  let launcherStart: number | undefined;
  while (index < words.length) {
    const key = lookupKey(programName(words[index], platform), platform);
    const step = Object.hasOwn(WRAPPERS, key) ? WRAPPERS[key](words, index) : undefined;
    if (!step || step.next >= words.length) break;
    if (step.finding) concerns.findings.push(step.finding);
    if (step.forget) concerns.rememberable = false;
    for (const assignment of step.assignments ?? []) noteAssignment(assignment, concerns);
    if (step.launcher) launcherStart ??= index;
    index = step.next;
  }
  return { index, launcherStart };
}

function classifyInvocation(
  programWord: string,
  program: string,
  key: string,
  args: string[],
  env: PathEnvironment,
  depth: number,
): Verdict {
  const verdict =
    classifyProgram(key, args, programContext(env, depth), program) ??
    normal(`Runs an unrecognized program (${program})`);
  const versionQuery =
    !hasPathSeparator(programWord, env.platform) &&
    (isKnownProgram(key) || Object.hasOwn(WRAPPERS, key)) &&
    args.length === 1 &&
    (VERSION_QUERIES.has(args[0]) || (args[0] === '-v' && VERSION_FLAG_PROGRAMS.has(key))) &&
    !startsProjectCode(key) &&
    RISK_RANK[verdict.risk] <= RISK_RANK.network;
  // Keep the version/help query safe, but cover the flag in its prefix (`node --version`), so that
  // a redirect or wrapper raising it to normal does not offer a bare `node` grant that would then
  // cover `node evil.js` (see the rule-prefix guard in analyzeSimpleCommand).
  return versionQuery
    ? safe(`Prints version or help (${program})`, { paths: [], prefixLength: args.length + 1 })
    : verdict;
}

function roleOf(key: string, programWord: string, args: string[], verdict: Verdict): Role {
  return {
    fetcher: FETCHERS.has(key),
    interpreter: INTERPRETER_PROGRAMS.has(key),
    shell: SHELL_PROGRAMS.has(key),
    printed: PRINTERS.has(key) ? args.join(' ') : undefined,
    runsDynamicCode:
      VARIABLE_REFERENCE.test(programWord) ||
      (verdict.script !== undefined && VARIABLE_REFERENCE.test(verdict.script)),
    listsFiles: FILE_LISTERS.has(key),
    readsPipedFiles: PIPED_FILE_READERS.has(key),
  };
}

/** Commands a program runs per item (`find -exec rm {} ;`) become segments of their own. */
function analyzeNestedArgv(
  argvs: string[][],
  env: PathEnvironment,
  depth: number,
  scope: ReadonlyMap<string, boolean>,
): ScriptResult {
  const result: ScriptResult = { segments: [], findings: [], unparsable: false };
  for (const argv of argvs) {
    if (argv.length === 0) continue;
    // Each level hands the rest of the line to the next (`find -exec find -exec ...`), so the
    // nesting is bounded like nested scripts, and its text counts against the budget: beyond
    // that the command is only scanned for blocked programs and asks every time.
    if (
      depth + 1 >= MAX_SCRIPT_DEPTH ||
      budgetExhausted(env) ||
      !spendWork(env, Math.ceil(argv.reduce((sum, word) => sum + word.length + 1, 0) / 256))
    ) {
      const unchecked = analyzeUnchecked(argv.join(' '));
      result.findings.push(...unchecked.findings);
      result.unparsable = true;
      return result;
    }
    const nested = analyzeSimpleCommand(
      { assignments: [], words: argv, rawWords: argv, redirects: [], text: argv.join(' ') },
      env,
      depth + 1,
      scope,
    );
    result.segments.push(...nested.segments);
    result.findings.push(...nested.findings);
    result.unparsable ||= nested.unparsable;
  }
  return result;
}

/** Whether the shell may expand a word (filename patterns, braces) before the program sees it. */
type ExpansionCheck = (word: string) => boolean;

function expansionCheck(
  words: readonly string[],
  rawWords: readonly string[],
  platform: NodeJS.Platform,
): ExpansionCheck {
  const expanding = words.filter((word, i) => shellMayExpand(word, rawWords[i], platform));
  const exact = new Set(expanding);
  // Classifiers may pass on part of a word (`dd if=x` → `x`), so suffixes count as well. With
  // many patterns every word is assumed to be one (that only adds checks), keeping this linear.
  return (word) =>
    exact.has(word) ||
    (expanding.length > 0 &&
      (expanding.length > 64 || expanding.some((candidate) => candidate.endsWith(word))));
}

/**
 * Path arguments outside the project or with unknown variables, and arguments that may name
 * secret files: not for programs that only list names or metadata (`listsOnly`, e.g. `ls *`).
 */
function checkArgumentPaths(
  words: readonly string[],
  env: PathEnvironment,
  concerns: Concerns,
  expands: ExpansionCheck,
  listsOnly: boolean,
): void {
  // Once the budget is spent the whole command asks every time anyway (see analyzeCommand).
  if (budgetExhausted(env)) return;
  // PowerShell passes `a,b` as a list of two paths.
  const paths = new Set(
    env.platform === 'win32'
      ? words.flatMap((word) => (word.includes(',') ? [word, ...word.split(',')] : [word]))
      : words,
  );
  const location = locateArguments(paths, env);
  if (location === 'outside') concerns.findings.push(normal('Accesses paths outside the project'));
  if (location === 'variable') {
    concerns.findings.push(
      normal('Uses variables whose values are unknown in paths', { concern: 'opaque' }),
    );
  }
  const secret = listsOnly
    ? undefined
    : [...new Set(words)].find((word) => mayNameSensitive(word, env, expands(word)));
  if (secret !== undefined) {
    concerns.findings.push(
      normal(`Reads a file that may contain secrets (${secret})`, { concern: 'secret' }),
    );
  }
  if (location !== undefined || secret !== undefined) concerns.rememberable = false;
}

/**
 * Arguments of `git <args>` that may name files git writes (`archive -o`, `format-patch -o`):
 * those after the subcommand, without commit messages. Global options such as `--git-dir=.git`
 * and git's own handling of its directory are not writes by another program.
 */
function gitWriteTargets(args: readonly string[]): string[] {
  const rest = args.slice(gitSubcommandIndex(args) + 1);
  return rest.filter(
    (arg, i) => !/^(-m|--message)$/.test(rest[i - 1] ?? '') && !/^(-m.|--message=)/s.test(arg),
  );
}

/**
 * Options whose value is a pattern of files to leave alone (`--exclude .git`, `--exclude=.git`)
 * rather than a target. Only options that always take a value: a boolean such as
 * `--ignore-interrupts` (or `--ignore`, which tee reads as its abbreviation) is followed by a
 * real target.
 */
const EXCLUSION_VALUE_OPTIONS = new Set([
  '--exclude',
  '--exclude-dir',
  '--exclude-from',
  '--filter',
]);
/** Short exclusion options of particular programs (`tar -X file`, `zip -x pattern`). */
const SHORT_EXCLUSION_OPTIONS: Readonly<Record<string, string>> = {
  tar: '-X',
  bsdtar: '-X',
  zip: '-x',
};

/**
 * Programs that may write files must not touch `.git` (hooks and config run code later): the
 * same rule as the file tools, which never modify files inside `.git`. Values of exclusion
 * options are skipped, but not after `--`, where every word is an operand.
 */
function checkGitDirWrites(
  words: readonly string[],
  env: PathEnvironment,
  concerns: Concerns,
  expands: ExpansionCheck,
  key: string,
): void {
  const end = words.indexOf('--');
  const target = words.find((word, i) => {
    if (end < 0 || i < end) {
      const inline = /^(--[\w-]+)=/.exec(word)?.[1];
      if (inline !== undefined && EXCLUSION_VALUE_OPTIONS.has(inline)) return false;
      const previous = words[i - 1];
      if (
        previous !== undefined &&
        (EXCLUSION_VALUE_OPTIONS.has(previous) || previous === own(SHORT_EXCLUSION_OPTIONS, key))
      ) {
        return false;
      }
    }
    return touchesGitDir(word, env, expands(word));
  });
  if (target === undefined) return;
  concerns.findings.push(destructive(`May modify files inside the .git directory (${target})`));
  concerns.rememberable = false;
}

/** `bash -c`, `powershell -Command`, `cmd /c`, `eval`: analyze the payload in place of the shell. */
function analyzeNestedScript(
  verdict: Verdict,
  command: SimpleCommand,
  outer: Concerns,
  env: PathEnvironment,
  depth: number,
  role: Role,
  scope: ReadonlyMap<string, boolean>,
): CommandResult {
  if (depth >= MAX_SCRIPT_DEPTH) {
    const findings = [
      ...outer.findings,
      normal('The command is nested too deeply to analyze', { concern: 'opaque' }),
    ];
    const segment: Segment = {
      text: command.text,
      program: command.words[0],
      args: command.words.slice(1),
      findings,
      matchText: command.words.join(' '),
    };
    return { segments: [segment], findings: [], unparsable: true, role };
  }
  const nested = analyzeScript(verdict.script ?? '', env, depth + 1, scope);
  for (const segment of nested.segments) {
    segment.findings.push(...outer.findings);
    if (!outer.rememberable || verdict.rememberable === false) segment.rulePrefix = undefined;
  }
  const findings =
    nested.segments.length === 0 ? [...nested.findings, ...outer.findings] : nested.findings;
  return { segments: nested.segments, findings, unparsable: nested.unparsable, role };
}

function analyzeRedirect(
  redirect: Redirect,
  env: PathEnvironment,
): { finding: Finding; forget: boolean } | undefined {
  const windows =
    env.platform === 'win32' ? windowsLiteral(redirect.target, redirect.rawTarget) : undefined;
  const target = windows ?? redirect.target;
  // Under a POSIX shell on Windows the redirect target is read the POSIX way too (`> .\env` writes
  // `.env`): classify both readings and keep the riskier outcome (see windowsLiteral).
  const results = [redirectTarget(redirect, target, env)];
  if (env.backslashEscapes === true && windows !== undefined && windows !== redirect.target) {
    results.push(redirectTarget(redirect, redirect.target, env));
  }
  const present = results.filter((result) => result !== undefined);
  if (present.length === 0) return undefined;
  const finding = highest(present.map((result) => result.finding)) ?? present[0].finding;
  return { finding, forget: present.some((result) => result.forget) };
}

/** Classifies one reading of a redirect target. */
function redirectTarget(
  redirect: Redirect,
  target: string,
  env: PathEnvironment,
): { finding: Finding; forget: boolean } | undefined {
  const op = redirect.op.replace(/^\d+/, '');
  if (op === '<<' || op === '<<-' || op === '<<<') return undefined;
  if ((op === '>&' || op === '<&') && /^(\d+|-)$/.test(target)) return undefined;
  if (isHarmlessDevice(target)) return undefined;
  const writes = op.includes('>');
  if (writes && isRawDevice(target)) {
    return { finding: blocked(`Writes directly to a device (${target})`), forget: true };
  }
  const expands = shellMayExpand(target, redirect.rawTarget, env.platform);
  if (writes && touchesGitDir(target, env, expands)) {
    return { finding: destructive('Writes inside the .git directory'), forget: true };
  }
  // Once the budget is spent the whole command asks every time anyway (see analyzeCommand).
  if (budgetExhausted(env)) {
    return writes ? { finding: normal('Writes output to a file'), forget: true } : undefined;
  }
  const location = locatePathArgument(target, env);
  if (writes) {
    if (location === 'outside')
      return { finding: normal('Writes to a file outside the project'), forget: true };
    if (location === 'variable') {
      return {
        finding: normal('Writes to a file whose path uses variables', { concern: 'opaque' }),
        forget: true,
      };
    }
    return { finding: normal('Writes output to a file'), forget: false };
  }
  if (location === 'outside')
    return { finding: normal('Accesses paths outside the project'), forget: true };
  if (location === 'variable') {
    return {
      finding: normal('Uses variables whose values are unknown in paths', { concern: 'opaque' }),
      forget: true,
    };
  }
  if (mayNameSensitive(target, env, expands)) {
    return {
      finding: normal(`Reads a file that may contain secrets (${target})`, { concern: 'secret' }),
      forget: true,
    };
  }
  return undefined;
}

/**
 * Pipelines: a download piped (directly or through other commands) into an interpreter runs
 * downloaded code; text printed by echo/printf into a shell is analyzed as a script.
 */
function applyPipeRules(
  parsed: ParsedCommand,
  results: CommandResult[],
  env: PathEnvironment,
  depth: number,
  scope: ReadonlyMap<string, boolean>,
): void {
  // Pipes always run from an earlier command to a later one (see ParsedCommand.pipes), so one
  // pass in order finds, for every command, a fetcher and a file lister upstream of it.
  const upstream = new Map<number, number[]>();
  for (const [from, to] of parsed.pipes) {
    const list = upstream.get(to);
    if (list) list.push(from);
    else upstream.set(to, [from]);
  }
  const fetchedBy: Array<string | undefined> = [];
  const listedBy: Array<string | undefined> = [];
  const hasUpstream = (index: number): boolean =>
    (upstream.get(index) ?? []).some((from) => from < index);
  /** True when every upstream source is an analyzed printer (echo/printf), never a path producer. */
  const printerSourcesOnly = (index: number): boolean =>
    (upstream.get(index) ?? []).every(
      (from) => from < index && results[from].role.printed !== undefined,
    );
  results.forEach((sink, index) => {
    for (const from of upstream.get(index) ?? []) {
      if (from >= index) continue;
      const source = results[from];
      fetchedBy[index] ??= source.role.fetcher ? programOf(source) : fetchedBy[from];
      listedBy[index] ??= source.role.listsFiles ? programOf(source) : listedBy[from];
    }
    const fetcher = fetchedBy[index];
    if (fetcher !== undefined && sink.role.interpreter) {
      attach(
        sink,
        destructive(`Runs code downloaded from the network (${fetcher} | ${programOf(sink)})`),
      );
    }
    // PowerShell binds piped objects to -Path/-LiteralPath, so a reader (`Get-Content`,
    // `Select-String`) reads whatever upstream names, not only `Get-ChildItem`: text and object
    // producers (`echo Path ~/.ssh/id_rsa | ConvertFrom-Csv`, `Import-Csv`) build arbitrary paths
    // that bind just the same. Any upstream feeding a reader may therefore read secret or outside
    // files, so it is never remembered.
    if (env.platform === 'win32' && sink.role.readsPipedFiles && hasUpstream(index)) {
      const lister = listedBy[index];
      attach(
        sink,
        normal(
          lister !== undefined
            ? `Reads files listed by another command, which may contain secrets (${lister} | ${programOf(sink)})`
            : `Reads files named by piped input, which may be outside the project or contain secrets (${programOf(sink)})`,
          { concern: 'secret' },
        ),
      );
      for (const segment of sink.segments) segment.rulePrefix = undefined;
    }
    // A shell or interpreter fed by anything but an analyzed echo/printf runs code Patch cannot
    // see (`cat payload | bash`, `base64 -d <<< x | bash`): never remember such a sink.
    if (
      (sink.role.shell || sink.role.interpreter) &&
      hasUpstream(index) &&
      !printerSourcesOnly(index)
    ) {
      for (const segment of sink.segments) segment.rulePrefix = undefined;
    }
  });

  // Text printed into a shell is a script: analyze each printed text once.
  if (depth >= MAX_SCRIPT_DEPTH) return;
  const printedScripts = new Map<number, Finding | undefined>();
  for (const [from, to] of parsed.pipes) {
    const printed = results[from].role.printed;
    if (printed === undefined || !results[to].role.shell) continue;
    if (!printedScripts.has(from)) {
      const script = analyzeScript(printed, env, depth + 1, scope);
      printedScripts.set(
        from,
        highest([...script.findings, ...script.segments.flatMap((segment) => segment.findings)]),
      );
    }
    const top = printedScripts.get(from);
    if (top)
      attach(results[to], { risk: top.risk, reason: `Pipes commands into a shell: ${top.reason}` });
  }
}

function attach(result: CommandResult, finding: Finding): void {
  if (result.segments.length === 0) result.findings.push(finding);
  for (const segment of result.segments) segment.findings.push(finding);
}

function programOf(result: CommandResult): string {
  return result.segments[0]?.program || 'command';
}

/**
 * For input that failed to parse: look for dangerous programs anywhere in the text. Linear in the
 * text: programs that are always blocked are found wherever they are; other known programs are
 * classified with the words after them, each distinct invocation once, up to
 * MAX_SCANNED_INVOCATIONS (beyond that the command counts as destructive).
 */
function scanUnparsable(text: string, env: PathEnvironment, depth: number): Finding[] {
  const tokens = text.split(/[^\w.:\\/+-]+/).filter(Boolean);
  const findings: Finding[] = [];
  const ctx = programContext(env, depth);
  const keys = new Map<string, string>();
  const seen = new Set<string>();
  let fetches = false;
  let runsScripts = false;
  let truncated = false;
  for (let i = 0; i < tokens.length; i++) {
    let key = keys.get(tokens[i]);
    if (key === undefined) {
      key = lookupKey(programName(tokens[i], env.platform), env.platform);
      keys.set(tokens[i], key);
    }
    fetches ||= FETCHERS.has(key);
    runsScripts ||= SHELL_PROGRAMS.has(key) || key === 'eval' || key === 'source';
    const blockedReason = alwaysBlockedReason(key);
    if (blockedReason !== undefined) {
      if (!seen.has(key)) findings.push(blocked(`${blockedReason} (${key})`));
      seen.add(key);
      continue;
    }
    if (!isKnownProgram(key) || truncated) continue;
    const args = tokens.slice(i + 1, i + 9);
    const invocation = [key, ...args].join('\0');
    if (seen.has(invocation)) continue;
    seen.add(invocation);
    if (seen.size > MAX_SCANNED_INVOCATIONS) {
      truncated = true;
      continue;
    }
    const verdict = classifyProgram(key, args, ctx, tokens[i]);
    if (
      verdict &&
      verdict.script === undefined &&
      RISK_RANK[verdict.risk] >= RISK_RANK.destructive
    ) {
      findings.push({ risk: verdict.risk, reason: verdict.reason });
    }
  }
  if (fetches && runsScripts) findings.push(destructive('Runs code downloaded from the network'));
  if (truncated) findings.push(destructive('Has too many commands to check for dangerous ones'));
  return findings;
}

function programContext(env: PathEnvironment, depth: number): ProgramContext {
  return {
    platform: env.platform,
    isCatastrophicTarget: (word) => isCatastrophicTarget(word, env),
    pathExists: (word) => pathExists(word, env),
    inGitWorkTree: () => inGitWorkTree(env),
    gitRepoIsProject: (cValues) => gitRepositoryIsProject(env, cValues),
    searchHasNegatedIgnore: (roots) => searchHasNegatedIgnore(env, roots),
    analyzeScript: (script) => {
      if (depth + 1 >= MAX_SCRIPT_DEPTH)
        return normal('The command is nested too deeply to analyze', { concern: 'opaque' });
      const result = analyzeScript(script, env, depth + 1);
      return (
        highest([...result.findings, ...result.segments.flatMap((segment) => segment.findings)]) ??
        normal('Empty command')
      );
    },
  };
}

function locateArguments(
  words: Iterable<string>,
  env: PathEnvironment,
): 'outside' | 'variable' | undefined {
  let variable = false;
  for (const word of words) {
    // Once the budget is spent the whole command asks every time anyway (see analyzeCommand).
    if (!spendWork(env)) return undefined;
    const location = locatePathArgument(word, env);
    if (location === 'outside') return 'outside';
    if (location === 'variable') variable = true;
  }
  return variable ? 'variable' : undefined;
}

function defaultPathArguments(
  args: readonly string[],
  key: string,
  platform: NodeJS.Platform,
): string[] {
  return args.filter((arg) => !isSwitchArgument(arg, key, platform));
}

/**
 * Records `cd <dir>` so later relative paths are also checked against the new directory. Targets
 * that are unknown (`cd -`, `cd "$dir"`, `cd ~other`) make later relative paths count as outside.
 */
function trackDirectoryChange(key: string, args: readonly string[], env: PathEnvironment): void {
  // Once the budget is spent no path is checked any more.
  if (budgetExhausted(env)) return;
  const target = args.find((arg) => !isOption(arg));
  if (target === undefined) {
    // `pushd` alone swaps directories this command entered; `cd` alone goes home.
    if (key !== 'pushd') enterDirectory(env, env.home);
    return;
  }
  const expanded = expandHome(target, env.home);
  if (
    expanded === undefined ||
    target === '-' ||
    /\$|%\w+%/.test(expanded) ||
    // A `name:`-prefixed target with `..` may resolve through a symlinked `name:` directory to
    // somewhere other than its lexical parent: treat the new directory as unknown (outside).
    remoteLikeMayEscape(expanded, env.platform)
  ) {
    enterDirectory(env, undefined);
    return;
  }
  enterDirectory(env, resolveArgument(expanded, env.cwds[env.cwds.length - 1], env.platform));
}

/**
 * On Windows a backslash is a path separator rather than an escape (PowerShell and cmd keep it,
 * and a user writing `C:\Users` means a Windows path), so such words keep their backslashes.
 * That includes backslashes before wildcards and braces: `config\*` is every file in `config`
 * for PowerShell and cmd (and inside double quotes for Git Bash), never a literal `config*`.
 */
function windowsLiteral(value: string, raw: string | undefined): string {
  if (raw === undefined || !/\\[\w.$%~*?[\]{}-]/.test(raw) || /\$\(|`/.test(raw)) return value;
  return raw.replace(/["']/g, '');
}

/** Basename of the program; on Windows also lowercased and without .exe/.cmd/.bat/.ps1/.com. */
function programName(word: string, platform: NodeJS.Platform): string {
  const base = (platform === 'win32' ? word.split(/[\\/]/) : word.split('/')).pop() || word;
  return platform === 'win32' ? base.replace(/\.(exe|cmd|bat|ps1|com)$/i, '').toLowerCase() : base;
}

/**
 * Table key for a program name: case-insensitive on Windows and macOS (case-insensitive file
 * systems) and for PowerShell cmdlets (`Get-ChildItem`) everywhere.
 */
function lookupKey(program: string, platform: NodeJS.Platform): string {
  const caseInsensitive =
    platform === 'win32' || platform === 'darwin' || /^[A-Za-z]+-[A-Za-z]+$/.test(program);
  return caseInsensitive ? program.toLowerCase() : program;
}

function hasPathSeparator(word: string, platform: NodeJS.Platform): boolean {
  return word.includes('/') || (platform === 'win32' && word.includes('\\'));
}

function toPublicSegment(segment: Segment): CommandSegment {
  const top = highest(segment.findings) ?? normal('Runs a command');
  return {
    text: segment.text,
    program: segment.program,
    args: segment.args,
    risk: top.risk,
    reason: top.reason || undefined,
    matchText: segment.matchText,
    ...(segment.rulePrefix === undefined ? {} : { rulePrefix: segment.rulePrefix }),
  };
}

function summarizeReasons(findings: readonly Finding[], risk: CommandRisk): string[] {
  const relevant = findings
    .filter((finding) => finding.reason !== '')
    .filter((finding) => risk === 'safe' || RISK_RANK[finding.risk] > RISK_RANK.safe)
    .map((finding, order) => ({ finding, order }))
    .sort((a, b) => RISK_RANK[b.finding.risk] - RISK_RANK[a.finding.risk] || a.order - b.order);
  return [...new Set(relevant.map(({ finding }) => finding.reason))];
}

/**
 * The distinct, ordered rule prefixes of a rememberable command's non-safe segments (every
 * segment when all are safe), or [] when it must not be remembered: unparsable, above network, a
 * script-level finding above safe, or any covered segment without a prefix.
 */
function rulePrefixesFor(
  result: ScriptResult,
  segments: CommandSegment[],
  risk: CommandRisk,
): string[] {
  if (result.unparsable || RISK_RANK[risk] > RISK_RANK.network) return [];
  if (result.findings.some((finding) => RISK_RANK[finding.risk] > RISK_RANK.safe)) return [];
  const nonSafe = segments.filter((segment) => segment.risk !== 'safe');
  const pool = nonSafe.length > 0 ? nonSafe : segments;
  if (pool.length === 0 || pool.some((segment) => segment.rulePrefix === undefined)) return [];
  return [...new Set(pool.map((segment) => segment.rulePrefix as string))];
}
