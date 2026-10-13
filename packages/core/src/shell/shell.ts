import { statSync } from 'node:fs';
import path from 'node:path';

export type ShellKind = 'bash' | 'zsh' | 'sh' | 'powershell' | 'cmd';

export interface ShellInfo {
  kind: ShellKind;
  /** Absolute path (or bare command name resolvable on PATH) of the shell executable. */
  executable: string;
  /** Human label, e.g. "bash", "zsh", "Git Bash", "PowerShell". */
  label: string;
  /** Argument vector that runs `command` non-interactively. */
  argsFor(command: string): string[];
}

export interface DetectShellOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Explicit shell from config (absolute path). Wins when it exists. */
  configured?: string;
  /** Injected existence check for tests. */
  exists?: (path: string) => boolean;
}

type Exists = (path: string) => boolean;

const POSIX_SHELLS: ReadonlySet<string> = new Set(['bash', 'zsh', 'sh']);
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'];

/**
 * Line run before every PowerShell command. Windows PowerShell and pwsh write redirected output
 * in the console's code page (e.g. 852), which cannot represent most of Unicode. This switches
 * the console code page and the encoding used for native programs' input and output to UTF-8.
 * The console is the command's own hidden one (commands are spawned without a console window),
 * never the user's terminal. The line goes before the command, after any statements that must
 * come first in a script (see withPowerShellSetup).
 */
export const POWERSHELL_UTF8_SETUP =
  'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}; ' +
  '$OutputEncoding = [Console]::OutputEncoding';

/**
 * Picks the shell used for `bash` tool calls and `!` commands.
 *  - POSIX: $SHELL when it is bash/zsh/sh, else /bin/bash, else /bin/sh. Args: ["-c", command].
 *  - Windows: Git Bash (never WSL's System32\bash.exe): $PATCH_GIT_BASH, then
 *    %ProgramFiles%\Git\bin\bash.exe, %ProgramFiles(x86)%\Git\bin\bash.exe,
 *    %LOCALAPPDATA%\Programs\Git\bin\bash.exe, then a bash.exe next to git.exe found on PATH
 *    (<git>\..\..\bin\bash.exe). Fallback: PowerShell (pwsh.exe if on PATH, else powershell.exe)
 *    with ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], where the script is
 *    the command with the setup line (POWERSHELL_UTF8_SETUP) that makes output UTF-8.
 *  - A configured cmd.exe gets ["/d", "/s", "/c", command], unchanged: cmd keeps the console's
 *    code page, in which it also reads batch files, and runCommand decodes its output in that
 *    code page.
 *
 * A configured shell is classified by its file name; unrecognized shells are assumed to accept
 * `-c <command>` like POSIX shells.
 */
export function detectShell(options: DetectShellOptions = {}): ShellInfo {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? isFile;
  if (options.configured && exists(options.configured)) {
    return shellFromExecutable(options.configured, platform);
  }
  return platform === 'win32' ? detectWindowsShell(env, exists) : detectPosixShell(env, exists);
}

function createShell(kind: ShellKind, executable: string, label: string): ShellInfo {
  return { kind, executable, label, argsFor: (command) => shellArgs(kind, command) };
}

function shellArgs(kind: ShellKind, command: string): string[] {
  switch (kind) {
    case 'powershell':
      return [...POWERSHELL_ARGS, withPowerShellSetup(command)];
    case 'cmd':
      return ['/d', '/s', '/c', command];
    default:
      return ['-c', command];
  }
}

/**
 * The PowerShell script that runs `command` after POWERSHELL_UTF8_SETUP. The command stays the
 * top-level script, which keeps its exit code semantics, but `using` statements and a `param`
 * block must precede every other statement, so those (with comments among them) stay in front of
 * the setup line. The setup line is a line of its own, so error positions keep their columns
 * (except on a line the preamble shares with other code) and line numbers grow by one (by two
 * after such a shared line).
 */
function withPowerShellSetup(command: string): string {
  const preambleEnd = powerShellPreambleEnd(command);
  if (preambleEnd === 0) return `${POWERSHELL_UTF8_SETUP}\n${command}`;
  const rest = command.slice(preambleEnd).replace(/^[ \t]*\r?\n/, '');
  return `${command.slice(0, preambleEnd)}\n${POWERSHELL_UTF8_SETUP}\n${rest}`;
}

const USING_STATEMENT = /using[ \t]+(?:namespace|module|assembly)\b/iy;
const PARAM_KEYWORD = /param\s*\(/iy;
const CLOSING: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };

/**
 * Where the statements that must start a PowerShell script end: `using` statements, then an
 * optional `param` block with its attributes (`[CmdletBinding()] param(...)`), with whitespace
 * and comments around them. 0 when the command starts with none. The scan is approximate (it
 * knows strings, comments and brackets); when it cannot follow the text, the preamble ends
 * before that point and PowerShell reports any error itself.
 */
function powerShellPreambleEnd(script: string): number {
  let end = 0;
  let i = 0;
  for (;;) {
    i = skipTrivia(script, i);
    USING_STATEMENT.lastIndex = i;
    if (!USING_STATEMENT.test(script)) return paramBlockEnd(script, i) ?? end;
    const statementEnd = usingStatementEnd(script, USING_STATEMENT.lastIndex);
    if (statementEnd === undefined) return end;
    end = i = statementEnd;
  }
}

/** End of a `using` statement: after its `;`, or at the end of its line. */
function usingStatementEnd(script: string, from: number): number | undefined {
  for (let i = from; i < script.length;) {
    const after = skipStringOrComment(script, i);
    if (after !== i) {
      i = after;
      continue;
    }
    const char = script[i]!;
    if (char === '\n' || char === '\r') return i;
    if (char === ';') return i + 1;
    if (char === '`') {
      i += 2;
    } else if (char in CLOSING) {
      const close = matchingBracket(script, i);
      if (close === undefined) return undefined;
      i = close + 1;
    } else {
      i++;
    }
  }
  return script.length;
}

/** End of a `param(...)` block starting at `from`, after any attributes; undefined if none. */
function paramBlockEnd(script: string, from: number): number | undefined {
  let i = from;
  while (script[i] === '[') {
    const close = matchingBracket(script, i);
    if (close === undefined) return undefined;
    i = skipTrivia(script, close + 1);
  }
  PARAM_KEYWORD.lastIndex = i;
  if (!PARAM_KEYWORD.test(script)) return undefined;
  const close = matchingBracket(script, PARAM_KEYWORD.lastIndex - 1);
  return close === undefined ? undefined : close + 1;
}

/** Index of the bracket closing the one at `open`, skipping strings, comments and escapes. */
function matchingBracket(script: string, open: number): number | undefined {
  const expected: string[] = [];
  for (let i = open; i < script.length;) {
    const after = skipStringOrComment(script, i);
    if (after !== i) {
      i = after;
      continue;
    }
    const char = script[i]!;
    if (char === '`') {
      i += 2;
      continue;
    }
    const closing = CLOSING[char];
    if (closing !== undefined) {
      expected.push(closing);
    } else if (char === ')' || char === ']' || char === '}') {
      if (expected.pop() !== char) return undefined;
      if (expected.length === 0) return i;
    }
    i++;
  }
  return undefined;
}

/** Skips whitespace, line breaks and comments. */
function skipTrivia(script: string, from: number): number {
  let i = from;
  while (i < script.length) {
    if (/\s/.test(script[i]!)) {
      i++;
      continue;
    }
    const after = script[i] === '#' || script[i] === '<' ? skipStringOrComment(script, i) : i;
    if (after === i) return i;
    i = after;
  }
  return i;
}

/**
 * The index after the string literal or comment starting at `i`, or `i` when none starts there.
 * Unterminated ones extend to the end of the script.
 */
function skipStringOrComment(script: string, i: number): number {
  const char = script[i];
  if (char === '<' && script[i + 1] === '#') return indexAfter(script, '#>', i + 2);
  if (char === '#' && (i === 0 || /[\s;,(){}[\]=|&]/.test(script[i - 1]!))) {
    const lineEnd = script.slice(i).search(/[\r\n]/);
    return lineEnd < 0 ? script.length : i + lineEnd;
  }
  if (char === '@' && (script[i + 1] === '"' || script[i + 1] === "'")) {
    const quote = script[i + 1]!;
    const header = /^[ \t]*\r?\n/.exec(script.slice(i + 2));
    if (header) {
      const close = new RegExp(`\\r?\\n${quote}@`, 'g');
      close.lastIndex = i + 2 + header[0].length - 1;
      const match = close.exec(script);
      return match ? match.index + match[0].length : script.length;
    }
    return i;
  }
  if (char === "'") {
    for (let j = i + 1; j < script.length; j++) {
      if (script[j] !== "'") continue;
      if (script[j + 1] !== "'") return j + 1;
      j++;
    }
    return script.length;
  }
  if (char === '"') {
    for (let j = i + 1; j < script.length; j++) {
      const inner = script[j];
      if (inner === '`') {
        j++;
      } else if (inner === '$' && script[j + 1] === '(') {
        const close = matchingBracket(script, j + 1);
        if (close === undefined) return script.length;
        j = close;
      } else if (inner === '"') {
        if (script[j + 1] !== '"') return j + 1;
        j++;
      }
    }
    return script.length;
  }
  return i;
}

function indexAfter(script: string, token: string, from: number): number {
  const index = script.indexOf(token, from);
  return index < 0 ? script.length : index + token.length;
}

function detectPosixShell(env: NodeJS.ProcessEnv, exists: Exists): ShellInfo {
  const fromEnv = env.SHELL;
  if (fromEnv && path.posix.isAbsolute(fromEnv)) {
    const name = path.posix.basename(fromEnv);
    if (POSIX_SHELLS.has(name) && exists(fromEnv)) {
      return createShell(name as ShellKind, fromEnv, name);
    }
  }
  if (exists('/bin/bash')) return createShell('bash', '/bin/bash', 'bash');
  return createShell('sh', '/bin/sh', 'sh');
}

function detectWindowsShell(env: NodeJS.ProcessEnv, exists: Exists): ShellInfo {
  const gitBash = gitBashCandidates(env, exists).find(
    (candidate) => !isWslLauncher(candidate) && exists(candidate),
  );
  if (gitBash) return createShell('bash', gitBash, 'Git Bash');

  const powershell =
    findOnPath('pwsh.exe', env, exists) ??
    findOnPath('powershell.exe', env, exists) ??
    systemPowerShell(env, exists) ??
    'powershell.exe';
  return createShell('powershell', powershell, 'PowerShell');
}

function gitBashCandidates(env: NodeJS.ProcessEnv, exists: Exists): string[] {
  const win = path.win32;
  const candidates: string[] = [];
  const explicit = windowsEnv(env, 'PATCH_GIT_BASH');
  if (explicit) candidates.push(explicit);
  for (const [variable, ...segments] of [
    ['ProgramFiles', 'Git', 'bin', 'bash.exe'],
    ['ProgramFiles(x86)', 'Git', 'bin', 'bash.exe'],
    ['LOCALAPPDATA', 'Programs', 'Git', 'bin', 'bash.exe'],
  ] as const) {
    const root = windowsEnv(env, variable);
    if (root) candidates.push(win.join(root, ...segments));
  }
  const git = findOnPath('git.exe', env, exists);
  if (git) {
    // <Git>\cmd\git.exe and <Git>\bin\git.exe sit one level below the install root,
    // <Git>\mingw64\bin\git.exe two levels.
    const gitDir = win.dirname(git);
    candidates.push(win.join(gitDir, '..', 'bin', 'bash.exe'));
    candidates.push(win.join(gitDir, '..', '..', 'bin', 'bash.exe'));
  }
  return candidates;
}

/** WSL's bash.exe launchers run commands inside Linux, not against the Windows filesystem view. */
function isWslLauncher(executable: string): boolean {
  const normalized = path.win32.normalize(executable).toLowerCase();
  return (
    /\\(?:system32|sysnative)\\bash\.exe$/.test(normalized) ||
    normalized.includes('\\windowsapps\\')
  );
}

function systemPowerShell(env: NodeJS.ProcessEnv, exists: Exists): string | undefined {
  const systemRoot = windowsEnv(env, 'SystemRoot') ?? windowsEnv(env, 'windir');
  if (!systemRoot) return undefined;
  const candidate = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return exists(candidate) ? candidate : undefined;
}

/** Looks `fileName` up in absolute PATH directories (relative entries are skipped deliberately). */
function findOnPath(fileName: string, env: NodeJS.ProcessEnv, exists: Exists): string | undefined {
  const searchPath = windowsEnv(env, 'PATH');
  if (!searchPath) return undefined;
  for (const entry of searchPath.split(path.win32.delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !path.win32.isAbsolute(dir)) continue;
    const candidate = path.win32.join(dir, fileName);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** Environment lookup with Windows semantics (variable names are case-insensitive). */
function windowsEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === upper);
  const value = key === undefined ? undefined : env[key];
  return value ? value : undefined;
}

function shellFromExecutable(executable: string, platform: NodeJS.Platform): ShellInfo {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const name = paths
    .basename(executable)
    .toLowerCase()
    .replace(/\.exe$/, '');
  switch (name) {
    case 'bash':
      return createShell('bash', executable, gitBashLabel(executable, platform));
    case 'zsh':
    case 'sh':
      return createShell(name, executable, name);
    case 'pwsh':
    case 'powershell':
      return createShell('powershell', executable, 'PowerShell');
    case 'cmd':
      return createShell('cmd', executable, 'cmd');
    default:
      return createShell('sh', executable, name);
  }
}

function gitBashLabel(executable: string, platform: NodeJS.Platform): string {
  return platform === 'win32' && /[\\/]git[\\/]/i.test(executable) ? 'Git Bash' : 'bash';
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}
