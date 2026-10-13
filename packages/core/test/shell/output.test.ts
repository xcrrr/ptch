import { describe, expect, it } from 'vitest';
import { formatCommandOutput, formatTestSummary } from '../../src/shell/output.js';
import type { CommandResult } from '../../src/shell/process.js';

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 3200,
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    ...overrides,
  };
}

describe('formatCommandOutput', () => {
  it('shows the status line and unlabelled output when only stdout has output', () => {
    const formatted = formatCommandOutput(result({ stdout: 'hello\nworld\n', durationMs: 400 }));
    expect(formatted.content).toBe('Exit code 0 · 400ms\n\nhello\nworld');
    expect(formatted.summary).toBe('2 lines · 400ms');
    expect(formatted.tail).toEqual(['hello', 'world']);
  });

  it('shows unlabelled stderr when only stderr has output', () => {
    const formatted = formatCommandOutput(result({ stderr: 'boom\n', exitCode: 1 }));
    expect(formatted.content).toBe('Exit code 1 · 3.2s\n\nboom');
    expect(formatted.summary).toBe('exit 1 · 3.2s');
  });

  it('labels both streams when both have output', () => {
    const formatted = formatCommandOutput(
      result({ stdout: 'compiled\n', stderr: 'warning: unused\n', exitCode: 1 }),
    );
    expect(formatted.content).toBe(
      'Exit code 1 · 3.2s\n\nstdout:\ncompiled\n\nstderr:\nwarning: unused',
    );
  });

  it('says "(no output)" and "done" for a silent success', () => {
    const formatted = formatCommandOutput(result({ stdout: '\n  \n', durationMs: 120 }));
    expect(formatted.content).toBe('Exit code 0 · 120ms\n\n(no output)');
    expect(formatted.summary).toBe('done · 120ms');
    expect(formatted.tail).toEqual([]);
  });

  it('drops leading blank lines but keeps indentation', () => {
    const formatted = formatCommandOutput(result({ stdout: '\n\n  indented\n    more\n\n' }));
    expect(formatted.content).toBe('Exit code 0 · 3.2s\n\n  indented\n    more');
  });

  it('states a timeout using the configured limit', () => {
    const formatted = formatCommandOutput(
      result({ exitCode: null, timedOut: true, durationMs: 120_300, stdout: 'partial\n' }),
      { timeoutMs: 120_000 },
    );
    expect(formatted.content).toBe('Command timed out after 120s and was stopped.\n\npartial');
    expect(formatted.summary).toBe('timed out · 2m 00s');
  });

  it('falls back to the duration when the timeout is not given', () => {
    const formatted = formatCommandOutput(
      result({ exitCode: null, timedOut: true, durationMs: 1540 }),
    );
    expect(formatted.content).toBe('Command timed out after 1.5s and was stopped.\n\n(no output)');
  });

  it('states an interruption by the user', () => {
    const formatted = formatCommandOutput(
      result({ exitCode: null, aborted: true, stdout: 'step 1\n', signal: 'SIGTERM' }),
    );
    expect(formatted.content).toBe('Command was interrupted by the user.\n\nstep 1');
    expect(formatted.summary).toBe('interrupted · 3.2s');
  });

  it('reports a termination by signal', () => {
    const formatted = formatCommandOutput(result({ exitCode: null, signal: 'SIGKILL' }));
    expect(formatted.content).toBe('Terminated by signal SIGKILL · 3.2s\n\n(no output)');
    expect(formatted.summary).toBe('killed (SIGKILL) · 3.2s');
  });

  it('truncates long output per stream and says so', () => {
    const stdout = Array.from({ length: 1000 }, (_, i) => `out ${i}`).join('\n');
    const formatted = formatCommandOutput(result({ stdout, stderr: 'short error' }));
    expect(formatted.content).toContain('stdout:\nout 0\nout 1\n');
    expect(formatted.content).toContain('... 600 lines omitted ...');
    expect(formatted.content).toContain('out 999\n\nstderr:\nshort error');
    expect(formatted.content).toMatch(/\n\nOutput was truncated\. .+$/);
    const keptLines = formatted.content.split('\n').filter((line) => /^out \d+$/.test(line));
    expect(keptLines).toHaveLength(400);
    expect(keptLines[159]).toBe('out 159');
    expect(keptLines[160]).toBe('out 760');
  });

  it('truncates a huge single line by characters', () => {
    const formatted = formatCommandOutput(result({ stdout: 'x'.repeat(100_000) }));
    expect(formatted.content).toContain('characters omitted');
    expect(formatted.content.length).toBeLessThan(31_000);
  });

  it('does not add the truncation hint for short output', () => {
    expect(formatCommandOutput(result({ stdout: 'ok' })).content).not.toContain('truncated');
  });

  it('adds the truncation hint when capture already dropped output', () => {
    const stdout = 'head\n... 5,000 bytes omitted ...\ntail\n';
    const formatted = formatCommandOutput(result({ stdout, outputTruncated: true }));
    expect(formatted.content).toBe(
      `Exit code 0 · 3.2s\n\nhead\n... 5,000 bytes omitted ...\ntail\n\nOutput was truncated. Narrow the command (filter or limit its output), or redirect it to a file and inspect the relevant parts with read_file or grep.`,
    );
  });

  it('summarizes detected test results instead of the exit code', () => {
    const stdout = ' Test Files  1 failed | 3 passed (4)\n      Tests  1 failed | 41 passed (42)\n';
    expect(formatCommandOutput(result({ stdout, exitCode: 1, durationMs: 8100 })).summary).toBe(
      '41 passed · 1 failed · 8.1s',
    );
  });

  it('adds the exit code when tests passed but the command still failed', () => {
    const stdout = 'Tests:       12 passed, 12 total\n';
    expect(formatCommandOutput(result({ stdout, exitCode: 2 })).summary).toBe(
      '12 passed · exit 2 · 3.2s',
    );
  });

  it('returns the last non-empty lines of stdout then stderr as the tail', () => {
    const formatted = formatCommandOutput(
      result({ stdout: 'a\nb\n\nc\n', stderr: 'd\n\ne\n', exitCode: 1 }),
      { tailLines: 3 },
    );
    expect(formatted.tail).toEqual(['c', 'd', 'e']);
  });

  it('defaults to four tail lines and clips long ones', () => {
    const long = 'y'.repeat(1000);
    const formatted = formatCommandOutput(result({ stdout: `1\n2\n3\n4\n${long}\n`, exitCode: 1 }));
    expect(formatted.tail).toHaveLength(4);
    expect(formatted.tail[0]).toBe('2');
    expect(formatted.tail[3]).toHaveLength(300);
    expect(formatted.tail[3]!.endsWith('…')).toBe(true);
  });

  it('counts a single line in the summary', () => {
    expect(formatCommandOutput(result({ stdout: 'one\n', durationMs: 50 })).summary).toBe(
      '1 line · 50ms',
    );
  });
});

describe('formatTestSummary', () => {
  it('joins the non-zero parts', () => {
    expect(formatTestSummary({ passed: 42, failed: 1 })).toBe('42 passed · 1 failed');
    expect(formatTestSummary({ passed: 1200, failed: 0, skipped: 3 })).toBe(
      '1,200 passed · 3 skipped',
    );
    expect(formatTestSummary({ failed: 2 })).toBe('2 failed');
  });

  it('says "no tests" when every part is zero or missing', () => {
    expect(formatTestSummary({})).toBe('no tests');
    expect(formatTestSummary({ passed: 0, failed: 0, skipped: 0 })).toBe('no tests');
  });
});
