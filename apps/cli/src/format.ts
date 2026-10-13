import { homedir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import type { ToolCallSummary, ToolDisplay } from '@patch/core';

/** Replaces the home directory prefix with "~" and uses forward slashes after it. */
export function tildify(path: string, home: string = homedir()): string {
  const rel = relative(home, path);
  if (rel === '') return '~';
  if (!rel.startsWith('..') && !isAbsolute(rel)) return `~/${rel.split(sep).join('/')}`;
  return path;
}

/** "+18 -6" for diffs; undefined otherwise. */
export function diffStat(display: ToolDisplay | undefined): string | undefined {
  const diff = display?.diff;
  if (!diff) return undefined;
  return `+${diff.added} -${diff.removed}`;
}

/** Plain one-line description of a finished tool call (used in print mode and logs). */
export function toolLine(
  summary: ToolCallSummary,
  display: ToolDisplay | undefined,
  verbWidth = 8,
): string {
  const parts = [summary.verb.padEnd(verbWidth) + summary.target];
  if (summary.detail) parts.push(` ${summary.detail}`);
  const stat = diffStat(display);
  if (stat) parts.push(`  ${stat}`);
  if (display?.summary && !stat) parts.push(` · ${display.summary}`);
  return parts.join('');
}

/** Verb-specific activity label for the status line ("Reading src/a.ts"). */
export function activityLabel(summary: ToolCallSummary): string {
  const target = summary.target.length > 60 ? `${summary.target.slice(0, 59)}…` : summary.target;
  switch (summary.verb) {
    case 'read':
      return `Reading ${target}`;
    case 'edit':
      return `Editing ${target}`;
    case 'write':
    case 'create':
      return `Writing ${target}`;
    case 'grep':
      return `Searching for ${target}`;
    case 'glob':
      return `Finding files ${target}`;
    case 'ls':
      return `Listing ${target}`;
    case 'bash':
      return summary.detail ? `${summary.detail.replace(/\.$/, '')}` : `Running ${target}`;
    case 'git':
      return `Checking git ${target}`;
    case 'search':
      return `Searching the web for ${target}`;
    case 'fetch':
      return `Fetching ${target}`;
    case 'mcp':
      return `Calling ${target}`;
    default:
      return `Running ${summary.verb}`;
  }
}

/** Activity label while a tool call's input is still streaming. */
export function preparingLabel(toolName: string, inputBytes: number): string {
  const size = inputBytes >= 1024 ? `${(inputBytes / 1024).toFixed(1)} KB` : `${inputBytes} bytes`;
  switch (toolName) {
    case 'write_file':
      return `Writing file · ${size}`;
    case 'edit_file':
      return `Preparing edit · ${size}`;
    case 'bash':
      return 'Preparing command';
    default:
      return 'Preparing tool call';
  }
}
