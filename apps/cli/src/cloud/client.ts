import {
  API_VERSION,
  SNAPSHOT_MANIFEST_HEADER,
  type BrainEntry,
  type BrainEntryDetail,
  type BrainGraphResponse,
  type ConfirmProposalRequest,
  type ConfirmProposalResponse,
  type ConversationDetail,
  type ConversationRecord,
  type CreateConversationRequest,
  type DismissProposalResponse,
  type MessageRecord,
  type SendMessageRequest,
  type SendMessageResponse,
  type CloudStatus,
  type CreateBrainEntryRequest,
  type CreateTaskRequest,
  type EventPage,
  type EventRecord,
  type ArtifactRecord,
  type ProjectRecord,
  type SnapshotManifest,
  type SnapshotRecord,
  type TaskRecord,
} from '@patch/cloud-protocol';
import { stripControls, toDisplayText } from '../ui/text-layout.js';
import type { CloudCredentials } from './config.js';

export class CloudApiError extends Error {
  override readonly name = 'CloudApiError';
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /** The parsed error body, when there was one (a refused confirm carries the failed proposal). */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export interface AccountInfo {
  authenticated: boolean;
  kind: 'session' | 'token' | 'oauth' | null;
  version?: string;
  account?: { id: string; name: string };
  expiresAt?: string | null;
  client?: { id: string; name: string; device: string } | null;
}

export interface TaskDetail {
  task: TaskRecord;
  artifacts: ArtifactRecord[];
  snapshot: SnapshotRecord | null;
  retries: string[];
}

/** Supplies the bearer token, and renews it when the server says it has expired. */
export interface TokenProvider {
  accessToken(): Promise<string>;
  refresh(): Promise<string>;
}

/** A small typed client for the Patch Cloud HTTP API. */
export class CloudApi {
  constructor(
    private readonly creds: CloudCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly tokens?: TokenProvider,
  ) {}

  get url(): string {
    return this.creds.url;
  }

  private async send(path: string, init: RequestInit = {}, renewed = false): Promise<Response> {
    let response: Response;
    const token = this.tokens ? await this.tokens.accessToken() : this.creds.token;
    try {
      response = await this.fetchImpl(`${this.creds.url}/api/${API_VERSION}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      throw new CloudApiError(
        `Cannot reach Patch Cloud at ${this.creds.url}. Check your connection; if the host is a private-network address, is that network connected?`,
        0,
        'unreachable',
      );
    }
    if (response.ok) return response;
    // An access token can expire between the check and the request: renew once and retry.
    if (response.status === 401 && this.tokens && !renewed) {
      await this.tokens.refresh();
      return this.send(path, init, true);
    }
    let code = 'error';
    let parsed: unknown;
    let message = `Patch Cloud answered ${response.status}.`;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      parsed = body;
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      // not JSON
    }
    if (response.status === 401) {
      message = this.tokens
        ? 'Patch Cloud rejected this sign-in. Run: ptch login'
        : 'Patch Cloud rejected the token. Run "ptch login", or create a new token on the host and run "ptch cloud login <url>".';
    }
    // The server wrote these: no escape sequence reaches a terminal through an error.
    throw new CloudApiError(toDisplayText(message), response.status, stripControls(code), parsed);
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await this.send(path, init)).json()) as T;
  }

  private post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.json<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  status(): Promise<CloudStatus> {
    return this.json('/status');
  }

  /** Who this credential is, and when it stops working unless renewed. */
  me(): Promise<AccountInfo> {
    return this.json('/auth/me');
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return (await this.json<{ projects: ProjectRecord[] }>('/projects')).projects;
  }

  /** A project with its newest snapshots and recent tasks. */
  projectDetail(
    id: string,
  ): Promise<{ project: ProjectRecord; tasks: TaskRecord[]; snapshots: SnapshotRecord[] }> {
    return this.json(`/projects/${encodeURIComponent(id)}`);
  }

  createProject(input: {
    name: string;
    description?: string;
    gitRemote?: string | null;
  }): Promise<ProjectRecord> {
    return this.post('/projects', input);
  }

  uploadSnapshot(
    projectId: string,
    archive: Buffer,
    manifest: SnapshotManifest,
  ): Promise<SnapshotRecord> {
    return this.json(`/projects/${encodeURIComponent(projectId)}/snapshots`, {
      method: 'POST',
      headers: {
        'content-type': 'application/gzip',
        [SNAPSHOT_MANIFEST_HEADER]: Buffer.from(JSON.stringify(manifest)).toString('base64'),
      },
      body: new Uint8Array(archive),
    });
  }

  createTask(input: CreateTaskRequest): Promise<TaskRecord> {
    return this.post('/tasks', input);
  }

  async listTasks(
    query: { status?: string; project?: string; limit?: number } = {},
  ): Promise<TaskRecord[]> {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.project) params.set('project', query.project);
    if (query.limit) params.set('limit', String(query.limit));
    const suffix = params.size > 0 ? `?${params}` : '';
    return (await this.json<{ tasks: TaskRecord[] }>(`/tasks${suffix}`)).tasks;
  }

  getTask(id: string): Promise<TaskDetail> {
    return this.json(`/tasks/${encodeURIComponent(id)}`);
  }

  cancelTask(id: string): Promise<TaskRecord> {
    return this.post(`/tasks/${encodeURIComponent(id)}/cancel`);
  }

  retryTask(id: string): Promise<TaskRecord> {
    return this.post(`/tasks/${encodeURIComponent(id)}/retry`, { origin: 'cli' });
  }

  events(id: string, after = 0): Promise<EventPage> {
    return this.json(`/tasks/${encodeURIComponent(id)}/events?after=${after}&limit=2000`);
  }

  async downloadArtifact(id: string): Promise<Buffer> {
    return Buffer.from(
      await (await this.send(`/artifacts/${encodeURIComponent(id)}/download`)).arrayBuffer(),
    );
  }

  async brain(projectId: string, query: { q?: string; kind?: string } = {}): Promise<BrainEntry[]> {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.kind) params.set('kind', query.kind);
    const suffix = params.size > 0 ? `?${params}` : '';
    return (
      await this.json<{ entries: BrainEntry[] }>(
        `/projects/${encodeURIComponent(projectId)}/brain${suffix}`,
      )
    ).entries;
  }

  addBrainEntry(projectId: string, entry: CreateBrainEntryRequest): Promise<BrainEntry> {
    return this.post(`/projects/${encodeURIComponent(projectId)}/brain`, entry);
  }

  // ---- conversations (the chat of Patch HQ) ----

  async listConversations(
    query: { project?: string; limit?: number; before?: string } = {},
  ): Promise<ConversationRecord[]> {
    const params = new URLSearchParams();
    if (query.project) params.set('project', query.project);
    if (query.limit) params.set('limit', String(query.limit));
    if (query.before) params.set('before', query.before);
    const suffix = params.size > 0 ? `?${params}` : '';
    return (await this.json<{ conversations: ConversationRecord[] }>(`/conversations${suffix}`))
      .conversations;
  }

  createConversation(input: CreateConversationRequest = {}): Promise<ConversationRecord> {
    return this.post('/conversations', input);
  }

  getConversation(id: string): Promise<ConversationDetail> {
    return this.json(`/conversations/${encodeURIComponent(id)}`);
  }

  /** One message: how an answer the chat model is still writing is followed. */
  getMessage(id: string, messageId: string): Promise<MessageRecord> {
    return this.json(
      `/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`,
    );
  }

  sendMessage(id: string, input: SendMessageRequest): Promise<SendMessageResponse> {
    return this.post(`/conversations/${encodeURIComponent(id)}/messages`, input);
  }

  confirmProposal(
    id: string,
    messageId: string,
    input: ConfirmProposalRequest = {},
  ): Promise<ConfirmProposalResponse> {
    return this.post(
      `/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/confirm`,
      input,
    );
  }

  dismissProposal(id: string, messageId: string): Promise<DismissProposalResponse> {
    return this.post(
      `/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/dismiss`,
    );
  }

  /** Tasks by id (at most 50), in the order asked; unknown ids are left out. */
  async tasksByIds(ids: readonly string[]): Promise<TaskRecord[]> {
    if (ids.length === 0) return [];
    const params = new URLSearchParams({ ids: ids.join(',') });
    return (await this.json<{ tasks: TaskRecord[] }>(`/tasks?${params}`)).tasks;
  }

  // ---- the Brain as a graph ----

  brainGraph(
    query: { project?: string; q?: string; limit?: number } = {},
  ): Promise<BrainGraphResponse> {
    const params = new URLSearchParams();
    if (query.project) params.set('project', query.project);
    if (query.q) params.set('q', query.q);
    if (query.limit) params.set('limit', String(query.limit));
    const suffix = params.size > 0 ? `?${params}` : '';
    return this.json(`/brain/graph${suffix}`);
  }

  brainEntry(id: string): Promise<BrainEntryDetail> {
    return this.json(`/brain/entries/${encodeURIComponent(id)}`);
  }

  /**
   * Follows a task's event stream until it ends, reconnecting from the last seen event when the
   * connection drops. `onEvent` is called once per event, in order.
   */
  async follow(
    id: string,
    onEvent: (event: EventRecord) => void,
    options: { after?: number; signal?: AbortSignal } = {},
  ): Promise<{ status: string }> {
    let cursor = options.after ?? 0;
    let failures = 0;
    for (;;) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        const response = await this.send(
          `/tasks/${encodeURIComponent(id)}/stream?after=${cursor}`,
          {
            headers: { accept: 'text/event-stream' },
            ...(options.signal ? { signal: options.signal } : {}),
          },
        );
        failures = 0;
        const reader = response.body?.getReader();
        if (!reader) throw new Error('no body');
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const name = /^event: (.+)$/m.exec(frame)?.[1];
            const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (!name || !data) continue;
            if (name === 'end') return JSON.parse(data) as { status: string };
            if (name === 'ev') {
              const event = JSON.parse(data) as EventRecord;
              cursor = Math.max(cursor, event.seq);
              onEvent(event);
            }
          }
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        if (error instanceof CloudApiError && error.status !== 0) throw error;
        if (++failures > 8) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * failures, 5000)));
      }
    }
  }
}
