import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { codePageDecoder, windowsConsoleCodePage } from '../../src/shell/code-pages.js';
import {
  killAllProcessTreesSync,
  killProcessTree,
  NON_INTERACTIVE_ENV,
  removeStaleScriptFiles,
  runCommand,
  type RunCommandOptions,
} from '../../src/shell/process.js';
import { MSYS_INLINE_COMMAND_LIMIT } from '../../src/shell/invocation.js';
import { detectShell } from '../../src/shell/shell.js';
import { makeTempDir, writeFiles } from '../../src/testing/index.js';
import {
  isPosixShell,
  isProcessAlive,
  isShellProcessAlive,
  node,
  NODE,
  readPid,
  shell,
  waitFor,
} from './helpers.js';

let dir: string;
let cleanup: () => void;

beforeEach(() => {
  ({ dir, cleanup } = makeTempDir('patch-shell-'));
});

afterEach(() => {
  cleanup();
});

function run(command: string, options: Partial<RunCommandOptions> = {}) {
  return runCommand(command, { shell, cwd: dir, timeoutMs: 30_000, ...options });
}

/** Writes a CommonJS script into the temp dir and returns the command that runs it. */
function script(name: string, source: string): string {
  writeFiles(dir, { [name]: source });
  return node(name);
}

describe.runIf(isPosixShell)('runCommand', () => {
  it('captures stdout, stderr and the exit code separately', async () => {
    const result = await run(
      script(
        'streams.cjs',
        `process.stdout.write('to stdout\\n'); process.stderr.write('to stderr\\n'); process.exitCode = 3;`,
      ),
    );
    expect(result).toMatchObject({
      stdout: 'to stdout\n',
      stderr: 'to stderr\n',
      exitCode: 3,
      signal: null,
      timedOut: false,
      aborted: false,
      outputTruncated: false,
    });
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('reports shell-level exit codes without throwing', async () => {
    const result = await run('echo before; exit 7');
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe('before\n');
  });

  it('runs in the given working directory', async () => {
    writeFiles(dir, { 'sub/marker.txt': 'here' });
    const result = await run(`${NODE} -e 'console.log(process.cwd())'`, { cwd: join(dir, 'sub') });
    const expected = join(dir, 'sub');
    const actual = result.stdout.trim();
    if (process.platform === 'win32') expect(actual.toLowerCase()).toBe(expected.toLowerCase());
    else expect(actual).toBe(expected);
  });

  it('applies NON_INTERACTIVE_ENV and lets explicit env override it', async () => {
    const result = await run(
      script(
        'env.cjs',
        `const keys = ['PAGER', 'GIT_PAGER', 'GIT_TERMINAL_PROMPT', 'GIT_EDITOR', 'PATCH_AGENT', 'EXTRA'];
         console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k]]))));`,
      ),
      { env: { EXTRA: 'value with spaces', GIT_PAGER: 'less' } },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      PAGER: NON_INTERACTIVE_ENV.PAGER,
      GIT_PAGER: 'less',
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      PATCH_AGENT: '1',
      EXTRA: 'value with spaces',
    });
  });

  it('passes quotes, backslashes and globs through to the shell unchanged', async () => {
    writeFiles(dir, { 'a.txt': '', 'b.txt': '' });
    const result = await run(
      `printf '%s|' 'a\\\\b' "dq \\"inner\\"" 'it'"'"'s' 'zażółć 日本'; echo; echo *.txt`,
    );
    expect(result.stdout).toBe('a\\\\b|dq "inner"|it\'s|zażółć 日本|\na.txt b.txt\n');
  });

  it('stops a command that exceeds its timeout promptly', async () => {
    const started = Date.now();
    const result = await run(`${NODE} -e 'setTimeout(() => {}, 60000)'`, { timeoutMs: 500 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(400);
  });

  it('kills running commands synchronously when Patch exits abruptly', async () => {
    const pending = run(`${NODE} -e 'setTimeout(() => {}, 60000)'`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const started = Date.now();
    killAllProcessTreesSync();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.exitCode).not.toBe(0);
  });

  // In Git Bash, forked utilities and the programs that scripts start are not Windows
  // descendants of the shell (see the interrupt tests below), so the exit hook must reach them
  // through MSYS as well. The command's script file, if any, holds its text and must go too.
  it.each([
    ['on the command line', ''],
    ['from a script file', `# ${'x'.repeat(MSYS_INLINE_COMMAND_LIMIT)}\n`],
  ])(
    'kills forked utilities and scripts synchronously when Patch exits abruptly (%s)',
    async (_, padding) => {
      const token = `exit-hook-${process.pid}-${Date.now()}`;
      writeFiles(dir, {
        'fakenpm.sh': `#!/bin/sh\n${node('runner.cjs')}\n`,
        'runner.cjs': `const fs = require('fs');
           fs.writeFileSync('runner.pid.tmp', String(process.pid));
           fs.renameSync('runner.pid.tmp', 'runner.pid');
           setTimeout(() => {}, 60000);`,
      });
      const pending = run(
        `${padding}# ${token}\nsh ./fakenpm.sh & ` +
          `sh -c 'echo $$ > sleep.pid.tmp && mv sleep.pid.tmp sleep.pid && exec sleep 300'; echo done`,
      );
      const readPidFile = (name: string) => readPid(() => readFileSync(join(dir, name), 'utf8'));
      await waitFor(
        () => readPidFile('runner.pid') !== undefined && readPidFile('sleep.pid') !== undefined,
        15_000,
      );
      const runner = readPidFile('runner.pid')!;
      const sleeper = readPidFile('sleep.pid')!;
      expect(isProcessAlive(runner)).toBe(true);
      expect(isShellProcessAlive(sleeper)).toBe(true);
      const scriptFiles = () =>
        readdirSync(tmpdir())
          .filter((name) => name.startsWith('patch-command-'))
          .filter((name) => {
            try {
              return readFileSync(join(tmpdir(), name), 'utf8').includes(token);
            } catch {
              return false;
            }
          });
      const usesScriptFile = padding !== '' && process.platform === 'win32';
      expect(scriptFiles()).toHaveLength(usesScriptFile ? 1 : 0);
      expect(process.listeners('exit')).toContain(killAllProcessTreesSync);

      killAllProcessTreesSync();
      expect(scriptFiles()).toEqual([]);
      const result = await pending;
      expect(result.exitCode).not.toBe(0);
      await waitFor(() => !isProcessAlive(runner) && !isShellProcessAlive(sleeper), 3_000);
    },
  );

  it('stops a command when the signal aborts and keeps the output so far', async () => {
    const controller = new AbortController();
    const chunks: string[] = [];
    const command = script(
      'slow.cjs',
      `console.log('started'); setTimeout(() => console.log('never'), 60000);`,
    );
    const pending = run(command, {
      signal: controller.signal,
      onOutput: (chunk) => {
        chunks.push(chunk);
        controller.abort();
      },
    });
    const started = Date.now();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(chunks.join('')).toBe('started\n');
    expect(result).toMatchObject({ aborted: true, timedOut: false, exitCode: null });
    expect(result.stdout).toBe('started\n');
  });

  it('does not start the command when the signal is already aborted', async () => {
    writeFiles(dir, { 'marker.cjs': `require('fs').writeFileSync('ran.txt', 'yes');` });
    const controller = new AbortController();
    controller.abort();
    const result = await run(node('marker.cjs'), { signal: controller.signal });
    expect(result).toMatchObject({ aborted: true, exitCode: null, stdout: '', durationMs: 0 });
    expect(() => readFileSync(join(dir, 'ran.txt'))).toThrow();
  });

  it('kills the whole process tree, including grandchildren holding the output pipes', async () => {
    const command = script(
      'parent.cjs',
      `const { spawn } = require('child_process');
       const fs = require('fs');
       const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });
       // Output first: the test stops the tree as soon as the pid file appears.
       process.stdout.write('ready\\n', () => {
         fs.writeFileSync('grandchild.pid.tmp', String(child.pid));
         fs.renameSync('grandchild.pid.tmp', 'grandchild.pid');
       });
       setTimeout(() => {}, 60000);`,
    );
    const controller = new AbortController();
    const pending = run(command, { signal: controller.signal });
    let grandchild: number | undefined;
    await waitFor(() => {
      grandchild = readPid(() => readFileSync(join(dir, 'grandchild.pid'), 'utf8'));
      return grandchild !== undefined;
    }, 10_000);
    expect(isProcessAlive(grandchild!)).toBe(true);

    const started = Date.now();
    controller.abort();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(result.aborted).toBe(true);
    expect(result.stdout).toBe('ready\n');
    // Gone, or a zombie its new parent has not reaped yet (isProcessAlive counts those as gone).
    await waitFor(() => !isProcessAlive(grandchild!), 5_000);
  });

  // In Git Bash, processes the shell forks and that exec another program (MSYS `sleep`, scripts,
  // npm and pnpm, which are bash scripts there) are not Windows descendants of the shell, so
  // `taskkill /T` alone misses them and their open pipes delay the result by the kill grace.
  it.each([
    ['on the command line', ''],
    ['from a script file', `# ${'x'.repeat(MSYS_INLINE_COMMAND_LIMIT)}\n`],
  ])(
    'stops processes started through shell scripts, including their native children (%s)',
    async (_, padding) => {
      writeFiles(dir, {
        // Like npm: a shell script that runs node, which runs the actual server as a child.
        'fakenpm.sh': `#!/bin/sh\n${node('runner.cjs')}\n`,
        'runner.cjs': `const { spawn } = require('child_process');
           const fs = require('fs');
           fs.writeFileSync('runner.pid.tmp', String(process.pid));
           fs.renameSync('runner.pid.tmp', 'runner.pid');
           spawn(process.execPath, ['server.cjs'], { stdio: 'inherit' });
           setTimeout(() => {}, 60000);`,
        // Output first: the test stops the tree as soon as both pid files appear.
        'server.cjs': `const fs = require('fs');
           process.stdout.write('ready\\n', () => {
             fs.writeFileSync('server.pid.tmp', String(process.pid));
             fs.renameSync('server.pid.tmp', 'server.pid');
           });
           setTimeout(() => {}, 60000);`,
      });
      const controller = new AbortController();
      const pending = run(`${padding}sh ./fakenpm.sh; echo done`, { signal: controller.signal });
      const readPidFile = (name: string) => readPid(() => readFileSync(join(dir, name), 'utf8'));
      await waitFor(
        () => readPidFile('runner.pid') !== undefined && readPidFile('server.pid') !== undefined,
        15_000,
      );
      const runner = readPidFile('runner.pid')!;
      const server = readPidFile('server.pid')!;

      const started = Date.now();
      controller.abort();
      const result = await pending;
      // Under the 5 s kill grace (a busy machine slows the kill itself): nothing kept the pipes open.
      expect(Date.now() - started).toBeLessThan(4_500);
      expect(result).toMatchObject({ aborted: true, exitCode: null, stdout: 'ready\n' });
      await waitFor(() => !isProcessAlive(runner) && !isProcessAlive(server), 5_000);
    },
  );

  it('stops forked shell utilities promptly at the timeout', async () => {
    const started = Date.now();
    const result = await run('echo started; sleep 30; echo never', { timeoutMs: 1_000 });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(result).toMatchObject({ timedOut: true, exitCode: null, stdout: 'started\n' });
  });

  it('runs commands longer than the Git Bash command-line limit in full', async () => {
    // Git Bash silently cuts a command-line argument after ~8,190 characters.
    const token = `token-${process.pid}-${Date.now()}`;
    const lines = Array.from(
      { length: 300 },
      (_, i) => `line ${i} zażółć 日本 🎉 ${'x'.repeat(20)}`,
    );
    const command = [
      `cat > out.txt <<'EOF'`,
      ...lines,
      'EOF',
      `echo "${token}"`,
      'read -r input || echo "stdin closed"',
      'echo "$((6 * 7))"',
      'exit 5',
    ].join('\n');
    expect(command.length).toBeGreaterThan(10_000);

    const result = await run(command);
    expect(result).toMatchObject({ exitCode: 5, stdout: `${token}\nstdin closed\n42\n` });
    expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe(`${lines.join('\n')}\n`);
    // A script file used to pass the command is deleted afterwards.
    const leftovers = readdirSync(tmpdir())
      .filter((name) => name.startsWith('patch-command-'))
      .filter((name) => {
        try {
          return readFileSync(join(tmpdir(), name), 'utf8').includes(token);
        } catch {
          return false;
        }
      });
    expect(leftovers).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a command longer than the OS allows on a command line with a clear error',
    async () => {
      await expect(run(`echo ${'x'.repeat(2_000_000)}`)).rejects.toThrow(
        /the command \(2,000,005 characters\) is longer than the operating system allows/,
      );
    },
  );

  it('returns soon after the shell exits even if a background process keeps the pipes open', async () => {
    writeFiles(dir, {
      'background.cjs': `require('fs').writeFileSync('background.pid', String(process.pid)); setTimeout(() => {}, 30000);`,
    });
    const started = Date.now();
    const result = await run(`${node('background.cjs')} & echo started`);
    let background: number | undefined;
    try {
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('started\n');
      await waitFor(() => {
        background = readPid(() => readFileSync(join(dir, 'background.pid'), 'utf8'));
        return background !== undefined;
      });
    } finally {
      if (background !== undefined) await killProcessTree(background);
    }
  });

  it('truncates very large output, keeping the head, the tail and an explicit marker', async () => {
    const lineCount = 100_000;
    const command = script(
      'flood.cjs',
      `const lines = [];
       for (let i = 0; i < ${lineCount}; i++) lines.push('line ' + i + ' ' + 'x'.repeat(20));
       process.stdout.write(lines.join('\\n') + '\\n');`,
    );
    const maxBufferBytes = 64 * 1024;
    const result = await run(command, { maxBufferBytes });
    const totalBytes = Array.from(
      { length: lineCount },
      (_, i) => `line ${i} ${'x'.repeat(20)}\n`.length,
    ).reduce((sum, n) => sum + n, 0);

    expect(result.outputTruncated).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.startsWith(`line 0 ${'x'.repeat(20)}\n`)).toBe(true);
    expect(result.stdout.endsWith(`line ${lineCount - 1} ${'x'.repeat(20)}\n`)).toBe(true);
    const marker = /\n\.\.\. ([\d,]+) bytes omitted \.\.\.\n/.exec(result.stdout);
    expect(marker).not.toBeNull();
    const omitted = Number(marker![1]!.replace(/,/g, ''));
    const kept = Buffer.byteLength(result.stdout) - Buffer.byteLength(marker![0]) + 1;
    expect(kept + omitted).toBe(totalBytes);
    expect(kept).toBeLessThanOrEqual(maxBufferBytes);
    // Cuts happen on line boundaries.
    for (const line of result.stdout.split('\n').filter((l) => l && !l.startsWith('...'))) {
      expect(line).toMatch(/^line \d+ x{20}$/);
    }
  });

  it('decodes multi-byte UTF-8 characters split across chunks', async () => {
    const text = 'zażółć gęślą jaźń 日本語 🎉\n';
    const command = script(
      'utf8.cjs',
      `const bytes = Buffer.from(${JSON.stringify(text)});
       let i = 0;
       const next = () => {
         if (i >= bytes.length) return;
         process.stdout.write(bytes.subarray(i, i + 1), () => setTimeout(next, 3));
         i++;
       };
       next();`,
    );
    const chunks: string[] = [];
    const result = await run(command, { onOutput: (chunk) => chunks.push(chunk) });
    expect(result.stdout).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
    expect(chunks.some((chunk) => chunk.includes('\uFFFD'))).toBe(false);
  });

  it('strips ANSI escape sequences, including ones split across chunks', async () => {
    const command = script(
      'ansi.cjs',
      `const parts = ['\\u001b[31mred\\u001b[0m \\u001b]8;;https://example.com\\u001b\\\\link\\u001b]8;;\\u001b\\\\\\n',
                      '\\u001b[3', '2mgreen\\u001b[0', 'm\\n', '\\u001b]0;title\\u0007plain\\n'];
       let i = 0;
       const next = () => { if (i < parts.length) process.stdout.write(parts[i++], () => setTimeout(next, 10)); };
       next();`,
    );
    const chunks: string[] = [];
    const result = await run(command, { onOutput: (chunk) => chunks.push(chunk) });
    expect(result.stdout).toBe('red link\ngreen\nplain\n');
    expect(chunks.join('')).toBe('red link\ngreen\nplain\n');
  });

  it('collapses carriage-return progress updates and normalizes CRLF', async () => {
    const command = script(
      'progress.cjs',
      `const parts = ['progress 10%', '\\rprogress 50%', '\\rprogress 100%\\n', 'done\\r\\n', 'crlf\\r', '\\nend\\r'];
       let i = 0;
       const next = () => { if (i < parts.length) process.stdout.write(parts[i++], () => setTimeout(next, 10)); };
       next();`,
    );
    const chunks: string[] = [];
    const result = await run(command, { onOutput: (chunk) => chunks.push(chunk) });
    expect(result.stdout).toBe('progress 100%\ndone\ncrlf\nend');
    // Live consumers still see the raw carriage returns.
    expect(chunks.join('')).toContain('\rprogress 50%');
  });

  it('tags live output by stream and ignores observers that throw', async () => {
    const seen: Array<[string, string]> = [];
    const result = await run('echo out; echo err >&2', {
      onOutput: (chunk, stream) => {
        seen.push([stream, chunk]);
        throw new Error('observer bug');
      },
    });
    expect(result.stdout).toBe('out\n');
    expect(result.stderr).toBe('err\n');
    expect(seen).toContainEqual(['stdout', 'out\n']);
    expect(seen).toContainEqual(['stderr', 'err\n']);
  });

  it('rejects with a clear error when the shell executable does not exist', async () => {
    const missing = join(dir, 'no-such-shell', process.platform === 'win32' ? 'bash.exe' : 'bash');
    await expect(run('echo hi', { shell: { ...shell, executable: missing } })).rejects.toThrow(
      `Could not start shell ${missing}: ENOENT`,
    );
  });

  it('rejects with a clear error when the working directory does not exist', async () => {
    const missing = join(dir, 'gone');
    await expect(run('echo hi', { cwd: missing })).rejects.toThrow(
      `working directory ${missing} does not exist`,
    );
  });
});

describe.runIf(process.platform === 'win32')('runCommand with Windows shells', () => {
  const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const powershell = detectShell({
    configured: join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  });
  const cmd = detectShell({ configured: join(system32, 'cmd.exe') });
  const text = 'zażółć gęślą 日本';

  it('decodes PowerShell output and the output of programs it runs as UTF-8', async () => {
    writeFiles(dir, { [`${text}/file.txt`]: '' });
    const result = await run(
      `Write-Output '${text}'; Get-ChildItem -Name; cmd /d /c echo ${text}; exit 3`,
      { shell: powershell },
    );
    expect(result.stdout).toBe(`${text}\n${text}\n${text}\n`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(3);
  });

  it('reports PowerShell errors with positions in the command', async () => {
    const result = await run(`Get-Item 'missing-${text}'`, { shell: powershell });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`missing-${text}`);
    expect(result.stderr).toContain(`+ Get-Item 'missing-${text}'`);
  });

  it('runs PowerShell commands that start with using statements or a param block', async () => {
    // The non-ASCII output shows that the UTF-8 setup still ran, after the preamble.
    const usingLine = await run(
      `using namespace System.Text\n[StringBuilder]::new('${text}').ToString()`,
      { shell: powershell },
    );
    expect(usingLine).toMatchObject({ stdout: `${text}\n`, stderr: '', exitCode: 0 });
    const sameLine = await run(
      `using namespace System.IO; [Path]::GetFileName('C:/a/${text}.txt')`,
      { shell: powershell },
    );
    expect(sameLine).toMatchObject({ stdout: `${text}.txt\n`, stderr: '', exitCode: 0 });
    // The command is still the script itself, so a failing last command fails the script.
    const param = await run(
      `[CmdletBinding()]\nparam([string]$Name = '${text}')\n"hi $Name"; cmd /c exit 3`,
      { shell: powershell },
    );
    expect(param).toMatchObject({ stdout: `hi ${text}\n`, stderr: '', exitCode: 1 });
  });

  describe('with cmd', () => {
    /** Letters of the console's code page, and how to encode text in it. */
    let oem: { letters: string; encode: (text: string) => Buffer } | undefined;

    beforeAll(async () => {
      const codePage = await windowsConsoleCodePage();
      const decode = codePage === undefined ? undefined : codePageDecoder(codePage);
      if (!decode) return;
      const bytes = new Map<string, number>();
      for (let byte = 0x80; byte <= 0xff; byte++) {
        const char = decode(Buffer.from([byte]));
        if (/^\p{Ll}$/u.test(char)) bytes.set(char, byte);
      }
      if (bytes.size < 3) return;
      const letters = [...bytes.keys()].slice(0, 6).join('');
      const encode = (value: string) =>
        Buffer.from([...value].map((char) => bytes.get(char) ?? char.charCodeAt(0)));
      oem = { letters, encode };
    });

    it('decodes the console code page that cmd and the programs it starts write', async (ctx) => {
      if (!oem) return ctx.skip();
      writeFiles(dir, { [`${oem.letters}.txt`]: '' });
      // Built-ins and nested cmd write the console code page, node writes UTF-8.
      const result = await run(
        `echo ${oem.letters}& dir /b *.txt& cmd /d /c echo ${oem.letters}& ` +
          `"${process.execPath}" -e "console.log('${text}')"& exit /b 4`,
        { shell: cmd },
      );
      expect(result).toMatchObject({
        stdout: `${oem.letters}\n${oem.letters}.txt\n${oem.letters}\n${text}\n`,
        stderr: '',
        exitCode: 4,
      });
    });

    it('runs batch files saved in the console code page', async (ctx) => {
      if (!oem) return ctx.skip();
      mkdirSync(join(dir, oem.letters));
      // cmd decodes a batch file's first line before it notices a code page change, so the
      // lines that matter come later.
      writeFileSync(
        join(dir, 'build.bat'),
        Buffer.concat([
          Buffer.from('@echo off\r\necho '),
          oem.encode(oem.letters),
          Buffer.from('\r\ncd /d "'),
          oem.encode(oem.letters),
          Buffer.from('" || exit /b 1\r\necho IN %CD%\r\n'),
        ]),
      );
      const result = await run('.\\build.bat', { shell: cmd });
      expect(result).toMatchObject({
        stdout: `${oem.letters}\nIN ${join(dir, oem.letters)}\n`,
        stderr: '',
        exitCode: 0,
      });
    });

    it('runs nothing from the working directory before the command', async () => {
      // cmd looks programs up in the working directory first unless this variable is set.
      const saved = process.env.NoDefaultCurrentDirectoryInExePath;
      delete process.env.NoDefaultCurrentDirectoryInExePath;
      try {
        writeFiles(dir, {
          'chcp.bat': '@echo HIJACKED 1>&2\r\n',
          'chcp.cmd': '@echo HIJACKED\r\n',
        });
        const result = await run('echo hi& dir /b chcp.*', { shell: cmd });
        expect(result).toMatchObject({
          stdout: 'hi\nchcp.bat\nchcp.cmd\n',
          stderr: '',
          exitCode: 0,
        });
      } finally {
        if (saved !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = saved;
      }
    });
  });

  it('rejects a command longer than the Windows command line allows with a clear error', async () => {
    await expect(
      run(`Write-Output '${'x'.repeat(40_000)}'`, { shell: powershell }),
    ).rejects.toThrow(/longer than the operating system allows on a command line \(ENAMETOOLONG\)/);
  });
});

describe('removeStaleScriptFiles', () => {
  it('deletes script files left by processes that are gone and keeps all others', async () => {
    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    await new Promise((resolve) => exited.once('exit', resolve));
    const files = {
      gone: `patch-command-${exited.pid}-${randomUUID()}.sh`,
      own: `patch-command-${process.pid}-${randomUUID()}.sh`,
      running: `patch-command-${process.ppid}-${randomUUID()}.sh`,
      unownedOld: `patch-command-${randomUUID()}.sh`,
      unownedRecent: `patch-command-${randomUUID()}.sh`,
      unrelated: `patch-command-${exited.pid}.txt`,
    };
    writeFiles(dir, Object.fromEntries(Object.values(files).map((name) => [name, 'echo $TOKEN'])));
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    utimesSync(join(dir, files.unownedOld), twoDaysAgo, twoDaysAgo);

    const removed = await removeStaleScriptFiles(dir);
    expect(removed.sort()).toEqual([files.gone, files.unownedOld].sort());
    expect(readdirSync(dir).sort()).toEqual(
      [files.own, files.running, files.unownedRecent, files.unrelated].sort(),
    );
  });

  it('never throws for a directory it cannot read', async () => {
    await expect(removeStaleScriptFiles(join(dir, 'missing'))).resolves.toEqual([]);
  });
});

describe('killProcessTree', () => {
  it('kills a process and its descendants', async () => {
    const { dir: temp, cleanup: remove } = makeTempDir('patch-kill-');
    try {
      const source = `const { spawn } = require('child_process');
        const fs = require('fs');
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
        fs.writeFileSync('child.pid.tmp', String(child.pid));
        fs.renameSync('child.pid.tmp', 'child.pid');
        setTimeout(() => {}, 60000);`;
      writeFiles(temp, { 'tree.cjs': source });
      const parent = spawn(process.execPath, ['tree.cjs'], {
        cwd: temp,
        stdio: 'ignore',
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      let child: number | undefined;
      await waitFor(() => {
        child = readPid(() => readFileSync(join(temp, 'child.pid'), 'utf8'));
        return child !== undefined;
      }, 10_000);

      await killProcessTree(parent.pid!);
      await waitFor(() => !isProcessAlive(parent.pid!) && !isProcessAlive(child!), 5_000);
    } finally {
      remove();
    }
  });

  it('never throws for a process that no longer exists', async () => {
    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    await new Promise((resolve) => exited.once('exit', resolve));
    await expect(killProcessTree(exited.pid!)).resolves.toBeUndefined();
  });
});
