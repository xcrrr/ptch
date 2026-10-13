import { z } from 'zod';
import { oneLine } from '@patch/shared';
import { PRESENT_PLAN_TOOL, planModeText } from '../agent/plan-mode.js';
import { defineTool, type PlanOutcome, type ToolResult } from './types.js';

const TITLE_MAX_CHARS = 80;

export const presentPlanInput = z.object({
  plan: z
    .string()
    .min(1)
    .describe(
      'The plan in Markdown: the goal, the changes file by file, and how you will verify them.',
    ),
});

/**
 * present_plan — shows the model's plan to the user. In plan mode the user approves it (and
 * chooses whether edits are then accepted automatically) or keeps planning; the agent switches
 * modes and this tool tells the model what happened. Outside plan mode the plan is only shown.
 * Permission class `none`: it touches nothing outside Patch, so it runs in every mode.
 */
export const presentPlanTool = defineTool({
  name: PRESENT_PLAN_TOOL,
  description:
    'Present your implementation plan to the user for approval. In plan mode, call it once your research is done: the user approves the plan (plan mode then ends and you implement it) or tells you what to change. Outside plan mode it only shows the plan. Write the plan in Markdown, concise and specific: the goal, the changes file by file, and how you will verify them. Call it on its own, not together with other tools.',
  inputSchema: presentPlanInput,
  permissionClass: 'none',
  summarize: ({ plan }) => ({ verb: 'plan', target: planTitle(plan) }),
  permission: () => ({ kind: 'none' }),
  async execute({ plan }, ctx) {
    const outcome: PlanOutcome = ctx.presentPlan
      ? await ctx.presentPlan(plan)
      : { decision: 'shown' };
    return planResult(plan, outcome);
  },
});

/** The plan's first line without Markdown markers ("## Add a cache" → "Add a cache"). */
export function planTitle(plan: string): string {
  const first = plan.split('\n').find((line) => line.trim() !== '') ?? '';
  const title = first
    .trim()
    .replace(/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '')
    .replace(/[*_`]/g, '')
    .trim();
  return oneLine(title, TITLE_MAX_CHARS) || 'plan';
}

function planResult(plan: string, outcome: PlanOutcome): ToolResult {
  const display = (summary?: string, lines?: string[]) => ({
    plan,
    ...(summary ? { summary } : {}),
    ...(lines ? { lines } : {}),
  });
  switch (outcome.decision) {
    case 'approve':
      return outcome.mode === 'acceptEdits'
        ? {
            content: planModeText(
              false,
              'The user approved your plan and turned plan mode off. File edits inside the project are now accepted without asking; commands still ask as usual. Implement the plan now.',
            ),
            display: display('approved · accepting edits'),
          }
        : {
            content: planModeText(
              false,
              'The user approved your plan and turned plan mode off. Edits and commands ask for approval as usual. Implement the plan now.',
            ),
            display: display('approved'),
          };
    case 'keep_planning': {
      const feedback = outcome.feedback?.trim();
      return feedback
        ? {
            content: planModeText(
              true,
              `The user did not approve the plan yet and wants changes (plan mode stays on). Their feedback:\n${feedback}\nRevise the plan, researching more if needed, and present it again with ${PRESENT_PLAN_TOOL}.`,
            ),
            display: display('keep planning', [feedback]),
          }
        : {
            content: planModeText(
              true,
              'The user did not approve the plan and wants to keep planning (plan mode stays on). Wait for them to say what to change.',
            ),
            display: display('keep planning'),
          };
    }
    case 'end_turn':
      return {
        content: planModeText(
          true,
          'The plan was given to the user. This run is not interactive, so it ends here; the user reviews the plan on their own.',
        ),
        display: display('presented'),
      };
    case 'shown':
      return {
        content: planModeText(
          false,
          'Plan mode is off, so the plan needs no approval: it was shown to the user. Go ahead with it.',
        ),
        display: display(),
      };
  }
}
