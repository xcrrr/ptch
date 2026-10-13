import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '@patch/core/testing';
import {
  HISTORY_COMPACT_BYTES,
  MAX_STORED_PROMPT_CHARS,
  PromptHistory,
} from '../../src/app/history.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function home(): string {
  const dir = makeTempDir('patch-history-');
  cleanups.push(dir.cleanup);
  return dir.dir;
}

const line = (project: string, text: string) =>
  `${JSON.stringify({ project, text, ts: '2026-01-01T00:00:00.000Z' })}\n`;

describe('PromptHistory', () => {
  it('recalls prompts per project, newest first and without duplicates', () => {
    const dir = home();
    const history = new PromptHistory(dir, '/work/a');
    history.add('first');
    history.add('second');
    history.add('first');
    new PromptHistory(dir, '/work/b').add('elsewhere');
    expect(new PromptHistory(dir, '/work/a').list()).toEqual(['first', 'second']);
  });

  it('compacts history.jsonl once it grows past the limit', () => {
    const dir = home();
    const file = join(dir, 'history.jsonl');
    const filler = 'x'.repeat(100);
    let content = '';
    for (let i = 0; i < 5; i++) content += line('/work/other', `other ${i}`);
    for (let i = 0; i < 25_000; i++) content += line('/work/a', `prompt ${i} ${filler}`);
    writeFileSync(file, content);
    expect(statSync(file).size).toBeGreaterThan(HISTORY_COMPACT_BYTES);

    const history = new PromptHistory(dir, '/work/a');
    expect(history.list()[0]).toBe(`prompt 24999 ${filler}`);
    history.add('newest');

    expect(statSync(file).size).toBeLessThanOrEqual(HISTORY_COMPACT_BYTES / 2);
    const recalled = new PromptHistory(dir, '/work/a').list();
    expect(recalled).toHaveLength(200);
    expect(recalled.slice(0, 2)).toEqual(['newest', `prompt 24999 ${filler}`]);
    expect(new PromptHistory(dir, '/work/other').list()).toEqual([
      'other 4',
      'other 3',
      'other 2',
      'other 1',
      'other 0',
    ]);
  });

  it('recalls a huge prompt during the session without writing it to disk', () => {
    const dir = home();
    const history = new PromptHistory(dir, '/work/a');
    const huge = 'y'.repeat(MAX_STORED_PROMPT_CHARS + 1);
    history.add(huge);
    expect(history.list()[0]).toBe(huge);
    const file = join(dir, 'history.jsonl');
    expect(existsSync(file) ? readFileSync(file, 'utf8') : '').toBe('');
  });

  it('reads only the end of a large history file', () => {
    const dir = home();
    const file = join(dir, 'history.jsonl');
    // The project's only prompt is buried under more history than startup reads.
    let content = line('/work/a', 'ancient');
    const filler = 'z'.repeat(200);
    for (let i = 0; i < 20_000; i++) content += line('/work/b', `${i} ${filler}`);
    writeFileSync(file, content);
    expect(new PromptHistory(dir, '/work/a').list()).toEqual([]);
    expect(new PromptHistory(dir, '/work/b').list()).toHaveLength(200);
  });
});
