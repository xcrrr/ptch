import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_MODELS,
  clampEffort,
  DEFAULT_ANTHROPIC_MODEL,
  EFFORT_LEVELS,
  findAnthropicModel,
} from '../src/models.js';
import { AnthropicProvider, hasAnthropicCredentials } from '../src/provider.js';

describe('model catalog', () => {
  const provider = new AnthropicProvider();

  it('describes the default model', () => {
    expect(DEFAULT_ANTHROPIC_MODEL).toBe('claude-opus-5-5');
    expect(provider.getModelInfo(DEFAULT_ANTHROPIC_MODEL)).toEqual({
      id: 'claude-opus-5-5',
      label: 'Claude Opus 5.5',
      description: 'Default. Strongest Opus for long-horizon agentic coding.',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: {
        inputPerMTok: 4,
        outputPerMTok: 20,
        cacheReadPerMTok: 0.2,
        cacheWritePerMTok: 5,
        webSearchPerRequest: 0.01,
      },
      known: true,
      hostedTools: ['web_search', 'web_fetch'],
    });
  });

  it('offers the dynamic-filtering web tools to Opus, Sonnet and Fable, the basic ones to Haiku', () => {
    for (const model of ANTHROPIC_MODELS) {
      const expected = model.id.startsWith('claude-haiku-') ? 'basic' : 'dynamic';
      expect([model.id, model.capabilities.webTools]).toEqual([model.id, expected]);
    }
    expect(provider.getModelInfo('claude-haiku-4-5').hostedTools).toEqual([
      'web_search',
      'web_fetch',
    ]);
  });

  it('gives unknown models conservative defaults', () => {
    expect(provider.getModelInfo('claude-next-preview')).toEqual({
      id: 'claude-next-preview',
      label: 'claude-next-preview',
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      known: false,
    });
    expect(findAnthropicModel('claude-next-preview').capabilities).toMatchObject({
      adaptiveThinking: false,
      effort: false,
      serverFallbacks: false,
      webTools: false,
    });
  });

  it.each([
    ['claude-fable-5', 10, 50],
    ['claude-opus-4-7', 5, 25],
    ['claude-opus-4-6', 5, 25],
    ['claude-sonnet-4-6', 3, 15],
  ])('knows %s: 1M context, 128K output, adaptive thinking and effort', (id, input, output) => {
    expect(provider.getModelInfo(id)).toMatchObject({
      id,
      known: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: { inputPerMTok: input, outputPerMTok: output },
    });
    expect(findAnthropicModel(id).capabilities).toMatchObject({
      adaptiveThinking: true,
      effort: true,
    });
  });

  it('offers no xhigh effort on the 4.6 models only', () => {
    for (const id of ['claude-opus-4-6', 'claude-sonnet-4-6']) {
      expect(findAnthropicModel(id).capabilities.effortLevels).toEqual([
        'low',
        'medium',
        'high',
        'max',
      ]);
    }
    for (const id of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-fable-5']) {
      expect(findAnthropicModel(id).capabilities.effortLevels ?? EFFORT_LEVELS).toContain('xhigh');
    }
  });

  it('has one entry per model id', () => {
    const ids = ANTHROPIC_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not treat provider-prefixed ids as known', () => {
    expect(provider.getModelInfo('anthropic.claude-opus-5-5').known).toBe(false);
  });

  it('lists the recommended models without internal capability data', () => {
    const listed = provider.listModels();
    expect(listed.map((m) => m.id)).toEqual(
      ANTHROPIC_MODELS.filter((m) => m.recommended).map((m) => m.id),
    );
    expect(listed[0]?.id).toBe(DEFAULT_ANTHROPIC_MODEL);
    for (const model of listed) {
      expect(model).not.toHaveProperty('capabilities');
      expect(model).not.toHaveProperty('recommended');
      expect(model.known).toBe(true);
    }
  });

  it('offers Claude Haiku 5.5 with adaptive thinking and effort but no beta features', () => {
    const ids = provider.listModels().map((m) => m.id);
    expect(ids).toContain('claude-haiku-5-5');
    expect(provider.getModelInfo('claude-haiku-5-5')).toMatchObject({
      known: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
    });
    expect(findAnthropicModel('claude-haiku-5-5').capabilities).toMatchObject({
      adaptiveThinking: true,
      effort: true,
      progressUpdates: false,
      serverFallbacks: false,
    });
  });

  it('still knows Claude Haiku 4.5, with its 200K context and no thinking or effort', () => {
    const ids = provider.listModels().map((m) => m.id);
    expect(ids).not.toContain('claude-haiku-4-5');
    expect(provider.getModelInfo('claude-haiku-4-5')).toMatchObject({
      known: true,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    });
    expect(findAnthropicModel('claude-haiku-4-5').capabilities).toMatchObject({
      adaptiveThinking: false,
      effort: false,
    });
  });

  it('returns copies that callers cannot use to modify the catalog', () => {
    const info = provider.getModelInfo('claude-opus-5-5');
    info.contextWindow = 1;
    if (info.pricing) info.pricing.inputPerMTok = 999;
    const fresh = provider.getModelInfo('claude-opus-5-5');
    expect(fresh.contextWindow).toBe(1_000_000);
    expect(fresh.pricing?.inputPerMTok).toBe(4);
  });

  it('detects configured credentials', () => {
    expect(hasAnthropicCredentials({})).toBe(false);
    expect(hasAnthropicCredentials({ apiKey: '' })).toBe(false);
    expect(hasAnthropicCredentials({ apiKey: 'sk-test' })).toBe(true);
    expect(hasAnthropicCredentials({ authToken: 'token' })).toBe(true);
  });

  it('identifies itself', () => {
    expect(provider.id).toBe('anthropic');
    expect(provider.displayName).toBe('Anthropic');
  });
});

describe('clampEffort', () => {
  it('keeps a supported level', () => {
    for (const level of EFFORT_LEVELS) expect(clampEffort(level)).toBe(level);
    expect(clampEffort('max', ['low', 'medium', 'high', 'max'])).toBe('max');
  });

  it('clamps to the nearest supported level, preferring the lower one on a tie', () => {
    expect(clampEffort('xhigh', ['low', 'medium', 'high', 'max'])).toBe('high');
    expect(clampEffort('max', ['low', 'medium', 'high'])).toBe('high');
    expect(clampEffort('low', ['high', 'max'])).toBe('high');
    expect(clampEffort('medium', ['low', 'max'])).toBe('low');
  });
});
