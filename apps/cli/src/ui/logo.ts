import { Chalk, type ChalkInstance } from 'chalk';

/**
 * The "ptch" wordmark: lowercase letters drawn on a pixel grid and printed with half-block
 * characters, so one pixel is one column wide and half a row tall (roughly square).
 *
 * Twelve pixel rows: three for ascenders, six for the x-height, three for the descender.
 */
const GLYPHS: Record<'p' | 't' | 'c' | 'h', readonly string[]> = {
  p: [
    '......',
    '......',
    '......',
    '#####.',
    '#....#',
    '#....#',
    '#....#',
    '#....#',
    '#####.',
    '#.....',
    '#.....',
    '#.....',
  ],
  t: [
    '....',
    '.#..',
    '.#..',
    '####',
    '.#..',
    '.#..',
    '.#..',
    '.#..',
    '..##',
    '....',
    '....',
    '....',
  ],
  c: [
    '......',
    '......',
    '......',
    '.#####',
    '#.....',
    '#.....',
    '#.....',
    '#.....',
    '.#####',
    '......',
    '......',
    '......',
  ],
  h: [
    '#.....',
    '#.....',
    '#.....',
    '#####.',
    '#....#',
    '#....#',
    '#....#',
    '#....#',
    '#....#',
    '......',
    '......',
    '......',
  ],
};

const WORD = ['p', 't', 'c', 'h'] as const;
const LETTER_GAP = 2;

export type Rgb = readonly [number, number, number];

/** The wordmark as rows of pixels (true = lit). */
export function logoPixels(): boolean[][] {
  const height = GLYPHS.p.length;
  const rows: boolean[][] = [];
  for (let y = 0; y < height; y++) {
    const row: boolean[] = [];
    WORD.forEach((letter, i) => {
      if (i > 0) for (let g = 0; g < LETTER_GAP; g++) row.push(false);
      for (const ch of GLYPHS[letter][y] ?? '') row.push(ch === '#');
    });
    rows.push(row);
  }
  return rows;
}

const PIXELS = logoPixels();
/** Pixel grid size. */
export const LOGO_PIXEL_WIDTH = PIXELS[0]?.length ?? 0;
export const LOGO_PIXEL_HEIGHT = PIXELS.length;

export type LogoSize = 'small' | 'large';

/** Terminal columns and rows the wordmark occupies. */
export function logoDimensions(size: LogoSize): { columns: number; rows: number } {
  return size === 'small'
    ? { columns: LOGO_PIXEL_WIDTH, rows: Math.ceil(LOGO_PIXEL_HEIGHT / 2) }
    : { columns: LOGO_PIXEL_WIDTH * 2, rows: LOGO_PIXEL_HEIGHT };
}

/** How lit a pixel is (0 = off, 1 = full) and its color at full brightness. */
export interface LogoFrame {
  intensity: (x: number, y: number) => number;
  color: (x: number, y: number) => Rgb;
}

/** Below this a pixel is not drawn at all. */
const VISIBLE = 0.04;
/** What a pixel fades from and to: near-black, so fades read on dark terminal themes. */
const DARK: Rgb = [22, 22, 22];

export const WHITE: Rgb = [255, 255, 255];

/** Flat white: every pixel the same color. */
export function whiteColor(): Rgb {
  return WHITE;
}

/** White at the top fading to silver at the bottom of the descender. */
export function silverColor(_x: number, y: number): Rgb {
  return mix(WHITE, [158, 162, 170], y / (LOGO_PIXEL_HEIGHT - 1));
}

/**
 * Renders one frame of the wordmark as terminal lines (with color escapes from `chalk`; plain
 * blocks when it has no color support).
 */
export function renderLogo(
  frame: LogoFrame,
  size: LogoSize = 'small',
  chalk: ChalkInstance = new Chalk(),
): string[] {
  const pixel = (x: number, y: number): Rgb | null => {
    if (!PIXELS[y]?.[x]) return null;
    const level = clamp01(frame.intensity(x, y));
    if (level < VISIBLE) return null;
    return mix(DARK, frame.color(x, y), level);
  };
  const paint = (rgb: Rgb, text: string) => (chalk.level > 0 ? chalk.rgb(...rgb)(text) : text);

  const lines: string[] = [];
  if (size === 'large') {
    for (let y = 0; y < LOGO_PIXEL_HEIGHT; y++) {
      let line = '';
      for (let x = 0; x < LOGO_PIXEL_WIDTH; x++) {
        const rgb = pixel(x, y);
        line += rgb ? paint(rgb, '██') : '  ';
      }
      lines.push(line.trimEnd());
    }
    return lines;
  }
  for (let y = 0; y < LOGO_PIXEL_HEIGHT; y += 2) {
    let line = '';
    for (let x = 0; x < LOGO_PIXEL_WIDTH; x++) {
      const top = pixel(x, y);
      const bottom = pixel(x, y + 1);
      if (top && bottom) line += paint(top, '█');
      else if (top) line += paint(top, '▀');
      else if (bottom) line += paint(bottom, '▄');
      else line += ' ';
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** The wordmark at full brightness. */
export function staticLogo(
  size: LogoSize = 'small',
  color: LogoFrame['color'] = silverColor,
  chalk?: ChalkInstance,
): string[] {
  return renderLogo({ intensity: () => 1, color }, size, chalk);
}

// ---------------------------------------------------------------------------
// Animation

/** Intro: pixels light up in a left-to-right wave, then a band of light sweeps across. */
export const INTRO_MS = 1_350;
/** Outro: pixels go out in random order. */
export const OUTRO_MS = 420;

const WAVE_MS = 520;
const WAVE_JITTER_MS = 200;
const RAMP_MS = 260;
const SHINE_START_MS = 720;
const SHINE_MS = 600;
const SHINE_HALF_WIDTH = 3;
const OUTRO_SPREAD_MS = OUTRO_MS - 150;
const OUTRO_FADE_MS = 150;

export function introFrame(elapsedMs: number, color: LogoFrame['color'] = silverColor): LogoFrame {
  const diagonal = (x: number, y: number) => x + (LOGO_PIXEL_HEIGHT - y) * 0.6;
  const span = LOGO_PIXEL_WIDTH + LOGO_PIXEL_HEIGHT * 0.6;
  const shineProgress = (elapsedMs - SHINE_START_MS) / SHINE_MS;
  const shineCenter = -SHINE_HALF_WIDTH + shineProgress * (span + 2 * SHINE_HALF_WIDTH);
  return {
    intensity: (x, y) => {
      const start = (x / LOGO_PIXEL_WIDTH) * WAVE_MS + noise(x, y) * WAVE_JITTER_MS;
      return easeOutCubic((elapsedMs - start) / RAMP_MS);
    },
    color: (x, y) => {
      const base = color(x, y);
      if (shineProgress <= 0 || shineProgress >= 1) return base;
      const distance = Math.abs(diagonal(x, y) - shineCenter);
      const glow = Math.max(0, 1 - distance / SHINE_HALF_WIDTH);
      return mix(base, WHITE, glow * glow);
    },
  };
}

export function outroFrame(elapsedMs: number, color: LogoFrame['color'] = silverColor): LogoFrame {
  return {
    intensity: (x, y) => {
      const start = noise(x, y) * OUTRO_SPREAD_MS;
      return 1 - easeInQuad((elapsedMs - start) / OUTRO_FADE_MS);
    },
    color,
  };
}

/** Deterministic per-pixel noise in [0, 1). */
function noise(x: number, y: number): number {
  let h = (x * 374_761_393 + y * 668_265_263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - (1 - c) ** 3;
}

function easeInQuad(t: number): number {
  const c = clamp01(t);
  return c * c;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function mix(from: Rgb, to: Rgb, t: number): Rgb {
  const k = clamp01(t);
  return [
    Math.round(from[0] + (to[0] - from[0]) * k),
    Math.round(from[1] + (to[1] - from[1]) * k),
    Math.round(from[2] + (to[2] - from[2]) * k),
  ];
}
