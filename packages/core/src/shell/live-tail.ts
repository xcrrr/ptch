import { collapseCarriageReturns, LineSplitter } from './terminal-text.js';

/** Longest line kept in a live tail; the start of a line is the informative part. */
const MAX_LINE_CHARS = 1_000;

export interface LiveTailSnapshot {
  /** Most recent non-blank lines, oldest first, including unfinished lines. */
  tail: string[];
  /** Lines seen so far, counting unfinished lines. */
  totalLines: number;
}

/**
 * Follows streaming command output (as delivered by `runCommand`'s `onOutput`) and keeps the last
 * few lines for a live view. Carriage-return progress updates replace the current line instead
 * of adding new ones, and stdout/stderr are split separately so interleaved chunks never merge
 * into one line.
 */
export class LiveTail {
  private readonly recent: string[] = [];
  private completedLines = 0;
  private readonly splitters = { stdout: new LineSplitter(), stderr: new LineSplitter() };

  constructor(private readonly maxLines = 5) {}

  push(chunk: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    this.splitters[stream].push(chunk, (line) => this.addLine(line));
  }

  snapshot(): LiveTailSnapshot {
    const unfinished = [this.splitters.stdout.pending, this.splitters.stderr.pending]
      .map(displayLine)
      .filter(isVisible);
    return {
      tail: [...this.recent, ...unfinished].slice(-this.maxLines),
      totalLines: this.completedLines + unfinished.length,
    };
  }

  private addLine(raw: string): void {
    this.completedLines++;
    const line = displayLine(raw);
    if (!isVisible(line)) return;
    this.recent.push(line);
    if (this.recent.length > this.maxLines) this.recent.shift();
  }
}

function displayLine(raw: string): string {
  return collapseCarriageReturns(raw).trimEnd().slice(0, MAX_LINE_CHARS);
}

function isVisible(line: string): boolean {
  return line.trim() !== '';
}
