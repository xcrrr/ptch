import {
  LiveTail,
  PATCH_VERSION,
  ToolError,
  analyzeCommand,
  countChanges,
  describeError,
  describeMcpServer,
  expandCustomCommand,
  formatCommandOutput,
  imageFromBytes,
  nextPermissionMode,
  runCommand,
  usageSinceCompaction,
  type AgentEvent,
  type CustomCommand,
  type CustomCommandSet,
  type McpApprovalAnswer,
  type PermissionMode,
  type PermissionRequest,
  type PermissionResponse,
  type PlanReviewRequest,
  type PlanReviewResponse,
  type Session,
  type SessionStartSource,
  type SessionSummary,
  type ToolCallSummary,
  type ToolDisplay,
  type ToolProgress,
  type TurnResult,
} from '@patch/core';
import { oneLine, promptTokens, relativeTime, shortId, type ModelInfo } from '@patch/shared';
import { ClipboardError, readClipboardImage } from '../clipboard.js';
import { apiKeyInstruction } from '../credentials.js';
import { activityLabel, preparingLabel, tildify } from '../format.js';
import {
  attachImageFile,
  describeImageFile,
  imageLine,
  imageMentions,
  type AttachResult,
  type ImageAttachment,
} from '../images.js';
import type { Runtime, SessionHandle } from '../runtime.js';
import type {
  McpApprovalRequest,
  SlashCommandInfo,
  ToolRowStatus,
} from '../ui/components/props.js';
import { splitCommittable } from '../ui/markdown.js';
import type { TranscriptItem, WelcomeInfo } from '../ui/transcript.js';
import { builtInCommandNames, createCommands, type SlashCommand } from './commands.js';
import {
  customCommandInfo,
  parseSlashInput,
  partitionCustomCommands,
  shadowedNotice,
} from './custom-commands.js';
import { PromptHistory } from './history.js';
import { buildTranscriptFromEntries, hasTranscript } from './transcript-builder.js';

export type Mode =
  | 'idle'
  | 'running'
  | 'permission'
  | 'plan-review'
  | 'auto-confirm'
  | 'session-picker'
  | 'model-picker'
  | 'mcp-approval';

export interface LiveTool {
  id: string;
  name: string;
  summary: ToolCallSummary;
  status: ToolRowStatus;
  display?: ToolDisplay;
  progress?: ToolProgress;
  durationMs?: number;
}

export interface Activity {
  label: string;
  startedAt: number;
  detail?: string;
}

export interface FooterInfo {
  branch: string | null;
  model: string;
  /** Percent of the context window in use after the last request, or null when unknown. */
  contextPercent: number | null;
}

export interface AppState {
  /** Committed scrollback, rendered once by <Static>. */
  items: TranscriptItem[];
  /** Changing this remounts <Static> (after the screen is cleared). */
  staticKey: number;
  /** Assistant text still being streamed (not yet committed). */
  liveText: string;
  liveTools: LiveTool[];
  activity: Activity | null;
  mode: Mode;
  permission: PermissionRequest | null;
  /** The plan on screen for review (mode 'plan-review'). */
  planReview: PlanReviewRequest | null;
  /** The session's permission mode (Shift+Tab, /plan, an approved plan), shown in the footer. */
  permissionMode: PermissionMode;
  /** The project's MCP servers waiting for approval at startup (mode 'mcp-approval'). */
  mcpApproval: McpApprovalRequest | null;
  sessionChoices: SessionSummary[] | null;
  modelChoices: ModelInfo[] | null;
  /** Slash commands for the menu and completion: the built-in ones, then custom ones. */
  commands: SlashCommandInfo[];
  /** Prompts (and custom commands) submitted while busy, run in order when the work finishes. */
  queue: string[];
  /**
   * Set after a first Ctrl+C on an empty prompt; a second one within EXIT_CONFIRM_MS exits. Reset
   * to null when the window closes.
   */
  exitArmedAt: number | null;
  exiting: boolean;
  footer: FooterInfo;
  history: readonly string[];
  /** Request to clear the terminal before the next render (consumed by the view). */
  clearScreenToken: number;
}

export interface ControllerOptions {
  /** Prompt to submit immediately after startup. */
  initialPrompt?: string;
  /** The session was resumed (rebuild its transcript). */
  resumed?: boolean;
  /** Extra startup notices (e.g. config warnings). */
  startupNotices?: Array<{ level: 'info' | 'warn' | 'error'; text: string; hint?: string }>;
  /** Called when /clear or /resume replaces the active session. */
  onSessionChange?: (handle: SessionHandle) => void;
  now?: () => number;
  /** Reads an image from the system clipboard (default: readClipboardImage; replaced in tests). */
  readClipboard?: () => Promise<Buffer | undefined>;
}

/** A prompt submitted while Patch was busy, with the images attached to it. */
interface QueuedPrompt {
  text: string;
  images: ImageAttachment[];
}

/** A permission request waiting for the user's answer (shown one at a time, oldest first). */
interface PendingPermission {
  request: PermissionRequest;
  resolve: (response: PermissionResponse) => void;
}

/** A plan waiting for the user's review (shown after any waiting permission request). */
interface PendingPlan {
  request: PlanReviewRequest;
  resolve: (response: PlanReviewResponse) => void;
}

/** What pasting from the clipboard produced. `empty`: there was no image to paste. */
export type ClipboardPasteResult =
  { ok: true; attachment: ImageAttachment } | { ok: false; empty: boolean; message: string };

type StartupNotice = NonNullable<ControllerOptions['startupNotices']>[number];

/** Window for the second Ctrl+C. */
export const EXIT_CONFIRM_MS = 2000;
const NOTIFY_INTERVAL_MS = 16;
/** Activity shown while a prompt waits for the MCP servers to start. */
const MCP_STARTING_LABEL = 'Starting MCP servers';

/**
 * Owns the interactive session: turns, permission prompts, queueing, slash commands, `!` shell
 * commands and the transcript. Pure state machine with a subscribe API so the Ink view stays thin
 * and the flows are testable without a terminal.
 */
export class AppController {
  readonly runtime: Runtime;
  /** The built-in commands. */
  readonly commands: SlashCommand[];
  private handle: SessionHandle;
  /** Custom commands that can run (none named like a built-in command). */
  private customCommands: CustomCommand[] = [];
  /** Custom-command problems already shown, so each is reported once per process. */
  private readonly reportedCommandProblems = new Set<string>();
  /** A reload of the custom commands in progress (see reloadCustomCommands). */
  private commandReload: Promise<void> | undefined;
  private state: AppState;
  private readonly listeners = new Set<() => void>();
  private readonly promptHistory: PromptHistory;
  private abortController: AbortController | null = null;
  /**
   * Requests waiting for approval; the first is on screen. Approving an image the user attached
   * can coincide with a running turn's own request, which then waits its turn.
   */
  private readonly pendingPermissions: PendingPermission[] = [];
  /** Plans waiting for review; the first is on screen once no permission request waits. */
  private readonly pendingPlans: PendingPlan[] = [];
  /**
   * Auto mode was confirmed in this session (or it started in auto mode, with --auto or carried
   * over by /clear): turning it on again needs no confirmation.
   */
  private autoConfirmed: boolean;
  /**
   * The auto mode confirmation waits for an answer (`announce`: say so in the transcript once
   * auto mode is on, as /auto does).
   */
  private autoConfirmation: { announce: boolean } | null = null;
  /** Prompts submitted while busy (`state.queue` shows their text). */
  private readonly queued: QueuedPrompt[] = [];
  private readonly readClipboard: () => Promise<Buffer | undefined>;
  private nextItemId = 0;
  private notifyTimer: NodeJS.Timeout | null = null;
  private exitArmTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  /**
   * Work that makes Patch busy (turns, `!` commands, compaction, session switches): while any of
   * it runs, prompts are queued and esc/Ctrl+C interrupt. Each entry removes only itself.
   */
  private readonly work = new Set<Promise<void>>();
  /** Read-only commands (/status, /diff) that may run alongside work without owning it. */
  private readonly background = new Set<Promise<void>>();
  /** Set by close(): the session may be discarded, so nothing more is written to it. */
  private closed = false;
  private readonly onSessionChange?: (handle: SessionHandle) => void;
  /** Answers the MCP approval prompt on screen. */
  private resolveMcpApproval: ((answer: McpApprovalAnswer) => void) | undefined;
  /** MCP servers are starting (prompts wait for them: the tool list must be complete first). */
  private mcpStarting = false;

  constructor(runtime: Runtime, handle: SessionHandle, options: ControllerOptions = {}) {
    this.runtime = runtime;
    this.handle = handle;
    // `ptch --auto` is an explicit choice: it counts as the confirmation.
    this.autoConfirmed = handle.permissions.mode === 'auto';
    this.now = options.now ?? Date.now;
    this.readClipboard = options.readClipboard ?? (() => readClipboardImage());
    this.onSessionChange = options.onSessionChange;
    this.promptHistory = new PromptHistory(
      runtime.config.paths.home,
      runtime.workspace.projectRoot,
    );
    this.commands = createCommands();
    const commandNotices = this.useCustomCommands(runtime.customCommands);

    const items: TranscriptItem[] = [{ kind: 'welcome', id: this.id(), info: this.welcomeInfo() }];
    for (const notice of [...(options.startupNotices ?? []), ...commandNotices]) {
      items.push({ kind: 'notice', id: this.id(), ...notice });
    }
    if (!runtime.hasCredentials) items.push(this.missingKeyNotice());
    if (options.resumed) items.push(...this.resumedItems(handle.session));

    this.state = {
      items,
      staticKey: 0,
      liveText: '',
      liveTools: [],
      activity: null,
      mode: 'idle',
      permission: null,
      planReview: null,
      permissionMode: handle.permissions.mode,
      mcpApproval: null,
      sessionChoices: null,
      modelChoices: null,
      commands: this.slashCommandInfos(),
      queue: [],
      exitArmedAt: null,
      exiting: false,
      footer: this.footerInfo(),
      history: this.promptHistory.list(),
      clearScreenToken: 0,
    };

    this.startup(options.resumed ? 'resume' : 'startup');
    if (options.initialPrompt) this.submit(options.initialPrompt);
  }

  // ---------------------------------------------------------------------------
  // Store API

  getState = (): AppState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The session currently in use. */
  get session(): Session {
    return this.handle.session;
  }

  get sessionHandle(): SessionHandle {
    return this.handle;
  }

  /** Slash commands for the menu and completion (built-in, then custom). */
  get commandInfos(): SlashCommandInfo[] {
    return this.state.commands;
  }

  /** Resolves when all running work and read-only commands (and what they queued) finish. */
  async idle(): Promise<void> {
    while (this.work.size > 0 || this.background.size > 0) {
      await Promise.all([...this.work, ...this.background]);
    }
    this.flushNotify();
  }

  /**
   * Called when the UI has exited. Stops timers and stops recording into the session, whose file
   * the caller may delete when it has no messages.
   */
  close(): void {
    this.closed = true;
    this.clearExitTimer();
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
  }

  private setState(patch: Partial<AppState>, immediate = false): void {
    this.state = { ...this.state, ...patch };
    if (immediate) this.flushNotify();
    else this.scheduleNotify();
  }

  private scheduleNotify(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      for (const listener of this.listeners) listener();
    }, NOTIFY_INTERVAL_MS);
  }

  private flushNotify(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    for (const listener of this.listeners) listener();
  }

  private id(): string {
    this.nextItemId += 1;
    return `i${this.nextItemId}`;
  }

  // ---------------------------------------------------------------------------
  // Transcript helpers

  /** Appends committed items, fixing up tool-row grouping. */
  commit(...items: Array<TranscriptItem | DistributiveOmit<TranscriptItem, 'id'>>): void {
    if (items.length === 0) return;
    const next = [...this.state.items];
    for (const raw of items) {
      const item = ('id' in raw ? raw : { ...raw, id: this.id() }) as TranscriptItem;
      if (item.kind === 'tool') {
        const previous = next[next.length - 1];
        item.first = !previous || previous.kind !== 'tool';
      }
      next.push(item);
    }
    this.setState({ items: next });
  }

  notice(level: 'info' | 'warn' | 'error', text: string, hint?: string): void {
    this.commit({ kind: 'notice', level, text, ...(hint ? { hint } : {}) });
  }

  private commitLiveText(final: boolean): void {
    const text = this.state.liveText;
    if (!text) return;
    if (final) {
      const trimmed = text.trim();
      this.state = { ...this.state, liveText: '' };
      if (trimmed) this.commit({ kind: 'assistant', markdown: trimmed, first: true });
      else this.scheduleNotify();
      return;
    }
    const { commit, rest } = splitCommittable(text);
    if (!commit) return;
    this.state = { ...this.state, liveText: rest };
    this.commit({ kind: 'assistant', markdown: commit, first: true });
  }

  /** Moves finished tool rows (from the front of the live list) into the scrollback. */
  private commitFinishedTools(force = false): void {
    const live = [...this.state.liveTools];
    const done: LiveTool[] = [];
    while (live.length > 0) {
      const head = live[0] as LiveTool;
      if (!force && (head.status === 'running' || head.status === 'waiting')) break;
      live.shift();
      done.push(
        force && (head.status === 'running' || head.status === 'waiting')
          ? { ...head, status: 'interrupted' }
          : head,
      );
    }
    if (done.length === 0) return;
    this.state = { ...this.state, liveTools: live };
    this.commit(
      ...done.map((t): DistributiveOmit<TranscriptItem, 'id'> => ({
        kind: 'tool',
        name: t.name,
        summary: t.summary,
        status: t.status === 'running' || t.status === 'waiting' ? 'interrupted' : t.status,
        display: t.display,
        durationMs: t.durationMs,
        first: true,
      })),
    );
  }

  private updateTool(id: string, patch: Partial<LiveTool>): void {
    this.setState({
      liveTools: this.state.liveTools.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });
  }

  private setActivity(label: string, detail?: string): void {
    const startedAt = this.state.activity?.startedAt ?? this.now();
    this.setState({ activity: { label, startedAt, ...(detail ? { detail } : {}) } });
  }

  // ---------------------------------------------------------------------------
  // Input

  /**
   * Handles a submitted prompt, slash command or shell command. `images` are the images attached
   * in the prompt editor (sent with a prompt or a custom command; other commands ignore them).
   */
  submit(raw: string, images: ImageAttachment[] = []): void {
    const text = raw.replace(/\s+$/, '');
    if (!text.trim()) return;
    this.promptHistory.add(text);
    this.clearExitTimer();
    this.setState({ history: this.promptHistory.list(), exitArmedAt: null });

    if (text.startsWith('/') && !text.startsWith('//')) {
      this.runSlashCommand(text, images);
      return;
    }
    if (this.isBusy()) {
      this.enqueue(text, images);
      return;
    }
    if (text.startsWith('!')) {
      this.track(this.runUserShell(text.slice(1).trim()));
      return;
    }
    this.track(this.runTurn(text, undefined, { images }));
  }

  isBusy(): boolean {
    return this.work.size > 0;
  }

  /**
   * Ctrl+C: interrupt work; otherwise clear the prompt (handled by the view when text exists);
   * otherwise arm/confirm exit. Returns what happened.
   */
  handleCtrlC(promptHasText: boolean): 'interrupted' | 'clear-prompt' | 'armed' | 'exit' {
    if (this.isBusy()) {
      this.interrupt();
      return 'interrupted';
    }
    if (this.state.mode === 'session-picker' || this.state.mode === 'model-picker') {
      this.cancelPicker();
      return 'interrupted';
    }
    if (this.autoConfirmation) {
      this.respondAutoConfirm(false);
      return 'interrupted';
    }
    if (promptHasText) return 'clear-prompt';
    const armed = this.state.exitArmedAt;
    if (armed !== null && this.now() - armed < EXIT_CONFIRM_MS) {
      this.requestExit();
      return 'exit';
    }
    this.armExit();
    return 'armed';
  }

  /**
   * Esc / Ctrl+C while working: stops the current turn, compaction or shell command, declining
   * every request waiting for approval, every plan waiting for review and the auto mode
   * confirmation.
   */
  interrupt(): void {
    while (this.pendingPermissions.length > 0) this.respondPermission({ decision: 'deny' });
    while (this.pendingPlans.length > 0) this.respondPlan({ decision: 'keep_planning' });
    if (this.autoConfirmation) this.respondAutoConfirm(false);
    this.respondMcpApproval('no');
    this.abortController?.abort();
  }

  requestExit(): void {
    this.interrupt();
    this.clearExitTimer();
    this.setState({ exiting: true }, true);
  }

  /** Arms exit for EXIT_CONFIRM_MS; the footer hint disappears when the window closes. */
  private armExit(): void {
    this.clearExitTimer();
    const armedAt = this.now();
    const timer = setTimeout(() => {
      if (this.exitArmTimer !== timer) return;
      this.exitArmTimer = null;
      if (this.state.exitArmedAt === armedAt) this.setState({ exitArmedAt: null }, true);
    }, EXIT_CONFIRM_MS);
    timer.unref?.();
    this.exitArmTimer = timer;
    this.setState({ exitArmedAt: armedAt }, true);
  }

  private clearExitTimer(): void {
    if (!this.exitArmTimer) return;
    clearTimeout(this.exitArmTimer);
    this.exitArmTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Agent turns

  /** Runs `work` as busy work (see `work`); queued prompts start when the last work ends. */
  private track(work: Promise<void>): void {
    const tracked: Promise<void> = work
      .catch((error: unknown) => this.reportUnexpected(error))
      .finally(() => {
        this.work.delete(tracked);
        this.drainQueue();
      });
    this.work.add(tracked);
  }

  /** Runs a read-only command beside any busy work; it never makes Patch busy or idle. */
  private trackBackground(work: Promise<void>): void {
    const tracked: Promise<void> = work
      .catch((error: unknown) => this.reportUnexpected(error))
      .finally(() => {
        this.background.delete(tracked);
        this.flushNotify();
      });
    this.background.add(tracked);
  }

  private reportUnexpected(error: unknown): void {
    this.runtime.logger.error('unexpected controller error', error);
    const friendly = describeError(error);
    this.notice('error', friendly.title, friendly.hint);
  }

  private drainQueue(): void {
    // A queued entry may start nothing (a custom command removed meanwhile): take the next one.
    while (!this.isBusy() && !this.state.exiting) {
      const next = this.queued.shift();
      if (next === undefined) {
        this.flushNotify();
        return;
      }
      this.setState({ queue: this.queued.map((prompt) => prompt.text) });
      if (next.text.startsWith('!')) this.track(this.runUserShell(next.text.slice(1).trim()));
      else if (parseSlashInput(next.text)) this.runSlashCommand(next.text, next.images);
      else this.track(this.runTurn(next.text, undefined, { images: next.images }));
    }
  }

  /** Queues a prompt submitted while busy. */
  private enqueue(text: string, images: readonly ImageAttachment[]): void {
    this.queued.push({ text, images: [...images] });
    this.setState({ queue: this.queued.map((prompt) => prompt.text) }, true);
    if (this.mcpStarting) this.showMcpStarting();
  }

  /**
   * Runs an agent turn for `text` with the attached `images` and those the text mentions as
   * `@path` (see attachMentions). `displayText` overrides the echoed user line; `source` (the
   * file of a custom command) is shown dim under it.
   */
  async runTurn(
    text: string,
    displayText?: string,
    options: { source?: string; images?: readonly ImageAttachment[] } = {},
  ): Promise<void> {
    const attached = options.images ?? [];
    const userItem = (images: readonly ImageAttachment[]) => ({
      kind: 'user' as const,
      text: displayText ?? text,
      ...(options.source ? { source: options.source } : {}),
      ...imageLines(images),
    });
    if (!this.runtime.hasCredentials) {
      this.commit(userItem(attached));
      this.commit(this.missingKeyNotice());
      return;
    }
    const abort = new AbortController();
    this.abortController = abort;
    this.setState(
      { ...this.restingMode(true), activity: { label: 'Thinking', startedAt: this.now() } },
      true,
    );
    const mentioned = await this.attachMentions(text);
    const images = [...attached, ...mentioned.images];
    this.commit(userItem(images));
    for (const problem of mentioned.problems) this.notice(problem.level, problem.text);
    if (abort.signal.aborted) {
      if (this.abortController === abort) this.abortController = null;
      this.notice('info', 'Interrupted.');
      this.setState({ ...this.restingMode(false), activity: null }, true);
      return;
    }

    let result: TurnResult | undefined;
    let errorShown = false;
    try {
      result = await this.handle.agent.runTurn(
        {
          text,
          notes: this.turnNotes(),
          ...(images.length > 0 ? { images: images.map((attachment) => attachment.image) } : {}),
        },
        {
          signal: abort.signal,
          onEvent: (event) => {
            if (event.type === 'notice' && event.level === 'error') errorShown = true;
            this.onAgentEvent(event, abort.signal);
          },
          requestPermission: (request) => this.askPermission(request),
          reviewPlan: (request) => this.askPlanReview(request),
        },
      );
    } finally {
      if (this.abortController === abort) this.abortController = null;
      this.commitLiveText(true);
      this.commitFinishedTools(true);
      if (result?.status === 'interrupted') this.notice('info', 'Interrupted.');
      else if (result?.status === 'error' && result.error && !errorShown) {
        // A turn the agent refused (for example while it was busy) reports only its result.
        this.notice('error', result.error.title, result.error.hint);
      }
      this.setState(
        { ...this.restingMode(false), activity: null, footer: this.footerInfo() },
        true,
      );
    }
  }

  /**
   * Loads the images a prompt mentions as `@path` (the text is sent as typed). Mentions that
   * could not be attached are returned as notices: info for a missing file (the mention may mean
   * something else), a warning when the image was unreadable, too large or not approved.
   */
  private async attachMentions(text: string): Promise<{
    images: ImageAttachment[];
    problems: Array<{ level: 'info' | 'warn'; text: string }>;
  }> {
    const images: ImageAttachment[] = [];
    const problems: Array<{ level: 'info' | 'warn'; text: string }> = [];
    for (const mention of imageMentions(text)) {
      let result: AttachResult;
      try {
        result = await this.attachImage(mention);
      } catch (error) {
        this.runtime.logger.warn('could not attach a mentioned image', error);
        result = { ok: false, reason: 'invalid', message: describeError(error).title };
      }
      if (result.ok) images.push(result.attachment);
      else {
        problems.push({
          level: result.reason === 'missing' ? 'info' : 'warn',
          text: `@${mention} was not attached. ${result.message}`,
        });
      }
    }
    return { images, problems };
  }

  /**
   * Loads an image the user attached by path (a pasted or dropped path, an `@path` mention).
   * Reading it follows read_file's rules; when the user must approve, the request is shown like a
   * tool's (see attachImageFile).
   */
  attachImage(path: string): Promise<AttachResult> {
    return attachImageFile(path, {
      paths: this.handle.paths,
      permissions: this.handle.permissions,
      requestPermission: (request) => this.askPermission(request),
    });
  }

  /** Reads an image from the system clipboard (Alt+V / Ctrl+V). */
  async pasteClipboardImage(): Promise<ClipboardPasteResult> {
    let bytes: Buffer | undefined;
    try {
      bytes = await this.readClipboard();
    } catch (error) {
      this.runtime.logger.warn('could not read the clipboard', error);
      const message =
        error instanceof ClipboardError ? error.message : 'Could not read the clipboard.';
      return { ok: false, empty: false, message };
    }
    if (!bytes || bytes.length === 0) {
      return { ok: false, empty: true, message: 'No image in the clipboard' };
    }
    try {
      const file = imageFromBytes(bytes, 'The clipboard image', 'clipboard');
      return { ok: true, attachment: { image: file.image, description: describeImageFile(file) } };
    } catch (error) {
      if (error instanceof ToolError) return { ok: false, empty: false, message: error.message };
      throw error;
    }
  }

  /** Context for the model sent with the prompt (a changed working directory, see Runtime). */
  private turnNotes(): string[] {
    try {
      return this.runtime.turnNotes(this.handle.session);
    } catch (error) {
      this.runtime.logger.warn('could not prepare the working directory update', error);
      return [];
    }
  }

  private onAgentEvent(event: AgentEvent, signal: AbortSignal): void {
    switch (event.type) {
      case 'model_start':
        if (!this.state.liveText) this.setActivity('Thinking');
        break;
      case 'thinking':
        if (!this.state.liveText) this.setActivity('Thinking');
        break;
      case 'progress':
        this.commit({ kind: 'progress', text: event.text.trim() });
        this.setActivity(oneLine(event.text, 72));
        break;
      case 'text_delta':
        this.state = { ...this.state, liveText: this.state.liveText + event.text };
        this.commitLiveText(false);
        if (this.state.activity?.label !== 'Responding') this.setActivity('Responding');
        else this.scheduleNotify();
        break;
      case 'text_end':
        this.commitLiveText(true);
        break;
      case 'tool_prepare':
        this.commitLiveText(true);
        this.setActivity(preparingLabel(event.name, event.inputBytes));
        break;
      case 'tool_start':
        this.commitLiveText(true);
        this.setState({
          liveTools: [
            ...this.state.liveTools,
            { id: event.id, name: event.name, summary: event.summary, status: 'running' },
          ],
        });
        this.setActivity(activityLabel(event.summary));
        break;
      case 'tool_permission':
      case 'plan_review':
        this.updateTool(event.id, { status: 'waiting' });
        break;
      case 'permission_mode':
        this.setState({ permissionMode: event.mode });
        break;
      case 'tool_progress':
        this.updateTool(event.id, { progress: event.progress });
        break;
      case 'tool_end': {
        const status: ToolRowStatus = event.denied
          ? 'denied'
          : event.result.isError && signal.aborted
            ? 'interrupted'
            : event.result.isError
              ? 'error'
              : 'done';
        const finished = {
          status,
          display: event.result.display ?? errorDisplay(event.result),
          durationMs: event.durationMs,
          progress: undefined,
        };
        if (this.state.liveTools.some((t) => t.id === event.id)) {
          this.updateTool(event.id, finished);
        } else {
          // Calls rejected before they started (unknown tool, invalid input, cut off) only end.
          this.state = {
            ...this.state,
            liveTools: [
              ...this.state.liveTools,
              { id: event.id, name: event.name, summary: event.summary, ...finished },
            ],
          };
        }
        this.commitFinishedTools();
        if (this.state.liveTools.length === 0) this.setActivity('Thinking');
        break;
      }
      case 'hosted_tool_start':
        this.commitLiveText(true);
        // A call from a paused response is announced again when its result arrives.
        if (!this.state.liveTools.some((t) => t.id === event.id)) {
          this.setState({
            liveTools: [
              ...this.state.liveTools,
              { id: event.id, name: event.kind, summary: event.summary, status: 'running' },
            ],
          });
        }
        this.setActivity(activityLabel(event.summary));
        break;
      case 'hosted_tool_end': {
        const finished = {
          status: (event.isError ? 'error' : 'done') as ToolRowStatus,
          display: event.display,
        };
        if (this.state.liveTools.some((t) => t.id === event.id)) {
          this.updateTool(event.id, finished);
        } else {
          this.state = {
            ...this.state,
            liveTools: [
              ...this.state.liveTools,
              { id: event.id, name: event.kind, summary: event.summary, ...finished },
            ],
          };
        }
        this.commitFinishedTools();
        if (this.state.liveTools.length === 0) this.setActivity('Thinking');
        break;
      }
      case 'usage':
        this.setState({
          footer: {
            ...this.state.footer,
            model: event.model,
            contextPercent:
              event.contextWindow > 0
                ? Math.min(100, Math.round((event.contextTokens / event.contextWindow) * 100))
                : null,
          },
        });
        break;
      case 'notice':
        this.notice(event.level, event.text, event.hint);
        break;
      case 'compaction_start':
        this.setActivity('Compacting conversation');
        break;
      case 'compaction':
        this.commit({
          kind: 'compaction',
          summary: event.summary,
          auto: event.auto,
          messagesCompacted: event.messagesCompacted,
        });
        break;
      default:
        break;
    }
  }

  /** Shows the request (after any already waiting) and resolves with the user's answer. */
  private askPermission(request: PermissionRequest): Promise<PermissionResponse> {
    return new Promise((resolve) => {
      this.pendingPermissions.push({ request, resolve });
      if (this.pendingPermissions.length === 1) this.setState(this.restingMode(false), true);
    });
  }

  /** Answers the request on screen; the next waiting one, if any, takes its place. */
  respondPermission = (response: PermissionResponse): void => {
    const current = this.pendingPermissions.shift();
    if (!current) return;
    this.setState(this.restingMode(this.isBusy()), true);
    current.resolve(response);
  };

  /** Shows the plan for review (after any waiting request) and resolves with the user's answer. */
  private askPlanReview(request: PlanReviewRequest): Promise<PlanReviewResponse> {
    return new Promise((resolve) => {
      this.pendingPlans.push({ request, resolve });
      if (this.pendingPlans.length === 1) this.setState(this.restingMode(false), true);
    });
  }

  /** Answers the plan on screen. An approval's mode reaches the footer with the agent's event. */
  respondPlan = (response: PlanReviewResponse): void => {
    const current = this.pendingPlans.shift();
    if (!current) return;
    this.setState(this.restingMode(this.isBusy()), true);
    current.resolve(response);
  };

  /**
   * The mode when nothing else holds the screen: the oldest request waiting for approval, else
   * the oldest plan waiting for review, else the auto mode confirmation, else running or idle.
   */
  private restingMode(busy: boolean): Pick<AppState, 'mode' | 'permission' | 'planReview'> {
    const pending = this.pendingPermissions[0];
    if (pending) return { mode: 'permission', permission: pending.request, planReview: null };
    const plan = this.pendingPlans[0];
    if (plan) return { mode: 'plan-review', permission: null, planReview: plan.request };
    if (this.autoConfirmation) return { mode: 'auto-confirm', permission: null, planReview: null };
    return { mode: busy ? 'running' : 'idle', permission: null, planReview: null };
  }

  // ---------------------------------------------------------------------------
  // Permission modes

  /** Shift+Tab: default → accepting edits → plan mode → auto mode → default. */
  cyclePermissionMode = (): void => {
    const next = nextPermissionMode(this.handle.permissions.mode);
    if (next === 'auto') this.enterAutoMode();
    else this.setPermissionMode(next);
  };

  /**
   * Turns auto mode on. The first time in a session the user confirms it first (the mode stays
   * as it is meanwhile); `announce` puts a notice in the transcript once it is on (/auto).
   */
  enterAutoMode(announce = false): void {
    if (this.autoConfirmed) {
      this.setPermissionMode('auto');
      if (announce) this.announceAutoMode();
      return;
    }
    this.autoConfirmation = { announce };
    this.setState(this.restingMode(this.isBusy()), true);
  }

  /** The answer to the auto mode confirmation: Yes turns it on, No returns to the default mode. */
  respondAutoConfirm = (yes: boolean): void => {
    const pending = this.autoConfirmation;
    if (!pending) return;
    this.autoConfirmation = null;
    if (yes) this.autoConfirmed = true;
    this.setPermissionMode(yes ? 'auto' : 'default');
    this.setState(this.restingMode(this.isBusy()), true);
    if (yes && pending.announce) this.announceAutoMode();
  };

  private announceAutoMode(): void {
    this.notice(
      'info',
      'Auto mode is on: edits and commands run without asking. Destructive commands and secret files still ask.',
      'Turn it off with /auto or shift+tab.',
    );
  }

  /**
   * Switches the session's permission mode. Calls checked from now on follow it; the model hears
   * about plan mode with the next message (see Agent).
   */
  setPermissionMode(mode: PermissionMode): void {
    this.handle.permissions.setMode(mode);
    this.setState({ permissionMode: mode }, true);
  }

  // ---------------------------------------------------------------------------
  // `!` shell commands (run by the user, outside the model loop)

  private async runUserShell(command: string): Promise<void> {
    if (!command) {
      this.notice('info', 'Type a command after "!", e.g. !git status');
      return;
    }
    const { workspace } = this.runtime;
    const analysis = analyzeCommand(command, {
      cwd: workspace.cwd,
      projectRoot: workspace.projectRoot,
      home: workspace.home,
      platform: workspace.platform,
      shell: this.runtime.shell.kind,
    });
    const subject = { kind: 'execute' as const, command, analysis, origin: 'user' as const };
    const decision = this.handle.permissions.evaluate(subject);
    this.commit({ kind: 'user', text: `!${command}` });
    if (decision.type === 'deny') {
      this.notice('warn', decision.message);
      return;
    }

    const abort = new AbortController();
    this.abortController = abort;
    this.setState(this.restingMode(true), true);
    try {
      if (decision.type === 'ask') {
        const response = await this.askPermission({
          id: `shell-${this.id()}`,
          toolName: 'shell',
          summary: { verb: 'bash', target: command },
          subject,
          prompt: decision.prompt,
        });
        if (response.decision === 'deny') {
          this.notice('info', 'Command not run.');
          return;
        }
      }
      const rowId = `shell-${this.id()}`;
      this.setState({
        liveTools: [
          { id: rowId, name: 'shell', summary: { verb: '!', target: command }, status: 'running' },
        ],
        activity: { label: `Running ${oneLine(command, 60)}`, startedAt: this.now() },
      });
      const tail = new LiveTail(5);
      const result = await runCommand(command, {
        shell: this.runtime.shell,
        cwd: workspace.cwd,
        timeoutMs: 30 * 60_000,
        signal: abort.signal,
        onOutput: (chunk, stream) => {
          tail.push(chunk, stream);
          this.updateTool(rowId, { progress: tail.snapshot() });
        },
      });
      this.setState({ liveTools: [] });
      const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n');
      this.commit({
        kind: 'shell',
        command,
        exitCode: result.exitCode,
        output: result.aborted ? `${output}\n(interrupted)`.trim() : output,
        durationMs: result.durationMs,
      });
      // After close() the session file may already be gone; writing would recreate it headless.
      if (!this.closed) {
        const formatted = formatCommandOutput(result);
        this.handle.agent.recordUserShellCommand({
          command,
          exitCode: result.exitCode,
          output: formatted.content,
          durationMs: result.durationMs,
        });
      }
    } catch (error) {
      const friendly = describeError(error);
      this.notice('error', friendly.title, friendly.hint);
    } finally {
      if (this.abortController === abort) this.abortController = null;
      this.setState({ ...this.restingMode(false), activity: null, liveTools: [] }, true);
    }
  }

  // ---------------------------------------------------------------------------
  // Slash commands

  private runSlashCommand(text: string, images: readonly ImageAttachment[] = []): void {
    const { name, args } = parseSlashInput(text) ?? { name: '', args: '' };
    const command = this.commands.find((c) => c.name === name || c.aliases?.includes(name));
    if (!command) {
      this.runCustomCommandInput(name, text, args, images);
      return;
    }
    if (this.isBusy() && !command.availableWhileBusy) {
      this.notice(
        'info',
        `/${command.name} is available when Patch is idle.`,
        'Press esc to interrupt the current work.',
      );
      return;
    }
    const outcome = command.run(this, args);
    if (!(outcome instanceof Promise)) return;
    // A read-only command must not take over the busy state: ending before a running turn would
    // make Patch look idle mid-turn (esc and Ctrl+C would stop interrupting, prompts would no
    // longer queue).
    if (command.availableWhileBusy) this.trackBackground(outcome);
    else this.track(outcome);
  }

  // ---------------------------------------------------------------------------
  // Custom commands (Markdown prompts; see loadCustomCommands)

  /**
   * A typed slash command that is not built in. A custom command is a message like any other:
   * while Patch is busy it waits in the queue, and images attached to it are sent with its
   * prompt. When idle, the commands are read again first, so a file added or edited since the
   * last scan is used as it is now.
   */
  private runCustomCommandInput(
    name: string,
    typed: string,
    args: string,
    images: readonly ImageAttachment[],
  ): void {
    if (this.isBusy()) {
      if (this.findCustomCommand(name)) {
        this.enqueue(typed, images);
      } else {
        this.unknownCommand(name);
      }
      return;
    }
    this.track(this.runCustomCommand(name, typed, args, images));
  }

  private async runCustomCommand(
    name: string,
    typed: string,
    args: string,
    images: readonly ImageAttachment[],
  ): Promise<void> {
    await this.reloadCustomCommands();
    const command = this.findCustomCommand(name);
    if (!command) {
      this.unknownCommand(name);
      return;
    }
    // The transcript shows what was typed and the file; the model gets the expanded prompt.
    await this.runTurn(expandCustomCommand(command, args), typed, {
      source: command.source,
      images,
    });
  }

  private findCustomCommand(name: string): CustomCommand | undefined {
    return name === '' ? undefined : this.customCommands.find((c) => c.name === name);
  }

  private unknownCommand(name: string): void {
    this.notice('warn', `Unknown command: /${name}`, 'Type /help to see available commands.');
  }

  /** The custom commands as listed by the slash menu and /help. */
  customCommandInfos(): SlashCommandInfo[] {
    return this.customCommands.map(customCommandInfo);
  }

  private slashCommandInfos(): SlashCommandInfo[] {
    const builtIn = this.commands.map((c): SlashCommandInfo => ({
      name: c.name,
      description: c.description,
      args: c.args,
      aliases: c.aliases,
    }));
    return [...builtIn, ...this.customCommandInfos()];
  }

  /**
   * Reads the custom commands again (after /clear, when the slash menu opens, before one runs)
   * and updates the menu. Problems not reported before are shown as notices. Concurrent calls
   * share one reload.
   */
  reloadCustomCommands(): Promise<void> {
    this.commandReload ??= (async () => {
      try {
        const set = await this.runtime.reloadCustomCommands();
        if (this.closed) return;
        for (const notice of this.useCustomCommands(set)) {
          this.notice(notice.level, notice.text, notice.hint);
        }
        const infos = this.slashCommandInfos();
        if (JSON.stringify(infos) !== JSON.stringify(this.state.commands)) {
          this.setState({ commands: infos });
        }
      } finally {
        this.commandReload = undefined;
      }
    })();
    return this.commandReload;
  }

  /** The slash menu opened: look for commands added since the last scan. */
  refreshCommands = (): void => {
    this.trackBackground(this.reloadCustomCommands());
  };

  /**
   * Takes over a loaded set of custom commands. Those named like a built-in command are left out
   * (built-in commands always win); such a name and each loading problem are reported once per
   * process. Returns the notices to show.
   */
  private useCustomCommands(set: CustomCommandSet): StartupNotice[] {
    const { usable, shadowed } = partitionCustomCommands(set, builtInCommandNames(this.commands));
    this.customCommands = usable;
    const notices: StartupNotice[] = [];
    const report = (key: string, notice: StartupNotice) => {
      if (this.reportedCommandProblems.has(key)) return;
      this.reportedCommandProblems.add(key);
      notices.push(notice);
    };
    for (const command of shadowed) {
      report(`shadowed:${command.path}`, { level: 'warn', ...shadowedNotice(command) });
    }
    for (const warning of set.warnings) report(warning, { level: 'warn', text: warning });
    return notices;
  }

  // ---------------------------------------------------------------------------
  // Startup: MCP servers, then SessionStart hooks

  /**
   * Starts the MCP servers (once per process) and then runs the SessionStart hooks, as busy work:
   * prompts submitted meanwhile wait in the queue, so the first request already has the complete
   * tool list. Both are quiet unless something needs the user (approving the project's servers)
   * or fails.
   */
  private startup(source: SessionStartSource): void {
    const mcp = this.runtime.mcp.configured && !this.runtime.mcp.started;
    const hooks = this.runtime.hooks.has('SessionStart');
    if (!mcp && !hooks) return;
    this.track(
      (async () => {
        if (mcp) await this.startMcp();
        if (hooks && !this.state.exiting) await this.runSessionStartHooks(source);
      })(),
    );
  }

  /**
   * Asks about the project's servers that need approval (from .mcp.json), then connects to the
   * servers that may start. Failures are shown as notices. Esc skips the servers still starting.
   */
  private async startMcp(): Promise<void> {
    const { mcp } = this.runtime;
    const abort = new AbortController();
    this.abortController = abort;
    try {
      const pending = mcp.pendingApprovals();
      if (pending.length > 0) {
        const answer = await this.askMcpApproval({
          servers: pending.map((server) => ({
            name: server.name,
            target: describeMcpServer(server),
          })),
        });
        for (const notice of mcp.answerApproval(pending, answer)) {
          this.notice(notice.level, notice.text, notice.hint);
        }
      }
      this.mcpStarting = true;
      if (this.queued.length > 0) this.showMcpStarting();
      const notices = await this.runtime.startMcp(abort.signal);
      for (const notice of notices) this.notice(notice.level, notice.text, notice.hint);
    } finally {
      this.mcpStarting = false;
      if (this.abortController === abort) this.abortController = null;
      if (this.state.activity?.label === MCP_STARTING_LABEL) {
        this.setState({ ...this.restingMode(false), activity: null }, true);
      }
    }
  }

  /** A prompt waits for the MCP servers: say so. */
  private showMcpStarting(): void {
    if (this.state.mode !== 'idle' && this.state.mode !== 'running') return;
    this.setState(
      { mode: 'running', activity: { label: MCP_STARTING_LABEL, startedAt: this.now() } },
      true,
    );
  }

  /** Shows the approval prompt for the project's MCP servers; resolves with the answer. */
  private askMcpApproval(request: McpApprovalRequest): Promise<McpApprovalAnswer> {
    return new Promise((resolve) => {
      this.resolveMcpApproval = resolve;
      this.setState({ mode: 'mcp-approval', mcpApproval: request }, true);
    });
  }

  /** Answers the MCP approval prompt on screen (esc and Ctrl+C answer 'no'). */
  respondMcpApproval = (answer: McpApprovalAnswer): void => {
    const resolve = this.resolveMcpApproval;
    if (!resolve) return;
    this.resolveMcpApproval = undefined;
    this.setState({ ...this.restingMode(false), mcpApproval: null }, true);
    resolve(answer);
  };

  /**
   * Runs the SessionStart hooks of the session in use as busy work (prompts submitted meanwhile
   * wait in the queue; esc stops them), without an activity line: they are quiet unless they
   * fail. What they print reaches the model with the next message.
   */
  private startSessionHooks(source: SessionStartSource): void {
    if (!this.runtime.hooks.has('SessionStart')) return;
    this.track(this.runSessionStartHooks(source));
  }

  private async runSessionStartHooks(source: SessionStartSource): Promise<void> {
    const abort = new AbortController();
    this.abortController = abort;
    try {
      await this.handle.agent.runSessionStartHooks(source, {
        signal: abort.signal,
        onEvent: (event) => {
          if (event.type === 'notice') this.notice(event.level, event.text, event.hint);
        },
      });
    } finally {
      if (this.abortController === abort) this.abortController = null;
    }
  }

  // Command primitives used by commands.ts -------------------------------------

  /** Starts an agent turn whose echoed user line differs from the prompt sent. */
  startTurn(prompt: string, displayText: string): void {
    this.track(this.runTurn(prompt, displayText));
  }

  /** Runs abortable work with an activity label (e.g. compaction). */
  async runBusy<T>(
    label: string,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    const abort = new AbortController();
    this.abortController = abort;
    this.setState({ ...this.restingMode(true), activity: { label, startedAt: this.now() } }, true);
    try {
      return await work(abort.signal);
    } finally {
      if (this.abortController === abort) this.abortController = null;
      this.setState(
        { ...this.restingMode(false), activity: null, footer: this.footerInfo() },
        true,
      );
    }
  }

  openSessionPicker(sessions: SessionSummary[]): void {
    this.setState({ mode: 'session-picker', sessionChoices: sessions }, true);
  }

  openModelPicker(models: ModelInfo[]): void {
    this.setState({ mode: 'model-picker', modelChoices: models }, true);
  }

  cancelPicker = (): void => {
    this.setState({ mode: 'idle', sessionChoices: null, modelChoices: null }, true);
  };

  selectSession = (id: string): void => {
    this.setState({ mode: 'idle', sessionChoices: null }, true);
    // Checked before loading: loading the session in use would take its lock from this handle
    // (which could then no longer write), and the switch would discard it as an empty old session.
    const match = this.runtime.store.resolve(id);
    if ('id' in match && match.id === this.session.id) {
      this.notice('info', `Already in session ${shortId(match.id)}.`);
      return;
    }
    const resolved = this.runtime.resolveSession(id);
    if (!resolved.ok) {
      this.notice('error', resolved.message);
      return;
    }
    // Like `ptch --resume`: the session keeps its own model unless --model or PATCH_MODEL was given.
    this.switchSession(
      this.runtime.openSession(resolved.session, this.runtime.resumeModelOverride()),
      true,
    );
  };

  /**
   * Ctrl+O at a permission prompt: prints the full command or change being approved; at a plan
   * review, the full plan.
   */
  expandPermission(): void {
    const plan = this.state.mode === 'plan-review' ? this.state.planReview : null;
    if (plan) {
      this.commit({ kind: 'detail', title: 'Plan', text: plan.plan });
      return;
    }
    const request = this.state.permission;
    if (!request) return;
    const { prompt, preview } = request;
    this.commit({
      kind: 'detail',
      title: prompt.title,
      text: [prompt.subjectLine, preview?.text].filter(Boolean).join('\n\n'),
      ...(preview?.diff ? { diff: preview.diff } : {}),
    });
  }

  selectModel = (model: string): void => {
    this.setState({ mode: 'idle', modelChoices: null }, true);
    this.setModel(model);
  };

  setModel(model: string): void {
    const info = this.runtime.provider.getModelInfo(model);
    this.handle.agent.setModel(model);
    this.setState({ footer: this.footerInfo() });
    this.notice(
      info.known ? 'info' : 'warn',
      info.known
        ? `Using ${info.label} (${model}) for this session.`
        : `Using ${model} for this session.`,
      info.known
        ? undefined
        : 'Patch does not recognize this model id; it will be sent to the provider as-is.',
    );
  }

  /** Replaces the active session (after /clear or /resume) and redraws the transcript. */
  switchSession(handle: SessionHandle, resumed: boolean): void {
    const previous = this.handle;
    this.handle = handle;
    // Release the previous session (its lock) so another Patch process can open it.
    if (previous.session !== handle.session) previous.session.close();
    this.onSessionChange?.(handle);
    // The confirmation is once per session; auto mode carried over by /clear needs none.
    this.autoConfirmation = null;
    this.autoConfirmed = handle.permissions.mode === 'auto';
    const items: TranscriptItem[] = [{ kind: 'welcome', id: this.id(), info: this.welcomeInfo() }];
    if (!this.runtime.hasCredentials) items.push(this.missingKeyNotice());
    if (resumed) items.push(...this.resumedItems(handle.session));
    this.setState(
      {
        items,
        staticKey: this.state.staticKey + 1,
        clearScreenToken: this.state.clearScreenToken + 1,
        liveText: '',
        liveTools: [],
        footer: this.footerInfo(),
        permissionMode: handle.permissions.mode,
      },
      true,
    );
    this.startSessionHooks(resumed ? 'resume' : 'clear');
  }

  /** Clears the terminal and redraws the most recent part of the transcript. */
  redraw(): void {
    const keep = this.state.items.slice(-60);
    this.setState(
      {
        items: keep,
        staticKey: this.state.staticKey + 1,
        clearScreenToken: this.state.clearScreenToken + 1,
      },
      true,
    );
  }

  /** Ctrl+O: prints the full detail of the most recent tool call. */
  expandLastTool(): void {
    const items = this.state.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item?.kind !== 'tool') continue;
      const detail = item.display?.detail ?? item.display?.plan;
      const diff = item.display?.diff;
      if (!detail && !diff) continue;
      this.commit({
        kind: 'detail',
        title: `${item.summary.verb} ${item.summary.target}`.trim(),
        text: detail ?? '',
        ...(diff ? { diff } : {}),
      });
      return;
    }
    this.notice('info', 'No tool output to expand yet.');
  }

  // ---------------------------------------------------------------------------
  // Derived info

  welcomeInfo(): WelcomeInfo {
    const { workspace, config, gitStatus } = this.runtime;
    const git = workspace.git;
    const branch = git ? (git.branch ?? (git.head ? `detached @${git.head}` : 'detached')) : null;
    const notes: string[] = [];
    if (!workspace.isGit) notes.push('No Git repository detected. Working in directory mode.');
    if (workspace.projectRoot === workspace.home) {
      notes.push('Running in your home directory; Patch treats it as the project root.');
    }
    if (config.debug && this.runtime.logger.filePath) {
      notes.push(`Debug log: ${tildify(this.runtime.logger.filePath, workspace.home)}`);
    }
    return {
      version: PATCH_VERSION,
      location: tildify(workspace.cwd, workspace.home),
      branch,
      isGit: workspace.isGit,
      changedFiles: gitStatus ? countChanges(gitStatus).total : null,
      model: this.handle.agent.model,
      status: this.runtime.hasCredentials ? 'ready' : 'no API key',
      statusLevel: this.runtime.hasCredentials ? 'ok' : 'warn',
      instructionFiles: workspace.instructions.map((f) => f.display),
      notes,
    };
  }

  footerInfo(): FooterInfo {
    const usage = this.handle.agent.contextUsage();
    const git = this.runtime.workspace.git;
    return {
      branch: git ? (git.branch ?? (git.head ? `@${git.head}` : null)) : null,
      model: this.handle.agent.model,
      contextPercent:
        usage.window > 0 && usage.tokens > 0
          ? Math.min(100, Math.round((usage.tokens / usage.window) * 100))
          : null,
    };
  }

  private missingKeyNotice(): TranscriptItem {
    const instruction = apiKeyInstruction();
    return {
      kind: 'notice',
      id: this.id(),
      level: 'warn',
      text: `${instruction.title} Run: ${instruction.command}`,
      hint: instruction.note,
    };
  }

  private resumedItems(session: Session): TranscriptItem[] {
    const items: TranscriptItem[] = [];
    const updated = session.entries().at(-1);
    const when =
      updated && 'ts' in updated ? relativeTime(updated.ts) : relativeTime(session.meta.createdAt);
    if (hasTranscript(session)) {
      items.push(...buildTranscriptFromEntries(session.entries(), () => this.id()));
    }
    items.push({
      kind: 'divider',
      id: this.id(),
      label: `resumed ${shortId(session.id)} · ${oneLine(session.title(), 48)} · ${when}`,
    });
    const directory = this.runtime.directoryNotice(session);
    if (directory) items.push({ kind: 'notice', id: this.id(), ...directory });
    // The context after a compaction is only the summary, whatever the requests before it used.
    const last = usageSinceCompaction(session.entries());
    if (last) {
      const window = this.runtime.provider.getModelInfo(session.model).contextWindow;
      const tokens = promptTokens(last) + last.outputTokens;
      if (window > 0 && tokens / window > 0.6) {
        items.push({
          kind: 'notice',
          id: this.id(),
          level: 'info',
          text: `This conversation uses ${Math.round((tokens / window) * 100)}% of the context window.`,
          hint: 'Run /compact to summarize it before continuing.',
        });
      }
    }
    return items;
  }
}

/** The user item's image lines ("[Image #1] screenshot.png · 1280×720 · 84 KB"), if any. */
function imageLines(images: readonly ImageAttachment[]): { images?: string[] } {
  if (images.length === 0) return {};
  return { images: images.map((attachment, i) => imageLine(i + 1, attachment.description)) };
}

/** For failed calls without a display, show the first line of the error under the row. */
function errorDisplay(result: { content: string; isError?: boolean }): ToolDisplay | undefined {
  if (!result.isError) return undefined;
  const first = result.content.split('\n').find((line) => line.trim());
  return first ? { lines: [oneLine(first, 160)] } : undefined;
}

/** Omit that distributes over unions (so discriminated unions keep their shape). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
