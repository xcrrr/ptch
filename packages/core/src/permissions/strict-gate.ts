import type { ShellKind } from '../shell/shell.js';
import { parseCommand } from './command-parser.js';
import type { CommandAnalysis } from './command-risk.js';

/**
 * A deliberately simple, conservative gate applied after the detailed classifier.
 *
 * The detailed classifier understands a large part of shell syntax and many programs' options,
 * which is what lets it recognize read-only commands. That same breadth makes it easy to miss an
 * exotic corner (expansions inside subscripts, escapes, wrappers...). Running a command without
 * asking, or remembering an approval, therefore also requires passing this gate, which only accepts
 * plain syntax and a short list of well-understood programs. Anything else simply asks.
 */

/** Programs that may run without a prompt (when the detailed classifier also calls them safe). */
const AUTO_APPROVABLE = new Set([
  'cd',
  'ls',
  'dir',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'echo',
  'which',
  'where',
  'file',
  'stat',
  'du',
  'df',
  'tree',
  'sort',
  'uniq',
  'cut',
  'diff',
  'cmp',
  'comm',
  'nl',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'find',
  'git',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'date',
  'uname',
  'whoami',
  'hostname',
  'true',
  // Version and help queries of toolchains (the classifier decides which forms are read-only).
  'node',
  'npm',
  'pnpm',
  'python',
  'python3',
  'go',
  'cargo',
  'rustc',
  'tsc',
  'deno',
  'bun',
  'java',
  'dotnet',
  'ruby',
  // PowerShell read-only cmdlets and their aliases.
  'get-childitem',
  'gci',
  'get-content',
  'gc',
  'get-location',
  'get-item',
  'test-path',
  'select-string',
  'sls',
]);

/**
 * Programs whose normal (non-destructive) commands may be remembered for the session by their
 * subcommand prefix ("pnpm test", "git commit"). Interpreters (node, python, bash...) and generic
 * runners are absent on purpose: remembering "node" or "npx" would approve arbitrary code later.
 */
const REMEMBERABLE = new Set([
  'pnpm',
  'npm',
  'yarn',
  'bun',
  'deno',
  'cargo',
  'go',
  'make',
  'cmake',
  'ctest',
  'just',
  'git',
  'tsc',
  'eslint',
  'prettier',
  'biome',
  'vitest',
  'jest',
  'mocha',
  'playwright',
  'pytest',
  'ruff',
  'mypy',
  'black',
  'flake8',
  'tox',
  'dotnet',
  'mvn',
  'gradle',
  'rspec',
  'rake',
  'composer',
  'swift',
  'zig',
  'turbo',
  'nx',
  'mkdir',
  'touch',
  'cp',
  'mv',
]);

/** Second words that turn a package manager into a runner of arbitrary packages or binaries. */
const RUNNER_SUBCOMMANDS = new Set(['exec', 'dlx', 'x', 'create']);

/**
 * Per-program subcommands that download or run arbitrary code chosen by their arguments
 * (`npm init <initializer>` runs a create-* package, `go run pkg@latest` a remote module).
 */
const PROGRAM_RUNNERS: Readonly<Record<string, readonly string[]>> = {
  npm: ['init', 'innit', 'create', 'exec', 'x'],
  pnpm: ['init', 'create', 'exec', 'dlx'],
  yarn: ['init', 'create', 'dlx', 'exec'],
  bun: ['init', 'create', 'x'],
  go: ['run'],
  deno: ['run', 'eval', 'repl'],
  cargo: ['install'],
};

/** Package managers that run an unknown word as a binary (`pnpm node -e ...`). */
const BINARY_FALLBACK = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/**
 * Interpreters: remembered only with a concrete script (`node scripts/build.js`) or module
 * (`python -m pytest`) in the prefix, never as a bare program that would also cover `-e`/`-c`.
 */
const INTERPRETERS = new Set([
  'node',
  'python',
  'python3',
  'py',
  'ruby',
  'php',
  'perl',
  'bash',
  'sh',
  'zsh',
  'pwsh',
  'powershell',
  'tsx',
  'ts-node',
]);

/** Environment launchers remembered only when the program they launch is itself remembered. */
const LAUNCHERS = new Set(['uv', 'poetry', 'pipenv', 'pdm', 'hatch']);

/** Wrappers that only change how the program after them runs (the detailed analysis unwraps them). */
const TRANSPARENT_WRAPPERS = new Set(['env', 'timeout', 'nice', 'time', 'nohup', 'command']);

const SAFE_OUTSIDE_QUOTES = /[A-Za-z0-9 \t_\-.,/:=+@%^]/;
const CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f]/;

function describeCharacter(char: string): string {
  switch (char) {
    case '$':
    case '`':
      return 'Uses shell expansion';
    case '<':
    case '>':
      return 'Uses redirection';
    case '*':
    case '?':
    case '[':
    case ']':
      return 'Uses a filename pattern';
    case '\\':
      return 'Uses a backslash escape';
    case '(':
    case ')':
    case '{':
    case '}':
      return 'Uses grouping or a subshell';
    case '&':
      return 'Runs something in the background';
    case '\n':
    case '\r':
      return 'Spans several lines';
    case '~':
      return 'Uses home-directory expansion';
    default:
      return char.charCodeAt(0) > 0x7e
        ? 'Uses non-ASCII characters outside quotes'
        : 'Uses shell syntax Patch does not auto-approve';
  }
}

/**
 * Returns why `command` is not plain enough to run or remember without asking, or undefined.
 * Accepted: words of letters, digits and `_-.,/:=+@%^`, single- and double-quoted strings (double
 * quotes without `$`, backticks, `\` or `!`), and the separators `&&`, `||`, `|` and `;`.
 */
export function syntaxViolation(command: string, shell: ShellKind | undefined): string | undefined {
  const windowsShell = shell === 'powershell' || shell === 'cmd';
  // cmd has no single quotes; PowerShell and cmd expand `%`/`@`/`^` in ways POSIX shells do not.
  const singleQuotes = shell !== 'cmd';
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else if (CONTROL_CHARS.test(char)) return 'Uses control characters';
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === '$' || char === '`' || char === '\\' || char === '!') {
        return describeCharacter(char === '!' ? '$' : char);
      } else if (CONTROL_CHARS.test(char)) return 'Uses control characters';
      continue;
    }
    if (char === "'" && singleQuotes) {
      quote = "'";
      continue;
    }
    if (char === '"') {
      quote = '"';
      continue;
    }
    if (char === '|' || char === ';') continue;
    if (char === '&') {
      if (command[i + 1] === '&') {
        i++;
        continue;
      }
      return describeCharacter('&');
    }
    if (windowsShell && (char === '%' || char === '@' || char === '^')) {
      return 'Uses shell syntax Patch does not auto-approve';
    }
    // PowerShell and cmd use `\` as a path separator; POSIX shells (Git Bash) as an escape.
    if (windowsShell && char === '\\') continue;
    if (!SAFE_OUTSIDE_QUOTES.test(char)) return describeCharacter(char);
  }
  return quote === undefined ? undefined : 'Has an unterminated quote';
}

/** Lowercase program name without a Windows executable extension (names are compared loosely). */
function programName(word: string, platform: NodeJS.Platform): string {
  const lower = word.toLowerCase();
  return platform === 'win32' ? lower.replace(/\.(exe|cmd|bat|com)$/, '') : lower;
}

/**
 * Programs at the start of each simple command, or a reason the command does not have that plain
 * shape (variable assignments unless allowed, redirections, programs given by path, parse errors).
 */
function plainPrograms(
  command: string,
  platform: NodeJS.Platform,
  allowAssignments: boolean,
): { programs: string[] } | { violation: string } {
  const parsed = parseCommand(command);
  if (parsed.error) return { violation: 'Could not be parsed reliably' };
  if (parsed.hasCommandSubstitution || parsed.hasProcessSubstitution) {
    return { violation: 'Uses shell expansion' };
  }
  const programs: string[] = [];
  for (const simple of parsed.commands) {
    if (simple.assignments.length > 0 && !allowAssignments) {
      return { violation: 'Sets shell variables' };
    }
    if (simple.redirects.length > 0) return { violation: 'Uses redirection' };
    const first = simple.words[0];
    if (first === undefined || first === '') return { violation: 'Has an empty command' };
    if (/[/\\]/.test(first)) return { violation: 'Runs a program by path' };
    programs.push(programName(first, platform));
  }
  return { programs };
}

/** Whether a non-safe segment may be remembered under its own rule prefix. */
function segmentRememberable(
  program: string,
  prefix: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  const name = programName(program, platform);
  const words = (prefix ?? '').trim().split(/\s+/);
  const second = words[1];
  if (INTERPRETERS.has(name)) {
    if (second === undefined) return false;
    if (second === '-m') return words[2] !== undefined && !RUNNER_SUBCOMMANDS.has(words[2]);
    return !second.startsWith('-');
  }
  if (LAUNCHERS.has(name)) {
    if (second !== 'run') return second !== undefined;
    const launched = words[2];
    return launched !== undefined && REMEMBERABLE.has(programName(launched, platform));
  }
  if (!REMEMBERABLE.has(name)) return false;
  if (second === undefined) return true;
  if (RUNNER_SUBCOMMANDS.has(second)) return false;
  if (Object.hasOwn(PROGRAM_RUNNERS, name) && PROGRAM_RUNNERS[name]?.includes(second)) return false;
  // `pnpm node script.js` falls back to running the `node` binary: never remember interpreters.
  if (BINARY_FALLBACK.has(name) && INTERPRETERS.has(programName(second, platform))) return false;
  return true;
}

function notRememberable(analysis: CommandAnalysis): CommandAnalysis {
  const { rulePrefix: _prefix, rulePrefixes: _prefixes, ...rest } = analysis;
  return { ...rest, rememberable: false };
}

/**
 * Applies the gate to a detailed analysis:
 *  - a "safe" result stays safe only for plain syntax and AUTO_APPROVABLE programs; otherwise it
 *    becomes "normal" (Patch asks) and cannot be remembered;
 *  - a normal or network result keeps its session option only for plain syntax and REMEMBERABLE
 *    programs (never for runners such as `npm exec`); otherwise it asks every time.
 */
export function applyStrictGate(
  analysis: CommandAnalysis,
  shell: ShellKind | undefined,
  platform: NodeJS.Platform,
): CommandAnalysis {
  const { command, risk } = analysis;
  if (risk === 'safe') {
    const syntax = syntaxViolation(command, shell);
    const shape =
      syntax === undefined ? plainPrograms(command, platform, false) : { violation: syntax };
    const violation =
      'violation' in shape
        ? shape.violation
        : shape.programs.find((program) => !AUTO_APPROVABLE.has(program)) !== undefined
          ? 'Runs a program Patch only runs after asking'
          : undefined;
    if (violation === undefined) return analysis;
    return notRememberable({
      ...analysis,
      risk: 'normal',
      reasons: [violation],
      segments: analysis.segments.map((segment) =>
        segment.risk === 'safe' ? { ...segment, risk: 'normal', reason: violation } : segment,
      ),
    });
  }
  if (risk !== 'normal' && risk !== 'network') return analysis;
  if (analysis.rememberable === false && !analysis.rulePrefixes && !analysis.rulePrefix) {
    return analysis;
  }
  if (syntaxViolation(command, shell) !== undefined) return notRememberable(analysis);
  // Leading assignments (`CI=1 pnpm test`) were vetted by the detailed analysis, which makes the
  // command non-rememberable when they could change how programs run (PATH, LD_PRELOAD...).
  const shape = plainPrograms(command, platform, analysis.rememberable !== false);
  if ('violation' in shape) return notRememberable(analysis);
  const knownShape = shape.programs.every(
    (program) =>
      REMEMBERABLE.has(program) ||
      AUTO_APPROVABLE.has(program) ||
      INTERPRETERS.has(program) ||
      LAUNCHERS.has(program) ||
      TRANSPARENT_WRAPPERS.has(program),
  );
  const pendingRememberable = analysis.segments
    .filter((segment) => segment.risk !== 'safe')
    .every((segment) => segmentRememberable(segment.program, segment.rulePrefix, platform));
  return knownShape && pendingRememberable ? analysis : notRememberable(analysis);
}
