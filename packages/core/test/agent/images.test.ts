import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProviderError, type ImageBlock, type Message } from '@patch/shared';
import { Agent } from '../../src/agent/agent.js';
import { renderTranscript } from '../../src/agent/compaction.js';
import { COMPACTION_SUMMARY_PREFIX } from '../../src/session/schema.js';
import { ScriptedProvider, pngBytes, textResponse, toolResponse } from '../../src/testing/index.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { defineTool } from '../../src/tools/types.js';
import {
  FakePermissions,
  MemorySession,
  agentRequests,
  createHarness,
  createToolContext,
  expectAppendOnly,
  expectValidHistory,
} from './helpers.js';

const IMAGE: ImageBlock = {
  type: 'image',
  mediaType: 'image/png',
  data: pngBytes(4, 3).toString('base64'),
  label: 'shot.png',
};

const NOTE = 'A note sent with the turn.';

const tooLong = () =>
  new ProviderError('context_length', 'prompt is too long', { provider: 'anthropic', status: 400 });

function withImage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text: NOTE }, IMAGE, { type: 'text', text }] };
}

function run(agent: Agent, text: string, images?: ImageBlock[]) {
  return agent.runTurn(
    { text, notes: [NOTE], ...(images ? { images } : {}) },
    {
      signal: new AbortController().signal,
      onEvent: () => {},
      requestPermission: async () => ({ decision: 'deny' }),
    },
  );
}

describe('images in user turns', () => {
  it('go after the notes and before the text, in the same user message', async () => {
    const harness = createHarness([textResponse('A small black image.')]);
    const result = await run(harness.agent, 'What is in [Image #1]?', [IMAGE]);

    expect(result.status).toBe('completed');
    expect(agentRequests(harness.provider)[0]!.messages).toEqual([
      withImage('What is in [Image #1]?'),
    ]);
    // Stored as sent (through a JSON round trip), label included.
    expect(harness.session.messages()[0]).toEqual(withImage('What is in [Image #1]?'));
  });

  it('are sent again with the text when the request overflows and the turn compacts', async () => {
    const harness = createHarness(
      [textResponse('a'), { error: tooLong() }, textResponse('summary'), textResponse('b')],
      { modelInfo: { contextWindow: 1_000 } },
    );
    await run(harness.agent, 'one');
    const result = await run(harness.agent, 'look', [IMAGE]);

    expect(result.status).toBe('completed');
    const [, overflowed, retried] = agentRequests(harness.provider);
    expect(overflowed!.messages.at(-1)).toEqual(withImage('look'));
    expect(retried!.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: `${COMPACTION_SUMMARY_PREFIX}\n\nsummary` }],
      },
      withImage('look'),
    ]);
  });
});

describe('images in tool results', () => {
  it('are returned to the model with the result text and stored with it', async () => {
    const screenshot = defineTool({
      name: 'screenshot',
      description: 'Takes a screenshot.',
      inputSchema: z.object({}),
      permissionClass: 'read',
      summarize: () => ({ verb: 'shot', target: 'screen' }),
      permission: () => ({ kind: 'read', paths: [] }),
      execute: async () => ({
        content: 'Image: screen (4×3, 70 B)',
        images: [IMAGE],
        display: { summary: 'image 4×3' },
      }),
    });
    const provider = new ScriptedProvider([
      toolResponse([{ id: 'c1', name: 'screenshot', input: {} }]),
      textResponse('It is black.'),
    ]);
    const session = new MemorySession();
    const agent = new Agent({
      provider,
      session,
      tools: new ToolRegistry([screenshot]),
      permissions: new FakePermissions(),
      toolContext: createToolContext(),
    });

    const result = await run(agent, 'Take a screenshot.');

    expect(result.status).toBe('completed');
    const requests = agentRequests(provider);
    expect(requests[1]!.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolCallId: 'c1',
          content: 'Image: screen (4×3, 70 B)',
          images: [IMAGE],
        },
      ],
    });
    expectValidHistory(requests[1]!.messages);
    expectAppendOnly(requests);
    // The UI record keeps the display only, never the image data.
    expect(session.ofType('tool')[0]).toMatchObject({ display: { summary: 'image 4×3' } });
    expect(JSON.stringify(session.ofType('tool'))).not.toContain(IMAGE.data);
  });
});

describe('images in compaction transcripts', () => {
  it('are replaced by a placeholder', () => {
    const transcript = renderTranscript([
      withImage('compare these'),
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.png' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'c1', content: 'Image: a.png', images: [IMAGE] },
        ],
      },
    ]);
    expect(transcript).toContain('[image]\ncompare these');
    expect(transcript).toContain('[tool result] Image: a.png [image]');
    expect(transcript).not.toContain(IMAGE.data);
    expect(transcript).not.toContain('shot.png');
  });

  it('sit next to web searches and cited text', () => {
    const transcript = renderTranscript([
      withImage('find the guide for this'),
      {
        role: 'assistant',
        content: [
          {
            type: 'provider',
            provider: 'anthropic',
            kind: 'server_tool_use',
            data: { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} },
            hostedTool: { phase: 'call', id: 's1', kind: 'web_search', detail: 'banner guide' },
          },
          {
            type: 'provider',
            provider: 'anthropic',
            kind: 'web_search_tool_result',
            data: { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
            hostedTool: {
              phase: 'result',
              id: 's1',
              kind: 'web_search',
              summary: '3 results',
              isError: false,
            },
          },
          {
            type: 'text',
            text: 'It follows the guide.',
            providerData: { provider: 'anthropic', data: { citations: [] } },
          },
        ],
      },
    ]);
    expect(transcript).toBe(
      [
        `User:\n${NOTE}\n[image]\nfind the guide for this`,
        'Patch:\n[web search: banner guide]\n[web search result] 3 results\nIt follows the guide.',
      ].join('\n\n'),
    );
  });
});
