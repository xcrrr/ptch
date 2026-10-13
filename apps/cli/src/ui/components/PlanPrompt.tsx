import { plural, splitLines } from '@patch/shared';
import { Box, Text, useInput, type Key } from 'ink';
import { useCallback, useRef, useState } from 'react';
import { renderMarkdown } from '../markdown.js';
import { glyphs, INDENT, theme } from '../theme.js';
import { displayWidth, graphemes, toDisplayText, truncateToWidth } from '../text-layout.js';
import type { PlanPromptProps, SelectOption } from './props.js';
import { Select } from './Select.js';

const TITLE = 'Patch has a plan';
const FEEDBACK_LABEL = 'What should Patch change?';
/** Border and padding columns on each side of the plan. */
const FRAME_SIDE = 2;
/** Pointer ("› ") before each option, and before the feedback text. */
const POINTER_WIDTH = 2;

type Choice = 'accept' | 'ask' | 'keep';

const OPTIONS: ReadonlyArray<SelectOption<Choice>> = [
  { label: 'Yes, and accept edits', value: 'accept' },
  { label: 'Yes, and ask before each edit', value: 'ask' },
  { label: 'No, keep planning', value: 'keep' },
];

/**
 * Rows besides the plan: title, the frame's borders, a blank line, the options (or the feedback
 * label and input, which take fewer) and the hint.
 */
const FIXED_ROWS = 1 + 2 + 1 + OPTIONS.length + 1;

/** The plan as rendered rows for a frame `width` columns wide (borders included). */
export function renderPlanRows(plan: string, width: number): string[] {
  const inner = Math.max(1, width - 2 * FRAME_SIDE);
  return splitLines(renderMarkdown(plan, { width: inner }));
}

/**
 * A plan in a rounded frame, `width` columns wide. Rows are truncated, never wrapped, so the
 * height is exact: the rows, the "… N more lines" row when `hidden`, and the two borders.
 */
export function PlanFrame({
  rows,
  hidden = 0,
  width,
}: {
  rows: readonly string[];
  hidden?: number;
  width: number;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.planMode}
      paddingX={FRAME_SIDE - 1}
      width={Math.max(2 * FRAME_SIDE + 1, width)}
    >
      {rows.map((row, i) => (
        <Text key={i} wrap="truncate-end">
          {row || ' '}
        </Text>
      ))}
      {hidden > 0 && (
        <Text dimColor wrap="truncate-end">
          {`${glyphs.ellipsis} ${plural(hidden, 'more line')}`}
        </Text>
      )}
      {rows.length === 0 && hidden === 0 && <Text> </Text>}
    </Box>
  );
}

/** What the prompt shows within its row budget. */
export interface PlanPromptLayout {
  /** Rendered plan rows that are shown. */
  rows: string[];
  /** Rows left out (shown as "… N more lines"). */
  hidden: number;
  /** The plan was cut to fit: ctrl+o prints it in full. */
  truncated: boolean;
  /** Terminal rows the prompt takes at most (the options show; the feedback input is shorter). */
  height: number;
}

/** Decides how much of the plan fits in `maxRows` (the frame keeps at least one row). */
export function layoutPlanPrompt(
  plan: string,
  width: number,
  maxRows = Number.POSITIVE_INFINITY,
): PlanPromptLayout {
  const all = renderPlanRows(plan, frameWidth(width));
  const room = Math.max(1, maxRows - FIXED_ROWS);
  if (all.length <= room) {
    return { rows: all, hidden: 0, truncated: false, height: FIXED_ROWS + Math.max(1, all.length) };
  }
  // One row says how many lines are left out.
  const shown = Math.max(0, room - 1);
  return {
    rows: all.slice(0, shown),
    hidden: all.length - shown,
    truncated: true,
    height: FIXED_ROWS + shown + 1,
  };
}

function frameWidth(width: number): number {
  return Math.max(1, width - INDENT);
}

/**
 * The plan review (see PlanPromptProps): the plan in a frame, then "Yes, and accept edits", "Yes,
 * and ask before each edit" or "No, keep planning", which asks what to change.
 */
export function PlanPrompt({
  request,
  onRespond,
  width,
  maxRows,
  isActive = true,
}: PlanPromptProps) {
  const [phase, setPhase] = useState<'options' | 'feedback'>('options');
  const layout = layoutPlanPrompt(request.plan, width, maxRows);
  const contentWidth = Math.max(1, width - INDENT);
  const labelWidth = Math.max(1, contentWidth - POINTER_WIDTH - `${OPTIONS.length}. `.length);
  const options = OPTIONS.map((option) => ({
    ...option,
    label: truncateToWidth(option.label, labelWidth),
  }));

  const choose = (choice: Choice): void => {
    if (choice === 'accept') onRespond({ decision: 'approve', mode: 'acceptEdits' });
    else if (choice === 'ask') onRespond({ decision: 'approve', mode: 'default' });
    else setPhase('feedback');
  };
  const hint =
    phase === 'feedback'
      ? ['enter send', 'esc back']
      : [
          'enter confirm',
          'esc keep planning',
          ...(layout.truncated ? ['ctrl+o show in full'] : []),
        ];

  return (
    <Box flexDirection="column" paddingLeft={INDENT} width={width}>
      <Text bold color={theme.planMode} wrap="truncate-end">
        {TITLE}
      </Text>
      <PlanFrame rows={layout.rows} hidden={layout.hidden} width={contentWidth} />
      <Box marginTop={1} flexDirection="column">
        {phase === 'options' ? (
          <Select
            options={options}
            initialIndex={0}
            onSelect={choose}
            onCancel={() => onRespond({ decision: 'keep_planning' })}
            isActive={isActive}
            numbered
          />
        ) : (
          <FeedbackInput
            width={contentWidth}
            isActive={isActive}
            onSubmit={(feedback) =>
              onRespond(
                feedback ? { decision: 'keep_planning', feedback } : { decision: 'keep_planning' },
              )
            }
            onBack={() => setPhase('options')}
          />
        )}
      </Box>
      <Text dimColor wrap="truncate-end">
        {hint.join(` ${glyphs.dot} `)}
      </Text>
    </Box>
  );
}

/**
 * "What should Patch change?" and one line of input: typing and pasting add text (line breaks
 * become spaces), Backspace deletes, Ctrl+U clears, Enter sends the trimmed text, Esc goes back.
 * A long text shows its end.
 */
function FeedbackInput({
  width,
  isActive,
  onSubmit,
  onBack,
}: {
  width: number;
  isActive: boolean;
  onSubmit: (feedback: string) => void;
  onBack: () => void;
}) {
  const [text, setText] = useState('');
  // Several key events can arrive before React re-renders (a paste, fast typing).
  const latest = useRef(text);
  latest.current = text;
  const update = useCallback((next: string) => {
    latest.current = next;
    setText(next);
  }, []);
  const handleInput = useCallback(
    (input: string, key: Key) => {
      const current = latest.current;
      if (key.return) onSubmit(current.trim());
      else if (key.escape) onBack();
      else if (key.backspace || key.delete) update(graphemes(current).slice(0, -1).join(''));
      else if (key.ctrl && input === 'u') update('');
      else if (!key.ctrl && !key.meta && !key.tab && input) {
        const typed = toDisplayText(input).replace(/\s*\n\s*/g, ' ');
        if (typed) update(current + typed);
      }
    },
    [onSubmit, onBack, update],
  );
  useInput(handleInput, { isActive });

  const room = Math.max(1, width - POINTER_WIDTH - 1);
  const shown = displayWidth(text) <= room ? text : truncateToWidth(text, room, 'start');
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">{FEEDBACK_LABEL}</Text>
      <Text wrap="truncate-end">
        <Text color={theme.accent}>{`${glyphs.pointer} `}</Text>
        {shown}
        <Text inverse> </Text>
      </Text>
    </Box>
  );
}
