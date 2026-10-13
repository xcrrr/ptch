import {
  DUAL_PROGRAMS,
  SWITCH_WORD,
  parseOptions,
  parsePowerShellArgs,
  pathArguments,
  powerShellPaths,
  valuesOf,
  type OptionSpec,
  type ParsedArgs,
  type PowerShellSpec,
} from './options.js';
import { isHarmlessDevice } from './risk-paths.js';
import {
  abbreviatesLong,
  endOfOptions,
  normal,
  safe,
  type Classifier,
  type ProgramContext,
  type Verdict,
} from './risk-helpers.js';

/**
 * Read-only programs, classified by allowlist: a call is safe only when every option it uses is
 * on the program's list of options that neither write files, run programs, load configuration nor
 * change state. Anything else (an unlisted option, a GNU-style abbreviation, a PowerShell script
 * block) is at least normal; for programs that have options able to write files or run programs
 * (`risky`), such calls are never remembered either.
 */
export interface ReadOnlyEntry {
  /** GNU/BSD-style options (also used for Windows aliases such as `ls` and `cat`). */
  options?: OptionSpec;
  /** PowerShell parameters, for cmdlets (`Get-Content`) and PowerShell-only aliases (`gc`). */
  powershell?: PowerShellSpec;
  /** Operands are text, not files (`echo`, `tr`). */
  text?: boolean;
  /** Every option is read-only (`echo`, `uname`): the program has none that write or run code. */
  anyOption?: boolean;
  /** Only shows names or metadata of the files it is given, never their contents. */
  listsOnly?: boolean;
  /** Has options that write files or run programs: calls with unknown options are never remembered. */
  risky?: boolean;
  /** Reason for safe calls; default "Read-only command (<name>)". */
  reason?: string;
  /** Further classification after the options were accepted (`tee out.txt` writes a file). */
  refine?: (parsed: ParsedArgs, ctx: ProgramContext, name: string) => Verdict | undefined;
}

/**
 * PowerShell provider paths: drives such as `env:`, `HKLM:` and `Cert:` expose environment
 * variables, the registry and certificates, and provider-qualified paths (`Registry::HKCU\x`,
 * `Microsoft.PowerShell.Core\FileSystem::C:\x`) reach any provider. The optional prefix is a
 * parameter name (`-Path:env:`).
 */
const PROVIDER_PATH =
  /^(-[A-Za-z]+:)?([A-Za-z][\w.\\-]*::|(env|variable|cert|hklm|hkcu|wsman|function|alias|registry|temp):)/i;
/**
 * Other PowerShell drives (two or more letters, such as `Temp:` or a mapped drive) are outside the
 * project; one-letter drives are file system paths and checked as such.
 */
const POWERSHELL_DRIVE = /^(-[A-Za-z]+:)?[A-Za-z][\w-]+:(?!\/\/)/;

const CMDLET_NAME = /^[a-z]+-[a-z]+$/i;

/** PowerShell aliases with no POSIX program of the same name. */
// prettier-ignore
const POWERSHELL_ALIASES = new Set([
  'gci', 'gc', 'gi', 'gp', 'gpv', 'rvpa', 'select', '?', 'measure', 'group', 'ft', 'fl', 'fw',
  'compare', 'gv', 'sl', 'gl', 'gcm', 'gal', 'gdr', 'gmo', 'gm', 'gps', 'gsv',
]);

/**
 * Programs that print their arguments: their output is a literal script when piped to a shell,
 * and PowerShell does not run script blocks passed to them.
 */
export const PRINTERS: ReadonlySet<string> = new Set([
  'echo',
  'printf',
  'write-output',
  'write-host',
]);

export function readOnly(entry: ReadOnlyEntry): Classifier {
  return (args, ctx, name) => {
    const key = name.toLowerCase();
    const powershellOnly = CMDLET_NAME.test(name) || POWERSHELL_ALIASES.has(key);
    // On Windows the command may run in PowerShell, where `{...}` is a script block that
    // Where-Object, Sort-Object, Select-Object or a delay-bind parameter runs.
    if (
      (powershellOnly || ctx.platform === 'win32') &&
      !PRINTERS.has(key) &&
      args.some((arg) => /[{}]/.test(arg))
    ) {
      return normal(`May run a PowerShell script block (${name})`, { rememberable: false });
    }
    const powershellPaths = powershellOnly || ctx.platform === 'win32';
    if (
      !entry.text &&
      args.some((arg) => PROVIDER_PATH.test(arg) || (powershellPaths && POWERSHELL_DRIVE.test(arg)))
    ) {
      return normal(
        `Reads a PowerShell drive outside the project, such as environment variables or the registry (${name})`,
        { paths: [], rememberable: false },
      );
    }
    const parsed = parseEntry(entry, args, ctx, key, powershellOnly);
    if (parsed.unknown !== undefined) {
      return normal(
        `Uses an option that is not known to be read-only (${name} ${parsed.unknown})`,
        {
          rememberable: !entry.risky,
        },
      );
    }
    const paths = entry.text
      ? []
      : powershellOnly && entry.powershell
        ? powerShellPaths(parsed, entry.powershell)
        : pathArguments(parsed, entry.options ?? {});
    const refined = entry.refine?.(parsed, ctx, name);
    if (refined) return { paths, ...refined };
    return safe(entry.reason ?? `Read-only command (${name})`, {
      paths,
      ...(entry.listsOnly ? { listsOnly: true } : {}),
    });
  };
}

function parseEntry(
  entry: ReadOnlyEntry,
  args: readonly string[],
  ctx: ProgramContext,
  key: string,
  powershellOnly: boolean,
): ParsedArgs {
  if (powershellOnly && entry.powershell) return parsePowerShellArgs(args, entry.powershell);
  if (entry.anyOption) {
    return { operands: args.filter((arg) => !arg.startsWith('-')), values: [], used: [] };
  }
  const switches = ctx.platform === 'win32' && DUAL_PROGRAMS.has(key);
  return parseOptions(args, entry.options ?? {}, { switches });
}

// -----------------------------------------------------------------------------------------------
// Output-only programs: print information unrelated to file contents; arguments are not paths.

const TEXT: ReadOnlyEntry = { anyOption: true, text: true };

// prettier-ignore
const TEXT_PROGRAMS = [
  'echo', 'true', 'false', ':', 'sleep', 'seq', 'yes', 'cal', 'uname', 'whoami', 'id', 'groups',
  'uptime', 'nproc', 'arch', 'tty', 'locale', 'which', 'where', 'whereis', 'basename', 'dirname',
  'test', '[', 'clear', 'cls', 'free', 'sw_vers', 'lsb_release', 'ver', 'vol', 'wait',
  'jobs', 'pwd', 'unset',
];

/** Arithmetic comparison operators that make `[[ ... ]]` evaluate its operands as arithmetic. */
const ARITHMETIC_COMPARISONS = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge']);
const INTEGER_LITERAL = /^[+-]?\d+$/;

/**
 * `[[ ... ]]`: a string test is read-only, but a numeric comparison (`-eq`, `-lt`, ...) makes bash
 * evaluate its operands as arithmetic, which re-parses an operand and runs command substitution
 * hidden in an array subscript — even when single-quoted or carried by a variable
 * (`[[ 'a[$(cmd)]' -eq 1 ]]`, `[[ $x -eq 1 ]]`). Unless every compared operand is a plain integer
 * literal, such a call is never safe and never remembered.
 */
const doubleBracket: Classifier = (args, _ctx, name) => {
  if (args.some((arg) => ARITHMETIC_COMPARISONS.has(arg))) {
    const compared = args.filter(
      (arg) =>
        !arg.startsWith('-') &&
        arg !== ']]' &&
        arg !== '(' &&
        arg !== ')' &&
        arg !== '&&' &&
        arg !== '||',
    );
    if (compared.some((operand) => !INTEGER_LITERAL.test(operand))) {
      return normal(`Evaluates an arithmetic comparison that can run commands (${name})`, {
        paths: [],
        rememberable: false,
      });
    }
  }
  return safe(`Read-only command (${name})`, { paths: [] });
};

/** `printf -v NAME` assigns a shell variable (`printf -v PATH ...` changes what later runs). */
const printf: ReadOnlyEntry = { options: { long: ['--help', '--version'] }, text: true };

/** BSD-style `ps e`/`ps -E` print every process's environment, which may hold secrets. */
const ps: ReadOnlyEntry = {
  text: true,
  options: {
    short: 'aAcdefFHjlLmMNrsSTuvwxXyZ',
    shortValue: 'CgGopqstUO',
    long: ['--forest', '--headers', '--no-headers', '--help', '--version', '--cumulative'],
    longValue: [
      '--format',
      '--pid',
      '--ppid',
      '--user',
      '--group',
      '--sort',
      '--cols',
      '--columns',
      '--lines',
      '--rows',
      '--tty',
    ],
  },
  refine: (parsed) =>
    parsed.operands.some((operand) => !/^(\d+|[auxwfjlrsvcTSmhHgnZ]+)$/.test(operand))
      ? normal('Shows process environments, which may contain secrets (ps e)', {
          paths: [],
          concern: 'secret',
        })
      : undefined,
};

/**
 * `man -P <cmd>`, `-H <browser>` and `--pager` run programs, and `-l` formats a local file. Page
 * names with a slash (`man ./.env`) are local files as well, which man prints: they are checked
 * as paths.
 */
const man: ReadOnlyEntry = {
  text: true,
  risky: true,
  options: {
    short: 'afkwW',
    shortValue: 'S',
    long: ['--all', '--apropos', '--whatis', '--where', '--path', '--help', '--version'],
    longValue: ['--sections'],
  },
  refine: (parsed) => {
    const files = parsed.operands.filter((operand) => /[\\/]/.test(operand));
    return files.length > 0
      ? safe('Formats a manual page file (man)', { paths: files })
      : undefined;
  },
};

const help: ReadOnlyEntry = { text: true, options: { short: 'dms' } };

// -----------------------------------------------------------------------------------------------
// Files and directories

const COMMON_LONG = ['--help', '--version'];

const ls: ReadOnlyEntry = {
  listsOnly: true,
  options: {
    // GNU and BSD letters; options that take a value in one of them (GNU -I, -T, -w; BSD -D) are
    // treated as flags, so a following word is still checked as a path.
    short: '1@%,ABCDFGHILOPRSTUWXZabcdefghiklmnopqrstuvwxy',
    long: [
      ...COMMON_LONG,
      '--all',
      '--almost-all',
      '--author',
      '--escape',
      '--directory',
      '--dired',
      '--file-type',
      '--full-time',
      '--group-directories-first',
      '--no-group',
      '--human-readable',
      '--si',
      '--dereference-command-line',
      '--dereference-command-line-symlink-to-dir',
      '--inode',
      '--kibibytes',
      '--dereference',
      '--numeric-uid-gid',
      '--literal',
      '--hide-control-chars',
      '--show-control-chars',
      '--quote-name',
      '--reverse',
      '--recursive',
      '--size',
      '--context',
      '--zero',
      '--ignore-backups',
    ],
    longValue: [
      '--block-size',
      '--format',
      '--hide',
      '--ignore',
      '--indicator-style',
      '--quoting-style',
      '--sort',
      '--time',
      '--time-style',
      '--tabsize',
      '--width',
    ],
    longOptional: ['--color', '--colour', '--hyperlink', '--classify'],
    switches: ['/a', '/b', '/c', '/d', '/l', '/n', '/o', '/p', '/q', '/r', '/s', '/t', '/w', '/x'],
  },
  powershell: {
    switches: [
      'recurse',
      'r',
      's',
      'force',
      'name',
      'directory',
      'ad',
      'd',
      'file',
      'af',
      'hidden',
      'ah',
      'h',
      'readonly',
      'ar',
      'system',
      'as',
      'followsymlink',
    ],
    values: [
      'path',
      'literalpath',
      'lp',
      'pspath',
      'filter',
      'include',
      'exclude',
      'depth',
      'attributes',
    ],
    paths: ['path', 'literalpath', 'lp', 'pspath'],
  },
};

const cat: ReadOnlyEntry = {
  options: {
    short: 'AbeEnstTuvl',
    long: [
      ...COMMON_LONG,
      '--show-all',
      '--number-nonblank',
      '--show-ends',
      '--number',
      '--squeeze-blank',
      '--show-tabs',
      '--show-nonprinting',
    ],
  },
  powershell: {
    switches: ['raw', 'wait', 'asbytestream', 'force'],
    values: [
      'path',
      'literalpath',
      'lp',
      'pspath',
      'totalcount',
      'head',
      'first',
      'tail',
      'last',
      'readcount',
      'encoding',
      'delimiter',
      'stream',
      'filter',
      'include',
      'exclude',
    ],
    paths: ['path', 'literalpath', 'lp', 'pspath'],
  },
};

const head: ReadOnlyEntry = {
  options: {
    short: 'qvz',
    shortValue: 'nc',
    numeric: true,
    long: [...COMMON_LONG, '--quiet', '--silent', '--verbose', '--zero-terminated'],
    longValue: ['--lines', '--bytes'],
  },
};

const tail: ReadOnlyEntry = {
  options: {
    short: 'fFqvzr',
    shortValue: 'ncsb',
    numeric: true,
    long: [...COMMON_LONG, '--retry', '--quiet', '--silent', '--verbose', '--zero-terminated'],
    longValue: ['--lines', '--bytes', '--sleep-interval', '--pid', '--max-unchanged-stats'],
    longOptional: ['--follow'],
  },
};

/**
 * `wc --files0-from=F` reads and counts every NUL-separated file named in F (or on stdin with
 * `-`), so it can reach secret or outside-project files the operand check never sees: not
 * allowlisted, so such a call asks.
 */
const wc: ReadOnlyEntry = {
  risky: true,
  options: {
    short: 'cmlLw',
    long: [...COMMON_LONG, '--bytes', '--chars', '--lines', '--max-line-length', '--words'],
    longValue: ['--total'],
  },
};

/** `file -z` runs decompression programs; `-m` and `-C` load and compile magic files. */
const file: ReadOnlyEntry = {
  listsOnly: true,
  options: {
    short: 'bdEhiIkLlNnprsSv0',
    shortValue: 'eFfP',
    long: [
      ...COMMON_LONG,
      '--brief',
      '--debug',
      '--dereference',
      '--no-dereference',
      '--keep-going',
      '--list',
      '--no-buffer',
      '--no-pad',
      '--preserve-date',
      '--raw',
      '--special-files',
      '--print0',
      '--mime',
      '--mime-type',
      '--mime-encoding',
      '--extension',
      '--apple',
    ],
    longValue: ['--exclude', '--exclude-quiet', '--separator', '--files-from', '--parameter'],
    pathValues: ['-f', '--files-from'],
  },
};

const stat: ReadOnlyEntry = {
  listsOnly: true,
  options: {
    short: 'LftZFnqrsxl',
    shortValue: 'c',
    long: [...COMMON_LONG, '--dereference', '--file-system', '--terse'],
    longValue: ['--format', '--printf', '--cached'],
  },
};

const du: ReadOnlyEntry = {
  listsOnly: true,
  risky: true,
  options: {
    short: 'abcDhHklLmPsSx0Ag',
    shortValue: 'dBtXI',
    long: [
      ...COMMON_LONG,
      '--all',
      '--apparent-size',
      '--bytes',
      '--total',
      '--dereference-args',
      '--human-readable',
      '--inodes',
      '--dereference',
      '--count-links',
      '--no-dereference',
      '--separate-dirs',
      '--si',
      '--summarize',
      '--one-file-system',
      '--null',
    ],
    longValue: [
      '--block-size',
      '--max-depth',
      '--threshold',
      '--exclude',
      '--exclude-from',
      '--time-style',
    ],
    longOptional: ['--time'],
    pathValues: ['-X', '--exclude-from'],
  },
};

const df: ReadOnlyEntry = {
  listsOnly: true,
  options: {
    short: 'ahHiklPTv',
    shortValue: 'Btx',
    long: [
      ...COMMON_LONG,
      '--all',
      '--human-readable',
      '--si',
      '--inodes',
      '--local',
      '--no-sync',
      '--sync',
      '--portability',
      '--print-type',
      '--total',
    ],
    longValue: ['--block-size', '--type', '--exclude-type'],
    longOptional: ['--output'],
  },
};

/** `tree -o FILE` writes its output to a file. */
const tree: ReadOnlyEntry = {
  listsOnly: true,
  risky: true,
  options: {
    short: 'adfilxpsugDFqNQrtcvUCAJXhnS',
    shortValue: 'LPIHT',
    long: [
      ...COMMON_LONG,
      '--noreport',
      '--dirsfirst',
      '--filesfirst',
      '--prune',
      '--du',
      '--si',
      '--matchdirs',
      '--ignore-case',
      '--gitignore',
      '--nolinks',
      '--metafirst',
      '--info',
    ],
    longValue: ['--charset', '--filelimit', '--timefmt', '--sort', '--gitfile'],
    pathValues: ['--gitfile'],
    switches: ['/f', '/a'],
  },
};

/**
 * Recursive `diff -r` and `-N` (absent files compare as empty) print whole files, `.env`
 * included, like `grep -r`. `-l`/`--paginate` runs `pr`.
 */
const diff: ReadOnlyEntry = {
  options: {
    short: 'abBcdeEfinNpqrstTuvwy',
    shortValue: 'CDFILSUWxX',
    numeric: true,
    long: [
      ...COMMON_LONG,
      '--normal',
      '--brief',
      '--report-identical-files',
      '--ed',
      '--rcs',
      '--side-by-side',
      '--left-column',
      '--suppress-common-lines',
      '--show-c-function',
      '--expand-tabs',
      '--initial-tab',
      '--suppress-blank-empty',
      '--text',
      '--strip-trailing-cr',
      '--ignore-case',
      '--ignore-tab-expansion',
      '--ignore-trailing-space',
      '--ignore-space-change',
      '--ignore-all-space',
      '--ignore-blank-lines',
      '--minimal',
      '--speed-large-files',
      '--new-file',
      '--unidirectional-new-file',
      '--recursive',
      '--no-dereference',
      '--ignore-file-name-case',
      '--no-ignore-file-name-case',
    ],
    longValue: [
      '--show-function-line',
      '--label',
      '--width',
      '--tabsize',
      '--exclude',
      '--exclude-from',
      '--starting-file',
      '--ifdef',
      '--ignore-matching-lines',
      '--line-format',
      '--old-line-format',
      '--new-line-format',
      '--unchanged-line-format',
      '--old-group-format',
      '--new-group-format',
      '--changed-group-format',
      '--unchanged-group-format',
      '--horizon-lines',
      '--to-file',
      '--from-file',
      '--palette',
    ],
    longOptional: ['--context', '--unified', '--color'],
    pathValues: ['-X', '--exclude-from', '--to-file', '--from-file'],
  },
  refine: (parsed, _ctx, name) =>
    parsed.used.some((option) =>
      ['-r', '--recursive', '-N', '--new-file', '--unidirectional-new-file'].includes(option),
    )
      ? normal(
          `Compares directories recursively, including files that may contain secrets (${name} -r)`,
          {
            rememberable: false,
            concern: 'secret',
          },
        )
      : undefined,
};

const cmp: ReadOnlyEntry = {
  options: {
    short: 'blsv',
    shortValue: 'in',
    long: [...COMMON_LONG, '--print-bytes', '--verbose', '--quiet', '--silent'],
    longValue: ['--ignore-initial', '--bytes'],
  },
};

const comm: ReadOnlyEntry = {
  options: {
    short: '123z',
    long: [...COMMON_LONG, '--check-order', '--nocheck-order', '--total', '--zero-terminated'],
    longValue: ['--output-delimiter'],
  },
};

const cut: ReadOnlyEntry = {
  options: {
    short: 'nsz',
    shortValue: 'bcdf',
    long: [...COMMON_LONG, '--complement', '--only-delimited', '--zero-terminated'],
    longValue: ['--bytes', '--characters', '--delimiter', '--fields', '--output-delimiter'],
  },
};

/** tr only reads standard input; its operands are character sets. */
const tr: ReadOnlyEntry = {
  text: true,
  options: {
    short: 'cCdst',
    long: [...COMMON_LONG, '--complement', '--delete', '--squeeze-repeats', '--truncate-set1'],
  },
};

const nl: ReadOnlyEntry = {
  options: {
    short: 'p',
    shortValue: 'bdfhilnsvw',
    long: [...COMMON_LONG, '--no-renumber'],
    longValue: [
      '--body-numbering',
      '--section-delimiter',
      '--footer-numbering',
      '--header-numbering',
      '--line-increment',
      '--join-blank-lines',
      '--number-format',
      '--number-separator',
      '--starting-line-number',
      '--number-width',
    ],
  },
};

const simpleText = (spec: OptionSpec): ReadOnlyEntry => ({
  options: { ...spec, long: [...COMMON_LONG, ...(spec.long ?? [])] },
});

const tac = simpleText({
  short: 'br',
  shortValue: 's',
  long: ['--before', '--regex'],
  longValue: ['--separator'],
});
const rev = simpleText({ short: '0' });
const fold = simpleText({
  short: 'bs',
  shortValue: 'w',
  numeric: true,
  long: ['--bytes', '--spaces'],
  longValue: ['--width'],
});
const fmt = simpleText({
  short: 'cstu',
  shortValue: 'pwg',
  numeric: true,
  long: ['--crown-margin', '--split-only', '--tagged-paragraph', '--uniform-spacing'],
  longValue: ['--prefix', '--width', '--goal'],
});
const column = simpleText({
  short: 'tnxeJLdr',
  shortValue: 'csoNEHRTWl',
  long: ['--table', '--json', '--fillrows', '--keep-empty-lines'],
  longValue: [
    '--columns',
    '--separator',
    '--output-separator',
    '--table-columns',
    '--table-name',
    '--table-right',
    '--table-hide',
    '--table-order',
    '--table-wrap',
    '--table-truncate',
    '--table-noextreme',
    '--tree',
    '--tree-id',
    '--tree-parent',
    '--output-width',
  ],
});
const paste = simpleText({
  short: 'sz',
  shortValue: 'd',
  long: ['--serial', '--zero-terminated'],
  longValue: ['--delimiters'],
});
const join = simpleText({
  short: 'iz',
  shortValue: 'aejotv12',
  long: ['--ignore-case', '--check-order', '--nocheck-order', '--header', '--zero-terminated'],
});
const expand = simpleText({
  short: 'ia',
  shortValue: 't',
  numeric: true,
  long: ['--initial', '--all', '--first-only'],
  longValue: ['--tabs'],
});
const od = simpleText({
  short: 'abcdfhilosvxBDeFHILOX',
  shortValue: 'AjNSt',
  shortOptional: 'w',
  long: ['--output-duplicates', '--traditional'],
  longValue: ['--address-radix', '--endian', '--skip-bytes', '--read-bytes', '--format'],
  longOptional: ['--width', '--strings'],
});
const hexdump: ReadOnlyEntry = {
  options: { short: 'bcCdoxvL', shortValue: 'efns', pathValues: ['-f'], long: COMMON_LONG },
};
const strings = simpleText({
  short: 'adfowhv',
  shortValue: 'ntesTU',
  numeric: true,
  long: ['--all', '--data', '--print-file-name', '--include-all-whitespace'],
  longValue: ['--bytes', '--radix', '--encoding', '--target', '--output-separator', '--unicode'],
});
const checksum = simpleText({
  short: 'bctwzqrsUpx0',
  shortValue: 'al',
  long: [
    '--binary',
    '--check',
    '--tag',
    '--text',
    '--zero',
    '--ignore-missing',
    '--quiet',
    '--status',
    '--strict',
    '--warn',
    '--base64',
    '--raw',
    '--untagged',
    '--sysv',
  ],
  longValue: ['--algorithm', '--length'],
});
/** BSD `base64 -o FILE` writes a file; `-i FILE` (BSD) is checked as a path operand. */
const base64 = simpleText({
  short: 'dDi',
  shortValue: 'wb',
  long: ['--decode', '--ignore-garbage'],
  longValue: ['--wrap'],
});

const realpath: ReadOnlyEntry = {
  listsOnly: true,
  options: {
    short: 'emLPqsz',
    long: [
      ...COMMON_LONG,
      '--canonicalize-existing',
      '--canonicalize-missing',
      '--logical',
      '--physical',
      '--quiet',
      '--strip',
      '--no-symlinks',
      '--zero',
    ],
    longValue: ['--relative-to', '--relative-base'],
    pathValues: ['--relative-to', '--relative-base'],
  },
};

const readlink: ReadOnlyEntry = {
  listsOnly: true,
  options: {
    short: 'femnqsvz',
    long: [
      ...COMMON_LONG,
      '--canonicalize',
      '--canonicalize-existing',
      '--canonicalize-missing',
      '--no-newline',
      '--quiet',
      '--silent',
      '--verbose',
      '--zero',
    ],
  },
};

/** eza/exa/lsd list names; `--git` reads repository status. */
const eza: ReadOnlyEntry = {
  listsOnly: true,
  options: {
    short: '1lGxRFTaAdDfrSbBghHimnuUZ@MoX',
    shortValue: 'LsItw',
    long: [
      ...COMMON_LONG,
      '--long',
      '--oneline',
      '--grid',
      '--across',
      '--recurse',
      '--tree',
      '--all',
      '--almost-all',
      '--list-dirs',
      '--only-dirs',
      '--only-files',
      '--reverse',
      '--header',
      '--links',
      '--inode',
      '--modified',
      '--changed',
      '--accessed',
      '--created',
      '--blocksize',
      '--octal-permissions',
      '--no-icons',
      '--no-permissions',
      '--no-filesize',
      '--no-user',
      '--no-time',
      '--git',
      '--no-git',
      '--git-ignore',
      '--group-directories-first',
      '--binary',
      '--bytes',
      '--group',
      '--smart-group',
      '--numeric',
      '--extended',
      '--dereference',
      '--mounts',
      '--total-size',
      '--directory',
      '--human-readable',
      '--classify',
    ],
    longValue: [
      '--level',
      '--sort',
      '--ignore-glob',
      '--time-style',
      '--time',
      '--width',
      '--depth',
    ],
    longOptional: ['--icons', '--color', '--colour', '--hyperlink'],
  },
};

const decompress = simpleText({ short: 'fqvltcdkhL', shortValue: 'T' });
const look = simpleText({ short: 'bdf', shortValue: 't' });
const getfacl: ReadOnlyEntry = {
  listsOnly: true,
  options: {
    short: 'acdeEnpRLPst',
    long: [
      ...COMMON_LONG,
      '--access',
      '--omit-header',
      '--all-effective',
      '--no-effective',
      '--skip-base',
      '--recursive',
      '--logical',
      '--physical',
      '--tabular',
      '--numeric',
      '--absolute-names',
      '--default',
    ],
  },
};
const lsattr: ReadOnlyEntry = { listsOnly: true, options: { short: 'RVadlpv' } };
/** bash `type -a` describes commands; cmd's `type` prints files (operands are checked as paths). */
const type: ReadOnlyEntry = { options: { short: 'aftpP' } };
/**
 * `cd dir` only changes the directory the rest of the command runs in (checked as a path). `cd`
 * alone goes to the home directory and `cd -` to the previous one, both outside the project or
 * unknown: later commands without paths (`rg KEY`, `ls`) would read there.
 */
const cd: ReadOnlyEntry = {
  listsOnly: true,
  options: { short: 'LPe@n', numeric: true, switches: ['/d'] },
  powershell: {
    switches: ['passthru'],
    values: ['path', 'literalpath', 'lp', 'pspath', 'stackname'],
  },
  refine: (parsed, _ctx, name) => {
    // `pushd` and `popd` without a directory move within the directory stack, which only holds
    // directories this command entered.
    if (/^(pushd|popd)$/i.test(name)) return undefined;
    const targets = [
      ...parsed.operands,
      ...valuesOf(parsed, 'path', 'literalpath', 'lp', 'pspath'),
    ];
    if (targets.length === 0) {
      return normal(`Changes to the home directory, outside the project (${name})`, {
        paths: [],
        rememberable: false,
      });
    }
    return targets.includes('-')
      ? normal(`Changes to the previous directory, which may be outside the project (${name} -)`, {
          paths: [],
          rememberable: false,
        })
      : undefined;
  },
};

// -----------------------------------------------------------------------------------------------
// PowerShell cmdlets

const ps1 = (spec: PowerShellSpec, extra: Partial<ReadOnlyEntry> = {}): ReadOnlyEntry => ({
  powershell: spec,
  ...extra,
});

const PATH_VALUES = ['path', 'literalpath', 'lp', 'pspath'];
const FILTER_VALUES = ['filter', 'include', 'exclude'];

const getItem = ps1(
  { switches: ['force'], values: [...PATH_VALUES, ...FILTER_VALUES, 'stream'], paths: PATH_VALUES },
  { listsOnly: true },
);
const getItemProperty = ps1(
  { values: [...PATH_VALUES, ...FILTER_VALUES, 'name'], paths: PATH_VALUES },
  { listsOnly: true },
);
const testPath = ps1(
  {
    switches: ['isvalid'],
    values: [...PATH_VALUES, ...FILTER_VALUES, 'pathtype', 'olderthan', 'newerthan'],
    paths: PATH_VALUES,
  },
  { listsOnly: true },
);
const resolvePath = ps1(
  { switches: ['relative'], values: [...PATH_VALUES, 'relativebasepath'], paths: PATH_VALUES },
  { listsOnly: true },
);
const splitPath = ps1(
  {
    switches: [
      'parent',
      'leaf',
      'leafbase',
      'extension',
      'qualifier',
      'noqualifier',
      'isabsolute',
      'resolve',
    ],
    values: PATH_VALUES,
    paths: PATH_VALUES,
  },
  { listsOnly: true },
);
const joinPath = ps1(
  {
    switches: ['resolve'],
    values: ['path', 'childpath', 'additionalchildpath'],
    paths: ['path', 'childpath', 'additionalchildpath'],
  },
  { listsOnly: true },
);
const getFileHash = ps1({
  values: [...PATH_VALUES, 'algorithm', 'inputstream'],
  paths: PATH_VALUES,
});
const getAcl = ps1(
  {
    switches: ['audit', 'allcentralaccesspolicies'],
    values: [...PATH_VALUES, ...FILTER_VALUES],
    paths: PATH_VALUES,
  },
  { listsOnly: true },
);
const importCsv = ps1({
  switches: ['useculture'],
  values: [...PATH_VALUES, 'delimiter', 'header', 'encoding'],
  paths: PATH_VALUES,
});

// Pipeline cmdlets: values are objects or property names. Script blocks (braces) are rejected.
const measureObject = ps1({
  switches: [
    'line',
    'word',
    'character',
    'sum',
    'average',
    'maximum',
    'minimum',
    'standarddeviation',
    'allstats',
    'ignorewhitespace',
  ],
  values: ['property', 'inputobject'],
});
const selectObject = ps1({
  switches: ['unique', 'wait', 'caseinsensitive'],
  values: [
    'property',
    'excludeproperty',
    'expandproperty',
    'first',
    'last',
    'skip',
    'skiplast',
    'index',
    'skipindex',
    'inputobject',
  ],
});
// prettier-ignore
const WHERE_OPERATORS = [
  'eq', 'ne', 'gt', 'ge', 'lt', 'le', 'like', 'notlike', 'match', 'notmatch', 'contains',
  'notcontains', 'in', 'notin', 'is', 'isnot', 'not', 'ceq', 'cne', 'cgt', 'cge', 'clt', 'cle',
  'clike', 'cnotlike', 'cmatch', 'cnotmatch', 'ccontains', 'cnotcontains', 'cin', 'cnotin',
];
const whereObject = ps1({
  switches: WHERE_OPERATORS,
  values: ['property', 'value', 'inputobject'],
});
const sortObject = ps1({
  switches: ['descending', 'unique', 'stable', 'casesensitive'],
  values: ['property', 'top', 'bottom', 'culture', 'inputobject'],
});
const formatObject = ps1({
  switches: [
    'autosize',
    'hidetableheaders',
    'wrap',
    'force',
    'displayerror',
    'showerror',
    'repeatheader',
  ],
  values: ['property', 'groupby', 'view', 'expand', 'column', 'inputobject'],
});
const outString = ps1({ switches: ['stream', 'nonewline'], values: ['width', 'inputobject'] });
const outHost = ps1({ switches: ['paging'], values: ['inputobject'] });
const convert = ps1({
  switches: [
    'compress',
    'asarray',
    'enumsasstrings',
    'ashashtable',
    'noenumerate',
    'notypeinformation',
    'nti',
    'includetypeinformation',
    'noheader',
    'useculture',
  ],
  values: [
    'depth',
    'inputobject',
    'escapehandling',
    'delimiter',
    'usequotes',
    'quotefields',
    'header',
  ],
});
const getUnique = ps1({
  switches: ['asstring', 'ontype', 'caseinsensitive'],
  values: ['inputobject'],
});
const groupObject = ps1({
  switches: ['noelement', 'ashashtable', 'asstring', 'casesensitive'],
  values: ['property', 'culture', 'inputobject'],
});
const compareObject = ps1({
  switches: ['includeequal', 'excludedifferent', 'passthru', 'casesensitive'],
  values: ['referenceobject', 'differenceobject', 'property', 'syncwindow', 'culture'],
});
const getVariable = ps1({
  switches: ['valueonly'],
  values: ['name', 'scope', 'include', 'exclude'],
});
const getLocation = ps1(
  { switches: ['stack'], values: ['psprovider', 'psdrive', 'stackname'] },
  TEXT,
);
const getDate = ps1(
  {
    switches: ['asutc'],
    values: [
      'format',
      'uformat',
      'date',
      'unixtimeseconds',
      'year',
      'month',
      'day',
      'hour',
      'minute',
      'second',
      'millisecond',
      'displayhint',
    ],
  },
  TEXT,
);
const writeOutput = ps1(
  {
    switches: ['noenumerate', 'nonewline'],
    values: ['inputobject', 'object', 'separator', 'foregroundcolor', 'backgroundcolor'],
  },
  TEXT,
);
const getProcess = ps1(
  {
    switches: ['includeusername', 'module', 'fileversioninfo'],
    values: ['name', 'id', 'inputobject'],
  },
  TEXT,
);
const getService = ps1(
  {
    switches: ['dependentservices', 'requiredservices'],
    values: ['name', 'displayname', 'include', 'exclude', 'inputobject'],
  },
  TEXT,
);
/** `Get-Help -Online` and `-ShowWindow` open other programs. */
const getHelp = ps1(
  {
    switches: ['full', 'detailed', 'examples'],
    values: ['name', 'parameter', 'category', 'component', 'role', 'functionality', 'path'],
  },
  TEXT,
);
const getCommand = ps1(
  {
    switches: ['all', 'listimported', 'syntax', 'showcommandinfo'],
    values: [
      'name',
      'noun',
      'verb',
      'module',
      'commandtype',
      'totalcount',
      'parametername',
      'parametertype',
      'fullyqualifiedmodule',
    ],
  },
  TEXT,
);
const getModule = ps1(
  {
    switches: ['listavailable', 'all', 'refresh', 'skipeditioncheck'],
    values: ['name', 'fullyqualifiedname', 'psedition'],
  },
  TEXT,
);
const getMember = ps1(
  { switches: ['static', 'force'], values: ['name', 'membertype', 'view', 'inputobject'] },
  TEXT,
);
const getAlias = ps1({ values: ['name', 'definition', 'exclude', 'scope'] }, TEXT);
const getPsDrive = ps1({ values: ['name', 'psprovider', 'scope', 'literalname'] }, TEXT);
const getPsProvider = ps1({ values: ['psprovider'] }, TEXT);
const getCulture = ps1({ switches: ['listavailable', 'nouseroverrides'], values: ['name'] }, TEXT);
const getRandom = ps1(
  { switches: ['shuffle'], values: ['minimum', 'maximum', 'count', 'inputobject', 'setseed'] },
  TEXT,
);
const outNull = ps1({ values: ['inputobject'] }, TEXT);
const getHost = ps1({}, TEXT);

// -----------------------------------------------------------------------------------------------
// Programs whose read-only form depends on their arguments

/** `sort -o FILE` writes; `--compress-program` runs a program; `-T` writes temporary files. */
const sort: ReadOnlyEntry = {
  risky: true,
  options: {
    short: 'bdfghiMnRrVcCmsuz',
    shortValue: 'ktS',
    long: [
      ...COMMON_LONG,
      '--ignore-leading-blanks',
      '--dictionary-order',
      '--ignore-case',
      '--general-numeric-sort',
      '--ignore-nonprinting',
      '--month-sort',
      '--human-numeric-sort',
      '--numeric-sort',
      '--random-sort',
      '--reverse',
      '--version-sort',
      '--merge',
      '--stable',
      '--unique',
      '--zero-terminated',
      '--debug',
    ],
    longValue: [
      '--key',
      '--field-separator',
      '--buffer-size',
      '--parallel',
      '--random-source',
      '--batch-size',
      '--sort',
    ],
    longOptional: ['--check'],
    pathValues: ['--random-source'],
    switches: ['/r', '/+'],
  },
  powershell: sortObject.powershell,
};

/** `uniq in out` and `xxd in out` write their second operand. */
const writesSecondOperand: ReadOnlyEntry['refine'] = (parsed, _ctx, name) =>
  parsed.operands.length >= 2
    ? normal(`Writes output to a file (${name})`, { paths: parsed.operands })
    : undefined;

const uniq: ReadOnlyEntry = {
  options: {
    short: 'cdDiuz',
    shortValue: 'fsw',
    numeric: true,
    long: [
      ...COMMON_LONG,
      '--count',
      '--repeated',
      '--ignore-case',
      '--unique',
      '--zero-terminated',
    ],
    longValue: ['--skip-fields', '--skip-chars', '--check-chars'],
    longOptional: ['--all-repeated', '--group'],
  },
  refine: writesSecondOperand,
};

/** xxd spells its long options with one dash (`-ps`, `-len 16`). */
const xxd: ReadOnlyEntry = {
  options: { short: 'abCEeiprduhv', shortValue: 'cglnosR', long: COMMON_LONG },
  refine: writesSecondOperand,
};

const tee: ReadOnlyEntry = {
  options: {
    short: 'aip',
    long: [...COMMON_LONG, '--append', '--ignore-interrupts'],
    longOptional: ['--output-error'],
  },
  powershell: {
    switches: ['append'],
    values: ['filepath', 'literalpath', 'variable', 'inputobject', 'encoding'],
    paths: ['filepath', 'literalpath'],
  },
  refine: (parsed) => {
    const targets = [...parsed.operands, ...valuesOf(parsed, 'filepath', 'literalpath')];
    if (targets.some((target) => !isHarmlessDevice(target))) {
      return normal('Writes output to a file (tee)', { paths: targets });
    }
    if (valuesOf(parsed, 'variable').length > 0) {
      return normal('Sets a variable (Tee-Object -Variable)', { paths: [] });
    }
    return safe('Copies input to output (tee)', { paths: [] });
  },
};

/** `date -s`/`--set` and `date MMDDhhmm` set the clock; `+FORMAT` only formats. */
const date: ReadOnlyEntry = {
  text: true,
  options: {
    short: 'uR',
    shortValue: 'dfr',
    shortOptional: 'I',
    long: [...COMMON_LONG, '--utc', '--universal', '--rfc-email', '--rfc-2822', '--debug'],
    longValue: ['--date', '--file', '--reference', '--rfc-3339'],
    longOptional: ['--iso-8601'],
    pathValues: ['-f', '--file', '-r', '--reference'],
  },
  refine: (parsed) =>
    parsed.operands.some((operand) => !operand.startsWith('+'))
      ? normal('Sets the system clock (date)', { paths: [] })
      : safe('Prints the date (date)', {
          paths: valuesOf(parsed, '-f', '--file', '-r', '--reference'),
        }),
};

const hostname: ReadOnlyEntry = {
  text: true,
  options: {
    short: 'fsdiIaAy',
    long: [
      ...COMMON_LONG,
      '--fqdn',
      '--long',
      '--short',
      '--domain',
      '--ip-address',
      '--all-ip-addresses',
      '--all-fqdns',
      '--alias',
      '--nis',
      '--yp',
    ],
  },
  refine: (parsed) =>
    parsed.operands.length > 0
      ? normal('Changes the host name (hostname)', { paths: [] })
      : undefined,
};

/**
 * unzip is read-only only when it lists, tests or prints comments (`-l`, `-v`, `-t`, `-Z`,
 * `-z`) with no other options.
 */
const unzip: Classifier = (args, _ctx, name) => {
  const parsed = parseOptions(args, { short: 'lvtzZq12hmsMTC', long: COMMON_LONG });
  const lists = parsed.used.some((option) => ['-l', '-v', '-t', '-z', '-Z'].includes(option));
  return parsed.unknown === undefined && lists
    ? safe(`Lists archive contents (${name})`, { paths: parsed.operands })
    : normal(`Extracts archives (${name})`);
};

/**
 * jq and yq print values. `$ENV`, `env`, `strenv`, `envsubst` read environment variables, which
 * may hold secrets, and yq's `load*` read other files. yq's `-i` (in place) and `-s` (split into
 * files) write files.
 */
const JQ_ENVIRONMENT = /\$ENV\b|\b(?:str)?env(?:subst)?\b|\bload(?:_\w+)?\b/;
/**
 * jq/gojq module directives: `import "x" as $d {search: "/"}` loads `<search dir>/x.json` from any
 * directory (absolute and `~/` search paths are allowed), and modules run code Patch cannot see.
 * Field access (`.include`) and variables (`$import`) are not directives.
 */
const JQ_MODULES = /(?<![.$\w])(?:import|include|modulemeta|get_search_list)\b/;
function jq(): Classifier {
  return (args, _ctx, name) => {
    const yq = name.toLowerCase() === 'yq';
    const shortFlags = yq ? 'nrjeCMPNyYc' : 'nrjascCMSeRPN';
    // prettier-ignore
    const flags = new Set([
      '-h', '-V', '--tab', '--args', '--jsonargs', '--seq', '--stream', '--stream-errors',
      '--raw-input', '--null-input', '--compact-output', '--sort-keys', '--exit-status',
      '--ascii-output', '--join-output', '--raw-output', '--raw-output0', '--unbuffered',
      '--color-output', '--monochrome-output', '--help', '--version', '--prettyPrint', '--no-doc',
      '--build-configuration', '--yaml-output', ...(yq ? [] : ['--slurp']),
    ]);
    const oneValue = new Set(['--indent', '-I', '-o', '--output-format', '-p', '--input-format']);
    const twoValues = new Set(['--arg', '--argjson', '--slurpfile', '--rawfile']);
    const pathOptions = new Set(['-f', '--from-file', '-L']);
    const paths: string[] = [];
    const operands: string[] = [];
    let hasFilterFile = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--') {
        operands.push(...args.slice(i + 1));
        break;
      }
      if (!arg.startsWith('-') || arg === '-') operands.push(arg);
      else if (flags.has(arg) || [...arg.slice(1)].every((letter) => shortFlags.includes(letter)))
        continue;
      else if (oneValue.has(arg)) i++;
      else if (pathOptions.has(arg)) {
        hasFilterFile ||= arg !== '-L';
        if (args[i + 1] !== undefined) paths.push(args[++i]);
      } else if (twoValues.has(arg)) {
        if (arg === '--slurpfile' || arg === '--rawfile') paths.push(args[i + 2] ?? '');
        i += 2;
      } else {
        return normal(`Uses an option that is not known to be read-only (${name} ${arg})`, {
          rememberable: false,
        });
      }
    }
    // yq (mikefarah) takes an `eval`/`e` command word first.
    const words = /^(e|eval|ea|eval-all)$/.test(operands[0] ?? '') ? operands.slice(1) : operands;
    if (hasFilterFile) {
      // The filter file is not read here, so it may use `$ENV`, `import` or `load`.
      return normal(`Runs a filter from a file, which Patch cannot check (${name} -f)`, {
        paths: [...paths, ...words],
        rememberable: false,
      });
    }
    const filter = words[0];
    if (filter !== undefined && JQ_MODULES.test(filter)) {
      return normal(`Loads modules or data files from other directories (${name} import)`, {
        paths: [...paths, ...words.slice(1)],
        rememberable: false,
      });
    }
    if (filter !== undefined && JQ_ENVIRONMENT.test(filter)) {
      return normal(`Reads environment variables or other files (may include secrets) (${name})`, {
        paths: [],
        rememberable: false,
        concern: 'secret',
      });
    }
    return safe(`Processes JSON or YAML (${name})`, { paths: [...paths, ...words.slice(1)] });
  };
}

// -----------------------------------------------------------------------------------------------
// Table

const ENTRIES: Array<[readonly string[], ReadOnlyEntry]> = [
  [TEXT_PROGRAMS, TEXT],
  [['printf'], printf],
  [['ps'], ps],
  [['man'], man],
  [['help'], help],
  [['ls', 'dir', 'vdir', 'get-childitem', 'gci'], ls],
  [['cat', 'get-content', 'gc'], cat],
  [['head'], head],
  [['tail'], tail],
  [['wc'], wc],
  [['file'], file],
  [['stat'], stat],
  [['du'], du],
  [['df'], df],
  [['tree'], tree],
  [['diff'], diff],
  [['cmp'], cmp],
  [['comm'], comm],
  [['cut'], cut],
  [['tr'], tr],
  [['nl'], nl],
  [['tac'], tac],
  [['rev'], rev],
  [['fold'], fold],
  [['fmt'], fmt],
  [['column'], column],
  [['paste'], paste],
  [['join'], join],
  [['expand', 'unexpand'], expand],
  [['od'], od],
  [['hexdump'], hexdump],
  [['strings'], strings],
  [
    [
      'md5sum',
      'sha1sum',
      'sha224sum',
      'sha256sum',
      'sha384sum',
      'sha512sum',
      'shasum',
      'cksum',
      'b2sum',
      'sum',
      'md5',
    ],
    checksum,
  ],
  [['base32', 'base64'], base64],
  [['realpath'], realpath],
  [['readlink'], readlink],
  [['exa', 'eza', 'lsd'], eza],
  [['zcat', 'bzcat', 'xzcat', 'zstdcat'], decompress],
  [['look'], look],
  [['getfacl'], getfacl],
  [['lsattr'], lsattr],
  [['type'], type],
  [['cd', 'pushd', 'popd', 'chdir', 'set-location', 'sl'], cd],
  [['get-item', 'gi'], getItem],
  [['get-itemproperty', 'gp', 'get-itempropertyvalue', 'gpv'], getItemProperty],
  [['test-path'], testPath],
  [['resolve-path', 'rvpa'], resolvePath],
  [['split-path'], splitPath],
  [['join-path'], joinPath],
  [['get-filehash'], getFileHash],
  [['get-acl'], getAcl],
  [['import-csv'], importCsv],
  [['measure-object', 'measure'], measureObject],
  [['select-object', 'select'], selectObject],
  [['where-object', '?'], whereObject],
  [['sort-object'], sortObject],
  [['format-table', 'ft', 'format-list', 'fl', 'format-wide', 'fw'], formatObject],
  [['out-string'], outString],
  [['out-host'], outHost],
  [['convertto-json', 'convertfrom-json', 'convertto-csv', 'convertfrom-csv'], convert],
  [['get-unique'], getUnique],
  [['group-object', 'group'], groupObject],
  [['compare-object', 'compare'], compareObject],
  [['get-variable', 'gv'], getVariable],
  [['get-location', 'gl'], getLocation],
  [['get-date'], getDate],
  [['write-output', 'write-host'], writeOutput],
  [['get-process', 'gps'], getProcess],
  [['get-service', 'gsv'], getService],
  [['get-help'], getHelp],
  [['get-command', 'gcm'], getCommand],
  [['get-module', 'gmo'], getModule],
  [['get-member', 'gm'], getMember],
  [['get-alias', 'gal'], getAlias],
  [['get-psdrive', 'gdr'], getPsDrive],
  [['get-psprovider'], getPsProvider],
  [['get-culture', 'get-uiculture'], getCulture],
  [['get-random'], getRandom],
  [['out-null'], outNull],
  [['get-host'], getHost],
  [['uniq'], uniq],
  [['xxd'], xxd],
  [['tee', 'tee-object'], tee],
  [['date'], date],
  [['hostname'], hostname],
];

/**
 * Why a `sort` call runs a program or writes a file, whatever else it does: `--compress-program`
 * (and abbreviations such as `--comp`), `-o`/`--output`, `-T`/`--temporary-directory`, and on
 * Windows `/o` and `/t`. Undefined when it does neither.
 */
function sortSideEffect(args: readonly string[], platform: NodeJS.Platform): Verdict | undefined {
  const options = args.slice(0, endOfOptions(args));
  if (options.some((arg) => abbreviatesLong(arg, ['--compress-program']))) {
    return normal('Runs a program (sort --compress-program)', { rememberable: false });
  }
  const output = options.find(
    (arg) =>
      /^-[A-Za-z]*[oT]/.test(arg) ||
      abbreviatesLong(arg, ['--output', '--temporary-directory']) ||
      (platform === 'win32' && SWITCH_WORD.test(arg) && /^\/[ot]/i.test(arg)),
  );
  return output === undefined ? undefined : normal(`Writes output to a file (sort ${output})`);
}

const readOnlySort = readOnly(sort);

export const READ_ONLY_CLASSIFIERS = new Map<string, Classifier>();
for (const [names, entry] of ENTRIES) {
  for (const name of names) READ_ONLY_CLASSIFIERS.set(name, readOnly(entry));
}
READ_ONLY_CLASSIFIERS.set(
  'sort',
  (args, ctx, name) => sortSideEffect(args, ctx.platform) ?? readOnlySort(args, ctx, name),
);
READ_ONLY_CLASSIFIERS.set('unzip', unzip);
READ_ONLY_CLASSIFIERS.set('[[', doubleBracket);
for (const name of ['jq', 'yq', 'gojq']) READ_ONLY_CLASSIFIERS.set(name, jq());
