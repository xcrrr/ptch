import { classifyGit } from './git-rules.js';
import { DUAL_PROGRAMS, SWITCH_WORD, parseOptions, type OptionSpec } from './options.js';
import {
  blocked,
  destructive,
  firstOperandIndex,
  hasOption,
  isOption,
  network,
  normal,
  operands,
  optionValues,
  parameterValue,
  raise,
  safe,
  type Classifier,
  type ProgramContext,
  type Verdict,
} from './risk-helpers.js';
import { READ_ONLY_CLASSIFIERS } from './read-only-rules.js';
import { isRawDevice } from './risk-paths.js';
import { fd, find, findstr, grep, rg, sed, selectString, tar } from './search-rules.js';
import { TOOL_CLASSIFIERS, classifyPipModule } from './tool-rules.js';

const always =
  (
    make: (reason: string, extra?: Partial<Verdict>) => Verdict,
    text: string,
    extra?: Partial<Verdict>,
  ): Classifier =>
  (_args, _ctx, name) =>
    make(`${text} (${name})`, extra);

// ---------------------------------------------------------------------------------------------
// Read-only programs are classified by allowlist in read-only-rules.ts and search-rules.ts.

/** ag and ack search the current directory recursively by default, hidden files included. */
const recursiveSearch: Classifier = (_args, _ctx, name) =>
  normal(`Searches directories recursively, including files that may contain secrets (${name})`, {
    rememberable: false,
    concern: 'secret',
  });

const awk: Classifier = (args, _ctx, name) => {
  const words = operands(
    args,
    new Set(['-F', '-v', '-f', '--field-separator', '--assign', '--file']),
  );
  const hasScriptFile = optionValues(args, ['-f', '--file']).length > 0;
  // awk programs can call system() and write files (`print > file`), so an approval must not be
  // remembered: a later `awk` would run a different, possibly hostile, program.
  return normal(`Runs an awk program (${name})`, {
    paths: hasScriptFile ? words : words.slice(1),
    rememberable: false,
  });
};

// ---------------------------------------------------------------------------------------------
// Programs that change files, processes, or the system

// prettier-ignore
const MODIFIES_FILES = [
  'mkdir', 'md', 'touch', 'cp', 'copy', 'xcopy', 'mv', 'move', 'ren', 'rename', 'ln', 'mklink',
  'install', 'patch', 'zip', 'gzip', 'gunzip', 'bzip2', 'bunzip2', 'xz', 'unxz', '7z', 'split',
  'csplit', 'mktemp', 'dos2unix', 'unix2dos', 'new-item', 'ni', 'copy-item', 'cpi', 'move-item',
  'mi', 'rename-item', 'rni', 'set-content', 'add-content', 'ac', 'out-file', 'new-itemproperty',
  'set-itemproperty', 'sp', 'expand-archive', 'compress-archive', 'export-csv',
];

const DELETES_FILES: Record<string, string> = {
  rm: 'Deletes files',
  rmdir: 'Deletes directories',
  rd: 'Deletes directories',
  del: 'Deletes files',
  erase: 'Deletes files',
  unlink: 'Deletes files',
  'remove-item': 'Deletes files',
  ri: 'Deletes files',
  trash: 'Moves files to the trash',
  'trash-put': 'Moves files to the trash',
  shred: 'Destroys file contents',
  srm: 'Destroys file contents',
  wipe: 'Destroys file contents',
  truncate: 'Truncates files',
  'clear-content': 'Erases file contents',
  clc: 'Erases file contents',
  'clear-item': 'Erases items',
  cli: 'Erases items',
  'remove-itemproperty': 'Deletes item properties',
  rp: 'Deletes item properties',
  'clear-recyclebin': 'Empties the recycle bin',
};

const deletesFiles: Classifier = (args, ctx, name) => {
  const reason = `${DELETES_FILES[name.toLowerCase()] ?? 'Deletes files'} (${name})`;
  if (args.includes('--no-preserve-root'))
    return blocked(`Deletes the filesystem root (${name} --no-preserve-root)`);
  const targets = targetOperands(args, name, ctx.platform);
  if (targets.some((target) => ctx.isCatastrophicTarget(target))) {
    return blocked(`Deletes the root, home, or a system directory (${name} ${targets.join(' ')})`);
  }
  return destructive(reason);
};

const changesPermissions: Classifier = (args, ctx, name) => {
  const targets = targetOperands(args, name, ctx.platform);
  if (targets.some((target) => ctx.isCatastrophicTarget(target))) {
    return blocked(`Changes permissions of the root, home, or a system directory (${name})`);
  }
  return destructive(`Changes file permissions or ownership (${name})`);
};

/** Operands of rm-like commands, without options and cmd.exe switches. */
function targetOperands(args: string[], name: string, platform: NodeJS.Platform): string[] {
  const key = name.toLowerCase();
  return args.filter((arg) => !isOption(arg) && !isSwitchArgument(arg, key, platform));
}

/**
 * True for cmd.exe-style switches (`/s`, `/Q`, `/IM`, `/user:admin`) of programs that take them.
 * For other programs `/c` is a path (the C: drive in Git Bash).
 */
export function isSwitchArgument(word: string, key: string, platform: NodeJS.Platform): boolean {
  if (!SWITCH_WORD.test(word)) return false;
  return WINDOWS_PROGRAMS.has(key) || (platform === 'win32' && DUAL_PROGRAMS.has(key));
}

/** icacls shows permissions; most switches change them, and `/save` writes them to a file. */
const icacls: Classifier = (args) => {
  if (
    args.some((arg) =>
      /^\/(grant|deny|remove|reset|setowner|setintegritylevel|restore|inheritance)/i.test(arg),
    )
  ) {
    return destructive('Changes file permissions (icacls)');
  }
  const other = args.find((arg) => arg.startsWith('/') && !/^\/[tclq]$/i.test(arg));
  return other === undefined
    ? safe('Shows file permissions (icacls)')
    : normal(`Uses an option that is not known to be read-only (icacls ${other})`);
};

const robocopy: Classifier = (args) =>
  args.some((arg) => /^\/(mir|purge|mov|move)$/i.test(arg))
    ? destructive('Mirrors directories and deletes extra files (robocopy /MIR)')
    : normal('Copies files (robocopy)', { paths: args.filter((arg) => !arg.startsWith('/')) });

const kill: Classifier = (args) => {
  let index = 0;
  if (['-s', '-n', '--signal'].includes(args[0])) index = 2;
  else if (args.length > 1 && /^-(\d+|[A-Za-z][A-Za-z0-9+-]*)$/.test(args[0]) && args[0] !== '-1')
    index = 1;
  const targets = args.slice(index).filter((arg) => arg !== '--');
  if (targets.some((pid) => pid === '-1' || pid === '1')) {
    return blocked('Terminates every process or init (kill -1)');
  }
  return destructive('Terminates processes (kill)', { paths: [] });
};

const dd: Classifier = (args) => {
  const output = args.find((arg) => arg.startsWith('of='))?.slice(3);
  if (output !== undefined && isRawDevice(output))
    return blocked(`Writes directly to a disk device (dd of=${output})`);
  return destructive('Overwrites data (dd)', {
    paths: args.map((arg) => arg.replace(/^(if|of)=/, '')),
  });
};

const format: Classifier = (args) =>
  args.some((arg) => /^[A-Za-z]:\\?$/.test(arg))
    ? blocked(`Formats a disk (format ${args.join(' ')})`)
    : normal('Runs an unrecognized program (format)');

const diskutil: Classifier = (args) => {
  const action = args[0] ?? '';
  if (/^(erase|zero|secureerase|partition|reformat|apfs|unmountdisk|eject)/i.test(action)) {
    return blocked(`Modifies disks or partitions (diskutil ${action})`);
  }
  const options = args.slice(1).filter(isOption);
  return ['list', 'info', 'activity'].includes(action) &&
    options.every((option) => ['-plist', '-all'].includes(option))
    ? safe('Lists disks (diskutil)', { paths: [] })
    : destructive(`Changes disks (diskutil ${action})`);
};

/** Only `vssadmin list ...` reads; `delete` and `resize` destroy shadow copies. */
const vssadmin: Classifier = (args) => {
  if (args.some((arg) => /^(delete|resize)$/i.test(arg))) {
    return blocked('Deletes volume shadow copies (vssadmin)');
  }
  return /^list$/i.test(args[0] ?? '')
    ? safe('Lists volume shadow copies (vssadmin)', { paths: [] })
    : destructive(`Changes volume shadow copies (vssadmin${args[0] ? ` ${args[0]}` : ''})`, {
        paths: [],
      });
};

const initSystem: Classifier = (args, _ctx, name) =>
  args.some((arg) => ['0', '6', 'halt', 'reboot', 'poweroff'].includes(arg))
    ? blocked(`Shuts down or restarts the system (${name} ${args.join(' ')})`)
    : normal(`Changes the system run level (${name})`);

const SYSTEMCTL_READ_OPTIONS: OptionSpec = {
  short: 'alqr',
  shortValue: 'tpno',
  long: [
    '--user',
    '--system',
    '--no-pager',
    '--all',
    '--full',
    '--no-legend',
    '--plain',
    '--quiet',
    '--value',
    '--recursive',
    '--failed',
    '--show-types',
    '--reverse',
    '--after',
    '--before',
    '--help',
    '--version',
  ],
  longValue: ['--type', '--state', '--property', '--lines', '--output'],
};

const systemctl: Classifier = (args) => {
  const action = args.find((arg) => !isOption(arg)) ?? '';
  if (
    [
      'poweroff',
      'reboot',
      'halt',
      'kexec',
      'suspend',
      'hibernate',
      'hybrid-sleep',
      'emergency',
      'rescue',
      'isolate',
      'soft-reboot',
    ].includes(action)
  ) {
    return blocked(`Shuts down, restarts, or isolates the system (systemctl ${action})`);
  }
  if (
    [
      '',
      'status',
      'list-units',
      'list-unit-files',
      'list-timers',
      'list-sockets',
      'show',
      'cat',
      'is-active',
      'is-enabled',
      'is-failed',
      'help',
    ].includes(action)
  ) {
    // `-H`/`--host` and `-M`/`--machine` reach other machines and containers.
    const parsed = parseOptions(args, SYSTEMCTL_READ_OPTIONS);
    return parsed.unknown === undefined
      ? safe('Reads service state (systemctl)', { paths: [] })
      : normal(`Uses an option that is not known to be read-only (systemctl ${parsed.unknown})`);
  }
  if (
    [
      'stop',
      'disable',
      'mask',
      'kill',
      'reset-failed',
      'revert',
      'unmask',
      'edit',
      'set-property',
    ].includes(action)
  ) {
    return destructive(`Stops or reconfigures services (systemctl ${action})`);
  }
  return normal(`Changes services (systemctl ${action})`, { prefixLength: 2 });
};

const service: Classifier = (args) => {
  const action = args[1] ?? '';
  if (action === 'status' || args[0] === '--status-all')
    return safe('Reads service state (service)');
  return action === 'stop'
    ? destructive('Stops a service (service stop)')
    : normal(`Changes services (service ${action})`);
};

const launchctl: Classifier = (args) => {
  const action = args[0] ?? '';
  if (['list', 'print', 'print-disabled', 'blame', 'help', 'version'].includes(action))
    return safe('Reads service state (launchctl)');
  if (['unload', 'remove', 'bootout', 'disable', 'kill', 'stop'].includes(action)) {
    return destructive(`Stops or removes services (launchctl ${action})`);
  }
  return normal(`Changes services (launchctl ${action})`);
};

const crontab: Classifier = (args) => {
  if (hasOption(args, { short: 'l' })) {
    return parseOptions(args, { short: 'l', shortValue: 'u' }).unknown === undefined
      ? safe('Lists scheduled jobs (crontab -l)', { paths: [] })
      : normal('Uses an option that is not known to be read-only (crontab)');
  }
  return hasOption(args, { short: 'r' })
    ? destructive('Deletes all scheduled jobs (crontab -r)')
    : destructive('Replaces scheduled jobs (crontab)');
};

/** `\\host\...` names another machine: reaching it sends the user's credentials there. */
const REMOTE_MACHINE = /^[\\/]{2}/;

const reg: Classifier = (args) => {
  const action = (args[0] ?? '').toLowerCase();
  if (action === 'query') {
    return args.some((arg) => REMOTE_MACHINE.test(arg))
      ? network('Reads the registry of another machine (reg query)', {
          paths: [],
          rememberable: false,
        })
      : safe('Reads the Windows registry (reg query)', { paths: [] });
  }
  if (action === 'export' || action === 'save')
    return normal(`Exports registry keys (reg ${action})`);
  return destructive(`Modifies the Windows registry (reg ${action})`, { paths: [] });
};

const sc: Classifier = (args) =>
  /^(query|queryex|qc|qdescription|qfailure|getdisplayname|getkeyname|enumdepend)$/i.test(
    args[0] ?? '',
  )
    ? safe('Reads Windows service state (sc)', { paths: [] })
    : destructive('Changes Windows services or file contents (sc)', { paths: [] });

/** `net view` browses the network for computers and shares; `statistics`, `config` read locally. */
const net: Classifier = (args) => {
  const action = args[0] ?? '';
  if (/^view$/i.test(action)) {
    return network('Contacts other machines (net view)', {
      paths: [],
      rememberable: !args.some((arg) => REMOTE_MACHINE.test(arg)),
    });
  }
  if (!/^(statistics|config|help|helpmsg)$/i.test(action)) {
    return destructive('Changes Windows services, shares, or accounts (net)', { paths: [] });
  }
  return args.some((arg) => REMOTE_MACHINE.test(arg))
    ? network(`Contacts another machine (net ${action})`, { paths: [], rememberable: false })
    : safe('Reads Windows network information (net)', { paths: [] });
};

const startProcess: Classifier = (args, _ctx, name) => {
  const verb = parameterValue(args, '-verb', '-v');
  if (verb !== undefined && verb.toLowerCase() === 'runas') {
    return blocked(`Requests elevated privileges (${name} -Verb RunAs)`);
  }
  return normal(`Starts a process (${name})`, { rememberable: false });
};

const export_: Classifier = (args) => {
  const names = args
    .filter((arg) => arg.includes('='))
    .map((arg) => arg.slice(0, arg.indexOf('=')));
  if (args.length === 0 || args.includes('-p'))
    return normal('Prints environment variables (may include secrets)', { concern: 'secret' });
  return names.some(isDangerousVariable)
    ? normal('Overrides an environment variable that controls program loading', {
        rememberable: false,
      })
    : safe('Sets environment variables', { paths: [] });
};

/** `set -euo pipefail` only sets options; `set` alone prints every variable. */
const set: Classifier = (args) =>
  args.length > 0 &&
  args.every((arg, i) => /^[-+]/.test(arg) || (i > 0 && /^[-+][A-Za-z]*o$/.test(args[i - 1])))
    ? safe('Sets shell options', { paths: [] })
    : normal('Prints or sets shell variables (may include secrets)', {
        paths: [],
        concern: 'secret',
      });

const alias: Classifier = (args) =>
  args.some((arg) => arg.includes('='))
    ? normal('Defines a shell alias', { paths: [] })
    : safe('Lists shell aliases', { paths: [] });

// prettier-ignore
const DANGEROUS_VARIABLES = new Set([
  'PATH', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'PROMPT_COMMAND', 'IFS', 'PYTHONPATH',
  'PYTHONSTARTUP', 'PYTHONHOME', 'PYTHONUSERBASE', 'PERL5OPT', 'PERL5LIB', 'PERLLIB', 'RUBYOPT',
  'RUBYLIB', 'VISUAL', 'SHELLOPTS', 'BASHOPTS', 'PS4', 'NODE_PATH', 'COMSPEC', 'PATHEXT', 'HOME',
  'USERPROFILE', 'APPDATA', 'ZDOTDIR', 'SHELL', 'BROWSER', 'LESSOPEN', 'LESSCLOSE', 'LESSKEY',
  'LESSKEYIN', 'LESS', 'MANOPT', 'PSMODULEPATH', 'GCONV_PATH', 'HOSTALIASES', 'SSH_ASKPASS',
  'SUDO_ASKPASS', 'GNUPGHOME', 'RIPGREP_CONFIG_PATH', 'CDPATH', 'OLDPWD', 'GLOBIGNORE',
  'MANPATH', 'TERMINFO', 'MAGIC', 'GOFLAGS', 'GOENV', 'MAKEFLAGS', 'MAKE', 'MAKESHELL', 'SHELLFLAGS',
  'RUSTFLAGS', 'RUSTDOCFLAGS', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTC',
]);

/**
 * Variables that change which code runs or which configuration a program loads: `PATH=... ls`,
 * `LD_PRELOAD`, `GIT_CONFIG_PARAMETERS` (git runs `core.fsmonitor`), `GIT_DIR`, `HOME` and
 * `XDG_CONFIG_HOME` (another `.gitconfig`), `TAR_OPTIONS`, pagers and editors, `*CONFIG*`,
 * `GOFLAGS`/`CARGO_*`/`RUSTFLAGS` (toolchain wrappers and extra flags), `MAKEFLAGS`.
 */
export function isDangerousVariable(name: string): boolean {
  return (
    DANGEROUS_VARIABLES.has(name.toUpperCase()) ||
    /^(LD_|DYLD_|GIT_|XDG_|BASH_FUNC_|NPM_CONFIG_|CARGO_)/i.test(name) ||
    /(_OPTIONS|_OPTS|_WRAPPER|PAGER|EDITOR)$/i.test(name) ||
    /CONFIG/i.test(name)
  );
}

/** Variables that only change formatting or locale, which read-only commands may set. */
const HARMLESS_VARIABLES =
  /^(LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|COLUMNS|LINES|NO_COLOR|FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE|COLORTERM|CI)$/;

export function isHarmlessVariable(name: string): boolean {
  return HARMLESS_VARIABLES.test(name);
}

/**
 * Variables whose values are not secret, which read-only commands may print (`echo $HOME`):
 * locations, locale, terminal and shell state, and Windows and PowerShell system values.
 * Everything else in the environment may hold credentials (`$GITHUB_TOKEN`, `$AWS_SECRET_ACCESS_KEY`).
 */
// prettier-ignore
const PUBLIC_VARIABLES = new Set([
  'HOME', 'USER', 'USERNAME', 'LOGNAME', 'PWD', 'OLDPWD', 'SHELL', 'PATH', 'TERM', 'TERM_PROGRAM',
  'COLORTERM', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'HOSTNAME', 'HOSTTYPE', 'OSTYPE',
  'MACHTYPE', 'SHLVL', 'BASH', 'BASH_VERSION', 'BASH_VERSINFO', 'BASHPID', 'ZSH_VERSION', 'RANDOM',
  'SRANDOM', 'SECONDS', 'EPOCHSECONDS', 'EPOCHREALTIME', 'LINENO', 'UID', 'EUID', 'PPID', 'GROUPS',
  'COLUMNS', 'LINES', 'IFS', 'PS1', 'PS2', 'PS3', 'PS4', 'OPTIND', 'OPTARG', 'REPLY', 'PIPESTATUS',
  'FUNCNAME', 'BASH_SOURCE', 'DIRSTACK', 'CI', 'NODE_ENV', 'GOPATH', 'GOROOT', 'GOOS', 'GOARCH',
  'JAVA_HOME', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'CARGO_HOME', 'RUSTUP_HOME',
  'PNPM_HOME', 'NVM_DIR', 'EDITOR', 'VISUAL', 'PAGER', 'DISPLAY', 'USERPROFILE', 'USERDOMAIN',
  'COMPUTERNAME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMW6432',
  'COMMONPROGRAMFILES', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'HOMEDRIVE', 'HOMEPATH', 'OS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS', 'PATHEXT', 'COMSPEC',
  'PUBLIC', 'CD', 'DATE', 'TIME', 'ERRORLEVEL', 'PSVERSIONTABLE', 'PSHOME', 'PSSCRIPTROOT',
  'PSCOMMANDPATH', 'PSEDITION', 'PSCULTURE', 'PSUICULTURE', 'HOST', 'PID', 'NULL', 'TRUE', 'FALSE',
  'LASTEXITCODE', 'ISWINDOWS', 'ISLINUX', 'ISMACOS', 'ISCORECLR', 'ARGS', 'INPUT', 'MATCHES',
  'ERROR', 'PSITEM', 'SHELLID', '_',
]);

export function isPublicVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return PUBLIC_VARIABLES.has(upper) || /^(LC_\w+|XDG_\w+_(HOME|DIR|DIRS))$/.test(upper);
}

// ---------------------------------------------------------------------------------------------
// Network

// prettier-ignore
const NETWORK_PROGRAMS = [
  'curl', 'wget', 'scp', 'sftp', 'ftp', 'tftp', 'telnet', 'nc', 'ncat', 'netcat', 'socat', 'nmap',
  'ping', 'ping6', 'traceroute', 'tracert', 'mtr', 'dig', 'nslookup', 'host', 'whois', 'http',
  'https', 'xh', 'aria2c', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm',
  'start-bitstransfer', 'test-netconnection', 'test-connection', 'ngrok', 'cloudflared',
];

// prettier-ignore
const SSH_VALUE_OPTIONS = new Set([
  '-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-b', '-c', '-E', '-e', '-m', '-O', '-Q',
  '-S', '-W', '-w', '-B', '-I',
]);
/**
 * `-o` settings that make ssh/scp/sftp run a local program or load configuration that can
 * (`ProxyCommand`, `LocalCommand`, `KnownHostsCommand`), plus `Include`/`Match` (load other
 * config) and `ControlPath`/`ControlMaster`/`ControlPersist` (reuse a multiplexed connection).
 */
// prettier-ignore
const SSH_UNSAFE_KEYS = new Set([
  'proxycommand', 'localcommand', 'permitlocalcommand', 'knownhostscommand', 'match', 'include',
  'proxyusefdpass', 'controlpath', 'controlmaster', 'controlpersist', 'localforward',
  'remoteforward', 'dynamicforward', 'forwardagent',
]);

/** The value word that follows a short option (`-o Key=val` → `Key=val`), inline or separate. */
interface SshScan {
  /** The option (as written) that runs a local command or loads configuration, if any. */
  unsafe?: string;
  /** Files ssh reads from its options (`-i`, `-F`, `-E`, `-S`), checked as paths. */
  paths: string[];
}

/** Scans ssh/scp/sftp options for ones that run local code or load configuration. */
function scanSshOptions(args: readonly string[], program: 'ssh' | 'scp' | 'sftp'): SshScan {
  const scan: SshScan = { paths: [] };
  const markKey = (setting: string): void => {
    const key = setting.split(/[=\s]/, 1)[0]?.toLowerCase() ?? '';
    if (SSH_UNSAFE_KEYS.has(key)) scan.unsafe ??= `-o ${setting.split(/[=\s]/, 1)[0]}`;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === '-o') {
      if (args[i + 1] !== undefined) markKey(args[++i]);
    } else if (arg.startsWith('-o') && arg.length > 2) {
      markKey(arg.slice(2));
    } else if (arg === '-F' || (arg.startsWith('-F') && arg.length > 2)) {
      scan.unsafe ??= '-F';
      const value = arg.length > 2 ? arg.slice(2) : args[++i];
      if (value !== undefined) scan.paths.push(value);
    } else if ((program === 'scp' || program === 'sftp') && (arg === '-S' || /^-S./.test(arg))) {
      scan.unsafe ??= '-S';
      if (arg === '-S' && args[i + 1] !== undefined) i++;
    } else if ((arg === '-i' || arg === '-E') && args[i + 1] !== undefined) {
      scan.paths.push(args[++i]);
    } else if (SSH_VALUE_OPTIONS.has(arg)) {
      i++;
    }
  }
  return scan;
}

/**
 * `ssh host <command>` runs the command remotely; its risk is that of the remote command. Options
 * that run a local program or load other configuration (`-o ProxyCommand=...`, `-F`) are never
 * remembered, so a grant for ordinary `ssh` cannot cover them.
 */
const ssh: Classifier = (args, ctx, name) => {
  const scan = scanSshOptions(args, 'ssh');
  const hostIndex = firstOperandIndex(args, SSH_VALUE_OPTIONS);
  const remote = hostIndex < 0 ? [] : args.slice(hostIndex + 1);
  let result = network('Connects to a remote host (ssh)', { paths: scan.paths });
  if (remote.length > 0) {
    result = raise({ ...result, rememberable: false }, ctx.analyzeScript(remote.join(' ')));
  }
  if (scan.unsafe !== undefined) {
    result = { ...result, rememberable: false };
    if (result.risk === 'network') {
      result = {
        ...result,
        reason: `Runs a local command or loads configuration (${name} ${scan.unsafe})`,
      };
    }
  }
  return result;
};

/** scp/sftp: like ssh, but `-S <program>` runs a local transfer program. */
const scp: Classifier = (args, _ctx, name) => {
  const program = name.toLowerCase() === 'sftp' ? 'sftp' : 'scp';
  const scan = scanSshOptions(args, program);
  const paths = [...operands(args, SSH_VALUE_OPTIONS), ...scan.paths];
  if (scan.unsafe !== undefined) {
    return network(`Runs a local command or loads configuration (${name} ${scan.unsafe})`, {
      paths,
      rememberable: false,
    });
  }
  return network(`Copies files over the network (${name})`, { paths });
};

/** Options (inline or separate) that make a program run a command or load a config file. */
function usesAny(args: readonly string[], options: readonly string[]): string | undefined {
  for (const arg of args) {
    if (arg === '--') break;
    for (const option of options) {
      if (arg === option) return option;
      if (option.startsWith('--') && arg.startsWith(`${option}=`)) return option;
      if (!option.startsWith('--') && arg.startsWith(option) && arg.length > option.length) {
        return option;
      }
    }
  }
  return undefined;
}

const rsync: Classifier = (args) => {
  if (args.some((arg) => arg.startsWith('--delete') || arg === '--remove-source-files')) {
    return destructive('Deletes files while syncing (rsync --delete)');
  }
  // `-e`/`--rsh` run a remote shell, `--rsync-path` a program on the remote, `--config`/`--daemon`
  // load a config file: none may be remembered from an ordinary `rsync` grant.
  const unsafe = usesAny(args, ['-e', '--rsh', '--rsync-path', '--config', '--daemon']);
  if (unsafe !== undefined) {
    return network(`Runs a remote shell or program (rsync ${unsafe})`, { rememberable: false });
  }
  return network('Copies files, possibly over the network (rsync)');
};

/** `curl -K <file>`/`--config` loads a config file that can set the output file or upload data. */
const curl: Classifier = (args, _ctx, name) => {
  const config = usesAny(args, ['-K', '--config']);
  if (config !== undefined) {
    return network(
      `Loads a configuration file that can write files or upload data (${name} ${config})`,
      {
        rememberable: false,
      },
    );
  }
  return network(`Uses the network (${name})`);
};

/** `wget -e <command>`/`--execute` can set `output_document`; `--config` loads a config file. */
const wget: Classifier = (args, _ctx, name) => {
  const unsafe = usesAny(args, ['-e', '--execute', '--config']);
  if (unsafe !== undefined) {
    return network(
      `Runs wget commands or loads a config that can write files (${name} ${unsafe})`,
      {
        rememberable: false,
      },
    );
  }
  return network(`Uses the network (${name})`);
};

// ---------------------------------------------------------------------------------------------
// Shells and interpreters

const SHELL_VALUE_OPTIONS = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
/** fish's `-C`/`--init-command` run a command before the `-c` one. */
const FISH_VALUE_OPTIONS = new Set(['-C', '--init-command']);
/** Options that make a shell run other code before the command. */
const SHELL_STARTUP_CODE = /^(--rcfile|--init-file|--init-command|-C)(=|$)/;
/** Pseudo-files that are really standard input: `bash /dev/stdin` runs code Patch cannot see. */
const STDIN_FILE = /^(\/dev\/stdin|\/dev\/fd\/\d+|\/proc\/self\/fd\/\d+)$/;

/**
 * `bash -c "<script>"` runs the script; `bash file` runs a file; a bare shell, `-s`, `-i` or `-`
 * reads its script from standard input, which Patch cannot see, so those are never remembered
 * (otherwise a `bash` grant would cover `cat payload | bash`). A file operand keeps the script in
 * the rule prefix, so an approval covers only that script. Startup files (`--rcfile`,
 * `--init-file`) and fish's init commands (`-C`, analyzed with the script) run first: never
 * remembered.
 */
const posixShell: Classifier = (args, _ctx, name) => {
  const fish = name.toLowerCase() === 'fish';
  let startup: string | undefined;
  const initCommands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (SHELL_STARTUP_CODE.test(arg) && (fish || arg !== '-C')) startup ??= arg;
    if (fish && arg.startsWith('--init-command=')) initCommands.push(arg.slice(15));
    if (SHELL_VALUE_OPTIONS.has(arg) || (fish && FISH_VALUE_OPTIONS.has(arg))) {
      if (fish && FISH_VALUE_OPTIONS.has(arg) && args[i + 1] !== undefined) {
        initCommands.push(args[i + 1]);
      }
      i++;
    } else if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) {
      const script = args[i + 1];
      if (script === undefined) return normal(`Starts a shell (${name})`, { rememberable: false });
      return startup === undefined
        ? safe('', { script })
        : normal(`Runs other code before the command (${name} ${startup})`, {
            script: [...initCommands, script].join('\n'),
            rememberable: false,
          });
    } else if (arg === '--' || !/^[-+]/.test(arg)) {
      const fileIndex = arg === '--' ? i + 1 : i;
      const file = args[fileIndex];
      if (file === undefined || STDIN_FILE.test(file)) {
        return normal(`Starts a shell (${name})`, { rememberable: false });
      }
      return normal(`Runs a shell script (${name} ${file})`, { prefixLength: fileIndex + 2 });
    }
  }
  return normal(`Starts a shell (${name})`, { rememberable: false });
};

// prettier-ignore
const POWERSHELL_VALUE_PARAMETERS = new Set([
  '-executionpolicy', '-ep', '-ex', '-exec', '-windowstyle', '-w', '-win', '-version', '-v',
  '-inputformat', '-if', '-inp', '-outputformat', '-of', '-o', '-configurationname', '-config',
  '-workingdirectory', '-wd', '-settingsfile', '-psconsolefile', '-custompipename',
]);

/**
 * `powershell -Command <script>`, `-EncodedCommand <base64>`, or a bare command after parameters.
 * `-WorkingDirectory` runs the script elsewhere, so its relative paths cannot be checked.
 */
const powershell: Classifier = (args, _ctx, name) => {
  const flags = { policyBypass: false, workingDirectory: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!/^[-/]/.test(arg)) return withFlags(safe('', { script: args.slice(i).join(' ') }), flags);
    const parameter = `-${arg.slice(1).split(':')[0].toLowerCase()}`;
    if (POWERSHELL_VALUE_PARAMETERS.has(parameter)) {
      // `-ExecutionPolicy Bypass` or `-ExecutionPolicy:Bypass`.
      const inline = arg.includes(':') ? arg.slice(arg.indexOf(':') + 1) : undefined;
      const value = inline ?? args[i + 1] ?? '';
      if (parameter.startsWith('-e') && /^(bypass|unrestricted)$/i.test(value)) {
        flags.policyBypass = true;
      }
      if (parameter === '-workingdirectory' || parameter === '-wd') flags.workingDirectory = true;
      if (inline === undefined) i++;
    } else if (parameter === '-c' || (parameter.length >= 4 && '-command'.startsWith(parameter))) {
      return withFlags(safe('', { script: args.slice(i + 1).join(' ') }), flags);
    } else if (
      parameter === '-e' ||
      parameter === '-ec' ||
      (parameter.length >= 4 && '-encodedcommand'.startsWith(parameter))
    ) {
      const decoded = decodePowerShellCommand(args[i + 1] ?? '');
      return decoded
        ? withFlags(safe('', { script: decoded }), flags)
        : normal(`Runs an encoded command that could not be decoded (${name})`, {
            rememberable: false,
          });
    } else if (parameter === '-f' || (parameter.length >= 3 && '-file'.startsWith(parameter))) {
      return normal(`Runs a PowerShell script (${name})`, { rememberable: !flags.policyBypass });
    }
  }
  return normal(`Starts PowerShell (${name})`);
};

function withFlags(
  result: Verdict,
  flags: { policyBypass: boolean; workingDirectory: boolean },
): Verdict {
  let verdict = result;
  if (flags.policyBypass) {
    verdict = raise(
      { ...verdict, rememberable: false },
      normal('Bypasses the PowerShell execution policy'),
    );
  }
  if (flags.workingDirectory) {
    verdict = raise(
      { ...verdict, rememberable: false },
      normal('Runs the command in another directory (-WorkingDirectory)'),
    );
  }
  return verdict;
}

function decodePowerShellCommand(encoded: string): string | undefined {
  if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) return undefined;
  const decoded = Buffer.from(encoded, 'base64').toString('utf16le').replace(/\0+$/, '');
  return decoded.trim() === '' || /[\u0000-\u0008\u000e-\u001f]/.test(decoded)
    ? undefined
    : decoded;
}

/** `cmd /c <script>` (or `/k`, `/r`, and attached forms like `/c"dir"`). */
const cmd: Classifier = (args) => {
  for (let i = 0; i < args.length; i++) {
    const match = /^\/([ckr])(.*)$/is.exec(args[i]);
    if (match)
      return safe('', { script: [match[2], ...args.slice(i + 1)].filter(Boolean).join(' ') });
    if (!args[i].startsWith('/')) break;
  }
  return normal('Starts a command prompt (cmd)');
};

/** `command -v x` only looks a program up (other forms are unwrapped as a wrapper). */
const commandLookup: Classifier = (args) =>
  hasOption(args, { short: 'vV' })
    ? safe('Looks up a command (command -v)', { paths: [] })
    : normal('Runs a command (command)');

const evalScript: Classifier = (args) =>
  args.length === 0 ? safe('Does nothing (eval)') : safe('', { script: args.join(' ') });

const env: Classifier = (args) => {
  const split = optionValues(args, ['-S', '--split-string']);
  if (split.length > 0) return safe('', { script: split.join(' ') });
  return normal('Prints environment variables (may include secrets)', {
    paths: [],
    concern: 'secret',
  });
};

/**
 * Interpreters (`node`, `ruby`, `perl`, `tsx`, ...). `node script.js` runs a file: remembered,
 * with the script in the rule prefix (`node script.js`), so a grant covers only that script. But
 * inline code (`-e`/`--eval`, `-p`, `-r`, `--import`, ...), a REPL or stdin (`node`, `node -`),
 * and any other option run code Patch cannot vet, so they are never remembered: otherwise a
 * `node` grant would cover `node -e '<arbitrary code>'`.
 */
const interpreter: Classifier = (args, _ctx, name) => {
  if (args.length === 0) {
    return normal(`Starts an interactive interpreter (${name})`, { rememberable: false });
  }
  const scriptIndex = args.findIndex((arg) => !isOption(arg));
  if (scriptIndex < 0) return normal(`Runs code (${name})`, { rememberable: false });
  if (args[scriptIndex] === '-') {
    return normal(`Runs code from standard input (${name})`, { rememberable: false });
  }
  if (scriptIndex > 0) return normal(`Runs code (${name})`, { rememberable: false });
  return normal(`Runs a script (${name} ${args[scriptIndex]})`, { prefixLength: scriptIndex + 2 });
};

const PYTHON_VALUE_OPTIONS = new Set(['-W', '-X', '-Q']);

const python: Classifier = (args, ctx, name) => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-m' || /^-m\w/.test(arg)) {
      const moduleIndex = arg === '-m' ? i + 1 : i;
      const module = arg === '-m' ? args[i + 1] : arg.slice(2);
      if (module === undefined) break;
      if (module === 'pip') {
        const pip = classifyPipModule(args.slice(moduleIndex + 1));
        return { ...pip, prefixLength: moduleIndex + 1 + (pip.prefixLength ?? 1) };
      }
      return normal(`Runs a Python module (${name} -m ${module})`, {
        prefixLength: moduleIndex + 2,
      });
    }
    // Inline code, the REPL and stdin (`-c`, `python`, `python -`) run code Patch cannot vet, so
    // they are never remembered. A script file is remembered with the script in the rule prefix.
    if (arg === '-c') return normal(`Runs Python code (${name} -c)`, { rememberable: false });
    if (PYTHON_VALUE_OPTIONS.has(arg)) i++;
    else if (arg === '-')
      return normal(`Runs code from standard input (${name})`, { rememberable: false });
    else if (!isOption(arg)) {
      return normal(`Runs a script (${name} ${arg})`, { prefixLength: i + 2 });
    }
  }
  return interpreter(args, ctx, name);
};

// prettier-ignore
const INTERPRETERS = [
  'node', 'nodejs', 'ruby', 'perl', 'php', 'lua', 'luajit', 'rscript', 'julia', 'java', 'jshell',
  'groovy', 'kotlin', 'scala', 'elixir', 'erl', 'escript', 'swift', 'osascript', 'tclsh', 'wish',
  'ts-node', 'tsx', 'dotnet-script',
];

/** Development tools that run project code or build output. */
// prettier-ignore
const PROJECT_TOOLS = [
  'tsc', 'vitest', 'jest', 'mocha', 'ava', 'tap', 'pytest', 'py.test', 'tox', 'nox', 'rspec',
  'rake', 'phpunit', 'eslint', 'prettier', 'biome', 'oxlint', 'stylelint', 'black', 'ruff',
  'flake8', 'pylint', 'mypy', 'pyright', 'isort', 'golangci-lint', 'gofmt', 'rustfmt', 'rubocop',
  'shellcheck', 'shfmt', 'vite', 'webpack', 'rollup', 'esbuild', 'parcel', 'turbo', 'nx', 'lerna',
  'tsup', 'swc', 'babel', 'next', 'nuxt', 'astro', 'remix', 'gatsby', 'ng', 'cypress', 'storybook',
  'jupyter', 'ipython', 'cmake', 'ninja', 'meson', 'bazel', 'bazelisk', 'buck2', 'scons', 'ant',
  'sbt', 'lein', 'gcc', 'g++', 'cc', 'c++', 'clang', 'clang++', 'rustc', 'javac', 'kotlinc', 'zig',
  'ghc', 'cabal', 'stack', 'xcodebuild', 'ctest', 'cpack', 'valgrind', 'gdb', 'lldb', 'just',
  'task',
];

/** Pagers run commands (`!cmd`, `LESSOPEN`, `v` for the editor), so they are never safe. */
// prettier-ignore
const PAGERS = [
  'less', 'more', 'most', 'pg', 'zless', 'zmore', 'bzless', 'bzmore', 'xzless', 'xzmore', 'view',
];

/** PowerShell commands that run the script blocks they are given. */
// prettier-ignore
const SCRIPT_BLOCK_RUNNERS = [
  'foreach-object', '%', 'foreach', 'invoke-command', 'icm', 'start-job', 'sajb',
  'start-threadjob', 'new-module', 'nmo', 'register-objectevent', 'register-engineevent', 'trap',
];

// prettier-ignore
const EDITORS_AND_OPENERS = [
  'vim', 'vi', 'nvim', 'nano', 'emacs', 'code', 'subl', 'notepad', 'open', 'xdg-open', 'start',
  'explorer', 'invoke-item', 'ii',
];

// ---------------------------------------------------------------------------------------------
// Blocked: privilege escalation and system-level destruction

const ELEVATION = ['sudo', 'su', 'doas', 'pkexec', 'runas', 'gsudo', 'sudoedit', 'chroot'];
const POWER = ['shutdown', 'reboot', 'halt', 'poweroff', 'stop-computer', 'restart-computer'];
// prettier-ignore
const DISK_TOOLS = [
  'mke2fs', 'mkswap', 'fdisk', 'sfdisk', 'cfdisk', 'gdisk', 'sgdisk', 'parted', 'wipefs',
  'diskpart', 'format-volume', 'clear-disk', 'initialize-disk', 'bcdedit',
];
const SECURITY_SETTINGS: Record<string, string> = {
  'set-executionpolicy': 'Changes the PowerShell execution policy',
  'set-mppreference': 'Changes Windows Defender settings',
  'add-mppreference': 'Changes Windows Defender settings',
  csrutil: 'Changes system integrity protection',
  setenforce: 'Changes SELinux enforcement',
  spctl: 'Changes Gatekeeper settings',
};

const SYSTEM_CHANGES: Record<string, string> = {
  mount: 'Mounts or unmounts filesystems',
  umount: 'Mounts or unmounts filesystems',
  iptables: 'Changes firewall rules',
  ip6tables: 'Changes firewall rules',
  nft: 'Changes firewall rules',
  ufw: 'Changes firewall rules',
  'firewall-cmd': 'Changes firewall rules',
  netsh: 'Changes network configuration',
  useradd: 'Changes user accounts',
  userdel: 'Changes user accounts',
  usermod: 'Changes user accounts',
  groupadd: 'Changes user accounts',
  groupdel: 'Changes user accounts',
  passwd: 'Changes passwords',
  chpasswd: 'Changes passwords',
  'set-acl': 'Changes file permissions',
};

/** Programs blocked whatever their arguments, with the reason. */
const ALWAYS_BLOCKED = new Map<string, string>([
  ...ELEVATION.map((name): [string, string] => [name, 'Requires elevated privileges']),
  ...POWER.map((name): [string, string] => [name, 'Shuts down or restarts the system']),
  ...DISK_TOOLS.map((name): [string, string] => [
    name,
    'Modifies disks, partitions, or boot configuration',
  ]),
  ...Object.entries(SECURITY_SETTINGS),
]);

/** Why a program is blocked whatever its arguments (`sudo`, `shutdown`, `mkfs.*`), if it is. */
export function alwaysBlockedReason(key: string): string | undefined {
  return ALWAYS_BLOCKED.get(key) ?? (key.startsWith('mkfs') ? 'Formats a filesystem' : undefined);
}

/** Programs blocked whatever their arguments (besides `mkfs.*`), lowercase. */
export function alwaysBlockedNames(): Iterable<string> {
  return ALWAYS_BLOCKED.keys();
}

// ---------------------------------------------------------------------------------------------
// Table

const CLASSIFIERS = new Map<string, Classifier>();

function register(names: readonly string[], classifier: Classifier): void {
  for (const name of names) CLASSIFIERS.set(name, classifier);
}

for (const [name, classifier] of READ_ONLY_CLASSIFIERS) register([name], classifier);
register(['grep', 'egrep', 'fgrep'], grep);
register(['ag', 'ack', 'ack-grep'], recursiveSearch);
register(['select-string', 'sls'], selectString);
register(['rg'], rg);
register(['findstr'], findstr);
register(['find'], find);
register(['fd', 'fdfind'], fd);
register(['sed', 'gsed'], sed);
register(['awk', 'gawk', 'mawk', 'nawk'], awk);
register(['tar', 'bsdtar'], tar);
register(PAGERS, always(normal, 'Opens a pager, which can run commands', { rememberable: false }));
register(
  SCRIPT_BLOCK_RUNNERS,
  always(normal, 'Runs a PowerShell script block', { rememberable: false }),
);
register(MODIFIES_FILES, always(normal, 'Modifies files'));
register(['attrib'], always(normal, 'Changes file attributes'));
register(Object.keys(DELETES_FILES), deletesFiles);
register(['chmod', 'chown', 'chgrp', 'chattr', 'setfacl', 'takeown'], changesPermissions);
register(['icacls'], icacls);
register(['robocopy'], robocopy);
register(['kill'], kill);
register(
  ['pkill', 'killall', 'taskkill', 'tskill', 'stop-process', 'spps', 'xkill'],
  always(destructive, 'Terminates processes', { paths: [] }),
);
register(['dd'], dd);
register(['format'], format);
register(['diskutil'], diskutil);
register(['vssadmin'], vssadmin);
register(['init', 'telinit'], initSystem);
register(['systemctl'], systemctl);
register(['service'], service);
register(['launchctl'], launchctl);
register(['crontab'], crontab);
register(['reg'], reg);
register(['sc'], sc);
register(['net'], net);
register(['start-process', 'saps'], startProcess);
register(['export'], export_);
register(['set'], set);
register(['alias'], alias);
register(
  ['printenv'],
  always(normal, 'Prints environment variables (may include secrets)', {
    paths: [],
    concern: 'secret',
  }),
);
register(
  ['history', 'get-history'],
  always(normal, 'Prints shell history (may include secrets)', { paths: [], concern: 'secret' }),
);
register(NETWORK_PROGRAMS, always(network, 'Uses the network'));
register(['ssh'], ssh);
register(['scp', 'sftp'], scp);
register(['curl'], curl);
register(['wget'], wget);
register(['rsync'], rsync);
register(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'mksh', 'csh', 'tcsh'], posixShell);
register(['powershell', 'pwsh'], powershell);
register(['cmd'], cmd);
register(['eval', 'invoke-expression', 'iex'], evalScript);
register(['source', '.'], always(normal, 'Runs a shell script in the current shell'));
register(['exec'], always(normal, 'Replaces the shell or changes file descriptors'));
register(['env'], env);
register(['command'], commandLookup);
register(['python', 'python2', 'python3', 'py', 'pypy', 'pypy3'], python);
register(INTERPRETERS, interpreter);
register(PROJECT_TOOLS, always(normal, 'Runs project tooling'));
register(EDITORS_AND_OPENERS, always(normal, 'Opens a file or program', { rememberable: false }));
for (const [name, reason] of ALWAYS_BLOCKED) register([name], always(blocked, reason));
for (const [name, reason] of Object.entries(SYSTEM_CHANGES))
  register([name], always(destructive, reason));
register(['git'], classifyGit);
for (const [name, classifier] of Object.entries(TOOL_CLASSIFIERS)) register([name], classifier);

/**
 * Classifies a program invocation by its lookup key (see `lookupKey` in command-risk.ts).
 * Returns undefined for programs Patch does not know.
 */
export function classifyProgram(
  key: string,
  args: string[],
  ctx: ProgramContext,
  name: string,
): Verdict | undefined {
  const classifier =
    CLASSIFIERS.get(key) ??
    (key.startsWith('mkfs') ? always(blocked, 'Formats a filesystem') : undefined);
  return classifier?.(args, ctx, name);
}

export function isKnownProgram(key: string): boolean {
  return CLASSIFIERS.has(key) || key.startsWith('mkfs');
}

/** Programs that download data (upstream of `| sh` they make the pipeline destructive). */
// prettier-ignore
export const FETCHERS = new Set([
  'curl', 'wget', 'http', 'https', 'xh', 'aria2c', 'invoke-webrequest', 'iwr', 'invoke-restmethod',
  'irm', 'nc', 'ncat', 'netcat', 'socat', 'ssh', 'scp', 'gh', 'glab', 'ftp', 'tftp',
]);

/** Programs that execute code read from stdin or from an argument. */
// prettier-ignore
export const INTERPRETER_PROGRAMS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'mksh', 'csh', 'tcsh', 'powershell', 'pwsh',
  'cmd', 'iex', 'invoke-expression', 'eval', 'source', '.', 'python', 'python2', 'python3', 'py',
  'pypy', 'pypy3', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'osascript',
  'tclsh', 'rscript',
]);

/** Shells whose stdin is a script (`echo "rm -rf x" | sh`). */
// prettier-ignore
export const SHELL_PROGRAMS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'mksh', 'csh', 'tcsh', 'powershell', 'pwsh',
  'cmd', 'iex', 'invoke-expression',
]);

/** PowerShell commands (and their aliases) that output file objects. */
// prettier-ignore
export const FILE_LISTERS = new Set([
  'get-childitem', 'gci', 'ls', 'dir', 'get-item', 'gi', 'resolve-path', 'rvpa',
]);

/** PowerShell commands (and their aliases) that read the files piped into them. */
// prettier-ignore
export const PIPED_FILE_READERS = new Set([
  'get-content', 'gc', 'cat', 'type', 'select-string', 'sls', 'import-csv',
]);

/** Programs that change the working directory for the rest of the command. */
export const CD_PROGRAMS = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl']);

/** Windows-only programs whose `/x` arguments are always switches, never paths. */
// prettier-ignore
const WINDOWS_PROGRAMS = new Set([
  'del', 'erase', 'rd', 'xcopy', 'robocopy', 'findstr', 'taskkill', 'tskill', 'runas', 'attrib',
  'icacls', 'takeown', 'cipher', 'sc', 'reg', 'net', 'netsh', 'vssadmin', 'bcdedit', 'diskpart',
  'format', 'copy', 'move', 'ren', 'md', 'mklink', 'cls', 'ver', 'vol', 'tracert', 'cmd',
]);
