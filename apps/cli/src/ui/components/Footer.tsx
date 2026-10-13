import { Box, Text } from 'ink';
import { glyphs, INDENT } from '../theme.js';
import { displayWidth, toDisplayText, truncateToWidth } from '../text-layout.js';
import type { FooterProps } from './props.js';

const MIN_GAP = 2;
const SEPARATOR = ` ${glyphs.dot} `;

/**
 * One dim line under the prompt: left-aligned hints, right-aligned status. The right side wins
 * when space is short; the line stops one column before the edge so it never soft-wraps. An
 * accent (the permission mode) leads the left side in its own color.
 */
export function Footer({ left, right, width, accent }: FooterProps) {
  const available = Math.max(0, width - INDENT - 1);
  const rightText = truncateToWidth(oneLineText(right), available);
  const leftBudget = available - displayWidth(rightText) - (rightText ? MIN_GAP : 0);
  const accentText =
    accent && leftBudget > 0 ? truncateToWidth(oneLineText(accent.text), leftBudget) : '';
  const hints = oneLineText(left);
  const restBudget = leftBudget - displayWidth(accentText);
  const rest =
    restBudget > 0 && hints
      ? truncateToWidth(accentText ? SEPARATOR + hints : hints, restBudget)
      : '';
  const leftWidth = displayWidth(accentText) + displayWidth(rest);
  const gap = Math.max(0, available - leftWidth - displayWidth(rightText));
  return (
    <Box paddingLeft={INDENT}>
      <Text wrap="truncate-end">
        {accentText && <Text color={accent?.color}>{accentText}</Text>}
        <Text dimColor>{rightText ? rest + ' '.repeat(gap) + rightText : rest}</Text>
      </Text>
    </Box>
  );
}

function oneLineText(text: string): string {
  return toDisplayText(text).replace(/\s*\n\s*/g, ' ');
}
