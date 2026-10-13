import { stripAnsi } from '@patch/shared';
import chalk from 'chalk';
import { afterAll, beforeAll } from 'vitest';

/** Lets Ink process pending input and effects. A lone ESC needs a little longer to flush. */
export function tick(ms = 15): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const keys = {
  enter: '\r',
  tab: '\t',
  up: '\u001b[A',
  down: '\u001b[B',
  left: '\u001b[D',
  right: '\u001b[C',
  escape: '\u001b',
  backspace: '\u007f',
  ctrlC: '\u0003',
  ctrlD: '\u0004',
  ctrlO: '\u000f',
  ctrlJ: '\n',
  altEnter: '\u001b\r',
} as const;

/** Plain text of a frame with trailing spaces removed from every line. */
export function plainFrame(frame: string | undefined): string {
  return stripAnsi(frame ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
}

export function plainLines(frame: string | undefined): string[] {
  return plainFrame(frame).split('\n');
}

/** Forces basic ANSI colors for the tests in the calling file (chalk is shared with Ink). */
export function withColors(): void {
  let previous = chalk.level;
  beforeAll(() => {
    previous = chalk.level;
    chalk.level = 1;
  });
  afterAll(() => {
    chalk.level = previous;
  });
}

/** SGR codes used in assertions. */
export const sgr = {
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  inverse: '\u001b[7m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
} as const;
