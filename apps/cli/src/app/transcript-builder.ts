import {
  COMPACTION_SUMMARY_PREFIX,
  HOOK_OUTPUT_TAG,
  INTERRUPTED_MARKER,
  PLAN_MODE_TAG,
  USER_SHELL_CONTEXT_TAG,
  hostedToolSummary,
  type Session,
  type SessionEntry,
} from '@patch/core';
import type { ContentBlock, HostedToolActivity, TextBlock } from '@patch/shared';
import { describeStoredImage, imageLine } from '../images.js';
import type { TranscriptItem } from '../ui/transcript.js';
import { WORKING_DIRECTORY_TAG } from '../working-directory.js';

/** Max items rebuilt when resuming a long session (older ones are summarized by a divider). */
export const MAX_RESUMED_ITEMS = 160;

type ItemWithoutId = TranscriptItem extends infer T
  ? T extends { id: string }
    ? Omit<T, 'id'>
    : never
  : never;

type ToolItem = Extract<ItemWithoutId, { kind: 'tool' }>;

/**
 * Rebuilds a readable transcript from persisted session entries so a resumed session shows its
 * history. Uses UI records (tool entries) rather than raw tool results. Hosted tool calls are
 * rebuilt from the assistant messages that carry them, in place, with the outcome of their result
 * (which can come a message later); a call without a result shows as interrupted.
 */
export function buildTranscriptFromEntries(
  entries: readonly SessionEntry[],
  nextId: () => string,
): TranscriptItem[] {
  const items: ItemWithoutId[] = [];
  let lastKind: string | undefined;
  const hostedRows = new Map<string, ToolItem>();

  const push = (item: ItemWithoutId) => {
    items.push(item);
    lastKind = item.kind;
  };

  const pushHosted = (activity: HostedToolActivity) => {
    const row = hostedRows.get(activity.id);
    if (row) {
      if (activity.phase === 'result') {
        row.status = activity.isError ? 'error' : 'done';
        row.display = { summary: activity.summary };
      }
      return;
    }
    const item: ToolItem = {
      kind: 'tool',
      name: activity.kind,
      summary: hostedToolSummary(activity.kind, activity.phase === 'call' ? activity.detail : ''),
      status: 'interrupted',
      first: lastKind !== 'tool',
    };
    if (activity.phase === 'result') {
      item.status = activity.isError ? 'error' : 'done';
      item.display = { summary: activity.summary };
    }
    hostedRows.set(activity.id, item);
    push(item);
  };

  /**
   * Text blocks become assistant items. Cited passages come in blocks of their own, split from
   * the text around them, so adjacent blocks with citations are joined back into one item
   * (other adjacent blocks, such as the runs of an interrupted response, stay apart).
   */
  const pushAssistant = (content: readonly ContentBlock[]) => {
    let run: TextBlock[] = [];
    const flush = () => {
      const texts = run.some((block) => block.providerData)
        ? [run.map((block) => block.text).join('')]
        : run.map((block) => block.text);
      for (const text of texts) {
        if (text.trim()) push({ kind: 'assistant', markdown: text.trim(), first: true });
      }
      run = [];
    };
    for (const block of content) {
      if (block.type === 'text') {
        run.push(block);
        continue;
      }
      flush();
      if (block.type !== 'provider') continue;
      if (block.hostedTool) pushHosted(block.hostedTool);
      else if (block.displayText) push({ kind: 'progress', text: block.displayText });
    }
    flush();
  };

  for (const entry of entries) {
    switch (entry.type) {
      case 'message': {
        const { message } = entry;
        if (message.role === 'user') {
          // A prompt's images come right before its text.
          let images: string[] = [];
          for (const block of message.content) {
            if (block.type === 'image') {
              images.push(imageLine(images.length + 1, describeStoredImage(block)));
              continue;
            }
            if (block.type !== 'text') continue;
            const text = block.text;
            if (text.startsWith(USER_SHELL_CONTEXT_TAG)) continue;
            if (text.startsWith(COMPACTION_SUMMARY_PREFIX)) continue;
            if (text.startsWith(WORKING_DIRECTORY_TAG)) continue;
            // Hook output: context for the model; a Stop hook's request is a notice of its own.
            if (text.startsWith(HOOK_OUTPUT_TAG)) continue;
            if (text.startsWith(PLAN_MODE_TAG)) continue;
            if (text.trim() === INTERRUPTED_MARKER) {
              push({ kind: 'notice', level: 'info', text: 'Interrupted.' });
              continue;
            }
            push({ kind: 'user', text, ...(images.length > 0 ? { images } : {}) });
            images = [];
          }
          if (images.length > 0) push({ kind: 'user', text: '', images });
        } else {
          pushAssistant(message.content);
        }
        break;
      }
      case 'tool':
        push({
          kind: 'tool',
          name: entry.name,
          summary: entry.summary,
          status: entry.denied ? 'denied' : entry.isError ? 'error' : 'done',
          display: entry.display,
          durationMs: entry.durationMs,
          first: lastKind !== 'tool',
        });
        break;
      case 'notice':
        push({ kind: 'notice', level: entry.level, text: entry.text });
        break;
      case 'shell':
        push({
          kind: 'shell',
          command: entry.command,
          exitCode: entry.exitCode,
          output: entry.output,
          durationMs: entry.durationMs,
        });
        break;
      case 'compaction':
        push({
          kind: 'compaction',
          summary: entry.summary,
          auto: entry.auto,
          messagesCompacted: entry.messagesCompacted,
        });
        break;
      case 'model':
        push({ kind: 'notice', level: 'info', text: `Model set to ${entry.model}.` });
        break;
      default:
        break;
    }
  }

  let visible = items;
  const result: TranscriptItem[] = [];
  if (items.length > MAX_RESUMED_ITEMS) {
    const hidden = items.length - MAX_RESUMED_ITEMS;
    visible = items.slice(hidden);
    result.push({ kind: 'divider', id: nextId(), label: `${hidden} earlier entries not shown` });
    // A tool row at the cut must start its own group.
    const first = visible[0];
    if (first && first.kind === 'tool') visible[0] = { ...first, first: true };
  }
  for (const item of visible) result.push({ ...item, id: nextId() } as TranscriptItem);
  return result;
}

/** True when the session has anything worth replaying. */
export function hasTranscript(session: Session): boolean {
  return session.entries().some((e) => e.type === 'message');
}
