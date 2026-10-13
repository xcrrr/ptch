import {
  formatCount,
  formatDuration,
  plural,
  splitLines,
  stripAnsi,
  truncateMiddle,
} from '@patch/shared';
import type { CommandResult } from './process.js';
import { TEST_RUNNER_DETECTORS, type TestDetection } from './test-runners.js';

export { LiveTail, type LiveTailSnapshot } from './live-tail.js';

export interface TestSummary {
  passed?: number;
  failed?: number;
  skipped?: number;
}

/** Per-stream limits for model-facing output. */
const MAX_STREAM_LINES = 400;
const MAX_STREAM_CHARS = 30_000;
const HEAD_RATIO = 0.4;
const DEFAULT_TAIL_LINES = 4;
const MAX_TAIL_LINE_CHARS = 300;

const TRUNCATION_HINT =
  'Output was truncated. Narrow the command (filter or limit its output), or redirect it to a file and inspect the relevant parts with read_file or grep.';

/**
 * Recognizes common test-runner summaries in command output (vitest, jest, mocha, pytest,
 * go test, cargo test, node:test, rspec, phpunit, bun). Returns undefined when none is found.
 * When several summaries appear, the last one wins.
 */
export function parseTestSummary(output: string): TestSummary | undefined {
  const lines = splitLines(stripAnsi(output));
  let best: TestDetection | undefined;
  for (const detect of TEST_RUNNER_DETECTORS) {
    const found = detect(lines);
    if (found && (best === undefined || found.line > best.line)) best = found;
  }
  return best?.summary;
}

/** "42 passed · 1 failed" (omits zero/undefined parts); "no tests" when nothing remains. */
export function formatTestSummary(summary: TestSummary): string {
  const parts: string[] = [];
  if (summary.passed) parts.push(`${formatCount(summary.passed)} passed`);
  if (summary.failed) parts.push(`${formatCount(summary.failed)} failed`);
  if (summary.skipped) parts.push(`${formatCount(summary.skipped)} skipped`);
  return parts.length > 0 ? parts.join(' · ') : 'no tests';
}

export interface FormattedCommandOutput {
  /** Model-facing text with exit code, duration and (truncated) stdout/stderr sections. */
  content: string;
  /** One-line UI summary, e.g. "42 passed · 1 failed · 8.1s" or "exit 1 · 3.2s". */
  summary: string;
  /** Up to `tailLines` last non-empty output lines, for showing under a failed command. */
  tail: string[];
}

export interface FormatCommandOutputOptions {
  /** Default 4. */
  tailLines?: number;
  /** The configured timeout, stated when the command timed out (defaults to its duration). */
  timeoutMs?: number;
}

/**
 * Formats a command result for the model and the UI. Output is truncated with
 * `truncateMiddle` (head 40% / tail 60%, max ~400 lines and ~30k chars per stream) and the
 * omission is stated explicitly. Includes "Command timed out after Xs" / "Interrupted by user"
 * lines when applicable.
 *
 * Content shape: a status line ("Exit code 1 · 3.2s"), a blank line, then the output. Both
 * streams are labelled ("stdout:" / "stderr:") only when both have output; "(no output)" when
 * neither has.
 */
export function formatCommandOutput(
  result: CommandResult,
  options: FormatCommandOutputOptions = {},
): FormattedCommandOutput {
  const stdout = trimBlankEdges(result.stdout);
  const stderr = trimBlankEdges(result.stderr);
  const body = outputBody(stdout, stderr);
  const sections = [statusLines(result, options.timeoutMs).join('\n'), body.text];
  if (body.truncated || result.outputTruncated) sections.push(TRUNCATION_HINT);
  return {
    content: sections.join('\n\n'),
    summary: uiSummary(result, stdout, stderr),
    tail: outputTail(stdout, stderr, options.tailLines ?? DEFAULT_TAIL_LINES),
  };
}

function statusLines(result: CommandResult, timeoutMs: number | undefined): string[] {
  const duration = formatDuration(result.durationMs);
  const lines: string[] = [];
  if (result.timedOut) {
    lines.push(
      `Command timed out after ${formatSeconds(timeoutMs ?? result.durationMs)} and was stopped.`,
    );
  }
  if (result.aborted) lines.push('Command was interrupted by the user.');
  if (result.exitCode !== null) {
    lines.push(`Exit code ${result.exitCode} · ${duration}`);
  } else if (!result.timedOut && !result.aborted) {
    lines.push(
      result.signal
        ? `Terminated by signal ${result.signal} · ${duration}`
        : `Exited without an exit code · ${duration}`,
    );
  }
  return lines;
}

function outputBody(stdout: string, stderr: string): { text: string; truncated: boolean } {
  if (stdout === '' && stderr === '') return { text: '(no output)', truncated: false };
  const out = truncateStream(stdout);
  const err = truncateStream(stderr);
  if (stderr === '') return out;
  if (stdout === '') return err;
  return {
    text: `stdout:\n${out.text}\n\nstderr:\n${err.text}`,
    truncated: out.truncated || err.truncated,
  };
}

function truncateStream(text: string): { text: string; truncated: boolean } {
  const result = truncateMiddle(text, {
    maxLines: MAX_STREAM_LINES,
    maxChars: MAX_STREAM_CHARS,
    headRatio: HEAD_RATIO,
  });
  return { text: result.text, truncated: result.truncated };
}

function uiSummary(result: CommandResult, stdout: string, stderr: string): string {
  const duration = formatDuration(result.durationMs);
  if (result.timedOut) return `timed out · ${duration}`;
  if (result.aborted) return `interrupted · ${duration}`;
  const tests = parseTestSummary(`${stdout}\n${stderr}`);
  if (tests) {
    const parts = [formatTestSummary(tests)];
    // A non-zero exit without failed tests (e.g. a later lint step failed) is worth showing.
    if (result.exitCode !== 0 && !tests.failed) parts.push(exitLabel(result));
    return [...parts, duration].join(' · ');
  }
  if (result.exitCode !== 0) return `${exitLabel(result)} · ${duration}`;
  const lineCount = splitLines(stdout).length + splitLines(stderr).length;
  return lineCount > 0 ? `${plural(lineCount, 'line')} · ${duration}` : `done · ${duration}`;
}

function exitLabel(result: CommandResult): string {
  if (result.exitCode !== null) return `exit ${result.exitCode}`;
  return result.signal ? `killed (${result.signal})` : 'no exit code';
}

/**
 * Lines that name what went wrong: failing tests ("✖ name", "FAIL file > test", "--- FAIL"),
 * errors ("Error: ...", "error TS2322", "error[E0308]"), and "npm ERR!" style reports.
 */
const FAILURE_LINE =
  /(^\s*(✖|✗|×|FAIL\b|--- FAIL|not ok\b|npm ERR!|ERR_)|[A-Za-z]*(Error|Exception)(\s*\[\w+\])?:|\berror(\[\w+\])?[: ]|\bFAILED\b|\bfailed\b)/;
/** Lines that look like failures but carry no information (summaries, stack frames). */
const NOISE_LINE = /^\s*(at\s|ℹ|#\s|Test Files|Tests\s|✖ failing tests:?$)/;

function outputTail(stdout: string, stderr: string, count: number): string[] {
  if (count <= 0) return [];
  const lines = [...splitLines(stdout), ...splitLines(stderr)].filter((line) => line.trim() !== '');
  const seen = new Set<string>();
  const failures: string[] = [];
  for (const line of lines) {
    const key = line.trim();
    if (!FAILURE_LINE.test(line) || NOISE_LINE.test(line) || seen.has(key)) continue;
    seen.add(key);
    failures.push(line);
  }
  // Prefer the lines that explain the failure; fall back to the end of the output.
  const chosen = failures.length > 0 ? failures.slice(0, count) : lines.slice(-count);
  return chosen.map((line) => clipLine(line.trim(), MAX_TAIL_LINE_CHARS));
}

/** Drops leading and trailing blank lines (and trailing whitespace) but keeps indentation. */
function trimBlankEdges(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
}

function clipLine(line: string, maxChars: number): string {
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}…`;
}

/** "500ms", "1.5s", "120s": timeouts read best in plain seconds. */
function formatSeconds(ms: number): string {
  if (ms < 1000) return formatDuration(ms);
  const seconds = ms / 1000;
  return seconds < 10 ? `${Number(seconds.toFixed(1))}s` : `${Math.round(seconds)}s`;
}
