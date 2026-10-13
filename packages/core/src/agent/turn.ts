import {
  ProviderError,
  addUsage,
  emptyUsage,
  isAbortError,
  oneLine,
  promptTokens,
  textOf,
  truncateLine,
  type HostedTool,
  type ImageBlock,
  type Message,
  type ModelEvent,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type StopReason,
  type TextBlock,
  type ToolCallBlock,
  type ToolResultBlock,
  type ToolSpec,
  type Usage,
} from '@patch/shared';
import { describeError } from '../errors.js';
import {
  describeHookFailure,
  formatHookOutput,
  type HookRunResult,
  type HookRunner,
} from '../hooks/runner.js';
import type { Logger } from '../logging/logger.js';
import type { PermissionManager } from '../permissions/manager.js';
import { INTERRUPTED_MARKER } from '../session/schema.js';
import type { Session } from '../session/store.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolCallSummary, ToolContext } from '../tools/types.js';
import { ABORTED, streamModel, untilAborted } from './abort.js';
import { hostedToolSummary } from './hosted-tools.js';
import type { CompactOptions, CompactionResult, TurnOptions, UserTurn } from './agent.js';
import { SummaryRejectedError, usageSinceCompaction } from './compaction.js';
import type { AgentEvent, FriendlyError, NoticeLevel, TurnResult, TurnStatus } from './events.js';
import {
  answerUnfinishedToolCalls,
  type AnsweredToolCall,
  type UnfinishedCallOutcome,
} from './repair.js';
import { TRUNCATED_TOOL_MESSAGE, ToolBatchRunner } from './tool-runner.js';

/** Default output cap per request when the caller sets none. */
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
/** Responses in a row whose tool calls were cut off before the turn gives up. */
const MAX_CONSECUTIVE_TRUNCATIONS = 2;
/** Paused responses in a row that the turn continues before it stops. */
export const MAX_PAUSE_CONTINUATIONS = 5;
/**
 * Growth of the context, as a share of the window, after which automatic compaction is tried
 * again before a turn once the model gave no usable summary for it.
 */
const AUTO_COMPACT_RETRY_GROWTH = 0.05;

/** Characters of the final answer passed to Stop hooks. */
const STOP_HOOK_MESSAGE_CHARS = 2_000;

const REFUSAL_HINT = 'Rephrase the request or switch models with /model.';
const CONTEXT_FULL: FriendlyError = {
  title: "The conversation no longer fits in the model's context window.",
  hint: 'Run /compact to summarize earlier context, or /clear to start fresh.',
};

type MessageEnd = Extract<ModelEvent, { type: 'message_end' }>;
type StreamEvent = Exclude<ModelEvent, MessageEnd>;

interface TurnOutcome {
  status: TurnStatus;
  error?: FriendlyError;
}

/** Everything a turn needs from its Agent. */
export interface TurnDeps {
  provider: ModelProvider;
  session: Session;
  tools: ToolRegistry;
  /** Tool specs sent with every request (identical across requests for prompt caching). */
  toolSpecs: () => ToolSpec[];
  /** Hosted tools sent with every agent request (fixed, like the tool specs). */
  hostedTools: readonly HostedTool[];
  permissions: PermissionManager;
  toolContext: Omit<ToolContext, 'signal' | 'onProgress'>;
  logger: Logger;
  maxSteps: number;
  maxOutputTokens?: number;
  autoCompact: boolean;
  autoCompactThreshold: number;
  /** Shared across turns; updated by the turn, cleared by the Agent after any compaction. */
  autoCompactBackoff: AutoCompactBackoff;
  compact: (options: CompactOptions) => Promise<CompactionResult>;
  /** The user's hooks (UserPromptSubmit, Stop, and the tool hooks). */
  hooks?: HookRunner;
  /**
   * Notes from SessionStart hooks not sent yet: taken (and cleared) when the turn appends the
   * user's message.
   */
  takeSessionNotes?: () => string[];
  /**
   * The note telling the model that plan mode was turned on or off since it last heard, if it
   * was; asked for when the turn appends the user's message (after any automatic compaction).
   */
  planModeNotes?: () => string[];
}

/**
 * When the model last answered an automatic compaction before a turn without a usable summary
 * (declined, cut off or empty). Asking again with nearly the same conversation would most likely
 * fail the same way while billing two requests the size of the context, so turns skip it until
 * the context has grown noticeably (a request that overflows the window still compacts).
 */
export interface AutoCompactBackoff {
  /** Context tokens at the rejected attempt. */
  rejectedAt?: number;
}

/** Delivers events to the listener; nothing gets through after `turn_end`. */
class TurnEmitter {
  private closed = false;
  private readonly listener: (event: AgentEvent) => void;
  private readonly logger: Logger;

  constructor(listener: (event: AgentEvent) => void, logger: Logger) {
    this.listener = listener;
    this.logger = logger;
  }

  emit(event: AgentEvent): void {
    if (this.closed) return;
    if (event.type === 'turn_end') this.closed = true;
    try {
      this.listener(event);
    } catch (error) {
      this.logger.error(`Event listener failed on ${event.type}`, error);
    }
  }
}

/**
 * Tracks the streamed parts of one response: contiguous text runs, tool names by call id, and the
 * hosted tool calls (by id) it reported.
 */
class ResponseStream {
  private readonly runs: string[] = [];
  private textOpen = false;
  private readonly toolNames = new Map<string, string>();
  private readonly hostedCalls = new Map<string, ToolCallSummary>();
  private readonly emit: (event: AgentEvent) => void;

  constructor(emit: (event: AgentEvent) => void) {
    this.emit = emit;
  }

  handle(event: StreamEvent): void {
    switch (event.type) {
      case 'message_start':
        return;
      case 'thinking':
        this.closeText();
        this.emit({ type: 'thinking' });
        return;
      case 'progress':
        this.closeText();
        this.emit({ type: 'progress', text: event.text });
        return;
      case 'text_delta':
        if (event.text === '') return;
        if (!this.textOpen) {
          this.runs.push('');
          this.textOpen = true;
        }
        this.runs[this.runs.length - 1] += event.text;
        this.emit({ type: 'text_delta', text: event.text });
        return;
      case 'tool_call_start':
        this.closeText();
        this.toolNames.set(event.id, event.name);
        this.emit({ type: 'tool_prepare', id: event.id, name: event.name, inputBytes: 0 });
        return;
      case 'tool_call_delta':
        this.emit({
          type: 'tool_prepare',
          id: event.id,
          name: this.toolNames.get(event.id) ?? '',
          inputBytes: event.inputBytes,
        });
        return;
      case 'hosted_tool_start': {
        this.closeText();
        const summary = hostedToolSummary(event.kind, event.detail);
        this.hostedCalls.set(event.id, summary);
        this.emit({ type: 'hosted_tool_start', id: event.id, kind: event.kind, summary });
        return;
      }
      case 'hosted_tool_end':
        this.closeText();
        this.emit({
          type: 'hosted_tool_end',
          id: event.id,
          kind: event.kind,
          summary: this.hostedCalls.get(event.id) ?? hostedToolSummary(event.kind, ''),
          display: { summary: event.summary },
          isError: event.isError,
        });
        return;
    }
  }

  closeText(): void {
    if (!this.textOpen) return;
    this.textOpen = false;
    this.emit({ type: 'text_end' });
  }

  /** Text runs streamed so far that carry visible content. */
  partialText(): string[] {
    return this.runs.filter((run) => run.trim() !== '');
  }
}

/**
 * One user turn of the agent loop. History changes are appends only: the provider binds
 * reasoning and prompt caching to the exact prefix, so earlier messages are never edited,
 * reordered or dropped, and every stored tool call is answered by the next stored message.
 */
export class TurnRunner {
  private readonly deps: TurnDeps;
  private readonly options: TurnOptions;
  private readonly emitter: TurnEmitter;
  private usage: Usage = emptyUsage();
  private steps = 0;
  private toolCalls = 0;
  private finalText = '';
  private consecutiveTruncations = 0;
  private consecutivePauses = 0;
  /** Tool calls of the last stored assistant message that are not answered yet. */
  private unanswered: ToolCallBlock[] = [];
  /** The user's message while no response to it is stored yet. */
  private unansweredUserText: string | undefined;
  /** Notes sent with the user's message (UserTurn.notes), blank ones dropped. */
  private notes: string[] = [];
  /** Images sent with the user's message (UserTurn.images). */
  private images: ImageBlock[] = [];
  /** A request of this turn overflowed the context window and the turn compacted for it. */
  private compactedForOverflow = false;
  /** A Stop hook made the turn continue (allowed once per turn, so hooks cannot loop it). */
  private continuedByStopHook = false;

  constructor(deps: TurnDeps, options: TurnOptions) {
    this.deps = deps;
    this.options = options;
    this.emitter = new TurnEmitter(options.onEvent, deps.logger);
  }

  private get signal(): AbortSignal {
    return this.options.signal;
  }

  private get session(): Session {
    return this.deps.session;
  }

  /** Runs the turn to completion. Never throws. */
  async run(turn: UserTurn): Promise<TurnResult> {
    this.emit({ type: 'turn_start', text: turn.text });
    let outcome: TurnOutcome;
    try {
      outcome = await this.execute(turn);
    } catch (error) {
      outcome = this.recover(error);
    }
    const result: TurnResult = {
      status: outcome.status,
      finalText: this.finalText,
      steps: this.steps,
      toolCalls: this.toolCalls,
      usage: this.usage,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
    this.emit({ type: 'turn_end', result });
    return result;
  }

  private async execute(turn: UserTurn): Promise<TurnOutcome> {
    if (turn.text.trim() === '') {
      return { status: 'error', error: { title: 'Nothing to send: the message is empty.' } };
    }
    this.notes = (turn.notes ?? []).filter((note) => note.trim() !== '');
    this.images = turn.images ?? [];
    // Before anything is appended: a prompt a hook blocks leaves the history as it was.
    const submitted = await this.runPromptHooks(turn.text);
    if ('status' in submitted) return submitted;
    this.answerUnfinishedToolCalls();
    await this.autoCompact();
    this.notes.push(
      ...(this.deps.planModeNotes?.() ?? []),
      ...(this.deps.takeSessionNotes?.() ?? []),
      ...submitted.notes,
    );
    // Last, so neither the repair nor the summary can come between the notes and the text.
    this.appendUserText(turn.text);
    for (let step = 1; step <= this.deps.maxSteps; step++) {
      if (this.signal.aborted) return this.interrupt();
      const outcome = await this.step(step);
      if (outcome) return outcome;
    }
    this.notice(
      'warn',
      `Stopped after ${this.deps.maxSteps} steps. Send a message to let Patch continue.`,
    );
    return { status: 'max_steps' };
  }

  /**
   * Runs the UserPromptSubmit hooks. A hook exiting with code 2 drops the prompt (its stderr is
   * shown to the user); the output of the others goes with the prompt as notes.
   */
  private async runPromptHooks(text: string): Promise<TurnOutcome | { notes: string[] }> {
    if (!this.deps.hooks?.has('UserPromptSubmit')) return { notes: [] };
    const run = await this.runHooks('UserPromptSubmit', { prompt: text });
    if (!run) return { status: 'interrupted' };
    if (run.blocked) {
      this.notice(
        'warn',
        'A UserPromptSubmit hook blocked this prompt, so it was not sent.',
        run.blocked.message || undefined,
      );
      return { status: 'blocked' };
    }
    return {
      notes: run.outputs.map((output) =>
        formatHookOutput(
          'UserPromptSubmit',
          "Context from the user's UserPromptSubmit hook:",
          output,
        ),
      ),
    };
  }

  /**
   * Runs the Stop hooks once the model has finished its reply. A hook exiting with code 2 makes
   * the model continue, with the hook's stderr as the instruction; once per turn, so hooks that
   * keep asking cannot hold the turn in a loop. Undefined = keep going.
   */
  private async runStopHooks(completed: TurnOutcome): Promise<TurnOutcome | undefined> {
    if (!this.deps.hooks?.has('Stop')) return completed;
    const run = await this.runHooks('Stop', {
      stopHookActive: this.continuedByStopHook,
      lastAssistantMessage: truncateLine(this.finalText, STOP_HOOK_MESSAGE_CHARS),
    });
    if (!run) return { status: 'interrupted' };
    if (!run.blocked) return completed;
    if (this.continuedByStopHook) {
      this.notice(
        'warn',
        'A Stop hook asked Patch to continue again; Patch stopped instead.',
        'Stop hooks can make Patch continue once per message.',
      );
      return completed;
    }
    this.continuedByStopHook = true;
    const instruction = run.blocked.message;
    this.notice(
      'info',
      instruction
        ? `A Stop hook asked Patch to continue: ${oneLine(instruction, 160)}`
        : 'A Stop hook asked Patch to continue.',
    );
    this.appendMessage({
      role: 'user',
      content: [
        {
          type: 'text',
          text: formatHookOutput(
            'Stop',
            "The user's Stop hook asks you to continue before you finish:",
            instruction || 'Continue with the task.',
          ),
        },
      ],
    });
    return undefined;
  }

  /** Runs the hooks of an event and reports the ones that failed; undefined when interrupted. */
  private async runHooks(
    event: 'UserPromptSubmit' | 'Stop',
    fields: Record<string, unknown>,
  ): Promise<HookRunResult | undefined> {
    const { hooks } = this.deps;
    if (!hooks) return { outputs: [], failures: [], aborted: false };
    const run = await untilAborted(
      hooks.run({ event, sessionId: this.session.id, signal: this.signal, fields }),
      this.signal,
    );
    if (run === ABORTED || run.aborted) return undefined;
    for (const failure of run.failures) {
      const { text, hint } = describeHookFailure(failure);
      this.notice('warn', text, hint);
    }
    return run;
  }

  /**
   * A previous Patch process stopped while tool calls were running (crash, kill), so the history
   * ends with calls nobody answered and every request would be rejected. Answer them first.
   */
  private answerUnfinishedToolCalls(): void {
    const answered = answerUnfinishedToolCalls(this.session);
    if (answered.length === 0) return;
    this.deps.logger.warn('Answered tool calls left unfinished by a previous process', {
      calls: answered.map(({ call, outcome }) => `${call.name} (${outcome})`),
    });
    this.notice('warn', unfinishedCallsNotice(answered));
  }

  private async autoCompact(): Promise<void> {
    if (!this.deps.autoCompact) return;
    const last = usageSinceCompaction(this.session.entries());
    const window = this.modelInfo().contextWindow;
    if (!last || window <= 0) return;
    const tokens = promptTokens(last) + last.outputTokens;
    if (tokens <= this.deps.autoCompactThreshold * window) return;
    const { rejectedAt } = this.deps.autoCompactBackoff;
    if (rejectedAt !== undefined && tokens < rejectedAt + AUTO_COMPACT_RETRY_GROWTH * window) {
      return;
    }
    // An interruption is reported by the step loop, which sees the aborted signal.
    await this.compactAutomatically(
      'Patch continued without compacting. Run /compact to try again.',
      tokens,
    );
  }

  /**
   * Runs an automatic compaction and counts its usage, including that of summary requests that
   * produced no summary. False when it failed (reported as a warning with `failureHint`) or was
   * interrupted (left to the caller, which sees the signal). `contextTokens` is set for the
   * compaction before a turn: a rejected summary then holds off the next ones (see
   * AutoCompactBackoff).
   */
  private async compactAutomatically(
    failureHint?: string,
    contextTokens?: number,
  ): Promise<boolean> {
    try {
      await this.deps.compact({
        signal: this.signal,
        auto: true,
        onEvent: (event) => this.emit(event),
        onUsage: (billed) => {
          this.usage = addUsage(this.usage, billed);
        },
      });
      return true;
    } catch (error) {
      if (this.signal.aborted || isAbortError(error)) return false;
      if (error instanceof SummaryRejectedError && contextTokens !== undefined) {
        this.deps.autoCompactBackoff.rejectedAt = contextTokens;
      }
      this.deps.logger.warn('Automatic compaction failed', error);
      const friendly = describeError(error, { model: this.session.model });
      this.notice('warn', `Automatic compaction failed: ${friendly.title}`, failureHint);
      return false;
    }
  }

  /** One model request and everything that follows from its response. Undefined = keep going. */
  private async step(step: number): Promise<TurnOutcome | undefined> {
    this.steps = step;
    // Each request reports its own response: a refused or failed step has no final text.
    this.finalText = '';
    const model = this.session.model;
    const request: ModelRequest = {
      model,
      system: this.session.meta.system,
      messages: this.session.history(),
      tools: this.deps.toolSpecs(),
      ...(this.deps.hostedTools.length > 0 ? { hostedTools: [...this.deps.hostedTools] } : {}),
      maxOutputTokens: this.deps.maxOutputTokens ?? defaultMaxOutputTokens(this.modelInfo()),
      purpose: 'agent',
    };
    this.emit({ type: 'model_start', step, model });

    const stream = new ResponseStream((event) => this.emit(event));
    let end: MessageEnd | undefined;
    try {
      for await (const event of streamModel(this.deps.provider, request, this.signal)) {
        if (event.type === 'message_end') {
          end = event;
          break;
        }
        stream.handle(event);
      }
      if (!end) throw new Error('The model response ended without a final message.');
    } catch (error) {
      stream.closeText();
      if (this.overflowedContext(error) && (await this.compactAfterOverflow())) {
        return this.step(step);
      }
      return this.streamFailed(error, stream.partialText());
    }
    stream.closeText();
    return this.responded(end);
  }

  /**
   * The request was rejected for not fitting in the context window. Auto-compaction before the
   * turn only sees the size of the last successful request, which misses large tool results (or
   * a large message) added since, so such a session would fail the same way on every turn.
   */
  private overflowedContext(error: unknown): boolean {
    return (
      this.deps.autoCompact &&
      !this.compactedForOverflow &&
      !this.signal.aborted &&
      error instanceof ProviderError &&
      error.kind === 'context_length'
    );
  }

  /**
   * Compacts (once per turn) so the failed step can be sent again. The summary covers everything
   * stored so far; the user's message (with the turn's notes) is sent again after it while no
   * response to it is stored, so the model answers the exact request. Later in the turn only the
   * notes are sent again: they still apply (a working-directory update, for example) and the
   * summary need not repeat them. False when compaction failed or was interrupted: the original
   * error is then reported.
   */
  private async compactAfterOverflow(): Promise<boolean> {
    this.compactedForOverflow = true;
    const pending = this.unansweredUserText;
    if (!(await this.compactAutomatically())) return false;
    if (pending !== undefined) {
      this.appendUserText(pending);
    } else if (this.notes.length > 0) {
      this.appendMessage({ role: 'user', content: this.noteBlocks() });
    }
    return true;
  }

  private streamFailed(error: unknown, partialText: string[]): TurnOutcome {
    if (this.signal.aborted || isAbortError(error)) {
      if (partialText.length > 0) {
        this.appendMessage({
          role: 'assistant',
          content: partialText.map((text) => ({ type: 'text', text })),
        });
        this.finalText = partialText.join('');
      }
      return this.interrupt();
    }
    this.deps.logger.error('Model request failed', error);
    const friendly = describeError(error, { model: this.session.model });
    this.notice('error', friendly.title, friendly.hint);
    return { status: 'error', error: friendly };
  }

  private async responded(end: MessageEnd): Promise<TurnOutcome | undefined> {
    this.unansweredUserText = undefined;
    this.recordUsage(end);
    if (end.stopReason === 'refusal') {
      this.surfaceNotices(end);
      return this.refused(end);
    }

    const { message } = end;
    this.finalText = textOf(message);
    const calls = message.content.filter(
      (block): block is ToolCallBlock => block.type === 'tool_call',
    );
    // An assistant message without content cannot be sent back to a provider.
    if (message.content.length > 0) {
      this.appendMessage(message);
      this.unanswered = calls;
    }
    this.surfaceNotices(end);

    const cutOff = end.stopReason === 'max_tokens' || end.stopReason === 'context_window_exceeded';
    if (calls.length > 0 && cutOff) return this.rejectCutOffCalls(calls);
    this.consecutiveTruncations = 0;
    if (end.stopReason !== 'pause') this.consecutivePauses = 0;
    if (calls.length === 0) {
      const outcome = this.finished(end.stopReason);
      return outcome?.status === 'completed' ? this.runStopHooks(outcome) : outcome;
    }
    return this.runTools(calls);
  }

  private recordUsage(end: MessageEnd): void {
    // Costs count every billed attempt; context accounting uses the attempt that served the turn.
    const billed = end.billedUsage ?? end.usage;
    this.session.append({
      type: 'usage',
      model: end.model,
      usage: end.usage,
      ...(end.billedUsage ? { billed: end.billedUsage } : {}),
    });
    this.usage = addUsage(this.usage, billed);
    this.emit({
      type: 'usage',
      model: end.model,
      usage: billed,
      contextTokens: promptTokens(end.usage) + end.usage.outputTokens,
      contextWindow: this.modelInfo().contextWindow,
    });
  }

  /** Non-fatal provider notices, e.g. that a fallback model served the response. */
  private surfaceNotices(end: MessageEnd): void {
    for (const text of end.notices ?? []) this.notice('info', text);
  }

  /** Refused output is discarded (not stored), as the provider asks. */
  private refused(end: MessageEnd): TurnOutcome {
    const category = end.refusal?.category;
    const detail = category ? ` Category: ${category}.` : '';
    this.notice('warn', `The model declined this request.${detail}`, REFUSAL_HINT);
    return { status: 'refused' };
  }

  private finished(stopReason: StopReason): TurnOutcome | undefined {
    switch (stopReason) {
      case 'max_tokens':
        this.notice(
          'warn',
          'The response was cut off at the output token limit.',
          'Send a message to let Patch continue.',
        );
        return { status: 'truncated' };
      case 'context_window_exceeded':
        this.notice('error', CONTEXT_FULL.title, CONTEXT_FULL.hint);
        return { status: 'error', error: CONTEXT_FULL };
      case 'pause':
        return this.paused();
      default:
        return { status: 'completed' };
    }
  }

  /**
   * The provider paused a long response, typically while its hosted tools work. The paused
   * message is stored like any response, and the next request continues it: the provider resumes
   * from the end of the conversation, so no user message may go between. After
   * MAX_PAUSE_CONTINUATIONS continuations in a row the turn stops instead; the next message then
   * starts a new exchange (the provider closes whatever the pause left open).
   */
  private paused(): TurnOutcome | undefined {
    this.consecutivePauses++;
    if (this.consecutivePauses <= MAX_PAUSE_CONTINUATIONS) return undefined;
    this.notice(
      'warn',
      `Stopped after the model paused ${this.consecutivePauses} times in a row.`,
      'Send a message to let Patch continue.',
    );
    return { status: 'max_steps' };
  }

  private rejectCutOffCalls(calls: ToolCallBlock[]): TurnOutcome | undefined {
    const results = this.toolRunner().reject(calls, TRUNCATED_TOOL_MESSAGE);
    this.appendToolResults(results, false);
    this.consecutiveTruncations++;
    if (this.consecutiveTruncations < MAX_CONSECUTIVE_TRUNCATIONS) return undefined;
    this.notice(
      'warn',
      "Stopped because the model's tool calls were cut off at the output token limit twice in a row.",
      'Ask for smaller steps, for example writing a large file in parts.',
    );
    return { status: 'truncated' };
  }

  private async runTools(calls: ToolCallBlock[]): Promise<TurnOutcome | undefined> {
    const batch = await this.toolRunner().run(calls);
    this.toolCalls += batch.processed;
    this.appendToolResults(batch.results, batch.status === 'interrupted');
    if (batch.status === 'continue') return undefined;
    // A plan nobody here can answer is what the turn produced.
    return { status: batch.status === 'ended' ? 'completed' : batch.status };
  }

  private toolRunner(): ToolBatchRunner {
    return new ToolBatchRunner({
      tools: this.deps.tools,
      permissions: this.deps.permissions,
      toolContext: this.deps.toolContext,
      logger: this.deps.logger,
      signal: this.signal,
      emit: (event) => this.emit(event),
      record: (entry) => this.session.append(entry),
      requestPermission: this.options.requestPermission,
      reviewPlan: this.options.reviewPlan,
      hooks: this.deps.hooks,
      sessionId: this.session.id,
    });
  }

  /** One user message answering every call; the interruption marker follows the results. */
  private appendToolResults(results: ToolResultBlock[], interrupted: boolean): void {
    this.appendMessage({
      role: 'user',
      content: interrupted ? [...results, { type: 'text', text: INTERRUPTED_MARKER }] : results,
    });
    this.unanswered = [];
  }

  private interrupt(): TurnOutcome {
    this.appendMessage({ role: 'user', content: [{ type: 'text', text: INTERRUPTED_MARKER }] });
    return { status: 'interrupted' };
  }

  /** Unexpected failure: report it and leave a history the provider still accepts. */
  private recover(error: unknown): TurnOutcome {
    this.deps.logger.error('Turn failed unexpectedly', error);
    const friendly = describeError(error, { model: this.safeModel() });
    try {
      if (this.unanswered.length > 0) {
        const content = `Tool execution failed unexpectedly: ${friendly.title}`;
        this.appendToolResults(
          this.unanswered.map((call) => ({
            type: 'tool_result',
            toolCallId: call.id,
            content,
            isError: true,
          })),
          false,
        );
      }
      this.notice('error', friendly.title, friendly.hint);
    } catch (secondary) {
      this.deps.logger.error('Could not record the turn failure', secondary);
    }
    return { status: 'error', error: friendly };
  }

  private safeModel(): string | undefined {
    try {
      return this.session.model;
    } catch {
      return undefined;
    }
  }

  private modelInfo(): ModelInfo {
    return this.deps.provider.getModelInfo(this.session.model);
  }

  private appendMessage(message: Message): void {
    this.session.append({ type: 'message', message });
  }

  /** The user's message: the turn's notes, its images, then its text. */
  private appendUserText(text: string): void {
    this.appendMessage({
      role: 'user',
      content: [...this.noteBlocks(), ...this.images, { type: 'text', text }],
    });
    this.unansweredUserText = text;
  }

  private noteBlocks(): TextBlock[] {
    return this.notes.map((note) => ({ type: 'text', text: note }));
  }

  /** Shows a notice and records it so it re-renders on resume. */
  private notice(level: NoticeLevel, text: string, hint?: string): void {
    this.emit({ type: 'notice', level, text, ...(hint ? { hint } : {}) });
    this.session.append({ type: 'notice', level, text });
  }

  private emit(event: AgentEvent): void {
    this.emitter.emit(event);
  }
}

/**
 * The notice for tool calls a stopped process left unanswered, e.g. "Patch stopped last time
 * before the results of 3 tool calls were recorded (2 finished, 1 unfinished). ...".
 */
function unfinishedCallsNotice(answered: AnsweredToolCall[]): string {
  const count = (...outcomes: UnfinishedCallOutcome[]) =>
    answered.filter(({ outcome }) => outcomes.includes(outcome)).length;
  const parts: [number, string][] = [
    [count('succeeded', 'failed'), 'finished'],
    [count('declined'), 'declined'],
    [count('unknown'), 'unfinished'],
  ];
  const details = parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(', ');
  const one = answered.length === 1;
  const subject = one
    ? 'the result of 1 tool call was'
    : `the results of ${answered.length} tool calls were`;
  return (
    `Patch stopped last time before ${subject} recorded (${details}). ` +
    `The model was told to check the current state before repeating ${one ? 'it' : 'them'}.`
  );
}

function defaultMaxOutputTokens(info: ModelInfo): number {
  return info.maxOutputTokens > 0
    ? Math.min(DEFAULT_MAX_OUTPUT_TOKENS, info.maxOutputTokens)
    : DEFAULT_MAX_OUTPUT_TOKENS;
}
