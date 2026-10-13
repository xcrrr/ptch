/**
 * Allowlist parsing of program options. A command is only classified safe when every option it
 * uses is on its program's read-only list: options that are not listed (including GNU-style
 * abbreviations such as `--in` for `--in-place`, which programs accept but this parser does not)
 * make the parse fail, and the caller treats the command as at least normal.
 *
 * Specs also say which options take a value, so values are neither mistaken for paths
 * (`head -n 5`, `grep -e /etc`) nor do they hide paths (`grep -f patterns.txt`).
 */
export interface OptionSpec {
  /** Short options without a value; they may be clustered (`-la`). */
  short?: string;
  /** Short options with a value, attached (`-n5`) or as the next word (`-n 5`). */
  shortValue?: string;
  /** Short options whose value is optional and can only be attached (`git log -U3`, `-M50%`). */
  shortOptional?: string;
  /** Long options without a value (`--stat`). `--name=value` is not accepted for them. */
  long?: readonly string[];
  /** Long options with a value: `--name=value` or `--name value`. */
  longValue?: readonly string[];
  /** Long options whose value is optional and can only be attached (`--color`, `--color=never`). */
  longOptional?: readonly string[];
  /** Options (as written in the lists above, e.g. `-f`, `--file`) whose values are files read. */
  pathValues?: readonly string[];
  /** Accepts numeric options such as `head -5` or `git log -3` (recorded as `-#`). */
  numeric?: boolean;
  /** Attached short values drop one leading `=` (`rg -g=x`), as lexopt-based tools do. */
  shortEquals?: boolean;
  /**
   * cmd.exe switches the program accepts, as `/` and one lowercase letter (`/s`); `/a` also
   * allows `/ad`, `/a:-d` and `/a-d`, and `/+` allows `/+3`. Only consulted when the caller says
   * `/x` words are switches.
   */
  switches?: readonly string[];
  /** Options are only recognized before the first operand (BSD/POSIX order, `ssh host ls -l`). */
  stopAtOperand?: boolean;
}

export interface OptionValue {
  /** The option as listed in the spec (`-n`, `--lines`). */
  option: string;
  value: string;
}

export interface ParsedArgs {
  /** Non-option arguments, in order. */
  operands: string[];
  /** Values given to value-taking options, in order. */
  values: OptionValue[];
  /** Every option used, as listed in the spec (`-l`, `--stat`, `/s`). */
  used: string[];
  /** The first argument that is not an allowed option; undefined when every option is allowed. */
  unknown?: string;
  /** Index in `args` of the first operand, when there is one. */
  firstOperandAt?: number;
}

/**
 * `/s`, `/Q`, `/AD`, `/o:n`, `/a-d`, `/+3`: the shape of cmd.exe switches. Longer words such as
 * `/tmp` are paths (Git Bash).
 */
export const SWITCH_WORD = /^\/(?:[A-Za-z?][A-Za-z]?|\+\d+)(?:[:-].*)?$/s;

/**
 * Programs that exist both as cmd.exe commands and on POSIX: on Windows their `/x` arguments are
 * cmd.exe switches, elsewhere paths.
 */
// prettier-ignore
export const DUAL_PROGRAMS: ReadonlySet<string> = new Set([
  'dir', 'rmdir', 'type', 'sort', 'more', 'tree', 'where', 'mkdir', 'shutdown', 'start', 'find',
  'cd', 'chdir',
]);

/** The switch a `/x...` word selects: `/` and its first letter, lowercased (`/AD` → `/a`). */
export function switchName(word: string): string {
  return word.startsWith('/+') ? '/+' : word.slice(0, 2).toLowerCase();
}

/**
 * Parses `args` against an allowlist. `switches`: whether words like `/s` are cmd.exe switches
 * (Windows) rather than paths. Never throws.
 */
export function parseOptions(
  args: readonly string[],
  spec: OptionSpec,
  { switches = false }: { switches?: boolean } = {},
): ParsedArgs {
  const result: ParsedArgs = { operands: [], values: [], used: [] };
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (endOfOptions || arg === '-' || !arg.startsWith('-')) {
      if (!endOfOptions && switches && spec.switches && SWITCH_WORD.test(arg)) {
        const name = switchName(arg);
        if (!spec.switches.includes(name)) return { ...result, unknown: arg };
        result.used.push(name);
        continue;
      }
      result.operands.push(arg);
      result.firstOperandAt ??= i;
      if (spec.stopAtOperand) endOfOptions = true;
      continue;
    }
    if (arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const consumed = parseLong(arg, args[i + 1], spec, result);
      if (consumed === undefined) return { ...result, unknown: arg };
      i += consumed;
      continue;
    }
    if (spec.numeric && /^-\d+$/.test(arg)) {
      result.used.push('-#');
      continue;
    }
    const consumed = parseShortCluster(arg, args[i + 1], spec, result);
    if (consumed === undefined) return { ...result, unknown: arg };
    i += consumed;
  }
  return result;
}

/** Number of extra words consumed (0 or 1), or undefined when the option is not allowed. */
function parseLong(
  arg: string,
  next: string | undefined,
  spec: OptionSpec,
  result: ParsedArgs,
): number | undefined {
  const equals = arg.indexOf('=');
  const name = equals < 0 ? arg : arg.slice(0, equals);
  const inline = equals < 0 ? undefined : arg.slice(equals + 1);
  if (spec.long?.includes(name) && inline === undefined) {
    result.used.push(name);
    return 0;
  }
  if (spec.longOptional?.includes(name)) {
    result.used.push(name);
    if (inline !== undefined) result.values.push({ option: name, value: inline });
    return 0;
  }
  if (spec.longValue?.includes(name)) {
    result.used.push(name);
    if (inline !== undefined) {
      result.values.push({ option: name, value: inline });
      return 0;
    }
    if (next === undefined) return 0;
    result.values.push({ option: name, value: next });
    return 1;
  }
  return undefined;
}

function parseShortCluster(
  arg: string,
  next: string | undefined,
  spec: OptionSpec,
  result: ParsedArgs,
): number | undefined {
  for (let i = 1; i < arg.length; i++) {
    const letter = arg[i];
    const option = `-${letter}`;
    if (spec.short?.includes(letter)) {
      result.used.push(option);
      continue;
    }
    const rest = arg.slice(i + 1);
    if (spec.shortOptional?.includes(letter)) {
      result.used.push(option);
      if (rest !== '') result.values.push({ option, value: rest });
      return 0;
    }
    if (spec.shortValue?.includes(letter)) {
      result.used.push(option);
      if (rest !== '') {
        const value = spec.shortEquals && rest.startsWith('=') ? rest.slice(1) : rest;
        result.values.push({ option, value });
        return 0;
      }
      if (next === undefined) return 0;
      result.values.push({ option, value: next });
      return 1;
    }
    return undefined;
  }
  return 0;
}

/** Operands plus the values of options that name files the program reads. */
export function pathArguments(parsed: ParsedArgs, spec: OptionSpec): string[] {
  const pathOptions = spec.pathValues ?? [];
  return [
    ...parsed.operands,
    ...parsed.values.filter((value) => pathOptions.includes(value.option)).map((v) => v.value),
  ];
}

/** Values given to any of `options` (as listed in the spec). */
export function valuesOf(parsed: ParsedArgs, ...options: string[]): string[] {
  return parsed.values.filter((value) => options.includes(value.option)).map((v) => v.value);
}

// -----------------------------------------------------------------------------------------------
// PowerShell

export interface PowerShellSpec {
  /** Switch parameters, lowercased without the dash (`recurse`). */
  switches?: readonly string[];
  /** Parameters that take a value (`-Path x`, `-Path:x`), lowercased without the dash. */
  values?: readonly string[];
  /** Value parameters whose values are paths the cmdlet reads. */
  paths?: readonly string[];
}

// prettier-ignore
const COMMON_SWITCHES = ['verbose', 'vb', 'debug', 'db'];
// prettier-ignore
const COMMON_VALUES = [
  'erroraction', 'ea', 'warningaction', 'wa', 'informationaction', 'infa', 'progressaction',
  'proga', 'errorvariable', 'ev', 'warningvariable', 'wv', 'informationvariable', 'iv',
  'outvariable', 'ov', 'outbuffer', 'ob', 'pipelinevariable', 'pv',
];

/**
 * Parses PowerShell cmdlet arguments against an allowlist of parameters (names compare ignoring
 * case; common parameters such as `-ErrorAction` are always allowed). Arguments containing braces
 * are script blocks or hashtables (`Where-Object { ... }`, `@{e={...}}`), which run code: they are
 * reported as unknown.
 */
export function parsePowerShellArgs(args: readonly string[], spec: PowerShellSpec): ParsedArgs {
  const result: ParsedArgs = { operands: [], values: [], used: [] };
  const switches = [...(spec.switches ?? []), ...COMMON_SWITCHES];
  const values = [...(spec.values ?? []), ...COMMON_VALUES];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/[{}]/.test(arg)) return { ...result, unknown: arg };
    if (!/^-[A-Za-z]/.test(arg)) {
      result.operands.push(arg);
      continue;
    }
    const colon = arg.indexOf(':');
    const name = (colon < 0 ? arg.slice(1) : arg.slice(1, colon)).toLowerCase();
    if (switches.includes(name)) {
      result.used.push(name);
      continue;
    }
    if (!values.includes(name)) return { ...result, unknown: arg };
    result.used.push(name);
    const value = colon < 0 ? args[++i] : arg.slice(colon + 1);
    if (value !== undefined) result.values.push({ option: name, value });
  }
  return result;
}

/** Operands plus the values of path parameters. */
export function powerShellPaths(parsed: ParsedArgs, spec: PowerShellSpec): string[] {
  const pathParameters = spec.paths ?? [];
  return [
    ...parsed.operands,
    ...parsed.values.filter((value) => pathParameters.includes(value.option)).map((v) => v.value),
  ];
}
