import {
  emptyUsage,
  promptTokens,
  stripAnsi,
  truncateMiddle,
  type HostedTool,
  type ImageBlock,
  type ModelProvider,
  type ToolSpec,
  type Usage,
} from '@patch/shared';
import { describeHookFailure, formatHookOutput, type HookRunner } from '../hooks/runner.js';
import { noopLogger, type Logger } from '../logging/logger.js';
import type {
  PermissionManager,
  PermissionRequest,
  PermissionResponse,
} from '../permissions/manager.js';
import type { PlanReviewRequest, PlanReviewResponse } from '../permissions/modes.js';
import { USER_SHELL_CONTEXT_TAG } from '../session/schema.js';
import type { Session } from '../session/store.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
import {
  COMPACTION_MAX_OUTPUT_TOKENS,
  COMPACTION_RETRY_MAX_OUTPUT_TOKENS,
  addSummaryUsage,
  summarizeConversation,
  usageSinceCompaction,
  type ConversationSummary,
  type SummaryUsage,
} from './compaction.js';
import type { AgentEvent, TurnResult } from './events.js';
import { planModeInHistory, planModeNote } from './plan-mode.js';
import { answerUnfinishedToolCalls } from './repair.js';
import { TurnRunner, type AutoCompactBackoff } from './turn.js';

export interface AgentOptions {
  provider: ModelProvider;
  session: Session;
  tools: ToolRegistry;
  /**
   * Hosted tools (web search, web fetch) offered with every agent request, after `tools`. Fixed
   * for the agent's lifetime, like the tool list. Default none.
   */
  hostedTools?: readonly HostedTool[];
  permissions: PermissionManager;
  /** Base tool context; the agent adds `signal` and `onProgress` per call. */
  toolContext: Omit<ToolContext, 'signal' | 'onProgress'>;
  logger?: Logger;
  /** Safety cap on model requests per user turn. Default 200. */
  maxStepsPerTurn?: number;
  /** Output token cap per request. Default min(64000, model maxOutputTokens). */
  maxOutputTokens?: number;
  /**
   * Compact automatically before a turn when the context is nearly full, and once during a turn
   * when a request is rejected for not fitting in the context window. Default true.
   */
  autoCompact?: boolean;
  /** Fraction of the context window that triggers auto-compaction. Default 0.85. */
  autoCompactThreshold?: number;
  /** The user's hooks (see HookRunner). None run without it. */
  hooks?: HookRunner;
}

/** How a session started, as told to SessionStart hooks. */
export type SessionStartSource = 'startup' | 'resume' | 'clear';

export interface SessionStartOptions {
  signal: AbortSignal;
  /** Receives notices about hooks that failed. */
  onEvent?: (event: AgentEvent) => void;
}

export interface TurnOptions {
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  /**
   * Called when a tool call needs approval. Must resolve (never hang) — the agent also races it
   * against `signal`. Non-interactive callers resolve `{ decision: 'deny' }`.
   */
  requestPermission: (request: PermissionRequest) => Promise<PermissionResponse>;
  /**
   * Called when the model presents a plan (present_plan) in plan mode; the agent switches to the
   * mode an approval names. Must resolve (never hang); also raced against `signal`. Callers that
   * cannot ask anyone leave it out: the plan then ends the turn as its outcome (status
   * 'completed'). Outside plan mode plans are only shown, without asking.
   */
  reviewPlan?: (request: PlanReviewRequest) => Promise<PlanReviewResponse>;
}

export interface UserTurn {
  text: string;
  /**
   * Context for the model that goes with this turn, such as a working-directory update. Each note
   * becomes a text block before `text` in the user message the turn appends, which comes after
   * any repair of tool calls a stopped process left unanswered and after any automatic
   * compaction, so neither can separate the notes from the user's text or drop them. When a
   * request of the turn overflows the context window and the turn compacts, the notes are sent
   * again after the summary. Blank notes are ignored. Session titles skip notes that start with
   * WORKING_DIRECTORY_TAG, HOOK_OUTPUT_TAG or PLAN_MODE_TAG. The agent adds a note of its own
   * after these when plan mode was turned on or off since the model last heard (see
   * planModeInHistory), then the output of SessionStart and UserPromptSubmit hooks.
   */
  notes?: string[];
  /**
   * Images the user attached. They go in the same message, after the notes and before `text`
   * (models read images best before the question about them), and are sent again with the text
   * when an overflowing request makes the turn compact.
   */
  images?: ImageBlock[];
}

export interface CompactOptions {
  signal: AbortSignal;
  /** Extra focus instructions from `/compact <instructions>`. */
  instructions?: string;
  auto?: boolean;
  onEvent?: (event: AgentEvent) => void;
  /**
   * Called with the tokens billed for the summary requests when they are recorded (a `usage`
   * entry with purpose 'summary'), also when the compaction then fails: the requests were billed
   * all the same.
   */
  onUsage?: (billed: Usage) => void;
}

export interface CompactionResult {
  summary: string;
  messagesCompacted: number;
  /** Tokens billed for the summary requests (a retry and server-side fallbacks included). */
  usage: Usage;
}

/** A command the user ran with `!`, as passed to `recordUserShellCommand`. */
export interface UserShellCommand {
  command: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
}

const DEFAULT_MAX_STEPS = 200;
const DEFAULT_AUTO_COMPACT_THRESHOLD = 0.85;

/** Output of a `!` command kept as model context. */
const SHELL_CONTEXT_MAX_LINES = 200;
const SHELL_CONTEXT_MAX_LINE_CHARS = 2_000;
const SHELL_CONTEXT_MAX_CHARS = 50_000;

/**
 * The agent loop:
 *
 *   user message → model → tool calls? → (permission → execute) → tool results → model → ...
 *
 * until the model answers without tool calls. All history mutations are appends to the session
 * (the conversation prefix sent to the provider is never edited), which keeps prompt caching
 * effective and satisfies providers that bind reasoning to the exact prefix.
 *
 * One operation runs at a time: a turn or a compaction. Shell commands recorded while one is
 * running are appended when it ends, so they can never split a tool call from its results.
 */
export class Agent {
  readonly provider: ModelProvider;
  readonly session: Session;
  readonly tools: ToolRegistry;
  readonly hostedTools: readonly HostedTool[];
  readonly permissions: PermissionManager;
  private readonly options: AgentOptions;
  private readonly logger: Logger;
  private toolSpecCache: ToolSpec[] | undefined;
  private activity: 'turn' | 'compaction' | undefined;
  private readonly deferredShellCommands: UserShellCommand[] = [];
  /** Shared by the turns: when automatic compaction last got no usable summary. */
  private readonly autoCompactBackoff: AutoCompactBackoff = {};
  /** Output of SessionStart hooks, sent as notes with the next user message. */
  private sessionNotes: string[] = [];

  constructor(options: AgentOptions) {
    this.options = options;
    this.provider = options.provider;
    this.session = options.session;
    this.tools = options.tools;
    // A copy: the caller's list could otherwise change the requests mid-session.
    this.hostedTools = structuredClone([...(options.hostedTools ?? [])]);
    this.permissions = options.permissions;
    this.logger = (options.logger ?? noopLogger).child('agent');
  }

  get model(): string {
    return this.session.model;
  }

  /** Switches the model for subsequent requests (persisted as a `model` entry). */
  setModel(model: string): void {
    if (model === this.session.model) return;
    this.session.append({ type: 'model', model });
    // Another model may well summarize what this one could not.
    this.autoCompactBackoff.rejectedAt = undefined;
  }

  /**
   * Runs one user turn to completion. Never throws: failures are reported through events and
   * the returned TurnResult (status 'error' with a FriendlyError).
   */
  async runTurn(turn: UserTurn, options: TurnOptions): Promise<TurnResult> {
    if (this.activity) return this.rejectBusyTurn(options);
    this.activity = 'turn';
    try {
      const runner = new TurnRunner(
        {
          provider: this.provider,
          session: this.session,
          tools: this.tools,
          toolSpecs: () => this.toolSpecs(),
          hostedTools: this.hostedTools,
          permissions: this.permissions,
          toolContext: this.options.toolContext,
          logger: this.logger,
          maxSteps: this.options.maxStepsPerTurn ?? DEFAULT_MAX_STEPS,
          maxOutputTokens: this.options.maxOutputTokens,
          autoCompact: this.options.autoCompact ?? true,
          autoCompactThreshold: this.options.autoCompactThreshold ?? DEFAULT_AUTO_COMPACT_THRESHOLD,
          autoCompactBackoff: this.autoCompactBackoff,
          compact: (compactOptions) => this.runCompaction(compactOptions),
          hooks: this.options.hooks,
          takeSessionNotes: () => this.sessionNotes.splice(0),
          planModeNotes: () => this.planModeNotes(),
        },
        options,
      );
      return await runner.run(turn);
    } finally {
      this.finishActivity();
    }
  }

  /**
   * Runs the SessionStart hooks (`source`: how the session started). What they print goes to the
   * model with the next user message, as notes of that turn; failures are reported as notices.
   * Never throws.
   */
  async runSessionStartHooks(
    source: SessionStartSource,
    options: SessionStartOptions,
  ): Promise<void> {
    const hooks = this.options.hooks;
    if (!hooks?.has('SessionStart')) return;
    const emit = (event: AgentEvent) => this.emitTo(options.onEvent, event);
    const run = await hooks.run({
      event: 'SessionStart',
      sessionId: this.session.id,
      signal: options.signal,
      fields: { source },
    });
    for (const failure of run.failures) {
      emit({ type: 'notice', level: 'warn', ...describeHookFailure(failure) });
    }
    if (run.blocked) {
      // Exit code 2 cannot stop a session from starting: reported like a failure.
      const { text } = describeHookFailure({ hook: run.blocked.hook, reason: 'exit 2' });
      emit({
        type: 'notice',
        level: 'warn',
        text,
        ...(run.blocked.message ? { hint: run.blocked.message } : {}),
      });
    }
    this.sessionNotes.push(
      ...run.outputs.map((output) =>
        formatHookOutput('SessionStart', "Context from the user's SessionStart hook:", output),
      ),
    );
  }

  /**
   * Records the output of a user-run `!` command as context for the next model request
   * (appends a `shell` entry and a user message describing the command and its output).
   */
  recordUserShellCommand(entry: UserShellCommand): void {
    if (this.activity) {
      this.deferredShellCommands.push(entry);
      return;
    }
    this.appendShellCommand(entry);
  }

  /**
   * Summarizes the conversation with the model and replaces the model context with the summary
   * (a `compaction` entry). Throws a ProviderError on provider failure, an Error with message
   * "Nothing to compact yet." when there is no conversation, or a SummaryRejectedError when the
   * summary is empty, declined or incomplete. No compaction is stored when it throws, but the
   * usage of every summary request that got a response is recorded either way.
   */
  async compact(options: CompactOptions): Promise<CompactionResult> {
    if (this.activity === 'turn') throw new Error('Cannot compact while a turn is running.');
    if (this.activity === 'compaction') throw new Error('A compaction is already running.');
    this.activity = 'compaction';
    try {
      // Turns do this themselves before compacting automatically.
      this.answerUnfinishedToolCalls();
      return await this.runCompaction(options);
    } finally {
      this.finishActivity();
    }
  }

  /** Tokens in context after the last request and the model's window (0 when unknown). */
  contextUsage(): { tokens: number; window: number } {
    const usage = usageSinceCompaction(this.session.entries());
    const window = this.provider.getModelInfo(this.session.model).contextWindow;
    return {
      tokens: usage ? promptTokens(usage) + usage.outputTokens : 0,
      window: window > 0 ? window : 0,
    };
  }

  private async runCompaction(options: CompactOptions): Promise<CompactionResult> {
    const history = this.session.history();
    if (!history.some((message) => message.role === 'user')) {
      throw new Error('Nothing to compact yet.');
    }
    const auto = options.auto ?? false;
    const emit = (event: AgentEvent) => this.emitTo(options.onEvent, event);
    emit({ type: 'compaction_start', auto });

    const before = usageSinceCompaction(this.session.entries());
    const model = this.session.model;
    const modelMaxOutput = this.provider.getModelInfo(model).maxOutputTokens;
    const capped = (cap: number) => (modelMaxOutput > 0 ? Math.min(cap, modelMaxOutput) : cap);
    const spent: { total?: SummaryUsage } = {};
    let result: ConversationSummary;
    try {
      result = await summarizeConversation({
        provider: this.provider,
        model,
        messages: history,
        instructions: options.instructions,
        maxOutputTokens: capped(COMPACTION_MAX_OUTPUT_TOKENS),
        retryMaxOutputTokens: capped(COMPACTION_RETRY_MAX_OUTPUT_TOKENS),
        signal: options.signal,
        onResponse: (response) => {
          spent.total = spent.total ? addSummaryUsage(spent.total, response) : response;
        },
      });
    } catch (error) {
      // Summary requests that got a response were billed although no summary is stored.
      if (spent.total) {
        try {
          this.recordSummaryUsage(spent.total, options);
        } catch (secondary) {
          this.logger.error('Could not record the usage of a failed compaction', secondary);
        }
      }
      throw error;
    }
    const { summary } = result;
    // Usage first: a compaction entry after the last usage marks the context as freshly reset.
    this.recordSummaryUsage(result, options);
    this.session.append({
      type: 'compaction',
      summary,
      messagesCompacted: history.length,
      ...(before ? { tokensBefore: promptTokens(before) } : {}),
      auto,
    });
    this.autoCompactBackoff.rejectedAt = undefined;
    emit({ type: 'compaction', summary, auto, messagesCompacted: history.length });
    return { summary, messagesCompacted: history.length, usage: result.billed };
  }

  /**
   * Records the usage of a compaction's summary requests. Marked as a summary entry: it counts
   * toward costs, never as the size of the conversation's context.
   */
  private recordSummaryUsage(spent: SummaryUsage, options: CompactOptions): void {
    try {
      options.onUsage?.(spent.billed);
    } catch (error) {
      this.logger.error('Compaction usage listener failed', error);
    }
    this.session.append({
      type: 'usage',
      purpose: 'summary',
      model: spent.model,
      usage: spent.usage,
      ...(sameUsage(spent.billed, spent.usage) ? {} : { billed: spent.billed }),
    });
  }

  /**
   * Answers tool calls a previous process left unanswered when it stopped (see
   * `answerUnfinishedToolCalls`), before anything else is appended to the conversation.
   */
  private answerUnfinishedToolCalls(): void {
    const answered = answerUnfinishedToolCalls(this.session);
    if (answered.length > 0) {
      this.logger.warn('Answered tool calls left unfinished by a previous process', {
        calls: answered.map(({ call, outcome }) => `${call.name} (${outcome})`),
      });
    }
  }

  /**
   * A note for the model when plan mode is on and it last heard it was off, or the other way
   * round. History is append-only and the system prompt frozen, so a change of mode is told with
   * the next user message (any number of switches in between make one note, or none).
   */
  private planModeNotes(): string[] {
    const on = this.permissions.mode === 'plan';
    return on === planModeInHistory(this.session.history()) ? [] : [planModeNote(on)];
  }

  private toolSpecs(): ToolSpec[] {
    this.toolSpecCache ??= this.tools.specs();
    return this.toolSpecCache;
  }

  private rejectBusyTurn(options: TurnOptions): TurnResult {
    const result: TurnResult = {
      status: 'error',
      finalText: '',
      steps: 0,
      toolCalls: 0,
      usage: emptyUsage(),
      error: {
        title:
          this.activity === 'turn'
            ? 'Patch is already working on a request.'
            : 'Patch is compacting the conversation.',
        hint: 'Wait for it to finish, or interrupt it first.',
      },
    };
    this.emitTo(options.onEvent, { type: 'turn_end', result });
    return result;
  }

  private finishActivity(): void {
    this.activity = undefined;
    for (const entry of this.deferredShellCommands.splice(0)) {
      try {
        this.appendShellCommand(entry);
      } catch (error) {
        this.logger.error('Could not record a deferred shell command', error);
      }
    }
  }

  private appendShellCommand(entry: UserShellCommand): void {
    this.answerUnfinishedToolCalls();
    this.session.append({ type: 'shell', ...entry });
    this.session.append({
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: formatUserShellContext(entry) }] },
    });
  }

  private emitTo(listener: ((event: AgentEvent) => void) | undefined, event: AgentEvent): void {
    if (!listener) return;
    try {
      listener(event);
    } catch (error) {
      this.logger.error(`Event listener failed on ${event.type}`, error);
    }
  }
}

function sameUsage(a: Usage, b: Usage): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens
  );
}

/**
 * The model-facing form of a `!` command:
 * `<user-shell-command>\n$ cmd\n<output>\n(exit code N)\n</user-shell-command>`.
 */
export function formatUserShellContext(entry: UserShellCommand): string {
  const output = truncateMiddle(stripAnsi(entry.output), {
    maxLines: SHELL_CONTEXT_MAX_LINES,
    maxLineChars: SHELL_CONTEXT_MAX_LINE_CHARS,
    maxChars: SHELL_CONTEXT_MAX_CHARS,
  }).text;
  const exit =
    entry.exitCode === null
      ? '(no exit code: the command was terminated)'
      : `(exit code ${entry.exitCode})`;
  return [
    USER_SHELL_CONTEXT_TAG,
    `$ ${entry.command}`,
    output === '' ? '(no output)' : output,
    exit,
    USER_SHELL_CONTEXT_TAG.replace('<', '</'),
  ].join('\n');
}
