import {
  isTerminal,
  type BrainEntryDetail,
  type ConversationRecord,
  type MessageRecord,
  type PermissionProfile,
  type ProjectRecord,
  type TaskRecord,
} from '@patch/cloud-protocol';
import { CloudApiError } from '../cloud/client.js';
import { STATUS_LABEL, ago, money, renderEvent, taskRuntime } from '../cloud/format.js';
import { SnapshotError, renderPreview, type SnapshotPlan } from '../cloud/snapshot.js';
import type { SlashCommandInfo } from '../ui/components/props.js';
import type { CloudBackend, CloudViewApi } from './backend.js';
import { plural } from '@patch/shared';
import { sanitizeApi, since } from './clean.js';
import { copyText } from './copy.js';
import {
  activeChooseProject,
  activeRunIds,
  usable,
  latestPendingProposal,
  nextProfile,
  runTaskIds,
  type Entry,
  type RunFacts,
} from './model.js';

/** Limits of the lists the pickers show. */
const PICKER_LIMIT = 30;
/** Width of the status column of the runs list (the longest status word). */
const STATUS_COLUMN = 'interrupted'.length;
const BRAIN_LIMIT = 300;
/** How many finished runs of a conversation get their recorded changes read. */
const FACTS_LIMIT = 10;
const EXIT_CONFIRM_MS = 2_000;
const HINT_MS = 4_000;
/** Offline: seconds between attempts to reach Patch Cloud again. */
const RETRY_STEPS_MS = [3_000, 5_000, 10_000, 15_000];

export type PickerKind = 'conversations' | 'projects' | 'runs' | 'brain' | 'brain-links' | 'choose';

export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
  /** A status mark in front of the label (the same marks as the run cards). */
  mark?: string;
  /** Draw the mark as the spinner (a run that is going on). */
  spinner?: boolean;
}

export interface PickerState {
  kind: PickerKind;
  title: string;
  subtitle?: string;
  options: PickerOption[];
  /** Dim line under the list (what the keys do, or why the list is short). */
  footer?: string;
  initialIndex?: number;
}

export interface ProposalUi {
  messageId: string;
  prompt: string;
  profile: PermissionProfile;
  busy: 'start' | 'dismiss' | null;
  error: string | null;
  /** When the snapshot the run would use was uploaded (read after the proposal appears). */
  snapshotAt: string | null;
  editing: boolean;
  /** The user went to the composer (a slash command): the proposal stays pending, keys go there. */
  parked: boolean;
}

export type Connection = 'ok' | 'offline' | 'expired';

export interface CloudViewState {
  /** Whether a sign-in exists. */
  phase: 'signed-out' | 'ready';
  signIn: { status: 'idle' | 'waiting' | 'failed'; url: string | null; message: string | null };
  /** The first contact with Patch Cloud is done (successfully or not). */
  booted: boolean;
  account: string | null;
  host: string | null;
  worker: 'online' | 'offline' | 'unknown';
  /** The version of Patch Cloud (its own, not the CLI's). */
  cloudVersion: string | null;
  connection: Connection;
  /** While offline: when the next attempt is made. */
  retryAt: number | null;
  projects: ProjectRecord[];
  project: { id: string; name: string } | null;
  conversation: ConversationRecord | null;
  /** A conversation is being opened (the start screen must not show). */
  loadingConversation: boolean;
  entries: Entry[];
  tasks: Record<string, TaskRecord>;
  missing: string[];
  facts: Record<string, RunFacts | 'pending'>;
  proposal: ProposalUi | null;
  picker: PickerState | null;
  follow: { taskId: string; title: string } | null;
  push: { question: string; busy: boolean } | null;
  busy: { label: string; startedAt: number } | null;
  hint: string | null;
  exitArmedAt: number | null;
  exiting: boolean;
  focused: boolean;
  history: string[];
  commands: SlashCommandInfo[];
  /** Bumped to make the view clear the screen and start over (/new, /resume). */
  clearScreenToken: number;
  /** Text to put in the composer (a failed message, a proposal's prompt being edited). */
  draft: { text: string; token: number } | null;
}

export interface CloudViewOptions {
  /** `ptch --resume <id>`, `--resume` (choose) or `--continue` (the latest). */
  resume?: { id: string } | 'pick' | 'latest';
  /** `ptch "prompt"`: sent as the first message once connected. */
  initialPrompt?: string;
  /** Milliseconds between polls (default 2000). */
  pollMs?: number;
  now?: () => number;
  /** Puts text on the clipboard (default: the platform's clipboard program). */
  copy?: (text: string) => Promise<boolean>;
}

export const COMMANDS: SlashCommandInfo[] = [
  { name: 'new', description: 'Start a new conversation' },
  { name: 'resume', args: '[id]', description: 'Open an earlier conversation' },
  { name: 'projects', description: 'List cloud projects and choose the one to work in' },
  { name: 'runs', description: 'Recent runs; open one to follow its log' },
  { name: 'run', args: '<id>', description: 'Follow the log of one run' },
  { name: 'brain', args: '[add <title>]', description: "Read this project's Brain" },
  { name: 'push', description: 'Upload this repository as a new snapshot' },
  { name: 'login', description: 'Sign in to Patch Cloud in your browser' },
  { name: 'logout', description: 'Sign this device out' },
  { name: 'whoami', description: 'Who you are signed in as, and where' },
  { name: 'help', description: 'Commands and keys' },
  { name: 'quit', aliases: ['exit'], description: 'Leave Patch' },
];

type Listener = () => void;

export class CloudViewController {
  private state: CloudViewState;
  private readonly listeners = new Set<Listener>();
  private api: CloudViewApi | null = null;
  private seq = 0;
  private draftToken = 0;
  private timer: NodeJS.Timeout | undefined;
  private hintTimer: NodeJS.Timeout | undefined;
  private ticking = false;
  private tickCount = 0;
  private failures = 0;
  private signInAbort: AbortController | null = null;
  private followAbort: AbortController | null = null;
  private pendingPush: { plan: SnapshotPlan; project: ProjectRecord | null; name: string } | null =
    null;
  private chooseDismissed = new Set<string>();
  private choosing = new Set<string>();
  private readonly now: () => number;
  private readonly copy: (text: string) => Promise<boolean>;
  private readonly pollMs: number;
  private logBuffer: string[] = [];
  private readonly background = new Set<Promise<unknown>>();
  private pendingResume: CloudViewOptions['resume'];
  private pendingPrompt: string | undefined;
  private logTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly backend: CloudBackend,
    options: CloudViewOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.copy = options.copy ?? copyText;
    this.pendingResume = options.resume;
    this.pendingPrompt = options.initialPrompt;
    this.pollMs = options.pollMs ?? 2_000;
    const signedIn = backend.isSignedIn();
    this.state = {
      phase: signedIn ? 'ready' : 'signed-out',
      signIn: { status: 'idle', url: null, message: null },
      booted: false,
      account: null,
      host: backend.host(),
      worker: 'unknown',
      cloudVersion: null,
      connection: 'ok',
      retryAt: null,
      projects: [],
      project: null,
      conversation: null,
      loadingConversation: signedIn && options.resume !== undefined,
      entries: [],
      tasks: {},
      missing: [],
      facts: {},
      proposal: null,
      picker: null,
      follow: null,
      push: null,
      busy: null,
      hint: null,
      exitArmedAt: null,
      exiting: false,
      focused: true,
      history: [],
      commands: COMMANDS,
      clearScreenToken: 0,
      draft: null,
    };
  }

  // ------------------------------------------------------------------ store

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): CloudViewState => this.state;

  private setState(patch: Partial<CloudViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private id(prefix: string): string {
    return `${prefix}${++this.seq}`;
  }

  private addEntries(...entries: Entry[]): void {
    this.setState({ entries: [...this.state.entries, ...entries] });
  }

  private notice(level: 'info' | 'warn' | 'error', text: string): void {
    this.addEntries({ kind: 'notice', id: this.id('n'), level, text });
  }

  private hint(text: string): void {
    clearTimeout(this.hintTimer);
    this.setState({ hint: text });
    this.hintTimer = setTimeout(() => this.setState({ hint: null }), HINT_MS);
    this.hintTimer.unref?.();
  }

  setDraft(text: string): void {
    this.setState({ draft: { text, token: ++this.draftToken } });
  }

  // ------------------------------------------------------------------ lifecycle

  /** Connects: signs in first when there is no sign-in. Resolves when the first contact is done. */
  async start(): Promise<void> {
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.pollMs);
    this.timer.unref?.();
    if (this.state.phase === 'signed-out') {
      await this.signIn();
      return;
    }
    await this.bootstrap();
  }

  /** Resolves when the work started in the background (reading runs, results) is done. */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  /** Runs something the user asked for from the keyboard; a failure becomes a line in the log. */
  perform(work: Promise<unknown>): void {
    void work.catch((error: unknown) => this.notice('error', errorText(error)));
  }

  private later(work: Promise<unknown>): void {
    this.background.add(work);
    void work.catch(() => undefined).finally(() => this.background.delete(work));
  }

  close(): void {
    clearInterval(this.timer);
    clearTimeout(this.hintTimer);
    clearTimeout(this.logTimer);
    this.signInAbort?.abort();
    this.followAbort?.abort();
  }

  setFocused(focused: boolean): void {
    if (focused === this.state.focused) return;
    this.setState({ focused });
    if (focused) void this.tick().catch(() => undefined);
  }

  /** Whether the view shows the animated start screen: nothing has been said, nothing is loading. */
  isFresh(): boolean {
    const s = this.state;
    return (
      !s.exiting &&
      !s.loadingConversation &&
      s.conversation === null &&
      s.busy === null &&
      s.entries.every((e) => e.kind === 'header' || e.kind === 'notice')
    );
  }

  // ------------------------------------------------------------------ sign-in

  /** `c` while waiting for the browser: the long address is copied instead of selected. */
  async copySignInAddress(): Promise<void> {
    const url = this.state.signIn.url;
    if (!url) return;
    this.hint(
      (await this.copy(url)) ? 'Address copied.' : 'Could not copy. Select the address instead.',
    );
  }

  async signIn(): Promise<void> {
    if (this.signInAbort) return;
    const controller = new AbortController();
    this.signInAbort = controller;
    this.setState({
      phase: 'signed-out',
      signIn: { status: 'waiting', url: null, message: null },
    });
    try {
      const api = await this.backend.login({
        signal: controller.signal,
        announce: (url) => this.setState({ signIn: { status: 'waiting', url, message: null } }),
      });
      this.api = sanitizeApi(api);
      this.signInAbort = null;
      this.setState({
        phase: 'ready',
        signIn: { status: 'idle', url: null, message: null },
        connection: 'ok',
        host: this.backend.host(),
      });
    } catch (error) {
      this.signInAbort = null;
      const cancelled = (error as Error).name === 'AbortError';
      this.setState({
        signIn: {
          status: 'failed',
          url: null,
          message: cancelled ? 'Sign-in cancelled.' : errorText(error),
        },
      });
      return;
    }
    await this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    if (!this.api) {
      try {
        const connected = await this.backend.connect();
        this.api = connected ? sanitizeApi(connected) : null;
      } catch (error) {
        this.notice('error', errorText(error));
      }
    }
    const api = this.api;
    if (!api) {
      this.setState({ phase: 'signed-out', booted: true });
      return;
    }
    await this.refreshIdentity();
    this.freshenHeader();
    const linked = await this.backend.linkedProject().catch(() => ({ root: null }) as const);
    if (!this.state.project && 'projectId' in linked && linked.projectId) {
      const found = this.state.projects.find((p) => p.id === linked.projectId);
      if (found) this.setState({ project: { id: found.id, name: found.name } });
    }
    if (!this.state.entries.some((e) => e.kind === 'header')) {
      this.addEntries(this.headerEntry());
    }
    this.setState({ booted: true });

    const resume = this.pendingResume;
    const initialPrompt = this.pendingPrompt;
    this.pendingResume = undefined;
    this.pendingPrompt = undefined;
    if (resume === 'pick') {
      await this.openConversationPicker();
    } else if (resume === 'latest') {
      const list = await this.guard(() => api.listConversations({ limit: 1 }));
      const first = list?.[0];
      if (first) await this.openConversation(first.id, false);
      else {
        this.setState({ loadingConversation: false });
        this.notice('info', 'No conversations yet. Starting a new one.');
      }
    } else if (resume) {
      await this.openConversation(resume.id, false);
    }
    if (!resume && this.state.conversation) await this.refreshConversation();
    // With a list of conversations open the prompt has nowhere to go yet.
    if (initialPrompt && resume !== 'pick' && this.state.phase === 'ready') {
      await this.submit(initialPrompt);
    }
  }

  private headerEntry(): Entry {
    return {
      kind: 'header',
      id: this.id('h'),
      account: this.state.account,
      host: this.state.host ?? this.api?.url ?? '',
      worker: this.state.worker,
      project: this.state.project?.name ?? null,
    };
  }

  /** After Patch Cloud answered for the first time: the header of the log tells who and where. */
  private freshenHeader(): void {
    const index = this.state.entries.findIndex((e) => e.kind === 'header');
    const current = this.state.entries[index];
    if (!current || current.kind !== 'header' || current.account !== null) return;
    const entries = [...this.state.entries];
    entries[index] = { ...this.headerEntry(), id: current.id };
    this.setState({ entries });
  }

  /** Who is signed in, whether the worker is online, and the projects. */
  private async refreshIdentity(): Promise<void> {
    const api = this.api;
    if (!api) return;
    const [me, status, projects] = await Promise.all([
      this.guard(() => api.me()),
      this.guard(() => api.status()),
      this.guard(() => api.listProjects()),
    ]);
    // Patch Cloud can answer "nobody" instead of refusing: the saved sign-in is not valid.
    if (me && !me.authenticated) this.setState({ connection: 'expired', retryAt: null });
    this.setState({
      host: this.backend.host() ?? api.url,
      ...(me?.account?.name ? { account: me.account.name } : {}),
      ...(status
        ? {
            worker: status.worker.online ? ('online' as const) : ('offline' as const),
            cloudVersion: status.version,
          }
        : {}),
      ...(projects ? { projects } : {}),
    });
    const current = this.state.project;
    if (current && projects) {
      const found = projects.find((p) => p.id === current.id);
      if (found && found.name !== current.name) {
        this.setState({ project: { id: found.id, name: found.name } });
      }
    }
  }

  // ------------------------------------------------------------------ api calls

  /** Runs a request and tracks whether Patch Cloud can be reached; never throws. */
  private async guard<T>(run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await this.call(run);
    } catch {
      return undefined;
    }
  }

  /** Runs a request, updating the connection state; rethrows the error for the caller. */
  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      if (this.state.connection !== 'ok' || this.failures > 0) {
        this.failures = 0;
        this.setState({ connection: 'ok', retryAt: null });
      }
      return result;
    } catch (error) {
      if (error instanceof CloudApiError) {
        if (error.status === 0) {
          // Several requests fail together; one failure counts once per retry window.
          if (this.state.connection === 'offline' && (this.state.retryAt ?? 0) > this.now()) {
            throw error;
          }
          const step = RETRY_STEPS_MS[Math.min(this.failures, RETRY_STEPS_MS.length - 1)] ?? 15_000;
          this.failures += 1;
          this.setState({ connection: 'offline', retryAt: this.now() + step });
        } else if (error.status === 401) {
          this.setState({ connection: 'expired', retryAt: null });
        }
      }
      throw error;
    }
  }

  private requireApi(): CloudViewApi {
    if (!this.api) throw new CloudApiError('Not signed in. Type /login.', 401, 'signed_out');
    return this.api;
  }

  // ------------------------------------------------------------------ polling

  /**
   * One round of the live updates: the runs shown in the conversation that are not finished, the
   * conversation itself while a run is active, the worker status now and then. Runs only while
   * the terminal is focused; while Patch Cloud is unreachable it retries on its own schedule.
   */
  async tick(): Promise<void> {
    const s = this.state;
    if (this.ticking || !this.api || s.phase !== 'ready' || s.exiting || !s.booted) return;
    if (s.connection === 'expired' || !s.focused) return;
    this.ticking = true;
    try {
      this.tickCount += 1;
      const api = this.api;
      if (s.connection === 'offline') {
        if (s.retryAt !== null && this.now() < s.retryAt) return;
        const status = await this.guard(() => api.status());
        if (!status) return;
        this.setState({ worker: status.worker.online ? 'online' : 'offline' });
        await this.refreshIdentity();
        this.freshenHeader();
        if (this.state.conversation) await this.refreshConversation();
        return;
      }

      const ids = activeRunIds(this.state.entries, this.state.tasks, new Set(this.state.missing));
      if (ids.length > 0) {
        const became = await this.refreshTasks(ids);
        // A run that just ended: the server appended its result message in the same moment.
        if (became.length > 0 || this.tickCount % 4 === 0) await this.refreshConversation();
      }
      if (this.state.picker?.kind === 'runs') await this.refreshRunsPicker();
      if (this.tickCount % 15 === 0) {
        const status = await this.guard(() => api.status());
        if (status) this.setState({ worker: status.worker.online ? 'online' : 'offline' });
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Reads the given tasks. Returns the ids that are final now but were not before. */
  private async refreshTasks(ids: readonly string[]): Promise<string[]> {
    const api = this.requireApi();
    const became: string[] = [];
    const tasks = { ...this.state.tasks };
    const missing = new Set(this.state.missing);
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const found = await this.guard(() => api.tasksByIds(chunk));
      if (!found) return became;
      const seen = new Set<string>();
      for (const task of found) {
        seen.add(task.id);
        const before = tasks[task.id];
        tasks[task.id] = task;
        if (isTerminal(task.status) && (!before || !isTerminal(before.status)))
          became.push(task.id);
      }
      for (const id of chunk) if (!seen.has(id)) missing.add(id);
    }
    this.setState({ tasks, missing: [...missing] });
    await this.loadFacts();
    return became;
  }

  /** Reads what the worker recorded about finished runs (changed files), a few at a time. */
  private async loadFacts(): Promise<void> {
    const api = this.api;
    if (!api) return;
    const finished = runTaskIds(this.state.entries)
      .filter((id) => {
        const task = this.state.tasks[id];
        return task && isTerminal(task.status) && this.state.facts[id] === undefined;
      })
      .slice(-FACTS_LIMIT);
    if (finished.length === 0) return;
    this.setState({
      facts: {
        ...this.state.facts,
        ...Object.fromEntries(finished.map((id) => [id, 'pending' as const])),
      },
    });
    const results: Record<string, RunFacts> = {};
    for (const id of finished) {
      const facts: RunFacts = {};
      try {
        let cursor = 0;
        for (let page = 0; page < 10; page++) {
          const batch = await this.call(() => api.events(id, cursor));
          for (const event of batch.events) {
            if (event.type !== 'task.changes') continue;
            const count = event.data.fileCount;
            facts.filesChanged =
              typeof count === 'number'
                ? count
                : Array.isArray(event.data.files)
                  ? event.data.files.length
                  : undefined;
          }
          if (batch.events.length < 2000) break;
          cursor = batch.cursor;
        }
      } catch {
        // not recorded or not readable now: the card simply leaves the line out
      }
      results[id] = facts;
    }
    this.setState({ facts: { ...this.state.facts, ...results } });
  }

  /** Reads the conversation again; messages that are new (a run's result) are appended. */
  private async refreshConversation(): Promise<number> {
    const api = this.api;
    const conversation = this.state.conversation;
    if (!api || !conversation) return 0;
    const detail = await this.guard(() => api.getConversation(conversation.id));
    if (!detail) return 0;
    return this.mergeMessages(detail.messages, detail.conversation);
  }

  private mergeMessages(
    messages: readonly MessageRecord[],
    conversation?: ConversationRecord,
  ): number {
    const entries = [...this.state.entries];
    let added = 0;
    for (const received of messages) {
      const message = usable(received);
      const index = entries.findIndex((e) => e.kind === 'message' && e.id === message.id);
      if (index >= 0) entries[index] = { kind: 'message', id: message.id, message };
      else {
        entries.push({ kind: 'message', id: message.id, message });
        added += 1;
      }
    }
    this.setState({ entries, ...(conversation ? { conversation } : {}) });
    this.later(this.afterMessages());
    return added;
  }

  /** After the log changed: read the runs it mentions, and hand the keyboard to what needs it. */
  private async afterMessages(): Promise<void> {
    this.syncFocus();
    const unknown = runTaskIds(this.state.entries).filter(
      (id) => !this.state.tasks[id] && !this.state.missing.includes(id),
    );
    if (unknown.length > 0 && this.api) await this.refreshTasks(unknown);
    else await this.loadFacts();
    this.syncFocus();
  }

  /** The proposal and the project question that wait for an answer take the keyboard. */
  private syncFocus(): void {
    const pending = latestPendingProposal(this.state.entries);
    const current = this.state.proposal;
    if (!pending) {
      if (current) this.setState({ proposal: null });
    } else if (!current || current.messageId !== pending.messageId) {
      this.setState({
        proposal: {
          messageId: pending.messageId,
          prompt: pending.block.prompt,
          profile: pending.block.profile,
          busy: null,
          error: null,
          snapshotAt: null,
          editing: false,
          parked: false,
        },
      });
      this.later(
        this.loadSnapshotAge(pending.messageId, pending.block.projectId, pending.block.snapshotId),
      );
    }
    const choose = activeChooseProject(this.state.entries);
    if (
      choose &&
      !this.state.picker &&
      !this.chooseDismissed.has(choose.messageId) &&
      !this.choosing.has(choose.messageId) &&
      !this.state.proposal
    ) {
      this.choosing.add(choose.messageId);
      this.later(this.openChoosePicker(choose.messageId));
    }
  }

  /** The assistant needs a project: the current list of projects, to choose from. */
  private async openChoosePicker(messageId: string): Promise<void> {
    try {
      const api = this.api;
      const fresh = api ? await this.guard(() => api.listProjects()) : undefined;
      const projects = fresh ?? this.state.projects;
      if (fresh) this.setState({ projects: fresh });
      if (this.state.picker || activeChooseProject(this.state.entries)?.messageId !== messageId) {
        return;
      }
      this.setState({
        picker: {
          kind: 'choose',
          title: 'Which project?',
          options: projects.map((p) => ({
            value: p.id,
            label: p.name,
            hint: `${p.taskCount} ${p.taskCount === 1 ? 'run' : 'runs'}`,
          })),
          footer:
            projects.length === 0
              ? 'There are no projects yet. Use /push in a repository to create one.'
              : 'enter choose · esc not now',
        },
      });
    } finally {
      this.choosing.delete(messageId);
    }
  }

  private async loadSnapshotAge(
    messageId: string,
    projectId: string,
    snapshotId: string,
  ): Promise<void> {
    const api = this.api;
    if (!api) return;
    const detail = await this.guard(() => api.projectDetail(projectId));
    const at = detail?.snapshots.find((s) => s.id === snapshotId)?.createdAt;
    const ui = this.state.proposal;
    if (at && ui?.messageId === messageId) this.setState({ proposal: { ...ui, snapshotAt: at } });
  }

  // ------------------------------------------------------------------ conversation

  async openConversation(ref: string, clear = true): Promise<boolean> {
    const api = this.api;
    if (!api) return false;
    this.setState({ loadingConversation: true });
    try {
      let id = ref;
      if (!/^cnv_[0-9a-z]{10,}$/.test(ref)) {
        const list = await this.call(() => api.listConversations({ limit: 100 }));
        const matches = list.filter((c) => c.id.startsWith(ref) || c.id.startsWith(`cnv_${ref}`));
        if (matches.length === 0) {
          this.notice('warn', `No conversation starts with "${ref}". Try /resume.`);
          this.setState({ loadingConversation: false });
          return false;
        }
        if (matches.length > 1) {
          this.notice(
            'warn',
            `"${ref}" matches ${matches.length} conversations; use more characters.`,
          );
          this.setState({ loadingConversation: false });
          return false;
        }
        id = (matches[0] as ConversationRecord).id;
      }
      const detail = await this.call(() => api.getConversation(id));
      const entries: Entry[] = [];
      if (detail.hasMore) {
        entries.push({
          kind: 'notice',
          id: this.id('n'),
          level: 'info',
          text: 'Showing the newest messages of this conversation.',
        });
      }
      entries.push(
        ...detail.messages.map((message): Entry => ({
          kind: 'message',
          id: message.id,
          message: usable(message),
        })),
      );
      const projectId = detail.conversation.projectId;
      const project =
        (projectId && this.state.projects.find((p) => p.id === projectId)) || this.state.project;
      const header = this.headerEntry();
      if (header.kind === 'header') header.project = project?.name ?? null;
      this.chooseDismissed.clear();
      this.setState({
        conversation: detail.conversation,
        entries: [header, ...entries],
        project: project ? { id: project.id, name: project.name } : null,
        tasks: {},
        missing: [],
        facts: {},
        proposal: null,
        picker: null,
        loadingConversation: false,
        ...(clear ? { clearScreenToken: this.state.clearScreenToken + 1 } : {}),
      });
      await this.afterMessages();
      return true;
    } catch (error) {
      this.setState({ loadingConversation: false });
      this.notice('error', errorText(error));
      return false;
    }
  }

  newConversation(): void {
    this.chooseDismissed.clear();
    this.setState({
      conversation: null,
      entries: [this.headerEntry()],
      tasks: {},
      missing: [],
      facts: {},
      proposal: null,
      picker: null,
      follow: null,
      push: null,
      loadingConversation: false,
      clearScreenToken: this.state.clearScreenToken + 1,
    });
  }

  // ------------------------------------------------------------------ input

  /** What the user submitted in the composer. */
  async submit(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    this.setState({
      history: [text, ...this.state.history.filter((h) => h !== text)].slice(0, 100),
      exitArmedAt: null,
    });
    if (this.state.proposal?.editing) {
      this.finishProposalEdit(text);
      return;
    }
    this.parkProposal(false);
    if (text.startsWith('/') && !text.startsWith('//')) {
      await this.runCommand(text);
      return;
    }
    if (this.state.phase !== 'ready' || !this.api) {
      this.notice('warn', 'You are not signed in to Patch Cloud. Type /login.');
      return;
    }
    if (this.state.connection === 'expired') {
      // The banner says it; the message is kept in the prompt.
      this.hint(
        'Your sign-in expired. Clear the prompt (ctrl+c), type /login, then send it again.',
      );
      this.setDraft(text);
      return;
    }
    if (this.state.busy) {
      this.hint(
        this.answering ? 'Patch is still answering.' : 'Still sending the previous message.',
      );
      this.setDraft(text);
      return;
    }
    await this.send(text, undefined);
  }

  private async send(text: string, projectId: string | undefined): Promise<void> {
    const api = this.requireApi();
    const pendingId = this.id('p');
    this.setState({
      busy: { label: 'Asking Patch Cloud', startedAt: this.now() },
      entries: [...this.state.entries, { kind: 'pending-user', id: pendingId, text }],
    });
    try {
      let conversation = this.state.conversation;
      if (!conversation) {
        const project = this.state.project;
        conversation = await this.call(() =>
          api.createConversation(project ? { projectId: project.id } : {}),
        );
        this.setState({ conversation });
      }
      const id = conversation.id;
      const project = projectId ?? this.state.project?.id;
      const response = await this.call(() =>
        api.sendMessage(id, { text, ...(project ? { projectId: project } : {}) }),
      );
      const entries = this.state.entries.filter((e) => e.id !== pendingId);
      this.setState({ entries, busy: null });
      this.mergeMessages([response.user, response.assistant], response.conversation);
      const chosen = response.conversation.projectId;
      if (chosen && chosen !== this.state.project?.id) {
        const found = this.state.projects.find((p) => p.id === chosen);
        if (found) this.setState({ project: { id: found.id, name: found.name } });
      }
      if (response.assistant.status === 'pending') {
        this.later(this.followAnswer(id, response.assistant));
      }
    } catch (error) {
      this.setState({
        busy: null,
        entries: this.state.entries.filter((e) => e.id !== pendingId),
      });
      // An expired sign-in has its own banner; the rest is said here.
      if ((error as CloudApiError).status !== 401) this.notice('error', errorText(error));
      this.setDraft(text);
    }
  }

  /** True while an answer of the chat model is being followed. */
  private answering = false;

  /**
   * Follows an answer the chat model is writing: reads the message again every half second,
   * shows what it is doing on the status line, and lets the text grow in place until it is done.
   */
  private async followAnswer(conversationId: string, message: MessageRecord): Promise<void> {
    const api = this.requireApi();
    const startedAt = this.now();
    let current = message;
    this.answering = true;
    this.setState({ busy: { label: current.activity ?? 'Thinking', startedAt } });
    try {
      while (current.status === 'pending' && this.now() - startedAt < 6 * 60_000) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (this.state.exiting || this.state.conversation?.id !== conversationId) return;
        const next = await this.guard(() => api.getMessage(conversationId, current.id));
        if (!next) continue;
        current = next;
        this.mergeMessages([next]);
        if (next.status === 'pending') {
          this.setState({ busy: { label: next.activity ?? 'Thinking', startedAt } });
        }
      }
    } finally {
      this.answering = false;
      if (this.state.busy) this.setState({ busy: null });
    }
  }

  // ------------------------------------------------------------------ proposals

  /** Enter / y: starts the run the assistant proposed. */
  async startProposal(): Promise<void> {
    const ui = this.state.proposal;
    const conversation = this.state.conversation;
    if (!ui || !conversation || ui.busy || ui.editing) return;
    const proposal = latestPendingProposal(this.state.entries);
    if (!proposal || proposal.messageId !== ui.messageId) return;
    const api = this.requireApi();
    this.setState({ proposal: { ...ui, busy: 'start', error: null } });
    try {
      const response = await this.call(() =>
        api.confirmProposal(conversation.id, ui.messageId, {
          ...(ui.prompt.trim() !== proposal.block.prompt ? { prompt: ui.prompt.trim() } : {}),
          ...(ui.profile !== proposal.block.profile ? { profile: ui.profile } : {}),
        }),
      );
      const tasks = { ...this.state.tasks, [response.task.id]: response.task };
      this.setState({ tasks, proposal: null });
      this.mergeMessages([response.proposal, response.assistant], response.conversation);
    } catch (error) {
      const refused = refusedProposal(error);
      if (refused) {
        // The reason was recorded on the proposal: it is shown there, as the server wrote it.
        this.setState({ proposal: null });
        this.mergeMessages([refused]);
        return;
      }
      this.setState({
        proposal: { ...ui, busy: null, error: errorText(error) },
      });
      if ((error as CloudApiError).status === 409) await this.refreshConversation();
    }
  }

  async dismissProposal(): Promise<void> {
    const ui = this.state.proposal;
    const conversation = this.state.conversation;
    if (!ui || !conversation || ui.busy) return;
    const api = this.requireApi();
    this.setState({ proposal: { ...ui, busy: 'dismiss', error: null } });
    try {
      const response = await this.call(() => api.dismissProposal(conversation.id, ui.messageId));
      this.setState({ proposal: null });
      this.mergeMessages([response.proposal], response.conversation);
    } catch (error) {
      this.setState({ proposal: { ...ui, busy: null, error: errorText(error) } });
      if ((error as CloudApiError).status === 409) await this.refreshConversation();
    }
  }

  cycleProfile(): void {
    const ui = this.state.proposal;
    if (!ui || ui.busy) return;
    this.setState({ proposal: { ...ui, profile: nextProfile(ui.profile) } });
  }

  beginProposalEdit(): void {
    const ui = this.state.proposal;
    if (!ui || ui.busy) return;
    this.setState({ proposal: { ...ui, editing: true } });
    this.setDraft(ui.prompt);
  }

  private finishProposalEdit(text: string): void {
    const ui = this.state.proposal;
    if (!ui) return;
    this.setState({ proposal: { ...ui, prompt: text, editing: false, error: null } });
  }

  cancelProposalEdit(): void {
    const ui = this.state.proposal;
    if (ui?.editing) this.setState({ proposal: { ...ui, editing: false } });
  }

  /** The user typed "/" at a proposal: the keyboard goes to the prompt, the proposal stays. */
  parkProposal(parked: boolean): void {
    const ui = this.state.proposal;
    if (ui && ui.parked !== parked) this.setState({ proposal: { ...ui, parked } });
  }

  // ------------------------------------------------------------------ commands

  private async runCommand(text: string): Promise<void> {
    const [head = '', ...rest] = text.slice(1).split(/\s+/);
    const name = head.toLowerCase();
    const arg = rest.join(' ').trim();
    const api = this.api;
    const needsSignIn = !['login', 'logout', 'help', 'quit', 'exit', 'whoami'].includes(name);
    if (needsSignIn && (this.state.phase !== 'ready' || !api)) {
      this.notice('warn', 'You are not signed in to Patch Cloud. Type /login.');
      return;
    }
    if (needsSignIn && this.state.connection === 'expired') {
      this.hint('Your sign-in expired. Type /login to sign in again.');
      return;
    }
    try {
      switch (name) {
        case 'new':
          this.newConversation();
          return;
        case 'resume':
          if (arg) await this.openConversation(arg);
          else await this.openConversationPicker();
          return;
        case 'projects':
          await this.openProjectPicker();
          return;
        case 'runs':
          await this.openRunsPicker();
          return;
        case 'run':
          if (!arg) {
            this.notice('warn', 'Usage: /run <id>  (or /runs to choose one)');
            return;
          }
          await this.followRun(arg);
          return;
        case 'brain':
          if (arg.toLowerCase().startsWith('add')) await this.addBrainNote(arg.slice(3).trim());
          else await this.openBrain();
          return;
        case 'push':
          await this.beginPush();
          return;
        case 'login':
          if (this.state.phase === 'ready') {
            if (this.state.connection === 'expired') {
              this.api = null;
              this.setState({ connection: 'ok' });
              await this.signIn();
            } else {
              this.notice(
                'info',
                `Already signed in${this.state.account ? ` as ${this.state.account}` : ''}. /logout first to sign in as someone else.`,
              );
            }
          } else await this.signIn();
          return;
        case 'logout':
          await this.logout();
          return;
        case 'whoami':
          await this.whoami();
          return;
        case 'help':
          this.help();
          return;
        case 'quit':
        case 'exit':
          this.requestExit();
          return;
        default:
          this.notice('warn', `Unknown command /${name}. Type /help for the list.`);
      }
    } catch (error) {
      this.notice('error', errorText(error));
    }
  }

  private help(): void {
    const rows: Array<[string, string]> = COMMANDS.map((c): [string, string] => [
      `/${c.name}${c.args ? ` ${c.args}` : ''}`,
      c.description,
    ]);
    const keys: Array<[string, string]> = [
      ['enter', 'Send'],
      ['shift+enter', 'New line (alt+enter too)'],
      ['up, down', 'Earlier messages'],
      ['y n p e', 'With a proposal and an empty prompt: start, dismiss, permissions, edit'],
      ['ctrl+c', 'Cancel what is open; twice leaves'],
    ];
    const width = Math.max(...[...rows, ...keys].map(([key]) => key.length));
    const table = (list: Array<[string, string]>): string[] =>
      list.map(([key, description]) => `${key.padEnd(width)}  ${description}`);
    this.addEntries({
      kind: 'doc',
      id: this.id('d'),
      title: 'Patch Cloud',
      lines: [
        'Ask in plain words: "What is running?", "What failed recently?", "Fix the failing tests".',
        'Anything that would change code becomes a proposal you confirm before it starts.',
        '',
        ...table(rows),
        '',
        ...table(keys),
      ],
    });
  }

  private async whoami(): Promise<void> {
    if (this.state.phase !== 'ready' || !this.api) {
      this.notice('info', 'Not signed in. Type /login.');
      return;
    }
    const api = this.api;
    const me = await this.call(() => api.me());
    if (!me.authenticated) {
      this.setState({ connection: 'expired', retryAt: null });
      this.notice('warn', 'The saved sign-in is not valid any more. Type /login to sign in again.');
      return;
    }
    const lines = [`Signed in as ${me.account?.name ?? 'unknown'} on ${api.url}`];
    if (me.client) lines.push(`Device      ${me.client.device} (${me.client.name})`);
    else lines.push(`Credential  ${me.kind ?? 'none'}`);
    if (me.version) lines.push(`Patch Cloud ${me.version}`);
    this.addEntries({ kind: 'doc', id: this.id('d'), lines });
  }

  private async logout(): Promise<void> {
    if (this.state.phase !== 'ready' && !this.backend.isSignedIn()) {
      this.notice('info', 'You are not signed in.');
      return;
    }
    this.followAbort?.abort();
    const { revoked } = await this.backend.logout();
    this.api = null;
    this.setState({
      phase: 'signed-out',
      account: null,
      worker: 'unknown',
      cloudVersion: null,
      connection: 'ok',
      retryAt: null,
      proposal: null,
      picker: null,
      follow: null,
      signIn: { status: 'idle', url: null, message: null },
    });
    this.notice(
      'info',
      revoked
        ? 'Signed out. This device can no longer use Patch Cloud. Type /login to sign in again.'
        : 'Signed out on this device. Patch Cloud could not be reached to revoke it: remove this device under Settings in Patch HQ. Type /login to sign in again.',
    );
  }

  // ------------------------------------------------------------------ pickers

  private async openConversationPicker(): Promise<void> {
    const api = this.requireApi();
    const list = await this.call(() => api.listConversations({ limit: PICKER_LIMIT })).catch(
      (error: unknown) => {
        this.notice('error', errorText(error));
        return null;
      },
    );
    if (!list) {
      this.setState({ loadingConversation: false });
      return;
    }
    if (list.length === 0) {
      this.setState({ loadingConversation: false });
      this.notice('info', 'No earlier conversations. Say something to start one.');
      return;
    }
    const now = new Date(this.now());
    this.setState({
      loadingConversation: false,
      picker: {
        kind: 'conversations',
        title: 'Resume a conversation',
        subtitle: 'The same conversations as in Patch HQ and on your phone',
        options: list.map((c) => ({
          value: c.id,
          label: c.title || 'New chat',
          hint: [
            since(c.updatedAt, now),
            `${c.messageCount} ${c.messageCount === 1 ? 'msg' : 'msgs'}`,
            this.projectNameOf(c.projectId),
          ]
            .filter(Boolean)
            .join(' · '),
        })),
        footer: 'enter open · esc cancel',
      },
    });
  }

  private projectNameOf(id: string | null | undefined): string | null {
    if (!id) return null;
    return this.state.projects.find((p) => p.id === id)?.name ?? null;
  }

  private async openProjectPicker(): Promise<void> {
    const api = this.requireApi();
    const projects = await this.call(() => api.listProjects());
    this.setState({ projects });
    if (projects.length === 0) {
      this.notice('info', 'No cloud projects yet. /push in a repository creates one.');
      return;
    }
    const current = this.state.project?.id;
    this.setState({
      picker: {
        kind: 'projects',
        title: 'Projects',
        subtitle: 'Messages you send are about the project you choose',
        options: projects.map((p) => ({
          value: p.id,
          label: p.name,
          hint: [
            p.id === current ? 'current' : null,
            `${p.taskCount} ${p.taskCount === 1 ? 'run' : 'runs'}`,
            p.lastTaskAt ? `last ${ago(p.lastTaskAt)}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        })),
        footer: 'enter choose · esc cancel',
        initialIndex: Math.max(
          0,
          projects.findIndex((p) => p.id === current),
        ),
      },
    });
  }

  private runOption(task: TaskRecord): PickerOption {
    const s = this.now();
    return {
      value: task.id,
      label: task.title,
      mark: statusMark(task.status),
      spinner: task.status === 'starting' || task.status === 'running',
      hint: [
        // A column of the same width, so the status is always in the same place.
        STATUS_LABEL[task.status].padEnd(STATUS_COLUMN),
        this.projectNameOf(task.projectId),
        taskRuntime(task, s) ?? ago(task.createdAt, s),
        task.costUsd > 0 ? money(task.costUsd) : null,
      ]
        .filter(Boolean)
        .join(' · '),
    };
  }

  private async openRunsPicker(): Promise<void> {
    const api = this.requireApi();
    const tasks = await this.call(() => api.listTasks({ limit: PICKER_LIMIT }));
    if (tasks.length === 0) {
      this.notice('info', 'No runs yet. Ask Patch to do something, or use ptch cloud submit.');
      return;
    }
    this.setState({
      picker: {
        kind: 'runs',
        title: 'Recent runs',
        subtitle: 'Runs that are still going update here.',
        options: tasks.map((t) => this.runOption(t)),
        footer: 'enter follow the log · esc cancel',
      },
    });
  }

  private async refreshRunsPicker(): Promise<void> {
    const api = this.api;
    const picker = this.state.picker;
    if (!api || picker?.kind !== 'runs') return;
    const tasks = await this.guard(() => api.listTasks({ limit: PICKER_LIMIT }));
    if (!tasks || this.state.picker?.kind !== 'runs') return;
    this.setState({ picker: { ...picker, options: tasks.map((t) => this.runOption(t)) } });
  }

  async selectPicker(value: string): Promise<void> {
    const picker = this.state.picker;
    if (!picker) return;
    this.setState({ picker: null });
    try {
      switch (picker.kind) {
        case 'conversations':
          await this.openConversation(value);
          break;
        case 'projects': {
          const found = this.state.projects.find((p) => p.id === value);
          if (found) {
            this.setState({ project: { id: found.id, name: found.name } });
            this.notice('info', `Working in project ${found.name}.`);
          }
          break;
        }
        case 'runs':
          await this.followRun(value);
          break;
        case 'brain':
        case 'brain-links':
          await this.openBrainEntry(value);
          break;
        case 'choose': {
          const choose = activeChooseProject(this.state.entries);
          const found = this.state.projects.find((p) => p.id === value);
          if (!choose || !found) break;
          this.setState({ project: { id: found.id, name: found.name } });
          await this.send(choose.text, found.id);
          break;
        }
      }
    } catch (error) {
      this.notice('error', errorText(error));
    }
  }

  cancelPicker(): void {
    const picker = this.state.picker;
    if (!picker) return;
    if (picker.kind === 'choose') {
      const choose = activeChooseProject(this.state.entries);
      if (choose) this.chooseDismissed.add(choose.messageId);
    }
    this.setState({ picker: null });
    this.syncFocus();
  }

  // ------------------------------------------------------------------ following a run

  private async resolveTask(ref: string): Promise<TaskRecord | null> {
    const api = this.requireApi();
    if (/^tsk_[0-9a-z]{20,}$/.test(ref)) {
      const found = await this.call(() => api.tasksByIds([ref]));
      return found[0] ?? null;
    }
    const tasks = await this.call(() => api.listTasks({ limit: 200 }));
    let matches = tasks.filter((t) => t.id.startsWith(ref) || t.id.startsWith(`tsk_${ref}`));
    // Not an id: a word from the title does as well, when it names one run.
    if (matches.length === 0) {
      const word = ref.toLowerCase();
      matches = tasks.filter((t) => t.title.toLowerCase().includes(word));
    }
    if (matches.length === 1) return matches[0] as TaskRecord;
    this.notice(
      'warn',
      matches.length === 0
        ? `No run matches "${ref}". Try /runs.`
        : `"${ref}" matches ${matches.length} runs; use more characters or choose from /runs.`,
    );
    return null;
  }

  async followRun(ref: string): Promise<void> {
    const api = this.requireApi();
    const task = await this.resolveTask(ref);
    if (!task) return;
    this.followAbort?.abort();
    const abort = new AbortController();
    this.followAbort = abort;
    this.addEntries({
      kind: 'notice',
      id: this.id('n'),
      level: 'info',
      text: isTerminal(task.status)
        ? `Log of ${task.title} (${task.id})`
        : `Following ${task.title} (${task.id}). Esc stops following; the run keeps going.`,
    });
    this.setState({
      follow: { taskId: task.id, title: task.title },
      proposal: this.state.proposal && { ...this.state.proposal, parked: true },
    });
    try {
      await api.follow(
        task.id,
        (event) => {
          const line = renderEvent(event, { verbose: false });
          if (line !== null) this.queueLog(line);
        },
        { signal: abort.signal },
      );
      this.flushLog();
      const detail = await this.call(() => api.getTask(task.id));
      this.addEntries({
        kind: 'run-end',
        id: this.id('r'),
        task: detail.task,
        project: this.projectNameOf(detail.task.projectId),
      });
      this.setState({ tasks: { ...this.state.tasks, [detail.task.id]: detail.task } });
    } catch (error) {
      this.flushLog();
      if ((error as Error).name === 'AbortError') {
        this.notice('info', 'Stopped following. The run continues in the cloud.');
      } else {
        this.notice('error', errorText(error));
      }
    } finally {
      if (this.followAbort === abort) this.followAbort = null;
      this.setState({ follow: null });
      this.parkProposal(false);
    }
  }

  stopFollowing(): void {
    this.followAbort?.abort();
  }

  /** Log lines arrive in bursts; they are written together. */
  private queueLog(line: string): void {
    this.logBuffer.push(line);
    this.logTimer ??= setTimeout(() => this.flushLog(), 40);
  }

  private flushLog(): void {
    clearTimeout(this.logTimer);
    this.logTimer = undefined;
    if (this.logBuffer.length === 0) return;
    const lines = this.logBuffer;
    this.logBuffer = [];
    this.addEntries(...lines.map((text): Entry => ({ kind: 'log', id: this.id('l'), text })));
  }

  // ------------------------------------------------------------------ the Brain

  private async openBrain(): Promise<void> {
    const project = this.state.project;
    if (!project) {
      this.notice('info', 'Choose a project first: /projects');
      return;
    }
    const api = this.requireApi();
    const graph = await this.call(() =>
      api.brainGraph({ project: project.id, limit: BRAIN_LIMIT }),
    );
    if (graph.nodes.length === 0) {
      this.notice(
        'info',
        `${project.name} has no Brain entries yet. /brain add <title> writes a note.`,
      );
      return;
    }
    const now = new Date(this.now());
    this.setState({
      picker: {
        kind: 'brain',
        title: `Brain · ${project.name}`,
        subtitle: `${graph.nodes.length} ${graph.nodes.length === 1 ? 'entry' : 'entries'}${graph.truncated ? ' (the newest; more exist)' : ''} · ${plural(graph.links.length, 'link')}`,
        options: graph.nodes.map((n) => ({
          value: n.id,
          label: `${n.kind.padEnd(9)} ${n.title}`,
          hint: `${n.degree} ${n.degree === 1 ? 'link' : 'links'} · ${since(n.updatedAt, now)}`,
        })),
        footer: 'enter read · esc cancel',
      },
    });
  }

  private async openBrainEntry(id: string): Promise<void> {
    const api = this.requireApi();
    const detail = await this.call(() => api.brainEntry(id));
    this.addEntries(brainEntryItem(detail, this.id('b'), new Date(this.now())));
    if (detail.links.length > 0) {
      this.setState({
        picker: {
          kind: 'brain-links',
          title: `Linked to "${detail.entry.title}"`,
          options: detail.links.map((l) => ({
            value: l.other.id,
            label: `${l.direction === 'out' ? '→' : '←'} ${l.link.type}  ${l.other.title}`,
            hint: `${l.other.kind}${l.other.archived ? ' · archived' : ''}`,
          })),
          footer: 'enter open · esc done',
        },
      });
    }
  }

  private async addBrainNote(title: string): Promise<void> {
    const project = this.state.project;
    if (!project) {
      this.notice('info', 'Choose a project first: /projects');
      return;
    }
    if (!title) {
      this.notice('warn', 'Usage: /brain add <title>');
      return;
    }
    const api = this.requireApi();
    const entry = await this.call(() =>
      api.addBrainEntry(project.id, { kind: 'note', title, body: '' }),
    );
    this.notice('info', `Added a note to the Brain of ${project.name}: ${entry.title}`);
  }

  // ------------------------------------------------------------------ /push

  private async beginPush(): Promise<void> {
    const api = this.requireApi();
    let plan: SnapshotPlan;
    try {
      plan = await this.backend.planPush();
    } catch (error) {
      this.notice('error', error instanceof SnapshotError ? error.message : errorText(error));
      return;
    }
    const projects = await this.call(() => api.listProjects());
    this.setState({ projects });
    const current = this.state.project;
    const linked = await this.backend.linkedProject();
    const byCurrent = current ? projects.find((p) => p.id === current.id) : undefined;
    const byLink = linked.projectId ? projects.find((p) => p.id === linked.projectId) : undefined;
    const byRemote = plan.remote ? projects.filter((p) => p.gitRemote === plan.remote) : [];
    const name = plan.root.split(/[\\/]/).filter(Boolean).pop() ?? 'project';
    const project =
      byLink ??
      byCurrent ??
      (byRemote.length === 1 ? (byRemote[0] as ProjectRecord) : undefined) ??
      projects.find((p) => p.name === name) ??
      null;
    const targetName = project?.name ?? name;
    const lines = renderPreview(plan, {
      host: api.url,
      project: project ? targetName : `${targetName} (will be created)`,
      profile: 'chosen for each run',
    });
    this.addEntries({ kind: 'doc', id: this.id('d'), title: 'Upload preview', lines });
    if (plan.files.length === 0) {
      this.notice('error', 'There are no files to upload.');
      return;
    }
    this.pendingPush = { plan, project, name: targetName };
    this.setState({
      push: {
        question: `Upload ${plan.files.length} files to ${targetName} on ${hostOf(api.url)} as a new snapshot?`,
        busy: false,
      },
    });
  }

  async confirmPush(): Promise<void> {
    const pending = this.pendingPush;
    const push = this.state.push;
    if (!pending || !push || push.busy) return;
    const api = this.requireApi();
    this.setState({ push: { ...push, busy: true } });
    try {
      const target =
        pending.project ??
        (await this.call(() =>
          api.createProject({
            name: pending.name,
            description: '',
            gitRemote: pending.plan.remote,
          }),
        ));
      if (!pending.project) this.notice('info', `Created cloud project "${target.name}".`);
      this.backend.linkProject(pending.plan.root, target.id);
      const built = await this.backend.buildArchive(pending.plan);
      if (built.unreadable.length > 0) {
        this.notice(
          'warn',
          `Could not read ${built.unreadable.length} file(s), left out: ${built.unreadable.slice(0, 5).join(', ')}`,
        );
      }
      const snapshot = await this.call(() =>
        api.uploadSnapshot(target.id, built.archive, built.manifest),
      );
      this.pendingPush = null;
      const projects = (await this.guard(() => api.listProjects())) ?? this.state.projects;
      this.setState({
        push: null,
        projects,
        project: { id: target.id, name: target.name },
      });
      this.notice(
        'info',
        `Uploaded ${built.manifest.fileCount} files (${(built.archive.length / 1024 / 1024).toFixed(1)} MB compressed) to ${target.name}: snapshot ${snapshot.id}. Ask Patch to start a run on it.`,
      );
    } catch (error) {
      this.pendingPush = null;
      this.setState({ push: null });
      this.notice('error', `Nothing was started. ${errorText(error)}`);
    }
  }

  cancelPush(): void {
    if (!this.state.push || this.state.push.busy) return;
    this.pendingPush = null;
    this.setState({ push: null });
    this.notice('info', 'Cancelled. Nothing was uploaded.');
  }

  // ------------------------------------------------------------------ keys

  /** Ctrl+C: cancels what is open, then clears the prompt, then (twice) leaves. */
  handleCtrlC(promptHasText: boolean): 'interrupted' | 'clear-prompt' | 'armed' | 'exit' {
    if (this.signInAbort) {
      this.signInAbort.abort();
      return 'interrupted';
    }
    if (this.state.follow) {
      this.stopFollowing();
      return 'interrupted';
    }
    if (this.state.picker) {
      this.cancelPicker();
      return 'interrupted';
    }
    if (this.state.push && !this.state.push.busy) {
      this.cancelPush();
      return 'interrupted';
    }
    if (this.state.proposal?.editing) {
      this.cancelProposalEdit();
      return 'interrupted';
    }
    if (promptHasText) return 'clear-prompt';
    const armed = this.state.exitArmedAt;
    if (armed !== null && this.now() - armed < EXIT_CONFIRM_MS) {
      this.requestExit();
      return 'exit';
    }
    this.setState({ exitArmedAt: this.now() });
    setTimeout(() => {
      if (
        this.state.exitArmedAt !== null &&
        this.now() - this.state.exitArmedAt >= EXIT_CONFIRM_MS
      ) {
        this.setState({ exitArmedAt: null });
      }
    }, EXIT_CONFIRM_MS + 50).unref?.();
    return 'armed';
  }

  requestExit(): void {
    this.signInAbort?.abort();
    this.followAbort?.abort();
    this.setState({ exiting: true });
  }
}

// ---------------------------------------------------------------------- helpers

export function statusMark(status: TaskRecord['status']): string {
  switch (status) {
    case 'succeeded':
      return '✓';
    case 'failed':
      return '✗';
    case 'interrupted':
      return '!';
    case 'cancelled':
      return '–';
    case 'queued':
      return '○';
    default:
      return '●';
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A refused confirm carries the proposal as it was recorded (state failed, with the reason). */
function refusedProposal(error: unknown): MessageRecord | null {
  if (!(error instanceof CloudApiError)) return null;
  const body = error.body as { proposal?: MessageRecord } | undefined;
  return body?.proposal && typeof body.proposal === 'object' ? body.proposal : null;
}

/** A readable one-line reason for an error. */
export function errorText(error: unknown): string {
  if (error instanceof CloudApiError) {
    if (error.status === 429) {
      return `Patch Cloud is limiting requests right now (429). Wait a moment and try again.${error.message ? ` ${error.message}` : ''}`;
    }
    if (error.status === 401) return 'Your sign-in expired. Type /login to sign in again.';
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function brainEntryItem(detail: BrainEntryDetail, id: string, now: Date): Entry {
  const { entry } = detail;
  const meta = [
    detail.projectName,
    `updated ${since(entry.updatedAt, now)}`,
    entry.source === 'task'
      ? 'written from a finished run'
      : entry.source === 'user'
        ? 'written by you'
        : 'written by Patch Cloud',
    entry.archived ? 'archived' : null,
    entry.tags.length > 0 ? entry.tags.map((t) => `#${t}`).join(' ') : null,
  ].filter((m): m is string => Boolean(m));
  if (detail.sourceTask) {
    const t = detail.sourceTask;
    meta.push(
      `run ${t.title}: ${t.status}${t.costUsd > 0 ? `, ${money(t.costUsd)}` : ''}${t.finishedAt ? `, ${ago(t.finishedAt, now.getTime())}` : ''}${t.changedFiles.length > 0 ? `, ${t.changedFiles.length} files changed` : ''}`,
    );
  }
  const links = detail.links.map((l) => {
    const evidence =
      l.link.origin === 'derived' && l.link.evidence.length > 0
        ? ` (derived: ${l.link.evidence.slice(0, 3).join(', ')})`
        : l.link.origin === 'suggested'
          ? ' (suggested, not confirmed)'
          : '';
    return `${l.direction === 'out' ? '→' : '←'} ${l.link.type}  ${l.other.title}  [${l.other.kind}]${evidence}`;
  });
  return {
    kind: 'brain-entry',
    id,
    title: entry.title,
    entryKind: entry.kind,
    meta,
    body: entry.body,
    links,
  };
}
