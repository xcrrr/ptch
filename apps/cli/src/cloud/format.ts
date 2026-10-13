import type { EventRecord, TaskRecord, TaskStatus } from '@patch/cloud-protocol';
import { toDisplayText } from '../ui/text-layout.js';

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(finite(ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A number from the server, or 0 when it is not one (never throws on odd data). */
function finite(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function money(value: number): string {
  const usd = finite(value);
  return usd === 0 ? '$0' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function ago(iso: string, now = Date.now()): string {
  const diff = now - Date.parse(iso);
  if (Number.isNaN(diff)) return 'at an unknown time';
  if (diff < 45_000) return 'just now';
  return `${duration(diff)} ago`;
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'queued',
  starting: 'starting',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
};

export function taskRuntime(task: TaskRecord, now = Date.now()): string | null {
  if (!task.startedAt) return null;
  const end = task.finishedAt ? Date.parse(task.finishedAt) : now;
  return duration(end - Date.parse(task.startedAt));
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * One line (or a few) of readable log for an event, or null for events not worth showing in a
 * terminal. The text comes from the server's stored records, which are already redacted.
 */
export function renderEvent(
  event: EventRecord,
  options: { verbose?: boolean } = {},
): string | null {
  const line = renderEventRaw(event, options);
  // The text comes from the server (and from the agent's output): no escape sequence passes.
  return line === null ? null : toDisplayText(line);
}

function renderEventRaw(event: EventRecord, options: { verbose?: boolean }): string | null {
  const d = event.data;
  switch (event.type) {
    case 'task.created':
      return '· task created';
    case 'task.status':
      return `· ${str(d.from)} → ${str(d.to)}${d.workerId ? ` (${str(d.workerId)})` : ''}`;
    case 'task.started':
      return '· started';
    case 'task.cancel_requested':
      return '· cancel requested';
    case 'task.limit':
      return `! limit reached: ${str(d.limit)}`;
    case 'task.finished':
    case 'task.cancelled':
    case 'task.interrupted':
      return `· ${str(d.to)}${d.error ? ` — ${str(d.error)}` : ''}`;
    case 'task.changes': {
      const files = Array.isArray(d.files) ? (d.files as Array<Record<string, unknown>>) : [];
      const head = `· ${files.length} file(s) changed`;
      const skipped = Array.isArray(d.skipped) ? d.skipped.length : 0;
      return skipped > 0 ? `${head}, ${skipped} not transferred` : head;
    }
    case 'task.output':
      return d.stream === 'worker' ? `· ${str(d.text)}` : `  ${str(d.text)}`;
    case 'agent.init':
      return `· agent ready (${str(d.model)}, mode ${str(d.permission_mode)})`;
    case 'agent.text':
      return str(d.text);
    case 'agent.tool_start':
      return options.verbose ? `  ▸ ${str(d.verb)} ${str(d.target)}` : null;
    case 'agent.tool_end': {
      const mark = d.is_error ? '✗' : '✓';
      const diff = d.diff as { added?: number; removed?: number } | undefined;
      const stat = diff ? `  +${diff.added ?? 0} -${diff.removed ?? 0}` : '';
      const note = d.summary ? ` · ${str(d.summary)}` : '';
      return `  ${mark} ${str(d.verb).padEnd(7)} ${str(d.target)}${stat}${note}`;
    }
    case 'agent.hosted_tool':
      return `  ${d.is_error ? '✗' : '✓'} ${str(d.verb).padEnd(7)} ${str(d.target)}`;
    case 'agent.permission_denied':
      return `! ${str(d.message)}`;
    case 'agent.notice':
      return `${d.level === 'error' ? '✗' : '·'} ${str(d.text)}`;
    case 'agent.compaction':
      return '· context compacted';
    case 'agent.usage':
      return options.verbose
        ? `  · tokens in ${d.input_tokens} out ${d.output_tokens}${typeof d.cost_usd === 'number' ? ` · ${money(d.cost_usd)}` : ''}`
        : null;
    case 'agent.result':
      return null;
    default:
      return options.verbose ? `· ${event.type}` : null;
  }
}
