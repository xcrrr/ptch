/**
 * Patch's visual language. Named ANSI colors only (never hex or backgrounds) so the interface
 * follows the user's terminal theme; `dim` carries secondary information. Strong color is
 * reserved for things that need attention.
 */
export const theme = {
  /** Brand accent: the prompt marker and selection cursor. Diff-green, used sparingly. */
  accent: 'green',
  /** Additions in diffs and stats. */
  added: 'green',
  /** Removals in diffs and stats. */
  removed: 'red',
  /** Errors and destructive actions. */
  danger: 'red',
  /** Warnings, permission prompts, risky actions. */
  warning: 'yellow',
  /** Inline code and paths in prose. */
  code: 'cyan',
  /** Links. */
  link: 'blue',
  /** Plan mode: the footer's mode label, plan prompts and plans. */
  planMode: 'cyan',
  /** Accepting edits: the footer's mode label. */
  acceptEdits: 'magenta',
  /** Auto mode (nothing but the guardrails asks): the footer's mode label and its confirmation. */
  autoMode: 'red',
} as const;

export const glyphs = {
  /** Prompt marker and user-message prefix. */
  prompt: '›',
  /** Selection cursor in lists. */
  pointer: '›',
  /** Separator between metadata parts. */
  dot: '·',
  /** Horizontal rule character. */
  rule: '─',
  /** Code block gutter. */
  gutter: '│',
  ellipsis: '…',
  check: '✓',
  cross: '✗',
  /** Footer marks of the permission modes. */
  planMode: '⏸',
  acceptEdits: '⏵⏵',
  autoMode: '⏵⏵⏵',
  /** Spinner frames (braille dots), ~80ms per frame. */
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
} as const;

/** Width of the tool verb column ("read    ", "edit    "). */
export const VERB_WIDTH = 8;
/** Left indent for everything Patch prints (user input sits at column 0). */
export const INDENT = 2;
