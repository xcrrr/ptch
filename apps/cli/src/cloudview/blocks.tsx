import { since } from './clean.js';
import { Box, Text } from 'ink';
import { Component, type ReactNode } from 'react';
import type { TaskRecord } from '@patch/cloud-protocol';
import { duration, money, taskRuntime } from '../cloud/format.js';
import { TranscriptItemView } from '../ui/components/TranscriptItemView.js';
import { renderMarkdown } from '../ui/markdown.js';
import { toDisplayText, truncateToWidth, wrapAtWhitespace } from '../ui/text-layout.js';
import { glyphs, INDENT, theme } from '../ui/theme.js';
import type { ProposalUi } from './controller.js';
import { statusMark } from './controller.js';
import {
  PROFILE_HELP,
  PROFILE_LABEL,
  summarizeRun,
  type Entry,
  type RunFacts,
  type RunTone,
  type ViewItem,
} from './model.js';

const SEP = ` ${glyphs.dot} `;
const DASH = '–';

const PROMPT_LINES = 8;

/** The first lines of a long text, with a note for the rest (the live area must fit the screen). */
function clampLines(text: string, max: number): string {
  const lines = text.split('\n');
  if (lines.length <= max) return text;
  return `${lines.slice(0, max).join('\n')}\n… ${lines.length - max} more lines`;
}

/** Wraps a line to the width, giving the continuation rows the indentation of the line. */
export function wrapKeepingIndent(line: string, width: number): string[] {
  const indent = /^ */.exec(line)?.[0] ?? '';
  const body = line.slice(indent.length);
  const room = Math.max(10, width - indent.length);
  return wrapAtWhitespace(body, room).map((row) => indent + row);
}

/** A block of the conversation: a blank line above, indented like the rest of Patch's output. */
function Block({ width, children }: { width: number; children: ReactNode }) {
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={INDENT} width={width}>
      {children}
    </Box>
  );
}

function toneColor(tone: RunTone): string | undefined {
  switch (tone) {
    case 'ok':
      return theme.added;
    case 'error':
      return theme.danger;
    case 'warn':
      return theme.warning;
    case 'active':
      return theme.accent;
    default:
      return undefined;
  }
}

/** "Owner · ptch.vercel.app": who and where. The worker and the project live in the footer. */
export function HeaderLine({
  entry,
  width,
}: {
  entry: Extract<Entry, { kind: 'header' }>;
  width: number;
}) {
  return (
    <Box paddingLeft={INDENT} width={width}>
      <Text dimColor wrap="truncate-end">
        {entry.account ? `${toDisplayText(entry.account)}${SEP}` : ''}
        {toDisplayText(hostLabel(entry.host))}
      </Text>
    </Box>
  );
}

export function hostLabel(host: string): string {
  try {
    return new URL(host).host;
  } catch {
    return host;
  }
}

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '--:--'
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Counts and spend at the moment of the answer. It says so, and never updates itself. */
function StatusBlockView({
  block,
  width,
  cloudVersion,
}: {
  block: Extract<ViewItem, { kind: 'status' }>['block'];
  width: number;
  /** The version of Patch Cloud itself (not of this CLI). */
  cloudVersion: string | null;
}) {
  return (
    <Block width={width}>
      <Text dimColor>
        {`${cloudVersion ? `Patch Cloud ${toDisplayText(cloudVersion)}${SEP}` : ''}snapshot as of ${clock(block.at)}`}
      </Text>
      <Text>
        <Text dimColor>{'Worker  '}</Text>
        <Text color={block.workerOnline ? undefined : theme.warning}>
          {block.workerOnline ? 'online' : 'offline'}
        </Text>
        {block.sandbox ? (
          <Text dimColor>{`${SEP}sandbox ${toDisplayText(block.sandbox)}`}</Text>
        ) : null}
      </Text>
      <Text>
        <Text dimColor>{'Runs    '}</Text>
        {`${block.running} running${SEP}${block.queued} queued`}
      </Text>
      <Text>
        <Text dimColor>{'Spent   '}</Text>
        {`${money(block.spentTodayUsd)} today${SEP}${money(block.spentMonthUsd)} this month`}
      </Text>
      {block.budgetBlocked ? (
        <Text color={theme.warning}>A spending limit is reached, so queued runs are waiting.</Text>
      ) : null}
    </Block>
  );
}

export interface RunCardProps {
  taskId: string;
  task: TaskRecord | undefined;
  missing: boolean;
  facts: RunFacts | 'pending' | undefined;
  projectName: string | null;
  width: number;
  spinnerFrame: string;
  now?: number;
}

/** A run in the conversation: the live record of the task, never a copy of what it said once. */
export function RunCard({
  taskId,
  task,
  missing,
  facts,
  projectName,
  width,
  spinnerFrame,
  now = Date.now(),
}: RunCardProps) {
  if (!task) {
    return (
      <Block width={width}>
        <Text dimColor wrap="truncate-end">
          {missing
            ? `This run no longer exists (${toDisplayText(taskId)}).`
            : `${spinnerFrame} Loading run ${toDisplayText(taskId)}…`}
        </Text>
      </Block>
    );
  }
  const summary = summarizeRun(task, facts === 'pending' ? undefined : facts);
  const color = toneColor(summary.tone);
  const active = summary.tone === 'active' || task.status === 'queued';
  const mark = summary.tone === 'active' ? spinnerFrame : statusMark(task.status);
  const runtime = taskRuntime(task, now);
  const meta = [
    summary.label,
    projectName && toDisplayText(projectName),
    runtime,
    task.costUsd > 0 ? money(task.costUsd) : null,
  ]
    .filter(Boolean)
    .join(SEP);
  const titleWidth = Math.max(10, width - INDENT - 2);
  return (
    <Block width={width}>
      <Text wrap="truncate-end">
        <Text color={color} dimColor={task.status === 'cancelled' || task.status === 'queued'}>
          {mark}
        </Text>{' '}
        <Text bold>
          {truncateToWidth(toDisplayText(task.title).replace(/\s+/g, ' '), titleWidth)}
        </Text>
      </Text>
      <Box paddingLeft={2} flexDirection="column">
        <Text wrap="truncate-end">
          <Text color={color} dimColor={!color}>
            {summary.label}
          </Text>
          <Text dimColor>{meta.slice(summary.label.length)}</Text>
        </Text>
        {!active || task.status !== 'queued' ? (
          <Text
            color={
              task.status === 'failed'
                ? theme.danger
                : task.status === 'interrupted'
                  ? theme.warning
                  : undefined
            }
            dimColor={task.status !== 'failed' && task.status !== 'interrupted'}
          >
            {toDisplayText(summary.outcome)}
          </Text>
        ) : (
          <Text dimColor>{summary.outcome}</Text>
        )}
      </Box>
    </Block>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <Text dimColor>{children}</Text>;
}

/**
 * The assistant offers to start a run. Nothing runs until it is confirmed; the prompt and the
 * permissions can be changed first; a refusal is shown exactly as the server wrote it.
 */
export function ProposalView({
  item,
  ui,
  width,
  keysActive = true,
  now = Date.now(),
}: {
  item: Extract<ViewItem, { kind: 'proposal' }>;
  ui: ProposalUi | null;
  width: number;
  /** The prompt is empty, so the keys of the proposal work (and are shown). */
  keysActive?: boolean;
  now?: number;
}) {
  const { block } = item;
  const firstLine = toDisplayText(block.prompt).split('\n')[0] ?? '';
  const titleWidth = Math.max(10, width - INDENT - 14);
  if (block.state === 'confirmed') {
    // One line: the run card (or the result) is where the status lives from here on.
    return (
      <Block width={width}>
        <Text wrap="truncate-end">
          <Text color={theme.added}>{glyphs.check}</Text> Started
          <Text dimColor>{`${SEP}${truncateToWidth(firstLine, titleWidth)}`}</Text>
        </Text>
      </Block>
    );
  }
  if (block.state === 'dismissed') {
    return (
      <Block width={width}>
        <Text dimColor wrap="truncate-end">
          {`${DASH} Dismissed. Nothing was started.`}
        </Text>
      </Block>
    );
  }
  if (block.state === 'failed') {
    return (
      <Block width={width}>
        <Text color={theme.danger}>
          {glyphs.cross} {toDisplayText(block.error ?? 'The run was not started.')}
        </Text>
        <Text dimColor wrap="truncate-end">
          {truncateToWidth(firstLine, width - INDENT)}
        </Text>
      </Block>
    );
  }
  if (!item.active || !ui) {
    return (
      <Block width={width}>
        <Text dimColor wrap="truncate-end">
          {`${DASH} Proposed run on ${toDisplayText(block.projectName)}, still pending. Nothing was started.`}
        </Text>
        <Text dimColor wrap="truncate-end">
          {truncateToWidth(firstLine, width - INDENT)}
        </Text>
      </Block>
    );
  }
  // The one place that says what is proposed and with which permissions: the profile shown is
  // the live one (it changes with `p`), and the age of the files is read once.
  const editing = ui.editing;
  return (
    <Block width={width}>
      <Text wrap="truncate-end">
        <Text dimColor>proposed run</Text>
        <Text bold>{`  ${toDisplayText(block.projectName)}`}</Text>
        <Text dimColor>
          {ui.snapshotAt
            ? `${SEP}files uploaded ${since(ui.snapshotAt, new Date(now))}`
            : `${SEP}latest files`}
        </Text>
      </Text>
      <Box marginTop={1}>
        <Text>{clampLines(toDisplayText(ui.prompt), PROMPT_LINES)}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text wrap="truncate-end">
          <Text dimColor>{'permissions  '}</Text>
          {PROFILE_LABEL[ui.profile]}
        </Text>
        <Hint>{PROFILE_HELP[ui.profile]}</Hint>
      </Box>
      {ui.error ? (
        <Box marginTop={1}>
          <Text color={theme.danger}>
            {glyphs.cross} {toDisplayText(ui.error)}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Hint>Nothing starts until you confirm.</Hint>
        {ui.busy ? (
          <Text dimColor>{ui.busy === 'start' ? 'Starting…' : 'Dismissing…'}</Text>
        ) : editing ? (
          <Text dimColor>Edit the prompt below · enter keeps it · esc cancels</Text>
        ) : keysActive ? (
          <Text dimColor wrap="wrap">
            enter or y start{SEP}e edit{SEP}p permissions{SEP}n or esc dismiss
          </Text>
        ) : null}
      </Box>
    </Block>
  );
}

function ChooseView({
  block,
  width,
}: {
  block: Extract<ViewItem, { kind: 'choose' }>['block'];
  width: number;
}) {
  return (
    <Block width={width}>
      <Text>{toDisplayText(block.reason)}</Text>
    </Block>
  );
}

function HelpView({
  block,
  width,
}: {
  block: Extract<ViewItem, { kind: 'help' }>['block'];
  width: number;
}) {
  return (
    <Block width={width}>
      {block.examples.slice(0, 6).map((example) => (
        <Text key={example} wrap="truncate-end">
          <Text dimColor>{`${glyphs.pointer} `}</Text>
          {toDisplayText(example)}
        </Text>
      ))}
    </Block>
  );
}

function UnsupportedView({
  block,
  width,
}: {
  block: Extract<ViewItem, { kind: 'unsupported' }>['block'];
  width: number;
}) {
  return (
    <Block width={width}>
      <Text dimColor>not available</Text>
      <Text>{toDisplayText(block.what)}</Text>
    </Block>
  );
}

function EntryView({
  entry,
  width,
}: {
  entry: Extract<ViewItem, { kind: 'entry' }>['entry'];
  width: number;
}) {
  switch (entry.kind) {
    case 'notice':
      return (
        <TranscriptItemView
          item={{ kind: 'notice', id: entry.id, level: entry.level, text: entry.text }}
          width={width}
        />
      );
    case 'doc':
      return (
        <Block width={width}>
          {entry.title ? <Text bold>{toDisplayText(entry.title)}</Text> : null}
          {entry.lines
            .flatMap((line) => wrapKeepingIndent(toDisplayText(line), width - INDENT - 1))
            .map((line, i) => (
              <Text key={i} dimColor={entry.title !== undefined || line.startsWith('  ')}>
                {line === '' ? ' ' : line}
              </Text>
            ))}
        </Block>
      );
    case 'brain-entry':
      return (
        <Block width={width}>
          <Text wrap="truncate-end">
            <Text bold>{toDisplayText(entry.title)}</Text>
            <Text dimColor>{`  ${entry.entryKind}`}</Text>
          </Text>
          <Text dimColor wrap="wrap">
            {toDisplayText(entry.meta.slice(0, 5).join(SEP))}
          </Text>
          {entry.meta.slice(5).map((line, i) => (
            <Text key={i} dimColor wrap="truncate-end">
              {toDisplayText(line)}
            </Text>
          ))}
          {entry.body.trim() ? (
            <Box marginTop={1}>
              <Text>{renderMarkdown(entry.body, { width: width - INDENT })}</Text>
            </Box>
          ) : (
            <Box marginTop={1}>
              <Text dimColor>(no text)</Text>
            </Box>
          )}
          {entry.links.length > 0 ? (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>{`links (${entry.links.length})`}</Text>
              {entry.links.map((line, i) => (
                <Text key={i} wrap="truncate-end">
                  {toDisplayText(line)}
                </Text>
              ))}
            </Box>
          ) : (
            <Text dimColor>No links.</Text>
          )}
        </Block>
      );
    case 'log':
      return (
        <Box paddingLeft={INDENT} width={width}>
          <Text wrap="wrap">{toDisplayText(entry.text)}</Text>
        </Box>
      );
    case 'run-end': {
      const summary = summarizeRun(entry.task);
      const color = toneColor(summary.tone);
      const t = entry.task;
      return (
        <Block width={width}>
          <Text wrap="truncate-end">
            <Text color={color}>{statusMark(t.status)}</Text>{' '}
            <Text bold>{toDisplayText(t.title)}</Text>
          </Text>
          <Box paddingLeft={2} flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={color}>{summary.label}</Text>
              <Text dimColor>
                {[
                  '',
                  entry.project && toDisplayText(entry.project),
                  taskRuntime(t),
                  t.costUsd > 0 ? money(t.costUsd) : null,
                  t.limits
                    ? `limit ${money(t.limits.maxCostUsd)} / ${duration(t.limits.maxDurationSec * 1000)}`
                    : null,
                ]
                  .filter((p) => p !== null)
                  .join(SEP)}
              </Text>
            </Text>
            <Text color={color}>{toDisplayText(summary.outcome)}</Text>
            {t.status === 'succeeded' && t.resultSummary ? (
              <Text dimColor>
                {toDisplayText(t.resultSummary).split('\n').slice(0, 6).join('\n')}
              </Text>
            ) : null}
          </Box>
        </Block>
      );
    }
  }
}

export interface ItemViewProps {
  item: ViewItem;
  width: number;
  tasks: Readonly<Record<string, TaskRecord>>;
  missing: ReadonlySet<string>;
  facts: Readonly<Record<string, RunFacts | 'pending'>>;
  projectName: (id: string) => string | null;
  proposal: ProposalUi | null;
  spinnerFrame: string;
  /** The prompt is empty: the keys of a pending proposal work. */
  keysActive?: boolean;
  /** The version of Patch Cloud (from its status), for the status card. */
  cloudVersion?: string | null;
  /** The start screen draws the header itself. */
  welcome?: boolean;
}

/**
 * Draws one item of the conversation. An item that cannot be drawn (data this version does not
 * understand) becomes one dim line; it never takes the whole view down.
 */
export function ItemView(props: ItemViewProps) {
  return (
    <ItemBoundary width={props.width}>
      <ItemContent {...props} />
    </ItemBoundary>
  );
}

class ItemBoundary extends Component<{ width: number; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Block width={this.props.width}>
        <Text dimColor>(This could not be shown here. Open it in Patch HQ.)</Text>
      </Block>
    );
  }
}

function ItemContent(props: ItemViewProps) {
  const { item, width } = props;
  switch (item.kind) {
    case 'header':
      return <HeaderLine entry={item.entry} width={width} />;
    case 'user':
      return (
        <TranscriptItemView item={{ kind: 'user', id: item.id, text: item.text }} width={width} />
      );
    case 'text':
      return (
        <TranscriptItemView
          item={{ kind: 'assistant', id: item.id, markdown: item.markdown, first: false }}
          width={width}
        />
      );
    case 'status':
      return (
        <StatusBlockView
          block={item.block}
          width={width}
          cloudVersion={props.cloudVersion ?? null}
        />
      );
    case 'run': {
      const task = props.tasks[item.taskId];
      return (
        <RunCard
          taskId={item.taskId}
          task={task}
          missing={props.missing.has(item.taskId)}
          facts={props.facts[item.taskId]}
          projectName={task ? props.projectName(task.projectId) : null}
          width={width}
          spinnerFrame={props.spinnerFrame}
        />
      );
    }
    case 'proposal':
      return (
        <ProposalView
          item={item}
          ui={item.active && props.proposal?.messageId === item.messageId ? props.proposal : null}
          width={width}
          keysActive={props.keysActive ?? true}
        />
      );
    case 'choose':
      return <ChooseView block={item.block} width={width} />;
    case 'help':
      return <HelpView block={item.block} width={width} />;
    case 'unsupported':
      return <UnsupportedView block={item.block} width={width} />;
    case 'entry':
      return <EntryView entry={item.entry} width={width} />;
    case 'unknown':
      return (
        <Block width={width}>
          <Text dimColor>
            (This message has content this version of ptch cannot show. Open it in Patch HQ.)
          </Text>
        </Block>
      );
  }
}
