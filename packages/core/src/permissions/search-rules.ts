import {
  SWITCH_WORD,
  parseOptions,
  parsePowerShellArgs,
  pathArguments,
  powerShellPaths,
  switchName,
  valuesOf,
  type OptionSpec,
  type ParsedArgs,
  type PowerShellSpec,
} from './options.js';
import { expandBraces, globMayMatchSensitive, looksSensitive } from './risk-paths.js';
import {
  abbreviatesLong,
  destructive,
  endOfOptions,
  normal,
  raise,
  safe,
  type Classifier,
  type Verdict,
} from './risk-helpers.js';

/**
 * Searches that walk directories without honoring .gitignore or hidden-file rules print matching
 * lines of `.env` files and keys, which the grep tool and `cat .env` never do without asking.
 */
const searchesSecrets = (what: string, paths?: string[]): Verdict =>
  normal(`Searches directories recursively, including files that may contain secrets (${what})`, {
    paths,
    rememberable: false,
    concern: 'secret',
  });

const unknownOption = (name: string, option: string, rememberable = false): Verdict =>
  normal(`Uses an option that is not known to be read-only (${name} ${option})`, { rememberable });

/** Files a search reads: operands after the pattern (all of them with `-e`/`-f`), plus `-f` files. */
function searchPaths(parsed: ParsedArgs, spec: OptionSpec, patternOptions: string[]): string[] {
  const explicitPattern = valuesOf(parsed, ...patternOptions).length > 0;
  const operands = explicitPattern ? parsed.operands : parsed.operands.slice(1);
  return [...operands, ...pathArguments({ ...parsed, operands: [] }, spec)];
}

// -----------------------------------------------------------------------------------------------
// grep

const GREP: OptionSpec = {
  short: 'EFGPiyvwxcLloqsbHhnTZzaIrRUJMXOSpuV',
  shortValue: 'efmABCDd',
  numeric: true,
  long: [
    '--extended-regexp',
    '--fixed-strings',
    '--basic-regexp',
    '--perl-regexp',
    '--ignore-case',
    '--no-ignore-case',
    '--invert-match',
    '--word-regexp',
    '--line-regexp',
    '--count',
    '--files-without-match',
    '--files-with-matches',
    '--only-matching',
    '--quiet',
    '--silent',
    '--no-messages',
    '--byte-offset',
    '--with-filename',
    '--no-filename',
    '--line-number',
    '--initial-tab',
    '--null',
    '--null-data',
    '--text',
    '--recursive',
    '--dereference-recursive',
    '--line-buffered',
    '--binary',
    '--help',
    '--version',
  ],
  longValue: [
    '--regexp',
    '--file',
    '--max-count',
    '--label',
    '--after-context',
    '--before-context',
    '--context',
    '--binary-files',
    '--devices',
    '--directories',
    '--exclude',
    '--exclude-from',
    '--exclude-dir',
    '--include',
    '--group-separator',
  ],
  longOptional: ['--color', '--colour'],
  pathValues: ['-f', '--file', '--exclude-from'],
};

/** grep and its variants. Recursive searches (`-r`, `-d recurse`) may print secrets. */
export const grep: Classifier = (args, _ctx, name) => {
  const parsed = parseOptions(args, GREP);
  if (parsed.unknown !== undefined) return unknownOption(name, parsed.unknown);
  const paths = searchPaths(parsed, GREP, ['-e', '--regexp', '-f', '--file']);
  const recursive =
    parsed.used.some((option) =>
      ['-r', '-R', '--recursive', '--dereference-recursive'].includes(option),
    ) || valuesOf(parsed, '-d', '--directories').includes('recurse');
  return recursive
    ? searchesSecrets(`${name} -r`, paths)
    : safe(`Searches files (${name})`, { paths });
};

// -----------------------------------------------------------------------------------------------
// ripgrep

/** ripgrep options that search hidden or ignored files (where secrets live). */
const RG_UNRESTRICTED = [
  '-u',
  '-.',
  '--hidden',
  '--unrestricted',
  '--no-ignore',
  '--no-ignore-dot',
  '--no-ignore-exclude',
  '--no-ignore-files',
  '--no-ignore-global',
  '--no-ignore-parent',
  '--no-ignore-vcs',
];
/** ripgrep options that run programs. */
const RG_RUNS_PROGRAMS = ['--pre', '--pre-glob', '-z', '--search-zip', '--hostname-bin'];
/** ripgrep options that define file types, which can select hidden secret files (`x:.env`). */
const RG_TYPE_DEFINITIONS = ['--type-add', '--type-clear'];
const RG_FOLLOWS_LINKS = ['-L', '--follow'];

const RG: OptionSpec = {
  short: 'abcFHhIilnNopPqsSUvVwx0u.zL',
  shortValue: 'ABCefgjmMrtTdE',
  shortEquals: true,
  long: [
    '--binary',
    '--block-buffered',
    '--byte-offset',
    '--case-sensitive',
    '--column',
    '--count',
    '--count-matches',
    '--crlf',
    '--debug',
    '--trace',
    '--files',
    '--files-with-matches',
    '--files-without-match',
    '--fixed-strings',
    '--glob-case-insensitive',
    '--heading',
    '--no-heading',
    '--ignore-case',
    '--include-zero',
    '--invert-match',
    '--json',
    '--line-buffered',
    '--line-number',
    '--line-regexp',
    '--max-columns-preview',
    '--mmap',
    '--multiline',
    '--multiline-dotall',
    '--no-config',
    '--no-ignore-messages',
    '--no-line-number',
    '--no-messages',
    '--no-mmap',
    '--no-pcre2-unicode',
    '--no-unicode',
    '--null',
    '--null-data',
    '--one-file-system',
    '--only-matching',
    '--passthru',
    '--pcre2',
    '--pcre2-version',
    '--pretty',
    '--quiet',
    '--smart-case',
    '--sort-files',
    '--stats',
    '--text',
    '--trim',
    '--type-list',
    '--vimgrep',
    '--with-filename',
    '--no-filename',
    '--word-regexp',
    '--no-require-git',
    '--ignore-file-case-insensitive',
    '--no-column',
    '--no-byte-offset',
    '--help',
    '--version',
    '--hidden',
    '--search-zip',
    '--follow',
    '--no-ignore',
    '--no-ignore-dot',
    '--no-ignore-exclude',
    '--no-ignore-files',
    '--no-ignore-global',
    '--no-ignore-parent',
    '--no-ignore-vcs',
    '--unrestricted',
  ],
  longValue: [
    '--after-context',
    '--before-context',
    '--context',
    '--regexp',
    '--file',
    '--glob',
    '--iglob',
    '--threads',
    '--max-count',
    '--max-columns',
    '--replace',
    '--type',
    '--type-not',
    '--max-depth',
    '--encoding',
    '--sort',
    '--sortr',
    '--max-filesize',
    '--path-separator',
    '--colors',
    '--color',
    '--context-separator',
    '--field-match-separator',
    '--field-context-separator',
    '--engine',
    '--ignore-file',
    '--dfa-size-limit',
    '--regex-size-limit',
    '--generate',
    '--pre',
    '--pre-glob',
    '--hostname-bin',
    '--type-add',
    '--type-clear',
  ],
  pathValues: ['-f', '--file', '--ignore-file'],
};

/**
 * True when a ripgrep glob may select a secret file: globs override ripgrep's hidden-file and
 * ignore rules. Brace alternatives (`{.env,x}`) are tried one by one; `!` globs only exclude.
 */
function rgGlobMaySelectSecrets(glob: string, platform: NodeJS.Platform): boolean {
  if (glob.startsWith('!')) return false;
  const alternatives = expandBraces(glob);
  if (alternatives === undefined) return true;
  return alternatives.some(
    (alternative) =>
      looksSensitive(alternative) ||
      globMayMatchSensitive(alternative, {
        dot: true,
        platform,
        skipGlobstar: true,
        escapes: platform !== 'win32',
      }),
  );
}

export const rg: Classifier = (args, ctx, name) => {
  const parsed = parseOptions(args, RG);
  if (parsed.unknown !== undefined) return unknownOption(name, parsed.unknown);
  const listsFiles = parsed.used.includes('--files') || parsed.used.includes('--type-list');
  const paths = listsFiles
    ? pathArguments(parsed, RG)
    : searchPaths(parsed, RG, ['-e', '--regexp', '-f', '--file']);
  const used = (options: readonly string[]): string | undefined =>
    parsed.used.find((option) => options.includes(option));
  const program = used(RG_RUNS_PROGRAMS);
  if (program !== undefined) {
    return normal(`Runs other programs on the files it searches (${name} ${program})`, {
      paths,
      rememberable: false,
    });
  }
  const types = used(RG_TYPE_DEFINITIONS);
  if (types !== undefined) {
    return normal(
      `Defines file types, which may select files that contain secrets (${name} ${types})`,
      {
        paths,
        rememberable: false,
        concern: 'secret',
      },
    );
  }
  const follows = used(RG_FOLLOWS_LINKS);
  if (follows !== undefined) {
    return normal(
      `Follows symbolic links, which may lead outside the project (${name} ${follows})`,
      {
        paths,
        rememberable: false,
      },
    );
  }
  if (listsFiles) return safe(`Lists files (${name})`, { paths, listsOnly: true });
  const unrestricted = used(RG_UNRESTRICTED);
  if (unrestricted !== undefined) return searchesSecrets(`${name} ${unrestricted}`, paths);
  // An `--ignore-file` can re-include hidden files with a `!` rule; its contents are not checked.
  if (valuesOf(parsed, '--ignore-file').length > 0) {
    return searchesSecrets(`${name} --ignore-file`, paths);
  }
  const glob = valuesOf(parsed, '-g', '--glob', '--iglob').find((value) =>
    rgGlobMaySelectSecrets(value, ctx.platform),
  );
  if (glob !== undefined) return searchesSecrets(`${name} --glob ${glob}`, paths);
  // A recursive search honors `.ignore`/`.gitignore`; a `!` negation in one re-includes hidden
  // files such as `.env`, which the search would then print. Only operands that are plain files
  // are not walked, so a directory (or no) operand must be checked.
  if (ctx.searchHasNegatedIgnore(paths) !== false) {
    return searchesSecrets(`${name} (ignore-file negation)`, paths);
  }
  return safe(`Searches files (${name})`, { paths });
};

// -----------------------------------------------------------------------------------------------
// findstr and Select-String

const FINDSTR_SWITCHES = [
  '/b',
  '/e',
  '/l',
  '/r',
  '/s',
  '/i',
  '/x',
  '/v',
  '/n',
  '/m',
  '/o',
  '/p',
  '/a',
  '/f',
  '/c',
  '/g',
  '/d',
];

/**
 * `findstr [switches] strings [files]`. `/c:` and `/g:` give the search strings; `/g:` names a
 * file of strings it reads; `/d:` lists directories to search (`;`-separated); `/f:` reads the
 * names of the files to search from a file, so which files it reads is unknown; `/s` (also in
 * clusters such as `/si`) searches subdirectories.
 */
export const findstr: Classifier = (args) => {
  const words: string[] = [];
  const read: string[] = [];
  let strings = false;
  let recursive = false;
  let listed: string | undefined;
  for (const arg of args) {
    if (!arg.startsWith('/')) {
      words.push(arg);
      continue;
    }
    if (!SWITCH_WORD.test(arg) && !/^\/[A-Za-z]+$/.test(arg)) {
      words.push(arg);
      continue;
    }
    const letters = /^\/([A-Za-z]+)/.exec(arg)?.[1].toLowerCase() ?? '';
    const value = arg.includes(':') ? arg.slice(arg.indexOf(':') + 1) : undefined;
    if (value !== undefined) {
      const name = switchName(arg);
      if (!FINDSTR_SWITCHES.includes(name)) return unknownOption('findstr', arg, true);
      if (name === '/c' || name === '/g') strings = true;
      if (name === '/f' || name === '/g') read.push(value);
      if (name === '/f') listed = arg;
      if (name === '/d') read.push(...value.split(/[;,]/).filter(Boolean));
      continue;
    }
    for (const letter of letters) {
      if (!FINDSTR_SWITCHES.includes(`/${letter}`)) return unknownOption('findstr', arg, true);
      if (letter === 's') recursive = true;
    }
  }
  const paths = [...(strings ? words : words.slice(1)), ...read];
  if (listed !== undefined) {
    return normal(
      `Searches files listed in another file, which may contain secrets (findstr ${listed})`,
      {
        paths,
        rememberable: false,
        concern: 'secret',
      },
    );
  }
  return recursive
    ? searchesSecrets('findstr /s', paths)
    : safe('Searches files (findstr)', { paths });
};

const SELECT_STRING: PowerShellSpec = {
  switches: [
    'simplematch',
    'casesensitive',
    'allmatches',
    'notmatch',
    'list',
    'quiet',
    'raw',
    'noemphasis',
  ],
  values: [
    'pattern',
    'path',
    'literalpath',
    'lp',
    'pspath',
    'include',
    'exclude',
    'encoding',
    'context',
    'culture',
    'inputobject',
  ],
  paths: ['path', 'literalpath', 'lp', 'pspath'],
};

/** Select-String reads `-Path`/`-LiteralPath` files and positional files after the pattern. */
export const selectString: Classifier = (args, _ctx, name) => {
  const parsed = parsePowerShellArgs(args, SELECT_STRING);
  if (parsed.unknown !== undefined) {
    return /[{}]/.test(parsed.unknown)
      ? normal(`May run a PowerShell script block (${name})`, { rememberable: false })
      : unknownOption(name, parsed.unknown, true);
  }
  const namedPattern = valuesOf(parsed, 'pattern').length > 0;
  const operands = namedPattern ? parsed.operands : parsed.operands.slice(1);
  return safe(`Searches files (${name})`, {
    paths: powerShellPaths({ ...parsed, operands }, SELECT_STRING),
  });
};

// -----------------------------------------------------------------------------------------------
// find and fd

const FIND_FLAGS = new Set([
  '-print',
  '-print0',
  '-ls',
  '-prune',
  '-quit',
  '-true',
  '-false',
  '-empty',
  '-readable',
  '-writable',
  '-executable',
  '-nouser',
  '-nogroup',
  '-depth',
  '-d',
  '-follow',
  '-mount',
  '-xdev',
  '-x',
  '-noleaf',
  '-ignore_readdir_race',
  '-noignore_readdir_race',
  '-daystart',
  '-help',
  '--help',
  '-version',
  '--version',
  '-warn',
  '-nowarn',
  '-not',
  '!',
  '-a',
  '-and',
  '-o',
  '-or',
  '(',
  ')',
  ',',
  '-E',
  '-X',
  '-s',
]);
// prettier-ignore
const FIND_VALUES = new Set([
  '-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex',
  '-regextype', '-type', '-xtype', '-maxdepth', '-mindepth', '-mtime', '-mmin', '-atime', '-amin',
  '-ctime', '-cmin', '-used', '-size', '-perm', '-user', '-group', '-uid', '-gid', '-links',
  '-inum', '-lname', '-ilname', '-fstype', '-context', '-printf', '-Bmin', '-Btime',
]);
const FIND_PATH_VALUES = new Set([
  '-newer',
  '-anewer',
  '-cnewer',
  '-samefile',
  '-files0-from',
  '-Bnewer',
]);
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const FIND_WRITES = new Map([
  ['-fprint', 1],
  ['-fprint0', 1],
  ['-fls', 1],
  ['-fprintf', 2],
]);
const FIND_WINDOWS_SWITCHES = ['/v', '/c', '/n', '/i'];

/**
 * find, by allowlist of expressions. `-exec`/`-ok` commands are analyzed as segments of their
 * own and never remembered (their file arguments are only known when they run), `-delete` is
 * destructive, `-fprint` and friends write files. On Windows, `find /i "x" file` is find.exe.
 */
export const find: Classifier = (args, ctx) => {
  if (ctx.platform === 'win32' && args.some((arg) => SWITCH_WORD.test(arg))) {
    const parsed = parseOptions(args, { switches: FIND_WINDOWS_SWITCHES }, { switches: true });
    if (parsed.unknown !== undefined) return unknownOption('find', parsed.unknown, true);
    return safe('Searches files (find)', { paths: parsed.operands.slice(1) });
  }
  let i = 0;
  while (i < args.length && /^-([HLP]|O\d*|D)$/.test(args[i])) i += args[i] === '-D' ? 2 : 1;
  const start = i;
  while (i < args.length && !/^[-(!),]/.test(args[i])) i++;
  const paths = args.slice(start, i);
  const nested: string[][] = [];
  let result: Verdict = safe('Searches for files (find)', { paths, nested, listsOnly: true });
  for (; i < args.length; i++) {
    const arg = args[i];
    if (FIND_FLAGS.has(arg)) continue;
    if (FIND_VALUES.has(arg) || /^-newer[aBcmt][aBcmt]$/.test(arg)) {
      i++;
      continue;
    }
    if (FIND_PATH_VALUES.has(arg)) {
      if (args[i + 1] !== undefined) paths.push(args[++i]);
      continue;
    }
    if (arg === '-delete') {
      result = raise(result, destructive('Deletes files (find -delete)'));
      continue;
    }
    const written = FIND_WRITES.get(arg);
    if (written !== undefined) {
      if (args[i + 1] !== undefined) paths.push(args[i + 1]);
      i += written;
      result = raise(
        { ...result, listsOnly: false },
        normal(`Writes output to a file (find ${arg})`),
      );
      continue;
    }
    if (FIND_EXEC.has(arg)) {
      let end = i + 1;
      while (end < args.length && args[end] !== ';' && args[end] !== '+') end++;
      nested.push(args.slice(i + 1, end));
      // The command's file arguments are only known when it runs (`-name .env -exec cat {} ;`),
      // so approving one `find -exec` must not approve the next.
      result = raise(
        { ...result, rememberable: false },
        normal(`Runs a command for each file (find ${arg})`),
      );
      i = end;
      continue;
    }
    return { ...unknownOption('find', arg), paths: args.filter((word) => !/^[-(!),]/.test(word)) };
  }
  return result;
};

const FD: OptionSpec = {
  short: 'HIusigFalLp01qh',
  shortValue: 'dtESjcoe',
  long: [
    '--hidden',
    '--no-ignore',
    '--no-ignore-vcs',
    '--no-ignore-parent',
    '--no-global-ignore-file',
    '--unrestricted',
    '--case-sensitive',
    '--ignore-case',
    '--glob',
    '--regex',
    '--fixed-strings',
    '--absolute-path',
    '--relative-path',
    '--list-details',
    '--follow',
    '--full-path',
    '--print0',
    '--prune',
    '--one-file-system',
    '--show-errors',
    '--quiet',
    '--help',
    '--version',
  ],
  longValue: [
    '--max-depth',
    '--min-depth',
    '--exact-depth',
    '--type',
    '--extension',
    '--exclude',
    '--size',
    '--changed-within',
    '--changed-before',
    '--change-newer-than',
    '--change-older-than',
    '--newer',
    '--older',
    '--owner',
    '--threads',
    '--max-results',
    '--color',
    '--base-directory',
    '--path-separator',
    '--search-path',
    '--ignore-file',
    '--format',
    '--and',
    '--batch-size',
    '--max-buffer-time',
  ],
  longOptional: ['--strip-cwd-prefix'],
  pathValues: ['--base-directory', '--search-path', '--ignore-file'],
};
/** `-x cmd`, `--exec cmd`, `--exec=cmd` (and `-X`/`--exec-batch`), up to a `;`. */
const FD_EXEC = /^(-x|-X|--exec|--exec-batch)(=.*)?$/s;

/** fd lists file names; `-x`/`-X` run a command for the files it finds. */
export const fd: Classifier = (args, _ctx, name) => {
  const execIndex = args.findIndex((arg) => FD_EXEC.test(arg));
  const ownArgs = execIndex < 0 ? args : args.slice(0, execIndex);
  const parsed = parseOptions(ownArgs, FD);
  if (parsed.unknown !== undefined) return unknownOption(name, parsed.unknown);
  const paths = [...parsed.operands.slice(1), ...pathArguments({ ...parsed, operands: [] }, FD)];
  if (execIndex < 0) return safe(`Searches for files (${name})`, { paths, listsOnly: true });
  const nested: string[][] = [];
  for (let i = execIndex; i >= 0 && i < args.length;) {
    const option = args[i];
    const inline = option.includes('=') ? [option.slice(option.indexOf('=') + 1)] : [];
    let end = i + 1;
    while (end < args.length && args[end] !== ';') end++;
    nested.push([...inline, ...args.slice(i + 1, end)]);
    i = args.findIndex((arg, j) => j > end && FD_EXEC.test(arg));
  }
  return normal(`Runs a command for each file (${name} ${args[execIndex].split('=')[0]})`, {
    paths,
    nested,
    rememberable: false,
  });
};

// -----------------------------------------------------------------------------------------------
// sed

const SED: OptionSpec = {
  short: 'nEsruzb',
  shortValue: 'elf',
  shortOptional: 'i',
  long: [
    '--quiet',
    '--silent',
    '--regexp-extended',
    '--separate',
    '--unbuffered',
    '--null-data',
    '--posix',
    '--debug',
    '--sandbox',
    '--follow-symlinks',
    '--binary',
    '--help',
    '--version',
  ],
  longValue: ['--expression', '--line-length', '--file'],
  longOptional: ['--in-place'],
};

/**
 * sed prints transformed text unless it edits in place (`-i`) or its script runs commands
 * (`e`, `s///e`) or reads and writes other files (`r`, `R`, `w`, `W`, `s///w`). Scripts are read
 * with a small parser; anything it does not understand counts as unsafe.
 */
export const sed: Classifier = (args, _ctx, name) => {
  const parsed = parseOptions(args, SED);
  if (parsed.unknown !== undefined) return unknownOption(name, parsed.unknown);
  const expressions = valuesOf(parsed, '-e', '--expression');
  const scriptFiles = valuesOf(parsed, '-f', '--file');
  const explicit = expressions.length > 0 || scriptFiles.length > 0;
  const scripts = explicit ? expressions : parsed.operands.slice(0, 1);
  const files = explicit ? parsed.operands : parsed.operands.slice(1);
  const inPlace = parsed.used.some((option) => option === '-i' || option === '--in-place');
  const results = scripts.map(sedScriptSafety);
  const unsafe =
    scriptFiles.length > 0
      ? 'reads its script from a file'
      : results.find((result) => result.safety !== 'print')?.safety;
  // The files a `w`/`r`/`s///w` command names are read or written when the script runs, so they
  // count as paths too: otherwise a script writing into `.git`, or reading `~/.ssh/id_rsa`, is
  // only seen as a plain write/read of the input operands.
  const scriptTargets = results.flatMap((result) => result.targets);
  if (unsafe !== undefined) {
    const what = unsafe === 'unknown' ? 'uses commands Patch cannot check' : unsafe;
    return normal(`Runs a sed script that ${what} (${name})`, {
      paths: [...files, ...scriptFiles, ...scriptTargets],
      rememberable: false,
    });
  }
  return inPlace
    ? normal(`Edits files in place (${name} -i)`, { paths: files })
    : safe(`Prints transformed text (${name})`, { paths: files });
};

type SedSafetyLevel = 'print' | 'unknown' | string;
interface SedSafety {
  safety: SedSafetyLevel;
  /** Files the script reads or writes (`w`/`W`/`r`/`R`/`s///w`), excluding stdout/stderr. */
  targets: string[];
}

/**
 * Whether a sed script only transforms and prints text ('print'), does something else (a reason
 * such as 'runs commands'), or could not be understood ('unknown'), with the files it reads or
 * writes. Linear in the script.
 */
function sedScriptSafety(script: string): SedSafety {
  let i = 0;
  let safety: SedSafetyLevel | undefined;
  const targets: string[] = [];
  const done = (level: SedSafetyLevel): SedSafety => ({ safety: level, targets });
  const at = (offset = 0): string => script[i + offset] ?? '';
  const skipBlanks = (): void => {
    while (/[ \t]/.test(at())) i++;
  };
  /** The file name a `w`/`r`/`s///w` command names: the rest of the line after optional blanks. */
  const readFileTarget = (): void => {
    skipBlanks();
    const start = i;
    while (i < script.length && at() !== '\n') i++;
    const target = script.slice(start, i);
    if (target !== '' && target !== '/dev/stdout' && target !== '/dev/stderr') targets.push(target);
  };
  /** Reads a regex or replacement up to `delimiter`; brackets only count in regexes. */
  const readDelimited = (delimiter: string, regex: boolean): boolean => {
    while (i < script.length) {
      const char = script[i];
      if (char === '\\') {
        i += 2;
      } else if (regex && char === '[') {
        const end = bracketEnd(script, i);
        if (end < 0) return false;
        i = end + 1;
      } else if (char === delimiter) {
        i++;
        return true;
      } else if (char === '\n' && regex) {
        return false;
      } else {
        i++;
      }
    }
    return false;
  };
  const readAddress = (): boolean => {
    if (/\d/.test(at())) {
      while (/[\d~]/.test(at())) i++;
    } else if (at() === '$') {
      i++;
    } else if (at() === '/' || at() === '\\') {
      const delimiter = at() === '/' ? '/' : at(1);
      i += at() === '/' ? 1 : 2;
      if (delimiter === '' || delimiter === '\n' || !readDelimited(delimiter, true)) return false;
      while (/[IM]/.test(at())) i++;
    }
    return true;
  };
  while (i < script.length) {
    while (/[\s;]/.test(at())) i++;
    if (i >= script.length) break;
    if (!readAddress()) return done('unknown');
    skipBlanks();
    if (at() === ',') {
      i++;
      skipBlanks();
      if (at() === '+' || at() === '~') i++;
      if (!readAddress()) return done('unknown');
    }
    skipBlanks();
    while (at() === '!') {
      i++;
      skipBlanks();
    }
    const command = at();
    i++;
    if (command === '') return done('unknown');
    if ('{}=dDgGhHnNpPxzF'.includes(command)) continue;
    if ('qQlL'.includes(command)) {
      skipBlanks();
      while (/\d/.test(at())) i++;
      continue;
    }
    if ('btT:'.includes(command)) {
      while (i < script.length && !/[;\n]/.test(at())) i++;
      continue;
    }
    if ('aic'.includes(command) || command === '#') {
      // Text (or a comment) up to the end of the line; `\` continues it on the next line.
      while (i < script.length && at() !== '\n') i += at() === '\\' ? 2 : 1;
      continue;
    }
    if (command === 's' || command === 'y') {
      const delimiter = at();
      if (delimiter === '' || delimiter === '\n' || delimiter === '\\') return done('unknown');
      i++;
      if (!readDelimited(delimiter, command === 's')) return done('unknown');
      if (!readDelimited(delimiter, false)) return done('unknown');
      if (command === 'y') continue;
      while (/[gpiImM\d]/.test(at())) i++;
      if (at() === 'e') return done('runs commands');
      if (at() === 'w') {
        i++;
        safety ??= 'writes files';
        readFileTarget();
        continue;
      }
      skipBlanks();
      if (at() !== '' && !/[;\n}#]/.test(at())) return done('unknown');
      continue;
    }
    if (command === 'e') return done('runs commands');
    if (command === 'w' || command === 'W') {
      safety ??= 'writes files';
      readFileTarget();
      continue;
    }
    if (command === 'r' || command === 'R') {
      safety ??= 'reads other files';
      readFileTarget();
      continue;
    }
    return done('unknown');
  }
  return done(safety ?? 'print');
}

/** Index of the `]` closing the bracket expression at `start`, or -1. */
function bracketEnd(text: string, start: number): number {
  let i = start + 1;
  if (text[i] === '^') i++;
  if (text[i] === ']') i++;
  while (i < text.length) {
    if (text[i] === '[' && /[:.=]/.test(text[i + 1] ?? '')) {
      const close = text.indexOf(`${text[i + 1]}]`, i + 2);
      if (close < 0) return -1;
      i = close + 2;
    } else if (text[i] === ']') {
      return i;
    } else if (text[i] === '\n') {
      return -1;
    } else {
      i++;
    }
  }
  return -1;
}

// -----------------------------------------------------------------------------------------------
// tar

/** Short options that take a value (GNU tar); the rest of a cluster or the next word is it. */
const TAR_SHORT_VALUES = 'bCfFgHIKLNTVX';
/** Options that make tar run a program, in every mode. */
const TAR_RUNS_PROGRAMS = [
  '--checkpoint-action',
  '--use-compress-program',
  '--to-command',
  '--rsh-command',
  '--info-script',
  '--new-volume-script',
];
const TAR_RUNS_PROGRAMS_SHORT = 'IF';
const TAR_LIST_SHORT = 'tvfzjJaZC';
// prettier-ignore
const TAR_LIST_LONG = [
  '--list', '--verbose', '--file', '--gzip', '--gunzip', '--ungzip', '--bzip2', '--xz', '--lzma',
  '--lzip', '--lzop', '--zstd', '--compress', '--uncompress', '--auto-compress', '--exclude',
  '--exclude-vcs', '--exclude-vcs-ignores', '--exclude-backups', '--exclude-caches', '--wildcards',
  '--no-wildcards', '--anchored', '--no-anchored', '--ignore-case', '--no-ignore-case',
  '--wildcards-match-slash', '--no-wildcards-match-slash', '--numeric-owner', '--full-time',
  '--utc', '--null', '--verbatim-files-from', '--show-transformed-names', '--quoting-style',
  '--directory', '--strip-components', '--no-recursion', '--recursion', '--help', '--version',
  '--usage', '--show-defaults', '--warning', '--force-local',
];
// prettier-ignore
const TAR_LONG_VALUES = new Set([
  '--file', '--directory', '--exclude', '--exclude-from', '--files-from', '--format', '--owner',
  '--group', '--mode', '--mtime', '--newer', '--after-date', '--newer-mtime', '--label',
  '--blocking-factor', '--record-size', '--tape-length', '--volno-file', '--listed-incremental',
  '--strip-components', '--transform', '--xform', '--suffix', '--quoting-style', '--quote-chars',
  '--no-quote-chars', '--exclude-tag', '--exclude-tag-under', '--exclude-tag-all', '--warning',
  '--use-compress-program', '--to-command', '--rsh-command', '--info-script', '--new-volume-script',
  '--index-file', '--checkpoint-action', '--sparse-version', '--hole-detection',
]);

interface TarOptions {
  /** Options as written in the spec (`-t`, `--list`). */
  used: string[];
  /** Archive names given to `-f`/`--file`. */
  archives: string[];
  /** Directories given to `-C`/`--directory`. */
  directories: string[];
  /** The option that runs a program, if any. */
  runs?: string;
}

/** Reads tar's options, including the old style without a dash (`tar tvf a.tar`). */
function readTarOptions(args: readonly string[]): TarOptions {
  const result: TarOptions = { used: [], archives: [], directories: [] };
  const end = endOfOptions(args);
  const take = (letter: string, value: string | undefined): void => {
    result.used.push(`-${letter}`);
    if (TAR_RUNS_PROGRAMS_SHORT.includes(letter)) result.runs ??= `-${letter}`;
    if (value === undefined) return;
    if (letter === 'f') result.archives.push(value);
    if (letter === 'C') result.directories.push(value);
  };
  let i = 0;
  if (args[0] !== undefined && !args[0].startsWith('-') && end > 0) {
    // Old style: each letter is an option; value letters take the following words in order.
    let next = 1;
    for (const letter of args[0]) {
      take(letter, TAR_SHORT_VALUES.includes(letter) ? args[next++] : undefined);
    }
    i = next;
  }
  for (; i < end; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const name = arg.split('=')[0];
      const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined;
      const value = inline ?? (TAR_LONG_VALUES.has(name) ? args[++i] : undefined);
      result.used.push(name);
      if (abbreviatesLong(arg, TAR_RUNS_PROGRAMS)) result.runs ??= name;
      if (name === '--file' && value !== undefined) result.archives.push(value);
      if (name === '--directory' && value !== undefined) result.directories.push(value);
    } else if (arg.startsWith('-') && arg !== '-') {
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j];
        if (!TAR_SHORT_VALUES.includes(letter)) {
          take(letter, undefined);
          continue;
        }
        const rest = arg.slice(j + 1);
        take(letter, rest !== '' ? rest : args[++i]);
        break;
      }
    }
  }
  return result;
}

/**
 * tar lists archives safely only in list mode (`-t`) with allowlisted options. Options that run
 * programs (`-I`, `--use-compress-program`, `--checkpoint-action=exec`, `--to-command`, `-F`,
 * and their abbreviations) make any tar call normal and never remembered. Archive names with a
 * colon (`host:file`) are opened on a remote host through rsh/ssh.
 */
export const tar: Classifier = (args, _ctx, name) => {
  const options = readTarOptions(args);
  if (options.runs !== undefined) {
    return normal(`Runs a command (${name} ${options.runs})`, { rememberable: false });
  }
  const remote = options.archives.find((archive) => /^[^/\\]{2,}:/.test(archive));
  if (remote !== undefined && !options.used.includes('--force-local')) {
    return normal(`Opens an archive on a remote host (${name} -f ${remote})`, {
      rememberable: false,
    });
  }
  const lists = options.used.includes('-t') || options.used.includes('--list');
  const readOnly = options.used.every((option) =>
    option.startsWith('--') ? TAR_LIST_LONG.includes(option) : TAR_LIST_SHORT.includes(option[1]),
  );
  return lists && readOnly
    ? safe(`Lists archive contents (${name})`, {
        paths: [...options.archives, ...options.directories],
      })
    : normal(`Creates or extracts archives (${name})`);
};
