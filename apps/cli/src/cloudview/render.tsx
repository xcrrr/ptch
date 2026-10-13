import { render } from 'ink';
import type { SecretStore } from '../cloud/secrets.js';
import { emptyComposer, type ComposerState } from '../ui/composer-state.js';
import { createBackend, type CloudBackend } from './backend.js';
import { CloudApp } from './CloudApp.js';
import { CloudViewController, type CloudViewOptions } from './controller.js';

const CLEAR_SCREEN =
  process.platform === 'win32' ? '\u001B[2J\u001B[0f' : '\u001B[2J\u001B[3J\u001B[H';

/**
 * Starts on an empty screen without destroying anything: scrolls what is on screen (the shell
 * prompt, earlier commands) up into the terminal's scrollback and moves to the top-left corner.
 */
function takeOverScreen(stdout: NodeJS.WriteStream): void {
  const rows = typeof stdout.rows === 'number' && stdout.rows > 0 ? stdout.rows : 24;
  stdout.write('\n'.repeat(rows) + '\u001B[H');
}

export interface CloudViewIO {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  env: NodeJS.ProcessEnv;
  cwd: string;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  /** Test hooks. */
  secretStore?: SecretStore;
  openBrowser?: (url: string) => Promise<void>;
  backend?: CloudBackend;
  /** Route console output through Ink (default true). */
  patchConsole?: boolean;
  /** Milliseconds between polls (default 2000). */
  pollMs?: number;
}

/**
 * Runs the cloud view until the user leaves: the conversation of Patch HQ in the terminal. The
 * Ink tree is mounted again on a cleared screen for /new and /resume; the prompt being edited
 * carries over. Returns the exit code.
 */
export async function runCloudView(
  options: Pick<CloudViewOptions, 'resume' | 'initialPrompt'>,
  io: CloudViewIO,
): Promise<number> {
  const backend =
    io.backend ??
    createBackend({
      env: io.env,
      cwd: io.cwd,
      ...(io.homeDir ? { homeDir: io.homeDir } : {}),
      ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
      ...(io.secretStore ? { secretStore: io.secretStore } : {}),
      ...(io.openBrowser ? { openBrowser: io.openBrowser } : {}),
    });
  const controller = new CloudViewController(backend, {
    ...options,
    ...(io.pollMs ? { pollMs: io.pollMs } : {}),
  });
  const onTerminate = (): void => controller.requestExit();
  process.on('SIGTERM', onTerminate);
  process.on('SIGHUP', onTerminate);

  const stdout = io.stdout;
  const fullScreen = stdout.isTTY === true;
  if (fullScreen) takeOverScreen(stdout);

  let composer: ComposerState = emptyComposer;
  let started = false;
  for (;;) {
    let remount = false;
    const instance = render(
      <CloudApp
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
        stdin: io.stdin,
        stderr: io.stderr,
        exitOnCtrlC: false,
        patchConsole: io.patchConsole ?? true,
        maxFps: 30,
      },
    );
    if (!started) {
      started = true;
      controller.perform(controller.start());
    }
    await instance.waitUntilExit();
    instance.cleanup();
    if (!remount || controller.getState().exiting) break;
    stdout.write(CLEAR_SCREEN);
  }
  controller.close();
  process.off('SIGTERM', onTerminate);
  process.off('SIGHUP', onTerminate);
  io.stdin.pause();
  io.stdin.unref?.();

  const conversation = controller.getState().conversation;
  if (conversation && conversation.messageCount > 0) {
    stdout.write(`\nResume this conversation with: ptch --resume ${conversation.id}\n`);
  }
  return 0;
}
