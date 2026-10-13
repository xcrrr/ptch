import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ShellInfo } from './shell.js';

/** How to pass a command to a shell on the current platform. */
export interface ShellInvocation {
  args: string[];
  /** Explicit argv[0]; needed when arguments are passed verbatim on Windows. */
  argv0?: string;
  windowsVerbatimArguments: boolean;
  /**
   * Set when the command does not go on the command line: the caller must write `content` to
   * `path` (which `args` refer to) before spawning, and delete the file once the command is done.
   */
  scriptFile?: { path: string; content: string };
}

/**
 * Longest command passed to an MSYS/Cygwin shell (Git Bash) on its command line on Windows. The
 * MSYS runtime silently cuts a double-quoted argument after about 8,190 characters, so the shell
 * would run only the start of a longer command and could report success. Longer commands are
 * written to a script file that the shell runs instead. The limit leaves a wide margin because
 * the cut-off is an undocumented property of the runtime.
 */
export const MSYS_INLINE_COMMAND_LIMIT = 4_000;

/**
 * Builds spawn arguments for `shell.argsFor(command)`.
 *
 * On Windows a process receives one command-line string that it parses itself, so quoting must
 * match the target's parser:
 *  - Git Bash / MSYS / Cygwin shells un-escape `\\` and `\"` inside double quotes (unlike the
 *    MSVC rules Node applies by default, which would turn `'a\\b'` into `'a\b'`), so every
 *    argument is quoted and escaped for that runtime and passed verbatim. Commands longer than
 *    MSYS_INLINE_COMMAND_LIMIT are passed as a script file (`<shell> <file>`, see `scriptFile`).
 *  - cmd.exe with `/s /c` strips one pair of quotes around the rest of the line, so the command
 *    is wrapped in quotes and passed verbatim (as Node does for `shell: true`).
 *  - PowerShell follows the MSVC rules, which Node's default quoting already produces.
 *
 * `scriptPath` allocates the script file's path (by default a unique name in the temp directory
 * that holds the writing process's pid, see scriptFileOwner).
 */
export function shellInvocation(
  shell: ShellInfo,
  command: string,
  platform: NodeJS.Platform = process.platform,
  scriptPath: () => string = defaultScriptPath,
): ShellInvocation {
  if (platform !== 'win32' || shell.kind === 'powershell') {
    return { args: shell.argsFor(command), windowsVerbatimArguments: false };
  }
  // Verbatim mode also skips quoting argv[0], and the executable path may contain spaces.
  const argv0 = `"${shell.executable}"`;
  if (shell.kind === 'cmd') {
    const args = shell.argsFor(command);
    return {
      args: args.map((arg, index) => (index === args.length - 1 ? `"${arg}"` : arg)),
      argv0,
      windowsVerbatimArguments: true,
    };
  }
  if (command.length > MSYS_INLINE_COMMAND_LIMIT) {
    const file = scriptPath();
    return {
      // MSYS and Cygwin accept Windows paths with forward slashes.
      args: [quoteMsysArgument(file.replace(/\\/g, '/'))],
      argv0,
      windowsVerbatimArguments: true,
      scriptFile: { path: file, content: command },
    };
  }
  return {
    args: shell.argsFor(command).map(quoteMsysArgument),
    argv0,
    windowsVerbatimArguments: true,
  };
}

/**
 * Whether `shell` is assumed to run on the MSYS/Cygwin runtime: on Windows, every shell except
 * PowerShell and cmd (Git Bash, MSYS2 and Cygwin shells, and unrecognized `-c` shells).
 */
export function isMsysShell(
  shell: ShellInfo,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && shell.kind !== 'powershell' && shell.kind !== 'cmd';
}

/** Quotes one argument for the MSYS/Cygwin command-line parser. */
export function quoteMsysArgument(arg: string): string {
  return `"${arg.replace(/[\\"]/g, '\\$&')}"`;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SCRIPT_FILE_NAME = new RegExp(`^patch-command-(?:(\\d+)-)?${UUID}\\.sh$`);

/** `patch-command-<pid>-<uuid>.sh` in the temp directory; pid is the process writing the file. */
function defaultScriptPath(): string {
  return path.join(tmpdir(), `patch-command-${process.pid}-${randomUUID()}.sh`);
}

/**
 * For the name of a script file made by the default script path: the pid of the process that
 * wrote it, or null for names without one (older versions). Undefined for any other name.
 */
export function scriptFileOwner(name: string): number | null | undefined {
  const match = SCRIPT_FILE_NAME.exec(name);
  if (!match) return undefined;
  return match[1] === undefined ? null : Number(match[1]);
}
