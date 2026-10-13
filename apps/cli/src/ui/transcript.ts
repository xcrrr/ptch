import type { FileDiff, ToolCallSummary, ToolDisplay } from '@patch/core';

export interface WelcomeInfo {
  version: string;
  /** Display location, e.g. "~/code/project". */
  location: string;
  /** Branch name, "detached @abc123", or null outside Git. */
  branch: string | null;
  isGit: boolean;
  /** Changed files at startup (null when unknown or not Git). */
  changedFiles: number | null;
  model: string;
  /** e.g. "ready", "no API key" */
  status: string;
  statusLevel: 'ok' | 'warn' | 'error';
  /** e.g. ["PATCH.md"] */
  instructionFiles: string[];
  /** Extra one-line notes (e.g. "Running in your home directory."). */
  notes: string[];
}

export interface StatusRow {
  label: string;
  value: string;
  /** Optional dim suffix. */
  detail?: string;
}

export interface HelpSection {
  title: string;
  rows: Array<{ key: string; description: string }>;
}

/**
 * Everything that can appear in the scrollback. Items are immutable once committed (they are
 * rendered with Ink's <Static> exactly once).
 */
export type TranscriptItem =
  | { kind: 'welcome'; id: string; info: WelcomeInfo }
  /** What the user typed; `source` names the file of a custom command (shown dim below). */
  | {
      kind: 'user';
      id: string;
      text: string;
      source?: string;
      /** The images sent with it, e.g. "[Image #1] screenshot.png · 1280×720 · 84 KB" (dim). */
      images?: string[];
    }
  /** A committed chunk of assistant Markdown (one or more complete blocks). */
  | {
      kind: 'assistant';
      id: string;
      markdown: string;
      /** First chunk of a response (gets a top gap). */ first: boolean;
    }
  /** Model-authored progress note. */
  | { kind: 'progress'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      summary: ToolCallSummary;
      status: 'done' | 'error' | 'denied' | 'interrupted';
      display?: ToolDisplay;
      durationMs?: number;
      /** First tool row after non-tool content (gets a top gap). */
      first: boolean;
    }
  | { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string; hint?: string }
  | {
      kind: 'shell';
      id: string;
      command: string;
      exitCode: number | null;
      output: string;
      durationMs: number;
    }
  | { kind: 'status'; id: string; title?: string; rows: StatusRow[] }
  | { kind: 'help'; id: string; sections: HelpSection[] }
  /** Raw `git diff` text rendered with colors. */
  | { kind: 'git-diff'; id: string; title: string; diff: string; untracked: string[] }
  /** Expanded detail of a past tool call, or of a request awaiting approval (ctrl+o). */
  | { kind: 'detail'; id: string; title: string; text: string; diff?: FileDiff }
  | { kind: 'divider'; id: string; label: string }
  | { kind: 'compaction'; id: string; summary: string; auto: boolean; messagesCompacted: number };

export type TranscriptKind = TranscriptItem['kind'];
