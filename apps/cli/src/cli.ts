import { rmSync } from 'node:fs';
import { chalkStderr } from 'chalk';
import {
  PATCH_VERSION,
  PROJECT_MCP_FILE,
  describeError,
  type Logger,
  type ResolvedConfig,
} from '@patch/core';
import { shortId, type ModelProvider } from '@patch/shared';
import { HELP_TEXT, UsageError, parseArgs, type CliArgs } from './args.js';
import { tildify } from './format.js';
import {
  EXIT_FAILURE,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_USAGE,
  combinePrompt,
  expandPrintPrompt,
  readPipedStdin,
  runPrint,
} from './print.js';
import type { CloudViewIO } from './cloudview/render.js';
import { Runtime, type SessionHandle } from './runtime.js';
import { samePath } from './working-directory.js';

export interface CliIO {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Test hooks. */
  providerFactory?: (config: ResolvedConfig, logger: Logger) => ModelProvider;
  assumeCredentials?: boolean;
  homeDir?: string;
  /** Test hooks for the cloud view (fetch, keystore, browser, polling interval, backend). */
  cloudView?: Partial<CloudViewIO>;
}

function defaultIO(): CliIO {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
  };
}

type StartupNotice = { level: 'info' | 'warn' | 'error'; text: string; hint?: string };

interface SessionChoice {
  handle: SessionHandle;
  resumed: boolean;
  notices: StartupNotice[];
}

/**
 * Removes a session file that never received a message (keeps ~/.patch/sessions tidy). Only for
 * a session nothing writes to any more: a later append would recreate the file without its
 * metadata line, and such a file can never be loaded.
 */
function discardIfEmpty(handle: SessionHandle, logger: Logger): void {
  if (handle.session.hasMessages()) return;
  try {
    rmSync(handle.session.filePath, { force: true });
  } catch (error) {
    logger.debug('could not remove empty session file', error);
  }
}

/** On exit: stops writes to the session and releases its lock, then discards it if empty. */
function finishSession(handle: SessionHandle, logger: Logger): void {
  handle.session.close();
  discardIfEmpty(handle, logger);
}

async function chooseSession(
  runtime: Runtime,
  args: CliArgs,
  io: CliIO,
): Promise<SessionChoice | { exitCode: number }> {
  const notices: StartupNotice[] = [];
  const override = runtime.resumeModelOverride();

  if (args.continue) {
    const recent = runtime.store.list({ projectRoot: runtime.workspace.projectRoot, limit: 20 });
    // A session another Patch process is writing cannot be shared; continue the newest free one.
    const busy = recent.filter((s) => runtime.store.isOpenElsewhere(s.id));
    const latest = recent.find((s) => !busy.includes(s));
    if (busy.length > 0 && busy[0] === recent[0]) {
      notices.push({
        level: 'info',
        text: `The most recent session (${shortId(busy[0].id)}) is open in another Patch process${latest ? `; continuing ${shortId(latest.id)} instead` : ''}.`,
      });
    }
    if (latest) {
      const loaded = runtime.resolveSession(latest.id);
      if (loaded.ok) {
        return { handle: runtime.openSession(loaded.session, override), resumed: true, notices };
      }
      notices.push({ level: 'warn', text: loaded.message });
    } else if (recent.length > 0) {
      notices.push({ level: 'info', text: 'Starting a new session.' });
    } else {
      notices.push({
        level: 'info',
        text: 'No previous session in this project. Starting a new one.',
      });
    }
    return { handle: await runtime.newSession(), resumed: false, notices };
  }

  if (args.resume) {
    let id = args.resumeId;
    if (!id) {
      const sessions = runtime.store.list({
        projectRoot: runtime.workspace.projectRoot,
        limit: 30,
      });
      if (sessions.length === 0) {
        notices.push({
          level: 'info',
          text: 'No previous sessions in this project. Starting a new one.',
        });
        return { handle: await runtime.newSession(), resumed: false, notices };
      }
      const { pickSession } = await import('./app/pick-session.js');
      const picked = await pickSession(
        sessions,
        tildify(runtime.workspace.projectRoot, runtime.workspace.home),
        io.stdout,
        io.stdin,
      );
      if (!picked) return { exitCode: EXIT_OK };
      id = picked;
    }
    const loaded = runtime.resolveSession(id);
    if (!loaded.ok) {
      io.stderr.write(`${loaded.message}\nRun "ptch --resume" to choose from recent sessions.\n`);
      return { exitCode: EXIT_FAILURE };
    }
    return { handle: runtime.openSession(loaded.session, override), resumed: true, notices };
  }

  return { handle: await runtime.newSession(), resumed: false, notices };
}

/**
 * The session to run, in the permission mode the flags ask for: `--plan` starts in plan mode,
 * `--auto` in auto mode (the flag is the confirmation), resumed sessions included; otherwise
 * every session starts in the default mode.
 */
async function startSession(
  runtime: Runtime,
  args: CliArgs,
  io: CliIO,
): Promise<SessionChoice | { exitCode: number }> {
  const choice = await chooseSession(runtime, args, io);
  if ('exitCode' in choice) return choice;
  if (args.plan) choice.handle.permissions.setMode('plan');
  else if (args.auto) choice.handle.permissions.setMode('auto');
  return choice;
}

/** Entry point. Returns the process exit code; never throws. */
export async function runCli(
  argv: readonly string[],
  partialIO: Partial<CliIO> = {},
): Promise<number> {
  const io: CliIO = { ...defaultIO(), ...partialIO };

  // `ptch cloud ...` talks to a Patch Cloud host; it never starts the local agent.
  // `ptch login`, `ptch logout` and `ptch whoami` are shortcuts for the account commands.
  const accountCommand = argv[0] === 'login' || argv[0] === 'logout' || argv[0] === 'whoami';
  if (argv[0] === 'cloud' || (accountCommand && argv.length <= 4)) {
    const { runCloud } = await import('./cloud/commands.js');
    const controller = new AbortController();
    const interrupt = (): void => controller.abort();
    process.once('SIGINT', interrupt);
    try {
      return await runCloud([...(argv[0] === 'cloud' ? argv.slice(1) : argv)], {
        stdin: io.stdin,
        stdout: io.stdout,
        stderr: io.stderr,
        env: io.env,
        cwd: io.cwd,
        ...(io.homeDir ? { homeDir: io.homeDir } : {}),
        signal: controller.signal,
      });
    } finally {
      process.off('SIGINT', interrupt);
    }
  }

  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
  if (args.help) {
    io.stdout.write(`${HELP_TEXT}\n`);
    return EXIT_OK;
  }
  if (args.version) {
    io.stdout.write(`${PATCH_VERSION}\n`);
    return EXIT_OK;
  }

  // Patch runs in Patch Cloud: an interactive `ptch` opens the cloud view. The local agent UI
  // is switched off in this beta; PATCH_ENABLE_LOCAL=1 is the developers' way back to it. Print
  // mode (-p) is not affected: it is how Patch Cloud runs the agent inside its task containers.
  const localEnabled = io.env.PATCH_ENABLE_LOCAL === '1';
  if (!args.print && !localEnabled) {
    if (args.local) {
      io.stderr.write(
        'Local mode is disabled in this beta: Patch runs in Patch Cloud. Run "ptch" to open it.\n',
      );
      return EXIT_USAGE;
    }
    if (!(io.stdin.isTTY && io.stdout.isTTY)) {
      const { CLOUD_HELP } = await import('./cloud/commands.js');
      io.stderr.write(
        `Patch Cloud opens in an interactive terminal. In scripts, use the ptch cloud commands:\n\n${CLOUD_HELP}\n`,
      );
      return EXIT_USAGE;
    }
    const { runCloudView } = await import('./cloudview/render.js');
    return runCloudView(
      {
        ...(args.prompt ? { initialPrompt: args.prompt } : {}),
        ...(args.resume
          ? { resume: args.resumeId ? { id: args.resumeId } : ('pick' as const) }
          : args.continue
            ? { resume: 'latest' as const }
            : {}),
      },
      {
        stdin: io.stdin,
        stdout: io.stdout,
        stderr: io.stderr,
        env: io.env,
        cwd: io.cwd,
        ...(io.homeDir ? { homeDir: io.homeDir } : {}),
        ...io.cloudView,
      },
    );
  }

  if (!args.print && !(io.stdin.isTTY && io.stdout.isTTY)) {
    io.stderr.write(
      'Patch needs an interactive terminal. For scripts and pipes use: ptch -p "<prompt>"\n',
    );
    return EXIT_USAGE;
  }

  let runtime: Runtime;
  try {
    runtime = await Runtime.create({
      cwd: io.cwd,
      env: io.env,
      args,
      homeDir: io.homeDir,
      providerFactory: io.providerFactory,
      assumeCredentials: io.assumeCredentials,
    });
  } catch (error) {
    const friendly = describeError(error);
    io.stderr.write(`Patch could not start: ${friendly.title}\n${friendly.hint ?? ''}\n`);
    return EXIT_FAILURE;
  }

  try {
    if (args.print) return await runPrintMode(runtime, args, io);
    return await runInteractiveMode(runtime, args, io);
  } finally {
    // MCP servers are child processes (or open sessions): stop them before Patch exits.
    await runtime.close();
  }
}

async function runPrintMode(runtime: Runtime, args: CliArgs, io: CliIO): Promise<number> {
  // `ptch -p "/review src/auth"` runs a custom command, as typing it interactively would.
  const expanded = args.prompt === undefined ? undefined : expandPrintPrompt(runtime, args.prompt);
  const prompt = combinePrompt(expanded?.prompt, await readPipedStdin(io.stdin));
  if (!prompt) {
    io.stderr.write('No prompt given. Usage: ptch -p "<prompt>" (or pipe text into ptch -p)\n');
    return EXIT_USAGE;
  }
  for (const warning of [...runtime.config.warnings, ...(expanded?.warnings ?? [])]) {
    io.stderr.write(`${warning}\n`);
  }
  if (expanded?.command) {
    io.stderr.write(
      `${chalkStderr.dim(`/${expanded.command.name} · ${expanded.command.source}`)}\n`,
    );
  }

  const choice = await startSession(runtime, args, io);
  if ('exitCode' in choice) return choice.exitCode;
  const directory = choice.resumed ? runtime.directoryNotice(choice.handle.session) : undefined;
  for (const notice of [...choice.notices, ...(directory ? [directory] : [])]) {
    io.stderr.write(`${notice.text}\n`);
  }

  const abort = new AbortController();
  const stop = stopOnSignals(abort, io.stderr);
  try {
    // Without credentials runPrint stops at once; no server needs to start for that.
    if (runtime.hasCredentials) await startMcpForPrint(runtime, io.stderr, abort.signal);
    if (abort.signal.aborted) {
      io.stderr.write('Interrupted.\n');
      return EXIT_INTERRUPTED;
    }
    return await runPrint(runtime, choice.handle, {
      prompt,
      // Input piped next to a prompt is content (a diff, a log): mentions in it attach nothing.
      // A custom command's mentions count, as in an interactive session.
      mentionsFrom: expanded?.prompt ?? prompt,
      outputFormat: args.outputFormat,
      stdout: io.stdout,
      stderr: io.stderr,
      signal: abort.signal,
      sessionStart: choice.resumed ? 'resume' : 'startup',
    });
  } finally {
    stop();
    finishSession(choice.handle, runtime.logger);
  }
}

/**
 * Print mode never prompts: project MCP servers (.mcp.json) that were not approved for good in an
 * interactive session are skipped, with a notice on stderr. The others start before the prompt
 * is sent; servers that fail are reported and left out.
 */
async function startMcpForPrint(
  runtime: Runtime,
  stderr: NodeJS.WritableStream,
  signal: AbortSignal,
): Promise<void> {
  if (!runtime.mcp.configured) return;
  const color = chalkStderr;
  const pending = runtime.mcp.pendingApprovals();
  if (pending.length > 0) {
    runtime.mcp.skip(pending, `not approved (from ${PROJECT_MCP_FILE})`);
    for (const server of pending) {
      stderr.write(
        `${color.yellow(`Skipping the MCP server "${server.name}" from ${PROJECT_MCP_FILE}: it is not approved for this project.`)}\n`,
      );
    }
    stderr.write(`${color.dim('  Start ptch interactively in this project to approve it.')}\n`);
  }
  for (const notice of await runtime.startMcp(signal)) {
    stderr.write(`${color.yellow(notice.text)}\n`);
  }
}

/** Signals that end print mode: Ctrl+C, `kill`/`timeout`/CI cancellation, a closed terminal. */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
/** After a second signal, how long running commands get to stop before Patch exits anyway. */
const FORCED_EXIT_GRACE_MS = 3_000;

/**
 * Turns the stop signals into an abort of the running turn. Commands run in their own process
 * group on POSIX, so neither terminal signals nor Patch's exit reach them: only the abort (which
 * sends SIGTERM, then SIGKILL, to the group) stops them. So the first signal aborts; a second one
 * exits once that termination has had time to finish; a third exits at once. Returns a function
 * that removes the handlers.
 */
function stopOnSignals(abort: AbortController, stderr: NodeJS.WritableStream): () => void {
  let received = 0;
  let forcedExit: NodeJS.Timeout | undefined;
  const onSignal = () => {
    received += 1;
    if (received === 1) {
      abort.abort();
      return;
    }
    if (received === 2) {
      stderr.write('Stopping running commands. Press Ctrl+C again to exit now.\n');
      forcedExit = setTimeout(() => process.exit(EXIT_INTERRUPTED), FORCED_EXIT_GRACE_MS);
      forcedExit.unref();
      return;
    }
    process.exit(EXIT_INTERRUPTED);
  };
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
  return () => {
    for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
    clearTimeout(forcedExit);
  };
}

async function runInteractiveMode(runtime: Runtime, args: CliArgs, io: CliIO): Promise<number> {
  const choice = await startSession(runtime, args, io);
  if ('exitCode' in choice) return choice.exitCode;

  const startupNotices: StartupNotice[] = [
    ...runtime.config.warnings.map((text): StartupNotice => ({ level: 'warn', text })),
    ...choice.notices,
  ];

  const { runInteractive } = await import('./app/render.js');
  let finalHandle: SessionHandle = choice.handle;
  try {
    const code = await runInteractive(runtime, choice.handle, {
      initialPrompt: args.prompt,
      resumed: choice.resumed,
      startupNotices,
      stdout: io.stdout,
      stdin: io.stdin,
      stderr: io.stderr,
      onSessionChange: (handle) => {
        // Never delete the file the new handle is about to use.
        if (!samePath(finalHandle.session.filePath, handle.session.filePath)) {
          discardIfEmpty(finalHandle, runtime.logger);
        }
        finalHandle = handle;
      },
    });
    return code;
  } finally {
    finishSession(finalHandle, runtime.logger);
  }
}

export { EXIT_FAILURE, EXIT_INTERRUPTED, EXIT_OK, EXIT_USAGE };
