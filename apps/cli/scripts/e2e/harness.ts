/**
 * Shared setup for the end-to-end scripts (run.ts, screenshots.ts): throwaway copies of the demo
 * repository and helpers for scripting mock Anthropic responses.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MockBlock, MockMessageResponse } from '@patch/provider-anthropic/testing';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'demo-repo');

export function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Demo',
      GIT_AUTHOR_EMAIL: 'demo@example.com',
      GIT_COMMITTER_NAME: 'Demo',
      GIT_COMMITTER_EMAIL: 'demo@example.com',
    },
  });
}

export interface Workspace {
  /** Temporary directory holding everything below. */
  root: string;
  repo: string;
  home: string;
  cleanup: () => void;
}

export interface WorkspaceOptions {
  /** Initialize a Git repository with one commit (default true). */
  git?: boolean;
  /** Where the copy of the demo repository goes, relative to `root` (default "demo-app"). */
  repoPath?: string;
}

export function makeWorkspace(options: WorkspaceOptions = {}): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'patch-e2e-'));
  const repo = join(root, options.repoPath ?? 'demo-app');
  const home = join(root, 'patch-home');
  mkdirSync(dirname(repo), { recursive: true });
  cpSync(FIXTURE, repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (options.git !== false) {
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'core.autocrlf', 'false');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'Initial commit');
  }
  return {
    root,
    repo,
    home,
    // Windows can hold the directory for a moment after the session exits.
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10 }),
  };
}

export const text = (markdown: string): MockBlock => ({ type: 'text', text: markdown });
export const note = (thinking: string): MockBlock => ({ type: 'thinking', thinking });
export const tool = (name: string, input: Record<string, unknown>): MockBlock => ({
  type: 'tool_use',
  name,
  input,
});

/** A web search call, and its results unless `results` is omitted (a call still running). */
export function webSearch(
  query: string,
  results?: Array<{ url: string; title: string }>,
): MockBlock[] {
  const call: MockBlock = { type: 'server_tool_use', name: 'web_search', input: { query } };
  return results ? [call, { type: 'web_search_tool_result', results }] : [call];
}

/** A web fetch call and its result: the page text, or an error code. */
export function webFetch(url: string, page: { text: string } | { error: string }): MockBlock[] {
  return [
    { type: 'server_tool_use', name: 'web_fetch', input: { url } },
    'text' in page
      ? { type: 'web_fetch_tool_result', url, text: page.text }
      : { type: 'web_fetch_tool_result', error_code: page.error },
  ];
}

export function reply(...content: MockBlock[]): MockMessageResponse {
  const usesTools = content.some((b) => b.type === 'tool_use');
  return {
    content,
    stop_reason: usesTools ? 'tool_use' : 'end_turn',
    usage: { input_tokens: 2400, output_tokens: 180, cache_read_input_tokens: 9000 },
    delayMs: 8,
    chunkSize: 12,
  };
}
