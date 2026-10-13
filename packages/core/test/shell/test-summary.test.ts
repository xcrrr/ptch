import { describe, expect, it } from 'vitest';
import { parseTestSummary } from '../../src/shell/output.js';

const lines = (...rows: string[]) => rows.join('\n');

describe('parseTestSummary', () => {
  describe('vitest', () => {
    const output = lines(
      ' ✓ src/a.test.ts (12 tests) 34ms',
      ' ❯ src/b.test.ts (3 tests | 1 failed) 12ms',
      '',
      ' Test Files  1 failed | 3 passed (4)',
      '      Tests  1 failed | 12 passed | 2 skipped | 1 todo (16)',
      '   Start at  12:00:00',
      '   Duration  1.24s (transform 80ms, setup 0ms, collect 120ms, tests 300ms)',
    );

    it('reads the Tests line rather than Test Files', () => {
      expect(parseTestSummary(output)).toEqual({ passed: 12, failed: 1, skipped: 3 });
    });

    it('falls back to the Test Files line', () => {
      expect(parseTestSummary(' Test Files  4 passed (4)\n   Duration  1s')).toEqual({ passed: 4 });
    });

    it('ignores ANSI colors', () => {
      const colored =
        '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m2 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m40 passed\x1b[39m\x1b[22m\x1b[90m (42)\x1b[39m';
      expect(parseTestSummary(colored)).toEqual({ passed: 40, failed: 2 });
    });
  });

  it('parses jest summaries', () => {
    const output = lines(
      'FAIL src/sum.test.js',
      '  ● sum › adds',
      'Test Suites: 1 failed, 3 passed, 4 total',
      'Tests:       1 failed, 2 skipped, 1 todo, 12 passed, 16 total',
      'Snapshots:   0 total',
      'Time:        1.234 s',
      'Ran all test suites.',
    );
    expect(parseTestSummary(output)).toEqual({ failed: 1, skipped: 3, passed: 12 });
    expect(parseTestSummary('Test Suites: 2 passed, 2 total\nTime: 1 s')).toEqual({ passed: 2 });
  });

  it('parses mocha summaries', () => {
    const output = lines(
      '  Array',
      '    ✓ indexOf',
      '',
      '  12 passing (34ms)',
      '  2 pending',
      '  1 failing',
      '',
      '  1) Array',
      '       fails:',
      '     AssertionError: expected 1 to equal 2',
    );
    expect(parseTestSummary(output)).toEqual({ passed: 12, skipped: 2, failed: 1 });
    expect(parseTestSummary('\n  3 passing (5ms)\n')).toEqual({ passed: 3 });
  });

  it('parses pytest summaries, decorated and quiet', () => {
    expect(
      parseTestSummary(
        lines(
          'tests/test_a.py ..F.s                                              [100%]',
          '=================================== FAILURES ===================================',
          '=========================== short test summary info ============================',
          'FAILED tests/test_a.py::test_x - assert 1 == 2',
          '============== 1 failed, 12 passed, 2 skipped, 3 warnings in 0.52s ==============',
        ),
      ),
    ).toEqual({ failed: 1, passed: 12, skipped: 2 });
    expect(parseTestSummary('2 failed, 1 error, 3 xfailed, 1 xpassed in 1.02s')).toEqual({
      failed: 3,
      skipped: 3,
      passed: 1,
    });
    expect(parseTestSummary('========== 5 passed in 12.34s (0:00:12) ==========')).toEqual({
      passed: 5,
    });
    expect(parseTestSummary('==== 4 passed in 0.10 seconds ====')).toEqual({ passed: 4 });
  });

  it('sums cargo test results across test binaries', () => {
    const output = lines(
      'running 13 tests',
      'test tests::adds ... ok',
      'test tests::breaks ... FAILED',
      '',
      'test result: FAILED. 12 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s',
      '',
      '     Running tests/integration.rs (target/debug/deps/integration-1a2b)',
      'test result: ok. 3 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.00s',
      '',
      '   Doc-tests mycrate',
      'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
    );
    expect(parseTestSummary(output)).toEqual({ passed: 15, failed: 1, skipped: 2 });
  });

  it('counts go test -v results, including subtests', () => {
    const output = lines(
      '=== RUN   TestAdd',
      '--- PASS: TestAdd (0.00s)',
      '=== RUN   TestTable',
      '    --- PASS: TestTable/one (0.00s)',
      '    --- FAIL: TestTable/two (0.00s)',
      '--- FAIL: TestTable (0.00s)',
      '--- SKIP: TestSlow (0.00s)',
      'FAIL',
      'FAIL\texample.com/calc\t0.012s',
      'ok  \texample.com/util\t(cached)',
    );
    expect(parseTestSummary(output)).toEqual({ passed: 2, failed: 2, skipped: 1 });
  });

  it('counts go test packages without -v', () => {
    const output = lines(
      'ok  \texample.com/a\t0.012s',
      'ok  \texample.com/b\t(cached)\tcoverage: 81.0% of statements',
      '?   \texample.com/c\t[no test files]',
      'FAIL\texample.com/d [build failed]',
      'FAIL\texample.com/e\t0.230s',
    );
    expect(parseTestSummary(output)).toEqual({ passed: 2, failed: 2 });
  });

  it('parses node:test TAP and spec reporter statistics', () => {
    const tap = lines(
      'ok 1 - adds',
      'not ok 2 - subtracts',
      '1..13',
      '# tests 13',
      '# suites 2',
      '# pass 11',
      '# fail 1',
      '# cancelled 0',
      '# skipped 1',
      '# todo 0',
      '# duration_ms 123.45',
    );
    expect(parseTestSummary(tap)).toEqual({ passed: 11, failed: 1, skipped: 1 });
    const spec = lines(
      '✔ adds (1.2ms)',
      'ℹ tests 4',
      'ℹ suites 0',
      'ℹ pass 3',
      'ℹ fail 0',
      'ℹ cancelled 1',
      'ℹ skipped 0',
      'ℹ todo 0',
      'ℹ duration_ms 52.1',
    );
    expect(parseTestSummary(spec)).toEqual({ passed: 3, failed: 1, skipped: 0 });
  });

  it('parses rspec summaries', () => {
    expect(
      parseTestSummary(
        'Finished in 0.5 seconds (files took 0.2 seconds to load)\n13 examples, 1 failure',
      ),
    ).toEqual({
      passed: 12,
      failed: 1,
      skipped: 0,
    });
    expect(parseTestSummary('20 examples, 0 failures, 3 pending')).toEqual({
      passed: 17,
      failed: 0,
      skipped: 3,
    });
  });

  it('parses phpunit summaries', () => {
    expect(
      parseTestSummary(
        lines(
          'There was 1 failure:',
          '',
          'FAILURES!',
          'Tests: 13, Assertions: 20, Errors: 1, Failures: 1, Skipped: 2, Incomplete: 1.',
        ),
      ),
    ).toEqual({ passed: 8, failed: 2, skipped: 3 });
    expect(
      parseTestSummary('Time: 00:00.012, Memory: 6.00 MB\n\nOK (13 tests, 20 assertions)'),
    ).toEqual({
      passed: 13,
    });
    expect(parseTestSummary('Tests: 13, Assertions: 20, Failures: 1.')).toEqual({
      passed: 12,
      failed: 1,
      skipped: 0,
    });
  });

  it('parses bun summaries', () => {
    const output = lines(
      '(pass) math > adds [0.12ms]',
      '(fail) math > divides [0.30ms]',
      '',
      ' 12 pass',
      ' 1 skip',
      ' 1 fail',
      ' 20 expect() calls',
      'Ran 14 tests across 2 files. [52.00ms]',
    );
    expect(parseTestSummary(output)).toEqual({ passed: 12, skipped: 1, failed: 1 });
  });

  it('lets the summary that appears last win', () => {
    const output = lines(
      '> pnpm -r test',
      '      Tests  10 passed (10)',
      '   Duration  1s',
      'Tests:       2 failed, 5 passed, 7 total',
    );
    expect(parseTestSummary(output)).toEqual({ failed: 2, passed: 5 });
    const reversed = lines('  4 passing (3ms)', '', '      Tests  1 failed | 9 passed (10)');
    expect(parseTestSummary(reversed)).toEqual({ failed: 1, passed: 9 });
  });

  it('handles CRLF output', () => {
    expect(parseTestSummary('ok\r\n      Tests  3 passed (3)\r\n')).toEqual({ passed: 3 });
  });

  it('returns undefined for output without a test summary', () => {
    for (const output of [
      '',
      'added 120 packages in 3s',
      'Compiled 12 files in 1.2s',
      '12 packages in 3s',
      'ok 1 - TAP line without statistics',
      'Tests: none',
      'Build succeeded.\n0 Warning(s)\n0 Error(s)',
    ]) {
      expect(parseTestSummary(output)).toBeUndefined();
    }
  });
});
