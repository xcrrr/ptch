import { describe, expect, it } from 'vitest';
import type { Message, ToolResultBlock } from '@patch/shared';
import {
  PRESENT_PLAN_TOOL,
  planModeInHistory,
  planModeNote,
  planModeText,
} from '../../src/agent/plan-mode.js';
import { buildSystemPrompt } from '../../src/agent/system-prompt.js';
import { SKIPPED_AFTER_PLAN_MESSAGE, SKIPPED_TOOL_MESSAGE } from '../../src/agent/tool-runner.js';
import type { PlanReviewRequest, PlanReviewResponse } from '../../src/permissions/modes.js';
import { PLAN_MODE_TAG, WORKING_DIRECTORY_TAG } from '../../src/session/schema.js';
import { textResponse, toolResponse } from '../../src/testing/index.js';
import { createDefaultTools } from '../../src/tools/index.js';
import { planTitle, presentPlanTool } from '../../src/tools/present-plan.js';
import type { ToolDefinition } from '../../src/tools/types.js';
import {
  agentRequests,
  createHarness,
  eventsOf,
  expectAppendOnly,
  expectValidHistory,
  runTurn,
  type HarnessOptions,
} from './helpers.js';

const PLAN = '## Cache the config\n\n1. Read it once in `src/config.ts`.\n2. Run the tests.';
const ON = planModeNote(true);
const OFF = planModeNote(false);

function planHarness(steps: Parameters<typeof createHarness>[0], options: HarnessOptions = {}) {
  return createHarness(steps, {
    ...options,
    extraTools: [presentPlanTool as ToolDefinition],
  });
}

/** Text blocks of a user message. */
function texts(message: Message | undefined): string[] {
  return (message?.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : []));
}

/** The tool result for `id` in the history. */
function resultFor(messages: readonly Message[], id: string): ToolResultBlock | undefined {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result' && block.toolCallId === id) return block;
    }
  }
  return undefined;
}

const presentPlan = (id = 'plan1', plan = PLAN) =>
  toolResponse([{ id, name: PRESENT_PLAN_TOOL, input: { plan } }], 'Here is my plan.');

describe('plan mode notes', () => {
  it('tell the model plan mode is on with the next user message, and only once', async () => {
    const harness = planHarness([textResponse('researching'), textResponse('still researching')]);
    harness.permissions.setMode('plan');
    const directory = `${WORKING_DIRECTORY_TAG}\nWorking directory: /repo\n</working-directory-update>`;
    await runTurn(harness.agent, 'add a cache', { notes: [directory] });
    await runTurn(harness.agent, 'go on');

    const [first, second] = agentRequests(harness.provider);
    // After the caller's notes, before the text, in the same message.
    expect(texts(first!.messages[0])).toEqual([directory, ON, 'add a cache']);
    expect(texts(second!.messages.at(-1))).toEqual(['go on']);
    expect(harness.session.title()).toBe('add a cache');
    expect(ON.startsWith(`${PLAN_MODE_TAG} state="on">`)).toBe(true);
    expect(ON).toContain('call present_plan');
    expectAppendOnly(agentRequests(harness.provider));
  });

  it('tell the model plan mode is off once it was turned off', async () => {
    const harness = planHarness([textResponse('a'), textResponse('b'), textResponse('c')]);
    harness.permissions.setMode('plan');
    await runTurn(harness.agent, 'one');
    harness.permissions.setMode('acceptEdits');
    await runTurn(harness.agent, 'two');
    harness.permissions.setMode('default');
    await runTurn(harness.agent, 'three');

    const requests = agentRequests(harness.provider);
    expect(texts(requests[1]!.messages.at(-1))).toEqual([OFF, 'two']);
    // Accepting edits and the default are both "off" for the model.
    expect(texts(requests[2]!.messages.at(-1))).toEqual(['three']);
    expectAppendOnly(requests);
  });

  it('say nothing when the mode was switched on and back off between messages', async () => {
    const harness = planHarness([textResponse('a'), textResponse('b')]);
    await runTurn(harness.agent, 'one');
    harness.permissions.setMode('plan');
    harness.permissions.setMode('default');
    await runTurn(harness.agent, 'two');
    expect(texts(agentRequests(harness.provider)[1]!.messages.at(-1))).toEqual(['two']);
  });

  it('never change the system prompt or the tool list', async () => {
    const harness = planHarness([textResponse('a'), textResponse('b'), textResponse('c')]);
    await runTurn(harness.agent, 'one');
    harness.permissions.setMode('plan');
    await runTurn(harness.agent, 'two');
    harness.permissions.setMode('default');
    await runTurn(harness.agent, 'three');
    const requests = agentRequests(harness.provider);
    expect(requests.map((request) => request.tools.map((tool) => tool.name))).toEqual(
      Array(3).fill(requests[0]!.tools.map((tool) => tool.name)),
    );
    expect(requests[0]!.tools.map((tool) => tool.name)).toContain(PRESENT_PLAN_TOOL);
    expectAppendOnly(requests);
  });

  it('tell a resumed session in the default mode that plan mode is off', async () => {
    const harness = planHarness([textResponse('ok')]);
    harness.session.append({
      type: 'message',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: ON },
          { type: 'text', text: 'plan it' },
        ],
      },
    });
    harness.session.append({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Reading first.' }] },
    });
    expect(planModeInHistory(harness.session.history())).toBe(true);
    await runTurn(harness.agent, 'just do it');
    expect(texts(agentRequests(harness.provider)[0]!.messages.at(-1))).toEqual([OFF, 'just do it']);
  });

  it('are sent again after a compaction left only the summary', async () => {
    const harness = planHarness(
      [
        textResponse('first', { usage: { inputTokens: 900, outputTokens: 30 } }),
        textResponse('summary'),
        textResponse('second'),
      ],
      { modelInfo: { contextWindow: 1_000 } },
    );
    harness.permissions.setMode('plan');
    await runTurn(harness.agent, 'one');
    await runTurn(harness.agent, 'two');
    const retried = agentRequests(harness.provider)[1]!;
    expect(texts(retried.messages.at(-1))).toEqual([ON, 'two']);
  });

  it('are read back from present_plan results, which say whether plan mode is on', () => {
    const call = (id: string, name = PRESENT_PLAN_TOOL): Message => ({
      role: 'assistant',
      content: [{ type: 'tool_call', id, name, input: {} }],
    });
    const result = (id: string, content: string): Message => ({
      role: 'user',
      content: [{ type: 'tool_result', toolCallId: id, content }],
    });
    const note = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
    expect(planModeInHistory([])).toBe(false);
    expect(planModeInHistory([note(ON)])).toBe(true);
    expect(
      planModeInHistory([note(ON), call('p1'), result('p1', planModeText(false, 'approved'))]),
    ).toBe(false);
    // Only present_plan results count: another tool's output cannot claim a mode.
    expect(planModeInHistory([note(ON), call('b1', 'bash'), result('b1', OFF)])).toBe(true);
  });
});

describe('plan mode enforcement in a turn', () => {
  it('denies edits and commands without asking, and lets reads run', async () => {
    const harness = planHarness([
      toolResponse([
        { id: 'r', name: 'echo', input: { text: 'src/a.ts' } },
        { id: 'w', name: 'note', input: { path: 'a.md', content: 'x' } },
        { id: 'x', name: 'slow', input: { ms: 1 } },
      ]),
      textResponse('I will present a plan instead.'),
    ]);
    harness.permissions.setMode('plan');
    const { result, permissionRequests } = await runTurn(harness.agent, 'change it');

    expect(result.status).toBe('completed');
    expect(permissionRequests).toEqual([]);
    expect(harness.lab.log).toEqual(['start:echo:src/a.ts', 'end:echo:src/a.ts']);
    const history = harness.session.history();
    expect(resultFor(history, 'r')?.isError).toBeUndefined();
    expect(resultFor(history, 'w')).toMatchObject({ isError: true });
    expect(resultFor(history, 'w')?.content).toMatch(/^Plan mode is on: .*cannot be edited/);
    expect(resultFor(history, 'x')?.content).toMatch(/^Plan mode is on: .*read-only commands/);
    expect(harness.session.ofType('tool').map((entry) => entry.denied)).toEqual([
      undefined,
      true,
      true,
    ]);
    expectValidHistory(history);
  });
});

describe('present_plan', () => {
  it('approved with "accept edits": switches modes and the next edit needs no approval', async () => {
    const reviews: PlanReviewRequest[] = [];
    const harness = planHarness([
      presentPlan(),
      toolResponse([{ id: 'w', name: 'note', input: { path: 'a.md', content: 'x' } }]),
      textResponse('Done.'),
    ]);
    harness.permissions.setMode('plan');
    const { result, events, permissionRequests } = await runTurn(harness.agent, 'add a cache', {
      reviewPlan: (request) => {
        reviews.push(request);
        return { decision: 'approve', mode: 'acceptEdits' };
      },
    });

    expect(result.status).toBe('completed');
    expect(reviews).toEqual([{ id: 'plan1', plan: PLAN }]);
    expect(harness.permissions.mode).toBe('acceptEdits');
    expect(eventsOf(events, 'plan_review')).toEqual([
      { type: 'plan_review', id: 'plan1', request: { id: 'plan1', plan: PLAN } },
    ]);
    expect(eventsOf(events, 'permission_mode')).toEqual([
      { type: 'permission_mode', mode: 'acceptEdits' },
    ]);
    const approved = resultFor(harness.session.history(), 'plan1');
    expect(approved?.isError).toBeUndefined();
    expect(approved?.content).toMatch(/^<plan-mode state="off">\nThe user approved your plan/);
    expect(approved?.content).toContain('Implement the plan now.');
    // The edit ran without a prompt.
    expect(permissionRequests).toEqual([]);
    expect(harness.lab.notes.get('a.md')).toBe('x');
    const [planEntry] = harness.session.ofType('tool');
    expect(planEntry).toMatchObject({
      name: PRESENT_PLAN_TOOL,
      summary: { verb: 'plan', target: 'Cache the config' },
      display: { plan: PLAN, summary: 'approved · accepting edits' },
    });
    expectValidHistory(harness.session.history());
  });

  it('approved with "ask before each edit": back to the default mode, where edits ask', async () => {
    const harness = planHarness([
      presentPlan(),
      toolResponse([{ id: 'w', name: 'note', input: { path: 'a.md', content: 'x' } }]),
      textResponse('Waiting for approval.'),
    ]);
    harness.permissions.setMode('plan');
    const { permissionRequests } = await runTurn(harness.agent, 'add a cache', {
      reviewPlan: () => ({ decision: 'approve', mode: 'default' }),
      respond: () => ({ decision: 'allow_once' }),
    });
    expect(harness.permissions.mode).toBe('default');
    expect(permissionRequests.map((request) => request.toolName)).toEqual(['note']);
    expect(resultFor(harness.session.history(), 'plan1')?.content).toContain(
      'Edits and commands ask for approval as usual.',
    );
  });

  it('does not repeat the mode change with the next message after an approval', async () => {
    const harness = planHarness([presentPlan(), textResponse('Done.'), textResponse('Sure.')]);
    harness.permissions.setMode('plan');
    await runTurn(harness.agent, 'add a cache', {
      reviewPlan: () => ({ decision: 'approve', mode: 'acceptEdits' }),
    });
    await runTurn(harness.agent, 'thanks');
    expect(texts(agentRequests(harness.provider).at(-1)!.messages.at(-1))).toEqual(['thanks']);
  });

  it('kept planning with feedback: plan mode stays on and the model revises the plan', async () => {
    const harness = planHarness([
      presentPlan('plan1'),
      presentPlan('plan2', `${PLAN}\n3. Use zod.`),
      textResponse('Implementing.'),
    ]);
    harness.permissions.setMode('plan');
    const answers: PlanReviewResponse[] = [
      { decision: 'keep_planning', feedback: '  Validate it with zod.  ' },
      { decision: 'approve', mode: 'acceptEdits' },
    ];
    const { result } = await runTurn(harness.agent, 'add a cache', {
      reviewPlan: () => answers.shift()!,
    });

    expect(result.status).toBe('completed');
    const kept = resultFor(harness.session.history(), 'plan1');
    expect(kept?.content).toBe(
      planModeText(
        true,
        'The user did not approve the plan yet and wants changes (plan mode stays on). Their feedback:\nValidate it with zod.\nRevise the plan, researching more if needed, and present it again with present_plan.',
      ),
    );
    expect(harness.session.ofType('tool')[0]?.display).toMatchObject({
      summary: 'keep planning',
      lines: ['Validate it with zod.'],
    });
    expect(agentRequests(harness.provider)).toHaveLength(3);
    expect(harness.permissions.mode).toBe('acceptEdits');
  });

  it('kept planning without feedback (or esc): the turn ends so the user can say what to change', async () => {
    const harness = planHarness([
      toolResponse([
        { id: 'plan1', name: PRESENT_PLAN_TOOL, input: { plan: PLAN } },
        { id: 'r', name: 'echo', input: { text: 'more' } },
      ]),
      textResponse('Revised.'),
    ]);
    harness.permissions.setMode('plan');
    const { result } = await runTurn(harness.agent, 'add a cache', {
      reviewPlan: () => ({ decision: 'keep_planning' }),
    });

    expect(result.status).toBe('denied');
    expect(agentRequests(harness.provider)).toHaveLength(1);
    expect(harness.permissions.mode).toBe('plan');
    const history = harness.session.history();
    expect(resultFor(history, 'plan1')?.content).toContain('Wait for them to say what to change.');
    expect(resultFor(history, 'r')?.content).toBe(SKIPPED_TOOL_MESSAGE);
    expect(harness.lab.log).toEqual([]);

    // The user's next message is the feedback; plan mode is still on, so no note.
    await runTurn(harness.agent, 'Use zod.');
    const next = agentRequests(harness.provider)[1]!;
    expect(texts(next.messages.at(-1))).toEqual(['Use zod.']);
    expectValidHistory(next.messages);
  });

  it('outside plan mode only shows the plan and tells the model to go ahead', async () => {
    let reviewed = false;
    const harness = planHarness([presentPlan(), textResponse('Implementing.')]);
    const { result, events } = await runTurn(harness.agent, 'plan first, then do it', {
      reviewPlan: () => {
        reviewed = true;
        return { decision: 'keep_planning' };
      },
    });

    expect(result.status).toBe('completed');
    expect(reviewed).toBe(false);
    expect(eventsOf(events, 'plan_review')).toEqual([]);
    expect(resultFor(harness.session.history(), 'plan1')?.content).toBe(
      planModeText(
        false,
        'Plan mode is off, so the plan needs no approval: it was shown to the user. Go ahead with it.',
      ),
    );
    const end = eventsOf(events, 'tool_end')[0];
    expect(end?.result.display).toEqual({ plan: PLAN });
    expect(harness.permissions.mode).toBe('default');
  });

  it('ends the turn with the plan as its outcome when nobody can review it', async () => {
    const harness = planHarness([
      toolResponse([
        { id: 'plan1', name: PRESENT_PLAN_TOOL, input: { plan: PLAN } },
        { id: 'r', name: 'echo', input: { text: 'more' } },
      ]),
    ]);
    harness.permissions.setMode('plan');
    const { result } = await runTurn(harness.agent, 'add a cache');

    expect(result.status).toBe('completed');
    expect(agentRequests(harness.provider)).toHaveLength(1);
    const history = harness.session.history();
    expect(resultFor(history, 'plan1')?.content).toMatch(/^<plan-mode state="on">\nThe plan was/);
    expect(resultFor(history, 'r')?.content).toBe(SKIPPED_AFTER_PLAN_MESSAGE);
    expect(harness.session.ofType('tool')[0]?.display?.summary).toBe('presented');
    expect(harness.permissions.mode).toBe('plan');
    expectValidHistory(history);
  });

  it('changes nothing when interrupted during the review', async () => {
    const abort = new AbortController();
    const harness = planHarness([presentPlan()]);
    harness.permissions.setMode('plan');
    const { result } = await runTurn(harness.agent, 'add a cache', {
      signal: abort.signal,
      reviewPlan: () =>
        new Promise((resolve) => {
          abort.abort();
          setTimeout(() => resolve({ decision: 'approve', mode: 'acceptEdits' }), 5);
        }),
    });
    expect(result.status).toBe('interrupted');
    expect(harness.permissions.mode).toBe('plan');
    expectValidHistory(harness.session.history());
  });

  it('treats a failing review as not approved', async () => {
    const harness = planHarness([presentPlan()]);
    harness.permissions.setMode('plan');
    const { result } = await runTurn(harness.agent, 'add a cache', {
      reviewPlan: () => {
        throw new Error('no terminal');
      },
    });
    expect(result.status).toBe('denied');
    expect(harness.permissions.mode).toBe('plan');
  });

  it('runs in every mode: it needs no approval', async () => {
    for (const mode of ['default', 'acceptEdits', 'plan'] as const) {
      const harness = planHarness([presentPlan(), textResponse('ok')]);
      harness.permissions.setMode(mode);
      const { permissionRequests } = await runTurn(harness.agent, 'plan', {
        reviewPlan: () => ({ decision: 'keep_planning', feedback: 'more detail' }),
      });
      expect(permissionRequests).toEqual([]);
      expect(harness.permissions.evaluated.at(-1)).toEqual({ kind: 'none' });
    }
  });

  it('rejects an empty plan', async () => {
    const harness = planHarness([
      toolResponse([{ id: 'plan1', name: PRESENT_PLAN_TOOL, input: { plan: '' } }]),
      textResponse('ok'),
    ]);
    await runTurn(harness.agent, 'plan');
    expect(resultFor(harness.session.history(), 'plan1')).toMatchObject({ isError: true });
  });

  it('titles the row with the first line of the plan', () => {
    expect(planTitle('## Cache the config\n\nmore')).toBe('Cache the config');
    expect(planTitle('\n\n1. **Read** `a.ts` first')).toBe('Read a.ts first');
    expect(planTitle('   ')).toBe('plan');
  });
});

describe('the system prompt and tool list', () => {
  it('describe modes and present_plan in every session', () => {
    const names = createDefaultTools().map((tool) => tool.name);
    expect(names.at(-1)).toBe(PRESENT_PLAN_TOOL);
    expect(presentPlanTool.permissionClass).toBe('none');
    const prompt = buildSystemPrompt({
      workspace: {
        cwd: '/repo',
        projectRoot: '/repo',
        home: '/home/u',
        platform: 'linux',
        isGit: false,
        git: null,
        project: { kinds: [], label: '', scripts: [] },
        instructions: [],
        guidance: [],
      },
      shell: { kind: 'bash', executable: 'bash', label: 'bash', argsFor: () => [] },
      date: '2026-10-12',
      gitSnapshot: null,
      ripgrep: false,
    });
    expect(prompt).toContain('# Permission modes and plans');
    expect(prompt).toContain('call present_plan with a concise Markdown plan');
    expect(prompt).toContain('<plan-mode state="on">');
    expect(prompt.indexOf('# Permission modes')).toBeLessThan(prompt.indexOf('# Environment'));
  });
});
