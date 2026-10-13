import type { FileDiff } from '@patch/core';
import { formatDuration, plural } from '@patch/shared';
import { Box, Text } from 'ink';
import { Fragment } from 'react';
import { glyphs, INDENT, theme, VERB_WIDTH } from '../theme.js';
import { displayWidth, padEndToWidth, toDisplayText, truncateToWidth } from '../text-layout.js';
import { DiffView, measureDiffView } from './DiffView.js';
import type { ToolRowProps, ToolRowStatus } from './props.js';

/** Column where targets, second-line summaries and detail lines start. */
const TARGET_COLUMN = INDENT + VERB_WIDTH;
const MAX_DISPLAY_LINES = 4;
const MAX_PROGRESS_LINES = 5;
const MAX_DIFF_LINES = 8;
const MIN_TARGET_WIDTH = 8;
/** Durations below this are noise in a transcript. */
const MIN_SHOWN_DURATION_MS = 1000;
const SEPARATOR = ` ${glyphs.dot} `;
/** A summary that already ends with a duration ("4 passed · 1.2s", "exit 1 · 2m 05s"). */
const ENDS_WITH_DURATION = /(?:^|\s)(?:\d+ms|\d+(?:\.\d)?s|\d+m \d{2}s|\d+h \d{2}m)$/;
const STATS_GAP = '  ';
/** Space between a target and its dim detail (e.g. a command's description). */
const DETAIL_GAP = '  ';
/** Hosted web tools: their outcome goes on the second line, as a command's does. */
const HOSTED_TOOL_NAMES = new Set(['web_search', 'web_fetch']);
/** MCP tool calls (verb "mcp") put their outcome on the second line too. */
const MCP_VERB = 'mcp';

interface Segment {
  text: string;
  color?: string;
  dim?: boolean;
}

/**
 * One tool call:
 *   "  read    src/auth/session.ts · 120 lines"
 *   "  edit    src/auth/session.ts  +18 -6"   (+ compact DiffView below)
 *   "  bash    pnpm test"
 *   "          42 passed · 1 failed · 8.1s"
 *   "  search  vitest 4 release notes"
 *   "          8 results"
 *   "  mcp     github · create_issue  title: "Fix login""
 *   "          3 lines"
 * Commands, web searches and fetches, and MCP tool calls always put their outcome on the second
 * line; other tools do when the row is too long.
 */
export function ToolRow(props: ToolRowProps) {
  const { summary, status, display, width, spinnerFrame } = props;
  const {
    isCommand,
    detail,
    stats,
    outcome,
    outcomeInline,
    rawTarget,
    fixedWidth,
    outcomeWidth,
    tail,
  } = layoutToolRow(props);
  const targetBudget = Math.max(
    MIN_TARGET_WIDTH,
    width - TARGET_COLUMN - fixedWidth - (outcomeInline ? outcomeWidth : 0),
  );
  const target = truncateToWidth(rawTarget, targetBudget, isCommand ? 'end' : 'middle');

  const active = (status === 'running' || status === 'waiting') && spinnerFrame !== undefined;
  const verb = padEndToWidth(truncateToWidth(summary.verb, VERB_WIDTH - 1), VERB_WIDTH);
  const pad = ' '.repeat(TARGET_COLUMN);
  const lineWidth = Math.max(1, width - TARGET_COLUMN);

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        {active ? (
          <Text color={status === 'waiting' ? theme.warning : theme.accent}>
            {padEndToWidth(spinnerFrame, INDENT)}
          </Text>
        ) : (
          ' '.repeat(INDENT)
        )}
        <Text color={status === 'error' ? theme.danger : undefined} dimColor={status !== 'error'}>
          {verb}
        </Text>
        {target}
        {detail && <Text dimColor>{detail}</Text>}
        {stats.length > 0 && STATS_GAP}
        <Segments segments={stats} separator=" " />
        {outcomeInline && outcome && (
          <>
            <Text dimColor>{SEPARATOR}</Text>
            <Segments segments={[outcome]} />
          </>
        )}
      </Text>
      {outcome && !outcomeInline && (
        <Text wrap="truncate-end">
          {pad}
          <Segments segments={[outcome]} />
        </Text>
      )}
      {display?.diff && (
        <DiffView
          diff={display.diff}
          maxLines={MAX_DIFF_LINES}
          width={width}
          indent={TARGET_COLUMN}
          overflow="truncate"
        />
      )}
      {limitLines(display?.lines ?? []).map((line, i) => (
        <Text key={`line-${i}`} dimColor wrap="truncate-end">
          {pad + truncateToWidth(line, lineWidth)}
        </Text>
      ))}
      {tail.map((line, i) => (
        <Text key={`tail-${i}`} dimColor wrap="truncate-end">
          {pad + truncateToWidth(oneLine(line), lineWidth)}
        </Text>
      ))}
    </Box>
  );
}

function layoutToolRow({
  summary,
  name,
  status,
  display,
  progress,
  durationMs,
  width,
}: ToolRowProps) {
  const isCommand = summary.verb === 'bash' || name === 'bash';
  const hasDiff = display?.diff !== undefined;
  // A diff row says everything with its +/- stats; size details and summaries would repeat it.
  const detail = summary.detail && !hasDiff ? `${DETAIL_GAP}${oneLine(summary.detail)}` : '';
  const stats = display?.diff ? diffStats(display.diff) : [];
  const outcome = outcomeOf(
    status,
    hasDiff && status === 'done' ? undefined : display?.summary,
    durationMs,
  );
  const rawTarget = commandTarget(summary.target);
  const fixedWidth = displayWidth(detail) + segmentsWidth(stats, STATS_GAP);
  const outcomeWidth = outcome ? displayWidth(SEPARATOR + outcome.text) : 0;
  const outcomeInline =
    outcome !== null &&
    !isCommand &&
    !HOSTED_TOOL_NAMES.has(name) &&
    summary.verb !== MCP_VERB &&
    TARGET_COLUMN + displayWidth(rawTarget) + fixedWidth + outcomeWidth <= width;
  const tail = status === 'running' ? (progress?.tail ?? []).slice(-MAX_PROGRESS_LINES) : [];
  return {
    isCommand,
    detail,
    stats,
    outcome,
    outcomeInline,
    rawTarget,
    fixedWidth,
    outcomeWidth,
    tail,
  };
}

/** Terminal rows a ToolRow takes (every row is truncated to the width, never wrapped). */
export function toolRowHeight(props: ToolRowProps): number {
  const { outcome, outcomeInline, tail } = layoutToolRow(props);
  const diff = props.display?.diff;
  return (
    1 +
    (outcome && !outcomeInline ? 1 : 0) +
    (diff
      ? measureDiffView(diff, {
          maxLines: MAX_DIFF_LINES,
          width: props.width,
          indent: TARGET_COLUMN,
          overflow: 'truncate',
        }).height
      : 0) +
    limitLines(props.display?.lines ?? []).length +
    tail.length
  );
}

function Segments({ segments, separator = '' }: { segments: Segment[]; separator?: string }) {
  return (
    <>
      {segments.map((segment, i) => (
        <Fragment key={i}>
          {i > 0 && separator}
          <Text color={segment.color} dimColor={segment.dim}>
            {segment.text}
          </Text>
        </Fragment>
      ))}
    </>
  );
}

function segmentsWidth(segments: readonly Segment[], gap: string): number {
  if (segments.length === 0) return 0;
  const text = segments.map((segment) => segment.text).join(' ');
  return displayWidth(gap + text);
}

/** "+18 -6"; new files show only their additions, empty changes show "+0". */
function diffStats(diff: FileDiff): Segment[] {
  const stats: Segment[] = [];
  if (diff.added > 0 || diff.removed === 0)
    stats.push({ text: `+${diff.added}`, color: theme.added });
  if (diff.removed > 0 && !diff.isNew)
    stats.push({ text: `-${diff.removed}`, color: theme.removed });
  return stats;
}

function outcomeOf(
  status: ToolRowStatus,
  summary: string | undefined,
  durationMs: number | undefined,
): Segment | null {
  switch (status) {
    case 'running':
    case 'waiting':
      return null;
    case 'denied':
      return { text: 'declined', color: theme.warning };
    case 'interrupted':
      return { text: 'interrupted', dim: true };
    case 'error':
      return { text: summary ? oneLine(summary) : 'failed', color: theme.danger };
    case 'done': {
      const parts = summary ? [oneLine(summary)] : [];
      const timed = parts.length > 0 && ENDS_WITH_DURATION.test(parts[0] ?? '');
      if (!timed && durationMs !== undefined && durationMs >= MIN_SHOWN_DURATION_MS) {
        parts.push(formatDuration(durationMs));
      }
      return parts.length > 0 ? { text: parts.join(SEPARATOR), dim: true } : null;
    }
  }
}

/** At most MAX_DISPLAY_LINES rows, the last one counting the lines left out. */
function limitLines(lines: readonly string[]): string[] {
  const clean = lines.map((line) => oneLine(line).trimStart()).filter(Boolean);
  if (clean.length <= MAX_DISPLAY_LINES) return clean;
  const kept = clean.slice(0, MAX_DISPLAY_LINES - 1);
  return [...kept, `${glyphs.ellipsis} ${plural(clean.length - kept.length, 'more line')}`];
}

/** Multi-line commands (heredocs, scripts) are summarized by their first line. */
function commandTarget(target: string): string {
  const lines = toDisplayText(target).split('\n');
  const first = lines[0]?.trimEnd() ?? '';
  return lines.length > 1 ? `${first} ${glyphs.ellipsis}` : first;
}

function oneLine(text: string): string {
  return toDisplayText(text)
    .replace(/\s*\n\s*/g, ' ')
    .trimEnd();
}
