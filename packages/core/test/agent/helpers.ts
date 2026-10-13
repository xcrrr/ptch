import { resolve } from 'node:path';
import { expect } from 'vitest';
import { z } from 'zod';
import {
  addUsage,
  emptyUsage,
  type Message,
  type ModelInfo,
  type ModelRequest,
  type Usage,
} from '@patch/shared';
import { Agent, type AgentOptions } from '../../src/agent/agent.js';
import type { AgentEvent, TurnResult } from '../../src/agent/events.js';
import { FileStateTracker } from '../../src/fs/file-state.js';
import { PathPolicy, type ResolvedPath } from '../../src/fs/paths.js';
import { noopLogger } from '../../src/logging/logger.js';
import {
  PermissionManager,
  type PermissionDecision,
  type PermissionRequest,
  type PermissionResponse,
  type SessionGrant,
} from '../../src/permissions/manager.js';
import type { PlanReviewRequest, PlanReviewResponse } from '../../src/permissions/modes.js';
import { titleFromMessage } from '../../src/session/parse.js';
import {
  COMPACTION_SUMMARY_PREFIX,
  SESSION_FORMAT_VERSION,
  type AppendableEntry,
  type SessionEntry,
  type SessionMeta,
} from '../../src/session/schema.js';
import { Session } from '../../src/session/store.js';
import { ScriptedProvider, type ScriptStep } from '../../src/testing/index.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import {
  ToolError,
  defineTool,
  type PermissionClass,
  type PermissionSubject,
  type ToolContext,
  type ToolDefinition,
} from '../../src/tools/types.js';

export const TEST_CWD = resolve('/patch-test/project');
export const TEST_SYSTEM = 'You are Patch, under test.';
export const TEST_MODEL = 'test-model';

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

/**
 * In-memory Session following the documented contract (entries include meta; appends fill `ts`;
 * history honors the last compaction). Entries go through a JSON round trip, like the JSONL file.
 */
export class MemorySession extends Session {
  constructor(meta: Partial<Omit<SessionMeta, 'type' | 'v'>> = {}) {
    const full: SessionMeta = {
      type: 'meta',
      v: SESSION_FORMAT_VERSION,
      id: 'test-session',
      createdAt: '2026-10-07T00:00:00.000Z',
      cwd: TEST_CWD,
      projectRoot: TEST_CWD,
      isGit: false,
      branch: null,
      provider: 'scripted',
      model: TEST_MODEL,
      patchVersion: '0.0.0-test',
      system: TEST_SYSTEM,
      ...meta,
    };
    super('memory://test-session.jsonl', full, [full]);
  }

  override entries(): readonly SessionEntry[] {
    return this.entryList;
  }

  override append(entry: AppendableEntry): SessionEntry {
    const stored = JSON.parse(
      JSON.stringify({ ts: new Date().toISOString(), ...entry }),
    ) as SessionEntry;
    this.entryList.push(stored);
    return stored;
  }

  override history(): Message[] {
    let start = 1;
    let summary: string | undefined;
    this.entryList.forEach((entry, index) => {
      if (entry.type === 'compaction') {
        start = index + 1;
        summary = entry.summary;
      }
    });
    const messages = this.entryList
      .slice(start)
      .flatMap((entry) => (entry.type === 'message' ? [structuredClone(entry.message)] : []));
    if (summary === undefined) return messages;
    return [
      {
        role: 'user',
        content: [{ type: 'text', text: `${COMPACTION_SUMMARY_PREFIX}\n\n${summary}` }],
      },
      ...messages,
    ];
  }

  override get model(): string {
    for (let i = this.entryList.length - 1; i >= 0; i--) {
      const entry = this.entryList[i];
      if (entry.type === 'model') return entry.model;
    }
    return this.meta.model;
  }

  override title(): string {
    for (const entry of this.entryList) {
      if (entry.type !== 'message') continue;
      const title = titleFromMessage(entry.message);
      if (title !== undefined) return title;
    }
    return '(no messages)';
  }

  override usageTotals(): Usage {
    return this.entryList.reduce(
      (sum, entry) => (entry.type === 'usage' ? addUsage(sum, entry.billed ?? entry.usage) : sum),
      emptyUsage(),
    );
  }

  override lastUsage(): Usage | undefined {
    for (let i = this.entryList.length - 1; i >= 0; i--) {
      const entry = this.entryList[i];
      if (entry.type === 'usage') return entry.usage;
    }
    return undefined;
  }

  override hasMessages(): boolean {
    return this.entryList.some(
      (entry) => entry.type === 'message' && entry.message.role === 'user',
    );
  }

  /** Non-meta entries of one type, for assertions. */
  ofType<T extends SessionEntry['type']>(type: T): Extract<SessionEntry, { type: T }>[] {
    return this.entryList.filter(
      (entry): entry is Extract<SessionEntry, { type: T }> => entry.type === type,
    );
  }

  /** All stored conversation messages, ignoring compaction. */
  messages(): Message[] {
    return this.ofType('message').map((entry) => entry.message);
  }
}

// ---------------------------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------------------------

export function allowDecision(): PermissionDecision {
  return { type: 'allow', reason: 'test rule' };
}

export function denyDecision(message: string): PermissionDecision {
  return { type: 'deny', reason: 'test rule', message };
}

export function askDecision(grant?: SessionGrant): PermissionDecision {
  return {
    type: 'ask',
    prompt: {
      title: 'Patch wants to make a change',
      subjectLine: 'test subject',
      severity: 'normal',
      ...(grant ? { sessionOption: { label: 'Yes, for this session', grant } } : {}),
    },
  };
}

type DecisionTable = Record<PermissionSubject['kind'], PermissionDecision>;

/** Per-subject decision; undefined falls through to the table by subject kind. */
export type DecisionOverride = (subject: PermissionSubject) => PermissionDecision | undefined;

/**
 * Decides by subject kind (defaults: read allow, write ask with an all-edits session option,
 * execute, mcp and none allow), after an optional per-subject override. Writes are allowed once
 * an all-edits grant exists. In a mode other than the default the real PermissionManager decides.
 * Records every evaluation and grant.
 */
export class FakePermissions extends PermissionManager {
  readonly evaluated: PermissionSubject[] = [];
  readonly granted: SessionGrant[] = [];
  private readonly table: DecisionTable;
  private readonly override: DecisionOverride | undefined;

  constructor(decisions: Partial<DecisionTable> = {}, override?: DecisionOverride) {
    super();
    this.table = {
      read: allowDecision(),
      write: askDecision({ kind: 'all-edits' }),
      execute: allowDecision(),
      mcp: allowDecision(),
      none: allowDecision(),
      ...decisions,
    };
    this.override = override;
  }

  override evaluate(
    subject: PermissionSubject,
    permissionClass?: PermissionClass,
  ): PermissionDecision {
    this.evaluated.push(subject);
    // Modes other than the default are decided by the real manager.
    if (this.mode !== 'default') return super.evaluate(subject, permissionClass);
    if (subject.kind === 'write' && this.granted.some((grant) => grant.kind === 'all-edits')) {
      return { type: 'allow', reason: 'session grant' };
    }
    return this.override?.(subject) ?? this.table[subject.kind];
  }

  override grant(grant: SessionGrant): void {
    super.grant(grant);
    this.granted.push(grant);
  }
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

/** Shared observation point for the fake tools. */
export class ToolLab {
  readonly log: string[] = [];
  readonly notes = new Map<string, string>();
  active = 0;
  maxActive = 0;
}

function fakePath(input: string): ResolvedPath {
  return {
    input,
    absolute: resolve(TEST_CWD, input),
    display: input,
    insideProject: true,
    exists: true,
    isDirectory: false,
    insideGitDir: false,
  };
}

function readSubject(path: string): PermissionSubject {
  return { kind: 'read', paths: [fakePath(path)] };
}

function executeSubject(command: string): PermissionSubject {
  return {
    kind: 'execute',
    command,
    origin: 'agent',
    analysis: { command, risk: 'normal', reasons: [], segments: [], unparsable: false },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export function createFakeTools(lab: ToolLab): ToolDefinition[] {
  const echo = defineTool({
    name: 'echo',
    description: 'Echoes text back (read class).',
    inputSchema: z.object({ text: z.string(), delayMs: z.number().int().min(0).optional() }),
    permissionClass: 'read',
    summarize: ({ text }) => ({ verb: 'echo', target: text }),
    permission: ({ text }) => readSubject(text),
    async execute({ text, delayMs }) {
      lab.log.push(`start:echo:${text}`);
      lab.active++;
      lab.maxActive = Math.max(lab.maxActive, lab.active);
      try {
        if (delayMs) await delay(delayMs);
      } finally {
        lab.active--;
      }
      lab.log.push(`end:echo:${text}`);
      return { content: `echo: ${text}` };
    },
  });

  const note = defineTool({
    name: 'note',
    description: 'Stores a note (write class).',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    permissionClass: 'write',
    summarize: ({ path }) => ({ verb: 'write', target: path }),
    permission: ({ path }) => ({ kind: 'write', paths: [fakePath(path)] }),
    preview: async ({ content }) => ({ text: content }),
    async execute({ path, content }) {
      lab.log.push(`start:note:${path}`);
      lab.notes.set(path, content);
      lab.log.push(`end:note:${path}`);
      return { content: `Wrote ${path}`, display: { summary: `${content.length} chars` } };
    },
  });

  const slow = defineTool({
    name: 'slow',
    description: 'Waits until aborted or until `ms` elapse (execute class).',
    inputSchema: z.object({
      ms: z.number().int().min(0).optional(),
      ignoreAbort: z.boolean().optional(),
    }),
    permissionClass: 'execute',
    summarize: () => ({ verb: 'bash', target: 'sleep' }),
    permission: () => executeSubject('sleep'),
    async execute({ ms, ignoreAbort }, ctx) {
      lab.log.push('start:slow');
      await new Promise<void>((done) => {
        const timer = setTimeout(done, ms ?? 5_000);
        timer.unref();
        if (!ignoreAbort) {
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            done();
          });
        }
      });
      lab.log.push('end:slow');
      return { content: ctx.signal.aborted ? 'slow: stopped early' : 'slow: done' };
    },
  });

  const fail = defineTool({
    name: 'fail',
    description: 'Always fails with a ToolError.',
    inputSchema: z.object({ path: z.string() }),
    permissionClass: 'read',
    summarize: ({ path }) => ({ verb: 'read', target: path }),
    permission: ({ path }) => readSubject(path),
    async execute({ path }) {
      throw new ToolError(`File not found: ${path}. Check the path with glob.`, {
        summary: 'not found',
      });
    },
  });

  const crash = defineTool({
    name: 'crash',
    description: 'Throws an unexpected error.',
    inputSchema: z.object({}),
    permissionClass: 'read',
    summarize: () => ({ verb: 'crash', target: '' }),
    permission: () => readSubject('.'),
    async execute() {
      throw new Error('boom');
    },
  });

  const progress = defineTool({
    name: 'progress',
    description: 'Reports progress lines; with holdMs keeps reporting (ignoring abort) that long.',
    inputSchema: z.object({ lines: z.number().int().min(1), holdMs: z.number().optional() }),
    permissionClass: 'read',
    summarize: () => ({ verb: 'progress', target: '' }),
    permission: () => readSubject('.'),
    async execute({ lines, holdMs }, ctx) {
      for (let i = 1; i <= lines; i++) ctx.onProgress?.({ tail: [`line ${i}`], totalLines: i });
      const until = Date.now() + (holdMs ?? 0);
      let count = lines;
      while (Date.now() < until) {
        await delay(5);
        count++;
        ctx.onProgress?.({ tail: [`line ${count}`], totalLines: count });
      }
      return { content: `${count} lines` };
    },
  });

  const badpath = defineTool({
    name: 'badpath',
    description: 'Its permission check rejects the input.',
    inputSchema: z.object({ path: z.string() }),
    permissionClass: 'read',
    summarize: ({ path }) => ({ verb: 'read', target: path }),
    permission: ({ path }) => {
      throw new ToolError(`Path ${path} is outside the project. Use a path inside it.`);
    },
    async execute() {
      lab.log.push('start:badpath');
      return { content: 'unreachable' };
    },
  });

  return [echo, note, slow, fail, crash, progress, badpath] as ToolDefinition[];
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

export function createToolContext(): Omit<ToolContext, 'signal' | 'onProgress'> {
  return {
    cwd: TEST_CWD,
    projectRoot: TEST_CWD,
    gitRoot: null,
    home: resolve('/patch-test/home'),
    paths: new PathPolicy({
      cwd: TEST_CWD,
      projectRoot: TEST_CWD,
      home: resolve('/patch-test/home'),
    }),
    fileState: new FileStateTracker(),
    shell: {
      kind: 'bash',
      executable: 'bash',
      label: 'bash',
      argsFor: (command) => ['-c', command],
    },
    logger: noopLogger,
  };
}

export interface Harness {
  agent: Agent;
  provider: ScriptedProvider;
  session: MemorySession;
  permissions: FakePermissions;
  lab: ToolLab;
}

export interface HarnessOptions {
  /** Replaces the default ScriptedProvider built from `steps`. */
  provider?: ScriptedProvider;
  decisions?: Partial<DecisionTable>;
  decide?: DecisionOverride;
  agent?: Partial<Omit<AgentOptions, 'provider' | 'session' | 'tools' | 'permissions'>>;
  modelInfo?: Partial<ModelInfo>;
  /** Tools offered after the fake ones (e.g. present_plan). */
  extraTools?: ToolDefinition[];
}

export function createHarness(steps: ScriptStep[], options: HarnessOptions = {}): Harness {
  const lab = new ToolLab();
  const provider = options.provider ?? new ScriptedProvider(steps, options.modelInfo);
  const session = new MemorySession();
  const permissions = new FakePermissions(options.decisions, options.decide);
  const agent = new Agent({
    provider,
    session,
    tools: new ToolRegistry([...createFakeTools(lab), ...(options.extraTools ?? [])]),
    permissions,
    toolContext: createToolContext(),
    ...options.agent,
  });
  return { agent, provider, session, permissions, lab };
}

export interface TurnRecording {
  result: TurnResult;
  /** Every event delivered, including any (erroneously) delivered after turn_end. */
  events: AgentEvent[];
  permissionRequests: PermissionRequest[];
}

export interface RunOptions {
  /** UserTurn.notes. */
  notes?: string[];
  signal?: AbortSignal;
  /** Answers permission prompts. Default: deny without feedback (non-interactive behavior). */
  respond?: (request: PermissionRequest) => PermissionResponse | Promise<PermissionResponse>;
  /** Answers plan reviews (TurnOptions.reviewPlan); omitted, the turn has none. */
  reviewPlan?: (request: PlanReviewRequest) => PlanReviewResponse | Promise<PlanReviewResponse>;
  onEvent?: (event: AgentEvent) => void;
}

export async function runTurn(
  agent: Agent,
  text: string,
  options: RunOptions = {},
): Promise<TurnRecording> {
  const events: AgentEvent[] = [];
  const permissionRequests: PermissionRequest[] = [];
  const result = await agent.runTurn(
    { text, ...(options.notes ? { notes: options.notes } : {}) },
    {
      signal: options.signal ?? new AbortController().signal,
      onEvent: (event) => {
        events.push(event);
        options.onEvent?.(event);
      },
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return options.respond ? options.respond(request) : { decision: 'deny' };
      },
      ...(options.reviewPlan
        ? { reviewPlan: async (request: PlanReviewRequest) => options.reviewPlan!(request) }
        : {}),
    },
  );
  return { result, events, permissionRequests };
}

export function eventTypes(events: AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

export function eventsOf<T extends AgentEvent['type']>(
  events: AgentEvent[],
  type: T,
): Extract<AgentEvent, { type: T }>[] {
  return events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
}

export function agentRequests(provider: ScriptedProvider): ModelRequest[] {
  return provider.requests.filter((request) => request.purpose === 'agent');
}

/**
 * The provider conformance rules for tool pairing: every assistant tool call is answered in the
 * immediately following user message, results reference calls of the immediately preceding
 * assistant message, and results come before other blocks in their message.
 */
export function expectValidHistory(messages: Message[]): void {
  expect(messages[0]?.role).toBe('user');
  messages.forEach((message, index) => {
    expect(message.content.length).toBeGreaterThan(0);
    const previous = messages[index - 1];
    const callIds =
      previous?.role === 'assistant'
        ? previous.content.flatMap((block) => (block.type === 'tool_call' ? [block.id] : []))
        : [];
    if (message.role === 'user') {
      const resultIds = message.content.flatMap((block) =>
        block.type === 'tool_result' ? [block.toolCallId] : [],
      );
      expect(resultIds.sort()).toEqual([...callIds].sort());
      const firstOther = message.content.findIndex((block) => block.type !== 'tool_result');
      if (firstOther >= 0) {
        expect(
          message.content.slice(firstOther).every((block) => block.type !== 'tool_result'),
        ).toBe(true);
      }
    } else {
      expect(message.content.every((block) => block.type !== 'tool_result')).toBe(true);
      const hasCalls = message.content.some((block) => block.type === 'tool_call');
      if (hasCalls) expect(messages[index + 1]?.role).toBe('user');
    }
  });
}

/**
 * Append-only invariant across a sequence of agent requests: identical system and tools, and each
 * request's messages extend the previous request's messages.
 */
export function expectAppendOnly(requests: ModelRequest[]): void {
  for (let i = 1; i < requests.length; i++) {
    const previous = requests[i - 1];
    const current = requests[i];
    expect(current.system).toBe(previous.system);
    expect(current.tools).toEqual(previous.tools);
    expect(current.hostedTools).toEqual(previous.hostedTools);
    expect(current.messages.length).toBeGreaterThan(previous.messages.length);
    expect(current.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
  }
}

/** Resolves when `predicate` matches an event (checked as events arrive). */
export function waitForEvent(predicate: (event: AgentEvent) => boolean): {
  onEvent: (event: AgentEvent) => void;
  reached: Promise<AgentEvent>;
} {
  let resolveReached!: (event: AgentEvent) => void;
  const reached = new Promise<AgentEvent>((done) => {
    resolveReached = done;
  });
  return {
    onEvent: (event) => {
      if (predicate(event)) resolveReached(event);
    },
    reached,
  };
}
