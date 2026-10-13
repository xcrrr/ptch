import type { Message } from '@patch/shared';
import { PLAN_MODE_TAG } from '../session/schema.js';

/** Name of the tool the model presents its plan with (see tools/present-plan.ts). */
export const PRESENT_PLAN_TOOL = 'present_plan';

const PLAN_MODE_STATE = /^<plan-mode state="(on|off)">/;

/**
 * Text for the model saying whether plan mode is on, wrapped in PLAN_MODE_TAG
 * (`<plan-mode state="on">\n...\n</plan-mode>`), so planModeInHistory can find it again.
 */
export function planModeText(on: boolean, body: string): string {
  return [`${PLAN_MODE_TAG} state="${on ? 'on' : 'off'}">`, body, '</plan-mode>'].join('\n');
}

/** The note sent with the user's next turn after plan mode was turned on or off. */
export function planModeNote(on: boolean): string {
  return planModeText(
    on,
    on
      ? `The user turned on plan mode. Research only: read files, search, and run read-only commands; edits and commands that could change anything are denied until a plan is approved. When you know what to do, call ${PRESENT_PLAN_TOOL} with your plan. The user approves it (plan mode then ends and you implement the plan) or tells you what to change.`
      : 'The user turned off plan mode. You may edit files and run commands again.',
  );
}

/**
 * Whether the model last heard that plan mode is on: the newest plan mode note in `history` or
 * present_plan result, else off (sessions start in the default mode, and a compaction leaves
 * only its summary). The conversation is append-only, so a change of mode is told with the next
 * user turn rather than by editing anything; this tells whether there is one to tell.
 */
export function planModeInHistory(history: readonly Message[]): boolean {
  const planCalls = new Set<string>();
  for (const message of history) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'tool_call' && block.name === PRESENT_PLAN_TOOL) planCalls.add(block.id);
    }
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message?.role !== 'user') continue;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j];
      const text =
        block?.type === 'text'
          ? block.text
          : block?.type === 'tool_result' && planCalls.has(block.toolCallId)
            ? block.content
            : undefined;
      const state = text === undefined ? undefined : PLAN_MODE_STATE.exec(text.trimStart())?.[1];
      if (state !== undefined) return state === 'on';
    }
  }
  return false;
}
