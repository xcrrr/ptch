import { plural } from '@patch/shared';
import { Box, Text } from 'ink';
import { glyphs, INDENT, theme } from '../theme.js';
import {
  displayWidth,
  padEndToWidth,
  toDisplayText,
  truncateToWidth,
  wrapAtWhitespace,
} from '../text-layout.js';
import type {
  McpApprovalChoice,
  McpApprovalPromptProps,
  McpApprovalRequest,
  SelectOption,
} from './props.js';
import { Select } from './Select.js';

/** Server rows sit two columns in from the title. */
const BODY_INDENT = 2;
const NAME_GAP = 2;
/** Longest name column; longer names are cut. */
const MAX_NAME_WIDTH = 24;
const MAX_REASON_ROWS = 2;

const REASON =
  'MCP servers run with your privileges and receive what Patch sends them. Start only servers you trust; Patch asks before each tool call.';

const OPTIONS: ReadonlyArray<SelectOption<McpApprovalChoice>> = [
  { label: 'Yes', value: 'yes' },
  { label: 'Yes, and remember for this project', value: 'remember' },
  { label: 'No', value: 'no' },
];

export interface McpApprovalLayout {
  title: string;
  /** Server rows shown, each cut to the width. */
  rows: string[];
  /** Servers left out ("… N more servers"). */
  hidden: number;
  reason: string[];
  /** Terminal rows the prompt takes. */
  height: number;
}

/** What the prompt shows within `maxRows`: every row is cut to the width, so the height is exact. */
export function layoutMcpApproval(
  request: McpApprovalRequest,
  width: number,
  maxRows = Number.POSITIVE_INFINITY,
): McpApprovalLayout {
  const contentWidth = Math.max(1, width - INDENT);
  const bodyWidth = Math.max(1, contentWidth - BODY_INDENT);
  const count = request.servers.length;
  const title = truncateToWidth(
    `This project's .mcp.json wants to start ${count === 1 ? 'an MCP server' : `${count} MCP servers`}`,
    contentWidth,
  );
  const wrapped = wrapAtWhitespace(REASON, contentWidth);
  const reason = wrapped.slice(0, MAX_REASON_ROWS);
  if (wrapped.length > MAX_REASON_ROWS) {
    const rest = wrapped.slice(MAX_REASON_ROWS - 1).join(' ');
    reason[MAX_REASON_ROWS - 1] = truncateToWidth(rest, contentWidth);
  }
  // Title, blank line, reason, blank line, options, hint.
  const fixed = 1 + 1 + reason.length + 1 + OPTIONS.length + 1;
  const room = Math.max(1, maxRows - fixed);
  const nameWidth = Math.min(
    MAX_NAME_WIDTH,
    Math.max(0, ...request.servers.map((server) => displayWidth(server.name))),
  );
  // A long command line keeps its start (the program) and its end (the script or package).
  const targetWidth = Math.max(1, bodyWidth - nameWidth - NAME_GAP);
  const all = request.servers.map((server) =>
    truncateToWidth(
      padEndToWidth(truncateToWidth(toDisplayText(server.name), nameWidth), nameWidth) +
        ' '.repeat(NAME_GAP) +
        truncateToWidth(toDisplayText(server.target).replace(/\n/g, ' '), targetWidth, 'middle'),
      bodyWidth,
    ),
  );
  // One row says how many servers are left out.
  const shown = all.length <= room ? all.length : Math.max(1, room - 1);
  const rows = all.slice(0, shown);
  const hidden = all.length - rows.length;
  return {
    title,
    rows,
    hidden,
    reason,
    height: fixed + rows.length + (hidden > 0 ? 1 : 0),
  };
}

export function McpApprovalPrompt({
  request,
  onRespond,
  width,
  maxRows,
  isActive = true,
}: McpApprovalPromptProps) {
  const layout = layoutMcpApproval(request, width, maxRows);
  const pad = ' '.repeat(BODY_INDENT);
  return (
    <Box flexDirection="column" paddingLeft={INDENT} width={width}>
      <Text bold color={theme.warning} wrap="truncate-end">
        {layout.title}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {layout.rows.map((row, i) => (
          <Text key={`server-${i}`} wrap="truncate-end">
            {pad + row}
          </Text>
        ))}
        {layout.hidden > 0 && (
          <Text dimColor wrap="truncate-end">
            {`${pad}${glyphs.ellipsis} ${plural(layout.hidden, 'more server')}`}
          </Text>
        )}
      </Box>
      {layout.reason.map((row, i) => (
        <Text key={`reason-${i}`} dimColor wrap="truncate-end">
          {row}
        </Text>
      ))}
      <Box marginTop={1}>
        <Select
          options={OPTIONS}
          onSelect={onRespond}
          onCancel={() => onRespond('no')}
          isActive={isActive}
          numbered
        />
      </Box>
      <Text dimColor wrap="truncate-end">
        {['enter confirm', 'esc decline'].join(` ${glyphs.dot} `)}
      </Text>
    </Box>
  );
}
