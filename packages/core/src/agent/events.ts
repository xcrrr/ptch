import type { HostedToolKind, Usage } from '@patch/shared';
import type { ToolCallSummary, ToolDisplay, ToolProgress, ToolResult } from '../tools/types.js';
import type { PermissionRequest } from '../permissions/manager.js';
import type { PermissionMode, PlanReviewRequest } from '../permissions/modes.js';

/** 'blocked': a UserPromptSubmit hook blocked the prompt, which was not sent. */
export type TurnStatus =
  | 'completed'
  | 'interrupted'
  | 'denied'
  | 'error'
  | 'refused'
  | 'max_steps'
  | 'truncated'
  | 'blocked';

export interface TurnResult {
  status: TurnStatus;
  /** Final assistant text of the turn (last model response), possibly empty. */
  finalText: string;
  /** Number of model requests made. */
  steps: number;
  /** Tool calls executed (including failed/denied ones). */
  toolCalls: number;
  usage: Usage;
  /** Friendly error for status 'error'. */
  error?: FriendlyError;
}

/** A user-presentable error: a precise title plus an optional actionable hint. */
export interface FriendlyError {
  title: string;
  hint?: string;
}

export type NoticeLevel = 'info' | 'warn' | 'error';

/**
 * Events emitted by the agent while running a turn, in order. The UI renders from these alone.
 * Text arrives as deltas; a `text_end` closes each contiguous run of assistant text.
 */
export type AgentEvent =
  | { type: 'turn_start'; text: string }
  /** A model request was sent. `step` starts at 1. */
  | { type: 'model_start'; step: number; model: string }
  | { type: 'thinking' }
  /** Model-authored progress note (not raw reasoning). */
  | { type: 'progress'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'text_end' }
  /** A tool call is being streamed by the model (input not complete yet). */
  | { type: 'tool_prepare'; id: string; name: string; inputBytes: number }
  /** A tool call was validated and is about to be checked/run. */
  | { type: 'tool_start'; id: string; name: string; summary: ToolCallSummary; input: unknown }
  /** Waiting for the user to approve. The UI resolves via TurnOptions.requestPermission. */
  | { type: 'tool_permission'; id: string; request: PermissionRequest }
  /** A plan waits for the user's review (plan mode). The UI resolves via TurnOptions.reviewPlan. */
  | { type: 'plan_review'; id: string; request: PlanReviewRequest }
  /** The permission mode changed: the user approved a plan and chose how to continue. */
  | { type: 'permission_mode'; mode: PermissionMode }
  | { type: 'tool_progress'; id: string; progress: ToolProgress }
  | {
      type: 'tool_end';
      id: string;
      name: string;
      summary: ToolCallSummary;
      result: ToolResult;
      durationMs: number;
      /** True when permission was denied (by the user or a rule). */
      denied?: boolean;
    }
  /**
   * The model called a hosted tool (web search or fetch), which the provider runs within the
   * response: no permission check, no local execution. Rendered like a tool row.
   */
  | { type: 'hosted_tool_start'; id: string; kind: HostedToolKind; summary: ToolCallSummary }
  /** A hosted tool finished; `display.summary` is the outcome ("8 results", "14 KB", an error). */
  | {
      type: 'hosted_tool_end';
      id: string;
      kind: HostedToolKind;
      summary: ToolCallSummary;
      display: ToolDisplay;
      isError: boolean;
    }
  | {
      type: 'usage';
      model: string;
      usage: Usage;
      /** Approximate tokens currently in context (prompt + output of the last request). */
      contextTokens: number;
      contextWindow: number;
    }
  | { type: 'notice'; level: NoticeLevel; text: string; hint?: string }
  | { type: 'compaction_start'; auto: boolean }
  | { type: 'compaction'; summary: string; auto: boolean; messagesCompacted: number }
  | { type: 'turn_end'; result: TurnResult };
