/**
 * Smoke tests against the real Anthropic API. Run with:
 *   PATCH_INTEGRATION=1 ANTHROPIC_API_KEY=... pnpm test:integration
 */
import {
  textOf,
  type Message,
  type ModelEvent,
  type ModelRequest,
  type ToolSpec,
} from '@patch/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ANTHROPIC_MODEL } from '../src/models.js';
import { AnthropicProvider } from '../src/provider.js';

const enabled =
  Boolean(process.env['ANTHROPIC_API_KEY']) && process.env['PATCH_INTEGRATION'] === '1';

const WEATHER_TOOL: ToolSpec = {
  name: 'get_weather',
  description: 'Returns the current weather for a city.',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
};

function provider(): AnthropicProvider {
  return new AnthropicProvider({ apiKey: process.env['ANTHROPIC_API_KEY'], effort: 'low' });
}

function request(messages: Message[], overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: process.env['PATCH_INTEGRATION_MODEL'] ?? DEFAULT_ANTHROPIC_MODEL,
    system: 'You are a terse assistant used in automated tests. Follow instructions exactly.',
    messages,
    tools: [],
    maxOutputTokens: 4_000,
    ...overrides,
  };
}

async function finish(stream: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  const end = events.at(-1);
  if (end?.type !== 'message_end') throw new Error('stream did not end with message_end');
  return { events, end };
}

describe.skipIf(!enabled)('AnthropicProvider against the real API', () => {
  it('streams a simple text reply', async () => {
    const { events, end } = await finish(
      provider().stream(
        request([
          { role: 'user', content: [{ type: 'text', text: 'Reply with exactly the word: pong' }] },
        ]),
      ),
    );
    expect(events[0]?.type).toBe('message_start');
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(end.stopReason).toBe('end_turn');
    expect(textOf(end.message).toLowerCase()).toContain('pong');
    expect(
      end.usage.inputTokens + end.usage.cacheReadTokens + end.usage.cacheWriteTokens,
    ).toBeGreaterThan(0);
    expect(end.usage.outputTokens).toBeGreaterThan(0);
  });

  it('completes a tool round trip, replaying thinking blocks', async () => {
    const anthropic = provider();
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is the weather in Paris? Use the get_weather tool.' },
        ],
      },
    ];
    const first = await finish(anthropic.stream(request(messages, { tools: [WEATHER_TOOL] })));
    expect(first.end.stopReason).toBe('tool_use');
    const call = first.end.message.content.find((b) => b.type === 'tool_call');
    expect(call).toMatchObject({ type: 'tool_call', name: 'get_weather' });
    if (call?.type !== 'tool_call') throw new Error('no tool call');
    expect(call.inputError).toBeUndefined();
    expect(String(call.input['city'])).toMatch(/paris/i);

    messages.push(first.end.message, {
      role: 'user',
      content: [{ type: 'tool_result', toolCallId: call.id, content: 'Sunny, 21°C' }],
    });
    const second = await finish(anthropic.stream(request(messages, { tools: [WEATHER_TOOL] })));
    expect(second.end.stopReason).toBe('end_turn');
    expect(textOf(second.end.message)).toMatch(/21/);
  });

  it('aborts promptly', async () => {
    const controller = new AbortController();
    const stream = provider().stream(
      request(
        [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Count from 1 to 500, one number per line.' }],
          },
        ],
        { signal: controller.signal },
      ),
    );
    let abortedAt = 0;
    await expect(
      (async () => {
        for await (const event of stream) {
          if (event.type === 'text_delta' && abortedAt === 0) {
            abortedAt = Date.now();
            controller.abort();
          }
        }
      })(),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(abortedAt).toBeGreaterThan(0);
    expect(Date.now() - abortedAt).toBeLessThan(2_000);
  });
});
