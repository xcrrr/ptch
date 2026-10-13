import type { ModelInfo } from '@patch/shared';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Every `output_config.effort` level, lowest to highest. */
export const EFFORT_LEVELS: readonly AnthropicEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Effort scale of models released before 'xhigh' existed (it arrived with Claude Opus 4.7). */
const EFFORT_LEVELS_WITHOUT_XHIGH: readonly AnthropicEffort[] = ['low', 'medium', 'high', 'max'];

/** Request-shape capabilities per model family. Drives which parameters/betas are sent. */
export interface AnthropicModelCapabilities {
  /**
   * Send `thinking: { type: 'adaptive', ... }`. Required for thinking on models where omitting
   * `thinking` means no thinking (Opus 4.6-4.8, Sonnet 4.6); harmless on models that think by
   * default. Never 'disabled' or `budget_tokens`, which 5.x models reject.
   */
  adaptiveThinking: boolean;
  /** Supports `thinking.display: 'updates'` (beta thinking-display-updates-2026-08-18). */
  progressUpdates: boolean;
  /** Supports `thinking.block_binding` (beta thinking-binding-controls-2026-08-01). */
  blockBinding: boolean;
  /** Supports `output_config.effort`. */
  effort: boolean;
  /**
   * The effort levels the model accepts when `effort` is true (default: all of EFFORT_LEVELS).
   * A configured level outside this list is clamped to the nearest one (see clampEffort).
   */
  effortLevels?: readonly AnthropicEffort[];
  /** Supports server-side refusal fallbacks `fallbacks: 'default'` (beta server-side-fallback-2026-07-01). */
  serverFallbacks: boolean;
  /** Supports `eager_input_streaming` on tools. */
  eagerInputStreaming: boolean;
  /**
   * Web search and web fetch server tools: 'dynamic' takes the `_20260209` versions (dynamic
   * filtering, Claude 4.6 and later), 'basic' the original ones, false none.
   */
  webTools: WebToolsSupport;
}

export type WebToolsSupport = 'dynamic' | 'basic' | false;

/** Web search price on the Claude API, USD per search on top of tokens (fetch costs tokens only). */
export const WEB_SEARCH_USD_PER_REQUEST = 10 / 1000;

export interface AnthropicModelEntry extends ModelInfo {
  capabilities: AnthropicModelCapabilities;
  /** Shown in /model. */
  recommended?: boolean;
}

const FIVE_X: AnthropicModelCapabilities = {
  adaptiveThinking: true,
  progressUpdates: true,
  blockBinding: true,
  effort: true,
  serverFallbacks: true,
  eagerInputStreaming: true,
  webTools: 'dynamic',
};

/** Adaptive thinking (sent explicitly) and effort, without any of the beta request features. */
const ADAPTIVE_ONLY: AnthropicModelCapabilities = {
  adaptiveThinking: true,
  progressUpdates: false,
  blockBinding: false,
  effort: true,
  serverFallbacks: false,
  eagerInputStreaming: true,
  webTools: 'dynamic',
};

/** Opus 4.6 / Sonnet 4.6: adaptive thinking and effort, but no 'xhigh' effort level. */
const FOUR_SIX: AnthropicModelCapabilities = {
  ...ADAPTIVE_ONLY,
  effortLevels: EFFORT_LEVELS_WITHOUT_XHIGH,
};

/**
 * Curated catalog (pricing in USD per million tokens; cache write = 5-minute TTL rate).
 * Source: Anthropic model documentation as of 2026-10.
 */
export const ANTHROPIC_MODELS: AnthropicModelEntry[] = [
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    description: 'Default. Strongest Opus for long-horizon agentic coding.',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 },
    known: true,
    recommended: true,
    capabilities: FIVE_X,
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    description: 'Fast and capable for everyday coding.',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
    known: true,
    recommended: true,
    capabilities: { ...FIVE_X, progressUpdates: true },
  },
  {
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    description: 'Most capable; slower and more expensive.',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: {
      inputPerMTok: 10,
      outputPerMTok: 50,
      cacheReadPerMTok: 0.25,
      cacheWritePerMTok: 12.5,
    },
    known: true,
    recommended: true,
    capabilities: FIVE_X,
  },
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 1, cacheWritePerMTok: 12.5 },
    known: true,
    // block_binding arrived with Fable 5.1; fallbacks stay off until confirmed for this model.
    capabilities: { ...ADAPTIVE_ONLY, progressUpdates: true },
  },
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
    known: true,
    capabilities: { ...FIVE_X, progressUpdates: false },
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
    known: true,
    capabilities: {
      ...FIVE_X,
      progressUpdates: false,
      blockBinding: false,
      serverFallbacks: false,
    },
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
    known: true,
    capabilities: ADAPTIVE_ONLY,
  },
  {
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
    known: true,
    capabilities: ADAPTIVE_ONLY,
  },
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
    known: true,
    capabilities: FOUR_SIX,
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
    known: true,
    capabilities: FOUR_SIX,
  },
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    description: 'Fastest and cheapest; best for simple tasks.',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    // Prompts up to 100K tokens; longer prompts cost $0.50 / $2.50 per MTok.
    pricing: {
      inputPerMTok: 0.1,
      outputPerMTok: 0.5,
      cacheReadPerMTok: 0.01,
      cacheWritePerMTok: 0.125,
    },
    known: true,
    recommended: true,
    // Adaptive thinking (on by default) and effort; no progress notes or server-side fallbacks,
    // and the basic web tools (dynamic filtering is not offered on Haiku).
    capabilities: { ...ADAPTIVE_ONLY, webTools: 'basic' },
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
    known: true,
    capabilities: {
      adaptiveThinking: false,
      progressUpdates: false,
      blockBinding: false,
      effort: false,
      serverFallbacks: false,
      eagerInputStreaming: true,
      // Dynamic filtering needs Claude 4.6 or later.
      webTools: 'basic',
    },
  },
];

const UNKNOWN_CAPABILITIES: AnthropicModelCapabilities = {
  adaptiveThinking: false,
  progressUpdates: false,
  blockBinding: false,
  effort: false,
  serverFallbacks: false,
  eagerInputStreaming: true,
  webTools: false,
};

/**
 * Looks up a model. Unknown ids get conservative capabilities (no thinking/effort/beta params
 * and no web tools, so any valid model id still works, including ones served where the web
 * tools do not exist) with a 200k context window and `known: false`.
 * Lookup is exact on id; a Bedrock-style "anthropic." prefix is not supported.
 */
export function findAnthropicModel(id: string): AnthropicModelEntry {
  const entry = ANTHROPIC_MODELS.find((m) => m.id === id);
  if (entry) return entry;
  return {
    id,
    label: id,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    known: false,
    capabilities: UNKNOWN_CAPABILITIES,
  };
}

/**
 * The level to send for `effort` on a model that accepts only `supported`: the level itself
 * when accepted, else the nearest accepted level on the low→max scale, the lower one on a tie
 * (so 'xhigh' becomes 'high' on a model without it, never the costlier 'max').
 */
export function clampEffort(
  effort: AnthropicEffort,
  supported: readonly AnthropicEffort[] = EFFORT_LEVELS,
): AnthropicEffort {
  if (supported.length === 0 || supported.includes(effort)) return effort;
  const rank = EFFORT_LEVELS.indexOf(effort);
  let best = supported[0] ?? effort;
  for (const level of supported) {
    const distance = Math.abs(EFFORT_LEVELS.indexOf(level) - rank);
    const bestDistance = Math.abs(EFFORT_LEVELS.indexOf(best) - rank);
    const lower = EFFORT_LEVELS.indexOf(level) < EFFORT_LEVELS.indexOf(best);
    if (distance < bestDistance || (distance === bestDistance && lower)) best = level;
  }
  return best;
}
