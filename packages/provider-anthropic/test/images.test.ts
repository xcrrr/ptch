import type { HostedTool, ImageBlock, Message } from '@patch/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { MockAnthropicServer } from '../src/testing/mock-server.js';
import {
  closeServers,
  collect,
  continueWith,
  lastBody,
  makeProvider,
  makeRequest,
  startServer,
  userText,
} from './helpers.js';

afterEach(closeServers);

/** A 1×1 PNG. */
const PNG_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
/** The start of a JPEG (SOI and a JFIF APP0 marker). */
const JPEG_DATA = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==';

const IMAGE: ImageBlock = {
  type: 'image',
  mediaType: 'image/png',
  data: PNG_DATA,
  label: 'screenshot.png',
};

const WIRE_IMAGE = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: PNG_DATA },
};

describe('image request mapping', () => {
  it('sends user images as base64 image blocks without their labels', async () => {
    const server = await startServer();
    const messages: Message[] = [
      { role: 'user', content: [IMAGE, { type: 'text', text: 'What is in [Image #1]?' }] },
    ];
    await collect(makeProvider(server).stream(makeRequest({ messages })));

    expect(lastBody(server)['messages']).toEqual([
      { role: 'user', content: [WIRE_IMAGE, { type: 'text', text: 'What is in [Image #1]?' }] },
    ]);
    expect(JSON.stringify(lastBody(server))).not.toContain('screenshot.png');
    expect(server.violations).toEqual([]);
  });

  it('sends a tool result with images as text and image content, and keeps caching', async () => {
    const server = await startServer();
    const messages: Message[] = [
      userText('Look at the screenshot.'),
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 'toolu_1', name: 'read_file', input: { path: 'a.png' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'toolu_1',
            content: 'Image: a.png (1×1, 70 B)',
            images: [IMAGE],
          },
        ],
      },
    ];
    await collect(makeProvider(server).stream(makeRequest({ messages })));

    const body = lastBody(server);
    expect((body['messages'] as unknown[]).at(-1)).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'text', text: 'Image: a.png (1×1, 70 B)' }, WIRE_IMAGE],
        },
      ],
    });
    expect(body['cache_control']).toEqual({ type: 'ephemeral' });
    expect(server.violations).toEqual([]);
  });

  it('leaves out an empty result text and keeps results without images as strings', async () => {
    const server = await startServer();
    const messages: Message[] = [
      userText('Two reads.'),
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 'toolu_1', name: 'read_file', input: { path: 'a.png' } },
          { type: 'tool_call', id: 'toolu_2', name: 'read_file', input: { path: 'b.txt' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'toolu_1', content: '', images: [IMAGE] },
          { type: 'tool_result', toolCallId: 'toolu_2', content: 'text', images: [] },
        ],
      },
    ];
    await collect(makeProvider(server).stream(makeRequest({ messages })));

    expect((lastBody(server)['messages'] as unknown[]).at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: [WIRE_IMAGE] },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'text' },
      ],
    });
    expect(server.violations).toEqual([]);
  });
});

describe('images alongside web tools', () => {
  const WEB_TOOLS: HostedTool[] = [{ kind: 'web_search' }, { kind: 'web_fetch' }];
  const withImage = (text: string): Message => ({
    role: 'user',
    content: [IMAGE, { type: 'text', text }],
  });

  it('keeps searches, citations and images in one append-only conversation', async () => {
    const server = await startServer();
    server.enqueue({
      content: [
        { type: 'server_tool_use', name: 'web_search', input: { query: 'error banner design' } },
        { type: 'web_search_tool_result', results: [{ url: 'https://a.dev/ui', title: 'UI' }] },
        {
          type: 'text',
          text: 'The banner follows the guide.',
          citations: [{ url: 'https://a.dev/ui', title: 'UI', cited_text: 'Banners go on top.' }],
        },
      ],
    });
    const provider = makeProvider(server);
    const request = makeRequest({
      messages: [withImage('Does [Image #1] follow the guide?')],
      hostedTools: WEB_TOOLS,
    });
    const { end } = await collect(provider.stream(request));

    server.enqueue({ content: [{ type: 'text', text: 'Yes, this one too.' }] });
    await collect(provider.stream(continueWith(request, end.message, withImage('And this?'))));

    const sent = lastBody(server)['messages'] as Array<{ role: string; content: unknown[] }>;
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(sent[0]!.content[0]).toEqual(WIRE_IMAGE);
    expect(sent[1]!.content.map((b) => (b as Body)['type'])).toEqual([
      'server_tool_use',
      'web_search_tool_result',
      'text',
    ]);
    expect(sent[1]!.content[2]).toMatchObject({ citations: [{ url: 'https://a.dev/ui' }] });
    expect(sent[2]!.content).toEqual([WIRE_IMAGE, { type: 'text', text: 'And this?' }]);
    expect(server.violations).toEqual([]);
  });

  it('answers a paused search before a new prompt that starts with an image', async () => {
    const server = await startServer();
    server.enqueue({
      content: [{ type: 'server_tool_use', name: 'web_search', input: { query: 'q' } }],
      stop_reason: 'pause_turn',
    });
    const provider = makeProvider(server);
    const request = makeRequest({ hostedTools: WEB_TOOLS });
    const { end } = await collect(provider.stream(request));

    server.enqueue({ content: [{ type: 'text', text: 'Looking at it instead.' }] });
    await collect(provider.stream(continueWith(request, end.message, withImage('Look at this.'))));
    const sent = lastBody(server)['messages'] as Array<{ role: string; content: unknown[] }>;
    expect(sent[1]?.content.at(-1)).toMatchObject({
      type: 'web_search_tool_result',
      content: { type: 'web_search_tool_result_error', error_code: 'unavailable' },
    });
    expect(sent[2]?.content[0]).toEqual(WIRE_IMAGE);
    expect(server.violations).toEqual([]);
  });
});

type Body = Record<string, unknown>;

async function postMessages(server: MockAnthropicServer, messages: unknown[], tools?: unknown[]) {
  const response = await fetch(`${server.url}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-5-5',
      max_tokens: 1024,
      messages,
      ...(tools ? { tools } : {}),
    }),
  });
  const json = JSON.parse(await response.text()) as Body;
  return {
    status: response.status,
    message: String((json['error'] as Body | undefined)?.['message']),
  };
}

function imageWith(source: Body, extra: Body = {}): Body {
  return { type: 'image', source: { type: 'base64', ...source }, ...extra };
}

describe('mock server image conformance', () => {
  const user = (...content: unknown[]) => [{ role: 'user', content }];
  const text = { type: 'text', text: 'What is this?' };

  const invalid: Array<[string, unknown[], RegExp]> = [
    [
      'an unsupported media type',
      user(imageWith({ media_type: 'image/bmp', data: PNG_DATA }), text),
      /^messages\.0\.content\.0\.source\.media_type: Input should be/,
    ],
    [
      'invalid base64',
      user(imageWith({ media_type: 'image/png', data: 'not base64!' }), text),
      /source\.data: Image data is not valid base64\./,
    ],
    [
      'missing data',
      user(imageWith({ media_type: 'image/png' }), text),
      /source\.data: Field required/,
    ],
    [
      'data in another format than declared',
      user(imageWith({ media_type: 'image/png', data: JPEG_DATA }), text),
      /specified using the image\/png media type, but the data is not a valid image\/png image/,
    ],
    [
      'an image over 5 MB',
      user(
        imageWith({
          media_type: 'image/png',
          data: 'iVBORw0KGgoA'.padEnd(5 * 1024 * 1024 + 4, 'A'),
        }),
        text,
      ),
      /image exceeds 5 MB maximum: 5242884 bytes > 5242880 bytes/,
    ],
    [
      'a field the API does not define (a leaked label)',
      user(imageWith({ media_type: 'image/png', data: PNG_DATA }, { label: 'a.png' }), text),
      /^messages\.0\.content\.0\.label: Extra inputs are not permitted/,
    ],
    [
      'an image in an assistant message',
      [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: [imageWith({ media_type: 'image/png', data: PNG_DATA })] },
      ],
      /^messages\.1\.content\.0: Image blocks are only allowed in user messages\./,
    ],
  ];

  it.each(invalid)('rejects %s', async (_name, messages, expected) => {
    const server = await startServer();
    const { status, message } = await postMessages(server, messages);
    expect(status).toBe(400);
    expect(message).toMatch(expected);
    expect(server.violations.length).toBeGreaterThan(0);
  });

  it('checks images inside tool results', async () => {
    const server = await startServer();
    const tools = [{ name: 'read_file', description: 'Read', input_schema: { type: 'object' } }];
    const call = { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} };
    const conversation = (content: unknown[]) => [
      { role: 'user', content: 'Read it' },
      { role: 'assistant', content: [call] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] },
    ];

    const ok = await postMessages(
      server,
      conversation([
        { type: 'text', text: 'Image: a.png' },
        imageWith({ media_type: 'image/png', data: PNG_DATA }),
      ]),
      tools,
    );
    expect(ok.status).toBe(200);
    expect(server.violations).toEqual([]);

    const bad = await postMessages(
      server,
      conversation([imageWith({ media_type: 'image/gif', data: PNG_DATA })]),
      tools,
    );
    expect(bad.status).toBe(400);
    expect(bad.message).toMatch(/^messages\.2\.content\.0\.content\.0\.source\.base64: /);
  });

  it('accepts every supported format', async () => {
    const server = await startServer();
    const samples: Array<[string, string]> = [
      ['image/png', PNG_DATA],
      ['image/jpeg', JPEG_DATA],
      ['image/gif', Buffer.from('GIF89a\x01\x00\x01\x00').toString('base64')],
      ['image/webp', Buffer.from('RIFF\x1a\x00\x00\x00WEBPVP8X').toString('base64')],
    ];
    for (const [mediaType, data] of samples) {
      const { status } = await postMessages(
        server,
        user(imageWith({ media_type: mediaType, data }), text),
      );
      expect(status, mediaType).toBe(200);
    }
    expect(server.violations).toEqual([]);
  });
});
