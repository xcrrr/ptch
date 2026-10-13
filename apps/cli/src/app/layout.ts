import type { ComposerState } from '../ui/composer-state.js';
import {
  composerHeight,
  layoutAutoConfirm,
  layoutMcpApproval,
  layoutPermissionPrompt,
  layoutPlanPrompt,
  sessionPickerHeight,
  sessionPickerMaxVisible,
  toolRowHeight,
  type SlashCommandInfo,
} from '../ui/components/index.js';
import type { AppState, LiveTool } from './controller.js';

/** Queued prompts listed below the status line before the rest are counted ("+ N more"). */
export const MAX_QUEUE_ROWS = 3;
/** Rows the composer may use for a long draft (the slash menu included). */
const MAX_COMPOSER_ROWS = 22;
/** While output is live, a long draft leaves at least this many rows for it. */
const MIN_LIVE_ROWS = 5;
/** A permission prompt keeps this many rows even when live tool rows want the space. */
const MIN_PERMISSION_ROWS = 12;
const MAX_PICKER_ROWS = 10;
/** Model picker rows around its list: title, blank line, "Other model ids" line. */
const MODEL_PICKER_CHROME = 3;

export interface LiveLayoutInput {
  state: AppState;
  composer: ComposerState;
  composerActive: boolean;
  commands: readonly SlashCommandInfo[];
  columns: number;
  rows: number;
}

/**
 * How the live area (everything below the transcript) fits the terminal. Ink repaints the whole
 * screen, transcript included, on every frame once its output reaches the terminal height, so
 * the live area is kept at most `rows - 1` rows: the footer, composer (with the slash menu),
 * status line and queue keep their rows, a permission prompt, plan review or picker gets what it
 * needs, tool rows get what is left, and streaming text gets the rest.
 */
export interface LiveLayout {
  /** Rows for streaming text (0: not shown). */
  liveTextRows: number;
  /** Tool rows shown (the most recent ones) and how many earlier ones are left out. */
  tools: LiveTool[];
  hiddenTools: number;
  /** Height of the tool block without its top margin when it must be clipped, else undefined. */
  toolsClip: number | undefined;
  queue: string[];
  hiddenQueue: number;
  composerMaxRows: number;
  permissionMaxRows: number;
  /** Rows the plan review may take (its plan is cut to fit). */
  planMaxRows: number;
  /** Rows the MCP approval prompt may take. */
  mcpApprovalMaxRows: number;
  pickerMaxVisible: number;
}

export function layoutLiveArea(input: LiveLayoutInput): LiveLayout {
  const { state, columns } = input;
  const limit = Math.max(1, input.rows - 1);
  let used = 1; // footer

  const prompting =
    state.mode === 'permission' || state.mode === 'plan-review' || state.mode === 'auto-confirm';
  if (state.activity && !prompting) used += 2;

  const queueFits = state.queue.length <= MAX_QUEUE_ROWS;
  const queue = queueFits ? state.queue : state.queue.slice(0, MAX_QUEUE_ROWS - 1);
  const hiddenQueue = state.queue.length - queue.length;
  used += queue.length + (hiddenQueue > 0 ? 1 : 0);

  const liveOutput = state.liveText.trim() !== '' || state.liveTools.length > 0;
  let composerMaxRows = MAX_COMPOSER_ROWS;
  if (input.composerActive) {
    composerMaxRows = clamp(
      limit - used - 1 - (liveOutput ? MIN_LIVE_ROWS : 0),
      1,
      MAX_COMPOSER_ROWS,
    );
    used +=
      1 +
      composerHeight({
        state: input.composer,
        width: columns,
        commands: input.commands,
        isActive: true,
        maxRows: composerMaxRows,
      });
  }

  const toolHeights = state.liveTools.map((tool) =>
    toolRowHeight({ ...tool, width: columns, spinnerFrame: '' }),
  );
  const toolsNatural = toolHeights.length > 0 ? 1 + sum(toolHeights) : 0;

  let permissionMaxRows = Number.POSITIVE_INFINITY;
  if (state.mode === 'permission' && state.permission) {
    const room = limit - used - 1;
    permissionMaxRows = Math.max(Math.min(MIN_PERMISSION_ROWS, room), room - toolsNatural, 1);
    used += 1 + layoutPermissionPrompt(state.permission, columns, permissionMaxRows).height;
  }

  let planMaxRows = Number.POSITIVE_INFINITY;
  if (state.mode === 'plan-review' && state.planReview) {
    const room = limit - used - 1;
    planMaxRows = Math.max(Math.min(MIN_PERMISSION_ROWS, room), room - toolsNatural, 1);
    used += 1 + layoutPlanPrompt(state.planReview.plan, columns, planMaxRows).height;
  }
  if (state.mode === 'auto-confirm') used += 1 + layoutAutoConfirm(columns).height;

  let mcpApprovalMaxRows = Number.POSITIVE_INFINITY;
  if (state.mode === 'mcp-approval' && state.mcpApproval) {
    mcpApprovalMaxRows = Math.max(1, limit - used - 1);
    used += 1 + layoutMcpApproval(state.mcpApproval, columns, mcpApprovalMaxRows).height;
  }

  let pickerMaxVisible = MAX_PICKER_ROWS;
  if (state.mode === 'session-picker' && state.sessionChoices) {
    pickerMaxVisible = sessionPickerMaxVisible(limit - used - 1, MAX_PICKER_ROWS);
    used += 1 + sessionPickerHeight(state.sessionChoices.length, pickerMaxVisible);
  } else if (state.mode === 'model-picker' && state.modelChoices) {
    pickerMaxVisible = clamp(limit - used - 1 - MODEL_PICKER_CHROME - 2, 1, MAX_PICKER_ROWS);
    const count = state.modelChoices.length;
    const list = count > pickerMaxVisible ? pickerMaxVisible + 2 : count;
    used += 1 + MODEL_PICKER_CHROME + list;
  }

  // Tool rows: all of them when they fit; else the most recent ones under a "N more" row.
  let tools = state.liveTools;
  let hiddenTools = 0;
  let toolsClip: number | undefined;
  if (toolsNatural > 0) {
    const room = limit - used;
    if (toolsNatural <= room) {
      used += toolsNatural;
    } else if (room < 2) {
      tools = [];
    } else {
      // Everything does not fit, so the "N more" row shows: start from the top margin and it.
      let height = 2;
      let first = toolHeights.length;
      while (first > 0 && height + (toolHeights[first - 1] ?? 0) <= room) {
        first -= 1;
        height += toolHeights[first] ?? 0;
      }
      if (first === toolHeights.length) {
        // Not even the newest row fits: show the top of it, clipped below the top margin.
        first -= 1;
        toolsClip = room - 1;
        height = room;
      }
      tools = state.liveTools.slice(first);
      hiddenTools = first;
      used += height;
    }
  }

  const liveTextRows = state.liveText.trim() ? Math.max(0, limit - used - 1) : 0;
  return {
    liveTextRows,
    tools,
    hiddenTools,
    toolsClip,
    queue,
    hiddenQueue,
    composerMaxRows,
    permissionMaxRows,
    planMaxRows,
    mcpApprovalMaxRows,
    pickerMaxVisible,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
