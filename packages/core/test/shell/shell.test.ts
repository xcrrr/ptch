import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectShell, POWERSHELL_UTF8_SETUP } from '../../src/shell/shell.js';

/** An existence check that knows exactly `files` (compared case-insensitively, like Windows). */
function filesystem(...files: string[]) {
  const known = new Set(files.map((file) => file.toLowerCase()));
  return (candidate: string) => known.has(candidate.toLowerCase());
}

describe('detectShell on POSIX', () => {
  it('uses $SHELL when it is bash, zsh or sh', () => {
    for (const name of ['bash', 'zsh', 'sh'] as const) {
      const executable = `/usr/local/bin/${name}`;
      const shell = detectShell({
        platform: 'darwin',
        env: { SHELL: executable },
        exists: filesystem(executable, '/bin/bash'),
      });
      expect(shell).toMatchObject({ kind: name, executable, label: name });
      expect(shell.argsFor('echo hi')).toEqual(['-c', 'echo hi']);
    }
  });

  it('falls back to /bin/bash when $SHELL is another shell or missing', () => {
    const exists = filesystem('/usr/bin/fish', '/bin/bash');
    for (const env of [{ SHELL: '/usr/bin/fish' }, { SHELL: '/opt/gone/zsh' }, {}]) {
      expect(detectShell({ platform: 'linux', env, exists })).toMatchObject({
        kind: 'bash',
        executable: '/bin/bash',
        label: 'bash',
      });
    }
  });

  it('falls back to /bin/sh when bash is not installed', () => {
    const shell = detectShell({ platform: 'linux', env: {}, exists: filesystem('/bin/sh') });
    expect(shell).toMatchObject({ kind: 'sh', executable: '/bin/sh', label: 'sh' });
    expect(shell.argsFor('ls')).toEqual(['-c', 'ls']);
  });

  it('ignores a relative $SHELL', () => {
    const shell = detectShell({
      platform: 'linux',
      env: { SHELL: 'zsh' },
      exists: filesystem('zsh', '/bin/bash'),
    });
    expect(shell.executable).toBe('/bin/bash');
  });
});

describe('detectShell on Windows', () => {
  const programFilesBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const baseEnv = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
    SystemRoot: 'C:\\Windows',
    Path: 'C:\\Windows\\System32;C:\\Windows',
  };

  function detect(env: Record<string, string>, ...files: string[]) {
    return detectShell({ platform: 'win32', env, exists: filesystem(...files) });
  }

  it('prefers $PATCH_GIT_BASH', () => {
    const custom = 'D:\\tools\\git\\bin\\bash.exe';
    const shell = detect({ ...baseEnv, PATCH_GIT_BASH: custom }, custom, programFilesBash);
    expect(shell).toMatchObject({ kind: 'bash', executable: custom, label: 'Git Bash' });
    expect(shell.argsFor('ls -la')).toEqual(['-c', 'ls -la']);
  });

  it('checks Program Files, Program Files (x86) and the per-user install in order', () => {
    const x86 = 'C:\\Program Files (x86)\\Git\\bin\\bash.exe';
    const user = 'C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe';
    expect(detect(baseEnv, programFilesBash, x86, user).executable).toBe(programFilesBash);
    expect(detect(baseEnv, x86, user).executable).toBe(x86);
    expect(detect(baseEnv, user).executable).toBe(user);
  });

  it('finds bash.exe next to git.exe on PATH', () => {
    const env = { ...baseEnv, ProgramFiles: 'C:\\Nowhere', Path: '"D:\\Git\\cmd";C:\\Windows' };
    expect(detect(env, 'D:\\Git\\cmd\\git.exe', 'D:\\Git\\bin\\bash.exe')).toMatchObject({
      kind: 'bash',
      executable: 'D:\\Git\\bin\\bash.exe',
      label: 'Git Bash',
    });
    const mingwEnv = { ...env, Path: 'E:\\Git\\mingw64\\bin' };
    expect(
      detect(mingwEnv, 'E:\\Git\\mingw64\\bin\\git.exe', 'E:\\Git\\bin\\bash.exe').executable,
    ).toBe('E:\\Git\\bin\\bash.exe');
  });

  it('reads environment variables case-insensitively', () => {
    const env = { PROGRAMFILES: 'C:\\Program Files', PATH: 'C:\\Windows' };
    expect(detect(env, programFilesBash).executable).toBe(programFilesBash);
  });

  it("never picks WSL's bash.exe", () => {
    const wsl = 'C:\\Windows\\System32\\bash.exe';
    const shell = detect(
      { ...baseEnv, PATCH_GIT_BASH: wsl, Path: 'C:\\Windows\\System32' },
      wsl,
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(shell.kind).toBe('powershell');
    expect(shell.executable).not.toBe(wsl);
  });

  it('skips relative PATH entries', () => {
    const env = { ...baseEnv, Path: '.;tools' };
    expect(detect(env, '.\\pwsh.exe', 'tools\\pwsh.exe').executable).toBe('powershell.exe');
  });

  it('falls back to pwsh.exe on PATH', () => {
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    const env = { ...baseEnv, Path: `C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32` };
    const shell = detect(env, pwsh, 'C:\\Windows\\System32\\powershell.exe');
    expect(shell).toMatchObject({ kind: 'powershell', executable: pwsh, label: 'PowerShell' });
    expect(shell.argsFor('Get-ChildItem')).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `${POWERSHELL_UTF8_SETUP}\nGet-ChildItem`,
    ]);
  });

  it('falls back to Windows PowerShell on PATH, then in SystemRoot, then by name', () => {
    const onPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const env = { ...baseEnv, Path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0' };
    expect(detect(env, onPath).executable).toBe(onPath);
    expect(detect({ ...baseEnv, Path: '' }, onPath).executable).toBe(onPath);
    expect(detect({}, onPath).executable).toBe('powershell.exe');
  });
});

describe('detectShell with a configured shell', () => {
  it('uses the configured shell when it exists', () => {
    const shell = detectShell({
      platform: 'linux',
      configured: '/opt/homebrew/bin/zsh',
      env: { SHELL: '/bin/bash' },
      exists: filesystem('/opt/homebrew/bin/zsh', '/bin/bash'),
    });
    expect(shell).toMatchObject({ kind: 'zsh', executable: '/opt/homebrew/bin/zsh' });
  });

  it('ignores a configured shell that does not exist', () => {
    const shell = detectShell({
      platform: 'linux',
      configured: '/missing/zsh',
      env: {},
      exists: filesystem('/bin/bash'),
    });
    expect(shell.executable).toBe('/bin/bash');
  });

  it('classifies configured shells by file name', () => {
    const configured = (path: string, platform: NodeJS.Platform = 'win32') =>
      detectShell({ platform, configured: path, env: {}, exists: () => true });

    expect(configured('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toMatchObject({
      kind: 'powershell',
      label: 'PowerShell',
    });
    const cmd = configured('C:\\Windows\\System32\\cmd.exe');
    expect(cmd).toMatchObject({ kind: 'cmd', label: 'cmd' });
    // cmd runs the command as it is; nothing (such as chcp) runs before it.
    expect(cmd.argsFor('dir')).toEqual(['/d', '/s', '/c', 'dir']);
    expect(configured('D:\\Git\\bin\\BASH.EXE')).toMatchObject({ kind: 'bash', label: 'Git Bash' });
    expect(configured('C:\\msys64\\usr\\bin\\bash.exe')).toMatchObject({
      kind: 'bash',
      label: 'bash',
    });
    const fish = configured('/usr/bin/fish', 'linux');
    expect(fish).toMatchObject({ kind: 'sh', label: 'fish' });
    expect(fish.argsFor('ls')).toEqual(['-c', 'ls']);
  });
});

describe('PowerShell scripts', () => {
  const pwsh = detectShell({
    platform: 'linux',
    configured: '/usr/bin/pwsh',
    env: {},
    exists: () => true,
  });
  const script = (command: string) => pwsh.argsFor(command).at(-1);
  const setup = POWERSHELL_UTF8_SETUP;

  it('runs the UTF-8 setup line before the command', () => {
    expect(pwsh.argsFor('Get-Date').slice(0, -1)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
    ]);
    expect(script('Get-Date')).toBe(`${setup}\nGet-Date`);
    // Comments and expressions that start with a type are ordinary statements.
    expect(script('# list files\nGet-ChildItem')).toBe(`${setup}\n# list files\nGet-ChildItem`);
    expect(script('[StringBuilder]::new("x")')).toBe(`${setup}\n[StringBuilder]::new("x")`);
    expect(script('[int]$x = 5; "x=$x"')).toBe(`${setup}\n[int]$x = 5; "x=$x"`);
  });

  it('keeps using statements in front of the setup line', () => {
    expect(script('using namespace System.Text\n[StringBuilder]::new("ok").ToString()')).toBe(
      `using namespace System.Text\n${setup}\n[StringBuilder]::new("ok").ToString()`,
    );
    expect(script('using namespace System.IO; [Path]::GetFileName("C:/a/b.txt")')).toBe(
      `using namespace System.IO;\n${setup}\n [Path]::GetFileName("C:/a/b.txt")`,
    );
    expect(
      script(
        '# helpers\r\nUSING Namespace System.Text # text\r\n<# more #>\r\nusing module ./x.psm1\r\nGet-Foo',
      ),
    ).toBe(
      `# helpers\r\nUSING Namespace System.Text # text\r\n<# more #>\r\nusing module ./x.psm1\n${setup}\nGet-Foo`,
    );
  });

  it('keeps a param block and its attributes in front of the setup line', () => {
    expect(script('param($x = 5)\n"x=$x"')).toBe(`param($x = 5)\n${setup}\n"x=$x"`);
    const preamble = [
      'using namespace System.IO',
      '<# .SYNOPSIS',
      '   Demo with an unbalanced ( parenthesis #>',
      '[CmdletBinding()]',
      'param(',
      '  [Parameter(Mandatory = $false)]',
      '  [ValidateSet(\'a)\', "b(")]',
      "  [string]$Name = 'it''s )',",
      '  [string]$Other = "$(Get-Date) `")" # comment )',
      ')',
    ].join('\n');
    expect(script(`${preamble}\nWrite-Output $Name`)).toBe(
      `${preamble}\n${setup}\nWrite-Output $Name`,
    );
  });

  it('ends the preamble before text it cannot follow', () => {
    for (const command of ['param($x = (1', '[CmdletBinding(]param()', "param('x)"]) {
      expect(script(command)).toBe(`${setup}\n${command}`);
    }
    expect(script('using namespace X; param(')).toBe(`using namespace X;\n${setup}\n param(`);
  });
});

describe('detectShell on this machine', () => {
  it('returns an existing shell that is not WSL bash', () => {
    const shell = detectShell();
    if (shell.kind !== 'powershell') expect(existsSync(shell.executable)).toBe(true);
    if (process.platform === 'win32') {
      expect(shell.executable.toLowerCase()).not.toMatch(/\\system32\\bash\.exe$/);
    }
  });
});
