import { z } from 'zod';

export const TASK_STATUSES = [
  'queued',
  'starting',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses a task never leaves. `interrupted` is final too: retrying creates a new task. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
];
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['starting', 'running'];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * What the agent may do without asking, chosen per task and always shown back to the user:
 * - `plan`: read and research only; the answer is a plan.
 * - `edits`: may change files in the workspace; no shell commands.
 * - `auto`: edits and commands inside the sandbox; Patch's auto-mode guardrails still deny
 *   destructive commands and secret files (nobody is there to approve them).
 */
export const PERMISSION_PROFILES = ['plan', 'edits', 'auto'] as const;
export type PermissionProfile = (typeof PERMISSION_PROFILES)[number];

export const TASK_ORIGINS = ['cli', 'hq', 'director'] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

export const TaskLimitsSchema = z.object({
  maxCostUsd: z.number().positive().max(1000),
  maxDurationSec: z.number().int().min(30).max(86_400),
  maxSteps: z.number().int().min(1).max(1000),
});
export type TaskLimits = z.infer<typeof TaskLimitsSchema>;

export const DEFAULT_TASK_LIMITS: TaskLimits = {
  maxCostUsd: 5,
  maxDurationSec: 3_600,
  maxSteps: 200,
};

export const CreateTaskSchema = z.object({
  projectId: z.string().min(1),
  /** Snapshot of the workspace to run on (uploaded first). */
  snapshotId: z.string().min(1),
  prompt: z.string().min(1).max(100_000),
  title: z.string().min(1).max(200).optional(),
  profile: z.enum(PERMISSION_PROFILES).default('auto'),
  model: z.string().min(1).max(100).optional(),
  priority: z.number().int().min(-10).max(10).default(0),
  limits: TaskLimitsSchema.partial().optional(),
  origin: z.enum(TASK_ORIGINS).default('cli'),
  parentTaskId: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateTaskRequest = z.input<typeof CreateTaskSchema>;

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TaskRecord {
  id: string;
  projectId: string;
  snapshotId: string | null;
  title: string;
  prompt: string;
  status: TaskStatus;
  profile: PermissionProfile;
  model: string | null;
  priority: number;
  origin: TaskOrigin;
  parentTaskId: string | null;
  /** Set on a task created by retrying another one. */
  retryOf: string | null;
  limits: TaskLimits;
  costUsd: number;
  tokens: TokenCounts;
  steps: number;
  toolCalls: number;
  cancelRequested: boolean;
  /** Short result: the final answer, cut to a few lines. The full answer is an artifact. */
  resultSummary: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  workerId: string | null;
  metadata: Record<string, unknown>;
}

export interface ProjectRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  gitRemote: string | null;
  createdAt: string;
  taskCount: number;
  lastTaskAt: string | null;
}

export const CreateProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2_000).default(''),
  gitRemote: z.string().max(500).nullable().optional(),
});
export type CreateProjectRequest = z.input<typeof CreateProjectSchema>;

export interface SnapshotRecord {
  id: string;
  projectId: string;
  createdAt: string;
  sizeBytes: number;
  fileCount: number;
  sha256: string;
  baseCommit: string | null;
  branch: string | null;
  /** Files that differ from the base commit at upload time (uncommitted changes). */
  dirtyFiles: string[];
}

/** The manifest the CLI sends with a snapshot upload (JSON in the `X-Snapshot-Manifest` header). */
export const SnapshotManifestSchema = z.object({
  fileCount: z.number().int().min(0).max(100_000),
  baseCommit: z.string().max(80).nullable().default(null),
  branch: z.string().max(250).nullable().default(null),
  dirtyFiles: z.array(z.string().max(1_000)).max(10_000).default([]),
});
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;

export type ArtifactKind = 'patch' | 'answer' | 'log' | 'file';

export interface ArtifactRecord {
  id: string;
  taskId: string;
  kind: ArtifactKind;
  name: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface ListTasksQuery {
  status?: TaskStatus[];
  projectId?: string;
  limit?: number;
  before?: string;
}
