import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTempDir, writeFiles } from '../../src/testing/index.js';
import {
  analyzeCommandDetailed as analyzeCommand,
  type AnalyzeCommandOptions,
  type CommandRisk,
} from '../../src/permissions/command-risk.js';

/**
 * The classifier runs synchronously before the user is asked, on model-written input: it must
 * never throw and must stay fast whatever the command (no catastrophic regular expressions, no
 * unbounded file system work, no quadratic loops).
 */
// Typical calls take 1-20 ms. The limit catches catastrophic blow-ups (one input once took 82 s)
// while tolerating a machine busy running the whole test suite in parallel.
const LIMIT_MS = 250;
const RISKS: CommandRisk[] = ['safe', 'normal', 'network', 'destructive', 'blocked'];

/**
 * Analyzes a command twice and returns the analysis with the faster of the two times, so a
 * one-off pause (just-in-time compilation of a new code path, garbage collection, other test
 * workers) does not count against the classifier.
 */
function timedAnalysis(
  command: string,
  options: AnalyzeCommandOptions,
): { analysis: ReturnType<typeof analyzeCommand>; elapsed: number } {
  let elapsed = Number.POSITIVE_INFINITY;
  let analysis = analyzeCommand('true', options);
  for (let run = 0; run < 2; run++) {
    const started = performance.now();
    analysis = analyzeCommand(command, options);
    elapsed = Math.min(elapsed, performance.now() - started);
  }
  return { analysis, elapsed };
}

const POSIX: AnalyzeCommandOptions = {
  cwd: '/proj',
  projectRoot: '/proj',
  home: '/home/user',
  platform: 'linux',
};
const WINDOWS: AnalyzeCommandOptions = {
  cwd: 'C:\\proj',
  projectRoot: 'C:\\proj',
  home: 'C:\\Users\\user',
  platform: 'win32',
};

const deepGlob = 'node_modules/.pnpm/[a-f]*/node_modules/[a-z]*/*.zz';
const braces8 = '{a,b}'.repeat(8);

/** Inputs built to hit every expensive path: parsing, patterns, braces, budgets, pipes. */
const ADVERSARIAL: Array<[string, string]> = [
  ['extglob ripgrep glob', `rg -g '${'*(*)'.repeat(12)}Z' KEY`],
  ['extglob on disk', `cat 'node_modules/.pnpm/*(*)Z'`],
  ['extglob on disk, PowerShell', `Get-Content 'node_modules/.pnpm/*(*)Z'`],
  ['escaped extglob', 'cat node_modules/.pnpm/*\\(*\\)Z'],
  ['long star run', `cat ${'*'.repeat(5000)}Z`],
  ['star and class run', `cat ${'*[a-z]'.repeat(2000)}`],
  ['brace budget, one word', `cat ${braces8}/../${deepGlob}`],
  ['brace budget, six words', `cat ${Array(6).fill(`${braces8}/../${deepGlob}`).join(' ')}`],
  ['many brace alternatives', `cat ${'{a,b,c,d,e,f,g,h}'.repeat(40)}`],
  ['nested braces', `cat ${'{'.repeat(2000)}a${',b}'.repeat(2000)}`],
  ['brace sequences', `cat ${'{1..9}'.repeat(50)}`],
  ['many brace words', `cat ${Array(300).fill('{a,b,c}').join(' ')}`],
  ['comma braces', `cat {${Array(5000).fill('a').join(',')}}`],
  ['huge echo', `echo ${'a '.repeat(45_000)}`],
  ['huge single word', `echo ${'a'.repeat(99_000)}`],
  ['over the length limit', `echo ${'a b '.repeat(300_000)}`],
  ['over the length limit, unparsable', `"${'rm -rf x '.repeat(150_000)}`],
  ['many pipes', Array(3000).fill('cat a').join(' | ')],
  ['many downloads piped to a shell', `${Array(2000).fill('curl x').join(' | ')} | sh`],
  [
    'subshells piped into each other',
    `(${Array(400).fill('a').join(';')}) | (${Array(400).fill('b').join(';')}) | (c)`,
  ],
  ['many lists', Array(5000).fill('ls').join(' && ')],
  ['printed scripts piped to shells', Array(900).fill("echo 'rm -rf x' | sh").join('; ')],
  ['deep substitutions', `${'$('.repeat(40)}ls${')'.repeat(40)}`],
  ['deep subshells', `${'('.repeat(5000)}ls${')'.repeat(5000)}`],
  ['deep groups', `${'{ '.repeat(3000)}ls; ${'}; '.repeat(3000)}`],
  ['many prefix keywords', `${'! '.repeat(20_000)}ls`],
  ['deep shell payloads', `bash -c '${'bash -c '.repeat(30)}ls'`],
  ['nested backticks', '`'.repeat(1000)],
  ['long identifier', 'a'.repeat(99_000)],
  ['many identifiers', `${'abcdefghij'.repeat(7)} `.repeat(1300)],
  ['many function definitions', Array(900).fill('f(){ f|f& }').join('; ')],
  ['function openers', 'f(){ '.repeat(15_000)],
  ['unparsable', `echo "${'x '.repeat(45_000)}`],
  ['unparsable with programs', `"${'rm -rf x$RANDOM '.repeat(4000)}`],
  ['big heredoc', `cat > a.txt <<'EOF'\n${'line of text $x `y`\n'.repeat(4000)}EOF`],
  ['heredoc with substitutions', `cat > a.txt <<EOF\n${'line $(ls) text\n'.repeat(2000)}EOF`],
  ['many patterns', `cat ${Array(3000).fill('src/*.ts').join(' ')}`],
  ['many directory patterns', `ls ${Array(2000).fill('*/*/*/*').join(' ')}`],
  ['many words', `cat ${Array.from({ length: 9000 }, (_, i) => `f${i}`).join(' ')}`],
  ['many writes', `cp ${Array.from({ length: 9000 }, (_, i) => `d/f${i}`).join(' ')} z`],
  ['many redirections', `ls ${'> a '.repeat(4900)}`],
  ['many input redirections', `cat ${Array(500).fill('< src/*').join(' ')}`],
  ['many options', `git log ${'--oneline '.repeat(9000)}`],
  ['many find expressions', `find . ${'-name x '.repeat(4000)}`],
  ['many find commands', `find . ${'-exec rm {} ; '.repeat(2000)}`],
  ['long sed script', `sed '${'s/a/b/;'.repeat(12_000)}' a`],
  ['many cds', `${Array(2000).fill('cd a').join(' && ')} && cat x`],
  ['many cds then a pattern', `${Array(200).fill('cd a').join(' && ')} && cat ${deepGlob}`],
  ['unclosed classes', `cat ${'['.repeat(5000)}`],
  ['Windows wildcards', `Get-Content ${'a\\*'.repeat(5000)}`],
  ['PowerShell list', `Get-Content ${Array(9000).fill('a').join(',')}`],
  ['encoded command', `powershell -EncodedCommand ${'QQ'.repeat(40_000)}`],
  ['wrapper chain', `${Array(5000).fill('env').join(' ')} ls`],
  ['timeout chain', `${Array(4000).fill('timeout 1').join(' ')} ls`],
  ['xargs chain', `${Array(2000).fill('xargs').join(' ')} ls`],
  ['launcher chain', `${Array(3000).fill('pnpm exec').join(' ')} ls`],
  ['many ssh hops', `ssh h ${'ssh h '.repeat(3000)}ls`],
  ['ANSI-C strings', `echo $'${'\\x41'.repeat(20_000)}'`],
  ['arithmetic', `echo $((${'('.repeat(10_000)}1${')'.repeat(10_000)}))`],
  ['parameter expansion', `echo \${${'{'.repeat(10_000)}`],
  ['many variables', `echo ${'"$A$B${C}" '.repeat(5000)}`],
  ['quoted text', `echo '${'x'.repeat(99_000)}'`],
  ['escaped text', `echo "${'x\\\\'.repeat(30_000)}"`],
  ['many quotes in a word', `echo ${"'a'".repeat(30_000)}`],
  ['network paths', 'cat //192.0.2.1/share/x \\\\192.0.2.2\\share\\y //192.0.2.3/s/*.txt'],
  ['device names', 'cat NUL COM1 con.txt LPT1 aux'],
  ['git many globals', `git ${'-C a '.repeat(4000)}status`],
  ['many fd commands', `fd x ${'-x echo ; '.repeat(3000)}`],
  ['deep nonexistent path', `touch ${'n/'.repeat(16_000)}x`],
  ['cd into a deep path then run', `cd ${'n/'.repeat(16_000)}x && pnpm test`],
  // Nested find -exec / fd -x recursion must be bounded (program-word position).
  ['nested find -exec', `find ${'-exec find '.repeat(1999)}ls`],
  ['nested fd -x', `fd ${'-x fd '.repeat(1999)}ls`],
  ['nested find -execdir', `find ${'-execdir find '.repeat(1999)}ls`],
  ['nested find -ok', `find ${'-ok find '.repeat(1999)}ls`],
  ['nested fd --exec=', `fd ${'--exec=fd '.repeat(1999)}ls`],
  // A program word full of `[` must not make PROGRAM_PATTERN backtrack.
  ['program word of brackets', `a${'['.repeat(99_000)}`],
  ['brackets in a shell payload', `bash -c 'a${'['.repeat(20_000)}'`],
  ['brackets after env', `env a${'['.repeat(20_000)}`],
  // Unclosed braces must not make shellMayExpand backtrack on win32.
  ['unclosed braces', `echo ${'{'.repeat(99_000)}`],
  ['unclosed brace lists', `echo ${'{a,'.repeat(30_000)}`],
  ['unclosed braces, redirect target', `echo hi > ${'{'.repeat(40_000)}`],
];

/** Deterministic pseudo-random generator (the fuzz corpus must be reproducible). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

// prettier-ignore
const FUZZ_TOKENS = [
  'ls', 'cat', 'rm', '-rf', 'git', 'push', 'log', '--output=', 'sudo', 'echo', 'rg', '-g', 'tar',
  '-I', '-tf', 'find', '-exec', '{}', ';', '.env', '.git/hooks/x', '*', '?', '[a-z]', '{a,b}',
  '{1..3}', '$X', '${Y}', '$(', ')', '`', "'", '"', '\\', '|', '||', '&&', '&', '>', '>>', '<',
  '2>&1', '<<EOF', '\n', '#', 'cd', '..', '-', '~', '/etc', '//host/s', 'C:\\x', '\\\\h\\s',
  'NUL', 'bash', '-c', 'pwsh', '-Command', 'cmd', '/c', 'env', '-S', 'xargs', 'npx', 'uv', 'run',
  'f()', '{', '}', ':', 'for', 'in', 'do', 'done', '$env:A', '%B%', '(', '!', '*(*)', '-o.git/x',
];

describe('classifier robustness', () => {
  let temp: { dir: string; cleanup: () => void };
  let host: AnalyzeCommandOptions;

  beforeAll(() => {
    temp = makeTempDir();
    host = { cwd: temp.dir, projectRoot: temp.dir, home: path.join(temp.dir, 'home') };
    // A tree shaped like node_modules/.pnpm, with long entry names for the pattern matchers.
    const files: Record<string, string> = { '.env': 'SECRET=1', 'src/a.ts': 'x' };
    for (let i = 0; i < 30; i++) {
      const name = `${'abcdef'[i % 6]}${'x'.repeat(60)}-${i}`;
      for (let j = 0; j < 10; j++) {
        files[`node_modules/.pnpm/${name}/node_modules/${'abcdefghij'[j]}${'y'.repeat(50)}/a.ts`] =
          'x';
      }
    }
    writeFiles(temp.dir, files);
    analyzeCommand('ls', host);
  });

  afterAll(() => temp.cleanup());

  for (const [platformName, options] of [
    ['posix', () => POSIX],
    ['windows', () => WINDOWS],
    ['host', () => host],
  ] as const) {
    it.each(ADVERSARIAL)(`%s: never throws and is fast (${platformName})`, (_name, command) => {
      const { analysis, elapsed } = timedAnalysis(command, options());
      expect(RISKS).toContain(analysis.risk);
      expect(elapsed).toBeLessThan(LIMIT_MS);
    });
  }

  it('bounds nested find -exec / fd -x recursion as destructive and unrememberable', () => {
    for (const command of [
      `find ${'-exec find '.repeat(1999)}ls`,
      `fd ${'-x fd '.repeat(1999)}ls`,
      `find ${'-execdir find '.repeat(1999)}ls`,
      `fd ${'--exec=fd '.repeat(1999)}ls`,
    ]) {
      for (const options of [POSIX, WINDOWS, host]) {
        const { analysis, elapsed } = timedAnalysis(command, options);
        expect(analysis.risk).toBe('destructive');
        expect(analysis.rulePrefix).toBeUndefined();
        expect(elapsed).toBeLessThan(LIMIT_MS);
      }
    }
  });

  it('never throws on random input, and never remembers destructive or unparsable commands', () => {
    const next = random(7);
    let slowest = 0;
    for (let i = 0; i < 1000; i++) {
      const length = 1 + Math.floor(next() * 24);
      const separators = [' ', ' ', ' ', ''];
      const command = Array.from(
        { length },
        () =>
          FUZZ_TOKENS[Math.floor(next() * FUZZ_TOKENS.length)] +
          separators[Math.floor(next() * separators.length)],
      ).join('');
      for (const options of [POSIX, WINDOWS, host]) {
        const { analysis, elapsed } = timedAnalysis(command, options);
        slowest = Math.max(slowest, elapsed);
        expect(RISKS, command).toContain(analysis.risk);
        if (analysis.unparsable || analysis.risk === 'destructive' || analysis.risk === 'blocked') {
          expect(analysis.rulePrefix, command).toBeUndefined();
        }
      }
    }
    expect(slowest).toBeLessThan(LIMIT_MS);
  });

  it('copes with directories it cannot read', (context) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) context.skip();
    const locked = path.join(temp.dir, 'locked');
    mkdirSync(path.join(locked, 'inner'), { recursive: true });
    chmodSync(locked, 0o000);
    try {
      for (const command of ['cat locked/*', 'cat locked/*/.e*', 'ls locked/*/x', 'cat locked/a']) {
        const { analysis, elapsed } = timedAnalysis(command, host);
        expect(elapsed).toBeLessThan(LIMIT_MS);
        expect(RISKS).toContain(analysis.risk);
      }
      // A pattern the directory listing cannot rule out still asks.
      expect(analyzeCommand('cat locked/*', host).risk).toBe('normal');
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});
