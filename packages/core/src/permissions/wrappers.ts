import { parseOptions, type OptionSpec } from './options.js';
import { firstOperandIndex, isOption, network, normal, own, type Finding } from './risk-helpers.js';
import {
  NPM_VALUE_OPTIONS,
  PNPM_VALUE_OPTIONS,
  POETRY_VALUE_OPTIONS,
  UV_VALUE_OPTIONS,
  YARN_VALUE_OPTIONS,
} from './tool-rules.js';

/** Result of stepping over a wrapper such as `env`, `timeout 5`, `xargs -0` or `npx`. */
export interface WrapperStep {
  /** Index of the wrapped command's first word. */
  next: number;
  finding?: Finding;
  /**
   * Launchers (`npx`, `pnpm exec`, `uv run`) select an environment, so they stay part of the
   * command's rule prefix. Transparent wrappers (`env`, `time`, `nice`) do not.
   */
  launcher?: boolean;
  /** True when approvals of the wrapped command must not be remembered for the session. */
  forget?: boolean;
  /** `NAME=value` words the wrapper puts in the command's environment (`env FOO=1 cmd`). */
  assignments?: string[];
}

/** Returns undefined when the word at `index` is not acting as a wrapper (e.g. `command -v`). */
type Wrapper = (words: readonly string[], index: number) => WrapperStep | undefined;

const set = (...values: string[]): ReadonlySet<string> => new Set(values);

/**
 * Words after a wrapper that are read to find the wrapped command. Wrappers are stepped over one
 * after another (`env timeout 5 nice ...`), so each step must only look at a bounded window to
 * keep the whole analysis linear; a wrapper with more options than that is not understood.
 */
const WINDOW = 64;

/** The words after the wrapper at `index`, at most WINDOW of them. */
function windowAfter(words: readonly string[], index: number): string[] {
  return words.slice(index + 1, index + 1 + WINDOW);
}

/** Index of the first word at or after `start` that is not an option (or an option's value). */
function skipOptions(
  words: readonly string[],
  start: number,
  valueOptions: ReadonlySet<string>,
): number {
  let i = start;
  while (i < words.length) {
    const word = words[i];
    if (word === '--') return i + 1;
    if (!isOption(word)) return i;
    i += valueOptions.has(word) ? 2 : 1;
  }
  return i;
}

/**
 * A transparent wrapper whose options are allowlisted: an option it does not know (BSD
 * `env -P dir` picks the program from another directory) makes the command ask, every time.
 */
function transparent(
  spec: OptionSpec,
  extra?: (options: readonly string[]) => Partial<WrapperStep>,
): Wrapper {
  return (words, index) => {
    const rest = windowAfter(words, index);
    const parsed = parseOptions(rest, { ...spec, stopAtOperand: true });
    if (
      parsed.unknown !== undefined ||
      (parsed.firstOperandAt === undefined && rest.length === WINDOW)
    ) {
      return {
        next: skipOptions(words, index + 1, set()),
        finding: normal(
          `Uses an option that is not known to be harmless (${words[index]} ${parsed.unknown ?? '...'})`,
        ),
        forget: true,
      };
    }
    const next = index + 1 + (parsed.firstOperandAt ?? rest.length);
    return { next, ...extra?.(words.slice(index + 1, next)) };
  };
}

const ENV_SPEC: OptionSpec = {
  short: 'i0v',
  shortValue: 'uC',
  long: ['--ignore-environment', '--null', '--debug'],
  longValue: ['--unset', '--chdir'],
  stopAtOperand: true,
};
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `env [options] [-] [NAME=value]... command`; `env -S "..."` is analyzed as a script instead. */
const env: Wrapper = (words, index) => {
  const rest = windowAfter(words, index);
  const firstOperand = rest.findIndex((word) => !isOption(word));
  const options = firstOperand < 0 ? rest : rest.slice(0, firstOperand);
  if (options.some((word) => /^-[A-Za-z0-9]*S/.test(word) || word.startsWith('--split-string'))) {
    return undefined;
  }
  const parsed = parseOptions(rest, ENV_SPEC);
  let finding: Finding | undefined;
  let forget = false;
  let i: number;
  if (
    parsed.unknown !== undefined ||
    (parsed.firstOperandAt === undefined && rest.length === WINDOW)
  ) {
    finding = normal(
      `Uses an option that is not known to be harmless (env ${parsed.unknown ?? '...'})`,
    );
    forget = true;
    i = skipOptions(words, index + 1, set('-u', '--unset', '-C', '--chdir'));
  } else {
    i = index + 1 + (parsed.firstOperandAt ?? rest.length);
    if (parsed.used.includes('-C') || parsed.used.includes('--chdir')) {
      finding = normal('Runs the command in another directory (env -C)');
      forget = true;
    }
  }
  if (words[i] === '-') i++;
  const assignments: string[] = [];
  while (i < words.length && ASSIGNMENT.test(words[i])) assignments.push(words[i++]);
  return { next: i, finding, forget, assignments };
};

const time = transparent(
  {
    short: 'pavq',
    shortValue: 'of',
    long: ['--portability', '--append', '--verbose', '--quiet'],
    longValue: ['--output', '--format'],
  },
  // `-o FILE` overwrites any file (`.git/hooks/x`, `~/.bashrc`) whatever the timed command is.
  (options) =>
    options.some((w) => /^-[A-Za-z]*o/.test(w) || w.startsWith('--output') || w.startsWith('--o'))
      ? { finding: normal('Writes timing output to a file (time -o)'), forget: true }
      : {},
);

const nice = transparent({ shortValue: 'n', numeric: true, longValue: ['--adjustment'] });

const nohup: Wrapper = (_words, index) => ({
  next: index + 1,
  finding: normal('Keeps running after the session ends (nohup)'),
});

const command: Wrapper = (words, index) => {
  const options = words.slice(index + 1, skipOptions(words, index + 1, set()));
  if (options.some((option) => /^-[A-Za-z]*[vV]/.test(option))) return undefined;
  if (options.some((option) => !/^-p+$/.test(option))) {
    return {
      next: index + 1 + options.length,
      finding: normal(
        `Uses an option that is not known to be harmless (command ${options.join(' ')})`,
      ),
      forget: true,
    };
  }
  return { next: index + 1 + options.length };
};

const exec = transparent({ short: 'cl', shortValue: 'a' });

const passThrough: Wrapper = (_words, index) => ({ next: index + 1 });

const TIMEOUT_SPEC: OptionSpec = {
  short: 'v',
  shortValue: 'sk',
  long: ['--preserve-status', '--foreground', '--verbose'],
  longValue: ['--signal', '--kill-after'],
};

/** `timeout [options] DURATION command...`. */
const timeout: Wrapper = (words, index) => {
  const step = transparent(TIMEOUT_SPEC)(words, index);
  if (!step) return undefined;
  return { ...step, next: step.next + 1 };
};

const XARGS_VALUE_OPTIONS = set(
  '-a',
  '-d',
  '-E',
  '-I',
  '-L',
  '-n',
  '-P',
  '-s',
  '--arg-file',
  '--delimiter',
  '--eof',
  '--max-lines',
  '--max-args',
  '--max-procs',
  '--max-chars',
  '--process-slot-var',
);

/**
 * The wrapped command's arguments (file names, often) are only known when it runs, so an
 * approval of `xargs cat` must not carry over to the next one (`... | xargs cat` of `.env`).
 */
const xargs: Wrapper = (words, index) => ({
  next: skipOptions(words, index + 1, XARGS_VALUE_OPTIONS),
  finding: normal('Runs a command with arguments read from input (xargs)'),
  forget: true,
});

const stdbuf = transparent({ shortValue: 'ioe', longValue: ['--input', '--output', '--error'] });

const NETWORK_LAUNCH = (what: string): Finding =>
  network(`Runs a package that may be downloaded (${what})`);

const launcher =
  (valueOptions: ReadonlySet<string>, finding?: Finding, subcommandWords = 0): Wrapper =>
  (words, index) => ({
    next: skipOptions(words, index + 1 + subcommandWords, valueOptions),
    launcher: true,
    finding,
  });

const npx = launcher(set('-p', '--package', '-c', '--call'), NETWORK_LAUNCH('npx'));
const bunx = launcher(set('-p', '--package'), NETWORK_LAUNCH('bunx'));
const uvx = launcher(set('--from', '--with', '--python', '-p', '--index'), NETWORK_LAUNCH('uvx'));

/** Launcher options that run the command in another directory (`pnpm -C dir exec`). */
const DIRECTORY_OPTION = /^(-[CP]|--(dir|directory|cwd|prefix|project|workspace-dir|chdir)(=|$))/;

/**
 * `<tool> [global options] <subcommand> ...` launchers, e.g. `pnpm exec`, `uv run`, `poetry run`.
 * They run the command in the project's environment, which they may first create or update
 * (installing packages, running build hooks or a Gemfile), so the command is at least normal.
 * Directory options make its relative paths uncheckable: then it is never remembered.
 */
function subcommandLauncher(
  launchers: Readonly<Record<string, { valueOptions?: ReadonlySet<string>; network?: boolean }>>,
  globalValueOptions: ReadonlySet<string> = set(),
): Wrapper {
  return (words, index) => {
    const rest = windowAfter(words, index);
    const subIndex = firstOperandIndex(rest, globalValueOptions);
    const sub = subIndex < 0 ? undefined : rest[subIndex];
    let spec = sub === undefined ? undefined : own(launchers, sub);
    let consumed = subIndex + 1;
    if (sub !== undefined && !spec) {
      const pair = `${sub} ${rest[subIndex + 1] ?? ''}`;
      spec = launchers[pair];
      consumed = subIndex + 2;
    }
    if (!spec || sub === undefined) return undefined;
    const label = `${words[index]} ${rest.slice(subIndex, consumed).join(' ')}`;
    const next = skipOptions(words, index + 1 + consumed, spec.valueOptions ?? set());
    const elsewhere = words.slice(index + 1, next).find((word) => DIRECTORY_OPTION.test(word));
    let finding: Finding;
    if (spec.network) finding = NETWORK_LAUNCH(label);
    else if (elsewhere !== undefined) {
      finding = normal(`Runs the command in another directory (${label} ${elsewhere})`);
    } else {
      finding = normal(
        `Runs the command in the project environment, which may set it up (${label})`,
      );
    }
    return { next, launcher: true, finding, forget: elsewhere !== undefined };
  };
}

const UV_RUN_VALUE_OPTIONS = set(
  '--with',
  '--with-requirements',
  '--with-editable',
  '--python',
  '-p',
  '--env-file',
  '--directory',
  '--project',
  '--package',
  '--extra',
  '--group',
  '--index',
  '--default-index',
);

export const WRAPPERS: Readonly<Record<string, Wrapper>> = {
  env,
  time,
  nice,
  nohup,
  command,
  builtin: passThrough,
  call: passThrough,
  exec,
  timeout,
  xargs,
  stdbuf,
  npx,
  pnpx: npx,
  bunx,
  uvx,
  npm: subcommandLauncher(
    {
      exec: { valueOptions: set('-p', '--package', '-c', '--call'), network: true },
      x: { network: true },
    },
    NPM_VALUE_OPTIONS,
  ),
  pnpm: subcommandLauncher(
    { exec: { network: true }, dlx: { valueOptions: set('--package', '-c'), network: true } },
    PNPM_VALUE_OPTIONS,
  ),
  yarn: subcommandLauncher(
    {
      dlx: { valueOptions: set('-p', '--package'), network: true },
      exec: { network: true },
    },
    YARN_VALUE_OPTIONS,
  ),
  bun: subcommandLauncher({ x: { valueOptions: set('-p', '--package'), network: true } }),
  uv: subcommandLauncher(
    {
      run: { valueOptions: UV_RUN_VALUE_OPTIONS },
      'tool run': { valueOptions: set('--from', '--with'), network: true },
    },
    UV_VALUE_OPTIONS,
  ),
  poetry: subcommandLauncher({ run: {} }, POETRY_VALUE_OPTIONS),
  pipenv: subcommandLauncher({ run: {} }),
  pdm: subcommandLauncher({ run: {} }),
  hatch: subcommandLauncher({ run: {} }),
  rye: subcommandLauncher({ run: {} }),
  pipx: subcommandLauncher({ run: { valueOptions: set('--spec', '--python'), network: true } }),
  bundle: subcommandLauncher({ exec: {} }),
  conda: subcommandLauncher({
    run: { valueOptions: set('-n', '--name', '-p', '--prefix', '--cwd') },
  }),
};
