import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@patch/core';
import { stripAnsi } from '@patch/shared';
import { pickSession } from '../../src/app/pick-session.js';
import { sessionPickerHeight, sessionPickerMaxVisible } from '../../src/ui/components/index.js';
import { delay, fakeTerminal, waitFor } from './fake-tty.js';

const DOWN = '\u001b[B';
const ENTER = '\r';

function sessions(count: number): SessionSummary[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    id: `${String(i).padStart(2, '0')}aa11bb22cc33dd44ee55ff66778899`,
    title: `Session number ${i + 1}`,
    createdAt: new Date(now - i * 60_000).toISOString(),
    updatedAt: new Date(now - i * 60_000).toISOString(),
    cwd: '/repo',
    projectRoot: '/repo',
    branch: 'main',
    model: 'claude-sonnet-5-5',
    messageCount: 4,
    projectExists: true,
    filePath: `/sessions/${i}.jsonl`,
  }));
}

describe('sessionPickerMaxVisible', () => {
  it('keeps the picker within the rows it is given', () => {
    for (let rows = 8; rows <= 40; rows++) {
      const visible = sessionPickerMaxVisible(rows);
      expect(visible).toBeGreaterThanOrEqual(1);
      expect(visible).toBeLessThanOrEqual(10);
      expect(sessionPickerHeight(30, visible)).toBeLessThanOrEqual(rows);
    }
    expect(sessionPickerMaxVisible(3)).toBe(1);
    expect(sessionPickerMaxVisible(100)).toBe(10);
  });
});

describe('pickSession (ptch --resume)', () => {
  it.each([12, 17])(
    'scrolls within a %i-row terminal without repainting the screen',
    async (rows) => {
      const term = fakeTerminal(80, rows);
      const list = sessions(30);
      const picked = pickSession(list, '~/repo', term.io.stdout, term.io.stdin);
      await waitFor(() => stripAnsi(term.stdout.output).includes('Resume a session'));
      for (let i = 0; i < 14; i++) {
        term.stdin.type(DOWN);
        await delay(15);
      }
      await waitFor(() => stripAnsi(term.stdout.output).includes('Session number 15'));
      await delay(50);
      // Ink's full-screen path (taken once output reaches the terminal height) clears the screen
      // and the scrollback on every frame.
      expect(term.stdout.clearsSince(0)).toBe(0);
      term.stdin.type(ENTER);
      expect(await picked).toBe(list[14]?.id);
    },
  );

  it('follows a terminal resize', async () => {
    const term = fakeTerminal(80, 24);
    const list = sessions(30);
    const picked = pickSession(list, '~/repo', term.io.stdout, term.io.stdin);
    await waitFor(() => stripAnsi(term.stdout.output).includes('↓ 20 more'));
    term.stdout.rows = 12;
    term.stdout.emit('resize');
    await waitFor(() => stripAnsi(term.stdout.output).includes('↓ 26 more'));
    term.stdin.type('\u001b');
    expect(await picked).toBeNull();
  });
});
