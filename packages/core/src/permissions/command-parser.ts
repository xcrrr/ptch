import { normalizeNewlines } from '@patch/shared';

export type ShellOperator = '&&' | '||' | ';' | '|' | '|&' | '&' | '\n';

export interface Redirect {
  /** '>', '>>', '<', '&>', '2>', '2>>', '>&' ... */
  op: string;
  target: string;
  /** The target as written (quotes and escapes kept). */
  rawTarget?: string;
}

export interface SimpleCommand {
  /** Leading VAR=value assignments. */
  assignments: string[];
  /** Words after quote removal (program first). */
  words: string[];
  /** The same words as written (quotes and escapes kept), parallel to `words`. */
  rawWords: string[];
  redirects: Redirect[];
  /** Original text of this simple command. */
  text: string;
}

/** A shell function definition (`name() { ... }`, `function name { ... }`). */
export interface FunctionDefinition {
  name: string;
  /** Indexes into `commands` of the body's commands: [first, end). */
  body: [number, number];
}

/** A `for NAME in WORDS` (or `select`) loop. */
export interface LoopVariable {
  name: string;
  /** The loop's words as written (quotes kept); empty for `for NAME; do` (the arguments). */
  rawItems: string[];
}

export interface ParsedCommand {
  /** Simple commands in order of appearance, flattened across operators and subshells. */
  commands: SimpleCommand[];
  /** Operators between commands, in order. */
  operators: ShellOperator[];
  /**
   * Pairs of indexes into `commands` connected by a pipe: [from, to]. `from` is always smaller
   * than `to` (commands are recorded in the order they are parsed).
   */
  pipes: Array<[number, number]>;
  hasCommandSubstitution: boolean;
  hasProcessSubstitution: boolean;
  /** True when the input defines a shell function (`name() { ... }` or `function name ...`). */
  hasFunctionDefinition: boolean;
  /** Function definitions, with the commands of their bodies. */
  functions: FunctionDefinition[];
  /** Variables set by `for`/`select` loops. */
  loopVariables: LoopVariable[];
  /** True for unbalanced quotes/parens or other input the lexer could not handle. */
  error?: string;
}

/**
 * A small POSIX-ish shell lexer/parser sufficient for risk analysis (not execution).
 * Handles single/double quotes, backslash escapes, `$(...)`, backticks, `( ... )` subshells,
 * `{ ...; }` groups, operators, redirections (including fd forms like `2>&1`), comments, and
 * line continuations. Never throws; sets `error` instead.
 *
 * Commands inside substitutions (`$(...)`, backticks, `<(...)`, unquoted heredoc bodies) are
 * included in `commands`, ahead of the command that contains them (their execution order).
 * Heredoc bodies are data and are skipped. `case` statements are reported as an error.
 *
 * Work is linear in the input: nesting, the number of commands and the number of pipe
 * connections are capped (input beyond the caps is reported as an error, with the commands
 * parsed so far).
 */
export function parseCommand(input: string): ParsedCommand {
  const parser = new ShellParser(normalizeNewlines(input), 0);
  parser.parseProgram();
  return parser.result();
}

const MAX_NESTING = 32;
/** Simple commands one parse may record. */
const MAX_COMMANDS = 300;
/** Pipe connections one parse may record (`(a; b) | (c; d)` connects every pair). */
const MAX_PIPES = 4096;
/** Words and redirections one parse may record. */
const MAX_ITEMS = 4000;

type Token =
  | { kind: 'word'; value: string; raw: string; start: number; end: number }
  | { kind: 'op'; op: ShellOperator; start: number; end: number }
  | { kind: 'redirect'; op: string; start: number; end: number }
  | { kind: '(' | ')' | 'eof'; start: number; end: number };

type WordToken = Extract<Token, { kind: 'word' }>;
type RedirectToken = Extract<Token, { kind: 'redirect' }>;

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
  /** Unquoted delimiters mean the body undergoes expansions (and may run substitutions). */
  expand: boolean;
}

class ParseError extends Error {}

const WORD_BREAKS = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
/** Runs of characters with no special meaning (sticky, so lexing stays linear). */
const PLAIN_WORD_RUN = /[^ \t\n;&|()<>'"$`\\]+/y;
const PLAIN_QUOTED_RUN = /[^"$`\\]+/y;
const PLAIN_HEREDOC_RUN = /[^$`\\]+/y;
const LIST_OPERATORS = new Set<ShellOperator>(['&&', '||', ';', '&', '\n']);
const REDIRECT_OPERATORS = ['<<<', '<<-', '<<', '<&', '<>', '>>', '>&', '>|', '<', '>'];
/** Reserved words that may precede a command; they do not change what runs. */
const PREFIX_KEYWORDS = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
const CLOSING_KEYWORDS = new Set(['fi', 'done', 'esac']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const ANSI_C_ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};

class ShellParser {
  private pos = 0;
  private lookahead: Token | undefined;
  private pendingHeredocs: PendingHeredoc[] = [];
  private readonly commands: SimpleCommand[] = [];
  private readonly operators: ShellOperator[] = [];
  private readonly pipes: Array<[number, number]> = [];
  private readonly functions: FunctionDefinition[] = [];
  private readonly loopVariables: LoopVariable[] = [];
  private hasCommandSubstitution = false;
  private hasProcessSubstitution = false;
  private hasFunctionDefinition = false;
  /** Words and redirections recorded, here and in nested parsers. */
  private items = 0;
  private error: string | undefined;

  constructor(
    private readonly input: string,
    private nesting: number,
  ) {}

  parseProgram(): void {
    this.guard(() => {
      this.parseList(() => false);
      const token = this.peek();
      if (token.kind !== 'eof') throw new ParseError(`Unexpected ${describeToken(token)}`);
    });
  }

  /** Scans text with double-quote semantics (a heredoc body) for substitutions only. */
  scanExpansions(): void {
    this.guard(() => {
      this.readExpandable(null);
    });
  }

  result(): ParsedCommand {
    return {
      commands: this.commands,
      operators: this.operators,
      pipes: this.pipes,
      hasCommandSubstitution: this.hasCommandSubstitution,
      hasProcessSubstitution: this.hasProcessSubstitution,
      hasFunctionDefinition: this.hasFunctionDefinition,
      functions: this.functions,
      loopVariables: this.loopVariables,
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  private guard(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.error = error instanceof ParseError ? error.message : 'Could not parse the command';
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Grammar

  private parseList(isEnd: () => boolean): void {
    for (;;) {
      this.skipNewlines();
      if (isEnd() || this.peek().kind === 'eof') return;
      const token = this.peek();
      if (token.kind === 'op' || token.kind === ')') {
        throw new ParseError(`Unexpected ${describeToken(token)}`);
      }
      this.parsePipeline(isEnd);
      const next = this.peek();
      if (next.kind === 'op' && LIST_OPERATORS.has(next.op)) {
        this.next();
        this.operators.push(next.op);
        if (next.op === '&&' || next.op === '||') {
          this.skipNewlines();
          if (isEnd() || this.peek().kind === 'eof') {
            throw new ParseError(`Expected a command after "${next.op}"`);
          }
        }
        continue;
      }
      if (isEnd() || next.kind === 'eof') return;
      throw new ParseError(`Unexpected ${describeToken(next)}`);
    }
  }

  private parsePipeline(isEnd: () => boolean): number[] {
    let previous = this.parseElement(isEnd);
    const all = [...previous];
    for (;;) {
      const token = this.peek();
      if (token.kind !== 'op' || (token.op !== '|' && token.op !== '|&')) return all;
      this.next();
      this.operators.push(token.op);
      this.skipNewlines();
      const following = this.peek();
      if (following.kind === 'eof' || following.kind === 'op' || isEnd()) {
        throw new ParseError(`Expected a command after "${token.op}"`);
      }
      const current = this.parseElement(isEnd);
      if (this.pipes.length + previous.length * current.length > MAX_PIPES) {
        throw new ParseError('The command has too many pipes to analyze');
      }
      for (const from of previous) for (const to of current) this.pipes.push([from, to]);
      all.push(...current);
      previous = current;
    }
  }

  /** One pipeline element: a subshell, a `{ }` group, a compound keyword, or a simple command. */
  private parseElement(isEnd: () => boolean): number[] {
    const first = this.commands.length;
    // Reserved words that only prefix a command (`!`, `then`, `do` ...) are skipped in a loop, so
    // long runs of them cannot exhaust the stack.
    for (let token = this.peek(); isPrefixKeyword(token); token = this.peek()) {
      this.next();
      const following = this.peek();
      if (following.kind === 'op' || following.kind === 'eof' || isEnd()) return [];
    }
    const token = this.peek();
    if (token.kind === '(') {
      this.next();
      this.enterNesting();
      this.parseList(() => this.peek().kind === ')');
      if (this.next().kind !== ')') throw new ParseError('Unbalanced parentheses: missing ")"');
      this.nesting--;
      this.attachRedirects(first, this.parseRedirects());
      return this.range(first);
    }
    if (token.kind === 'word' && token.raw === token.value) {
      const word = token.value;
      if (word === '{') {
        this.next();
        this.enterNesting();
        const isBraceEnd = (): boolean => isClosingBrace(this.peek());
        this.parseList(isBraceEnd);
        if (!isClosingBrace(this.next()))
          throw new ParseError('Unterminated "{" group: missing "}"');
        this.nesting--;
        this.attachRedirects(first, this.parseRedirects());
        return this.range(first);
      }
      if (CLOSING_KEYWORDS.has(word)) {
        this.next();
        this.attachRedirects(first, this.parseRedirects());
        return this.range(first);
      }
      if (word === 'for' || word === 'select') {
        this.next();
        this.parseLoopHeader();
        return this.range(first);
      }
      if (word === 'case') throw new ParseError('case statements are not supported');
      if (word === 'function') {
        this.next();
        const name = this.next();
        if (name.kind !== 'word') throw new ParseError('Expected a function name');
        if (this.peek().kind === '(') this.expectEmptyParens();
        this.parseFunctionBody(isEnd, name.value);
        return this.range(first);
      }
    }
    this.parseSimpleCommand(isEnd);
    return this.range(first);
  }

  /** `for NAME in WORDS` / `for NAME` (the words up to the next operator). */
  private parseLoopHeader(): void {
    const words: WordToken[] = [];
    for (let token = this.peek(); token.kind === 'word'; token = this.peek()) {
      words.push(token);
      this.next();
    }
    const [name, keyword, ...items] = words;
    if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name.raw)) return;
    const rawItems = keyword?.raw === 'in' ? items.map((item) => item.raw) : [];
    this.loopVariables.push({ name: name.raw, rawItems });
  }

  private parseSimpleCommand(isEnd: () => boolean): void {
    const assignments: string[] = [];
    const words: string[] = [];
    const rawWords: string[] = [];
    const redirects: Redirect[] = [];
    let start = -1;
    let end = -1;
    for (;;) {
      const token = this.peek();
      if (token.kind === 'word') {
        this.next();
        this.countItem();
        if (start < 0) start = token.start;
        end = token.end;
        if (words.length === 0 && ASSIGNMENT.test(token.raw)) {
          assignments.push(token.value);
        } else {
          words.push(token.value);
          rawWords.push(token.raw);
        }
        continue;
      }
      if (token.kind === 'redirect') {
        this.next();
        this.countItem();
        const target = this.readRedirectTarget(token);
        if (start < 0) start = token.start;
        end = target.end;
        redirects.push({ op: token.op, target: target.value, rawTarget: target.raw });
        continue;
      }
      if (token.kind === '(') {
        if (words.length === 1 && assignments.length === 0 && redirects.length === 0) {
          this.expectEmptyParens();
          this.parseFunctionBody(isEnd, words[0]);
          return;
        }
        throw new ParseError('Unexpected "("');
      }
      break;
    }
    if (start < 0) return;
    const text = this.input.slice(start, end).trim();
    this.addCommand({ assignments, words, rawWords, redirects, text });
  }

  private countItem(count = 1): void {
    this.items += count;
    if (this.items > MAX_ITEMS) throw new ParseError('The command has too many words to analyze');
  }

  private addCommand(command: SimpleCommand): void {
    if (this.commands.length >= MAX_COMMANDS) {
      throw new ParseError('The command has too many parts to analyze');
    }
    this.commands.push(command);
  }

  private expectEmptyParens(): void {
    this.next();
    if (this.next().kind !== ')') throw new ParseError('Unexpected "("');
  }

  private parseFunctionBody(isEnd: () => boolean, name: string): void {
    this.hasFunctionDefinition = true;
    this.skipNewlines();
    if (this.peek().kind === 'eof') throw new ParseError('Expected a function body');
    const first = this.commands.length;
    this.enterNesting();
    this.parseElement(isEnd);
    this.nesting--;
    this.functions.push({ name, body: [first, this.commands.length] });
  }

  private parseRedirects(): Redirect[] {
    const redirects: Redirect[] = [];
    for (let token = this.peek(); token.kind === 'redirect'; token = this.peek()) {
      this.next();
      this.countItem();
      const target = this.readRedirectTarget(token);
      redirects.push({ op: token.op, target: target.value, rawTarget: target.raw });
    }
    return redirects;
  }

  private readRedirectTarget(redirect: RedirectToken): WordToken {
    const target = this.next();
    if (target.kind !== 'word') throw new ParseError(`Missing target after "${redirect.op}"`);
    const op = redirect.op.replace(/^\d+/, '');
    if (op === '<<' || op === '<<-') {
      this.pendingHeredocs.push({
        delimiter: target.value,
        stripTabs: op === '<<-',
        expand: target.raw === target.value,
      });
    }
    return target;
  }

  /** Applies a group's trailing redirections to every command in it. */
  private attachRedirects(first: number, redirects: Redirect[]): void {
    if (redirects.length === 0) return;
    if (this.commands.length === first) {
      const text = redirects.map((r) => `${r.op}${r.target}`).join(' ');
      this.addCommand({ assignments: [], words: [], rawWords: [], redirects, text });
      return;
    }
    if ((this.commands.length - first) * redirects.length > MAX_PIPES) {
      throw new ParseError('The command has too many redirections to analyze');
    }
    for (let i = first; i < this.commands.length; i++)
      this.commands[i].redirects.push(...redirects);
  }

  private range(first: number): number[] {
    const indexes: number[] = [];
    for (let i = first; i < this.commands.length; i++) indexes.push(i);
    return indexes;
  }

  private skipNewlines(): void {
    for (let token = this.peek(); token.kind === 'op' && token.op === '\n'; token = this.peek()) {
      this.next();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Lexer

  private peek(): Token {
    this.lookahead ??= this.lex();
    return this.lookahead;
  }

  private next(): Token {
    const token = this.peek();
    this.lookahead = undefined;
    return token;
  }

  private lex(): Token {
    this.skipBlanks();
    const { input } = this;
    const start = this.pos;
    if (start >= input.length) return { kind: 'eof', start, end: start };
    const c = input[start];
    const c1 = input[start + 1];
    if (c === '#') {
      const newline = input.indexOf('\n', start);
      this.pos = newline < 0 ? input.length : newline;
      return this.lex();
    }
    if (c === '\n') {
      this.pos++;
      this.readPendingHeredocs();
      return this.op('\n', start);
    }
    if (c === ';') return this.op(';', start);
    if (c === '&') {
      if (c1 === '&') return this.op('&&', start);
      if (c1 === '>') {
        const op = input[start + 2] === '>' ? '&>>' : '&>';
        this.pos += op.length;
        return { kind: 'redirect', op, start, end: this.pos };
      }
      return this.op('&', start);
    }
    if (c === '|') {
      if (c1 === '|') return this.op('||', start);
      if (c1 === '&') return this.op('|&', start);
      return this.op('|', start);
    }
    if (c === '(' || c === ')') {
      this.pos++;
      return { kind: c, start, end: this.pos };
    }
    if ((c === '<' || c === '>') && c1 === '(') return this.lexWord();
    if (c === '<' || c === '>') return this.lexRedirect(start, '');
    const fd = /^\d+(?=[<>])/.exec(input.slice(start, start + 12));
    if (fd) {
      this.pos += fd[0].length;
      return this.lexRedirect(start, fd[0]);
    }
    return this.lexWord();
  }

  private op(op: ShellOperator, start: number): Token {
    if (op !== '\n') this.pos = start + op.length;
    return { kind: 'op', op, start, end: this.pos };
  }

  private lexRedirect(start: number, fd: string): Token {
    const rest = this.input.slice(this.pos, this.pos + 3);
    const op = REDIRECT_OPERATORS.find((candidate) => rest.startsWith(candidate)) ?? rest[0];
    this.pos += op.length;
    return { kind: 'redirect', op: fd + op, start, end: this.pos };
  }

  private skipBlanks(): void {
    const { input } = this;
    while (this.pos < input.length) {
      const c = input[this.pos];
      if (c === ' ' || c === '\t') this.pos++;
      else if (c === '\\' && input[this.pos + 1] === '\n') this.pos += 2;
      else break;
    }
  }

  private lexWord(): WordToken {
    const { input } = this;
    const start = this.pos;
    let value = '';
    if ((input[start] === '<' || input[start] === '>') && input[start + 1] === '(') {
      value += this.readSubstitution(2, 'process');
    }
    while (this.pos < input.length) {
      PLAIN_WORD_RUN.lastIndex = this.pos;
      const run = PLAIN_WORD_RUN.exec(input);
      if (run) {
        value += run[0];
        this.pos += run[0].length;
        continue;
      }
      const c = input[this.pos];
      if (WORD_BREAKS.has(c)) break;
      if (c === "'") value += this.readSingleQuoted();
      else if (c === '"') value += this.readDoubleQuoted();
      else if (c === '$') value += this.readDollar(false);
      else if (c === '`') value += this.readBackticks();
      else if (c === '\\') value += this.readEscape();
      else {
        value += c;
        this.pos++;
      }
    }
    return { kind: 'word', value, raw: input.slice(start, this.pos), start, end: this.pos };
  }

  private readEscape(): string {
    const next = this.input[this.pos + 1];
    if (next === undefined) {
      this.pos++;
      return '\\';
    }
    this.pos += 2;
    return next === '\n' ? '' : next;
  }

  private readSingleQuoted(): string {
    const close = this.input.indexOf("'", this.pos + 1);
    if (close < 0) throw new ParseError('Unterminated single quote');
    const content = this.input.slice(this.pos + 1, close);
    this.pos = close + 1;
    return content;
  }

  private readDoubleQuoted(): string {
    this.pos++;
    return this.readExpandable('"');
  }

  /** Reads double-quoted content up to `terminator` (or the end of input when null). */
  private readExpandable(terminator: '"' | null): string {
    const { input } = this;
    const plain = terminator === null ? PLAIN_HEREDOC_RUN : PLAIN_QUOTED_RUN;
    let value = '';
    while (this.pos < input.length) {
      plain.lastIndex = this.pos;
      const run = plain.exec(input);
      if (run) {
        value += run[0];
        this.pos += run[0].length;
        continue;
      }
      const c = input[this.pos];
      if (c === terminator) {
        this.pos++;
        return value;
      }
      if (c === '\\') {
        const next = input[this.pos + 1];
        if (next === '\n') {
          this.pos += 2;
        } else if (next !== undefined && '$`"\\'.includes(next)) {
          value += next;
          this.pos += 2;
        } else {
          value += c;
          this.pos++;
        }
      } else if (c === '$') {
        value += this.readDollar(true);
      } else if (c === '`') {
        value += this.readBackticks();
      } else {
        value += c;
        this.pos++;
      }
    }
    if (terminator !== null) throw new ParseError('Unterminated double quote');
    return value;
  }

  private readDollar(inDoubleQuotes: boolean): string {
    const next = this.input[this.pos + 1];
    if (next === '(') {
      return this.input[this.pos + 2] === '('
        ? this.readArithmetic()
        : this.readSubstitution(2, 'command');
    }
    if (next === '{') return this.readBraced();
    if (!inDoubleQuotes && next === "'") return this.readAnsiC();
    if (!inDoubleQuotes && next === '"') {
      this.pos++;
      return this.readDoubleQuoted();
    }
    this.pos++;
    return '$';
  }

  /** `$(...)`, `<(...)` or `>(...)`: parses the inner list with this parser. Returns the raw text. */
  private readSubstitution(openLength: number, kind: 'command' | 'process'): string {
    const start = this.pos;
    this.pos += openLength;
    if (kind === 'command') this.hasCommandSubstitution = true;
    else this.hasProcessSubstitution = true;
    this.enterNesting();
    this.parseList(() => this.peek().kind === ')');
    if (this.next().kind !== ')') {
      throw new ParseError(
        kind === 'command'
          ? 'Unterminated command substitution "$("'
          : 'Unterminated process substitution',
      );
    }
    this.nesting--;
    return this.input.slice(start, this.pos);
  }

  private readArithmetic(): string {
    const { input } = this;
    const start = this.pos;
    this.pos += 3;
    let depth = 2;
    while (this.pos < input.length && depth > 0) {
      const c = input[this.pos];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      this.pos++;
    }
    if (depth > 0) throw new ParseError('Unterminated arithmetic expansion "$(("');
    const text = input.slice(start, this.pos);
    if (/\$\(|`/.test(text.slice(3))) this.hasCommandSubstitution = true;
    return text;
  }

  private readBraced(): string {
    const { input } = this;
    const start = this.pos;
    this.pos += 2;
    let depth = 1;
    while (this.pos < input.length && depth > 0) {
      const c = input[this.pos];
      if (c === '\\') {
        this.pos += 2;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      this.pos++;
    }
    if (depth > 0) throw new ParseError('Unterminated parameter expansion "${"');
    const text = input.slice(start, this.pos);
    if (/\$\(|`/.test(text)) this.hasCommandSubstitution = true;
    return text;
  }

  private readAnsiC(): string {
    const { input } = this;
    let i = this.pos + 2;
    let content = '';
    while (i < input.length && input[i] !== "'") {
      if (input[i] === '\\' && i + 1 < input.length) {
        content += input.slice(i, i + 2);
        i += 2;
      } else {
        content += input[i];
        i++;
      }
    }
    if (i >= input.length) throw new ParseError("Unterminated $'...' string");
    this.pos = i + 1;
    return decodeAnsiC(content);
  }

  private readBackticks(): string {
    const { input } = this;
    let i = this.pos + 1;
    let content = '';
    while (i < input.length && input[i] !== '`') {
      if (input[i] === '\\' && i + 1 < input.length) {
        const next = input[i + 1];
        content += '$`\\'.includes(next) ? next : input.slice(i, i + 2);
        i += 2;
      } else {
        content += input[i];
        i++;
      }
    }
    if (i >= input.length) throw new ParseError('Unterminated backtick command substitution');
    const raw = input.slice(this.pos, i + 1);
    this.pos = i + 1;
    this.hasCommandSubstitution = true;
    this.mergeNested(content, (parser) => parser.parseProgram());
    return raw;
  }

  private readPendingHeredocs(): void {
    const { input } = this;
    const pending = this.pendingHeredocs;
    this.pendingHeredocs = [];
    for (const heredoc of pending) {
      let body = '';
      while (this.pos < input.length) {
        const newline = input.indexOf('\n', this.pos);
        const lineEnd = newline < 0 ? input.length : newline;
        const line = input.slice(this.pos, lineEnd);
        this.pos = newline < 0 ? input.length : newline + 1;
        const candidate = heredoc.stripTabs ? line.replace(/^\t+/, '') : line;
        if (candidate === heredoc.delimiter) break;
        body += `${line}\n`;
      }
      if (heredoc.expand && /[$`]/.test(body)) {
        this.mergeNested(body, (parser) => parser.scanExpansions());
      }
    }
  }

  /** Parses `text` with a separate parser and merges its commands into this one. */
  private mergeNested(text: string, run: (parser: ShellParser) => void): void {
    this.enterNesting();
    const nested = new ShellParser(text, this.nesting);
    run(nested);
    this.nesting--;
    const offset = this.commands.length;
    if (offset + nested.commands.length > MAX_COMMANDS) {
      throw new ParseError('The command has too many parts to analyze');
    }
    if (this.pipes.length + nested.pipes.length > MAX_PIPES) {
      throw new ParseError('The command has too many pipes to analyze');
    }
    this.countItem(nested.items);
    this.commands.push(...nested.commands);
    this.operators.push(...nested.operators);
    for (const [from, to] of nested.pipes) this.pipes.push([from + offset, to + offset]);
    for (const { name, body } of nested.functions) {
      this.functions.push({ name, body: [body[0] + offset, body[1] + offset] });
    }
    this.loopVariables.push(...nested.loopVariables);
    this.hasCommandSubstitution ||= nested.hasCommandSubstitution;
    this.hasProcessSubstitution ||= nested.hasProcessSubstitution;
    this.hasFunctionDefinition ||= nested.hasFunctionDefinition;
    if (nested.error !== undefined) throw new ParseError(nested.error);
  }

  private enterNesting(): void {
    this.nesting++;
    if (this.nesting > MAX_NESTING) throw new ParseError('The command is nested too deeply');
  }
}

function isClosingBrace(token: Token): boolean {
  return token.kind === 'word' && token.raw === '}';
}

function isPrefixKeyword(token: Token): boolean {
  return token.kind === 'word' && token.raw === token.value && PREFIX_KEYWORDS.has(token.value);
}

function describeToken(token: Token): string {
  switch (token.kind) {
    case 'eof':
      return 'end of input';
    case 'op':
      return token.op === '\n' ? 'newline' : `"${token.op}"`;
    case 'redirect':
      return `"${token.op}"`;
    case 'word':
      return `"${token.value}"`;
    default:
      return `"${token.kind}"`;
  }
}

function decodeAnsiC(content: string): string {
  return content.replace(
    /\\(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3})|c(.)|([\s\S]))/g,
    (
      _match,
      hex?: string,
      u4?: string,
      u8?: string,
      octal?: string,
      control?: string,
      other?: string,
    ) => {
      const code = hex ?? u4 ?? u8;
      if (code !== undefined) return safeFromCodePoint(Number.parseInt(code, 16));
      if (octal !== undefined) return String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
      if (control !== undefined) return String.fromCharCode(control.charCodeAt(0) & 0x1f);
      return other === undefined ? '' : (ANSI_C_ESCAPES[other] ?? other);
    },
  );
}

function safeFromCodePoint(code: number): string {
  return code <= 0x10ffff ? String.fromCodePoint(code) : '';
}
