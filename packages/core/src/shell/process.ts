import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  codePageDecoder,
  ConsoleOutputDecoder,
  windowsConsoleCodePage,
  type TextStreamDecoder,
} from './code-pages.js';
import { HeadTailBuffer, type BufferedText } from './head-tail-buffer.js';
import {
  isMsysShell,
  quoteMsysArgument,
  scriptFileOwner,
  shellInvocation,
  type ShellInvocation,
} from './invocation.js';
import type { ShellInfo } from './shell.js';
import { system32Path } from './system32.js';
import {
  collapseCarriageReturns,
  LineSplitter,
  TerminalStreamSanitizer,
  type LineHandler,
} from './terminal-text.js';

export interface RunCommandOptions {
  shell: ShellInfo;
  cwd: string;
  /** Hard timeout; the process tree is killed when exceeded. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Extra environment variables merged over process.env. */
  env?: Record<string, string>;
  /**
   * Called with each decoded chunk as it arrives, with escape sequences and control characters
   * removed. Carriage returns are kept so live views can render progress updates (see LiveTail).
   * Errors thrown by the callback are ignored.
   */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Max bytes retained per stream; beyond this the head and tail are kept. Default 4 MB. */
  maxBufferBytes?: number;
  /**
   * Written to the command's stdin, which is closed afterwards (hooks read their event this way).
   * Without it stdin is closed from the start.
   */
  input?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  /** null when killed by a signal / timeout / abort. */
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  /** True when output exceeded maxBufferBytes and the middle was dropped (marked inline). */
  outputTruncated: boolean;
}

/** Environment applied to every command so tools never block on pagers or prompts. */
export const NON_INTERACTIVE_ENV: Record<string, string> = {
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  EDITOR: 'true',
  VISUAL: 'true',
  NO_UPDATE_NOTIFIER: '1',
  PATCH_AGENT: '1',
};

export const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * After the shell exits, how long to wait for its output pipes to close. Pipes stay open while a
 * background process (`server &`) still holds them; such processes are left running.
 */
const EXIT_GRACE_MS = 1_000;
/** After a kill, how long to wait for the process tree to go away before resolving anyway. */
const KILL_GRACE_MS = 5_000;
/** POSIX: delay between SIGTERM and SIGKILL. */
const TERMINATE_GRACE_MS = 2_000;
const POLL_INTERVAL_MS = 50;
const TASKKILL_TIMEOUT_MS = 5_000;
/** Windows: how long the MSYS process-group kill (see killMsysCommands) may take. */
const MSYS_KILL_TIMEOUT_MS = 5_000;
/** Script files without the writer's pid in their name (older versions) are stale after a day. */
const UNOWNED_SCRIPT_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
/** setTimeout fires immediately for delays above 2^31 - 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Windows with an MSYS/Cygwin shell: environment variable holding a unique id per command, which
 * lets killProcessTree find the command's MSYS processes (see killMsysCommands).
 */
export const COMMAND_ID_VARIABLE = 'PATCH_COMMAND_ID';

/** Shells of commands still running, by pid: killed synchronously if Patch exits abruptly. */
const runningTrees = new Map<number, KillProcessTreeOptions>();
/** Script files of commands still running (see shellInvocation): deleted if Patch exits abruptly. */
const liveScriptFiles = new Set<string>();
let exitHookInstalled = false;
let staleScriptSweep: Promise<unknown> | undefined;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', killAllProcessTreesSync);
}

function trackRunningTree(pid: number, kill: KillProcessTreeOptions): void {
  runningTrees.set(pid, kill);
  installExitHook();
}

/**
 * Registers a process tree started outside runCommand (an MCP server) so the exit hook kills it
 * if Patch exits while it runs (see killAllProcessTreesSync; on POSIX it must lead its own process
 * group, i.e. be spawned detached). Returns a function that unregisters it once it has stopped.
 */
export function trackProcessTree(pid: number): () => void {
  trackRunningTree(pid, {});
  return () => {
    runningTrees.delete(pid);
  };
}

/**
 * Kills every command still running and deletes their script files, synchronously: safe in an
 * 'exit' handler (where it is installed) and before a forced process.exit. POSIX: SIGKILL to each
 * process group. Windows: the commands' MSYS processes first, with one helper run bounded by
 * MSYS_KILL_TIMEOUT_MS (see killMsysCommands), then `taskkill /T /F` on every shell.
 */
export function killAllProcessTreesSync(): void {
  const trees = [...runningTrees];
  runningTrees.clear();
  if (process.platform === 'win32') {
    killWindowsTreesSync(trees);
  } else {
    for (const [pid] of trees) sendSignal(-pid, 'SIGKILL');
  }
  // After the kills, so no shell is still reading its script.
  for (const file of liveScriptFiles) removeFile(file);
  liveScriptFiles.clear();
}

/**
 * Runs a shell command with stdin closed (or fed `options.input`). Never throws for non-zero exit
 * codes, timeouts or aborts (reflected in the result). Throws only if the shell itself cannot be
 * spawned, as an Error with a clear message ("Could not start shell <executable>: ENOENT").
 *
 * Process-tree cleanup: on POSIX the child is spawned detached and the whole process group is
 * signalled (SIGTERM, then SIGKILL after 2 s); on Windows `taskkill /pid <pid> /T /F` is used,
 * after the command's MSYS processes when the shell is Git Bash or another MSYS/Cygwin shell.
 * Commands still running when Patch exits are killed by an 'exit' hook (killAllProcessTreesSync).
 * Commands too long for an MSYS shell's command line run from a temporary script file, which is
 * deleted afterwards, by the exit hook, or, after a hard kill, by a later Patch process (see
 * removeStaleScriptFiles).
 *
 * Output is decoded as UTF-8; on Windows, lines that are not valid UTF-8 are decoded in the code
 * page of the command's console (see ConsoleOutputDecoder). ANSI escape sequences are stripped
 * from captured output, CRLF becomes LF, and carriage-return progress updates are collapsed to
 * their final state.
 */
export async function runCommand(
  command: string,
  options: RunCommandOptions,
): Promise<CommandResult> {
  if (options.signal?.aborted) return abortedBeforeStart();
  const newDecoder = outputDecoderFactory(await windowsConsoleCodePage());
  if (options.signal?.aborted) return abortedBeforeStart();
  const startedAt = performance.now();
  const invocation = shellInvocation(options.shell, command);
  const commandId = isMsysShell(options.shell) ? randomUUID() : undefined;
  // Only MSYS shells on Windows use script files.
  if (commandId !== undefined) staleScriptSweep ??= removeStaleScriptFiles();
  const env = commandEnvironment({
    ...options.env,
    ...(commandId === undefined ? {} : { [COMMAND_ID_VARIABLE]: commandId }),
  });
  if (invocation.scriptFile) writeScriptFile(options, invocation.scriptFile);
  try {
    let child: ChildProcess;
    try {
      child = spawn(options.shell.executable, invocation.args, {
        cwd: options.cwd,
        env,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        ...(invocation.argv0 === undefined ? {} : { argv0: invocation.argv0 }),
      });
    } catch (error) {
      throw startError(options, error, command);
    }
    const kill: KillProcessTreeOptions =
      commandId === undefined ? {} : { msys: { shell: options.shell, commandId } };
    return await supervise(child, options, startedAt, kill, command, newDecoder);
  } finally {
    if (invocation.scriptFile) {
      removeFile(invocation.scriptFile.path);
      liveScriptFiles.delete(invocation.scriptFile.path);
    }
  }
}

/** Windows: output can mix UTF-8 with the console's code page (see ConsoleOutputDecoder). */
function outputDecoderFactory(codePage: number | undefined): () => TextStreamDecoder {
  const legacy = codePage === undefined ? undefined : codePageDecoder(codePage);
  return legacy ? () => new ConsoleOutputDecoder(legacy) : () => new StringDecoder('utf8');
}

/**
 * Creates the script file with owner-only permissions (where the file system has them), failing
 * if the path exists. From then on it is registered for deletion by the exit hook; if writing
 * fails, the partial file is deleted at once.
 */
function writeScriptFile(
  options: RunCommandOptions,
  script: NonNullable<ShellInvocation['scriptFile']>,
): void {
  let failure: unknown;
  try {
    const fd = openSync(script.path, 'wx', 0o600);
    liveScriptFiles.add(script.path);
    installExitHook();
    try {
      writeFileSync(fd, script.content, 'utf8');
    } finally {
      closeSync(fd);
    }
    return;
  } catch (error) {
    failure = error;
  }
  if (liveScriptFiles.delete(script.path)) removeFile(script.path);
  const reason = (failure as NodeJS.ErrnoException | undefined)?.code ?? String(failure);
  throw new Error(
    `Could not start shell ${options.shell.executable}: the command is too long for its command line, and writing it to ${script.path} failed (${reason})`,
    { cause: failure },
  );
}

function removeFile(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // Best effort: the file sits in the temp directory.
  }
}

/**
 * Deletes script files (see shellInvocation) that Patch processes which are gone left in `dir`,
 * the temp directory by default: after a hard kill or a crash the exit hook cannot delete them.
 * A script file's name holds the pid of the process that wrote it, and files of processes still
 * running are kept; files named without a pid (older versions) are deleted after a day. Runs
 * once per process, the first time a command runs in an MSYS shell on Windows. Best effort;
 * resolves to the names of the files deleted.
 */
export async function removeStaleScriptFiles(dir: string = tmpdir()): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    const owner = scriptFileOwner(name);
    if (owner === undefined || owner === process.pid) continue;
    const file = path.join(dir, name);
    try {
      if (owner === null) {
        const { mtimeMs } = await stat(file);
        if (Date.now() - mtimeMs < UNOWNED_SCRIPT_FILE_MAX_AGE_MS) continue;
      } else if (isAlive(owner)) {
        continue;
      }
      await rm(file, { force: true });
      removed.push(name);
    } catch {
      // Gone already, or not ours to delete.
    }
  }
  return removed;
}

function supervise(
  child: ChildProcess,
  options: RunCommandOptions,
  startedAt: number,
  kill: KillProcessTreeOptions,
  command: string,
  newDecoder: () => TextStreamDecoder,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const maxBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    const stdout = new StreamCapture(maxBytes, newDecoder(), (text) =>
      notify(options, text, 'stdout'),
    );
    const stderr = new StreamCapture(maxBytes, newDecoder(), (text) =>
      notify(options, text, 'stderr'),
    );
    let spawned = false;
    let settled = false;
    let terminating = false;
    let timedOut = false;
    let aborted = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (child.pid !== undefined) runningTrees.delete(child.pid);
      // Release pipes still held by processes that outlived the shell.
      child.stdout?.destroy();
      child.stderr?.destroy();
      const out = stdout.finish();
      const err = stderr.finish();
      resolve({
        stdout: out.text,
        stderr: err.text,
        exitCode: timedOut || aborted ? null : code,
        signal,
        durationMs: Math.round(performance.now() - startedAt),
        timedOut,
        aborted,
        outputTruncated: out.truncated || err.truncated,
      });
    };

    // setImmediate lets the poll phase read data already sitting in the pipes before finishing.
    const finishAfter = (delayMs: number) => {
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        setImmediate(() => finish(exit?.code ?? null, exit?.signal ?? null));
      }, delayMs);
    };

    const terminate = (reason: 'timeout' | 'abort') => {
      if (settled || terminating) return;
      if (exit) {
        // The shell already finished; only stop waiting for pipes held by background processes.
        finishAfter(0);
        return;
      }
      terminating = true;
      if (reason === 'timeout') timedOut = true;
      else aborted = true;
      if (child.pid !== undefined) void killProcessTree(child.pid, process.platform, kill);
      finishAfter(KILL_GRACE_MS);
    };

    function onAbort() {
      terminate('abort');
    }

    child.stdout?.on('data', (chunk: Buffer) => stdout.write(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.write(chunk));
    if (child.stdin) {
      // EPIPE when the command exits without reading its input: not a failure of the command.
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.input);
    }
    child.once('spawn', () => {
      spawned = true;
      if (child.pid !== undefined) trackRunningTree(child.pid, kill);
    });
    child.on('error', (error) => {
      // Errors after a successful spawn (e.g. a failed kill) do not affect the result.
      if (spawned || settled) return;
      settled = true;
      cleanup();
      reject(startError(options, error, command));
    });
    child.once('exit', (code, signal) => {
      exit = { code, signal };
      clearTimeout(timeoutTimer);
      if (!terminating) finishAfter(EXIT_GRACE_MS);
    });
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) =>
      finish(code, signal),
    );

    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(
        () => terminate('timeout'),
        Math.min(options.timeoutMs, MAX_TIMER_MS),
      );
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Decodes, sanitizes and retains one output stream. */
class StreamCapture {
  private readonly sanitizer = new TerminalStreamSanitizer();
  private readonly lines = new LineSplitter();
  private readonly buffer: HeadTailBuffer;

  constructor(
    maxBytes: number,
    private readonly decoder: TextStreamDecoder,
    private readonly onText: (text: string) => void,
  ) {
    this.buffer = new HeadTailBuffer(maxBytes);
  }

  write(chunk: Buffer): void {
    this.accept(this.sanitizer.push(this.decoder.write(chunk)));
  }

  finish(): BufferedText {
    this.accept(this.sanitizer.push(this.decoder.end()));
    this.accept(this.sanitizer.flush());
    this.lines.flush(this.retain);
    return this.buffer.finish();
  }

  private accept(text: string): void {
    if (text === '') return;
    this.onText(text);
    this.lines.push(text, this.retain);
  }

  private readonly retain: LineHandler = (line, terminated) => {
    this.buffer.append(collapseCarriageReturns(line) + (terminated ? '\n' : ''));
  };
}

function notify(options: RunCommandOptions, text: string, stream: 'stdout' | 'stderr'): void {
  try {
    options.onOutput?.(text, stream);
  } catch {
    // A failing observer must not break output capture.
  }
}

function abortedBeforeStart(): CommandResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    durationMs: 0,
    timedOut: false,
    aborted: true,
    outputTruncated: false,
  };
}

/** process.env + NON_INTERACTIVE_ENV + extra, replacing variables case-insensitively on Windows. */
function commandEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries({ ...NON_INTERACTIVE_ENV, ...extra })) {
    if (process.platform === 'win32') {
      const upper = name.toUpperCase();
      for (const existing of Object.keys(env)) {
        if (existing.toUpperCase() === upper) delete env[existing];
      }
    }
    env[name] = value;
  }
  return env;
}

function startError(options: RunCommandOptions, error: unknown, command: string): Error {
  const executable = options.shell.executable;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' && !isDirectory(options.cwd)) {
    return new Error(
      `Could not start shell ${executable}: working directory ${options.cwd} does not exist`,
      { cause: error },
    );
  }
  if (code === 'ENAMETOOLONG' || code === 'E2BIG') {
    return new Error(
      `Could not start shell ${executable}: the command (${command.length.toLocaleString('en-US')} characters) is longer than the operating system allows on a command line (${code}). Write long scripts to a file and run the file instead.`,
      { cause: error },
    );
  }
  const reason =
    code && !code.startsWith('ERR_')
      ? code
      : error instanceof Error
        ? error.message
        : String(error);
  return new Error(`Could not start shell ${executable}: ${reason}`, { cause: error });
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

export interface KillProcessTreeOptions {
  /**
   * Windows: the process is an MSYS/Cygwin shell (Git Bash) that was started with
   * `COMMAND_ID_VARIABLE=<commandId>` in its environment. Its MSYS process group is killed first,
   * since `taskkill /T` alone misses processes started through MSYS fork/exec (see
   * killMsysCommands).
   */
  msys?: { shell: ShellInfo; commandId: string };
}

/** Kills a process and all its descendants. Best effort, never throws. */
export async function killProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  options: KillProcessTreeOptions = {},
): Promise<void> {
  try {
    if (platform === 'win32') {
      if (options.msys) await killMsysCommands(options.msys.shell, [options.msys.commandId]);
      await killWindowsTree(pid);
    } else {
      await killPosixTree(pid);
    }
  } catch {
    // Best effort by contract.
  }
}

/** Signals the process group led by `pid` (falling back to the single process), escalating to SIGKILL. */
async function killPosixTree(pid: number): Promise<void> {
  const target = sendSignal(-pid, 'SIGTERM') ? -pid : sendSignal(pid, 'SIGTERM') ? pid : undefined;
  if (target === undefined) return;
  const deadline = performance.now() + TERMINATE_GRACE_MS;
  while (performance.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (!isAlive(target)) return;
  }
  sendSignal(target, 'SIGKILL');
}

function sendSignal(target: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(target, signal);
    return true;
  } catch {
    return false;
  }
}

function isAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `taskkill /T /F` ends the whole tree; plain TerminateProcess is the fallback. */
function killWindowsTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    let taskkill: ChildProcess;
    try {
      taskkill = spawn(taskkillPath(), ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      sendSignal(pid, 'SIGKILL');
      resolve();
      return;
    }
    const timer = setTimeout(resolve, TASKKILL_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    taskkill.once('error', () => {
      sendSignal(pid, 'SIGKILL');
      done();
    });
    taskkill.once('exit', done);
  });
}

/**
 * Synchronous counterpart of killProcessTree for several shells at once (see
 * killAllProcessTreesSync): one MSYS helper run per MSYS installation for all its commands, then
 * one `taskkill /T /F` for all the shells. Each step is bounded by its timeout.
 */
function killWindowsTreesSync(trees: ReadonlyArray<[number, KillProcessTreeOptions]>): void {
  const commandsByHelper = new Map<string, string[]>();
  for (const [, { msys }] of trees) {
    if (!msys) continue;
    const helper = msysHelperShell(msys.shell);
    commandsByHelper.set(helper, [...(commandsByHelper.get(helper) ?? []), msys.commandId]);
  }
  for (const [helper, commandIds] of commandsByHelper) {
    const { args, options } = msysKillInvocation(helper, commandIds);
    spawnSync(helper, args, { ...options, timeout: MSYS_KILL_TIMEOUT_MS });
  }
  if (trees.length === 0) return;
  // taskkill ends the processes that exist even when some of the pids are gone.
  const pids = trees.flatMap(([pid]) => ['/PID', String(pid)]);
  spawnSync(taskkillPath(), ['/F', '/T', ...pids], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: TASKKILL_TIMEOUT_MS,
  });
}

function taskkillPath(): string {
  return system32Path('taskkill.exe');
}

/**
 * Bash script for killMsysCommands; arguments: taskkill's path, then the command ids. It finds
 * the commands' shells (top-level MSYS processes, so their parent pid is 1, whose environment
 * holds one of the ids; each environment is read in a subshell, because reading some processes'
 * environment aborts the MSYS runtime with "cmalloc would have returned NULL", which would end
 * the whole helper), takes every MSYS process in their process groups plus their MSYS
 * descendants, and kills them: SIGSTOP first, so a shell whose child dies cannot go on to the
 * next command of a list (`build; rm -rf out`) before it is killed itself, then `taskkill /T` on
 * their Windows pids, which ends the native processes they started while the Windows parent links
 * still hold, then SIGKILL for the MSYS processes. A few rounds catch processes forked in the
 * meantime. Only shell built-ins run besides taskkill.
 */
const MSYS_KILL_SCRIPT = [
  "taskkill=$1 self=$$ targets=' '",
  'shift',
  'ids=" $* "',
  'for dir in /proc/[0-9]*; do',
  '  pid=${dir#/proc/}',
  '  [ "$pid" != "$self" ] && read -r ppid < "$dir/ppid" && [ "$ppid" = 1 ] || continue',
  '  (',
  "    while IFS= read -r -d '' var; do",
  `      case $var in ${COMMAND_ID_VARIABLE}=*) ;; *) continue ;; esac`,
  '      case $ids in *" ${var#*=} "*) exit 0 ;; esac',
  '      exit 1',
  '    done < "$dir/environ"',
  '    exit 1',
  '  ) && read -r pgid < "$dir/pgid" && targets+="$pgid "',
  'done 2>/dev/null',
  '[ "$targets" = \' \' ] && exit 0',
  'for round in 1 2 3; do',
  '  pids=() parents=() pgids=() winpids=()',
  '  for dir in /proc/[0-9]*; do',
  '    pid=${dir#/proc/}',
  '    [ "$pid" != "$self" ] && read -r ppid < "$dir/ppid" && read -r pgid < "$dir/pgid" &&',
  '      read -r winpid < "$dir/winpid" || continue',
  '    pids+=("$pid") parents+=("$ppid") pgids+=("$pgid") winpids+=("$winpid")',
  '  done 2>/dev/null',
  "  members=' '",
  '  for i in "${!pids[@]}"; do',
  '    case $targets in *" ${pgids[i]} "*) members+="${pids[i]} " ;; esac',
  '  done',
  '  changed=1',
  '  while [ "$changed" = 1 ]; do',
  '    changed=0',
  '    for i in "${!pids[@]}"; do',
  '      case $members in',
  '        *" ${pids[i]} "*) ;;',
  '        *" ${parents[i]} "*) members+="${pids[i]} " changed=1 ;;',
  '      esac',
  '    done',
  '  done',
  '  [ "$members" = \' \' ] && exit 0',
  '  windows=() msys=()',
  '  for i in "${!pids[@]}"; do',
  '    case $members in *" ${pids[i]} "*) windows+=(/PID "${winpids[i]}") msys+=("${pids[i]}") ;; esac',
  '  done',
  '  kill -STOP "${msys[@]}" 2>/dev/null',
  '  MSYS2_ARG_CONV_EXCL=\'*\' "$taskkill" /F /T "${windows[@]}" >/dev/null 2>&1',
  '  kill -9 "${msys[@]}" 2>/dev/null',
  'done',
].join('\n');

/**
 * Kills the MSYS processes of commands run in an MSYS/Cygwin shell (Git Bash). When an MSYS
 * process forks and the child execs another program, the new Windows process is parented to a
 * stub that exits, so `taskkill /T` on the shell never reaches it: `sleep 100; echo`, `sh x.sh`,
 * and npm/pnpm (bash scripts in Git Bash) would keep running after a timeout or interrupt. The
 * MSYS runtime still knows these processes, so a bash from the same installation (whose process
 * table it shares) finds and kills them with MSYS_KILL_SCRIPT. Best effort, bounded by
 * MSYS_KILL_TIMEOUT_MS; never rejects.
 */
function killMsysCommands(shell: ShellInfo, commandIds: readonly string[]): Promise<void> {
  const helper = msysHelperShell(shell);
  const { args, options } = msysKillInvocation(helper, commandIds);
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(helper, args, options);
    } catch {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (child.pid !== undefined) void killWindowsTree(child.pid);
      resolve();
    }, MSYS_KILL_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('error', done);
    child.once('exit', done);
  });
}

/** Arguments and spawn options that run MSYS_KILL_SCRIPT in `helper` (see msysHelperShell). */
function msysKillInvocation(helper: string, commandIds: readonly string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === COMMAND_ID_VARIABLE) delete env[name];
  }
  // MSYS and Cygwin accept Windows paths with forward slashes.
  const taskkill = taskkillPath().replace(/\\/g, '/');
  const args = ['-c', MSYS_KILL_SCRIPT, 'patch-kill', taskkill, ...commandIds];
  return {
    args: args.map(quoteMsysArgument),
    options: {
      env,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
      argv0: `"${helper}"`,
    } as const,
  };
}

/**
 * The bash that runs MSYS_KILL_SCRIPT: the shell itself when it is bash, else a bash.exe next to
 * it (MSYS2 and Cygwin install both in usr/bin), else the shell itself (sh is bash there).
 */
function msysHelperShell(shell: ShellInfo): string {
  if (shell.kind === 'bash' || !path.win32.isAbsolute(shell.executable)) return shell.executable;
  const sibling = path.win32.join(path.win32.dirname(shell.executable), 'bash.exe');
  return isFile(sibling) ? sibling : shell.executable;
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}
