import {
  isTerminal,
  type BrainKind,
  type MessageBlock,
  type MessageRecord,
  type PermissionProfile,
  type ProjectRecord,
  type TaskRecord,
} from '@patch/cloud-protocol';

/**
 * The model behind the cloud view: what is on the screen, in order, and which parts of it are
 * finished. Pure data and functions, so it is tested without a terminal.
 */

/** One thing in the log of the view. Messages come from Patch Cloud, the rest is local. */
export type Entry =
  | {
      kind: 'header';
      id: string;
      account: string | null;
      host: string;
      worker: 'online' | 'offline' | 'unknown';
      project: string | null;
    }
  | { kind: 'message'; id: string; message: MessageRecord }
  /** A user message that was typed but not yet answered by the server. */
  | { kind: 'pending-user'; id: string; text: string }
  | { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string }
  /** Plain lines (whoami, help, the upload preview), shown dim under an optional title. */
  | { kind: 'doc'; id: string; title?: string; lines: string[] }
  /** A Brain entry opened for reading. */
  | {
      kind: 'brain-entry';
      id: string;
      title: string;
      entryKind: BrainKind;
      meta: string[];
      body: string;
      links: string[];
    }
  /** One line of a run's log while following it. */
  | { kind: 'log'; id: string; text: string }
  /** How a followed run ended. */
  | { kind: 'run-end'; id: string; task: TaskRecord; project: string | null };

export type ViewItem =
  | { kind: 'header'; id: string; entry: Extract<Entry, { kind: 'header' }> }
  | { kind: 'user'; id: string; text: string }
  | { kind: 'text'; id: string; markdown: string }
  | { kind: 'status'; id: string; block: Extract<MessageBlock, { type: 'status' }> }
  | { kind: 'run'; id: string; taskId: string }
  | {
      kind: 'proposal';
      id: string;
      messageId: string;
      block: Extract<MessageBlock, { type: 'proposal' }>;
      /** The one proposal that takes the keyboard. */
      active: boolean;
    }
  | { kind: 'choose'; id: string; block: Extract<MessageBlock, { type: 'choose_project' }> }
  | { kind: 'help'; id: string; block: Extract<MessageBlock, { type: 'help' }> }
  | { kind: 'unsupported'; id: string; block: Extract<MessageBlock, { type: 'unsupported' }> }
  | {
      kind: 'entry';
      id: string;
      entry: Exclude<Entry, { kind: 'message' | 'header' | 'pending-user' }>;
    }
  /** A message of Patch Cloud that has no block the CLI knows (a newer server). */
  | { kind: 'unknown'; id: string };

export interface BuiltItem {
  item: ViewItem;
  /** Finished: it will not change any more, so it can be written to the scrollback for good. */
  settled: boolean;
}

/** What is known about a run beyond its task record. */
export interface RunFacts {
  /** Files changed, only when the worker recorded it. */
  filesChanged?: number;
}

export interface BuildContext {
  tasks: Readonly<Record<string, TaskRecord>>;
  /** Task ids whose record does not exist (404). */
  missing: ReadonlySet<string>;
  facts: Readonly<Record<string, RunFacts | 'pending'>>;
  /** The id of the newest proposal message that is still pending (the one that is answered). */
  activeProposal: string | null;
  /** The choose-project message that is still unanswered, if any. */
  activeChoose: string | null;
  /** The time, for how long a finished run has waited for its result message. */
  now?: number;
}

/** How long a finished run's card waits for the result message the server appends. */
const RESULT_GRACE_MS = 30_000;

/**
 * A run that was started from a proposal can appear twice: in the "Started" message and again in
 * the result the server appends when it ends. There is exactly one card, in the newest message
 * that carries it; answers that merely list runs keep theirs. Returns the card of each started
 * run (the newest) and, per message id, the block indexes whose card is hidden.
 */
export function startedRunCards(entries: readonly Entry[]): {
  hidden: Map<string, Set<number>>;
  /** Started runs that have only one card so far (no result message yet). */
  single: Set<string>;
} {
  const started = new Set<string>();
  const messages = entries.flatMap((e) => (e.kind === 'message' ? [e.message] : []));
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'proposal' && block.state === 'confirmed' && block.taskId) {
        started.add(block.taskId);
      }
    }
  }
  const seen = new Map<string, Array<{ id: string; index: number }>>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    message.blocks.forEach((block, index) => {
      if (block.type !== 'run' || !started.has(block.taskId)) return;
      seen.set(block.taskId, [...(seen.get(block.taskId) ?? []), { id: message.id, index }]);
    });
  }
  const hidden = new Map<string, Set<number>>();
  const single = new Set<string>();
  for (const [taskId, refs] of seen) {
    if (refs.length === 1) single.add(taskId);
    for (const ref of refs.slice(0, -1)) {
      const set = hidden.get(ref.id) ?? new Set<number>();
      set.add(ref.index);
      hidden.set(ref.id, set);
    }
  }
  return { hidden, single };
}

/** Items that can still change are limited to this many; older ones are written as they are. */
export const MAX_LIVE_ITEMS = 4;
/**
 * Everything after the first item that can still change is drawn live too, so that is limited:
 * past this many items the first one is written as it is and the rest can be written after it.
 */
export const MAX_LIVE_TAIL = 5;

/**
 * A message as this version can use it: only blocks that are objects with a type (a newer or a
 * misbehaving server may send others; they are left out rather than failing the whole view).
 */
export function usable(message: MessageRecord): MessageRecord {
  const blocks: unknown = message.blocks;
  const kept = Array.isArray(blocks)
    ? blocks.filter(
        (b): b is MessageBlock =>
          b !== null && typeof b === 'object' && typeof (b as { type?: unknown }).type === 'string',
      )
    : [];
  return { ...message, blocks: kept };
}

export function messageText(message: MessageRecord): string {
  return message.blocks
    .filter((b): b is Extract<MessageBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
}

/**
 * The server's report of a run starts with the facts a run card already shows (title, status,
 * duration, cost, files, the reason); what follows is the agent's own words. Returns the part
 * that adds something.
 */
export function trimRunProse(text: string): string {
  const kept = text.split(/\n{2,}/).filter((paragraph) => {
    const first = paragraph.trimStart();
    return !(
      /^(Started|Finished|Failed|Interrupted|Cancelled): /.test(first) ||
      /^Reason: /.test(first) ||
      first.includes('Interrupted tasks are never run again')
    );
  });
  return kept.join('\n\n');
}

/** The newest proposal that is still pending, if any. */
export function latestPendingProposal(
  entries: readonly Entry[],
): { messageId: string; block: Extract<MessageBlock, { type: 'proposal' }> } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.kind !== 'message') continue;
    for (let j = entry.message.blocks.length - 1; j >= 0; j--) {
      const block = entry.message.blocks[j];
      if (block?.type === 'proposal' && block.state === 'pending') {
        return { messageId: entry.message.id, block };
      }
    }
  }
  return null;
}

/**
 * The unanswered "which project?" question: the last message is the assistant's and has a
 * choose_project block. Returns the message and the user text that led to it.
 */
export function activeChooseProject(
  entries: readonly Entry[],
): { messageId: string; reason: string; text: string } | null {
  const last = [...entries]
    .reverse()
    .find((e) => e.kind === 'message' || e.kind === 'pending-user');
  if (last?.kind !== 'message' || last.message.role !== 'assistant') return null;
  const block = last.message.blocks.find((b) => b.type === 'choose_project');
  if (!block || block.type !== 'choose_project') return null;
  const index = entries.indexOf(last);
  for (let i = index - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.kind === 'message' && entry.message.role === 'user') {
      return { messageId: last.message.id, reason: block.reason, text: messageText(entry.message) };
    }
  }
  return null;
}

/** Task ids of every run block in the log. */
export function runTaskIds(entries: readonly Entry[]): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'message') continue;
    for (const block of entry.message.blocks) {
      if (block.type === 'run' && !ids.includes(block.taskId)) ids.push(block.taskId);
    }
  }
  return ids;
}

/** Run ids that are not final yet (or not loaded): the ones to poll. */
export function activeRunIds(
  entries: readonly Entry[],
  tasks: Readonly<Record<string, TaskRecord>>,
  missing: ReadonlySet<string>,
): string[] {
  return runTaskIds(entries).filter((id) => {
    if (missing.has(id)) return false;
    const task = tasks[id];
    return !task || !isTerminal(task.status);
  });
}

/** Expands the log into the things to draw, each marked finished or not. */
export function buildItems(entries: readonly Entry[], context: BuildContext): BuiltItem[] {
  const built: BuiltItem[] = [];
  const cards = startedRunCards(entries);
  for (const entry of entries) {
    switch (entry.kind) {
      case 'header':
        built.push({ item: { kind: 'header', id: entry.id, entry }, settled: true });
        break;
      case 'pending-user':
        built.push({ item: { kind: 'user', id: entry.id, text: entry.text }, settled: false });
        break;
      case 'message':
        built.push(...messageItems(entry.message, context, cards));
        break;
      default:
        built.push({ item: { kind: 'entry', id: entry.id, entry }, settled: true });
    }
  }
  // Only the newest few unfinished things stay live; a frozen older one is written as it is.
  let live = 0;
  for (let i = built.length - 1; i >= 0; i--) {
    const b = built[i] as BuiltItem;
    if (b.settled) continue;
    live += 1;
    if (live > MAX_LIVE_ITEMS && !isPinned(b.item)) b.settled = true;
  }
  // The live area must stay shorter than the screen: what comes after the first unfinished item
  // is drawn live as well, so a long tail freezes that item.
  for (;;) {
    const first = built.findIndex((b) => !b.settled);
    if (first < 0 || built.length - first <= MAX_LIVE_TAIL) break;
    const b = built[first] as BuiltItem;
    if (isPinned(b.item)) break;
    b.settled = true;
  }
  return built;
}

/** The proposal that takes the keyboard is never written before it is answered. */
function isPinned(item: ViewItem): boolean {
  return (item.kind === 'proposal' && item.active) || item.kind === 'choose';
}

function messageItems(
  message: MessageRecord,
  context: BuildContext,
  cards: ReturnType<typeof startedRunCards>,
): BuiltItem[] {
  const out: BuiltItem[] = [];
  if (message.role === 'user') {
    const text = messageText(message);
    out.push({ item: { kind: 'user', id: message.id, text }, settled: true });
    return out;
  }
  const has = (type: MessageBlock['type']): boolean => message.blocks.some((b) => b.type === type);
  message.blocks.forEach((block, index) => {
    const id = `${message.id}:${index}`;
    switch (block.type) {
      case 'text': {
        // The cards say what the prose says: a status card, a proposal card, a run card. The words
        // are left out when a card follows, except what adds something (the agent's answer).
        if (has('status') || has('proposal')) break;
        const markdown = has('run') ? trimRunProse(block.text) : block.text;
        if (markdown.trim() === '') break;
        out.push({ item: { kind: 'text', id, markdown }, settled: true });
        break;
      }
      case 'status':
        out.push({ item: { kind: 'status', id, block }, settled: true });
        break;
      case 'run': {
        if (cards.hidden.get(message.id)?.has(index)) break;
        const task = context.tasks[block.taskId];
        const facts = context.facts[block.taskId];
        // A started run's only card waits for the result message, which brings the final card.
        const waitsForResult =
          cards.single.has(block.taskId) &&
          task?.finishedAt != null &&
          (context.now ?? Date.now()) - Date.parse(task.finishedAt) < RESULT_GRACE_MS;
        const settled =
          context.missing.has(block.taskId) ||
          (task !== undefined && isTerminal(task.status) && facts !== 'pending' && !waitsForResult);
        out.push({ item: { kind: 'run', id, taskId: block.taskId }, settled });
        break;
      }
      case 'proposal': {
        const active = context.activeProposal === message.id && block.state === 'pending';
        out.push({
          item: { kind: 'proposal', id, messageId: message.id, block, active },
          // A pending proposal that is not the active one is written as a dim "still pending".
          settled: block.state !== 'pending' || !active,
        });
        break;
      }
      case 'choose_project':
        out.push({
          item: { kind: 'choose', id, block },
          settled: context.activeChoose !== message.id,
        });
        break;
      case 'help':
        out.push({ item: { kind: 'help', id, block }, settled: true });
        break;
      case 'unsupported':
        out.push({ item: { kind: 'unsupported', id, block }, settled: true });
        break;
      default:
        out.push({ item: { kind: 'unknown', id }, settled: true });
    }
  });
  return out;
}

/**
 * How many leading items are finished. Items are written to the scrollback in order, so the
 * count only ever grows (`previous` is the count already written).
 */
export function committedCount(items: readonly BuiltItem[], previous: number): number {
  let n = 0;
  while (n < items.length && (items[n] as BuiltItem).settled) n += 1;
  return Math.max(previous, n);
}

// ------------------------------------------------------------------ run wording

export type RunTone = 'active' | 'ok' | 'error' | 'warn' | 'idle';

export interface RunSummary {
  tone: RunTone;
  /** The status word, exactly as recorded. */
  label: string;
  /** One honest line about how it ended (or is going). */
  outcome: string;
}

/**
 * A short, truthful description of a run. A failure, a cancellation and an interruption never
 * read as success, and "files changed" appears only when the worker recorded it.
 */
export function summarizeRun(task: TaskRecord, facts?: RunFacts): RunSummary {
  switch (task.status) {
    case 'queued':
      return { tone: 'idle', label: 'queued', outcome: 'Waiting for the worker.' };
    case 'starting':
      return { tone: 'active', label: 'starting', outcome: 'Starting the sandbox.' };
    case 'running':
      return {
        tone: 'active',
        label: 'running',
        outcome: task.cancelRequested
          ? 'Cancel requested: stopping.'
          : task.steps > 0
            ? `Working. Model step ${task.steps} so far.`
            : 'Working.',
      };
    case 'succeeded': {
      const changed =
        task.profile === 'plan'
          ? ' This was a plan-only run: nothing was changed.'
          : facts?.filesChanged === undefined
            ? ''
            : facts.filesChanged === 0
              ? ' No files were changed.'
              : ` ${facts.filesChanged} ${facts.filesChanged === 1 ? 'file' : 'files'} changed.`;
      return { tone: 'ok', label: 'succeeded', outcome: `Finished.${changed}` };
    }
    case 'failed':
      return {
        tone: 'error',
        label: 'failed',
        outcome: `Failed. ${task.error ?? 'The agent did not finish its work.'}`,
      };
    case 'cancelled':
      return {
        tone: 'idle',
        label: 'cancelled',
        outcome: 'Cancelled. The run stopped before it finished.',
      };
    default:
      // A status this version does not know (a newer server): said as it is, never as success.
      return {
        tone: 'idle',
        label: String(task.status),
        outcome: `Status: ${String(task.status)}.`,
      };
    case 'interrupted':
      return {
        tone: 'warn',
        label: 'interrupted',
        outcome: `Interrupted. The run did not finish and is not started again.${task.error ? ` ${task.error}` : ''}`,
      };
  }
}

export function projectName(
  projects: readonly ProjectRecord[],
  id: string | null | undefined,
): string | null {
  if (!id) return null;
  return projects.find((p) => p.id === id)?.name ?? null;
}

export const PROFILE_HELP: Record<PermissionProfile, string> = {
  auto: 'Edits files and runs commands inside the sandbox. Destructive commands and secret files stay blocked.',
  edits: 'Edits files only. No commands.',
  plan: 'Read-only research. The answer is a plan.',
};

export const PROFILE_LABEL: Record<PermissionProfile, string> = {
  auto: 'auto',
  edits: 'edits only',
  plan: 'plan only',
};

/** The next permission profile when cycling with `p`. */
export function nextProfile(profile: PermissionProfile): PermissionProfile {
  const order: PermissionProfile[] = ['auto', 'edits', 'plan'];
  return order[(order.indexOf(profile) + 1) % order.length] as PermissionProfile;
}
