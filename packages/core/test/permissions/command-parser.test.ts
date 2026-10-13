import { describe, expect, it } from 'vitest';
import { parseCommand } from '../../src/permissions/command-parser.js';

const words = (input: string): string[][] =>
  parseCommand(input).commands.map((command) => command.words);

describe('parseCommand words and quoting', () => {
  it('splits words on blanks', () => {
    expect(words('ls   -la\tsrc')).toEqual([['ls', '-la', 'src']]);
  });

  it('removes single and double quotes and keeps their contents literal', () => {
    expect(words(`echo 'a && rm -rf /' "b | c" d'e'"f"`)).toEqual([
      ['echo', 'a && rm -rf /', 'b | c', 'def'],
    ]);
    expect(parseCommand(`echo 'a && b'`).operators).toEqual([]);
  });

  it('handles backslash escapes outside and inside double quotes', () => {
    expect(words('echo a\\ b \\; \\$HOME')).toEqual([['echo', 'a b', ';', '$HOME']]);
    expect(words('echo "a \\"q\\" \\$x \\n"')).toEqual([['echo', 'a "q" $x \\n']]);
    expect(words("echo 'no \\escape'")).toEqual([['echo', 'no \\escape']]);
  });

  it('decodes ANSI-C quoting', () => {
    expect(words("echo $'\\x72m' $'a\\tb' $'\\101'")).toEqual([['echo', 'rm', 'a\tb', 'A']]);
  });

  it('keeps raw words alongside unquoted values', () => {
    const [command] = parseCommand(`cat "my file.txt" C:\\Users`).commands;
    expect(command.words).toEqual(['cat', 'my file.txt', 'C:Users']);
    expect(command.rawWords).toEqual(['cat', '"my file.txt"', 'C:\\Users']);
  });

  it('keeps empty quoted arguments', () => {
    expect(words(`git commit -m ''`)).toEqual([['git', 'commit', '-m', '']]);
  });

  it('separates leading assignments from words', () => {
    const [command] = parseCommand('FOO=1 BAR="a b" pnpm test X=2').commands;
    expect(command.assignments).toEqual(['FOO=1', 'BAR=a b']);
    expect(command.words).toEqual(['pnpm', 'test', 'X=2']);
  });

  it('records each simple command text', () => {
    expect(
      parseCommand('cd src && ls -la | wc -l').commands.map((command) => command.text),
    ).toEqual(['cd src', 'ls -la', 'wc -l']);
  });

  it('normalizes CRLF line endings', () => {
    expect(words('ls\r\npwd\r\n')).toEqual([['ls'], ['pwd']]);
  });
});

describe('parseCommand operators', () => {
  it('records list operators and pipes in order', () => {
    const parsed = parseCommand('a && b || c ; d & e\nf | g |& h');
    expect(parsed.operators).toEqual(['&&', '||', ';', '&', '\n', '|', '|&']);
    expect(words('a && b || c ; d & e\nf | g |& h').map((w) => w[0])).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
    ]);
    expect(parsed.pipes).toEqual([
      [5, 6],
      [6, 7],
    ]);
  });

  it('allows a newline after && and |', () => {
    expect(words('a &&\n  b |\n c')).toEqual([['a'], ['b'], ['c']]);
  });

  it('accepts a trailing ; or &', () => {
    expect(parseCommand('sleep 1 &').error).toBeUndefined();
    expect(parseCommand('ls;').error).toBeUndefined();
  });

  it('reports dangling or leading operators', () => {
    expect(parseCommand('ls &&').error).toMatch(/after "&&"/);
    expect(parseCommand('ls |').error).toMatch(/after "\|"/);
    expect(parseCommand('&& ls').error).toMatch(/Unexpected "&&"/);
    expect(parseCommand('ls ;; pwd').error).toMatch(/Unexpected ";"/);
  });
});

describe('parseCommand redirections', () => {
  it('parses file, fd and combined redirections', () => {
    const [command] = parseCommand(
      'cmd > out.txt 2>&1 >>log 2> err <in &>all &>>more >/dev/null 1>&2 >|clobber',
    ).commands;
    expect(command.words).toEqual(['cmd']);
    expect(command.redirects.map(({ op, target }) => ({ op, target }))).toEqual([
      { op: '>', target: 'out.txt' },
      { op: '2>&', target: '1' },
      { op: '>>', target: 'log' },
      { op: '2>', target: 'err' },
      { op: '<', target: 'in' },
      { op: '&>', target: 'all' },
      { op: '&>>', target: 'more' },
      { op: '>', target: '/dev/null' },
      { op: '1>&', target: '2' },
      { op: '>|', target: 'clobber' },
    ]);
  });

  it('does not treat digits inside words as file descriptors', () => {
    const [command] = parseCommand('echo a2>x 2 > y').commands;
    expect(command.words).toEqual(['echo', 'a2', '2']);
    expect(command.redirects.map((r) => r.op)).toEqual(['>', '>']);
  });

  it('reports a missing redirection target', () => {
    expect(parseCommand('ls >').error).toMatch(/Missing target after ">"/);
  });

  it('skips heredoc bodies and handles <<- and quoted delimiters', () => {
    const parsed = parseCommand('cat <<EOF > out.txt\nrm -rf /\nEOF\necho done');
    expect(words('cat <<EOF > out.txt\nrm -rf /\nEOF\necho done')).toEqual([
      ['cat'],
      ['echo', 'done'],
    ]);
    expect(parsed.commands[0].redirects.map((r) => r.op)).toEqual(['<<', '>']);
    expect(words('cat <<-END\n\trm x\n\tEND\npwd')).toEqual([['cat'], ['pwd']]);
    expect(words("cat <<'EOF'\n$(rm x)\nEOF")).toEqual([['cat']]);
    expect(parseCommand("cat <<'EOF'\n$(rm x)\nEOF").hasCommandSubstitution).toBe(false);
  });

  it('parses substitutions inside unquoted heredoc bodies', () => {
    const parsed = parseCommand('cat <<EOF\nvalue: $(whoami) `id`\nEOF');
    expect(parsed.hasCommandSubstitution).toBe(true);
    expect(parsed.commands.map((command) => command.words[0])).toEqual(['whoami', 'id', 'cat']);
  });

  it('treats a heredoc without a terminator as running to the end', () => {
    expect(words('cat <<EOF\nline\nmore')).toEqual([['cat']]);
  });

  it('parses here-strings', () => {
    const [command] = parseCommand('grep x <<< "a x b"').commands;
    expect(command.redirects).toEqual([{ op: '<<<', target: 'a x b', rawTarget: '"a x b"' }]);
  });
});

describe('parseCommand grouping and substitution', () => {
  it('flattens subshells and brace groups and applies trailing redirections', () => {
    const parsed = parseCommand('(cd src && make) > build.log; { ls; pwd; } | wc -l');
    expect(parsed.commands.map((command) => command.words)).toEqual([
      ['cd', 'src'],
      ['make'],
      ['ls'],
      ['pwd'],
      ['wc', '-l'],
    ]);
    expect(parsed.commands[0].redirects).toEqual([
      { op: '>', target: 'build.log', rawTarget: 'build.log' },
    ]);
    expect(parsed.commands[1].redirects).toHaveLength(1);
    expect(parsed.pipes).toEqual([
      [2, 4],
      [3, 4],
    ]);
  });

  it('reports unbalanced parentheses and groups', () => {
    expect(parseCommand('(ls').error).toMatch(/missing "\)"/);
    expect(parseCommand('ls)').error).toMatch(/Unexpected "\)"/);
    expect(parseCommand('{ ls').error).toMatch(/missing "}"/);
  });

  it('parses command substitutions and includes their commands first', () => {
    const parsed = parseCommand('echo $(ls $(pwd)) "$(date)" `whoami`');
    expect(parsed.hasCommandSubstitution).toBe(true);
    expect(parsed.commands.map((command) => command.words[0])).toEqual([
      'pwd',
      'ls',
      'date',
      'whoami',
      'echo',
    ]);
    expect(parsed.commands[4].words).toEqual(['echo', '$(ls $(pwd))', '$(date)', '`whoami`']);
  });

  it('parses process substitutions', () => {
    const parsed = parseCommand('diff <(sort a) >(tee b)');
    expect(parsed.hasProcessSubstitution).toBe(true);
    expect(parsed.commands.map((command) => command.words[0])).toEqual(['sort', 'tee', 'diff']);
  });

  it('keeps arithmetic and parameter expansions as words', () => {
    const parsed = parseCommand('echo $((1 + (2 * 3))) ${HOME:-/tmp} ${#x}');
    expect(parsed.hasCommandSubstitution).toBe(false);
    expect(parsed.commands[0].words).toEqual([
      'echo',
      '$((1 + (2 * 3)))',
      '${HOME:-/tmp}',
      '${#x}',
    ]);
  });

  it('reports unterminated quotes and substitutions', () => {
    expect(parseCommand("echo 'abc").error).toBe('Unterminated single quote');
    expect(parseCommand('echo "abc').error).toBe('Unterminated double quote');
    expect(parseCommand('echo $(ls').error).toMatch(/Unterminated command substitution/);
    expect(parseCommand('echo `ls').error).toMatch(/Unterminated backtick/);
    expect(parseCommand('echo ${HOME').error).toMatch(/Unterminated parameter expansion/);
  });

  it('keeps commands parsed before an error', () => {
    const parsed = parseCommand('sudo reboot\necho "x');
    expect(parsed.error).toBeDefined();
    expect(parsed.commands.map((command) => command.words)).toEqual([['sudo', 'reboot']]);
  });
});

describe('parseCommand comments, continuations and keywords', () => {
  it('ignores comments but not # inside words', () => {
    expect(words('ls # rm -rf /\npwd')).toEqual([['ls'], ['pwd']]);
    expect(words('echo a#b "#c"')).toEqual([['echo', 'a#b', '#c']]);
    expect(words('# only a comment')).toEqual([]);
  });

  it('joins line continuations', () => {
    expect(words('ls \\\n  -la \\\n  src')).toEqual([['ls', '-la', 'src']]);
    expect(words('ec\\\nho hi')).toEqual([['echo', 'hi']]);
  });

  it('strips compound-command keywords', () => {
    expect(words('if [ -f x ]; then cat x; else echo no; fi')).toEqual([
      ['[', '-f', 'x', ']'],
      ['cat', 'x'],
      ['echo', 'no'],
    ]);
    expect(words('while true; do ls; done > log')).toEqual([['true'], ['ls'], []]);
    expect(words('for f in *.ts; do cat "$f"; done')).toEqual([['cat', '$f']]);
    expect(words('! grep -q x f')).toEqual([['grep', '-q', 'x', 'f']]);
  });

  it('recognizes function definitions', () => {
    const fork = parseCommand(':(){ :|:& };:');
    expect(fork.hasFunctionDefinition).toBe(true);
    expect(fork.error).toBeUndefined();
    expect(fork.commands.map((command) => command.words)).toEqual([[':'], [':'], [':']]);
    expect(
      parseCommand('function greet { echo hi; }; greet').commands.map((c) => c.words[0]),
    ).toEqual(['echo', 'greet']);
  });

  it('reports case statements as unsupported', () => {
    expect(parseCommand('case $x in a) ls;; esac').error).toBe('case statements are not supported');
  });
});

describe('parseCommand robustness', () => {
  it('never throws on arbitrary input', () => {
    const alphabet = [
      'a',
      ' ',
      "'",
      '"',
      '\\',
      '$',
      '(',
      ')',
      '`',
      '|',
      '&',
      ';',
      '<',
      '>',
      '{',
      '}',
      '\n',
      '#',
      '=',
      '*',
    ];
    let seed = 42;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 2000; i++) {
      const length = Math.floor(random() * 30);
      const input = Array.from(
        { length },
        () => alphabet[Math.floor(random() * alphabet.length)],
      ).join('');
      expect(() => parseCommand(input)).not.toThrow();
    }
  });

  it('limits nesting depth', () => {
    const deep = `${'$('.repeat(40)}ls${')'.repeat(40)}`;
    expect(parseCommand(deep).error).toMatch(/nested too deeply/);
  });

  it('returns an empty result for empty input', () => {
    expect(parseCommand('   ')).toEqual({
      commands: [],
      operators: [],
      pipes: [],
      hasCommandSubstitution: false,
      hasProcessSubstitution: false,
      hasFunctionDefinition: false,
      functions: [],
      loopVariables: [],
    });
  });
});
