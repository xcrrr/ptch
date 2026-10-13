import { plural, splitLines } from '@patch/shared';
import { Box, Text } from 'ink';
import { glyphs, theme } from '../theme.js';
import { toDisplayText } from '../text-layout.js';
import type { GitDiffViewProps } from './props.js';

const DEFAULT_MAX_LINES = 400;
const MAX_UNTRACKED_LISTED = 20;
const HUNK_HEADER_COLOR = 'cyan';

/**
 * Colored `git diff` text: "diff --git"/"+++"/"---" headers bold, "@@" lines cyan, additions green,
 * deletions red, rest default. Truncates after `maxLines` with "… N more lines (run git diff for
 * the full output)". Untracked files listed after the diff ("Untracked: a.ts, b.ts").
 */
export function GitDiffView({
  diff,
  untracked,
  maxLines = DEFAULT_MAX_LINES,
  width,
}: GitDiffViewProps) {
  const lines = splitLines(toDisplayText(diff));
  const shown = lines.slice(0, Math.max(0, maxLines));
  const hidden = lines.length - shown.length;
  if (lines.length === 0 && untracked.length === 0) {
    return <Text dimColor>No changes.</Text>;
  }
  return (
    <Box flexDirection="column" width={width}>
      {shown.map((line, i) => (
        <DiffLine key={i} line={line} />
      ))}
      {hidden > 0 && (
        <Text dimColor>
          {glyphs.ellipsis} {plural(hidden, 'more line')} (run git diff for the full output)
        </Text>
      )}
      {untracked.length > 0 && (
        <Box marginTop={shown.length > 0 ? 1 : 0}>
          <Text>
            <Text dimColor>Untracked: </Text>
            {untrackedList(untracked)}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function DiffLine({ line }: { line: string }) {
  if (line.startsWith('diff --git') || line.startsWith('+++') || line.startsWith('---')) {
    return <Text bold>{line}</Text>;
  }
  if (line.startsWith('@@')) return <Text color={HUNK_HEADER_COLOR}>{line}</Text>;
  if (line.startsWith('+')) return <Text color={theme.added}>{line}</Text>;
  if (line.startsWith('-')) return <Text color={theme.removed}>{line}</Text>;
  return <Text>{line === '' ? ' ' : line}</Text>;
}

function untrackedList(files: readonly string[]): string {
  const listed = files.slice(0, MAX_UNTRACKED_LISTED).join(', ');
  const rest = files.length - MAX_UNTRACKED_LISTED;
  return rest > 0 ? `${listed} and ${rest} more` : listed;
}
