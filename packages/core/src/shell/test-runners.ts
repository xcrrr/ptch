import type { TestSummary } from './output.js';

/** A recognized summary and the index of the last output line it was read from. */
export interface TestDetection {
  summary: TestSummary;
  line: number;
}

type Bucket = keyof TestSummary;
/** Maps a summary word to a bucket; `null` marks words that are recognized but not counted. */
type Vocabulary = Readonly<Record<string, Bucket | null>>;
type Detector = (lines: readonly string[]) => TestDetection | undefined;

const VITEST_WORDS: Vocabulary = {
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
  todo: 'skipped',
};
const JEST_WORDS: Vocabulary = { ...VITEST_WORDS, pending: 'skipped', total: null };
const PYTEST_WORDS: Vocabulary = {
  passed: 'passed',
  failed: 'failed',
  error: 'failed',
  errors: 'failed',
  skipped: 'skipped',
  xfailed: 'skipped',
  xpassed: 'passed',
  deselected: null,
  warning: null,
  warnings: null,
  rerun: null,
};
const CARGO_WORDS: Vocabulary = {
  passed: 'passed',
  failed: 'failed',
  ignored: 'skipped',
  measured: null,
  filtered: null,
};
const NODE_TEST_WORDS: Vocabulary = {
  pass: 'passed',
  fail: 'failed',
  cancelled: 'failed',
  skipped: 'skipped',
  todo: 'skipped',
  tests: null,
  suites: null,
  duration_ms: null,
};
const BUN_WORDS: Readonly<Record<string, Bucket>> = {
  pass: 'passed',
  fail: 'failed',
  skip: 'skipped',
  todo: 'skipped',
};
const PHPUNIT_FIELDS: Vocabulary = {
  Failures: 'failed',
  Errors: 'failed',
  Skipped: 'skipped',
  Incomplete: 'skipped',
};
const GO_RESULTS: Readonly<Record<string, Bucket>> = {
  PASS: 'passed',
  FAIL: 'failed',
  SKIP: 'skipped',
};

const VITEST_TESTS = /^\s*Tests\s+(\d+ (?:passed|failed|skipped|todo)\b.*)$/;
const VITEST_FILES = /^\s*Test Files\s+(\d+ (?:passed|failed|skipped|todo)\b.*)$/;
const JEST_TESTS = /^\s*Tests:\s+(.*\d+ total)\s*$/;
const JEST_SUITES = /^\s*Test Suites:\s+(.*\d+ total)\s*$/;
const MOCHA_PASSING = /^\s*(\d+) passing\b/;
const MOCHA_FOLLOW_UP = /^\s*(\d+) (pending|failing)\b/;
const PYTEST_SUMMARY =
  /^=*\s*(\d+ [a-z]+(?:, \d+ [a-z]+)*) in \d+(?:\.\d+)?(?:s| seconds)\b(?: \([^)]*\))?\s*=*\s*$/;
const CARGO_RESULT = /^test result: (?:ok|FAILED)\. (.*)$/;
const GO_VERBOSE = /^\s*--- (PASS|FAIL|SKIP): /;
const GO_PACKAGE_OK = /^ok\s+\S+\s+(?:\(cached\)|\d+(?:\.\d+)?s)(?:\s|$)/;
const GO_PACKAGE_FAIL = /^FAIL\s+\S+\s+(?:\d+(?:\.\d+)?s|\[[a-z ]+ failed\])(?:\s|$)/;
const NODE_TEST_STAT = /^(?:#|ℹ)\s*([a-z_]+)\s+(\d+(?:\.\d+)?)\s*$/;
const RSPEC_SUMMARY = /^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?\b/;
const PHPUNIT_OK = /^OK \((\d+) tests?, \d+ assertions?\)/;
const PHPUNIT_TOTALS = /^Tests: (\d+), Assertions: \d+(.*)$/;
const PHPUNIT_FIELD = /\b([A-Z][a-z]+): (\d+)/g;
const BUN_RAN = /^Ran \d+ tests? across \d+ files?\b/;
const BUN_COUNT = /^\s*(\d+) (pass|fail|skip|todo)\s*$/;
const COUNT_WORD = /(\d+) ([a-z_]+)/gi;

/** Bun prints its counts on the few lines just above "Ran N tests across M files". */
const BUN_LOOKBACK_LINES = 6;

/**
 * Detectors for the supported runners. Each reports the summary it would pick for the whole
 * output; parseTestSummary keeps the one that appears last. Listed most specific first, which
 * decides ties on the same line.
 */
export const TEST_RUNNER_DETECTORS: readonly Detector[] = [
  detectVitest,
  detectJest,
  detectPhpunit,
  detectRspec,
  detectPytest,
  detectCargo,
  detectGo,
  detectMocha,
  detectNodeTest,
  detectBun,
];

function add(summary: TestSummary, bucket: Bucket, value: number): void {
  summary[bucket] = (summary[bucket] ?? 0) + value;
}

/** Sums "<count> <word>" pairs in `text`; undefined when no word is recognized. */
function countWords(text: string, words: Vocabulary): TestSummary | undefined {
  const summary: TestSummary = {};
  let recognized = false;
  for (const [, count, word] of text.matchAll(COUNT_WORD)) {
    const key = word.toLowerCase();
    if (!Object.hasOwn(words, key)) continue;
    recognized = true;
    const bucket = words[key];
    if (bucket) add(summary, bucket, Number(count));
  }
  return recognized ? summary : undefined;
}

/** The last line matching `pattern`, with its counts read from capture group 1. */
function lastSummaryLine(
  lines: readonly string[],
  pattern: RegExp,
  words: Vocabulary,
): TestDetection | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = pattern.exec(lines[index]);
    const summary = match ? countWords(match[1], words) : undefined;
    if (summary) return { summary, line: index };
  }
  return undefined;
}

/** `Tests  1 failed | 12 passed (13)`, falling back to `Test Files  ...`. */
function detectVitest(lines: readonly string[]): TestDetection | undefined {
  return (
    lastSummaryLine(lines, VITEST_TESTS, VITEST_WORDS) ??
    lastSummaryLine(lines, VITEST_FILES, VITEST_WORDS)
  );
}

/** `Tests:       1 failed, 12 passed, 13 total`, falling back to `Test Suites: ...`. */
function detectJest(lines: readonly string[]): TestDetection | undefined {
  return (
    lastSummaryLine(lines, JEST_TESTS, JEST_WORDS) ??
    lastSummaryLine(lines, JEST_SUITES, JEST_WORDS)
  );
}

/** `==== 1 failed, 12 passed, 2 skipped in 0.52s ====` (also the undecorated `-q` form). */
function detectPytest(lines: readonly string[]): TestDetection | undefined {
  return lastSummaryLine(lines, PYTEST_SUMMARY, PYTEST_WORDS);
}

/**
 * `test result: FAILED. 12 passed; 1 failed; 0 ignored; ...`. One `cargo test` prints a result
 * per test binary (unit, integration, doc tests), so all of them are summed.
 */
function detectCargo(lines: readonly string[]): TestDetection | undefined {
  const summary: TestSummary = {};
  let last = -1;
  lines.forEach((line, index) => {
    const match = CARGO_RESULT.exec(line);
    const found = match ? countWords(match[1], CARGO_WORDS) : undefined;
    if (!found) return;
    for (const [bucket, value] of Object.entries(found) as [Bucket, number][]) {
      add(summary, bucket, value);
    }
    last = index;
  });
  return last === -1 ? undefined : { summary, line: last };
}

/** Counts `--- PASS/FAIL/SKIP:` lines (`go test -v`), else `ok`/`FAIL` package lines. */
function detectGo(lines: readonly string[]): TestDetection | undefined {
  const tests: TestSummary = {};
  const packages: TestSummary = {};
  let lastTest = -1;
  let lastPackage = -1;
  lines.forEach((line, index) => {
    const verbose = GO_VERBOSE.exec(line);
    if (verbose) {
      add(tests, GO_RESULTS[verbose[1]], 1);
      lastTest = index;
    } else if (GO_PACKAGE_OK.test(line)) {
      add(packages, 'passed', 1);
      lastPackage = index;
    } else if (GO_PACKAGE_FAIL.test(line)) {
      add(packages, 'failed', 1);
      lastPackage = index;
    }
  });
  if (lastTest !== -1) return { summary: tests, line: Math.max(lastTest, lastPackage) };
  return lastPackage === -1 ? undefined : { summary: packages, line: lastPackage };
}

/** `12 passing (34ms)` followed by optional `2 pending` and `1 failing` lines. */
function detectMocha(lines: readonly string[]): TestDetection | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    const passing = MOCHA_PASSING.exec(lines[index]);
    if (!passing) continue;
    const summary: TestSummary = { passed: Number(passing[1]) };
    let last = index;
    for (let next = index + 1; next < lines.length && next <= index + 2; next++) {
      const followUp = MOCHA_FOLLOW_UP.exec(lines[next]);
      if (!followUp) break;
      add(summary, followUp[2] === 'failing' ? 'failed' : 'skipped', Number(followUp[1]));
      last = next;
    }
    return { summary, line: last };
  }
  return undefined;
}

/**
 * node:test statistics, as a block of consecutive lines: `# pass 12`, `# fail 1` (TAP reporter)
 * or `ℹ pass 12` (spec reporter).
 */
function detectNodeTest(lines: readonly string[]): TestDetection | undefined {
  let end = lines.length - 1;
  while (end >= 0) {
    if (!isNodeTestStat(lines[end])) {
      end--;
      continue;
    }
    let start = end;
    while (start > 0 && isNodeTestStat(lines[start - 1])) start--;
    const summary: TestSummary = {};
    let counted = false;
    for (let index = start; index <= end; index++) {
      const [, word, count] = NODE_TEST_STAT.exec(lines[index])!;
      const bucket = NODE_TEST_WORDS[word];
      if (!bucket) continue;
      add(summary, bucket, Number(count));
      counted = true;
    }
    if (counted) return { summary, line: end };
    end = start - 1;
  }
  return undefined;
}

function isNodeTestStat(line: string): boolean {
  const match = NODE_TEST_STAT.exec(line);
  return match !== null && Object.hasOwn(NODE_TEST_WORDS, match[1]);
}

/** `13 examples, 1 failure, 2 pending`. */
function detectRspec(lines: readonly string[]): TestDetection | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = RSPEC_SUMMARY.exec(lines[index].trim());
    if (!match) continue;
    const examples = Number(match[1]);
    const failed = Number(match[2]);
    const skipped = Number(match[3] ?? 0);
    return {
      summary: { passed: Math.max(0, examples - failed - skipped), failed, skipped },
      line: index,
    };
  }
  return undefined;
}

/** `OK (13 tests, 20 assertions)` or `Tests: 13, Assertions: 20, Failures: 1, Skipped: 2.` */
function detectPhpunit(lines: readonly string[]): TestDetection | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    const ok = PHPUNIT_OK.exec(line);
    if (ok) return { summary: { passed: Number(ok[1]) }, line: index };
    const totals = PHPUNIT_TOTALS.exec(line);
    if (!totals) continue;
    const summary: TestSummary = { failed: 0, skipped: 0 };
    for (const [, field, count] of totals[2].matchAll(PHPUNIT_FIELD)) {
      const bucket = PHPUNIT_FIELDS[field];
      if (bucket) add(summary, bucket, Number(count));
    }
    const notPassed = (summary.failed ?? 0) + (summary.skipped ?? 0);
    summary.passed = Math.max(0, Number(totals[1]) - notPassed);
    return { summary, line: index };
  }
  return undefined;
}

/** ` 12 pass` / ` 1 fail` lines just above `Ran 13 tests across 2 files.`. */
function detectBun(lines: readonly string[]): TestDetection | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!BUN_RAN.test(lines[index])) continue;
    const summary: TestSummary = {};
    let counted = false;
    for (let previous = Math.max(0, index - BUN_LOOKBACK_LINES); previous < index; previous++) {
      const match = BUN_COUNT.exec(lines[previous]);
      if (!match) continue;
      add(summary, BUN_WORDS[match[2]], Number(match[1]));
      counted = true;
    }
    if (counted) return { summary, line: index };
  }
  return undefined;
}
