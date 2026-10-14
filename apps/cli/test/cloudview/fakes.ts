import type {
  BrainEntryDetail,
  BrainGraphResponse,
  CloudStatus,
  ConversationRecord,
  EventPage,
  EventRecord,
  MessageBlock,
  MessageRecord,
  ProjectRecord,
  SnapshotRecord,
  TaskRecord,
} from '@patch/cloud-protocol';
import type { CloudBackend, CloudViewApi, LoginHooks } from '../../src/cloudview/backend.js';
import { CloudApiError } from '../../src/cloud/client.js';
import type { SnapshotPlan } from '../../src/cloud/snapshot.js';

export const NOW = Date.now();
export const iso = (offsetMs = 0): string => new Date(NOW + offsetMs).toISOString();

export function project(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'prj_demo',
    name: 'Demo App',
    slug: 'demo-app',
    description: '',
    gitRemote: null,
    createdAt: iso(-86_400_000),
    taskCount: 3,
    lastTaskAt: iso(-60_000),
    ...over,
  };
}

export function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'tsk_aaaaaaaaaaaaaaaaaaaaaaaa',
    projectId: 'prj_demo',
    snapshotId: 'snp_1',
    title: 'Fix the failing tests',
    prompt: 'Fix the failing tests',
    status: 'running',
    profile: 'auto',
    model: null,
    priority: 0,
    origin: 'hq',
    parentTaskId: null,
    retryOf: null,
    limits: { maxCostUsd: 5, maxDurationSec: 3600, maxSteps: 200 },
    costUsd: 0.12,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    steps: 3,
    toolCalls: 2,
    cancelRequested: false,
    resultSummary: null,
    error: null,
    createdAt: iso(-120_000),
    startedAt: iso(-100_000),
    finishedAt: null,
    workerId: 'w1',
    metadata: {},
    ...over,
  };
}

export function message(
  id: string,
  role: 'user' | 'assistant',
  blocks: MessageBlock[],
  conversationId = 'cnv_aaaaaaaaaaaaaaa',
): MessageRecord {
  return { id, conversationId, role, blocks, createdAt: iso() };
}

export function status(over: Partial<CloudStatus['worker']> = {}): CloudStatus {
  return {
    version: '0.4.0',
    now: iso(),
    queue: {
      queued: 0,
      starting: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
    },
    worker: {
      id: 'w1',
      lastSeen: iso(),
      online: true,
      startedAt: iso(-1000),
      sandbox: 'docker',
      version: '0.4.0',
      currentTaskId: null,
      ...over,
    },
    budget: {
      dailyLimitUsd: null,
      monthlyLimitUsd: null,
      spentTodayUsd: 0,
      spentMonthUsd: 0,
      blocked: false,
    },
    usage: {
      today: {
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        requests: 0,
      },
      month: {
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        requests: 0,
      },
    },
  };
}

/** A hand-driven stand-in for the Patch Cloud API: every behavior is a property the test sets. */
export class FakeApi implements CloudViewApi {
  url = 'https://cloud.test';
  projects: ProjectRecord[] = [project()];
  tasks = new Map<string, TaskRecord>();
  conversations = new Map<string, ConversationRecord>();
  messages = new Map<string, MessageRecord[]>();
  brain: BrainGraphResponse = {
    nodes: [],
    links: [],
    truncated: false,
    projects: [],
    counts: { knowledge: 0, decision: 0, note: 0, change: 0 },
  };
  brainDetails = new Map<string, BrainEntryDetail>();
  snapshots: SnapshotRecord[] = [];
  eventLog = new Map<string, EventRecord[]>();
  workerOnline = true;
  /** What /auth/me says: false when the saved sign-in is no longer valid. */
  meAuthenticated = true;
  /** Errors thrown by the next calls, in order (any method). */
  failures: Error[] = [];
  /** Every call, "method arg", for assertions. */
  log: string[] = [];
  uploads: Array<{ projectId: string; fileCount: number }> = [];
  /**
   * When set, the answer is written by "the chat model": sendMessage returns it pending and each
   * getMessage returns the next step (the last one should have no status: complete).
   */
  answerSteps: Array<Partial<MessageRecord>> | null = null;

  /** What the assistant answers; the test replaces it. */
  reply: (text: string, projectId: string | null | undefined) => MessageBlock[] = (text) => [
    { type: 'text', text: `You said: ${text}` },
  ];
  /** The confirm handler (default: creates a queued task). */
  confirmError: (() => Error) | null = null;
  followScript: Array<{ type: string; data: Record<string, unknown> }> = [];
  followFinal: TaskRecord | null = null;
  private seq = 0;

  private enter(call: string): void {
    this.log.push(call);
    const failure = this.failures.shift();
    if (failure) throw failure;
  }

  async status(): Promise<CloudStatus> {
    this.enter('status');
    return status({ online: this.workerOnline });
  }

  async me() {
    this.enter('me');
    return {
      authenticated: this.meAuthenticated,
      kind: 'oauth' as const,
      version: '0.4.0',
      account: { id: 'acc', name: 'Owner' },
      client: { id: 'patch-cli', name: 'Patch CLI', device: 'test (ptch)' },
    };
  }

  async listProjects() {
    this.enter('listProjects');
    return this.projects;
  }

  async projectDetail(id: string) {
    this.enter(`projectDetail ${id}`);
    const found = this.projects.find((p) => p.id === id) as ProjectRecord;
    return { project: found, tasks: [], snapshots: this.snapshots };
  }

  async createProject(input: { name: string; description?: string; gitRemote?: string | null }) {
    this.enter(`createProject ${input.name}`);
    const created = project({ id: `prj_new${++this.seq}`, name: input.name, taskCount: 0 });
    this.projects.push(created);
    return created;
  }

  async uploadSnapshot(projectId: string, archive: Buffer, manifest: { fileCount: number }) {
    this.enter(`uploadSnapshot ${projectId}`);
    this.uploads.push({ projectId, fileCount: manifest.fileCount });
    return {
      id: `snp_up${++this.seq}`,
      projectId,
      createdAt: iso(),
      sizeBytes: archive.length,
      fileCount: manifest.fileCount,
      sha256: 'a'.repeat(64),
      baseCommit: null,
      branch: null,
      dirtyFiles: [],
    } satisfies SnapshotRecord;
  }

  async listTasks(query: { limit?: number } = {}) {
    this.enter('listTasks');
    return [...this.tasks.values()].slice(0, query.limit ?? 20);
  }

  async getTask(id: string) {
    this.enter(`getTask ${id}`);
    const found = this.tasks.get(id);
    if (!found) throw new CloudApiError('Task not found', 404, 'not_found');
    return { task: found, artifacts: [], snapshot: null, retries: [] };
  }

  async tasksByIds(ids: readonly string[]) {
    this.enter(`tasksByIds ${ids.join(',')}`);
    return ids.map((id) => this.tasks.get(id)).filter((t): t is TaskRecord => t !== undefined);
  }

  async events(id: string, after = 0): Promise<EventPage> {
    this.enter(`events ${id}`);
    const all = (this.eventLog.get(id) ?? []).filter((e) => e.seq > after);
    return { events: all, cursor: all.at(-1)?.seq ?? after };
  }

  async follow(
    id: string,
    onEvent: (event: EventRecord) => void,
    options: { after?: number; signal?: AbortSignal } = {},
  ): Promise<{ status: string }> {
    this.enter(`follow ${id}`);
    let seq = 0;
    for (const e of this.followScript) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      onEvent({
        seq: ++seq,
        taskId: id,
        projectId: null,
        ts: iso(),
        type: e.type,
        level: 'info',
        data: e.data,
      });
    }
    if (this.followHold) {
      await new Promise<void>((resolve, reject) => {
        options.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
        this.release = resolve;
      });
    }
    return { status: this.followFinal?.status ?? 'succeeded' };
  }

  /** Keep `follow` open until `release()` (or an abort). */
  followHold = false;
  release: () => void = () => undefined;

  async listConversations(query: { limit?: number } = {}) {
    this.enter('listConversations');
    return [...this.conversations.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, query.limit ?? 30);
  }

  async createConversation(input: { projectId?: string | null; title?: string } = {}) {
    this.enter('createConversation');
    const id = `cnv_${String(++this.seq).padStart(15, '0')}`;
    const record: ConversationRecord = {
      id,
      title: input.title ?? 'New chat',
      projectId: input.projectId ?? null,
      createdAt: iso(this.seq * 1000),
      updatedAt: iso(this.seq * 1000),
      archived: false,
      messageCount: 0,
    };
    this.conversations.set(id, record);
    this.messages.set(id, []);
    return record;
  }

  async getConversation(id: string) {
    this.enter(`getConversation ${id}`);
    const conversation = this.conversations.get(id);
    if (!conversation) throw new CloudApiError('Conversation not found', 404, 'not_found');
    return { conversation, messages: this.messages.get(id) ?? [] };
  }

  async getMessage(id: string, messageId: string) {
    this.enter(`getMessage ${messageId}`);
    const list = this.messages.get(id) ?? [];
    const index = list.findIndex((m) => m.id === messageId);
    if (index < 0) throw new CloudApiError('Unknown message', 404, 'not_found');
    const step = this.answerSteps?.shift();
    if (step) {
      const { status: _status, activity: _activity, ...rest } = list[index] as MessageRecord;
      list[index] = { ...rest, ...step } as MessageRecord;
    }
    return list[index] as MessageRecord;
  }

  async sendMessage(id: string, input: { text: string; projectId?: string | null }) {
    this.enter(`sendMessage ${input.text}`);
    const conversation = this.conversations.get(id) as ConversationRecord;
    if (input.projectId) conversation.projectId = input.projectId;
    const list = this.messages.get(id) as MessageRecord[];
    const user = message(`msg_${++this.seq}`, 'user', [{ type: 'text', text: input.text }], id);
    const assistant: MessageRecord = this.answerSteps
      ? {
          ...message(`msg_${++this.seq}`, 'assistant', [], id),
          status: 'pending',
          activity: 'Thinking',
        }
      : message(
          `msg_${++this.seq}`,
          'assistant',
          this.reply(input.text, conversation.projectId),
          id,
        );
    list.push(user, assistant);
    conversation.messageCount = list.length;
    if (conversation.title === 'New chat') conversation.title = input.text.slice(0, 60);
    return { user, assistant, conversation: { ...conversation } };
  }

  async confirmProposal(
    id: string,
    messageId: string,
    input: { prompt?: string; profile?: 'plan' | 'edits' | 'auto' } = {},
  ) {
    this.enter(`confirmProposal ${messageId} ${JSON.stringify(input)}`);
    if (this.confirmError) throw this.confirmError();
    const list = this.messages.get(id) as MessageRecord[];
    const index = list.findIndex((m) => m.id === messageId);
    const old = list[index] as MessageRecord;
    const block = old.blocks.find((b) => b.type === 'proposal');
    if (!block || block.type !== 'proposal')
      throw new CloudApiError('Not a proposal', 400, 'invalid');
    const created = task({
      id: `tsk_${String(++this.seq).padStart(24, 'b')}`,
      title: (input.prompt ?? block.prompt).slice(0, 60),
      prompt: input.prompt ?? block.prompt,
      profile: input.profile ?? block.profile,
      status: 'queued',
      startedAt: null,
      steps: 0,
      costUsd: 0,
    });
    this.tasks.set(created.id, created);
    const proposal: MessageRecord = {
      ...old,
      blocks: old.blocks.map((b) =>
        b === block ? { ...block, state: 'confirmed' as const, taskId: created.id } : b,
      ),
    };
    list[index] = proposal;
    const assistant = message(
      `msg_${++this.seq}`,
      'assistant',
      [
        { type: 'text', text: `Started: ${created.title}` },
        { type: 'run', taskId: created.id },
      ],
      id,
    );
    list.push(assistant);
    const conversation = this.conversations.get(id) as ConversationRecord;
    conversation.messageCount = list.length;
    return { proposal, assistant, task: created, conversation: { ...conversation } };
  }

  async dismissProposal(id: string, messageId: string) {
    this.enter(`dismissProposal ${messageId}`);
    const list = this.messages.get(id) as MessageRecord[];
    const index = list.findIndex((m) => m.id === messageId);
    const old = list[index] as MessageRecord;
    const block = old.blocks.find((b) => b.type === 'proposal');
    if (!block || block.type !== 'proposal')
      throw new CloudApiError('Not a proposal', 400, 'invalid');
    const proposal: MessageRecord = {
      ...old,
      blocks: old.blocks.map((b) => (b === block ? { ...block, state: 'dismissed' as const } : b)),
    };
    list[index] = proposal;
    return { proposal, conversation: { ...(this.conversations.get(id) as ConversationRecord) } };
  }

  async brainGraph() {
    this.enter('brainGraph');
    return this.brain;
  }

  async brainEntry(id: string) {
    this.enter(`brainEntry ${id}`);
    const found = this.brainDetails.get(id);
    if (!found) throw new CloudApiError('Entry not found', 404, 'not_found');
    return found;
  }

  async addBrainEntry(projectId: string, entry: { kind: string; title: string }) {
    this.enter(`addBrainEntry ${entry.title}`);
    return {
      id: 'bre_new',
      projectId,
      kind: 'note' as const,
      title: entry.title,
      body: '',
      tags: [],
      source: 'user' as const,
      sourceTaskId: null,
      createdAt: iso(),
      updatedAt: iso(),
      archived: false,
    };
  }
}

export interface FakeBackendOptions {
  signedIn?: boolean;
  linkedProject?: string;
  /** What logging in does (default: succeeds with the given api). */
  login?: (hooks: LoginHooks) => Promise<CloudViewApi>;
  plan?: SnapshotPlan;
}

export class FakeBackend implements CloudBackend {
  cwd = '/repo';
  signedIn: boolean;
  linked: Array<[string, string]> = [];
  loginCalls = 0;
  logoutCalls = 0;
  planCalls = 0;

  constructor(
    readonly api: FakeApi,
    private readonly options: FakeBackendOptions = {},
  ) {
    this.signedIn = options.signedIn ?? true;
  }

  isSignedIn(): boolean {
    return this.signedIn;
  }
  host(): string | null {
    return this.signedIn ? this.api.url : null;
  }
  async connect(): Promise<CloudViewApi | null> {
    return this.signedIn ? this.api : null;
  }
  async login(hooks: LoginHooks): Promise<CloudViewApi> {
    this.loginCalls += 1;
    const api = this.options.login ? await this.options.login(hooks) : this.api;
    this.signedIn = true;
    return api;
  }
  async logout(): Promise<{ revoked: boolean }> {
    this.logoutCalls += 1;
    this.signedIn = false;
    return { revoked: true };
  }
  async linkedProject() {
    return this.options.linkedProject
      ? { root: '/repo', projectId: this.options.linkedProject }
      : { root: '/repo' };
  }
  linkProject(root: string, projectId: string): void {
    this.linked.push([root, projectId]);
  }
  async planPush(): Promise<SnapshotPlan> {
    this.planCalls += 1;
    return (
      this.options.plan ?? {
        root: '/repo',
        branch: 'main',
        baseCommit: 'a'.repeat(40),
        remote: null,
        files: [
          { path: 'a.txt', size: 10, executable: false },
          { path: 'src/b.ts', size: 20, executable: false },
        ],
        totalBytes: 30,
        excluded: [{ path: '.env', reason: 'looks like a secret (.env file)' }],
        dirty: [{ path: 'src/b.ts', kind: 'modified' }],
      }
    );
  }
  buildArchive: CloudBackend['buildArchive'] = async (plan) => ({
    archive: Buffer.from('archive'),
    manifest: {
      fileCount: plan.files.length,
      baseCommit: plan.baseCommit,
      branch: plan.branch,
      dirtyFiles: [],
    },
    unreadable: [],
  });
}
