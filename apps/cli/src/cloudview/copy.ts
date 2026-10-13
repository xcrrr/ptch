import { spawn } from 'node:child_process';

/** The programs that put text on the clipboard of this platform, in the order to try them. */
function writers(): Array<[string, string[]]> {
  if (process.platform === 'win32') return [['clip', []]];
  if (process.platform === 'darwin') return [['pbcopy', []]];
  return [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ];
}

function run(program: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(program, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 5_000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(text);
  });
}

/** Copies text to the system clipboard. Returns false when no clipboard program works. */
export async function copyText(text: string): Promise<boolean> {
  for (const [program, args] of writers()) {
    if (await run(program, args, text)) return true;
  }
  return false;
}
