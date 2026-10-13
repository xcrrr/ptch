import { oneLine, truncateLine, type ToolCallBlock, type ToolResultBlock } from '@patch/shared';
import type { z } from 'zod';
import {
  describeHookFailure,
  type HookFailure,
  type HookRunner,
  type HookToolCall,
} from '../hooks/runner.js';
import type { Logger } from '../logging/logger.js';
import type {
  PermissionDecision,
  PermissionManager,
  PermissionPrompt,
  PermissionRequest,
  PermissionResponse,
} from '../permissions/manager.js';
import type { PlanReviewRequest, PlanReviewResponse } from '../permissions/modes.js';
import type { AppendableEntry } from '../session/schema.js';
import type { ToolRegistry } from '../tools/registry.js';
import {
  ToolError,
  type PermissionSubject,
  type PlanOutcome,
  type ToolCallSummary,
  type ToolContext,
  type ToolDefinition,
  type ToolPreview,
  type ToolResult,
} from '../tools/types.js';
import { ABORTED, attempt, untilAborted } from './abort.js';
import type { AgentEvent, NoticeLevel } from './events.js';

export const INTERRUPTED_TOOL_MESSAGE = 'Interrupted by the user before this tool finished.';
export const DECLINED_TOOL_MESSAGE = 'The user declined this action.';
export const SKIPPED_TOOL_MESSAGE = 'Skipped because the user declined an earlier action.';
export const SKIPPED_AFTER_PLAN_MESSAGE = 'Skipped because the turn ended with the plan.';
export const TRUNCATED_TOOL_MESSAGE =
  'This tool call was cut off because the response hit the output limit before the input was complete. Retry with a smaller input — for large files, write a shorter version first and extend it with edit_file.';
export const BLOCKED_BY_HOOK_MESSAGE =
  'A PreToolUse hook the user configured blocked this call, so it did not run.';
/** Summary of a call blocked by a PreToolUse hook, shown on its row. */
export const BLOCKED_BY_HOOK_SUMMARY = 'blocked by hook';

/** Characters of an unparsable tool input echoed back to the model. */
const RAW_INPUT_ECHO_CHARS = 2_000;

export interface ToolRunnerOptions {
  tools: ToolRegistry;
  permissions: PermissionManager;
  /** Base context; the runner adds `signal` and a per-call `onProgress`. */
  toolContext: Omit<ToolContext, 'signal' | 'onProgress'>;
  logger: Logger;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  /** Persists an entry (Session.append). */
  record: (entry: AppendableEntry) => void;
  requestPermission: (request: PermissionRequest) => Promise<PermissionResponse>;
  /** Asks the user about a plan presented in plan mode (see TurnOptions.reviewPlan). */
  reviewPlan?: (request: PlanReviewRequest) => Promise<PlanReviewResponse>;
  /** The user's hooks: PreToolUse runs once a call is allowed, PostToolUse after it ran. */
  hooks?: HookRunner;
  /** Session id given to hooks. */
  sessionId: string;
}

/**
 * How a batch ended: 'continue' (every call has a result), 'denied' (the user declined without
 * feedback, or kept planning without saying what to change; later calls were skipped), 'ended'
 * (a plan is the outcome of a turn nobody can answer; later calls were skipped) or
 * 'interrupted' (the signal fired during the batch).
 */
export type ToolBatchStatus = 'continue' | 'denied' | 'ended' | 'interrupted';

export interface ToolBatchResult {
  /** One result per call, in call order. */
  results: ToolResultBlock[];
  status: ToolBatchStatus;
  /** Calls that were validated, checked or run (excludes skipped and never-reached calls). */
  processed: number;
}

interface CallState {
  call: ToolCallBlock;
  summary: ToolCallSummary;
  /** Processing of this call began. */
  reached: boolean;
  /** Execution start (ms epoch); unset when the tool never ran. */
  startedAt?: number;
  outcome?: { result: ToolResult; denied: boolean };
  /** Set by the call's plan review when the batch stops after this call. */
  ends?: Verdict;
}

/** A validated call ready for the permission check and execution. */
interface PreparedCall {
  state: CallState;
  tool: ToolDefinition;
  input: unknown;
  ctx: ToolContext;
  /** The one file the call reads or writes, once its permission subject is known (for hooks). */
  file?: string;
}

interface Notice {
  level: NoticeLevel;
  text: string;
  hint?: string;
}

type AllowOrAsk = Exclude<PermissionDecision, { type: 'deny' }>;

/**
 * Ends the batch after a call: 'stop' when the user declined without feedback (or kept planning
 * without saying what to change), 'end' when a plan is the outcome of the turn.
 */
type Verdict = 'stop' | 'end' | undefined;

/**
 * Executes the tool calls of one model response: validation, permission, execution, events and
 * `tool` entries. Never throws for tool-level failures — every call ends with exactly one
 * `tool_end` event, one `tool` entry and one result.
 *
 * Consecutive read-class calls that are allowed without asking run concurrently; anything else
 * waits for that group to finish and runs on its own, so side effects keep their order relative
 * to the reads around them.
 */
export class ToolBatchRunner {
  private readonly options: ToolRunnerOptions;
  /** The concurrent group of allowed reads currently running. */
  private readonly running = new Set<Promise<void>>();

  constructor(options: ToolRunnerOptions) {
    this.options = options;
  }

  private get signal(): AbortSignal {
    return this.options.signal;
  }

  async run(calls: ToolCallBlock[]): Promise<ToolBatchResult> {
    const states = calls.map(newState);
    let stopped: Verdict;
    let processed = 0;
    for (const state of states) {
      if (stopped || this.signal.aborted) break;
      processed++;
      state.reached = true;
      stopped = await this.process(state);
    }
    await this.flush();
    for (const state of states) {
      if (state.outcome) continue;
      const skipped = stopped !== undefined && !state.reached;
      const message = !skipped
        ? INTERRUPTED_TOOL_MESSAGE
        : stopped === 'end'
          ? SKIPPED_AFTER_PLAN_MESSAGE
          : SKIPPED_TOOL_MESSAGE;
      this.settle(state, errorResult(message));
    }
    const status: ToolBatchStatus = this.signal.aborted
      ? 'interrupted'
      : stopped === 'stop'
        ? 'denied'
        : stopped === 'end'
          ? 'ended'
          : 'continue';
    return { results: states.map(toResultBlock), status, processed };
  }

  /** Answers calls without running them (e.g. calls cut off by the output limit). */
  reject(calls: ToolCallBlock[], message: string): ToolResultBlock[] {
    const states = calls.map(newState);
    for (const state of states) this.settle(state, errorResult(message));
    return states.map(toResultBlock);
  }

  private async process(state: CallState): Promise<Verdict> {
    const validated = this.validate(state);
    if (!validated) return;
    const { tool, input } = validated;
    const isRead = tool.permissionClass === 'read';
    if (!isRead && !(await this.flushUnlessAborted())) return;

    const ctx = this.contextFor(state);
    state.summary = this.summarize(tool, input, ctx);
    this.options.emit({
      type: 'tool_start',
      id: state.call.id,
      name: state.call.name,
      summary: state.summary,
      input,
    });
    const prepared: PreparedCall = { state, tool, input, ctx };

    const checked = await this.check(prepared);
    if (!checked) return;
    prepared.file = subjectFile(checked.subject);
    if (checked.decision.type === 'allow' && isRead) {
      this.startConcurrent(prepared);
      return;
    }
    if (!(await this.flushUnlessAborted())) return;
    if (checked.decision.type === 'ask') {
      const approval = await this.approve(prepared, checked.subject, checked.decision.prompt);
      if (approval !== 'run') return approval;
    }
    await this.execute(prepared);
    return prepared.state.ends;
  }

  /** Resolves the tool and parses the input; settles the call with an error when either fails. */
  private validate(state: CallState): { tool: ToolDefinition; input: unknown } | undefined {
    const { call } = state;
    const tool = this.options.tools.get(call.name);
    if (!tool) {
      const available = this.options.tools.names().join(', ') || '(none)';
      this.settle(state, errorResult(`Unknown tool: ${call.name}. Available tools: ${available}.`));
      return undefined;
    }
    if (call.inputError !== undefined) {
      this.settle(state, errorResult(invalidJsonMessage(call)));
      return undefined;
    }
    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      this.settle(state, errorResult(invalidInputMessage(tool.name, parsed.error)));
      return undefined;
    }
    return { tool, input: parsed.data };
  }

  private contextFor(state: CallState): ToolContext {
    return {
      ...this.options.toolContext,
      signal: this.signal,
      onProgress: (progress) => {
        if (state.outcome) return;
        this.options.emit({ type: 'tool_progress', id: state.call.id, progress });
      },
      presentPlan: (plan) => this.presentPlan(state, plan),
    };
  }

  /**
   * present_plan's review. Outside plan mode the plan is only shown. In plan mode the user is
   * asked (callers that cannot ask anyone leave reviewPlan out: the plan then ends the turn as
   * its outcome), and an approval switches to the mode the user chose. Keeping on planning
   * without feedback ends the batch like a declined permission, so the user can say what to
   * change in their next message.
   */
  private async presentPlan(state: CallState, plan: string): Promise<PlanOutcome> {
    const { permissions, reviewPlan } = this.options;
    if (permissions.mode !== 'plan') return { decision: 'shown' };
    let response: PlanReviewResponse | typeof ABORTED = { decision: 'end_turn' };
    if (reviewPlan) {
      const request: PlanReviewRequest = { id: state.call.id, plan };
      this.options.emit({ type: 'plan_review', id: state.call.id, request });
      try {
        response = await untilAborted(
          attempt(() => reviewPlan(request)),
          this.signal,
        );
      } catch (error) {
        // Without an answer the plan is not approved.
        this.options.logger.error('reviewPlan failed', error);
        response = { decision: 'keep_planning' };
      }
    }
    // An interrupted call's result is discarded: nothing may change.
    if (response === ABORTED || this.signal.aborted) return { decision: 'keep_planning' };
    switch (response.decision) {
      case 'approve':
        permissions.setMode(response.mode);
        this.options.emit({ type: 'permission_mode', mode: response.mode });
        break;
      case 'keep_planning':
        if (!response.feedback?.trim()) state.ends = 'stop';
        break;
      case 'end_turn':
        state.ends = 'end';
        break;
    }
    return response;
  }

  private summarize(tool: ToolDefinition, input: unknown, ctx: ToolContext): ToolCallSummary {
    try {
      return tool.summarize(input, ctx);
    } catch (error) {
      this.options.logger.warn(`summarize failed for ${tool.name}`, error);
      return fallbackSummary(tool.name);
    }
  }

  /**
   * Describes the call to the permission layer and gets its decision. Settles the call when the
   * check fails or the decision is a denial; returns undefined then, and on abort.
   */
  private async check(
    prepared: PreparedCall,
  ): Promise<{ subject: PermissionSubject; decision: AllowOrAsk } | undefined> {
    const { state, tool, input, ctx } = prepared;
    const described = await untilAborted(this.subjectFor(tool, input, ctx), this.signal);
    if (described === ABORTED) return undefined;
    if ('error' in described) {
      this.settle(state, errorResult(described.error));
      return undefined;
    }
    const decision = this.evaluate(described.subject, tool);
    if ('error' in decision) {
      this.settle(state, errorResult(decision.error));
      return undefined;
    }
    if (decision.type === 'deny') {
      this.settle(state, errorResult(decision.message), true);
      return undefined;
    }
    return { subject: described.subject, decision };
  }

  private async subjectFor(
    tool: ToolDefinition,
    input: unknown,
    ctx: ToolContext,
  ): Promise<{ subject: PermissionSubject } | { error: string }> {
    try {
      return { subject: await attempt(() => tool.permission(input, ctx)) };
    } catch (error) {
      if (error instanceof ToolError) return { error: error.message };
      this.options.logger.error(`permission() failed for ${tool.name}`, error);
      return { error: `Tool failed: ${messageOf(error)}` };
    }
  }

  private evaluate(
    subject: PermissionSubject,
    tool: ToolDefinition,
  ): PermissionDecision | { error: string } {
    try {
      return this.options.permissions.evaluate(subject, tool.permissionClass);
    } catch (error) {
      this.options.logger.error('Permission evaluation failed', error);
      return { error: `Permission check failed: ${messageOf(error)}` };
    }
  }

  /**
   * Asks the user. Returns 'run' when approved (recording the session grant if one was chosen);
   * otherwise the call is settled (or the signal fired) and the batch verdict is returned.
   */
  private async approve(
    prepared: PreparedCall,
    subject: PermissionSubject,
    prompt: PermissionPrompt,
  ): Promise<'run' | Verdict> {
    const response = await this.ask(prepared, subject, prompt);
    if (response === ABORTED) return undefined;
    if (response.decision === 'deny') {
      const feedback = response.feedback?.trim();
      const message = feedback
        ? `${DECLINED_TOOL_MESSAGE} The user said: ${feedback}`
        : DECLINED_TOOL_MESSAGE;
      this.settle(prepared.state, errorResult(message), true);
      // Without feedback there is nothing to act on, so the turn ends after this batch.
      return feedback ? undefined : 'stop';
    }
    if (response.decision === 'allow_session' && prompt.sessionOption) {
      const { grant, grants } = prompt.sessionOption;
      for (const one of grants ?? [grant]) this.options.permissions.grant(one);
    }
    return 'run';
  }

  private async ask(
    prepared: PreparedCall,
    subject: PermissionSubject,
    prompt: PermissionPrompt,
  ): Promise<PermissionResponse | typeof ABORTED> {
    const { state, tool } = prepared;
    const preview = await untilAborted(this.previewFor(prepared), this.signal);
    if (preview === ABORTED) return ABORTED;
    const request: PermissionRequest = {
      id: state.call.id,
      toolName: tool.name,
      summary: state.summary,
      subject,
      prompt,
      ...(preview ? { preview } : {}),
    };
    this.options.emit({ type: 'tool_permission', id: state.call.id, request });
    try {
      return await untilAborted(
        attempt(() => this.options.requestPermission(request)),
        this.signal,
      );
    } catch (error) {
      // Without an answer the only safe reading is a refusal.
      this.options.logger.error('requestPermission failed', error);
      return { decision: 'deny' };
    }
  }

  /** Best-effort: a failing preview never blocks the permission prompt. */
  private async previewFor({ tool, input, ctx }: PreparedCall): Promise<ToolPreview | undefined> {
    if (!tool.preview) return undefined;
    try {
      return await attempt(() => tool.preview?.(input, ctx));
    } catch (error) {
      this.options.logger.warn(`preview failed for ${tool.name}`, error);
      return undefined;
    }
  }

  private startConcurrent(prepared: PreparedCall): void {
    const task = this.execute(prepared).finally(() => this.running.delete(task));
    this.running.add(task);
  }

  /** Runs an allowed call between its PreToolUse and PostToolUse hooks. */
  private async execute(prepared: PreparedCall): Promise<void> {
    const { state, tool, input, ctx } = prepared;
    state.startedAt = Date.now();
    const blocked = await this.beforeTool(prepared);
    if (blocked !== undefined) {
      this.settle(state, blocked === ABORTED ? errorResult(INTERRUPTED_TOOL_MESSAGE) : blocked);
      return;
    }
    const result = await untilAborted(this.invoke(tool, input, ctx), this.signal);
    if (result === ABORTED) {
      this.settle(state, errorResult(INTERRUPTED_TOOL_MESSAGE));
      return;
    }
    const after = await this.afterTool(prepared, result);
    this.settle(state, after.result);
    for (const notice of after.notices) this.notice(notice);
  }

  /**
   * Runs the PreToolUse hooks of a call the permission check allowed. Returns the call's result
   * when a hook blocked it (exit code 2; its stderr goes to the model), ABORTED when interrupted,
   * and undefined to go ahead.
   */
  private async beforeTool(
    prepared: PreparedCall,
  ): Promise<ToolResult | typeof ABORTED | undefined> {
    const { hooks } = this.options;
    if (!hooks?.has('PreToolUse', prepared.tool.name)) return undefined;
    const run = await untilAborted(
      hooks.run({
        event: 'PreToolUse',
        sessionId: this.options.sessionId,
        signal: this.signal,
        tool: hookCall(prepared),
      }),
      this.signal,
    );
    if (run === ABORTED || run.aborted) return ABORTED;
    for (const notice of failureNotices(run.failures)) this.notice(notice);
    if (!run.blocked) return undefined;
    const reason = run.blocked.message;
    return {
      content: reason
        ? `${BLOCKED_BY_HOOK_MESSAGE} The hook said:\n${reason}`
        : BLOCKED_BY_HOOK_MESSAGE,
      isError: true,
      display: {
        summary: BLOCKED_BY_HOOK_SUMMARY,
        ...(reason ? { lines: reason.split('\n') } : {}),
      },
    };
  }

  /**
   * Runs the PostToolUse hooks of a call that ran. A hook exiting with code 2 cannot undo the
   * call; its stderr is added to the result for the model. Notices are returned so they can
   * follow the call's row.
   */
  private async afterTool(
    prepared: PreparedCall,
    result: ToolResult,
  ): Promise<{ result: ToolResult; notices: Notice[] }> {
    const { hooks } = this.options;
    if (!hooks?.has('PostToolUse', prepared.tool.name)) return { result, notices: [] };
    const summary = resultSummary(result);
    const run = await untilAborted(
      hooks.run({
        event: 'PostToolUse',
        sessionId: this.options.sessionId,
        signal: this.signal,
        tool: hookCall(prepared),
        fields: {
          outcome: result.isError ? 'error' : 'success',
          isError: result.isError === true,
          ...(summary ? { summary } : {}),
        },
      }),
      this.signal,
    );
    if (run === ABORTED) return { result, notices: [] };
    const notices = failureNotices(run.failures);
    if (!run.blocked) return { result, notices };
    const reason = run.blocked.message || '(no message)';
    notices.push({
      level: 'warn',
      text: `PostToolUse hook reported a problem with ${prepared.tool.name}: ${oneLine(reason, 160)}`,
      hint: 'Its message was passed on to the model.',
    });
    return {
      result: {
        ...result,
        content: `${result.content}\n\nA PostToolUse hook the user configured reported a problem after this call:\n${reason}`,
      },
      notices,
    };
  }

  /** Shows a notice and records it so it re-renders on resume. */
  private notice({ level, text, hint }: Notice): void {
    this.options.emit({ type: 'notice', level, text, ...(hint ? { hint } : {}) });
    this.options.record({ type: 'notice', level, text });
  }

  /** Runs the tool; expected and unexpected failures both become error results. */
  private async invoke(
    tool: ToolDefinition,
    input: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      return await attempt(() => tool.execute(input, ctx));
    } catch (error) {
      if (error instanceof ToolError) {
        return {
          content: error.message,
          isError: true,
          ...(error.display ? { display: error.display } : {}),
        };
      }
      this.options.logger.error(`Tool ${tool.name} threw`, error);
      return errorResult(`Tool failed: ${messageOf(error)}`);
    }
  }

  /** Waits for the running reads. Concurrent executions race the signal, so this never hangs. */
  private async flush(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private async flushUnlessAborted(): Promise<boolean> {
    await this.flush();
    return !this.signal.aborted;
  }

  private settle(state: CallState, result: ToolResult, denied = false): void {
    if (state.outcome) return;
    state.outcome = { result, denied };
    const { call, summary } = state;
    const durationMs = state.startedAt === undefined ? 0 : Date.now() - state.startedAt;
    this.options.emit({
      type: 'tool_end',
      id: call.id,
      name: call.name,
      summary,
      result,
      durationMs,
      ...(denied ? { denied: true } : {}),
    });
    this.options.record({
      type: 'tool',
      callId: call.id,
      name: call.name,
      summary,
      isError: result.isError === true,
      ...(denied ? { denied: true } : {}),
      ...(result.display ? { display: result.display } : {}),
      durationMs,
    });
  }
}

function newState(call: ToolCallBlock): CallState {
  return { call, summary: fallbackSummary(call.name), reached: false };
}

function fallbackSummary(name: string): ToolCallSummary {
  return { verb: name, target: '' };
}

function errorResult(content: string): ToolResult {
  return { content, isError: true };
}

/** The one file a read or write works on, when it is a single path that is not a directory. */
function subjectFile(subject: PermissionSubject): string | undefined {
  if (subject.kind !== 'read' && subject.kind !== 'write') return undefined;
  if (subject.paths.length !== 1) return undefined;
  const [path] = subject.paths;
  return path && !path.isDirectory ? path.absolute : undefined;
}

function hookCall({ tool, input, file }: PreparedCall): HookToolCall {
  return { name: tool.name, input, ...(file ? { file } : {}) };
}

/** A short description of a result for PostToolUse hooks: never the content of a file. */
function resultSummary(result: ToolResult): string | undefined {
  if (result.display?.summary) return result.display.summary;
  if (!result.isError) return undefined;
  const first = result.content.split('\n').find((line) => line.trim() !== '');
  return first ? oneLine(first, 200) : undefined;
}

function failureNotices(failures: readonly HookFailure[]): Notice[] {
  return failures.map((failure) => ({ level: 'warn', ...describeHookFailure(failure) }));
}

/** Only called once every state has settled. */
function toResultBlock(state: CallState): ToolResultBlock {
  const { result } = state.outcome!;
  return {
    type: 'tool_result',
    toolCallId: state.call.id,
    content: result.content,
    ...(result.images && result.images.length > 0 ? { images: result.images } : {}),
    ...(result.isError ? { isError: true } : {}),
  };
}

function invalidJsonMessage(call: ToolCallBlock): string {
  const raw = truncateLine(call.rawInput ?? '', RAW_INPUT_ECHO_CHARS);
  return `The tool input was not valid JSON (${call.inputError}). Raw input: ${raw}. Send the call again with valid JSON.`;
}

function invalidInputMessage(toolName: string, error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : 'input';
    return `- ${path}: ${issue.message}`;
  });
  return `Invalid input for ${toolName}:\n${issues.join('\n')}\nFix the input and call the tool again.`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'unknown error';
}
