import { describe, expect, it } from 'vitest';
import {
  MSYS_INLINE_COMMAND_LIMIT,
  quoteMsysArgument,
  scriptFileOwner,
  shellInvocation,
} from '../../src/shell/invocation.js';
import { detectShell, POWERSHELL_UTF8_SETUP, type ShellInfo } from '../../src/shell/shell.js';

function shellOf(configured: string, platform: NodeJS.Platform): ShellInfo {
  return detectShell({ configured, platform, exists: () => true });
}

describe('shellInvocation', () => {
  const command = `printf '%s' "a\\"b" 'c\\\\d'`;

  it('passes arguments through unchanged on POSIX', () => {
    expect(shellInvocation(shellOf('/bin/bash', 'linux'), command, 'linux')).toEqual({
      args: ['-c', command],
      windowsVerbatimArguments: false,
    });
  });

  it('quotes every argument for the MSYS parser on Windows, including argv0', () => {
    const bash = shellOf('C:\\Program Files\\Git\\bin\\bash.exe', 'win32');
    expect(shellInvocation(bash, command, 'win32')).toEqual({
      args: ['"-c"', `"printf '%s' \\"a\\\\\\"b\\" 'c\\\\\\\\d'"`],
      argv0: '"C:\\Program Files\\Git\\bin\\bash.exe"',
      windowsVerbatimArguments: true,
    });
  });

  it('wraps the command in quotes for cmd /s /c', () => {
    const cmd = shellOf('C:\\Windows\\System32\\cmd.exe', 'win32');
    expect(shellInvocation(cmd, 'echo "a b" & echo c', 'win32')).toEqual({
      args: ['/d', '/s', '/c', '"echo "a b" & echo c"'],
      argv0: '"C:\\Windows\\System32\\cmd.exe"',
      windowsVerbatimArguments: true,
    });
  });

  it("leaves PowerShell arguments to Node's standard Windows quoting", () => {
    const pwsh = shellOf('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32');
    expect(shellInvocation(pwsh, 'Write-Output "hi"', 'win32')).toEqual({
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${POWERSHELL_UTF8_SETUP}\nWrite-Output "hi"`,
      ],
      windowsVerbatimArguments: false,
    });
    // `using` must stay the first statement of the script.
    expect(shellInvocation(pwsh, 'using namespace System.IO\n[Path]::GetTempPath()').args).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `using namespace System.IO\n${POWERSHELL_UTF8_SETUP}\n[Path]::GetTempPath()`,
    ]);
  });
});

describe('scriptFileOwner', () => {
  const uuid = '04d4c29e-5b1f-4c8e-9a43-1f2e3d4c5b6a';

  it('reads the pid of the process that wrote a script file from its name', () => {
    expect(scriptFileOwner(`patch-command-4242-${uuid}.sh`)).toBe(4242);
    // Names from versions that did not record the pid.
    expect(scriptFileOwner(`patch-command-${uuid}.sh`)).toBeNull();
  });

  it('ignores other files', () => {
    for (const name of [
      `patch-command-4242-${uuid}.sh.bak`,
      `patch-command-abc-${uuid}.sh`,
      'patch-command-4242.sh',
      `other-4242-${uuid}.sh`,
    ]) {
      expect(scriptFileOwner(name)).toBeUndefined();
    }
  });
});

describe('shellInvocation with commands too long for the MSYS command line', () => {
  const bash = shellOf('C:\\Program Files\\Git\\bin\\bash.exe', 'win32');
  const scriptPath = () => 'C:\\Users\\dev\\AppData\\Local\\Temp\\patch-command-1.sh';
  const long = `printf '%s' "${'x'.repeat(MSYS_INLINE_COMMAND_LIMIT)}"; echo END`;

  it('passes a long command to an MSYS shell as a script file', () => {
    expect(shellInvocation(bash, long, 'win32', scriptPath)).toEqual({
      args: ['"C:/Users/dev/AppData/Local/Temp/patch-command-1.sh"'],
      argv0: '"C:\\Program Files\\Git\\bin\\bash.exe"',
      windowsVerbatimArguments: true,
      scriptFile: { path: scriptPath(), content: long },
    });
  });

  it('keeps commands up to the limit on the command line', () => {
    const atLimit = 'x'.repeat(MSYS_INLINE_COMMAND_LIMIT);
    const invocation = shellInvocation(bash, atLimit, 'win32', () => {
      throw new Error('no script file expected');
    });
    expect(invocation.args).toEqual(['"-c"', `"${atLimit}"`]);
    expect(invocation.scriptFile).toBeUndefined();
  });

  it('applies only to MSYS shells on Windows', () => {
    const noScript = () => {
      throw new Error('no script file expected');
    };
    for (const [configured, platform] of [
      ['/bin/bash', 'linux'],
      ['C:\\Windows\\System32\\cmd.exe', 'win32'],
      ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32'],
    ] as const) {
      const shell = shellOf(configured, platform);
      expect(shellInvocation(shell, long, platform, noScript).scriptFile).toBeUndefined();
    }
  });
});

describe('quoteMsysArgument', () => {
  it('escapes backslashes and double quotes inside double quotes', () => {
    expect(quoteMsysArgument('plain')).toBe('"plain"');
    expect(quoteMsysArgument('')).toBe('""');
    expect(quoteMsysArgument('C:\\dir\\')).toBe('"C:\\\\dir\\\\"');
    expect(quoteMsysArgument('say "hi"')).toBe('"say \\"hi\\""');
  });
});
