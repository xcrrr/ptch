import { stripAnsi } from '@patch/shared';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderMarkdown, splitCommittable } from '../../src/ui/markdown.js';
import { displayWidth } from '../../src/ui/text-layout.js';

const render = (markdown: string, width = 60): string =>
  stripAnsi(renderMarkdown(markdown, { width }));
const lines = (markdown: string, width = 60): string[] => render(markdown, width).split('\n');

describe('renderMarkdown', () => {
  const previousLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
  });
  afterAll(() => {
    chalk.level = previousLevel;
  });

  it('renders headings as bold text followed by one blank line', () => {
    const output = renderMarkdown('# Title\nBody text', { width: 40 });
    expect(stripAnsi(output)).toBe('Title\n\nBody text');
    expect(output).toContain(chalk.bold('Title'));
    expect(output).not.toContain('#');
  });

  it('separates paragraphs with exactly one blank line and has no trailing newline', () => {
    expect(render('one\n\n\n\ntwo\n\n')).toBe('one\n\ntwo');
  });

  it('returns an empty string for empty or blank input', () => {
    expect(renderMarkdown('', { width: 40 })).toBe('');
    expect(renderMarkdown('  \n\n ', { width: 40 })).toBe('');
  });

  it('styles emphasis without leaving markers', () => {
    const output = renderMarkdown('**bold** *italic* ~~gone~~', { width: 40 });
    expect(stripAnsi(output)).toBe('bold italic gone');
    expect(output).toContain(chalk.bold('bold'));
    expect(output).toContain(chalk.italic('italic'));
    expect(output).toContain(chalk.strikethrough('gone'));
  });

  it('colors inline code without backticks and keeps its spacing', () => {
    const output = renderMarkdown('run `pnpm  test` now', { width: 40 });
    expect(stripAnsi(output)).toBe('run pnpm  test now');
    expect(output).toContain(chalk.cyan('pnpm  test'));
  });

  it('wraps prose to the width at word boundaries', () => {
    const output = lines('alpha beta gamma delta epsilon zeta eta theta', 16);
    expect(output).toEqual(['alpha beta gamma', 'delta epsilon', 'zeta eta theta']);
    for (const line of output) expect(displayWidth(line)).toBeLessThanOrEqual(16);
  });

  it('keeps styled punctuation attached to its word when wrapping', () => {
    expect(lines('aaaa **bbbb**, cccc', 9)).toEqual(['aaaa', 'bbbb,', 'cccc']);
  });

  it('breaks words longer than the width', () => {
    expect(lines('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('wraps wide characters by display width', () => {
    for (const line of lines('日本語のテキストを折り返す必要があります', 10)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(10);
    }
  });

  it('keeps soft and hard line breaks', () => {
    expect(render('first line\nsecond line')).toBe('first line\nsecond line');
    expect(render('first  \nsecond')).toBe('first\nsecond');
  });

  it('renders unordered lists with bullets and nested lists indented by two', () => {
    expect(lines('- one\n- two\n  - nested\n    - deeper\n- three')).toEqual([
      '• one',
      '• two',
      '  • nested',
      '    • deeper',
      '• three',
    ]);
  });

  it('renders ordered lists from their start number with aligned markers', () => {
    expect(lines('3. three\n4. four')).toEqual(['3. three', '4. four']);
    const many = Array.from({ length: 10 }, (_, i) => `${i + 1}. item`).join('\n');
    const rendered = lines(many);
    expect(rendered[0]).toBe(' 1. item');
    expect(rendered[9]).toBe('10. item');
  });

  it('indents wrapped list text under the item content', () => {
    expect(lines('- alpha beta gamma delta', 14)).toEqual(['• alpha beta', '  gamma delta']);
  });

  it('renders task items with checkboxes in tight and loose lists', () => {
    expect(lines('- [ ] todo\n- [x] done')).toEqual(['[ ] todo', '[x] done']);
    expect(lines('- [ ] todo\n\n- [x] done')).toEqual(['[ ] todo', '', '[x] done']);
    expect(lines('1. [x] first')).toEqual(['1. [x] first']);
  });

  it('separates loose list items with blank lines and keeps item paragraphs together', () => {
    expect(lines('- a\n\n  more about a\n\n- b')).toEqual(['• a', '', '  more about a', '', '• b']);
  });

  it('renders fenced code with a gutter and a language label', () => {
    const output = renderMarkdown('```ts\nconst a = 1;\n\n  return a;\n```', { width: 40 });
    expect(stripAnsi(output).split('\n')).toEqual(['│ ts', '│ const a = 1;', '│', '│   return a;']);
    expect(output).toContain(chalk.dim('│ '));
    expect(output).not.toContain('```');
  });

  it('renders indented code blocks and nested code in lists', () => {
    expect(lines('    indented code')).toEqual(['│ indented code']);
    expect(lines('1. step\n   ```sh\n   npm i\n   ```\n2. next')).toEqual([
      '1. step',
      '   │ sh',
      '   │ npm i',
      '2. next',
    ]);
  });

  it('wraps long code lines at whitespace, never mid-token', () => {
    const output = lines('```\nconst value = computeSomething(argumentOne, argumentTwo);\n```', 32);
    expect(output).toEqual([
      '│ const value =',
      '│ computeSomething(argumentOne,',
      '│ argumentTwo);',
    ]);
  });

  it('expands tabs in code', () => {
    expect(lines('```\n\tif (x) {}\n```')).toEqual(['│     if (x) {}']);
  });

  it('renders blockquotes with a dim gutter', () => {
    const output = renderMarkdown('> quoted\n>\n> more', { width: 40 });
    expect(stripAnsi(output).split('\n')).toEqual(['│ quoted', '│', '│ more']);
    expect(output).toContain(chalk.dim('│ '));
  });

  it('renders links with a dim url unless the text is the url', () => {
    const output = renderMarkdown('see [docs](https://x.dev/docs) or https://x.dev', { width: 80 });
    expect(stripAnsi(output)).toBe('see docs (https://x.dev/docs) or https://x.dev');
    expect(output).toContain(chalk.dim('(https://x.dev/docs)'));
    expect(output).toContain(chalk.blue('docs'));
    expect(render('<https://x.dev>')).toBe('https://x.dev');
    expect(render('mail me@x.dev')).toBe('mail me@x.dev');
  });

  it('renders images as alt text with the url', () => {
    expect(render('![diagram](img.png)')).toBe('diagram (img.png)');
    expect(render('![](img.png)')).toBe('(img.png)');
  });

  it('renders a horizontal rule capped at 40 columns', () => {
    expect(render('a\n\n---\n\nb', 80)).toBe(`a\n\n${'─'.repeat(40)}\n\nb`);
    expect(render('---', 12)).toBe('─'.repeat(12));
  });

  it('renders tables with aligned columns when they fit', () => {
    const table =
      '| Name | Count | State |\n|------|------:|:-----:|\n| alpha | 1 | ok |\n| beta | 22 | fine |';
    expect(lines(table, 60)).toEqual([
      'Name  │ Count │ State',
      '──────┼───────┼──────',
      'alpha │     1 │  ok',
      'beta  │    22 │ fine',
    ]);
  });

  it('falls back to header: value lines when a table is too wide', () => {
    const table =
      '| Name | Description |\n|---|---|\n| alpha | a rather long description |\n| beta | short |';
    expect(lines(table, 20)).toEqual([
      'Name: alpha',
      'Description: a',
      'rather long',
      'description',
      '',
      'Name: beta',
      'Description: short',
    ]);
  });

  it('prints raw HTML as text', () => {
    expect(render('<div>raw</div>')).toBe('<div>raw</div>');
    expect(render('text <b>bold</b> end')).toBe('text <b>bold</b> end');
  });

  it('decodes entities in prose but not in code', () => {
    expect(render('a &amp; b &lt;tag&gt; &#169;')).toBe('a & b <tag> ©');
    expect(render('`&amp;`')).toBe('&amp;');
  });

  it('never emits background colors and strips ANSI from the source', () => {
    const output = renderMarkdown('\u001b[41mred bg\u001b[0m **x** `y`', { width: 40 });
    expect(output).not.toMatch(/\u001b\[4\dm/);
    expect(stripAnsi(output)).toBe('red bg x y');
  });

  it('handles malformed markdown without throwing', () => {
    const inputs = [
      '**unclosed bold and [broken link(',
      '```\nunclosed fence\nstill code',
      '| a | b |\n|---|\n| 1 |',
      '- [ ]\n-\n1.',
      '>>> > >',
      '\u0000\u0007 control',
      '<div><span>',
      '# '.repeat(50),
    ];
    for (const input of inputs) {
      expect(() => renderMarkdown(input, { width: 30 })).not.toThrow();
    }
    expect(render('**unclosed bold')).toBe('**unclosed bold');
    expect(lines('```\nunclosed fence\nstill code')).toEqual(['│ unclosed fence', '│ still code']);
  });

  it('copes with tiny and fractional widths', () => {
    expect(() => renderMarkdown('# Heading\n\n- item with words', { width: 0 })).not.toThrow();
    expect(render('one two', 3.7)).toBe('one\ntwo');
  });

  it('normalizes CRLF input', () => {
    expect(render('one\r\n\r\ntwo')).toBe('one\n\ntwo');
  });
});

describe('splitCommittable', () => {
  it('returns nothing to commit without a block boundary', () => {
    expect(splitCommittable('')).toEqual({ commit: '', rest: '' });
    expect(splitCommittable('a paragraph still being')).toEqual({
      commit: '',
      rest: 'a paragraph still being',
    });
    expect(splitCommittable('line one\nline two\n')).toEqual({
      commit: '',
      rest: 'line one\nline two\n',
    });
  });

  it('commits complete paragraphs at the last blank line', () => {
    expect(splitCommittable('first\n\nsecond\n\nthird is stre')).toEqual({
      commit: 'first\n\nsecond',
      rest: 'third is stre',
    });
  });

  it('commits a paragraph followed by a blank line even before the next block starts', () => {
    expect(splitCommittable('done.\n\n')).toEqual({ commit: 'done.', rest: '' });
    expect(splitCommittable('done.\n\n\n\nnext')).toEqual({ commit: 'done.', rest: 'next' });
  });

  it('does not treat an unfinished whitespace line as a blank line', () => {
    expect(splitCommittable('para\n  ')).toEqual({ commit: '', rest: 'para\n  ' });
  });

  it('never commits inside an open fence', () => {
    const text = 'intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n';
    expect(splitCommittable(text)).toEqual({
      commit: 'intro',
      rest: '```ts\nconst a = 1;\n\nconst b = 2;\n',
    });
  });

  it('commits right after a closing fence', () => {
    expect(splitCommittable('```js\nx\n\ny\n```\nAfter the code')).toEqual({
      commit: '```js\nx\n\ny\n```',
      rest: 'After the code',
    });
  });

  it('waits until the closing fence line is complete', () => {
    expect(splitCommittable('```\ncode\n```')).toEqual({ commit: '', rest: '```\ncode\n```' });
  });

  it('handles tilde fences and longer closing fences', () => {
    expect(splitCommittable('~~~\na\n```\n\nb\n~~~~\nrest')).toEqual({
      commit: '~~~\na\n```\n\nb\n~~~~',
      rest: 'rest',
    });
  });

  it('does not close a fence with a shorter or different marker', () => {
    const text = '````\nx\n```\n\ny\n';
    expect(splitCommittable(text)).toEqual({ commit: '', rest: text });
  });

  it('does not mistake inline triple backticks for a fence', () => {
    expect(splitCommittable('use ```js``` here\n\nnext')).toEqual({
      commit: 'use ```js``` here',
      rest: 'next',
    });
  });

  it('commits a list once the next unindented block starts', () => {
    expect(splitCommittable('- a\n- b\n\n')).toEqual({ commit: '', rest: '- a\n- b\n\n' });
    expect(splitCommittable('- a\n- b\n\nAfter')).toEqual({ commit: '- a\n- b', rest: 'After' });
  });

  it('keeps indented continuation paragraphs with their list item', () => {
    const text = '1. first\n\n   more about first\n\n2. second';
    expect(splitCommittable(text)).toEqual({
      commit: '1. first\n\n   more about first',
      rest: '2. second',
    });
  });

  it('does not commit after a fence nested in a list', () => {
    const text = '1. Install:\n   ```sh\n   npm i\n   ```\n2. Run';
    expect(splitCommittable(text)).toEqual({ commit: '', rest: text });
  });

  it('keeps blank lines inside indented code together', () => {
    expect(splitCommittable('    code one\n\n    code two\n\nAfter')).toEqual({
      commit: '    code one\n\n    code two',
      rest: 'After',
    });
  });

  it('commits a paragraph before a list and holds the list', () => {
    expect(splitCommittable('Steps:\n\n- one\n- two\n\n')).toEqual({
      commit: 'Steps:',
      rest: '- one\n- two\n\n',
    });
  });

  it('handles CRLF line endings', () => {
    expect(splitCommittable('one\r\n\r\ntwo')).toEqual({ commit: 'one', rest: 'two' });
  });

  it('streams to the same blocks as rendering the whole text at once', () => {
    const full =
      '# Plan\n\nIntro paragraph.\n\n- a\n- b\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\nClosing words.\n';
    const committed: string[] = [];
    let buffer = '';
    for (const char of full) {
      buffer += char;
      const { commit, rest } = splitCommittable(buffer);
      if (commit) committed.push(commit);
      buffer = rest;
    }
    if (buffer.trim()) committed.push(buffer.trim());
    expect(committed).toEqual([
      '# Plan',
      'Intro paragraph.',
      '- a\n- b',
      '```ts\nconst x = 1;\n\nconst y = 2;\n```',
      'Closing words.',
    ]);
  });
});
