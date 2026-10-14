import { z } from 'zod';
import { PERMISSION_PROFILES, type PermissionProfile, type TaskRecord } from './tasks.js';

/**
 * Conversations: the chat in Patch HQ. A conversation belongs to the owner and optionally to a
 * project. Messages are stored by the API. The assistant's answers are written by a Claude model
 * (the chat model in Settings) that reads real Patch Cloud state through read-only tools; with the
 * chat model off, unreachable or over the spend limit, the API answers from its own records with
 * deterministic queries instead. Either way a request for work becomes a *proposal* the owner must
 * confirm before any task is created: the model cannot start, cancel or change anything.
 *
 * Blocks never copy volatile state: a `run` block holds the task id and the client renders the
 * live record, so a refresh, another device or the CLI always agree.
 */

export type MessageRole = 'user' | 'assistant';

export type MessageBlock =
  | { type: 'text'; text: string }
  /** A live task, rendered from `GET /tasks/:id`. */
  | { type: 'run'; taskId: string }
  /** Counts and spend read at the moment of the answer (a snapshot, labelled as such in the UI). */
  | {
      type: 'status';
      at: string;
      workerOnline: boolean;
      sandbox: string | null;
      queued: number;
      running: number;
      spentTodayUsd: number;
      spentMonthUsd: number;
      budgetBlocked: boolean;
    }
  /** The assistant offers to start a task. Nothing runs until it is confirmed. */
  | {
      type: 'proposal';
      projectId: string;
      projectName: string;
      snapshotId: string;
      prompt: string;
      profile: PermissionProfile;
      state: 'pending' | 'confirmed' | 'dismissed' | 'failed';
      /** Set when confirmed: the task the API actually accepted. */
      taskId?: string;
      /** Set when state is "failed": why the API refused. */
      error?: string;
    }
  /** The assistant needs a project; the client shows the project picker. */
  | { type: 'choose_project'; reason: string }
  /** What the chat can do, shown for requests it does not understand. */
  | { type: 'help'; examples: string[] }
  /** Said honestly when a request is outside what Patch Cloud does today. */
  | { type: 'unsupported'; what: string }
  /**
   * A place in Patch HQ the assistant points to. `navigate` is set when the owner asked to go
   * there: a client that receives the finished message live may open it right away (never when
   * the message is loaded later from history).
   */
  | {
      type: 'open';
      view: HqView;
      /** Path inside Patch HQ, relative to /hq: "/runs?status=active", "/runs/tsk_…", "/brain?node=…". */
      path: string;
      label: string;
      navigate?: boolean;
    };

/** Views of Patch HQ an `open` block can point to. */
export const HQ_VIEWS = ['runs', 'run', 'projects', 'project', 'brain', 'settings'] as const;
export type HqView = (typeof HQ_VIEWS)[number];

/** What an assistant message is doing: absent once it is complete. */
export type MessageStatus = 'pending' | 'failed';

/** Which model wrote an assistant message, and what it cost (all model requests of the reply). */
export interface MessageAi {
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ConversationRecord {
  id: string;
  title: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  messageCount: number;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: MessageRole;
  blocks: MessageBlock[];
  createdAt: string;
  /**
   * `pending` while the chat model is still writing (blocks grow as it goes; poll
   * `GET /conversations/:id/messages/:mid`), `failed` when it stopped with an error (the blocks
   * say why). Absent on a complete message.
   */
  status?: MessageStatus;
  /** While pending: what the assistant is doing now ("Reading run tsk_…"). */
  activity?: string;
  /** Set on a message a model wrote. */
  ai?: MessageAi;
}

export interface ConversationDetail {
  conversation: ConversationRecord;
  /** The newest 200 (oldest first); older ones with `GET /conversations/:id?before=<message id>`. */
  messages: MessageRecord[];
  /** True when older messages exist than the ones returned. */
  hasMore?: boolean;
}

export const CreateConversationSchema = z.object({
  projectId: z.string().min(1).nullable().optional(),
  title: z.string().min(1).max(120).optional(),
});
export type CreateConversationRequest = z.input<typeof CreateConversationSchema>;

export const SendMessageSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  /** Overrides the conversation's project for this message (and becomes its project). */
  projectId: z.string().min(1).nullable().optional(),
});
export type SendMessageRequest = z.input<typeof SendMessageSchema>;

export interface SendMessageResponse {
  user: MessageRecord;
  assistant: MessageRecord;
  conversation: ConversationRecord;
}

export const ConfirmProposalSchema = z.object({
  /** The owner may edit the prompt or the permission profile before starting. */
  prompt: z.string().trim().min(1).max(100_000).optional(),
  profile: z.enum(PERMISSION_PROFILES).optional(),
});
export type ConfirmProposalRequest = z.input<typeof ConfirmProposalSchema>;

/** Sentence-length suggestions for the empty chat; each one maps to something the API answers. */
export const CHAT_SUGGESTIONS = [
  "What's happening with my projects?",
  'Show my latest runs.',
  'What failed recently?',
  'How much have I spent today?',
] as const;

/** The default chat model: fast and inexpensive, and good at reading records and explaining. */
export const DEFAULT_CHAT_MODEL = 'claude-sonnet-5-5';

/** Chat models offered in Settings (any other model id is accepted too). */
export const CHAT_MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'default, fast and inexpensive' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'cheapest' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'most thorough, costs more' },
] as const;

// ---------------------------------------------------------------------------------------------
// Response shapes of the chat endpoints (added with Patch Cloud 0.3.0; additive to the above).
// ---------------------------------------------------------------------------------------------

/** `GET /conversations?project=&limit=&before=` — newest activity first, archived ones left out. */
export interface ListConversationsResponse {
  conversations: ConversationRecord[];
}

/**
 * `POST /conversations/:id/messages/:mid/confirm`. `proposal` is the updated proposal message
 * (state "confirmed", `taskId` set); `assistant` is the appended "Started ..." message.
 */
export interface ConfirmProposalResponse {
  proposal: MessageRecord;
  assistant: MessageRecord;
  task: TaskRecord;
  conversation: ConversationRecord;
  /** True when the proposal had already been confirmed: this is the first result, replayed. */
  alreadyConfirmed?: boolean;
}

/** `POST /conversations/:id/archive`. */
export interface ArchiveConversationResponse {
  conversation: ConversationRecord;
}

/** `POST /conversations/:id/messages/:mid/dismiss`. */
export interface DismissProposalResponse {
  proposal: MessageRecord;
  conversation: ConversationRecord;
}

/**
 * When confirm is refused (budget limit reached, project or snapshot gone) the HTTP error body is
 * the usual `{ error: { code, message } }` plus `proposal`: the message after it was marked
 * `failed`, so a client can show the reason without another request.
 */
export interface ConfirmRefusedBody {
  error: { code: string; message: string };
  proposal?: MessageRecord;
}

/** Title of a conversation until its first message names it. */
export const DEFAULT_CONVERSATION_TITLE = 'New chat';
