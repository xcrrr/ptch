import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { detectShell } from '../../src/shell/shell.js';

/** The shell this machine would use (Git Bash on Windows, $SHELL/bash elsewhere). */
export const shell = detectShell();

/** Real-command tests use POSIX syntax; they are skipped when only PowerShell is available. */
export const isPosixShell = shell.kind === 'bash' || shell.kind === 'zsh' || shell.kind === 'sh';

/** The running Node binary, single-quoted for a POSIX shell (forward slashes work in Git Bash). */
export const NODE = `'${process.execPath.replace(/\\/g, '/')}'`;

/** Shell command running a script file (relative to the command's cwd) with Node. */
export function node(scriptFile: string): string {
  return `${NODE} ${scriptFile}`;
}

/** True while `pid` runs. A zombie (exited, not yet reaped) counts as gone. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  return !isZombie(pid);
}

/**
 * True while the process the shell knows as `pid` (its `$$`) runs. In Git Bash that is an MSYS
 * pid, not a Windows one, so the shell's own process table is asked.
 */
export function isShellProcessAlive(pid: number): boolean {
  if (process.platform !== 'win32') return isProcessAlive(pid);
  const probe = spawnSync(shell.executable, ['-c', `test -e /proc/${pid}`], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return probe.status === 0;
}

function isZombie(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  try {
    // /proc/<pid>/stat: "pid (comm) state ..."; comm may contain spaces and parentheses.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z';
  } catch {
    return false;
  }
}

/** Polls `condition` until it holds; throws after `timeoutMs`. */
export async function waitFor(
  condition: () => boolean,
  timeoutMs = 5_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Reads a pid written by a test script, once the file holds a complete number. */
export function readPid(read: () => string): number | undefined {
  try {
    const pid = Number(read().trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}
