/** Small, dependency-free text and formatting helpers. */

const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** Normalizes CRLF / CR line endings to LF. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = normalizeNewlines(text).split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function truncateLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  const omitted = line.length - maxChars;
  return `${line.slice(0, maxChars)}… [${formatCount(omitted)} chars truncated]`;
}

export interface TruncateOptions {
  /** Maximum number of lines to keep. */
  maxLines: number;
  /** Maximum total characters to keep (applied after line truncation). */
  maxChars?: number;
  /** Fraction of kept lines taken from the head (rest from the tail). Default 0.4. */
  headRatio?: number;
  /** Maximum characters per individual line. */
  maxLineChars?: number;
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
  totalLines: number;
  omittedLines: number;
}

/**
 * Keeps the head and tail of long text, replacing the middle with an explicit marker such as
 * `... 2,841 lines omitted ...`. Never drops data silently.
 */
export function truncateMiddle(text: string, options: TruncateOptions): TruncateResult {
  const { maxLines, maxChars, maxLineChars } = options;
  const headRatio = options.headRatio ?? 0.4;
  let lines = splitLines(text);
  const totalLines = lines.length;
  let lineTruncated = false;
  if (maxLineChars !== undefined) {
    lines = lines.map((l) => {
      if (l.length <= maxLineChars) return l;
      lineTruncated = true;
      return truncateLine(l, maxLineChars);
    });
  }

  let omittedLines = 0;
  let out: string[];
  if (lines.length > maxLines) {
    const headCount = Math.max(1, Math.floor(maxLines * headRatio));
    const tailCount = Math.max(1, maxLines - headCount);
    omittedLines = lines.length - headCount - tailCount;
    out = [
      ...lines.slice(0, headCount),
      `... ${formatCount(omittedLines)} ${omittedLines === 1 ? 'line' : 'lines'} omitted ...`,
      ...lines.slice(lines.length - tailCount),
    ];
  } else {
    out = lines;
  }

  let result = out.join('\n');
  let truncated = omittedLines > 0 || lineTruncated;
  if (maxChars !== undefined && result.length > maxChars) {
    const headChars = Math.floor(maxChars * headRatio);
    const tailChars = maxChars - headChars;
    const omittedChars = result.length - headChars - tailChars;
    result = `${result.slice(0, headChars)}\n... ${formatCount(omittedChars)} characters omitted ...\n${result.slice(result.length - tailChars)}`;
    truncated = true;
  }
  return { text: result, truncated, totalLines, omittedLines };
}

/** 1234 -> "1,234" */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** 850 -> "850ms", 3200 -> "3.2s", 64000 -> "1m 04s" */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const rest = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Compact elapsed timer for status lines: 7 -> "7s", 75 -> "1m 15s". */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** 950 -> "950", 1234 -> "1.2k", 45000 -> "45k", 1300000 -> "1.3M" */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatUsd(amount: number): string {
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(n)} ${n === 1 ? singular : pluralForm}`;
}

/** "just now", "5m ago", "2h ago", "yesterday", "3d ago", or a date. */
export function relativeTime(date: Date | string, now: Date = new Date()): string {
  const then = typeof date === 'string' ? new Date(date) : date;
  const diff = now.getTime() - then.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 2 * day) return 'yesterday';
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return then.toISOString().slice(0, 10);
}

/** Short display form of a session id. */
export function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 6);
}

/** First line of text, collapsed whitespace, truncated with an ellipsis. */
export function oneLine(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1))}…`;
}
