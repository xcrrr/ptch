import { parseOptions, type OptionSpec } from './options.js';
import {
  destructive,
  firstOperandIndex,
  hasOption,
  isOption,
  network,
  normal,
  operands,
  optionValues,
  safe,
  verdict,
  type Classifier,
  type Verdict,
  own,
} from './risk-helpers.js';
import type { CommandRisk } from './command-risk.js';

/** Declarative description of a `<tool> <subcommand>` style CLI. */
interface SubcommandTool {
  /**
   * Global options that take a separate value (`-C dir`, `--filter x`), so the subcommand is
   * found after them. Being listed here does not make an option read-only.
   */
  valueOptions?: ReadonlySet<string>;
  /**
   * Options allowed in calls classified safe (besides `-h`, `--help`, `--json`, `--version`); any
   * other option (`npm --userconfig x`, `docker -H host`, `npm help --viewer`, `helm template
   * --post-renderer`, `kubectl config view --raw`) makes the call normal and never remembered.
   */
  readOnly?: OptionSpec;
  safe?: readonly string[];
  network?: readonly string[];
  destructive?: readonly string[];
  /** Subcommands whose first operand is a script/target that belongs in the rule prefix. */
  scripts?: readonly string[];
  /** Subcommands with their own actions (`go mod tidy`, `docker image rm`). */
  groups?: Readonly<Record<string, SubcommandTool>>;
  /** Classification when no subcommand is given. Default: safe (usually prints help). */
  bare?: CommandRisk;
  /** Risk of unlisted subcommands. Default: normal. */
  fallback?: CommandRisk;
  reasons?: Partial<Record<CommandRisk, string>>;
  /**
   * Options (or operands) that let the tool run an arbitrary command or load other configuration
   * (`go test -exec`, `cargo --config`, `npm --node-options`, `make SHELL=`). A call using one is
   * never remembered, so a grant for the ordinary command (`go test`) cannot cover it.
   */
  unsafe?: (args: readonly string[]) => boolean;
}

const DEFAULT_REASONS: Record<CommandRisk, string> = {
  safe: 'Reads project or tool information',
  normal: 'Runs project tooling',
  network: 'Uses the network',
  destructive: 'Publishes, deletes, or overwrites data',
  blocked: 'Blocked',
};

/**
 * Classifies `args` of a subcommand-style tool. The rule prefix covers the program, global
 * options, the subcommand, and the script or group action when there is one.
 */
function classifyTool(tool: SubcommandTool, args: readonly string[], label: string): Verdict {
  const index = firstOperandIndex(args, tool.valueOptions);
  const reason = (risk: CommandRisk, what: string): string =>
    `${tool.reasons?.[risk] ?? DEFAULT_REASONS[risk]} (${what})`;
  if (index < 0) {
    const risk = tool.bare ?? 'safe';
    // A bare invocation (no subcommand) must not offer a one-word grant covering every
    // subcommand, so it is remembered only when it is safe (and offers no prompt).
    return verdict(risk, reason(risk, label), risk === 'safe' ? {} : { rememberable: false });
  }
  const sub = args[index];
  const name = `${label} ${sub}`;
  const prefixLength = index + 2;
  const group = own(tool.groups, sub);
  if (group) {
    const inner = classifyTool(group, args.slice(index + 1), name);
    return { ...inner, prefixLength: index + 1 + (inner.prefixLength ?? 1) };
  }
  const risk = riskOf(tool, sub);
  if (tool.scripts?.includes(sub)) {
    const script = args.slice(index + 1).find((arg) => !isOption(arg));
    // `npm run` with no script is safe (prints the scripts), but must carry the subcommand in its
    // prefix so a redirect raising it to normal cannot offer a bare `npm` grant.
    if (script === undefined) return verdict('safe', reason('safe', name), { prefixLength });
    return verdict(risk, reason(risk, `${name} ${script}`), {
      prefixLength: args.indexOf(script, index + 1) + 2,
    });
  }
  return verdict(risk, reason(risk, name), { prefixLength });
}

function riskOf(tool: SubcommandTool, sub: string): CommandRisk {
  if (tool.destructive?.includes(sub)) return 'destructive';
  if (tool.network?.includes(sub)) return 'network';
  if (tool.safe?.includes(sub)) return 'safe';
  return tool.fallback ?? 'normal';
}

const DEFAULT_READ_ONLY: OptionSpec = { short: 'h', long: ['--help', '--json', '--version'] };

/**
 * Keeps a safe verdict only when every option in `args` is on the tool's read-only allowlist
 * (`readOnly`, help/json/version); otherwise normal and never remembered.
 */
function readOnlyOptions(
  spec: SubcommandTool,
  args: readonly string[],
  result: Verdict,
  name: string,
): Verdict {
  if (result.risk !== 'safe') return result;
  const allowed: OptionSpec = {
    ...spec.readOnly,
    short: `${DEFAULT_READ_ONLY.short}${spec.readOnly?.short ?? ''}`,
    long: [...(DEFAULT_READ_ONLY.long ?? []), ...(spec.readOnly?.long ?? [])],
  };
  const parsed = parseOptions(args, allowed);
  if (parsed.unknown === undefined) return result;
  return normal(`Uses an option that is not known to be read-only (${name} ${parsed.unknown})`, {
    ...(result.prefixLength === undefined ? {} : { prefixLength: result.prefixLength }),
    rememberable: false,
  });
}

const tool =
  (spec: SubcommandTool, label?: string): Classifier =>
  (args, _ctx, name) =>
    markUnsafe(
      readOnlyOptions(spec, args, classifyTool(spec, args, label ?? name), name),
      args,
      spec.unsafe,
    );

/** Drops rememberability from a normal/network verdict when the call uses a code-running option. */
function markUnsafe(
  result: Verdict,
  args: readonly string[],
  unsafe: SubcommandTool['unsafe'],
): Verdict {
  if (result.rememberable === false || unsafe === undefined) return result;
  return unsafe(args) ? { ...result, rememberable: false } : result;
}

/** A flag's name without leading dashes or `=value`/`:value` (go/make single-dash too). */
function optionName(arg: string): string {
  return arg.replace(/^-+/, '').split(/[=:]/, 1)[0];
}

/** The value of an option given inline (`--x=v`) or as the next word. */
function optionArgValue(arg: string, args: readonly string[], index: number): string | undefined {
  const equals = arg.indexOf('=');
  return equals >= 0 ? arg.slice(equals + 1) : args[index + 1];
}

/** A path value that leaves the project (absolute, `~`, `..`, or a Windows drive). */
const OUTSIDE_VALUE = /^(~|\.\.([\\/]|$)|[\\/]|[A-Za-z]:)/;
function outsideValue(value: string | undefined): boolean {
  return value !== undefined && OUTSIDE_VALUE.test(value);
}

/**
 * Builds an unsafe-option predicate: a call is unsafe when it uses one of `options` (matched by
 * flag name), a `+toolchain` word, an outside-project value for a directory option in `outside`,
 * or (with `variableOperands`) a `NAME=value` operand that overrides a variable.
 */
function unsafeOptions(
  options: ReadonlySet<string>,
  extra: { outside?: ReadonlySet<string>; toolchain?: boolean; variableOperands?: boolean } = {},
): (args: readonly string[]) => boolean {
  return (args) => {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--') break;
      if (extra.toolchain && arg.startsWith('+')) return true;
      if (!arg.startsWith('-')) {
        if (extra.variableOperands && /^[A-Za-z_]\w*=/.test(arg)) return true;
        continue;
      }
      const name = optionName(arg);
      if (options.has(name)) return true;
      if (extra.outside?.has(name) && outsideValue(optionArgValue(arg, args, i))) return true;
    }
    return false;
  };
}

const NPM_UNSAFE = unsafeOptions(
  new Set(['node-options', 'script-shell', 'userconfig', 'globalconfig', 'shell-emulator']),
  { outside: new Set(['prefix', 'dir', 'C']) },
);
const CARGO_UNSAFE = unsafeOptions(new Set(['config', 'Z', 'manifest-path']), {
  outside: new Set(['C']),
  toolchain: true,
});
const GO_UNSAFE = unsafeOptions(
  new Set([
    'exec',
    'toolexec',
    'overlay',
    'modfile',
    'pgo',
    'ldflags',
    'gcflags',
    'asmflags',
    'gccgoflags',
  ]),
  { outside: new Set(['C']) },
);
const MAKE_UNSAFE = unsafeOptions(
  new Set(['eval', 'E', 'f', 'file', 'makefile', 'I', 'include-dir', 'C', 'directory']),
  { variableOperands: true },
);

// ---------------------------------------------------------------------------------------------
// JavaScript package managers

// prettier-ignore
const INSTALLS = [
  'install', 'i', 'add', 'ci', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un',
];
// prettier-ignore
const NPM_REGISTRY = [
  'view', 'info', 'show', 'outdated', 'audit', 'search', 'login', 'logout', 'adduser', 'whoami',
  'ping', 'doctor', 'fund', 'create', 'init', 'dedupe', 'install-test', 'it', 'install-ci-test',
  'cit', 'clean-install',
];
// prettier-ignore
const NPM_PUBLISH = [
  'publish', 'unpublish', 'deprecate', 'dist-tag', 'owner', 'access', 'team', 'token', 'org',
  'hook', 'star', 'unstar',
];
// prettier-ignore
const NPM_INFO = [
  'ls', 'list', 'la', 'll', 'explain', 'why', 'root', 'bin', 'prefix', 'help', 'help-search',
  'query', 'get',
];

/** npm's global options with a separate value (shared with the `npm exec` launcher). */
// prettier-ignore
export const NPM_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--prefix', '-w', '--workspace', '--userconfig', '--globalconfig', '--cache', '--registry',
  '--loglevel',
]);

const npm = tool({
  valueOptions: NPM_VALUE_OPTIONS,
  unsafe: NPM_UNSAFE,
  safe: NPM_INFO,
  network: [...INSTALLS, ...NPM_REGISTRY],
  destructive: NPM_PUBLISH,
  scripts: ['run', 'run-script', 'rum', 'urn'],
  groups: {
    config: { safe: ['get', 'list', 'ls'], fallback: 'normal' },
    cache: { safe: ['ls'] },
  },
  reasons: { normal: 'Runs package scripts or tooling' },
  // Not `npm help --viewer`/`--browser`, which open other programs, nor `--userconfig` and
  // `--globalconfig`, which load other configuration.
  readOnly: {
    short: 'lpagvP',
    shortValue: 'w',
    long: [
      '--long',
      '--parseable',
      '--all',
      '--global',
      '--prod',
      '--production',
      '--dev',
      '--link',
      '--unicode',
      '--workspaces',
      '--ws',
      '--include-workspace-root',
      '--package-lock-only',
      '--no-color',
      '--expect-results',
      '--no-expect-results',
    ],
    longValue: [
      '--depth',
      '--omit',
      '--include',
      '--location',
      '--prefix',
      '--workspace',
      '--loglevel',
    ],
  },
});

/** pnpm's global options with a separate value (shared with the `pnpm exec` launcher). */
// prettier-ignore
export const PNPM_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-C', '--dir', '--filter', '-F', '--filter-prod', '--reporter', '--loglevel', '--store-dir',
  '--workspace-dir', '--test-pattern', '--changed-files-ignore-pattern',
]);

const pnpm = tool({
  valueOptions: PNPM_VALUE_OPTIONS,
  unsafe: NPM_UNSAFE,
  safe: ['ls', 'list', 'll', 'why', 'root', 'bin', 'help', 'licenses', 'store-path'],
  network: [
    ...INSTALLS,
    'fetch',
    'import',
    'dedupe',
    'audit',
    'outdated',
    'create',
    'env',
    'self-update',
    'view',
    'info',
  ],
  destructive: ['publish'],
  scripts: ['run', 'run-script'],
  groups: {
    config: { safe: ['get', 'list'] },
    store: { safe: ['path', 'status'], fallback: 'normal' },
  },
  reasons: { normal: 'Runs package scripts or tooling' },
  readOnly: {
    short: 'gPDrv',
    shortValue: 'CF',
    long: [
      '--long',
      '--parseable',
      '--global',
      '--prod',
      '--dev',
      '--recursive',
      '--only-projects',
      '--no-optional',
      '--exclude-peers',
      '--lockfile-only',
      '--workspace-root',
      '--no-color',
    ],
    longValue: [
      '--depth',
      '--dir',
      '--filter',
      '--filter-prod',
      '--reporter',
      '--loglevel',
      '--workspace-dir',
      '--test-pattern',
      '--changed-files-ignore-pattern',
    ],
  },
});

/** yarn's global options with a separate value (shared with the `yarn exec` launcher). */
export const YARN_VALUE_OPTIONS: ReadonlySet<string> = new Set(['--cwd']);

/**
 * yarn runs the release named by the project's `.yarnrc.yml` (`yarnPath`), which is project code,
 * for every command: nothing it does is read-only.
 */
const yarnTool: SubcommandTool = {
  valueOptions: YARN_VALUE_OPTIONS,
  bare: 'network',
  network: [
    ...INSTALLS,
    'create',
    'info',
    'npm',
    'import',
    'upgrade-interactive',
    'audit',
    'outdated',
    'login',
    'logout',
  ],
  destructive: ['publish'],
  scripts: ['run'],
  groups: {
    npm: { destructive: ['publish', 'tag'], fallback: 'network' },
  },
  reasons: { normal: "Runs package scripts or tooling, or the project's Yarn release" },
};

/** `yarn workspace <name> <command...>` runs a command in one workspace. */
const yarn: Classifier = (args, _ctx, name) => {
  const index = firstOperandIndex(args, yarnTool.valueOptions);
  if (args.length > 0 && args.every((arg) => ['--version', '--help', '-v', '-h'].includes(arg))) {
    return normal(`Runs the project's Yarn release, which may be project code (${name})`);
  }
  if (index >= 0 && args[index] === 'workspace' && index + 2 < args.length) {
    const inner = classifyTool(
      yarnTool,
      args.slice(index + 2),
      `yarn workspace ${args[index + 1]}`,
    );
    const result = { ...inner, prefixLength: index + 2 + (inner.prefixLength ?? 1) };
    return markUnsafe(readOnlyOptions(yarnTool, args, result, name), args, NPM_UNSAFE);
  }
  return markUnsafe(
    readOnlyOptions(yarnTool, args, classifyTool(yarnTool, args, name), name),
    args,
    NPM_UNSAFE,
  );
};

/** `bun pm trust` runs dependencies' lifecycle scripts; `bun pm cache rm` deletes the cache. */
const bun = tool({
  unsafe: NPM_UNSAFE,
  safe: ['help', 'why'],
  network: [...INSTALLS, 'a', 'create', 'c', 'outdated', 'link', 'audit'],
  destructive: ['publish'],
  scripts: ['run'],
  groups: {
    pm: { safe: ['ls', 'bin', 'hash', 'hash-string'], network: ['whoami'], fallback: 'normal' },
  },
  reasons: { normal: 'Runs scripts or tooling' },
  readOnly: { short: 'ag', long: ['--all', '--global', '--top'], longValue: ['--depth'] },
});

/** `deno info` and `deno doc` resolve module graphs, downloading remote imports. */
const deno = tool({
  safe: ['help', 'types'],
  network: ['install', 'add', 'remove', 'cache', 'upgrade', 'outdated', 'uninstall', 'info', 'doc'],
  destructive: ['publish'],
  reasons: { normal: 'Runs code or tooling' },
  readOnly: {
    short: 'qr',
    long: ['--quiet', '--private', '--lint', '--no-lock', '--no-remote', '--no-npm', '--no-config'],
    longValue: ['--filter', '--config', '--import-map', '--lock', '--location'],
  },
});

// ---------------------------------------------------------------------------------------------
// Other language toolchains

/** `--config` and `-Z` (unstable features) change what cargo loads and runs: never read-only. */
const cargo = tool({
  valueOptions: new Set(['--manifest-path', '-Z', '--config', '--color', '-C']),
  unsafe: CARGO_UNSAFE,
  safe: ['help', 'version', 'search-path', 'locate-project', 'read-manifest', 'verify-project'],
  network: [
    'add',
    'remove',
    'rm',
    'update',
    'upgrade',
    'fetch',
    'install',
    'uninstall',
    'search',
    'login',
    'logout',
    'vendor',
    'generate-lockfile',
  ],
  destructive: ['publish', 'yank', 'owner'],
  readOnly: {
    short: 'qv',
    long: ['--quiet', '--verbose', '--workspace', '--offline', '--frozen', '--locked'],
    longValue: ['--message-format', '--color', '--manifest-path'],
  },
});

/** `go work edit` rewrites go.work unless it only prints (`-print`, `-json`). */
const goTool: SubcommandTool = {
  valueOptions: new Set(['-C']),
  safe: ['version', 'help', 'doc'],
  network: ['get', 'install'],
  groups: {
    mod: { network: ['tidy', 'download', 'vendor'], safe: ['graph', 'why', 'verify'] },
    work: { fallback: 'normal' },
  },
};

/** go's flags are single-dash words (`-json`, `-all`); these only change what it prints. */
// prettier-ignore
const GO_READ_FLAGS = new Set([
  '-all', '-c', '-cmd', '-short', '-src', '-u', '-m', '-v', '-json', '-changed', '-vendor',
  '-print', '-go', '-h', '-help',
]);

/**
 * `go env` prints settings; `go env -w`/`-u` changes the user's go env file, which every later
 * go command reads (GOFLAGS=-toolexec=..., GOPROXY, GOSUMDB=off): never remembered, like
 * `git config` writes. Go's flag syntax accepts `-w`, `--w`, `-w=true`.
 */
const go: Classifier = (args, _ctx, name) => {
  const index = firstOperandIndex(args, goTool.valueOptions);
  if (
    index >= 0 &&
    args[index] === 'env' &&
    args.slice(index + 1).some((arg) => /^--?[wu](=|$)/.test(arg))
  ) {
    return normal(`Changes persistent Go configuration (${name} env -w/-u)`, {
      rememberable: false,
    });
  }
  const result =
    index >= 0 && args[index] === 'env'
      ? safe(`Reads project or tool information (${name} env)`, { prefixLength: index + 2 })
      : index >= 0 &&
          args[index] === 'work' &&
          args[index + 1] === 'edit' &&
          args.slice(index + 2).some((arg) => /^--?(print|json)$/.test(arg))
        ? safe(`Reads project or tool information (${name} work edit)`, { prefixLength: index + 3 })
        : classifyTool(goTool, args, name);
  if (result.risk !== 'safe') {
    return GO_UNSAFE(args) ? { ...result, rememberable: false } : result;
  }
  const option = args.find(
    (arg, i) =>
      isOption(arg) &&
      !GO_READ_FLAGS.has(arg.replace(/^--/, '-').split('=')[0]) &&
      arg !== '-C' &&
      args[i - 1] !== '-C',
  );
  return option === undefined
    ? result
    : normal(`Uses an option that is not known to be read-only (${name} ${option})`, {
        prefixLength: result.prefixLength,
        rememberable: false,
      });
};

/** Not `pip list -o`/`-u` (query the index) or `--python` (runs another interpreter). */
const PIP_READ_ONLY: OptionSpec = {
  short: 'lefqva',
  long: [
    '--not-required',
    '--user',
    '--local',
    '--editable',
    '--exclude-editable',
    '--include-editable',
    '--verbose',
    '--quiet',
    '--all',
    '--files',
    '--isolated',
    '--no-color',
    '--disable-pip-version-check',
    '--global',
    '--site',
  ],
  longValue: ['--format', '--path', '--exclude', '--algorithm'],
};

const pipTool: SubcommandTool = {
  safe: ['list', 'show', 'freeze', 'check', 'help', 'debug', 'inspect', 'hash'],
  network: ['install', 'download', 'wheel', 'search', 'index'],
  groups: { config: { safe: ['get', 'list', 'debug'] }, cache: { safe: ['dir', 'info', 'list'] } },
  reasons: { normal: 'Changes installed packages' },
  readOnly: PIP_READ_ONLY,
};
const pip = tool(pipTool);

/** poetry's global options with a separate value (shared with the `poetry run` launcher). */
export const POETRY_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-C',
  '--directory',
  '-P',
  '--project',
]);

const poetry = tool({
  valueOptions: POETRY_VALUE_OPTIONS,
  safe: ['show', 'check', 'about', 'help', 'list', 'search'],
  network: ['add', 'install', 'update', 'lock', 'remove', 'sync', 'search', 'init', 'new'],
  destructive: ['publish'],
  groups: {
    self: { network: ['update', 'add', 'install', 'lock'], safe: ['show'] },
    env: { safe: ['info', 'list'] },
  },
  // Not `poetry show --latest`/`--outdated`, which query the package index.
  readOnly: {
    short: 'Taqvn',
    shortValue: 'CP',
    long: [
      '--tree',
      '--top-level',
      '--no-dev',
      '--all',
      '--quiet',
      '--verbose',
      '--no-ansi',
      '--ansi',
      '--no-interaction',
      '--lock',
      '--path',
      '--full-path',
      '--executable',
      '--strict',
    ],
    longValue: ['--why', '--only', '--with', '--without', '--directory', '--project'],
  },
});

/** uv's global options with a separate value (shared with the `uv run` launcher). */
export const UV_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--directory',
  '--project',
  '--cache-dir',
  '--config-file',
  '--python',
  '-p',
]);

/**
 * `uv tree` resolves the project, which may download and build packages. `--python` runs the
 * given interpreter and `--config-file` loads other settings: never read-only.
 */
const uv = tool({
  valueOptions: UV_VALUE_OPTIONS,
  safe: ['help', 'version'],
  network: ['add', 'remove', 'sync', 'lock', 'init', 'tree'],
  destructive: ['publish'],
  groups: {
    pip: { ...pipTool, network: ['install', 'sync', 'compile'] },
    tool: { network: ['install', 'upgrade', 'run'], safe: ['list', 'dir'] },
    python: { network: ['install'], safe: ['list', 'find', 'dir'] },
    self: { network: ['update'] },
    cache: { safe: ['dir'] },
  },
  readOnly: {
    ...PIP_READ_ONLY,
    long: [...(PIP_READ_ONLY.long ?? []), '--only-installed'],
    longValue: [...(PIP_READ_ONLY.longValue ?? []), '--directory', '--project'],
  },
});

/**
 * `dotnet list` evaluates and restores projects (running their MSBuild targets), and
 * `dotnet sln <file> add` edits solutions: only `dotnet sln list` only reads.
 */
const dotnet = tool({
  safe: ['--version', '--info', '--list-sdks', '--list-runtimes', 'help'],
  network: ['restore', 'workload'],
  groups: {
    add: { network: ['package'] },
    tool: { network: ['install', 'update', 'restore', 'search'], safe: ['list'] },
    nuget: { destructive: ['push', 'delete'], fallback: 'network' },
    sln: { safe: ['list'] },
  },
  readOnly: {
    short: 'g',
    long: ['--global', '--local', '--info', '--list-sdks', '--list-runtimes'],
  },
});

const INFORMATION_OPTIONS = ['--version', '--help', '-v', '-h'];

/**
 * Build tools whose operands are tasks/goals; publishing tasks are destructive. Only a call with
 * nothing but version or help options is read-only, and not for tools whose startup reads project
 * code (`startsProjectCode`).
 */
function taskRunner(
  label: string,
  valueOptions: ReadonlySet<string>,
  publishing: RegExp,
  startsProjectCode?: string,
  unsafe?: (args: readonly string[]) => boolean,
): Classifier {
  return (args) => {
    const danger = unsafe?.(args) ?? false;
    const remember = danger ? { rememberable: false } : {};
    const tasks = operands(args, valueOptions);
    if (tasks.length === 0) {
      const informational =
        args.length > 0 && args.every((arg) => INFORMATION_OPTIONS.includes(arg));
      if (!informational) return normal(`Runs the default build (${label})`, remember);
      return startsProjectCode === undefined
        ? safe(`Prints tool information (${label})`, { paths: [] })
        : normal(`Runs ${label}, which ${startsProjectCode}`, remember);
    }
    const index = args.indexOf(tasks[0]);
    const what = `${label} ${tasks.join(' ')}`;
    const publishTask = tasks.find((task) => publishing.test(task));
    if (publishTask) return destructive(`Publishes or deploys artifacts (${label} ${publishTask})`);
    return normal(`Runs build tasks (${what})`, { prefixLength: index + 2, ...remember });
  };
}

// prettier-ignore
const MAKE_VALUE_OPTIONS = new Set([
  '-C', '--directory', '-f', '--file', '--makefile', '-I', '--include-dir', '-o', '-W', '-l',
]);
const make = taskRunner('make', MAKE_VALUE_OPTIONS, /^$/, undefined, MAKE_UNSAFE);
const maven = taskRunner(
  'mvn',
  new Set(['-f', '--file', '-P', '-pl', '-s', '-D']),
  /^(deploy|release:perform|site-deploy)$/,
  "loads the project's JVM options (.mvn/jvm.config)",
);
const gradle = taskRunner(
  'gradle',
  new Set(['-p', '-b', '-c', '-x', '--exclude-task', '-P', '-D']),
  /publish|upload|release/i,
);

// ---------------------------------------------------------------------------------------------
// Containers, clusters, infrastructure

/** `inspect` is not here: it prints containers' environment variables, which may hold secrets. */
// prettier-ignore
const DOCKER_READS = [
  'ps', 'images', 'version', 'info', 'logs', 'stats', 'top', 'port', 'diff', 'history', 'events',
  'ls', 'df',
];
const DOCKER_DELETES = ['rm', 'rmi', 'kill', 'prune', 'remove'];
const dockerGroup: SubcommandTool = {
  safe: DOCKER_READS,
  network: ['pull', 'search', 'login', 'logout'],
  destructive: [...DOCKER_DELETES, 'push'],
};
// -f is a filter or format for some subcommands and `--follow` for logs: either way not a path.
const DOCKER_READ_ONLY: OptionSpec = {
  short: 'aqsltv',
  shortValue: 'fn',
  long: [
    '--all',
    '--quiet',
    '--size',
    '--latest',
    '--no-trunc',
    '--timestamps',
    '--details',
    '--digests',
    '--no-stream',
    '--human',
    '--verbose',
    '--follow',
  ],
  longValue: [
    '--filter',
    '--format',
    '--last',
    '--tail',
    '--since',
    '--until',
    '--type',
    '--log-level',
  ],
};
// prettier-ignore
const DOCKER_GROUPS = [
  'container', 'image', 'volume', 'network', 'system', 'builder', 'buildx', 'context', 'plugin',
  'manifest', 'trust', 'swarm', 'node', 'service', 'stack', 'secret', 'config',
];

const dockerTool: SubcommandTool = {
  valueOptions: new Set(['-H', '--host', '-c', '--context', '--config', '-l', '--log-level']),
  ...dockerGroup,
  groups: {
    ...Object.fromEntries(DOCKER_GROUPS.map((name) => [name, dockerGroup])),
    compose: {
      safe: ['ps', 'logs', 'ls', 'images', 'top', 'version'],
      network: ['pull'],
      destructive: ['rm', 'kill', 'push'],
    },
  },
  readOnly: DOCKER_READ_ONLY,
};

/** Subcommands that start or enter a container, where privileged flags give host access. */
const DOCKER_RUN_SUBCOMMANDS = new Set(['run', 'create', 'exec']);
/** Flags that grant root-equivalent host access whatever their value. */
const DOCKER_PRIVILEGE_FLAGS = new Set([
  'privileged',
  'cap-add',
  'device',
  'device-cgroup-rule',
  'security-opt',
]);
/** Namespace-sharing flags: joining the host namespace escapes isolation. */
const DOCKER_NAMESPACE_FLAGS = new Set(['pid', 'ipc', 'uts', 'userns', 'cgroupns']);

/** True when `words` (operands) start or enter a container (`run`/`create`/`exec`). */
function dockerRunsContainer(words: readonly string[]): boolean {
  if (DOCKER_RUN_SUBCOMMANDS.has(words[0] ?? '')) return true;
  if (DOCKER_GROUPS.includes(words[0] ?? '') && DOCKER_RUN_SUBCOMMANDS.has(words[1] ?? '')) {
    return true;
  }
  return (
    (words[0] === 'compose' || words[0] === 'stack') && (words[1] === 'run' || words[1] === 'exec')
  );
}

/** A docker mount/volume host source that reaches outside the project (absolute, `~`, `..`, a
 * drive, a variable, or a socket). */
function dockerSourceOutside(source: string): boolean {
  if (source === '') return false;
  return OUTSIDE_VALUE.test(source) || source.startsWith('$') || /\.sock$/i.test(source);
}

/** `-v host:container[:opts]`: the host source is the text before the container path. */
function volumeSourceOutside(value: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return dockerSourceOutside(value.split(':')[0] ?? '');
}

/** `--mount type=bind,source=/etc,target=/host`: any bind source outside the project. */
function mountSourceOutside(value: string): boolean {
  return value.split(',').some((field) => {
    const [key, val] = field.split('=');
    return (key === 'source' || key === 'src') && val !== undefined && dockerSourceOutside(val);
  });
}

/**
 * True when a `docker run`/`create`/`exec` uses an option that gives the container root-equivalent
 * host access: a privilege or namespace flag, host networking, running as root, a bind mount or
 * volume whose source is outside the project, `--volumes-from`, or `LD_PRELOAD` in the
 * environment. Such a call is never remembered, so a grant for an ordinary `docker run` cannot
 * cover it.
 */
function dockerRunUnsafe(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (!arg.startsWith('-')) continue;
    const name = optionName(arg);
    const value = optionArgValue(arg, args, i);
    const attached =
      !arg.startsWith('--') && arg.length > 2 ? arg.slice(2).replace(/^=/, '') : undefined;
    if (DOCKER_PRIVILEGE_FLAGS.has(name) || DOCKER_NAMESPACE_FLAGS.has(name)) return true;
    if ((name === 'network' || name === 'net') && /^(host$|container:)/i.test(value ?? '')) {
      return true;
    }
    const user = name === 'user' ? value : name === 'u' ? (attached ?? value) : undefined;
    if (user !== undefined && /^(root|0)(:|$)/i.test(user)) return true;
    if (name === 'volumes-from') return true;
    if (name === 'volume' && value !== undefined && volumeSourceOutside(value)) return true;
    if (name === 'v') {
      const v = attached ?? value;
      if (v !== undefined && volumeSourceOutside(v)) return true;
    }
    if (name === 'mount' && value !== undefined && mountSourceOutside(value)) return true;
    const envValue = name === 'env' ? value : name === 'e' ? (attached ?? value) : undefined;
    if (envValue !== undefined && /^LD_PRELOAD=/.test(envValue)) return true;
    if (name === 'env-file' && outsideValue(value)) return true;
  }
  return false;
}

/**
 * `docker compose down -v` deletes volumes; plain `down` only stops and removes containers.
 * `docker compose config` prints the configuration with values from `.env` files filled in.
 */
const docker: Classifier = (args, _ctx, name) => {
  const result = readOnlyOptions(dockerTool, args, classifyTool(dockerTool, args, name), name);
  const words = operands(args, dockerTool.valueOptions);
  if (
    words[0] === 'compose' &&
    args.includes('down') &&
    hasOption(args, { short: 'v', long: ['--volumes', '--rmi'] })
  ) {
    return destructive('Deletes containers and volumes (docker compose down -v)');
  }
  if (words[0] === 'compose' && words[1] === 'config') {
    return normal(
      'Prints the Compose configuration, including values from .env files (docker compose config)',
      { prefixLength: result.prefixLength, rememberable: false },
    );
  }
  const inspects =
    words[0] === 'inspect' || (DOCKER_GROUPS.includes(words[0] ?? '') && words[1] === 'inspect');
  if (inspects && result.risk === 'normal') {
    return normal(
      `Prints container configuration, including environment variables that may contain secrets (${name} inspect)`,
      { prefixLength: result.prefixLength, rememberable: false, concern: 'secret' },
    );
  }
  // A `docker run`/`create`/`exec` with a privilege, namespace, host-mount or root-user option
  // gives the container host access: never remembered (see dockerRunUnsafe).
  if (
    dockerRunsContainer(words) &&
    (result.risk === 'normal' || result.risk === 'network') &&
    dockerRunUnsafe(args)
  ) {
    return { ...result, rememberable: false };
  }
  return result;
};

const kubectl = tool({
  valueOptions: new Set([
    '-n',
    '--namespace',
    '--context',
    '--kubeconfig',
    '--cluster',
    '--user',
    '-s',
    '--server',
  ]),
  destructive: ['delete', 'drain', 'replace'],
  fallback: 'network',
  groups: {
    config: {
      safe: ['view', 'get-contexts', 'current-context', 'get-clusters', 'get-users'],
      destructive: ['delete-context', 'delete-cluster', 'delete-user'],
    },
  },
  reasons: { network: 'Talks to a Kubernetes cluster' },
  // Not `kubectl config view --raw`, which prints credentials.
  readOnly: {
    long: ['--minify', '--flatten', '--merge', '--no-headers', '--allow-missing-template-keys'],
    shortValue: 'ons',
    longValue: [
      '--output',
      '--template',
      '--namespace',
      '--context',
      '--kubeconfig',
      '--cluster',
      '--user',
      '--server',
    ],
  },
});

const helmTool: SubcommandTool = {
  valueOptions: new Set(['-n', '--namespace', '--kube-context', '--kubeconfig']),
  safe: ['version', 'help', 'env', 'template', 'lint'],
  destructive: ['uninstall', 'delete', 'rollback'],
  fallback: 'network',
  readOnly: {
    shortValue: 'afsn',
    long: [
      '--include-crds',
      '--skip-tests',
      '--skip-crds',
      '--is-upgrade',
      '--no-hooks',
      '--debug',
      '--strict',
      '--with-subcharts',
      '--quiet',
      '--devel',
      '--skip-schema-validation',
      '--short',
      '--release-name',
    ],
    longValue: [
      '--set',
      '--set-string',
      '--set-json',
      '--set-literal',
      '--values',
      '--name-template',
      '--kube-version',
      '--api-versions',
      '--show-only',
      '--template',
      '--namespace',
      '--kube-context',
      '--kubeconfig',
    ],
    pathValues: ['-f', '--values'],
  },
};

/**
 * `helm template` and `lint` render charts locally; `--post-renderer` runs a program,
 * `--output-dir` writes files and `--set-file` embeds any file in the output. A chart that is not
 * a local directory (`bitnami/nginx`, `oci://...`) is downloaded.
 */
const helm: Classifier = (args, ctx, name) => {
  const result = readOnlyOptions(helmTool, args, classifyTool(helmTool, args, name), name);
  const [sub, ...charts] = parseOptions(args, helmTool.readOnly ?? {}).operands;
  if (result.risk !== 'safe' || (sub !== 'template' && sub !== 'lint')) return result;
  const remote = (sub === 'template' ? charts.slice(-1) : charts).find(
    (chart) => /:\/\/|^oci:/i.test(chart) || ctx.pathExists(chart) !== true,
  );
  return remote === undefined
    ? result
    : network(`May download a chart (${name} ${sub} ${remote})`, {
        prefixLength: result.prefixLength,
      });
};

const terraformTool: SubcommandTool = {
  valueOptions: new Set(['-chdir']),
  safe: ['version', 'help', 'validate', 'graph'],
  destructive: ['apply', 'destroy', 'import', 'taint', 'untaint', 'force-unlock'],
  groups: {
    // State and workspaces may live in a remote backend; `state show` prints secret attributes.
    state: { destructive: ['rm', 'mv', 'push', 'replace-provider'], fallback: 'network' },
    workspace: { destructive: ['delete'], fallback: 'network' },
  },
  fallback: 'network',
};

/**
 * `terraform fmt` rewrites files in place unless it only checks (`-check`, `-write=false`, or
 * stdin `-`). `terraform console` evaluates expressions such as `file("~/.ssh/id_rsa")` that read
 * any file, so it is never remembered.
 */
const terraform: Classifier = (args, _ctx, name) => {
  const index = firstOperandIndex(args, terraformTool.valueOptions);
  const sub = index < 0 ? undefined : args[index];
  const rest = args.slice(index + 1);
  const prefixLength = index + 2;
  if (sub === 'fmt') {
    const checksOnly =
      rest.some((arg) => /^--?check(=true)?$/i.test(arg)) ||
      rest.some((arg) => /^--?write=false$/i.test(arg)) ||
      rest.includes('-');
    return checksOnly
      ? terraformReadOnly(args, safe(`Checks formatting (${name} fmt)`, { prefixLength }), name)
      : normal(`Formats files in place (${name} fmt)`, { prefixLength });
  }
  if (sub === 'console') {
    return normal(`Evaluates expressions that can read any file (${name} console)`, {
      rememberable: false,
    });
  }
  const result = classifyTool(terraformTool, args, name);
  return result.risk === 'safe' ? terraformReadOnly(args, result, name) : result;
};

/** terraform's flags are single-dash words; these only change what it checks or prints. */
// prettier-ignore
const TERRAFORM_READ_FLAGS = new Set([
  '-json', '-no-color', '-no-tests', '-check', '-diff', '-recursive', '-list', '-write', '-type',
  '-plan', '-draw-cycles', '-module-depth', '-state', '-id', '-test-directory', '-chdir', '-help',
  '-h', '-version', '-v',
]);

function terraformReadOnly(args: readonly string[], result: Verdict, name: string): Verdict {
  const option = args.find(
    (arg) => isOption(arg) && !TERRAFORM_READ_FLAGS.has(arg.replace(/^--/, '-').split('=')[0]),
  );
  return option === undefined
    ? result
    : normal(`Uses an option that is not known to be read-only (${name} ${option})`, {
        prefixLength: result.prefixLength,
        rememberable: false,
      });
}

/** `pulumi about` contacts the backend. */
const pulumi = tool({
  destructive: ['up', 'update', 'destroy', 'refresh', 'import', 'cancel'],
  safe: ['version', 'help'],
  fallback: 'network',
});

const DEPLOY_OR_DELETE =
  /^(delete|rm|rb|destroy|remove|purge|terminate|deploy|publish|release|rollback|drop|reset|down)$|delete|terminate|destroy/i;

/** Cloud and hosting CLIs: everything talks to the network; deletes and deploys are destructive. */
const cloudCli: Classifier = (args, _ctx, name) => {
  const words = operands(args);
  const dangerous = words.find((word) => DEPLOY_OR_DELETE.test(word));
  if (dangerous) return destructive(`Deploys or deletes cloud resources (${name} ${dangerous})`);
  if (
    words.length === 0 &&
    ['vercel', 'netlify'].includes(name) &&
    !hasOption(args, { long: ['--help', '--version'] })
  ) {
    return destructive(`Deploys (${name})`);
  }
  const index = firstOperandIndex(args);
  return network(`Uses a cloud service (${name}${words[0] ? ` ${words[0]}` : ''})`, {
    prefixLength: index < 0 ? 1 : index + 2,
  });
};

// prettier-ignore
const GH_DESTRUCTIVE = new Set([
  'merge', 'close', 'delete', 'archive', 'unarchive', 'lock', 'transfer', 'rename', 'revert',
  'disable', 'cancel', 'rerun',
]);

/** GitHub/GitLab CLIs: network; merges, deletions, releases and mutating API calls are destructive. */
const forgeCli: Classifier = (args, _ctx, name) => {
  const words = operands(
    args,
    new Set([
      '-R',
      '--repo',
      '-X',
      '--method',
      '-F',
      '-f',
      '--field',
      '--raw-field',
      '-H',
      '--header',
      '-q',
      '--jq',
      '-t',
      '--template',
    ]),
  );
  const [group, action] = words;
  if (group === 'api') {
    const methods = optionValues(args, ['-X', '--method']).map((value) => value.toUpperCase());
    const mutating = methods.find((value) => ['DELETE', 'PUT', 'PATCH'].includes(value));
    if (mutating) return destructive(`Changes data through the API (${name} api -X ${mutating})`);
    return network(`Calls the API (${name} api)`, { rememberable: false });
  }
  const label = [name, group, action].filter(Boolean).join(' ');
  if (
    (action && GH_DESTRUCTIVE.has(action)) ||
    (group === 'release' && action !== 'list' && action !== 'view' && action !== 'download') ||
    ((group === 'secret' || group === 'variable') && action !== 'list')
  ) {
    return destructive(`Changes repository data (${label})`);
  }
  const prefixWords = [group, action].filter(Boolean).length;
  return network(`Talks to the code host (${label})`, { prefixLength: 1 + prefixWords });
};

// ---------------------------------------------------------------------------------------------
// System package managers

// prettier-ignore
const REMOVALS = [
  'remove', 'uninstall', 'purge', 'autoremove', 'erase', 'del', 'rm', 'cleanup', 'untap',
  'autoclean', 'clean',
];

const PACKAGE_LISTINGS = ['list', 'ls', 'leaves', 'deps', 'config', 'help'];
/** Options allowed in listings: pacman's query letters (`-Qi`) and output switches. */
const PACKAGE_LISTING_OPTION =
  /^(-Q[A-Za-z]*|-[1hlqv]|--(version|help|installed|upgradable|upgradeable|manual-installed|versions|cask|casks|formula|formulae|full-name|pinned|quiet|verbose|json|columns))$/;
/** Package managers that refresh repository metadata from the network before listing. */
const REFRESHES_METADATA = new Set(['dnf', 'yum', 'winget']);

/**
 * System package managers. Only listings (`apt list`, `brew leaves`, `pacman -Qi`, the bare
 * program) with allowlisted options are read-only; options such as `apt -o` change configuration,
 * and `pacman -Syu` without an operand still installs.
 */
const systemPackages: Classifier = (args, _ctx, name) => {
  const words = operands(args);
  const action = words[0];
  if (args.some((arg) => /^-R/.test(arg)) || (action && REMOVALS.includes(action))) {
    return destructive(`Removes system packages (${name}${action ? ` ${action}` : ''})`);
  }
  const prefixLength = action ? args.indexOf(action) + 2 : 1;
  const listing = args.some((arg) => /^-Q/.test(arg)) || PACKAGE_LISTINGS.includes(action ?? '');
  const unknown = args.find((arg) => isOption(arg) && !PACKAGE_LISTING_OPTION.test(arg));
  if ((listing || action === undefined) && unknown === undefined) {
    if (REFRESHES_METADATA.has(name.toLowerCase()) && action !== undefined && action !== 'help') {
      return network(`Refreshes package metadata from the network (${name} ${action})`, {
        prefixLength,
      });
    }
    return safe(`Lists system packages (${name})`, { paths: [] });
  }
  if (listing) {
    return normal(`Uses an option that is not known to be read-only (${name} ${unknown})`, {
      prefixLength,
      rememberable: false,
    });
  }
  return network(`Installs or updates system packages (${name}${action ? ` ${action}` : ''})`, {
    prefixLength,
  });
};

/**
 * conda and mamba. `env` has actions of its own: `env remove` deletes a whole environment, `env
 * create`/`update` install packages, `env config vars set` changes it.
 */
const condaTool: SubcommandTool = {
  network: ['install', 'update', 'create', 'search', 'upgrade'],
  destructive: ['remove', 'uninstall', 'clean'],
  safe: ['list', 'info', 'help'],
  groups: {
    env: {
      safe: ['list', 'export', 'help'],
      network: ['create', 'update'],
      destructive: ['remove'],
      fallback: 'normal',
    },
  },
};

/** Like condaTool, except that `env export -f <file>` writes a file. */
const conda: Classifier = (args, _ctx, name) => {
  const result = classifyTool(condaTool, args, name);
  const words = operands(args);
  if (
    words[0] === 'env' &&
    words[1] === 'export' &&
    optionValues(args, ['-f', '--file']).length > 0
  ) {
    return normal(`Writes an environment file (${name} env export -f)`, {
      prefixLength: result.prefixLength,
    });
  }
  return result;
};

/** Language package tools where only a few subcommands download or publish. */
const languageTools: Record<string, SubcommandTool> = {
  gem: {
    network: ['install', 'update', 'fetch', 'search', 'sources'],
    destructive: ['push', 'yank', 'owner'],
    safe: ['list', 'info', 'env', 'help', 'which', 'contents'],
  },
  // Most bundler commands evaluate the Gemfile, which is Ruby code.
  bundle: {
    network: ['install', 'update', 'add', 'outdated', 'lock', 'cache'],
    safe: ['help', 'config'],
  },
  composer: {
    network: [
      'install',
      'update',
      'require',
      'remove',
      'create-project',
      'outdated',
      'self-update',
      'audit',
    ],
    // Composer loads plugins from the project's vendor directory for other commands.
    safe: ['help'],
  },
  pod: {
    network: ['install', 'update', 'repo', 'outdated', 'search'],
    groups: { trunk: { destructive: ['push', 'delete', 'deprecate'], fallback: 'network' } },
  },
  mix: {
    network: ['deps.get', 'deps.update', 'hex.publish', 'archive.install', 'local.hex'],
    destructive: ['hex.publish'],
  },
  flutter: {
    network: ['pub', 'create', 'upgrade', 'precache', 'downgrade'],
    safe: ['doctor', 'devices', 'help', 'config'],
  },
  dart: { network: ['pub', 'create'], safe: ['help', 'info', 'analyze'] },
  playwright: { network: ['install', 'install-deps'], safe: ['help'] },
  pdm: {
    network: ['add', 'install', 'update', 'lock', 'remove', 'sync', 'init'],
    destructive: ['publish'],
    safe: ['list', 'show', 'info', 'help'],
  },
  hatch: { network: ['env'], destructive: ['publish'], safe: ['version', 'help', 'status'] },
  pipx: {
    network: ['install', 'upgrade', 'upgrade-all', 'inject', 'run', 'reinstall'],
    safe: ['list', 'environment', 'help'],
  },
};

/**
 * Programs whose startup runs project code whatever the arguments, so not even `--version` is
 * read-only: yarn runs the release named by `yarnPath`; mvn passes `.mvn/jvm.config` to Java
 * (`-javaagent:`).
 */
const STARTS_PROJECT_CODE = new Set(['yarn', 'mvn', 'mvnw']);

export function startsProjectCode(key: string): boolean {
  return STARTS_PROJECT_CODE.has(key);
}

export const TOOL_CLASSIFIERS: Record<string, Classifier> = {
  npm,
  pnpm,
  yarn,
  bun,
  deno,
  cargo,
  go,
  pip,
  pip3: pip,
  poetry,
  uv,
  dotnet,
  make,
  gmake: make,
  mvn: maven,
  mvnw: maven,
  gradle,
  gradlew: gradle,
  docker,
  podman: docker,
  'docker-compose': (args, ctx) => docker(['compose', ...args], ctx, 'docker'),
  kubectl,
  helm,
  terraform,
  tofu: terraform,
  conda,
  mamba: conda,
  pulumi,
  gh: forgeCli,
  glab: forgeCli,
  ...Object.fromEntries(
    [
      'aws',
      'gcloud',
      'gsutil',
      'az',
      'doctl',
      'fly',
      'flyctl',
      'heroku',
      'vercel',
      'netlify',
      'wrangler',
      'firebase',
      'railway',
      'supabase',
      'eb',
      'sam',
      'cdk',
      'serverless',
      'sls',
    ].map((name) => [name, cloudCli]),
  ),
  ...Object.fromEntries(
    [
      'brew',
      'apt',
      'apt-get',
      'yum',
      'dnf',
      'pacman',
      'zypper',
      'apk',
      'snap',
      'flatpak',
      'choco',
      'winget',
      'scoop',
      'port',
      'nix-env',
    ].map((name) => [name, systemPackages]),
  ),
  ...Object.fromEntries(Object.entries(languageTools).map(([name, spec]) => [name, tool(spec)])),
};

/** Classifies `python -m pip ...` like `pip ...` (prefix counted from the module word). */
export function classifyPipModule(args: string[]): Verdict {
  return readOnlyOptions(pipTool, args, classifyTool(pipTool, args, 'pip'), 'pip');
}
