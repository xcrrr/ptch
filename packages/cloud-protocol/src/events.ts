/**
 * Records of the append-only event log. Task events mirror the records `ptch -p --output-format
 * stream-json` writes (prefixed `agent.`), plus events the worker and the API add themselves.
 */
export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface EventRecord {
  /** Global, strictly increasing; use it as the cursor for `after`. */
  seq: number;
  taskId: string | null;
  projectId: string | null;
  ts: string;
  type: string;
  level: EventLevel;
  data: Record<string, unknown>;
}

/** Event types the platform itself emits (agent records arrive as `agent.<type>`). */
export const SYSTEM_EVENT_TYPES = [
  'project.created',
  'task.created',
  'task.queued',
  'task.started',
  'task.status',
  'task.cancel_requested',
  'task.cancelled',
  'task.finished',
  'task.interrupted',
  'task.limit',
  'task.output',
  'worker.started',
  'worker.stopped',
  'worker.recovered',
  'budget.blocked',
  'snapshot.created',
  'brain.entry',
  'auth.login',
  'auth.login_failed',
  'auth.token_created',
  'settings.changed',
  'approval.requested',
  'approval.decided',
] as const;
export type SystemEventType = (typeof SYSTEM_EVENT_TYPES)[number];

/** What a streaming client receives: the event, or a periodic heartbeat comment. */
export interface EventPage {
  events: EventRecord[];
  /** Highest seq in `events`, or the cursor that was passed when there were none. */
  cursor: number;
}
