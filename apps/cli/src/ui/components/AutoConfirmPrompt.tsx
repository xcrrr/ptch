import { Box, Text } from 'ink';
import { glyphs, INDENT, theme } from '../theme.js';
import { truncateToWidth, wrapAtWhitespace } from '../text-layout.js';
import type { AutoConfirmPromptProps, SelectOption } from './props.js';
import { Select } from './Select.js';

const TITLE = 'Auto mode runs edits and commands without asking.';
const BODY = 'Destructive commands and secret files still ask. Turn it on?';
const HINT = ['enter confirm', 'esc cancel'].join(` ${glyphs.dot} `);

const OPTIONS: ReadonlyArray<SelectOption<boolean>> = [
  { label: 'Yes', value: true, tone: 'danger' },
  { label: 'No', value: false },
];

/** What the confirmation shows: its wrapped title and body, and the rows it takes. */
export function layoutAutoConfirm(width: number): {
  title: string[];
  body: string[];
  height: number;
} {
  const contentWidth = Math.max(1, width - INDENT);
  const title = wrapAtWhitespace(TITLE, contentWidth);
  const body = wrapAtWhitespace(BODY, contentWidth);
  // The text, a blank line, the options and the hint.
  return { title, body, height: title.length + body.length + 1 + OPTIONS.length + 1 };
}

/**
 * The one-time confirmation before auto mode first turns on in a session:
 *   Auto mode runs edits and commands without asking.        (bold, theme.autoMode)
 *   Destructive commands and secret files still ask. Turn it on?
 *
 *   › 1. Yes
 *     2. No
 *   enter confirm · esc cancel
 * Esc answers No.
 */
export function AutoConfirmPrompt({ onRespond, width, isActive = true }: AutoConfirmPromptProps) {
  const { title, body } = layoutAutoConfirm(width);
  const contentWidth = Math.max(1, width - INDENT);
  return (
    <Box flexDirection="column" paddingLeft={INDENT} width={width}>
      {title.map((row, i) => (
        <Text key={`title-${i}`} bold color={theme.autoMode} wrap="truncate-end">
          {row}
        </Text>
      ))}
      {body.map((row, i) => (
        <Text key={`body-${i}`} wrap="truncate-end">
          {row}
        </Text>
      ))}
      <Box marginTop={1}>
        <Select
          options={OPTIONS}
          onSelect={onRespond}
          onCancel={() => onRespond(false)}
          isActive={isActive}
          numbered
        />
      </Box>
      <Text dimColor wrap="truncate-end">
        {truncateToWidth(HINT, contentWidth)}
      </Text>
    </Box>
  );
}
