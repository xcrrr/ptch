import type { SessionSummary } from '@patch/core';
import { relativeTime, shortId } from '@patch/shared';
import { Box, Text } from 'ink';
import { glyphs, INDENT, theme } from '../theme.js';
import { displayWidth, padEndToWidth, toDisplayText, truncateToWidth } from '../text-layout.js';
import type { SessionPickerProps } from './props.js';
import { useListNavigation } from './Select.js';

const MAX_VISIBLE = 10;
const ID_WIDTH = 6;
const POINTER_WIDTH = 2;
const GAP = '  ';
const MIN_TITLE_WIDTH = 12;
const MISSING = ' (missing)';

/**
 * Session list for --resume and /resume:
 *   Resume a session
 *   ~/code/project
 *
 *   › 82af31  Fix the failing auth test          2h ago · main · 24 msgs
 */
export function SessionPicker({
  sessions,
  onSelect,
  onCancel,
  width,
  projectLabel,
  maxVisible = MAX_VISIBLE,
}: SessionPickerProps) {
  const { index, start, end } = useListNavigation({
    count: sessions.length,
    maxVisible,
    onCancel,
    onSubmit: (selected) => {
      const session = sessions[selected];
      if (session) onSelect(session.id);
    },
  });
  const now = new Date();
  const metas = sessions.map((session) => sessionMeta(session, now));
  const metaWidth = Math.max(0, ...metas.map(displayWidth));
  const fixed = INDENT + POINTER_WIDTH + ID_WIDTH + GAP.length * 2 + metaWidth + 1;
  const longestTitle = Math.max(0, ...sessions.map((session) => displayWidth(titleOf(session))));
  const titleWidth = Math.max(MIN_TITLE_WIDTH, Math.min(longestTitle, width - fixed));

  return (
    <Box flexDirection="column" paddingLeft={INDENT}>
      <Text bold>Resume a session</Text>
      <Text dimColor wrap="truncate-middle">
        {toDisplayText(projectLabel)}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {sessions.length === 0 && <Text>No previous sessions for this project.</Text>}
        {start > 0 && <Text dimColor>{`  ↑ ${start} more`}</Text>}
        {sessions.slice(start, end).map((session, offset) => {
          const position = start + offset;
          const selected = position === index;
          const title = truncateToWidth(titleOf(session), titleWidth);
          return (
            <Text key={session.id} wrap="truncate-end">
              <Text color={theme.accent}>{selected ? `${glyphs.pointer} ` : '  '}</Text>
              <Text dimColor>{padEndToWidth(shortId(session.id), ID_WIDTH)}</Text>
              {GAP}
              <Text
                color={selected && session.projectExists ? theme.accent : undefined}
                dimColor={!session.projectExists}
              >
                {padEndToWidth(title, titleWidth)}
              </Text>
              <Text dimColor>{GAP + metas[position]}</Text>
            </Text>
          );
        })}
        {end < sessions.length && <Text dimColor>{`  ↓ ${sessions.length - end} more`}</Text>}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {sessions.length > 0 ? `enter resume ${glyphs.dot} esc cancel` : 'esc cancel'}
        </Text>
      </Box>
    </Box>
  );
}

/** Rows around the list: title, project, a blank line, both scroll indicators, a blank line, hint. */
const CHROME_ROWS = 7;

/**
 * Most terminal rows a SessionPicker takes: title, project, a blank line, the list (with its
 * scroll indicators) or the empty message, a blank line and the hint.
 */
export function sessionPickerHeight(count: number, maxVisible = MAX_VISIBLE): number {
  const visible = Math.max(1, maxVisible);
  const list = count === 0 ? 1 : count > visible ? visible + 2 : count;
  return 2 + 1 + list + 1 + 1;
}

/**
 * The `maxVisible` that keeps a SessionPicker within `rows` terminal rows (at least one session,
 * at most `max`).
 */
export function sessionPickerMaxVisible(rows: number, max = MAX_VISIBLE): number {
  return Math.min(max, Math.max(1, rows - CHROME_ROWS));
}

function titleOf(session: SessionSummary): string {
  return toDisplayText(session.title).replace(/\s+/g, ' ').trim() || '(untitled)';
}

function sessionMeta(session: SessionSummary, now: Date): string {
  const messages = `${session.messageCount} ${session.messageCount === 1 ? 'msg' : 'msgs'}`;
  const parts = [relativeTime(session.updatedAt, now), session.branch, messages].filter(Boolean);
  return parts.join(` ${glyphs.dot} `) + (session.projectExists ? '' : MISSING);
}
