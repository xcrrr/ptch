/**
 * How the PermissionManager treats tool calls, chosen by the user during a session (never
 * persisted: every session, resumed ones included, starts in `default`):
 *  - default:     the rules as configured (edits ask, commands depend on their risk)
 *  - acceptEdits: file edits inside the project are allowed, as if the user had answered "Yes,
 *                 allow all edits this session"; everything else is unchanged
 *  - plan:        read-only research. Every write, and every command (or other execute-class
 *                 call) that would not run without asking anyway, is denied without a prompt
 *  - auto:        no prompts, except the guardrails: destructive commands (and commands Patch
 *                 cannot fully analyze), commands that may read secrets, and sensitive files
 *                 still ask. Denials (blocked commands, .git, deny rules) never change
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto';

/** The order Shift+Tab cycles through. */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
];

/** The mode after `mode` in PERMISSION_MODES (auto wraps around to default). */
export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  const index = PERMISSION_MODES.indexOf(mode);
  return PERMISSION_MODES[(index + 1) % PERMISSION_MODES.length] ?? 'default';
}

/** A plan the model presented with present_plan in plan mode, waiting for the user's answer. */
export interface PlanReviewRequest {
  /** The present_plan call's id. */
  id: string;
  /** The plan, in Markdown. */
  plan: string;
}

/**
 * The answer to a plan review:
 *  - approve:       plan mode ends; the session continues in `mode` and the model implements
 *                   (never auto mode, which the user turns on themselves)
 *  - keep_planning: plan mode stays on. With feedback the model revises the plan right away;
 *                   without, the turn ends and the user says what to change in their next message
 *  - end_turn:      nobody can answer (print mode): the plan is the outcome and the turn ends
 */
export type PlanReviewResponse =
  | { decision: 'approve'; mode: 'acceptEdits' | 'default' }
  | { decision: 'keep_planning'; feedback?: string }
  | { decision: 'end_turn' };
