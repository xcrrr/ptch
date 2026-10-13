import { Chalk } from 'chalk';
import { Box, Text } from 'ink';
import { logoDimensions, renderLogo, type LogoFrame } from '../logo.js';

const chalk = new Chalk();
const CAPTION_GREY = 118;
/** Near-black, what the caption fades from and to (like the wordmark's pixels). */
const CAPTION_DARK = 22;

/** Rows the logo block takes: the wordmark, a blank line and the caption. */
export const SPLASH_LOGO_ROWS = logoDimensions('small').rows + 2;

export interface SplashLogoProps {
  frame: LogoFrame;
  /** Small dim line under the wordmark (the version). */
  caption: string;
  /** Caption brightness, 0 (hidden) to 1. */
  captionLevel: number;
}

/** The startup wordmark: one frame of its animation, with a caption below. */
export function SplashLogo({ frame, caption, captionLevel }: SplashLogoProps) {
  const { columns } = logoDimensions('small');
  const lines = renderLogo(frame, 'small', chalk);
  const level = Math.min(1, Math.max(0, captionLevel));
  const grey = Math.round(CAPTION_DARK + (CAPTION_GREY - CAPTION_DARK) * level);
  const captionText =
    level < 0.05 ? ' ' : chalk.level > 0 ? chalk.rgb(grey, grey, grey)(caption) : caption;
  return (
    <Box flexDirection="column" alignItems="center" flexShrink={0}>
      <Box flexDirection="column" width={columns}>
        {lines.map((line, i) => (
          <Text key={i}>{line === '' ? ' ' : line}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text>{captionText}</Text>
      </Box>
    </Box>
  );
}
