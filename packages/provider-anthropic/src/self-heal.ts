import { BadRequestError } from '@anthropic-ai/sdk';
import { apiErrorDetails } from './errors.js';
import { BETA_BLOCK_BINDING, BETA_SERVER_FALLBACKS, type SentFeatures } from './request.js';

/** Optional request features that can be turned off when the API rejects them. */
export type HealableFeature = keyof SentFeatures;

export type HealAction =
  | { type: 'disable'; feature: HealableFeature }
  /** Resend without the thinking blocks whose signatures the API refused. */
  | { type: 'strip_thinking' };

export function healActionKey(action: HealAction): string {
  return action.type === 'disable' ? action.feature : action.type;
}

/** Errors about blocks in the history rather than the tool definition (resending cannot help). */
const SERVER_TOOL_HISTORY_ERROR = /tool_result|encrypted_/;

/**
 * What each feature's 400 looks like: the parameter it sends or its beta header. `unless` rules
 * out messages that name the feature for another reason.
 */
const FEATURE_MARKERS: Array<{ feature: HealableFeature; pattern: RegExp; unless?: RegExp }> = [
  { feature: 'blockBinding', pattern: new RegExp(`block_binding|${BETA_BLOCK_BINDING}`) },
  { feature: 'serverFallbacks', pattern: new RegExp(`fallbacks|${BETA_SERVER_FALLBACKS}`) },
  // Also matches the beta name, thinking-display-updates-2026-08-18.
  { feature: 'progressUpdates', pattern: /\bdisplay\b|updates/ },
  { feature: 'eagerInputStreaming', pattern: /eager_input_streaming/ },
  // E.g. web search disabled for the organization, or a tool version the model does not take.
  { feature: 'webSearch', pattern: /web[_ ]search/, unless: SERVER_TOOL_HISTORY_ERROR },
  { feature: 'webFetch', pattern: /web[_ ]fetch/, unless: SERVER_TOOL_HISTORY_ERROR },
];

/**
 * Decides whether a failed request can be repaired by resending it without one optional
 * feature. Only 400s whose message names something this request actually sent qualify, so an
 * unrelated validation error is never retried.
 */
export function detectHealAction(
  error: unknown,
  sent: SentFeatures,
  thinkingBlocksSent: number,
): HealAction | undefined {
  if (!(error instanceof BadRequestError)) return undefined;
  const message = apiErrorDetails(error).message?.toLowerCase();
  if (!message) return undefined;
  if (thinkingBlocksSent > 0 && message.includes('signature')) return { type: 'strip_thinking' };
  for (const { feature, pattern, unless } of FEATURE_MARKERS) {
    if (sent[feature] && pattern.test(message) && !unless?.test(message)) {
      return { type: 'disable', feature };
    }
  }
  return undefined;
}
