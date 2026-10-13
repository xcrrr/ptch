import { render } from 'ink';
import { shortId } from '@patch/shared';
import type { Runtime, SessionHandle } from '../runtime.js';
import { emptyComposer, type ComposerState } from '../ui/composer-state.js';
import { App } from './App.js';
import { AppController, type ControllerOptions } from './controller.js';

const CLEAR_SCREEN =
  process.platform === 'win32' ? '\u001B[2J\u001B[0f' : '\u001B[2J\u001B[3J\u001B[H';

/**
 * Starts Patch on an empty screen without destroying anything: scrolls what is on screen (the
 * shell prompt, earlier commands) up into the terminal's scrollback and moves to the top-left
 * corner, so scrolling up still shows the earlier commands.
 */
function takeOverScreen(stdout: NodeJS.WriteStream): void {
  const rows = typeof stdout.rows === 'number' && stdout.rows > 0 ? stdout.rows : 24;
  stdout.write('\n'.repeat(rows) + '\u001B[H');
}

/**
 * On exit, how long aborted work gets to settle. Covers stopping a command's process tree
 * (SIGTERM, then SIGKILL after 2 s; taskkill on Windows) and the 5 s grace runCommand allows.
 */
const EXIT_SETTLE_MS = 6_000;

async function settleWithin(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface InteractiveOptions extends ControllerOptions {
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  stderr?: NodeJS.WriteStream;
  /** Route console output through Ink (default true; tests whose console cannot be patched turn it off). */
  patchConsole?: boolean;
}

/**
 * Runs the interactive UI until the user exits. The Ink tree is remounted on a cleared screen
 * for /clear, /resume and ctrl+l so the terminal never re-prints stale history; the prompt being
 * edited carries over to the new tree. Returns the exit code.
 */
export async function runInteractive(
  runtime: Runtime,
  handle: SessionHandle,
  options: InteractiveOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const controller = new AppController(runtime, handle, options);
  // Kept until the end: a repeated signal while running work is stopped must not fall through to
  // Node's default (exit at once), which would leave commands' process groups running.
  const onTerminate = () => controller.requestExit();
  process.on('SIGTERM', onTerminate);
  process.on('SIGHUP', onTerminate);

  const fullScreen = stdout.isTTY === true;
  if (fullScreen) takeOverScreen(stdout);

  // The prompt being edited survives a remount (ctrl+l, or text typed while /clear runs).
  let composer: ComposerState = emptyComposer;
  for (;;) {
    let remount = false;
    const instance = render(
      <App
        controller={controller}
        initialComposer={composer}
        splash={fullScreen}
        onRemount={(draft) => {
          remount = true;
          composer = draft;
        }}
      />,
      {
        stdout,
        stdin: options.stdin ?? process.stdin,
        stderr: options.stderr ?? process.stderr,
        exitOnCtrlC: false,
        patchConsole: options.patchConsole ?? true,
        maxFps: 30,
      },
    );
    await instance.waitUntilExit();
    instance.cleanup();
    if (!remount || controller.getState().exiting) break;
    stdout.write(CLEAR_SCREEN);
  }
  // Exiting aborted any running work, but it is still unwinding: an interrupted `!` command, for
  // one, records its output when it ends. Let it finish before the caller checks whether the
  // session is empty (and deletes its file), then stop all further writes.
  await settleWithin(controller.idle(), EXIT_SETTLE_MS);
  controller.close();
  process.off('SIGTERM', onTerminate);
  process.off('SIGHUP', onTerminate);
  const stdin = options.stdin ?? process.stdin;
  stdin.pause();
  stdin.unref?.();

  const session = controller.session;
  if (session.hasMessages()) {
    stdout.write(`\nResume this session with: ptch --resume ${shortId(session.id)}\n`);
  }
  return 0;
}
