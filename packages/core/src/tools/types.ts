import type { ImageBlock } from '@patch/shared';
import type { z } from 'zod';
import type { Logger } from '../logging/logger.js';
import type { PathPolicy, ResolvedPath } from '../fs/paths.js';
import type { FileStateTracker } from '../fs/file-state.js';
import type { ShellInfo } from '../shell/shell.js';
import type { CommandAnalysis } from '../permissions/command-risk.js';
import type { PlanReviewResponse } from '../permissions/modes.js';

/**
 * The permission class every tool belongs to: it reads, writes or executes, or (`none`) it only
 * acts inside Patch, such as showing text to the user, and needs no approval in any mode.
 */
export type PermissionClass = 'read' | 'write' | 'execute' | 'none';

/** Everything a tool may use while running. Created per tool call by the agent. */
export interface ToolContext {
  /** Directory Patch was started in. Relative paths resolve here and shell commands run here. */
  cwd: string;
  /** Project boundary: the Git repository root, or `cwd` outside Git. */
  projectRoot: string;
  /** Git repository root, or null in directory mode. */
  gitRoot: string | null;
  /** User home directory (for `~` expansion and display). */
  home: string;
  signal: AbortSignal;
  paths: PathPolicy;
  fileState: FileStateTracker;
  shell: ShellInfo;
  logger: Logger;
  /** Streams incremental progress (e.g. bash output) to the UI. */
  onProgress?: (progress: ToolProgress) => void;
  /**
   * Shows a plan to the user (present_plan) and resolves with what became of it: in plan mode
   * the user's answer, after which the agent has switched modes as they chose; otherwise
   * `shown`. Provided by the agent for each call.
   */
  presentPlan?: (plan: string) => Promise<PlanOutcome>;
}

/** What became of a plan given to ToolContext.presentPlan. `shown`: plan mode was off. */
export type PlanOutcome = { decision: 'shown' } | PlanReviewResponse;

export interface ToolProgress {
  /** Most recent output lines (already ANSI-stripped), for a live tail in the UI. */
  tail: string[];
  /** Total output lines seen so far. */
  totalLines: number;
}

/**
 * What the permission layer needs to decide about a specific call. Computed from validated
 * input before anything runs.
 */
export type PermissionSubject =
  | { kind: 'read'; paths: ResolvedPath[] }
  | { kind: 'write'; paths: ResolvedPath[] }
  | { kind: 'execute'; command: string; analysis: CommandAnalysis; origin: 'agent' | 'user' }
  /**
   * A call to a tool of an MCP server (execute class: the server runs it with the user's
   * privileges). `tool` is the tool's name on the server, `exposedName` its name for the model.
   */
  | { kind: 'mcp'; server: string; tool: string; exposedName: string; input: unknown }
  /** Nothing outside Patch is touched (permission class `none`). */
  | { kind: 'none' };

/** One-line description of a call for the transcript, e.g. `read  src/auth/session.ts`. */
export interface ToolCallSummary {
  /** Short lowercase verb shown in the gutter: read, edit, write, create, grep, glob, ls, bash, git. */
  verb: string;
  /** Main target: a path, pattern, or command. */
  target: string;
  /** Optional extra context shown dim after the target (e.g. "lines 40-120"). */
  detail?: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Lines prefixed with ' ', '+', or '-' (and possibly '\' for "No newline at end of file"). */
  lines: string[];
}

export interface FileDiff {
  /** Display path (relative to cwd when inside the project). */
  path: string;
  added: number;
  removed: number;
  isNew: boolean;
  hunks: DiffHunk[];
}

/** UI-facing rendering hints for a finished tool call. Never sent to the model. */
export interface ToolDisplay {
  /** Short dim suffix after the target, e.g. "11 matches" or "42 passed · 1 failed". */
  summary?: string;
  /** A few dim lines under the row, e.g. the tail of a failing command. */
  lines?: string[];
  /** Diff for edits and file creations. */
  diff?: FileDiff;
  /** Longer detail for on-demand expansion (already truncated to a sane size). */
  detail?: string;
  /** A plan the model presented (Markdown), shown in full in a frame under the row. */
  plan?: string;
}

export interface ToolResult {
  /** Text returned to the model. */
  content: string;
  /** Images returned to the model with the text (never logged). */
  images?: ImageBlock[];
  isError?: boolean;
  display?: ToolDisplay;
}

/** Shown in permission prompts before a risky call runs. */
export interface ToolPreview {
  diff?: FileDiff;
  /** Plain text preview (e.g. the first lines of a new file). */
  text?: string;
}

/**
 * A first-party tool. Tools never touch the UI directly and never decide permissions themselves:
 * they describe the call (`summarize`, `permission`, `preview`) and execute it.
 */
export interface ToolDefinition<Input = any> {
  name: string;
  /** Model-facing description. */
  description: string;
  inputSchema: z.ZodType<Input>;
  /**
   * Model-facing JSON Schema (an object schema) sent instead of one derived from `inputSchema`,
   * for tools whose schema comes from elsewhere (MCP servers).
   */
  jsonSchema?: Record<string, unknown>;
  permissionClass: PermissionClass;
  summarize(input: Input, ctx: ToolContext): ToolCallSummary;
  /** May throw `ToolError` for invalid input (e.g. a path that cannot be resolved). */
  permission(input: Input, ctx: ToolContext): Promise<PermissionSubject> | PermissionSubject;
  preview?(input: Input, ctx: ToolContext): Promise<ToolPreview | undefined>;
  /** Expected failures should throw `ToolError` (returned to the model as an error result). */
  execute(input: Input, ctx: ToolContext): Promise<ToolResult>;
}

/** An expected, model-recoverable tool failure. The message is returned to the model verbatim. */
export class ToolError extends Error {
  override readonly name = 'ToolError';
  readonly display?: ToolDisplay;
  constructor(message: string, display?: ToolDisplay) {
    super(message);
    this.display = display;
  }
}

export function defineTool<Input>(tool: ToolDefinition<Input>): ToolDefinition<Input> {
  return tool;
}
