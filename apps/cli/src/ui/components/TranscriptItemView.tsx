import { formatDuration, plural, splitLines, truncateMiddle } from '@patch/shared';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { renderMarkdown } from '../markdown.js';
import { glyphs, INDENT, theme } from '../theme.js';
import type { HelpSection, StatusRow, TranscriptItem } from '../transcript.js';
import { displayWidth, padEndToWidth, toDisplayText } from '../text-layout.js';
import { DiffView } from './DiffView.js';
import { GitDiffView } from './GitDiffView.js';
import { PlanFrame, renderPlanRows } from './PlanPrompt.js';
import type { TranscriptItemViewProps } from './props.js';
import { ToolRow } from './ToolRow.js';
import { Welcome } from './Welcome.js';

const SHELL_OUTPUT_LINES = 30;
const SHELL_LINE_CHARS = 1000;
const DETAIL_MAX_LINES = 400;
const COMPACTION_SUMMARY_LINES = 6;
const COLUMN_GAP = 2;

type ItemOf<K extends TranscriptItem['kind']> = Extract<TranscriptItem, { kind: K }>;

/** Renders any committed transcript item (see transcript.ts for per-kind layout rules). */
export function TranscriptItemView({ item, width, welcomeTitle = true }: TranscriptItemViewProps) {
  switch (item.kind) {
    case 'welcome':
      return <Welcome info={item.info} showTitle={welcomeTitle} />;
    case 'user':
      return (
        <UserMessage text={item.text} source={item.source} images={item.images} width={width} />
      );
    case 'assistant':
      return (
        <Block width={width}>
          <Text>{renderMarkdown(item.markdown, { width: width - INDENT })}</Text>
        </Block>
      );
    case 'progress':
      return (
        <Block width={width}>
          <Text dimColor>{toDisplayText(item.text)}</Text>
        </Block>
      );
    case 'tool':
      return (
        <Box marginTop={item.first ? 1 : 0} flexDirection="column">
          <ToolRow
            summary={item.summary}
            name={item.name}
            status={item.status}
            display={item.display}
            durationMs={item.durationMs}
            width={width}
          />
          {item.display?.plan && (
            <Box paddingLeft={INDENT}>
              <PlanFrame
                rows={renderPlanRows(item.display.plan, width - INDENT)}
                width={width - INDENT}
              />
            </Box>
          )}
        </Box>
      );
    case 'notice':
      return <Notice item={item} width={width} />;
    case 'shell':
      return <ShellResult item={item} width={width} />;
    case 'status':
      return <StatusTable item={item} width={width} />;
    case 'help':
      return <Help sections={item.sections} width={width} />;
    case 'git-diff':
      return (
        <Block width={width}>
          <Text dimColor>{toDisplayText(item.title)}</Text>
          <GitDiffView diff={item.diff} untracked={item.untracked} width={width - INDENT} />
        </Block>
      );
    case 'detail':
      return <Detail item={item} width={width} />;
    case 'divider':
      return <Divider label={item.label} width={width} />;
    case 'compaction':
      return <Compaction item={item} width={width} />;
  }
}

/** A transcript block: one blank line above, indented by INDENT. */
function Block({ width, children }: { width: number; children: ReactNode }) {
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={INDENT} width={width}>
      {children}
    </Box>
  );
}

function UserMessage({
  text,
  source,
  images = [],
  width,
}: {
  text: string;
  source?: string;
  images?: readonly string[];
  width: number;
}) {
  return (
    <Box marginTop={1} width={width} flexDirection="column">
      <Box>
        <Text color={theme.accent}>{`${glyphs.prompt} `}</Text>
        <Box width={Math.max(1, width - INDENT)}>
          <Text>{toDisplayText(text)}</Text>
        </Box>
      </Box>
      {source && (
        <Box paddingLeft={INDENT}>
          <Text dimColor wrap="truncate-middle">
            {toDisplayText(source)}
          </Text>
        </Box>
      )}
      {images.map((line, i) => (
        <Box key={i} paddingLeft={INDENT}>
          <Text dimColor wrap="truncate-end">
            {toDisplayText(line).replace(/\n/g, ' ')}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function Notice({ item, width }: { item: ItemOf<'notice'>; width: number }) {
  const text = toDisplayText(item.text);
  const marker =
    item.level === 'error'
      ? { glyph: `${glyphs.cross} `, color: theme.danger }
      : item.level === 'warn'
        ? { glyph: '! ', color: theme.warning }
        : null;
  return (
    <Block width={width}>
      {marker ? (
        <Box>
          <Text color={marker.color}>{marker.glyph}</Text>
          <Box width={Math.max(1, width - INDENT - marker.glyph.length)}>
            <Text>{text}</Text>
          </Box>
        </Box>
      ) : (
        <Text dimColor>{text}</Text>
      )}
      {item.hint && (
        <Box paddingLeft={INDENT}>
          <Text dimColor>{toDisplayText(item.hint)}</Text>
        </Box>
      )}
    </Block>
  );
}

function ShellResult({ item, width }: { item: ItemOf<'shell'>; width: number }) {
  const output = truncateMiddle(toDisplayText(item.output), {
    maxLines: SHELL_OUTPUT_LINES,
    maxLineChars: SHELL_LINE_CHARS,
  });
  const failed = item.exitCode !== 0;
  const status = item.exitCode === null ? 'terminated' : `exit ${item.exitCode}`;
  return (
    <Box flexDirection="column" marginTop={1} width={width}>
      <Box>
        <Text color={theme.warning}>! </Text>
        <Box width={Math.max(1, width - INDENT)}>
          <Text>{toDisplayText(item.command)}</Text>
        </Box>
      </Box>
      {output.text !== '' && (
        <Box paddingLeft={INDENT} width={width}>
          <Text dimColor>{output.text}</Text>
        </Box>
      )}
      {failed && (
        <Box paddingLeft={INDENT}>
          <Text dimColor>{`${status} ${glyphs.dot} ${formatDuration(item.durationMs)}`}</Text>
        </Box>
      )}
    </Box>
  );
}

function StatusTable({ item, width }: { item: ItemOf<'status'>; width: number }) {
  const labelWidth = Math.max(0, ...item.rows.map((row) => displayWidth(row.label)));
  return (
    <Block width={width}>
      {item.title && <Text bold>{toDisplayText(item.title)}</Text>}
      {item.rows.map((row, i) => (
        <StatusRowView key={i} row={row} labelWidth={labelWidth} />
      ))}
    </Block>
  );
}

function StatusRowView({ row, labelWidth }: { row: StatusRow; labelWidth: number }) {
  return (
    <Text>
      <Text dimColor>{padEndToWidth(row.label, labelWidth + COLUMN_GAP)}</Text>
      {toDisplayText(row.value)}
      {row.detail && <Text dimColor>{`  ${toDisplayText(row.detail)}`}</Text>}
    </Text>
  );
}

function Help({ sections, width }: { sections: readonly HelpSection[]; width: number }) {
  const keyWidth = Math.max(
    0,
    ...sections.flatMap((section) => section.rows.map((row) => displayWidth(row.key))),
  );
  return (
    <Block width={width}>
      {sections.map((section, s) => (
        <Box key={s} flexDirection="column" marginTop={s > 0 ? 1 : 0}>
          <Text bold>{section.title}</Text>
          {section.rows.map((row, r) => (
            <Text key={r}>
              {padEndToWidth(row.key, keyWidth + COLUMN_GAP)}
              <Text dimColor>{row.description}</Text>
            </Text>
          ))}
        </Box>
      ))}
    </Block>
  );
}

function Detail({ item, width }: { item: ItemOf<'detail'>; width: number }) {
  const lines = splitLines(toDisplayText(item.text));
  const shown = lines.slice(0, DETAIL_MAX_LINES);
  return (
    <Block width={width}>
      <Text dimColor>{toDisplayText(item.title)}</Text>
      {item.diff ? (
        <DiffView diff={item.diff} maxLines={DETAIL_MAX_LINES} width={width - INDENT} indent={0} />
      ) : (
        <>
          {shown.length > 0 && <Text>{shown.join('\n')}</Text>}
          {lines.length > shown.length && (
            <Text dimColor>
              {`${glyphs.ellipsis} ${plural(lines.length - shown.length, 'more line')}`}
            </Text>
          )}
        </>
      )}
    </Block>
  );
}

function Divider({ label, width }: { label: string; width: number }) {
  const available = Math.max(0, width - INDENT - 1);
  const head = label ? `${glyphs.rule.repeat(2)} ${toDisplayText(label)} ` : '';
  const fill = Math.max(0, available - displayWidth(head));
  return (
    <Block width={width}>
      <Text dimColor wrap="truncate-end">
        {head + glyphs.rule.repeat(fill)}
      </Text>
    </Block>
  );
}

function Compaction({ item, width }: { item: ItemOf<'compaction'>; width: number }) {
  const lines = splitLines(toDisplayText(item.summary)).filter((line) => line.trim() !== '');
  const shown = lines.slice(0, COMPACTION_SUMMARY_LINES);
  const heading = [
    'Conversation compacted',
    `${plural(item.messagesCompacted, 'message')} summarized`,
    ...(item.auto ? ['automatic'] : []),
  ].join(` ${glyphs.dot} `);
  return (
    <Block width={width}>
      <Text dimColor>{heading}</Text>
      {shown.length > 0 && (
        <Box paddingLeft={INDENT} flexDirection="column">
          <Text dimColor>{shown.join('\n')}</Text>
          {lines.length > shown.length && <Text dimColor>{glyphs.ellipsis}</Text>}
        </Box>
      )}
    </Block>
  );
}
