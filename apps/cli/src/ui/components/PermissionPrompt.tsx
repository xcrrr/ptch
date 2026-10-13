import type {
  PermissionPrompt as Prompt,
  PermissionRequest,
  PermissionResponse,
  Severity,
} from '@patch/core';
import { plural, splitLines } from '@patch/shared';
import { Box, Text } from 'ink';
import { glyphs, INDENT, theme } from '../theme.js';
import { toDisplayText, truncateToWidth, wrapAtWhitespace } from '../text-layout.js';
import { DiffView, measureDiffView } from './DiffView.js';
import type { PermissionPromptProps, SelectOption } from './props.js';
import { Select } from './Select.js';

const PREVIEW_DIFF_LINES = 20;
const PREVIEW_TEXT_LINES = 12;
/** Subject, reason and preview sit two columns in from the title. */
const BODY_INDENT = 2;
const MAX_TITLE_ROWS = 2;
const MAX_REASON_ROWS = 2;
/** Preview rows kept (when the preview has them) before a long subject takes the rest. */
const MIN_PREVIEW_ROWS = 3;
/** Pointer ("› ") before each option. */
const POINTER_WIDTH = 2;

type Decision = PermissionResponse['decision'];

type PreviewLayout =
  { kind: 'diff'; rows: number } | { kind: 'text'; lines: string[]; hidden: number };

/** What the prompt shows within its row budget. */
export interface PermissionPromptLayout {
  title: string[];
  /** Rows of the subject (wrapped command or path) that are shown. */
  subject: string[];
  /** Subject rows left out (shown as "… N more lines"). */
  subjectHidden: number;
  reason: string[];
  preview: PreviewLayout | null;
  options: Array<SelectOption<Decision>>;
  /** Something was cut to fit: ctrl+o prints the request in full. */
  truncated: boolean;
  /** Terminal rows the prompt takes. */
  height: number;
}

/**
 * Permission prompt:
 *   <title in severity color>
 *
 *     <subjectLine>
 *   <reason, dim>
 *   <preview>
 *
 *   › 1. Yes
 *     2. <sessionOption.label>
 *     3. No, tell Patch what to do instead
 *   enter confirm · esc decline
 *
 * With `maxRows`, the subject and preview are cut so the whole prompt fits; the hint then
 * mentions ctrl+o, which the owner handles by printing the request in full.
 */
export function PermissionPrompt({
  request,
  onRespond,
  width,
  maxRows,
  isActive = true,
}: PermissionPromptProps) {
  const layout = layoutPermissionPrompt(request, width, maxRows);
  const { prompt, preview } = request;
  const contentWidth = Math.max(1, width - INDENT);
  const pad = ' '.repeat(BODY_INDENT);
  const respond = (decision: Decision): void => {
    onRespond(decision === 'deny' ? { decision: 'deny' } : { decision });
  };

  return (
    <Box flexDirection="column" paddingLeft={INDENT} width={width}>
      {layout.title.map((row, i) => (
        <Text key={`title-${i}`} bold color={titleColor(prompt.severity)} wrap="truncate-end">
          {row}
        </Text>
      ))}
      <Box marginTop={1} flexDirection="column">
        {layout.subject.map((row, i) => (
          <Text key={`subject-${i}`} bold wrap="truncate-end">
            {pad + row}
          </Text>
        ))}
        {layout.subjectHidden > 0 && (
          <Text dimColor wrap="truncate-end">
            {`${pad}${glyphs.ellipsis} ${plural(layout.subjectHidden, 'more line')}`}
          </Text>
        )}
      </Box>
      {layout.reason.map((row, i) => (
        <Text key={`reason-${i}`} dimColor wrap="truncate-end">
          {row}
        </Text>
      ))}
      {layout.preview?.kind === 'diff' && preview?.diff && (
        <DiffView
          diff={preview.diff}
          maxLines={PREVIEW_DIFF_LINES}
          maxRows={layout.preview.rows}
          width={contentWidth}
          indent={BODY_INDENT}
          overflow="truncate"
        />
      )}
      {layout.preview?.kind === 'text' && (
        <TextPreview lines={layout.preview.lines} hidden={layout.preview.hidden} />
      )}
      <Box marginTop={1}>
        <Select
          options={layout.options}
          onSelect={respond}
          onCancel={() => onRespond({ decision: 'deny' })}
          isActive={isActive}
          numbered
        />
      </Box>
      <Text dimColor wrap="truncate-end">
        {[
          'enter confirm',
          'esc decline',
          ...(layout.truncated ? ['ctrl+o show in full'] : []),
        ].join(` ${glyphs.dot} `)}
      </Text>
    </Box>
  );
}

function TextPreview({ lines, hidden }: { lines: readonly string[]; hidden: number }) {
  const pad = ' '.repeat(BODY_INDENT);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} dimColor wrap="truncate-end">
          {pad + (line || ' ')}
        </Text>
      ))}
      {hidden > 0 && (
        <Text dimColor wrap="truncate-end">
          {`${pad}${glyphs.ellipsis} ${plural(hidden, 'more line')}`}
        </Text>
      )}
    </Box>
  );
}

/**
 * Decides what the prompt shows. Every row is pre-wrapped or truncated here, so the height is
 * exact. Without `maxRows` only the fixed preview caps apply (20 diff lines, 12 text lines).
 * The title, reason, options and hint always show; the subject keeps at least one row.
 */
export function layoutPermissionPrompt(
  request: PermissionRequest,
  width: number,
  maxRows = Number.POSITIVE_INFINITY,
): PermissionPromptLayout {
  const { prompt } = request;
  const contentWidth = Math.max(1, width - INDENT);
  const bodyWidth = Math.max(1, contentWidth - BODY_INDENT);

  const title = capRows(
    wrapAtWhitespace(toDisplayText(prompt.title), contentWidth),
    MAX_TITLE_ROWS,
    contentWidth,
  );
  const reason = prompt.reason
    ? capRows(
        wrapAtWhitespace(toDisplayText(prompt.reason), contentWidth),
        MAX_REASON_ROWS,
        contentWidth,
      )
    : [];
  const options = promptOptions(prompt, contentWidth);
  // Title, the blank line above the subject, reason, the blank line above the options, the
  // options and the hint.
  const fixed = title.length + 1 + reason.length + 1 + options.length + 1;
  const room = Math.max(1, maxRows - fixed);

  const subjectRows = splitLines(toDisplayText(prompt.subjectLine)).flatMap((line) =>
    wrapAtWhitespace(line, bodyWidth),
  );
  const previewNatural = layoutPreview(request, contentWidth, Number.POSITIVE_INFINITY).height;
  const previewFloor = Math.min(previewNatural, MIN_PREVIEW_ROWS);

  let subject = subjectRows;
  let subjectHidden = 0;
  if (subjectRows.length + previewNatural > room && subjectRows.length > room - previewFloor) {
    // One row says how many lines are left out.
    const shown = Math.max(1, room - previewFloor - 1);
    subject = subjectRows.slice(0, shown);
    subjectHidden = subjectRows.length - shown;
  }
  const subjectHeight = subject.length + (subjectHidden > 0 ? 1 : 0);
  const preview = layoutPreview(request, contentWidth, Math.max(0, room - subjectHeight));

  return {
    title,
    subject,
    subjectHidden,
    reason,
    preview: preview.layout,
    options,
    truncated: subjectHidden > 0 || !preview.complete,
    height: fixed + subjectHeight + preview.height,
  };
}

/** The preview within `maxRows` rows: at most 20 diff lines or 12 text lines. */
function layoutPreview(
  request: PermissionRequest,
  contentWidth: number,
  maxRows: number,
): { layout: PreviewLayout | null; height: number; complete: boolean } {
  const { preview } = request;
  if (preview?.diff) {
    const measured = measureDiffView(preview.diff, {
      maxLines: PREVIEW_DIFF_LINES,
      maxRows,
      width: contentWidth,
      indent: BODY_INDENT,
      overflow: 'truncate',
    });
    return { layout: { kind: 'diff', rows: maxRows }, ...measured };
  }
  if (!preview?.text) return { layout: null, height: 0, complete: true };
  const bodyWidth = Math.max(1, contentWidth - BODY_INDENT);
  const lines = splitLines(toDisplayText(preview.text));
  let shown = Math.min(lines.length, PREVIEW_TEXT_LINES);
  // One row says how many lines are left out.
  if (shown + (shown < lines.length ? 1 : 0) > maxRows) shown = Math.max(0, maxRows - 1);
  const kept = lines.slice(0, shown).map((line) => truncateToWidth(line, bodyWidth));
  const hidden = maxRows > 0 ? lines.length - shown : 0;
  const cut = shown < lines.length || kept.some((line, i) => line !== lines[i]);
  return {
    layout: maxRows > 0 ? { kind: 'text', lines: kept, hidden } : null,
    height: kept.length + (hidden > 0 ? 1 : 0),
    complete: !cut,
  };
}

/** At most `max` rows; the last one marks the cut with "…". */
function capRows(rows: readonly string[], max: number, width: number): string[] {
  if (rows.length <= max) return [...rows];
  const kept = rows.slice(0, max);
  const last = kept[max - 1] ?? '';
  kept[max - 1] = truncateToWidth(`${last} ${rows.slice(max).join(' ')}`, width);
  return kept;
}

function promptOptions(prompt: Prompt, contentWidth: number): Array<SelectOption<Decision>> {
  const options: Array<SelectOption<Decision>> = [
    { label: 'Yes', value: 'allow_once', tone: prompt.severity === 'danger' ? 'danger' : 'normal' },
  ];
  if (prompt.sessionOption) {
    options.push({ label: prompt.sessionOption.label, value: 'allow_session' });
  }
  options.push({ label: 'No, tell Patch what to do instead', value: 'deny' });
  // One row each: pointer, "N. ", label.
  const labelWidth = Math.max(1, contentWidth - POINTER_WIDTH - `${options.length}. `.length);
  return options.map((option) => ({
    ...option,
    label: truncateToWidth(toDisplayText(option.label), labelWidth),
  }));
}

function titleColor(severity: Severity): string | undefined {
  if (severity === 'warning') return theme.warning;
  if (severity === 'danger') return theme.danger;
  return undefined;
}
