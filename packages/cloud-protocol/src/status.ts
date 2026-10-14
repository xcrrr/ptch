import { z } from 'zod';
import type { TaskStatus } from './tasks.js';

export interface WorkerStatus {
  id: string;
  /** Last heartbeat; a worker silent for a while is shown as offline. */
  lastSeen: string | null;
  online: boolean;
  startedAt: string | null;
  sandbox: string | null;
  version: string | null;
  currentTaskId: string | null;
}

export interface UsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
}

export interface UsageByModel extends UsageTotals {
  model: string;
}

export interface UsageDay extends UsageTotals {
  /** UTC date, YYYY-MM-DD. */
  day: string;
}

export interface BudgetStatus {
  dailyLimitUsd: number | null;
  monthlyLimitUsd: number | null;
  spentTodayUsd: number;
  spentMonthUsd: number;
  /** True when a limit is reached and queued tasks are held back. */
  blocked: boolean;
}

export interface CloudStatus {
  version: string;
  now: string;
  queue: Record<TaskStatus, number>;
  worker: WorkerStatus;
  budget: BudgetStatus;
  usage: { today: UsageTotals; month: UsageTotals };
  /**
   * Whether chat answers come from the chat model (added in 0.5.0). `reason` says why not when
   * `available` is false; `model` is null when the chat model is off in Settings.
   */
  chat?: { model: string | null; available: boolean; reason?: string };
}

/** Host readings taken on the machine the API runs on. Any value can be null when unavailable. */
export interface InfraStatus {
  hostname: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  uptimeSec: number;
  cpuCount: number;
  loadAvg: [number, number, number];
  memory: { totalBytes: number; freeBytes: number };
  disk: { path: string; totalBytes: number; freeBytes: number } | null;
  temperatureC: number | null;
  sandbox: { kind: string; available: boolean; detail: string };
  database: { path: string; sizeBytes: number; walSizeBytes: number };
  dataDir: { path: string; sizeBytes: number };
  listen: string;
}

export const SettingsSchema = z.object({
  dailyBudgetUsd: z.number().min(0).max(100_000).nullable(),
  monthlyBudgetUsd: z.number().min(0).max(1_000_000).nullable(),
  maxConcurrentTasks: z.number().int().min(1).max(4),
  defaultModel: z.string().min(1).max(100).nullable(),
  defaultMaxCostUsd: z.number().positive().max(1000),
  defaultMaxDurationSec: z.number().int().min(30).max(86_400),
  defaultMaxSteps: z.number().int().min(1).max(1000),
  /** Memory limit per task container, in MiB. */
  containerMemoryMb: z.number().int().min(256).max(12_288),
  containerCpus: z.number().min(0.5).max(4),
  /**
   * The model that writes chat answers (it reads Patch Cloud through read-only tools). null turns
   * the model off: the chat then answers from records with fixed queries.
   */
  chatModel: z.string().min(1).max(100).nullable(),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const SettingsPatchSchema = SettingsSchema.partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const DEFAULT_SETTINGS: Settings = {
  dailyBudgetUsd: null,
  monthlyBudgetUsd: null,
  maxConcurrentTasks: 1,
  defaultModel: null,
  defaultMaxCostUsd: 5,
  defaultMaxDurationSec: 3_600,
  defaultMaxSteps: 200,
  containerMemoryMb: 3_072,
  containerCpus: 3,
  chatModel: 'claude-sonnet-5-5',
};

export const LoginSchema = z.object({ password: z.string().min(1).max(1_000) });
