/**
 * Filename-pattern matching for a single path segment, as bash (without extglob), PowerShell, cmd
 * and ripgrep treat `*`, `?` and bracket expressions (`[abc]`, `[a-z]`, `[!x]`, `[^x]`).
 *
 * Patterns come from model-written commands, so matching must stay cheap whatever the input:
 * regular expressions compiled from globs (picomatch with extglob, or nested `*` groups) can
 * backtrack exponentially (`*(*)*(*)Z`). This matcher runs in O(pattern × name) time and never
 * throws. Parentheses, `+(...)` and other extglob syntax are plain characters here: non-interactive
 * bash, PowerShell, cmd and ripgrep do not support extglob.
 */

/** Characters that make a word a filename pattern in bash, PowerShell and cmd. */
export const GLOB_CHARS = /[*?[]/;

/** Longest pattern segment matched exactly; longer ones are assumed to match anything. */
const MAX_SEGMENT_PATTERN = 512;

export interface SegmentMatchOptions {
  /** Whether wildcards at the start of the pattern match a leading `.` (PowerShell, ripgrep). */
  dot: boolean;
  /** Compare ignoring case. */
  nocase: boolean;
  /** Whether `\x` matches a literal `x` (POSIX globs) rather than a backslash. */
  escapes?: boolean;
}

type Token =
  | { kind: 'star' }
  | { kind: 'any' }
  | { kind: 'char'; char: string }
  | {
      kind: 'class';
      negated: boolean;
      chars: string;
      ranges: Array<[string, string]>;
      all: boolean;
    };

/** A matcher for one segment pattern. Patterns too long to analyze match every name. */
export function segmentMatcher(
  pattern: string,
  options: SegmentMatchOptions,
): (name: string) => boolean {
  if (pattern.length > MAX_SEGMENT_PATTERN) return () => true;
  const tokens = tokenize(options.nocase ? pattern.toLowerCase() : pattern, options.escapes);
  const leadingLiteralDot = tokens[0]?.kind === 'char' && tokens[0].char === '.';
  return (name) => {
    const subject = options.nocase ? name.toLowerCase() : name;
    if (!options.dot && subject.startsWith('.') && !leadingLiteralDot) return false;
    return matchTokens(tokens, subject, options.nocase);
  };
}

function tokenize(pattern: string, escapes = false): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (tokens[tokens.length - 1]?.kind !== 'star') tokens.push({ kind: 'star' });
    } else if (char === '?') {
      tokens.push({ kind: 'any' });
    } else if (char === '[') {
      const parsed = parseClass(pattern, i);
      if (parsed) {
        tokens.push(parsed.token);
        i = parsed.end;
      } else {
        tokens.push({ kind: 'char', char });
      }
    } else if (char === '\\' && escapes && i + 1 < pattern.length) {
      tokens.push({ kind: 'char', char: pattern[++i] });
    } else {
      tokens.push({ kind: 'char', char });
    }
  }
  return tokens;
}

/** Parses `[...]` starting at `start`; undefined when it is not closed (then `[` is literal). */
function parseClass(pattern: string, start: number): { token: Token; end: number } | undefined {
  let i = start + 1;
  const negated = pattern[i] === '!' || pattern[i] === '^';
  if (negated) i++;
  const chars: string[] = [];
  const ranges: Array<[string, string]> = [];
  let all = false;
  let first = true;
  for (; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === ']' && !first) {
      return { token: { kind: 'class', negated, chars: chars.join(''), ranges, all }, end: i };
    }
    first = false;
    if (char === '[' && pattern[i + 1] === ':') {
      // POSIX classes such as [:alpha:]: assume they match anything (conservative).
      const close = pattern.indexOf(':]', i + 2);
      if (close >= 0) {
        all = true;
        i = close + 1;
        continue;
      }
    }
    if (pattern[i + 1] === '-' && pattern[i + 2] !== undefined && pattern[i + 2] !== ']') {
      ranges.push([char, pattern[i + 2]]);
      i += 2;
    } else {
      chars.push(char);
    }
  }
  return undefined;
}

function matchOne(token: Token, char: string, nocase: boolean): boolean {
  switch (token.kind) {
    case 'any':
      return true;
    case 'char':
      return token.char === char;
    case 'class': {
      if (token.all) return !token.negated;
      const variants = nocase ? [char, char.toUpperCase()] : [char];
      const hit = variants.some(
        (variant) =>
          token.chars.includes(variant) ||
          token.ranges.some(([low, high]) => variant >= low && variant <= high),
      );
      return hit !== token.negated;
    }
    default:
      return false;
  }
}

/**
 * Wildcard matching with backtracking to the most recent `*` only: O(tokens × name), which is
 * correct because a `*` inside one segment matches any run of characters.
 */
function matchTokens(tokens: readonly Token[], name: string, nocase: boolean): boolean {
  let t = 0;
  let n = 0;
  let starToken = -1;
  let starName = 0;
  while (n < name.length) {
    const token = tokens[t];
    if (token !== undefined && token.kind === 'star') {
      starToken = t++;
      starName = n;
    } else if (token !== undefined && matchOne(token, name[n], nocase)) {
      t++;
      n++;
    } else if (starToken >= 0) {
      t = starToken + 1;
      n = ++starName;
    } else {
      return false;
    }
  }
  while (tokens[t]?.kind === 'star') t++;
  return t === tokens.length;
}
