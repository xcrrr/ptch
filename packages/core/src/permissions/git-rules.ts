import { parseOptions, pathArguments, valuesOf, type OptionSpec } from './options.js';
import {
  abbreviatesLong,
  destructive,
  endOfOptions,
  firstOperandIndex,
  hasOption,
  isOption,
  network,
  normal,
  operands,
  raise,
  safe,
  type ProgramContext,
  type Verdict,
  own,
} from './risk-helpers.js';

// prettier-ignore
const GLOBAL_VALUE_OPTIONS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env',
  '--exec-path', '--list-cmds', '--attr-source',
]);

/**
 * Global options. `-c`, `--config-env`, `--exec-path=<dir>`, `--git-dir`, `--work-tree`, `--bare`
 * and `--attr-source` make git load configuration (hooks, `core.fsmonitor`, aliases, filters)
 * or programs from elsewhere: such calls are never safe and never remembered.
 */
const GLOBAL_SPEC: OptionSpec = {
  short: 'pPhv',
  shortValue: 'Cc',
  long: [
    '--no-pager',
    '--paginate',
    '--no-replace-objects',
    '--literal-pathspecs',
    '--glob-pathspecs',
    '--noglob-pathspecs',
    '--icase-pathspecs',
    '--no-optional-locks',
    '--no-advice',
    '--version',
    '--help',
    '--html-path',
    '--man-path',
    '--info-path',
    '--bare',
    '--no-lazy-fetch',
  ],
  longValue: [
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--super-prefix',
    '--config-env',
    '--list-cmds',
    '--attr-source',
  ],
  longOptional: ['--exec-path'],
  pathValues: ['-C'],
};
const CONFIGURING_GLOBALS = [
  '-c',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--bare',
  '--attr-source',
];

const NETWORK = new Set(['fetch', 'pull', 'clone', 'ls-remote', 'send-email', 'lfs']);

/** Subcommands that change local repository or working-tree state in recoverable ways. */
// prettier-ignore
const LOCAL_CHANGES = new Set([
  'add', 'mv', 'init', 'merge', 'cherry-pick', 'revert', 'apply', 'am', 'bisect', 'format-patch',
  'archive', 'bundle', 'repack', 'maintenance', 'sparse-checkout', 'symbolic-ref', 'update-index',
  'difftool', 'mergetool', 'request-pull',
]);

const HISTORY_REWRITES: Record<string, string> = {
  rebase: 'Rewrites history',
  'filter-branch': 'Rewrites history',
  'filter-repo': 'Rewrites history',
  replace: 'Replaces objects',
  'update-ref': 'Rewrites refs',
  prune: 'Deletes unreachable objects',
};

// -----------------------------------------------------------------------------------------------
// Read-only option allowlists

function merge(...specs: OptionSpec[]): OptionSpec {
  const join = (key: keyof OptionSpec): string[] =>
    specs.flatMap(
      (spec) => (spec[key] as readonly string[] | string | undefined) ?? [],
    ) as string[];
  return {
    short: specs.map((spec) => spec.short ?? '').join(''),
    shortValue: specs.map((spec) => spec.shortValue ?? '').join(''),
    shortOptional: specs.map((spec) => spec.shortOptional ?? '').join(''),
    long: join('long'),
    longValue: join('longValue'),
    longOptional: join('longOptional'),
    pathValues: join('pathValues'),
    numeric: specs.some((spec) => spec.numeric),
  };
}

/** Diff output options (`git diff`, `log -p`, `show`). Not `--output`, `--ext-diff`, `--textconv`. */
const DIFF: OptionSpec = {
  short: 'pusRabwWzDtrcm',
  shortValue: 'SGOIlU',
  shortOptional: 'MCBX',
  long: [
    '--patch',
    '--no-patch',
    '--raw',
    '--patch-with-raw',
    '--patch-with-stat',
    '--indent-heuristic',
    '--no-indent-heuristic',
    '--minimal',
    '--patience',
    '--histogram',
    '--numstat',
    '--shortstat',
    '--summary',
    '--compact-summary',
    '--cumulative',
    '--name-only',
    '--name-status',
    '--full-index',
    '--binary',
    '--check',
    '--no-color',
    '--no-color-moved',
    '--no-color-moved-ws',
    '--no-renames',
    '--rename-empty',
    '--no-rename-empty',
    '--text',
    '--ignore-cr-at-eol',
    '--ignore-space-at-eol',
    '--ignore-space-change',
    '--ignore-all-space',
    '--ignore-blank-lines',
    '--function-context',
    '--exit-code',
    '--quiet',
    '--no-ext-diff',
    '--no-textconv',
    '--ita-invisible-in-index',
    '--ita-visible-in-index',
    '--no-prefix',
    '--default-prefix',
    '--irreversible-delete',
    '--pickaxe-all',
    '--pickaxe-regex',
    '--follow',
    '--no-abbrev',
    '--find-copies-harder',
    '--no-relative',
    '--cc',
    '--combined-all-paths',
    '--remerge-diff',
    '--no-diff-merges',
    '--dd',
    '--no-stat',
  ],
  longValue: [
    '--diff-filter',
    '--diff-algorithm',
    '--anchored',
    '--stat-width',
    '--stat-name-width',
    '--stat-graph-width',
    '--stat-count',
    '--src-prefix',
    '--dst-prefix',
    '--line-prefix',
    '--output-indicator-new',
    '--output-indicator-old',
    '--output-indicator-context',
    '--ws-error-highlight',
    '--word-diff-regex',
    '--ignore-matching-lines',
    '--skip-to',
    '--rotate-to',
    '--orderfile',
    '--find-object',
    '--unified',
    '--diff-merges',
    '--inter-hunk-context',
    '--color-moved-ws',
    '--max-depth',
  ],
  longOptional: [
    '--stat',
    '--dirstat',
    '--dirstat-by-file',
    '--color',
    '--word-diff',
    '--color-moved',
    '--abbrev',
    '--relative',
    '--find-renames',
    '--find-copies',
    '--break-rewrites',
    '--color-words',
    '--submodule',
    '--ignore-submodules',
  ],
  pathValues: ['-O', '--orderfile'],
};

/** Revision and log options. */
const REVISIONS: OptionSpec = {
  short: 'iEFPg',
  shortValue: 'nL',
  numeric: true,
  long: [
    '--all',
    '--reflog',
    '--alternate-refs',
    '--single-worktree',
    '--ignore-missing',
    '--bisect',
    '--stdin',
    '--cherry-mark',
    '--cherry-pick',
    '--left-only',
    '--right-only',
    '--cherry',
    '--walk-reflogs',
    '--merge',
    '--boundary',
    '--simplify-by-decoration',
    '--first-parent',
    '--exclude-first-parent-only',
    '--not',
    '--do-walk',
    '--merges',
    '--no-merges',
    '--no-min-parents',
    '--no-max-parents',
    '--full-history',
    '--dense',
    '--sparse',
    '--simplify-merges',
    '--show-pulls',
    '--date-order',
    '--author-date-order',
    '--topo-order',
    '--reverse',
    '--objects',
    '--objects-edge',
    '--unpacked',
    '--relative-date',
    '--parents',
    '--children',
    '--left-right',
    '--graph',
    '--no-graph',
    '--oneline',
    '--abbrev-commit',
    '--no-abbrev-commit',
    '--no-expand-tabs',
    '--no-notes',
    '--show-notes',
    '--standard-notes',
    '--no-standard-notes',
    '--show-signature',
    '--log-size',
    '--no-decorate',
    '--clear-decorations',
    '--source',
    '--mailmap',
    '--no-mailmap',
    '--use-mailmap',
    '--no-use-mailmap',
    '--full-diff',
    '--all-match',
    '--invert-grep',
    '--regexp-ignore-case',
    '--basic-regexp',
    '--extended-regexp',
    '--fixed-strings',
    '--perl-regexp',
    '--remove-empty',
    '--count',
    '--in-commit-order',
    '--timestamp',
    '--header',
  ],
  longValue: [
    '--max-count',
    '--skip',
    '--since',
    '--after',
    '--until',
    '--before',
    '--since-as-filter',
    '--author',
    '--committer',
    '--grep-reflog',
    '--grep',
    '--min-parents',
    '--max-parents',
    '--glob',
    '--exclude',
    '--exclude-hidden',
    '--date',
    '--format',
    '--encoding',
    '--decorate-refs',
    '--decorate-refs-exclude',
    '--max-age',
    '--min-age',
  ],
  longOptional: [
    '--branches',
    '--tags',
    '--remotes',
    '--no-walk',
    '--ancestry-path',
    '--pretty',
    '--expand-tabs',
    '--notes',
    '--decorate',
    '--show-linear-break',
  ],
};

const LOG = merge(DIFF, REVISIONS);
const DIFF_PLUMBING = merge(DIFF, {
  short: 'vq',
  numeric: true,
  long: [
    '--root',
    '--stdin',
    '--no-commit-id',
    '--always',
    '--cached',
    '--merge-base',
    '--base',
    '--ours',
    '--theirs',
  ],
  longValue: ['--format'],
  longOptional: ['--pretty'],
});

// prettier-ignore
const READ_ONLY_SPECS: Record<string, OptionSpec> = {
  status: {
    short: 'sbvz',
    shortOptional: 'u',
    long: ['--short', '--branch', '--show-stash', '--long', '--verbose', '--null', '--no-column', '--ahead-behind', '--no-ahead-behind', '--renames', '--no-renames'],
    longOptional: ['--porcelain', '--untracked-files', '--ignore-submodules', '--ignored', '--column', '--find-renames'],
  },
  log: LOG,
  show: LOG,
  whatchanged: LOG,
  'rev-list': merge(LOG, { long: ['--no-object-names', '--object-names', '--disk-usage', '--bisect-all', '--bisect-vars', '--use-bitmap-index', '--quiet'] }),
  shortlog: merge(REVISIONS, { short: 'nsec', shortOptional: 'w', long: ['--numbered', '--summary', '--email', '--committer'], longValue: ['--group'] }),
  diff: merge(DIFF, { numeric: true, long: ['--cached', '--staged', '--no-index', '--base', '--ours', '--theirs', '--merge-base'] }),
  'diff-tree': DIFF_PLUMBING,
  'diff-index': DIFF_PLUMBING,
  'diff-files': DIFF_PLUMBING,
  'range-diff': merge(DIFF, { long: ['--no-dual-color', '--left-only', '--right-only', '--no-notes'], longValue: ['--creation-factor'], longOptional: ['--notes'] }),
  blame: {
    short: 'bltpcfnsewh',
    shortValue: 'LS',
    shortOptional: 'MC',
    long: ['--root', '--show-stats', '--first-parent', '--porcelain', '--line-porcelain', '--incremental', '--progress', '--no-progress', '--color-lines', '--color-by-age', '--score-debug', '--show-name', '--show-number', '--show-email', '--minimal'],
    longValue: ['--reverse', '--encoding', '--contents', '--date', '--ignore-rev', '--ignore-revs-file'],
    longOptional: ['--abbrev'],
    pathValues: ['-S', '--contents', '--ignore-revs-file'],
  },
  'ls-files': {
    short: 'cdmoiskuzftv',
    shortValue: 'xX',
    long: ['--cached', '--deleted', '--modified', '--others', '--ignored', '--stage', '--killed', '--directory', '--no-empty-directory', '--unmerged', '--resolve-undo', '--eol', '--deduplicate', '--full-name', '--recurse-submodules', '--debug', '--sparse', '--error-unmatch', '--exclude-standard'],
    longValue: ['--exclude', '--exclude-from', '--exclude-per-directory', '--with-tree', '--format'],
    longOptional: ['--abbrev'],
    pathValues: ['-X', '--exclude-from'],
  },
  'ls-tree': { short: 'drtlz', long: ['--name-only', '--name-status', '--object-only', '--full-name', '--full-tree', '--long'], longValue: ['--format'], longOptional: ['--abbrev'] },
  'cat-file': { short: 'tspeZ', long: ['--batch-all-objects', '--buffer', '--follow-symlinks', '--unordered', '--allow-unknown-type'], longOptional: ['--batch', '--batch-check', '--batch-command'] },
  describe: { long: ['--all', '--tags', '--contains', '--exact-match', '--debug', '--long', '--always', '--first-parent'], longValue: ['--candidates', '--match', '--exclude'], longOptional: ['--dirty', '--broken', '--abbrev'] },
  'rev-parse': {
    short: 'q',
    long: ['--show-toplevel', '--git-dir', '--absolute-git-dir', '--git-common-dir', '--is-inside-work-tree', '--is-inside-git-dir', '--is-bare-repository', '--is-shallow-repository', '--show-cdup', '--show-prefix', '--show-superproject-working-tree', '--shared-index-path', '--verify', '--quiet', '--symbolic', '--symbolic-full-name', '--all', '--revs-only', '--no-revs', '--flags', '--no-flags', '--not', '--sq', '--sq-quote', '--local-env-vars', '--keep-dashdash', '--stop-at-non-option', '--stuck-long'],
    longValue: ['--since', '--until', '--after', '--before', '--git-path', '--resolve-git-dir', '--path-format', '--prefix', '--default', '--exclude', '--glob', '--disambiguate'],
    longOptional: ['--short', '--abbrev-ref', '--branches', '--tags', '--remotes', '--show-object-format', '--show-ref-format'],
    pathValues: ['--resolve-git-dir'],
  },
  'merge-base': { short: 'a', long: ['--octopus', '--independent', '--is-ancestor', '--fork-point', '--all'] },
  'name-rev': { long: ['--tags', '--all', '--annotate-stdin', '--stdin', '--name-only', '--no-undefined', '--always'], longValue: ['--refs', '--exclude'] },
  'show-ref': { short: 'dsq', long: ['--head', '--branches', '--heads', '--tags', '--dereference', '--verify', '--quiet', '--exists'], longOptional: ['--hash', '--abbrev', '--exclude-existing'] },
  'for-each-ref': { long: ['--shell', '--perl', '--python', '--tcl', '--ignore-case', '--omit-empty', '--include-root-refs', '--stdin'], longValue: ['--count', '--sort', '--format', '--points-at', '--exclude'], longOptional: ['--color', '--merged', '--no-merged', '--contains', '--no-contains'] },
  'count-objects': { short: 'vH', long: ['--verbose', '--human-readable'] },
  var: { short: 'l' },
  help: { short: 'agc', long: ['--all', '--guides', '--config', '--user-interfaces', '--developer-interfaces', '--no-external-commands', '--no-aliases', '--verbose'] },
  version: { long: ['--build-options'] },
  'check-ignore': { short: 'qvnz', long: ['--quiet', '--verbose', '--non-matching', '--no-index', '--stdin'] },
  'check-attr': { short: 'az', long: ['--all', '--cached', '--stdin'], longValue: ['--source'] },
  'check-ref-format': { long: ['--normalize', '--allow-onelevel', '--no-allow-onelevel', '--refspec-pattern', '--branch'] },
  'show-branch': { short: 'arg', long: ['--all', '--remotes', '--topo-order', '--date-order', '--current', '--no-color', '--sparse', '--list', '--merge-base', '--independent', '--no-name', '--sha1-name', '--topics'], longOptional: ['--color', '--more', '--reflog'] },
  cherry: { short: 'v', longOptional: ['--abbrev'] },
  fsck: { short: 'v', long: ['--unreachable', '--dangling', '--no-dangling', '--root', '--tags', '--cache', '--no-reflogs', '--full', '--no-full', '--connectivity-only', '--strict', '--verbose', '--name-objects', '--no-progress', '--progress', '--without-reflogs'] },
  'verify-commit': { short: 'v', long: ['--verbose', '--raw'], longValue: ['--format'] },
  'verify-tag': { short: 'v', long: ['--verbose', '--raw'], longValue: ['--format'] },
  grep: {
    short: 'aiIrvhHEGPFnlLzocpWq',
    shortValue: 'efABCm',
    numeric: true,
    long: ['--cached', '--no-exclude-standard', '--exclude-standard', '--recurse-submodules', '--text', '--no-textconv', '--ignore-case', '--recursive', '--no-recursive', '--word-regexp', '--invert-match', '--full-name', '--extended-regexp', '--basic-regexp', '--perl-regexp', '--fixed-strings', '--line-number', '--column', '--files-with-matches', '--name-only', '--files-without-match', '--null', '--only-matching', '--count', '--no-color', '--break', '--heading', '--show-function', '--function-context', '--and', '--or', '--not', '--all-match', '--quiet'],
    longValue: ['--max-depth', '--threads', '--context', '--after-context', '--before-context', '--max-count', '--regexp', '--file'],
    longOptional: ['--color'],
    pathValues: ['-f', '--file'],
  },
};
READ_ONLY_SPECS.annotate = READ_ONLY_SPECS.blame;

const STASH_SHOW = merge(DIFF, {
  short: 'u',
  long: ['--include-untracked', '--only-untracked', '--no-include-untracked'],
});
const BRANCH_LIST: OptionSpec = {
  short: 'arvlqi',
  long: [
    '--all',
    '--remotes',
    '--verbose',
    '--list',
    '--quiet',
    '--show-current',
    '--ignore-case',
    '--omit-empty',
    '--no-color',
    '--no-column',
    '--no-abbrev',
  ],
  longValue: [
    '--sort',
    '--format',
    '--points-at',
    '--contains',
    '--no-contains',
    '--merged',
    '--no-merged',
  ],
  longOptional: ['--color', '--column', '--abbrev'],
};
const TAG_LIST: OptionSpec = {
  short: 'li',
  shortOptional: 'n',
  long: ['--list', '--ignore-case', '--omit-empty', '--no-column', '--no-color'],
  longValue: [
    '--sort',
    '--format',
    '--points-at',
    '--contains',
    '--no-contains',
    '--merged',
    '--no-merged',
  ],
  longOptional: ['--column', '--color'],
};
const CONFIG_READ: OptionSpec = {
  short: 'lz',
  shortValue: 'f',
  long: [
    '--get',
    '--get-all',
    '--get-regexp',
    '--get-urlmatch',
    '--list',
    '--name-only',
    '--show-origin',
    '--show-scope',
    '--global',
    '--system',
    '--local',
    '--worktree',
    '--bool',
    '--int',
    '--bool-or-int',
    '--path',
    '--expiry-date',
    '--null',
    '--includes',
    '--no-includes',
    '--fixed-value',
    '--all',
  ],
  longValue: ['--file', '--blob', '--type', '--default', '--regexp', '--value', '--url'],
  pathValues: ['-f', '--file'],
};
const ACTION_SPECS: Record<string, OptionSpec> = {
  'stash list': LOG,
  'stash show': STASH_SHOW,
  'worktree list': { short: 'vz', long: ['--porcelain', '--verbose'], longOptional: ['--expire'] },
  'submodule status': { short: 'q', long: ['--cached', '--recursive', '--quiet'] },
  'submodule summary': {
    short: 'n',
    long: ['--cached', '--files', '--for-status'],
    longValue: ['--summary-limit'],
  },
  'notes list': { longValue: ['--ref'] },
  'notes show': { longValue: ['--ref'] },
  'reflog show': LOG,
  'reflog list': {},
  'reflog exists': {},
  remote: { short: 'v', long: ['--verbose'] },
  'remote get-url': { long: ['--push', '--all'] },
  clean: {
    short: 'ndxXqf',
    shortValue: 'e',
    long: ['--dry-run', '--quiet', '--force'],
    longValue: ['--exclude'],
  },
};

/**
 * A safe verdict when every option in `rest` is on `spec`'s allowlist; otherwise normal and never
 * remembered (git has options that write files or run programs).
 */
function readOnlyGit(
  label: string,
  rest: readonly string[],
  spec: OptionSpec,
  reason?: string,
  extra: Partial<Verdict> = {},
): Verdict {
  const parsed = parseOptions(rest, spec);
  if (parsed.unknown !== undefined) {
    return normal(`Uses an option that is not known to be read-only (${label} ${parsed.unknown})`, {
      rememberable: false,
      ...(extra.prefixLength === undefined ? {} : { prefixLength: extra.prefixLength }),
    });
  }
  return safe(reason ?? `Reads repository state (${label})`, {
    ...extra,
    paths: pathArguments(parsed, spec),
  });
}

// -----------------------------------------------------------------------------------------------
// Options that write files or run programs, in any subcommand

/** Long options (and their abbreviations) that make git run a program or load hooks. */
const RUNS_PROGRAMS = [
  '--upload-pack',
  '--receive-pack',
  '--exec',
  '--extcmd',
  '--open-files-in-pager',
];
/** Short spellings of such options, per subcommand. */
const RUNS_PROGRAMS_SHORT: Record<string, string> = {
  clone: 'u',
  'ls-remote': 'u',
  difftool: 'x',
  rebase: 'x',
  grep: 'O',
};
/** Options that install hooks or configuration into a new repository (`clone`, `init`). */
const INSTALLS_HOOKS = ['--template', '--config', '--separate-git-dir'];

/**
 * Why `git <sub> <rest>` writes a file or runs a program named in its options, whatever the
 * subcommand otherwise does: `--output` (diff family), `--upload-pack`/`-u` (fetch, clone,
 * ls-remote), `--receive-pack`, `--exec` (archive, rebase), `-x`/`--extcmd` (difftool), `-O`
 * (grep), `--template`/`-c` (clone, init: hooks run later), `submodule foreach`, `bisect run`.
 * Undefined when there is none.
 */
function sideEffects(
  sub: string,
  rest: readonly string[],
  ctx: ProgramContext,
): Verdict | undefined {
  const options = rest.slice(0, endOfOptions(rest)).filter(isOption);
  const label = `git ${sub}`;
  /** Letters of a short-option cluster, up to its first non-letter (`-Ovim` → `Ovim`). */
  const letters = (arg: string): string =>
    arg.startsWith('--') ? '' : (/^-([A-Za-z]*)/.exec(arg)?.[1] ?? '');
  const runs = options.find(
    (arg) =>
      abbreviatesLong(arg, RUNS_PROGRAMS) ||
      [...(own(RUNS_PROGRAMS_SHORT, sub) ?? '')].some((letter) => letters(arg).includes(letter)),
  );
  if (runs !== undefined) {
    return normal(`Runs a program named in its options (${label} ${runs})`, {
      rememberable: false,
    });
  }
  if (sub === 'clone' || sub === 'init') {
    const hooks = options.find(
      (arg) =>
        abbreviatesLong(arg, INSTALLS_HOOKS) || (sub === 'clone' && letters(arg).includes('c')),
    );
    if (hooks !== undefined) {
      return normal(`Installs hooks or configuration that run code later (${label} ${hooks})`, {
        rememberable: false,
      });
    }
  }
  const output = options.find((arg) => abbreviatesLong(arg, ['--output']));
  if (output !== undefined && !['format-patch', 'archive', 'bundle'].includes(sub)) {
    return normal(`Writes output to a file (${label} --output)`, { rememberable: false });
  }
  const action = rest.find((arg) => !isOption(arg));
  if (sub === 'submodule' && action === 'foreach') {
    const script = rest
      .slice(rest.indexOf('foreach') + 1)
      .filter((arg) => !/^--(recursive|quiet)$/.test(arg));
    return raise(
      normal('Runs a command in each submodule (git submodule foreach)', { rememberable: false }),
      ctx.analyzeScript(script.join(' ')),
    );
  }
  if (sub === 'bisect' && action === 'run') {
    return raise(
      normal('Runs a command at each bisection step (git bisect run)', { rememberable: false }),
      ctx.analyzeScript(rest.slice(rest.indexOf('run') + 1).join(' ')),
    );
  }
  return undefined;
}

// -----------------------------------------------------------------------------------------------

/**
 * Classifies `git <args>`. The rule prefix covers the program, global options and the subcommand
 * (plus the action for `stash`, `remote`, `worktree`, `submodule`, `notes`, `reflog`). Read-only
 * subcommands are safe only with allowlisted options (see READ_ONLY_SPECS).
 */
export function classifyGit(args: string[], ctx: ProgramContext): Verdict {
  const index = firstOperandIndex(args, GLOBAL_VALUE_OPTIONS);
  const globals = parseOptions(index < 0 ? args : args.slice(0, index), GLOBAL_SPEC);
  if (globals.unknown !== undefined) {
    return normal(`Uses an option that is not known to be read-only (git ${globals.unknown})`, {
      rememberable: false,
    });
  }
  const configuring =
    globals.used.find((option) => CONFIGURING_GLOBALS.includes(option)) ??
    (valuesOf(globals, '--exec-path').length > 0 ? '--exec-path' : undefined);
  const cValues = valuesOf(globals, '-C');
  // `-C <dir>` and `cd` make git load the configuration of whatever repository governs that
  // directory. A read that would be safe runs that repo's textconv/filter/diff drivers, so it is
  // only safe when the repository is the project's own; a nested repo makes it normal and never
  // remembered (see gitRepositoryIsProject).
  const inOtherRepo = (verdict: Verdict): Verdict => {
    if (verdict.risk !== 'safe' || ctx.gitRepoIsProject(cValues) !== false) return verdict;
    return normal("Uses another repository's configuration (git -C)", { rememberable: false });
  };
  if (index < 0) {
    if (configuring !== undefined) {
      return normal(`Overrides git configuration (git ${configuring})`, { rememberable: false });
    }
    const informational = globals.used.every((option) =>
      /^(--version|--help|-h|-v|--exec-path|--html-path|--man-path|--info-path|--no-pager|-P)$/.test(
        option,
      ),
    );
    // `git` with only global options and no subcommand (`git -C sub`, `git -p`) must not offer a
    // bare `git` grant that would then cover `git fetch`, `git commit`, etc.
    return informational
      ? inOtherRepo(safe('Prints git information', { paths: [] }))
      : normal('Runs git', { rememberable: false });
  }
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  const result = classifySubcommand(subcommand, rest, ctx);
  const withPrefix: Verdict = {
    ...result,
    prefixLength: index + 1 + (result.prefixLength ?? 1),
    ...(result.paths === undefined
      ? {}
      : { paths: [...pathArguments({ ...globals, operands: [] }, GLOBAL_SPEC), ...result.paths] }),
  };
  if (configuring === undefined) return inOtherRepo(withPrefix);
  const configured: Verdict = { ...withPrefix, rememberable: false, paths: undefined };
  return withPrefix.risk === 'safe'
    ? { ...configured, risk: 'normal', reason: `Overrides git configuration (git ${configuring})` }
    : configured;
}

/** Index of the subcommand in `git <args>` (after global options), or -1 when there is none. */
export function gitSubcommandIndex(args: readonly string[]): number {
  return firstOperandIndex(args, GLOBAL_VALUE_OPTIONS);
}

/**
 * `git grep` searches tracked files, except with `--no-index`/`--untracked` (untracked files such
 * as `.env`).
 */
function classifyGrep(rest: string[]): Verdict | undefined {
  const options = rest.slice(0, endOfOptions(rest));
  if (options.some((arg) => abbreviatesLong(arg, ['--no-index', '--untracked']))) {
    return normal(
      'Searches untracked files, including files that may contain secrets (git grep --no-index)',
      { rememberable: false, concern: 'secret' },
    );
  }
  return undefined;
}

/**
 * `git diff --no-index a b` (and, outside a repository, the implicit `git diff a b` that git turns
 * into `--no-index`) compares the operands recursively as directory trees, printing every file in
 * them, `.env` included. It is rarely needed, so being strict costs little: never safe, never
 * remembered.
 */
function classifyDiff(rest: string[], ctx: ProgramContext): Verdict | undefined {
  const explicit = rest
    .slice(0, endOfOptions(rest))
    .some((arg) => abbreviatesLong(arg, ['--no-index']));
  const paths = operands(rest);
  if (explicit && paths.length > 0) {
    return normal(
      'Compares directories recursively, including files that may contain secrets (git diff --no-index)',
      { rememberable: false, concern: 'secret' },
    );
  }
  if (!explicit && !rest.includes('--') && paths.length >= 2 && ctx.inGitWorkTree() !== true) {
    return normal(
      'Compares files outside version control, including files that may contain secrets (git diff)',
      { rememberable: false, concern: 'secret' },
    );
  }
  return undefined;
}

function classifySubcommand(sub: string, rest: string[], ctx: ProgramContext): Verdict {
  const label = `git ${sub}`;
  const effects = sideEffects(sub, rest, ctx);
  if (effects) return effects;
  if (sub === 'grep') {
    const grep = classifyGrep(rest);
    if (grep) return grep;
  }
  if (sub === 'diff') {
    const diff = classifyDiff(rest, ctx);
    if (diff) return diff;
  }
  const readOnlySpec = own(READ_ONLY_SPECS, sub);
  if (readOnlySpec) return readOnlyGit(label, rest, readOnlySpec);
  if (NETWORK.has(sub)) return network(`Contacts a remote repository (${label})`);
  if (LOCAL_CHANGES.has(sub)) return normal(`Changes the repository (${label})`);
  const rewrite = own(HISTORY_REWRITES, sub);
  if (rewrite) return destructive(`${rewrite} (${label})`);
  switch (sub) {
    case 'commit':
      return hasOption(rest, { long: ['--amend'] })
        ? destructive('Rewrites the last commit (git commit --amend)')
        : normal('Creates a commit (git commit)');
    case 'push':
      return hasOption(rest, { short: 'n', long: ['--dry-run'] })
        ? network('Contacts a remote repository (git push --dry-run)')
        : destructive('Pushes to a remote repository (git push)');
    case 'clean':
      return hasOption(rest, { short: 'n', long: ['--dry-run'] }) &&
        !hasOption(rest, { short: 'i', long: ['--interactive'] })
        ? readOnlyGit(
            label,
            rest,
            ACTION_SPECS.clean,
            'Lists untracked files (git clean --dry-run)',
          )
        : destructive('Deletes untracked files (git clean)');
    case 'rm':
      return hasOption(rest, { long: ['--cached'] })
        ? normal('Untracks files (git rm --cached)')
        : destructive('Deletes files (git rm)');
    case 'gc':
      return rest.some((arg) => arg.startsWith('--prune'))
        ? destructive('Deletes unreachable objects (git gc --prune)')
        : normal('Optimizes the repository (git gc)');
    case 'reset':
      return classifyReset(rest, ctx);
    case 'checkout':
      return classifyCheckout(rest, ctx);
    case 'switch':
      return hasOption(rest, {
        short: 'fC',
        long: ['--discard-changes', '--force', '--force-create'],
      })
        ? destructive('Discards changes or overwrites a branch (git switch --force)')
        : normal('Switches branches (git switch)');
    case 'restore':
      return hasOption(rest, { short: 'S', long: ['--staged'] }) &&
        !hasOption(rest, { short: 'W', long: ['--worktree'] })
        ? normal('Unstages changes (git restore --staged)')
        : destructive('Discards uncommitted changes (git restore)');
    case 'branch':
      return classifyBranch(rest);
    case 'tag':
      return classifyTag(rest);
    case 'config':
      return classifyConfig(rest);
    case 'stash':
      return classifyStash(rest);
    case 'remote':
      return classifyRemote(rest);
    case 'reflog':
      return classifyReflog(rest);
    case 'worktree':
      return classifyAction('worktree', rest, {
        safe: ['list'],
        destructive: ['remove', 'prune'],
      });
    case 'submodule':
      return classifyAction('submodule', rest, {
        safe: ['status', 'summary'],
        network: ['update', 'add', 'sync'],
        destructive: ['deinit'],
      });
    case 'notes':
      return classifyAction('notes', rest, {
        safe: ['list', 'show'],
        destructive: ['remove', 'prune'],
      });
    case 'credential':
    case 'credential-store':
    case 'credential-cache':
      return normal(`Accesses stored credentials (${label})`, { rememberable: false });
    default:
      return normal(`Runs ${label}`);
  }
}

function classifyAction(
  group: string,
  rest: string[],
  actions: { safe?: string[]; network?: string[]; destructive?: string[] },
): Verdict {
  const actionIndex = rest.findIndex((arg) => !isOption(arg));
  const action = actionIndex < 0 ? undefined : rest[actionIndex];
  if (action === undefined) {
    const spec = ACTION_SPECS[`${group} ${actions.safe?.[0] ?? ''}`] ?? {};
    return readOnlyGit(`git ${group}`, rest, spec);
  }
  const label = `git ${group} ${action}`;
  if (actions.safe?.includes(action)) {
    const without = [...rest.slice(0, actionIndex), ...rest.slice(actionIndex + 1)];
    return readOnlyGit(label, without, ACTION_SPECS[`${group} ${action}`] ?? {}, undefined, {
      prefixLength: 2,
    });
  }
  if (actions.network?.includes(action)) {
    return network(`Contacts a remote repository (${label})`, { prefixLength: 2 });
  }
  if (actions.destructive?.includes(action)) return destructive(`Deletes data (${label})`);
  return normal(`Changes the repository (${label})`, { prefixLength: 2 });
}

function classifyReset(rest: string[], ctx: ProgramContext): Verdict {
  if (hasOption(rest, { long: ['--hard', '--merge', '--keep'] })) {
    return destructive('Discards uncommitted changes (git reset --hard)');
  }
  const separator = rest.indexOf('--');
  const before = operands(separator < 0 ? rest : rest.slice(0, separator));
  const unstageOnly =
    before.length === 0 ||
    (before.length === 1 && before[0] === 'HEAD') ||
    (separator >= 0 && before.every((arg) => arg === 'HEAD')) ||
    before.every((arg, i) => (i === 0 && arg === 'HEAD') || ctx.pathExists(arg) === true);
  return unstageOnly
    ? normal('Unstages changes (git reset)')
    : destructive('Moves the current branch (git reset <commit>)');
}

const CHECKOUT_VALUE_OPTIONS = new Set(['-b', '-B', '--orphan', '--conflict', '-t', '--track']);

function classifyCheckout(rest: string[], ctx: ProgramContext): Verdict {
  if (hasOption(rest, { short: 'fB', long: ['--force', '--ours', '--theirs'] })) {
    return destructive('Discards uncommitted changes (git checkout --force)');
  }
  if (rest.includes('--'))
    return destructive('Discards uncommitted changes to files (git checkout --)');
  const targets = operands(rest, CHECKOUT_VALUE_OPTIONS);
  // A target that may be a path (or cannot be checked) discards changes to it.
  if (targets.some((target) => looksLikePath(target) || ctx.pathExists(target) !== false)) {
    return destructive('Discards uncommitted changes to files (git checkout <path>)');
  }
  return hasOption(rest, { short: 'b', long: ['--orphan'] })
    ? normal('Creates a branch (git checkout -b)')
    : normal('Switches branches (git checkout)');
}

function looksLikePath(target: string): boolean {
  return (
    target === '.' ||
    target === '..' ||
    /^\.{1,2}[\\/]/.test(target) ||
    /[*?[]/.test(target) ||
    /\.[A-Za-z]\w*$/.test(target)
  );
}

const BRANCH_LIST_VALUE_OPTIONS = new Set([
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
  '--sort',
  '--format',
]);

function classifyBranch(rest: string[]): Verdict {
  if (hasOption(rest, { short: 'dD', long: ['--delete'] })) {
    return destructive('Deletes a branch (git branch -D)');
  }
  if (hasOption(rest, { short: 'fMC', long: ['--force'] })) {
    return destructive('Overwrites a branch (git branch --force)');
  }
  if (
    hasOption(rest, {
      short: 'mcu',
      long: [
        '--move',
        '--copy',
        '--set-upstream-to',
        '--unset-upstream',
        '--edit-description',
        '--track',
      ],
    })
  ) {
    return normal('Changes branches (git branch)');
  }
  const listing = hasOption(rest, { short: 'l', long: ['--list'] });
  if (!listing && operands(rest, BRANCH_LIST_VALUE_OPTIONS).length > 0) {
    return normal('Creates a branch (git branch)');
  }
  return readOnlyGit('git branch', rest, BRANCH_LIST, 'Lists branches (git branch)');
}

// prettier-ignore
const TAG_VALUE_OPTIONS = new Set([
  '-m', '-F', '-u', '--sort', '--format', '--contains', '--no-contains', '--points-at', '--merged',
  '--no-merged', '--cleanup',
]);

function classifyTag(rest: string[]): Verdict {
  if (hasOption(rest, { short: 'd', long: ['--delete'] }))
    return destructive('Deletes a tag (git tag -d)');
  if (hasOption(rest, { short: 'f', long: ['--force'] }))
    return destructive('Overwrites a tag (git tag -f)');
  const listing = hasOption(rest, { short: 'ln', long: ['--list'] });
  if (!listing && operands(rest, TAG_VALUE_OPTIONS).length > 0)
    return normal('Creates a tag (git tag)');
  return readOnlyGit('git tag', rest, TAG_LIST, 'Lists tags (git tag)');
}

const CONFIG_READS = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'];
// prettier-ignore
const CONFIG_WRITES = [
  '--unset', '--unset-all', '--remove-section', '--rename-section', '--add', '--replace-all',
  '--edit', '-e',
];

/** Config writes can install hooks, pagers or aliases that run code later: never remembered. */
function classifyConfig(rest: string[]): Verdict {
  const write = normal('Changes git configuration (git config)', { rememberable: false });
  if (rest.some((arg) => CONFIG_WRITES.includes(arg) || abbreviatesLong(arg, CONFIG_WRITES)))
    return write;
  const read = (): Verdict =>
    readOnlyGit('git config', rest, CONFIG_READ, 'Reads git configuration (git config)');
  if (rest.some((arg) => CONFIG_READS.includes(arg))) return read();
  const args = operands(rest, new Set(['--file', '-f', '--blob', '--type', '--default']));
  if (args[0] === 'get' || args[0] === 'list') {
    const without = rest.filter((arg) => arg !== args[0]);
    return readOnlyGit('git config', without, CONFIG_READ, 'Reads git configuration (git config)');
  }
  return args.length <= 1 ? read() : write;
}

function classifyStash(rest: string[]): Verdict {
  const actionIndex = rest.findIndex((arg) => !isOption(arg));
  const action = actionIndex < 0 ? undefined : rest[actionIndex];
  switch (action) {
    case 'list':
    case 'show': {
      const without = [...rest.slice(0, actionIndex), ...rest.slice(actionIndex + 1)];
      return readOnlyGit(
        `git stash ${action}`,
        without,
        ACTION_SPECS[`stash ${action}`],
        `Reads stashed changes (git stash ${action})`,
      );
    }
    case 'drop':
    case 'clear':
      return destructive(`Deletes stashed changes (git stash ${action})`);
    case 'push':
    case 'save':
    case 'apply':
    case 'pop':
    case 'branch':
    case 'create':
    case 'store':
      return normal(`Changes stashed changes (git stash ${action})`, { prefixLength: 2 });
    default:
      return normal('Stashes changes (git stash)');
  }
}

function classifyRemote(rest: string[]): Verdict {
  const actionIndex = rest.findIndex((arg) => !isOption(arg));
  const action = actionIndex < 0 ? undefined : rest[actionIndex];
  switch (action) {
    case undefined:
      return readOnlyGit('git remote', rest, ACTION_SPECS.remote, 'Lists remotes (git remote)');
    case 'get-url': {
      const without = [...rest.slice(0, actionIndex), ...rest.slice(actionIndex + 1)];
      return readOnlyGit(
        'git remote get-url',
        without,
        ACTION_SPECS['remote get-url'],
        'Lists remotes (git remote)',
      );
    }
    case 'show':
    case 'update':
    case 'prune':
      return network(`Contacts a remote repository (git remote ${action})`, { prefixLength: 2 });
    default:
      return normal(`Changes remotes (git remote ${action})`, { prefixLength: 2 });
  }
}

/** `git reflog [show|list|exists]` reads; `expire` and `delete` remove entries. */
function classifyReflog(rest: string[]): Verdict {
  const action = rest[0];
  if (action === 'expire' || action === 'delete') {
    return destructive(`Deletes reflog entries (git reflog ${action})`, { prefixLength: 2 });
  }
  if (action === 'list' || action === 'exists') {
    return readOnlyGit(`git reflog ${action}`, rest.slice(1), ACTION_SPECS[`reflog ${action}`]);
  }
  return readOnlyGit(
    'git reflog',
    action === 'show' ? rest.slice(1) : rest,
    ACTION_SPECS['reflog show'],
  );
}
