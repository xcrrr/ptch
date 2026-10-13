/**
 * Props contracts for Patch's Ink components. Components live next to this file, one per file,
 * named after the component (Composer.tsx exports `Composer`, etc.).
 */
import type { Key } from 'ink';
import type {
  FileDiff,
  PermissionRequest,
  PermissionResponse,
  PlanReviewRequest,
  PlanReviewResponse,
  SessionSummary,
  ToolCallSummary,
  ToolDisplay,
  ToolProgress,
} from '@patch/core';
import type { ImageAttachment } from '../../images.js';
import type { ComposerEffect, ComposerState } from '../composer-state.js';
import type { TranscriptItem, WelcomeInfo } from '../transcript.js';

export interface SlashCommandInfo {
  /** Without the slash, e.g. "compact". */
  name: string;
  description: string;
  /** Argument hint, e.g. "[instructions]". */
  args?: string;
  aliases?: string[];
  /** Shown dim after the description, e.g. "project" for a custom command: "(project)". */
  tag?: string;
}

/**
 * Multi-line prompt. Renders "› " + text (continuation lines indented to align), a visible
 * block cursor (inverse) at the cursor position, a dim placeholder when empty. When the text is
 * a slash command being typed (starts with "/" and contains no whitespace yet), shows up to 6
 * matching commands below (prefix match on name and aliases, then substring), with the
 * highlighted one marked; Up/Down move the highlight, Tab completes it ("/name "), Enter runs the
 * highlighted command if the typed text is not already an exact command. When the text starts
 * with "!", the prompt marker becomes "!" in theme.warning (shell mode). Attached images are
 * listed dim under the text ("[Image #1] screenshot.png · 1280×720 · 84 KB", at most 3 lines).
 */
export interface ComposerProps {
  state: ComposerState;
  onChange: (state: ComposerState) => void;
  /**
   * The prompt, and the images attached to it when there are any (their tokens renumbered, see
   * takeAttachments).
   */
  onSubmit: (text: string, images?: ImageAttachment[]) => void;
  /**
   * Non-editing effects: interrupt, escape, exit, clear-screen, expand, paste-image, cycle-mode
   * (submit/tab/menu handled inside).
   */
  onEffect: (effect: ComposerEffect) => void;
  /**
   * A paste that is exactly a path to an image file (`path` unquoted, `raw` as pasted). The owner
   * attaches the image, or inserts `raw` when it cannot. Without it such a paste is inserted as
   * text.
   */
  onPastePath?: (path: string, raw: string) => void;
  /**
   * Sees every key before the editor does; returns true when the owner used it (the key is then
   * not typed). `state` is the draft at that moment.
   */
  onKey?: (input: string, key: Key, state: ComposerState) => boolean;
  history: readonly string[];
  commands: readonly SlashCommandInfo[];
  /** Called when the slash menu opens (the text became "/..."), e.g. to look for new commands. */
  onMenuOpen?: () => void;
  /** Whether keyboard input is captured. */
  isActive: boolean;
  placeholder?: string;
  width: number;
  /**
   * Most terminal rows to use for the text and the slash menu together (default 16 text rows
   * plus the menu). Longer text scrolls around the cursor.
   */
  maxRows?: number;
  /** Agent is working: marker dim (input still accepted; submissions get queued by the owner). */
  busy?: boolean;
}

export interface SelectOption<T> {
  label: string;
  value: T;
  /** Dim text after the label. */
  hint?: string;
  tone?: 'normal' | 'danger';
}

/** Vertical list: Up/Down (and k/j) move, Enter selects, Esc cancels, digits 1-9 select directly when `numbered`. */
export interface SelectProps<T> {
  options: ReadonlyArray<SelectOption<T>>;
  onSelect: (value: T) => void;
  onCancel?: () => void;
  initialIndex?: number;
  isActive?: boolean;
  numbered?: boolean;
  /** Scrolls when there are more options than this (default 10). */
  maxVisible?: number;
}

/**
 * Permission prompt. Layout:
 *   <title in severity color>            (normal: bold; warning: yellow; danger: red)
 *
 *     <subjectLine>                       (bold; commands shown verbatim, wrapped)
 *   <reason, dim>                          (when present)
 *   <preview: DiffView (≤ 20 lines, cut to the width) or first 12 lines of text, dim>
 *
 *   › Yes
 *     <sessionOption.label>               (only when present)
 *     No, tell Patch what to do instead
 *   enter confirm · esc decline          (dim; "· ctrl+o show in full" when something was cut)
 * Options are numbered 1..3 for direct selection. Esc → deny. Danger severity puts the cursor on
 * "Yes" but renders it in red. With `maxRows`, the subject and preview are cut ("… N more
 * lines") so the prompt never takes more rows than that.
 */
export interface PermissionPromptProps {
  request: PermissionRequest;
  onRespond: (response: PermissionResponse) => void;
  width: number;
  /** Most terminal rows the prompt may take (unlimited when omitted). */
  maxRows?: number;
  isActive?: boolean;
}

/** The project's MCP servers (from .mcp.json) waiting for the user's approval at startup. */
export interface McpApprovalRequest {
  /** Each server's name and what it runs (command line) or where it connects (URL). */
  servers: ReadonlyArray<{ name: string; target: string }>;
}

export type McpApprovalChoice = 'yes' | 'remember' | 'no';

/**
 * Approval of the project's MCP servers. Layout:
 *   <title, yellow>                      "This project's .mcp.json wants to start 2 MCP servers"
 *
 *     <name>  <command line or URL>      (one row per server, cut to the width; "… N more")
 *   <why it matters, dim>
 *
 *   › 1. Yes
 *     2. Yes, and remember for this project
 *     3. No
 *   enter confirm · esc decline
 * Esc → "no". With `maxRows`, server rows are left out ("… N more servers") so the prompt never
 * takes more rows than that.
 */
export interface McpApprovalPromptProps {
  request: McpApprovalRequest;
  onRespond: (choice: McpApprovalChoice) => void;
  width: number;
  maxRows?: number;
  isActive?: boolean;
}

export type ToolRowStatus = 'running' | 'waiting' | 'done' | 'error' | 'denied' | 'interrupted';

/**
 * One tool call:
 *   "  read    src/auth/session.ts · 120 lines"
 *   "  edit    src/auth/session.ts  +18 -6"   (+ compact DiffView below, ≤ 8 lines, when display.diff)
 *   "  bash    pnpm test"
 *   "          42 passed · 1 failed · 8.1s"  (bash/long summaries go on a second line aligned to the target)
 * Gutter (first 2 columns): spinner frame while running/waiting, blank otherwise. Verb padded to
 * VERB_WIDTH, dim (red when error). Target normal weight; `summary.detail` dim after it. Summary
 * dim; red for error; yellow "declined" for denied; dim "interrupted". display.lines shown dim
 * under the row (≤ 4). While running, progress.tail (≤ 5 lines) shown dim under the row.
 * Long targets are truncated with "…" to fit `width`.
 */
export interface ToolRowProps {
  summary: ToolCallSummary;
  name: string;
  status: ToolRowStatus;
  display?: ToolDisplay;
  progress?: ToolProgress;
  durationMs?: number;
  width: number;
  /** Current spinner frame (owner animates) for running/waiting rows. */
  spinnerFrame?: string;
}

/**
 * File diff with a line-number gutter: context lines dim, "-" lines red, "+" lines green; hunks
 * separated by a dim "⋮". When more than `maxLines` diff lines, shows the first ones and
 * "… N more lines" (dim).
 */
export interface DiffViewProps {
  diff: FileDiff;
  maxLines?: number;
  width: number;
  /** Indentation in columns (default 10, aligning with tool targets). */
  indent?: number;
}

/**
 * Colored `git diff` text: "diff --git"/"+++"/"---" headers bold, "@@" lines cyan, additions green,
 * deletions red, rest default. Truncates after `maxLines` with "… N more lines (run git diff for
 * the full output)". Untracked files listed after the diff ("Untracked: a.ts, b.ts").
 */
export interface GitDiffViewProps {
  diff: string;
  untracked: readonly string[];
  maxLines?: number;
  width: number;
}

/** Renders any committed transcript item (see transcript.ts for per-kind layout rules). */
export interface TranscriptItemViewProps {
  item: TranscriptItem;
  width: number;
  /** Show the welcome header's title line (off when the logo was shown above it). Default true. */
  welcomeTitle?: boolean;
}

/**
 * Activity line shown while the agent works:
 *   "⠹ Running pnpm test  14s · esc to interrupt"
 * The component animates its own spinner (80ms) and elapsed time (1s resolution) from
 * `startedAt` (Date.now() ms). `detail` (dim) is optional extra info like "↓ 1.2k tokens".
 */
export interface StatusLineProps {
  label: string;
  startedAt: number;
  detail?: string;
  hint?: string;
}

/**
 * Restrained startup header:
 *   patch 0.1.0
 *   ~/code/project · main · 3 changed
 *   claude-opus-5-5 · ready · PATCH.md
 * (status "ready" dim, "no API key" yellow/red per statusLevel; notes dim below).
 */
export interface WelcomeProps {
  info: WelcomeInfo;
  /** Show the "ptch 0.1.0" title line. Default true. */
  showTitle?: boolean;
}

/**
 * Session list for --resume and /resume:
 *   "Resume a session"  (bold)  + dim project path
 *   › 82af31  Fix the failing auth test          2h ago · main · 24 msgs
 * Sessions whose project directory no longer exists are marked dim "(missing)".
 * Up/Down select, Enter resumes, Esc cancels. Empty list → "No previous sessions for this project."
 */
export interface SessionPickerProps {
  sessions: readonly SessionSummary[];
  onSelect: (id: string) => void;
  onCancel: () => void;
  width: number;
  /** Shown under the title. */
  projectLabel: string;
  /** Sessions listed at once before the list scrolls (default 10). */
  maxVisible?: number;
}

/** One dim line under the prompt: left-aligned hints, right-aligned status. */
export interface FooterProps {
  left: string;
  right: string;
  width: number;
  /**
   * Shown first on the left in `color` (not dim), e.g. "⏸ plan mode"; `left` follows it after
   * " · ".
   */
  accent?: { text: string; color: string };
}

/**
 * A plan the model presented, for the user's review (plan mode):
 *   Patch has a plan                   (bold, theme.planMode)
 *   ╭──────────────────────────╮
 *   │ <plan, rendered Markdown> │       (cut to fit with "… N more lines")
 *   ╰──────────────────────────╯
 *
 *   › 1. Yes, and accept edits
 *     2. Yes, and ask before each edit
 *     3. No, keep planning
 *   enter confirm · esc keep planning   (dim; "· ctrl+o show in full" when the plan was cut)
 * Option 3 asks what to change on one line ("› " + text, enter sends, esc goes back); sent
 * empty, the turn ends and the user can say it in the prompt instead. Esc on the options keeps
 * planning without feedback, like declining a permission prompt.
 */
/** The one-time confirmation before auto mode turns on (see AutoConfirmPrompt). */
export interface AutoConfirmPromptProps {
  /** True for Yes; Esc answers false. */
  onRespond: (yes: boolean) => void;
  width: number;
  isActive?: boolean;
}

export interface PlanPromptProps {
  request: PlanReviewRequest;
  onRespond: (response: PlanReviewResponse) => void;
  width: number;
  /** Most terminal rows the prompt may take (unlimited when omitted). */
  maxRows?: number;
  isActive?: boolean;
}
