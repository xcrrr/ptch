/**
 * Plays the ptch wordmark animations and prints the variants, for judging the logo in a real
 * terminal: `pnpm -C apps/cli logo` (add `--loop` to repeat the animation until Ctrl+C).
 * `--svg` writes the README logo to docs/images instead.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chalk } from 'chalk';
import {
  INTRO_MS,
  OUTRO_MS,
  introFrame,
  logoDimensions,
  logoPixels,
  outroFrame,
  renderLogo,
  silverColor,
  staticLogo,
  whiteColor,
  type LogoFrame,
  type LogoSize,
} from '../src/ui/logo.js';

const chalk = new Chalk({ level: 3 });
const out = process.stdout;
const FRAME_MS = 1000 / 40;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function columns(): number {
  return out.columns || 100;
}

function center(lines: string[], width: number): string[] {
  const pad = ' '.repeat(Math.max(0, Math.floor((columns() - width) / 2)));
  return lines.map((line) => pad + line);
}

/** Draws frames in place: each frame overwrites the previous one. */
async function play(
  size: LogoSize,
  durationMs: number,
  frameAt: (ms: number) => LogoFrame,
  caption: string,
): Promise<void> {
  const { columns: width, rows } = logoDimensions(size);
  const height = rows + 2;
  out.write('\n'.repeat(height));
  const start = Date.now();
  for (;;) {
    const elapsed = Date.now() - start;
    const lines = center(renderLogo(frameAt(Math.min(elapsed, durationMs)), size, chalk), width);
    lines.push('', center([chalk.rgb(110, 110, 110)(caption)], caption.length)[0] ?? '');
    out.write(`\u001B[${height}A\r` + lines.map((l) => `\u001B[2K${l}`).join('\n') + '\n');
    if (elapsed >= durationMs) break;
    await sleep(FRAME_MS);
  }
}

function gallery(): void {
  const label = (text: string) => chalk.rgb(110, 110, 110)(text);
  const show = (title: string, lines: string[], width: number) => {
    out.write('\n' + center([label(title)], title.length).join('\n') + '\n\n');
    out.write(center(lines, width).join('\n') + '\n');
  };
  const small = logoDimensions('small');
  const large = logoDimensions('large');
  show('A · small, silver', staticLogo('small', silverColor, chalk), small.columns);
  show('B · small, pure white', staticLogo('small', whiteColor, chalk), small.columns);
  if (columns() >= large.columns + 4) {
    show('C · large, silver', staticLogo('large', silverColor, chalk), large.columns);
  }
  const line = [
    '      ╷         ╷',
    '┌──╮ ╶┼─  ╭──  ├──╮',
    '│  │  │   │    │  │',
    '├──╯  ╰─  ╰──  ╵  ╵',
    '╵',
  ].map((l) => chalk.rgb(255, 255, 255)(l));
  show('D · thin line', line, 19);
  out.write('\n');
}

/** The wordmark as an SVG: one rectangle per run of lit pixels, filled with a vertical gradient. */
function logoSvg(top: string, bottom: string): string {
  const pixels = logoPixels();
  const unit = 10;
  const width = pixels[0]!.length * unit;
  const height = pixels.length * unit;
  const rects: string[] = [];
  pixels.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x++;
      rects.push(
        `<rect x="${start * unit}" y="${y * unit}" width="${(x - start) * unit}" height="${unit}"/>`,
      );
    }
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="ptch">`,
    `<title>ptch</title>`,
    `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${height}">`,
    `<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>`,
    `</linearGradient></defs>`,
    `<g fill="url(#g)" shape-rendering="crispEdges">`,
    ...rects,
    `</g>`,
    `</svg>`,
    '',
  ].join('\n');
}

/** Writes the README logo: white for dark backgrounds, near-black for light ones. */
function writeLogoSvgs(): void {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'images');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'logo-dark.svg'), logoSvg('#ffffff', '#9ea2aa'));
  writeFileSync(join(dir, 'logo-light.svg'), logoSvg('#1f2328', '#59636e'));
  console.log(`Wrote logo-dark.svg and logo-light.svg to ${dir}`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--svg')) {
    writeLogoSvgs();
    return;
  }
  const loop = process.argv.includes('--loop');
  out.write('\u001B[?25l');
  const restore = () => out.write('\u001B[?25h');
  process.on('exit', restore);
  process.on('SIGINT', () => process.exit(130));

  out.write('\n'.repeat(out.rows || 30) + '\u001B[H\n\n');
  do {
    await play('small', INTRO_MS, (ms) => introFrame(ms), 'intro');
    await sleep(1_200);
    out.write(`\u001B[${logoDimensions('small').rows + 2}A`);
    await play('small', OUTRO_MS, (ms) => outroFrame(ms), 'after the first message');
    await sleep(500);
    if (columns() >= logoDimensions('large').columns + 4) {
      await play('large', INTRO_MS, (ms) => introFrame(ms), 'large, for big windows');
      await sleep(1_200);
    }
    if (loop) out.write('\u001B[H\u001B[2J\n\n');
  } while (loop);
  gallery();
}

await main();
