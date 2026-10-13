import { Chalk } from 'chalk';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '@patch/shared';
import {
  INTRO_MS,
  OUTRO_MS,
  introFrame,
  logoDimensions,
  outroFrame,
  renderLogo,
  staticLogo,
} from '../../src/ui/logo.js';

const plain = new Chalk({ level: 0 });
const color = new Chalk({ level: 3 });

describe('the ptch wordmark', () => {
  it('draws lowercase p, t, c and h in half blocks', () => {
    expect(staticLogo('small', undefined, plain)).toEqual([
      '         ▄            █',
      '▄▄▄▄▄   ▄█▄▄   ▄▄▄▄▄  █▄▄▄▄',
      '█    █   █    █       █    █',
      '█    █   █    █       █    █',
      '█▀▀▀▀     ▀▀   ▀▀▀▀▀  ▀    ▀',
      '█',
    ]);
  });

  it('fits the dimensions it reports', () => {
    for (const size of ['small', 'large'] as const) {
      const lines = staticLogo(size, undefined, plain);
      const { columns, rows } = logoDimensions(size);
      expect(lines).toHaveLength(rows);
      expect(Math.max(...lines.map((line) => line.length))).toBe(columns);
    }
  });

  it('is white at the top, fading to silver toward the descender', () => {
    const lines = staticLogo('small', undefined, color);
    expect(lines[0]).toContain('\u001b[38;2;255;255;255m');
    expect(lines[5]).not.toContain('\u001b[38;2;255;255;255m');
    expect(stripAnsi(lines.join('\n'))).toBe(staticLogo('small', undefined, plain).join('\n'));
  });

  it('animates in from nothing to the full wordmark', () => {
    const blank = renderLogo(introFrame(0), 'small', plain).join('');
    expect(blank.trim()).toBe('');
    const midway = renderLogo(introFrame(INTRO_MS / 3), 'small', plain).join('\n');
    expect(midway.trim()).not.toBe('');
    expect(midway).not.toBe(staticLogo('small', undefined, plain).join('\n'));
    expect(renderLogo(introFrame(INTRO_MS), 'small', color)).toEqual(
      staticLogo('small', undefined, color),
    );
  });

  it('animates out to nothing', () => {
    expect(renderLogo(outroFrame(0), 'small', plain)).toEqual(
      staticLogo('small', undefined, plain),
    );
    expect(renderLogo(outroFrame(OUTRO_MS), 'small', plain).join('').trim()).toBe('');
  });
});
