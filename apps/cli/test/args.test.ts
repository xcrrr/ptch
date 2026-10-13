import { describe, expect, it } from 'vitest';
import { UsageError, parseArgs } from '../src/args.js';

describe('parseArgs', () => {
  it('defaults to an interactive session without a prompt', () => {
    const args = parseArgs([]);
    expect(args.print).toBe(false);
    expect(args.prompt).toBeUndefined();
    expect(args.outputFormat).toBe('text');
  });

  it('joins positional words into the initial prompt', () => {
    expect(parseArgs(['fix', 'the', 'tests']).prompt).toBe('fix the tests');
  });

  it('parses -p with a value and with a positional prompt', () => {
    expect(parseArgs(['-p', 'describe this repo'])).toMatchObject({
      print: true,
      prompt: 'describe this repo',
    });
    expect(parseArgs(['--print', '--', 'hello world'])).toMatchObject({
      print: true,
      prompt: 'hello world',
    });
    expect(parseArgs(['--print=inline'])).toMatchObject({ print: true, prompt: 'inline' });
  });

  it('allows -p without a prompt (stdin supplies it)', () => {
    const args = parseArgs(['-p']);
    expect(args.print).toBe(true);
    expect(args.prompt).toBeUndefined();
  });

  it('takes an id after --resume only when it looks like a session id', () => {
    expect(parseArgs(['--resume', '82af31'])).toMatchObject({ resume: true, resumeId: '82af31' });
    const bare = parseArgs(['-r']);
    expect(bare.resume).toBe(true);
    expect(bare.resumeId).toBeUndefined();
    const withPrompt = parseArgs(['--resume', 'fix the bug']);
    expect(withPrompt).toMatchObject({ resume: true, prompt: 'fix the bug' });
    expect(withPrompt.resumeId).toBeUndefined();
  });

  it('parses --continue, --model, --debug', () => {
    expect(parseArgs(['-c', '-m', 'claude-sonnet-5-5', '--debug'])).toMatchObject({
      continue: true,
      model: 'claude-sonnet-5-5',
      debug: true,
    });
    expect(parseArgs(['--model=claude-haiku-4-5']).model).toBe('claude-haiku-4-5');
  });

  it('collects repeatable --allow-command values in print mode', () => {
    const args = parseArgs([
      '-p',
      'go',
      '--allow-edits',
      '--allow-command',
      'pnpm test',
      '--allow-command=pnpm lint',
    ]);
    expect(args.allowEdits).toBe(true);
    expect(args.allowCommands).toEqual(['pnpm test', 'pnpm lint']);
  });

  it('rejects print-only flags in interactive mode', () => {
    expect(() => parseArgs(['--allow-edits'])).toThrow(UsageError);
    expect(() => parseArgs(['--output-format', 'json'])).toThrow(UsageError);
  });

  it('rejects unknown options, missing values and conflicts', () => {
    expect(() => parseArgs(['--frobnicate'])).toThrow(/Unknown option: --frobnicate/);
    expect(() => parseArgs(['--model'])).toThrow(/--model needs a value/);
    expect(() => parseArgs(['--continue', '--resume'])).toThrow(/either --continue or --resume/);
    expect(() => parseArgs(['-p', 'x', '--output-format', 'yaml'])).toThrow(
      /"text", "json" or "stream-json"/,
    );
    expect(() => parseArgs(['--max-steps', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['-p', 'x', '--resume'])).toThrow(/needs a session id/);
  });

  it('parses --max-steps and --output-format json', () => {
    expect(parseArgs(['-p', 'x', '--max-steps', '12', '--output-format', 'json'])).toMatchObject({
      maxSteps: 12,
      outputFormat: 'json',
    });
  });

  it('recognizes help and version flags', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--version']).version).toBe(true);
  });
});

describe('--output-format stream-json', () => {
  it('is accepted in print mode only', () => {
    expect(parseArgs(['-p', 'x', '--output-format', 'stream-json']).outputFormat).toBe(
      'stream-json',
    );
    expect(() => parseArgs(['x', '--output-format', 'stream-json'])).toThrow(UsageError);
  });
});
