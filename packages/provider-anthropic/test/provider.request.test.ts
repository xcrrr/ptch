import type { Message } from '@patch/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/provider.js';
import {
  closeServers,
  collect,
  lastBody,
  makeProvider,
  makeRequest,
  READ_FILE_TOOL,
  startServer,
  userText,
} from './helpers.js';

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeServers();
});

const ALL_BETAS = [
  'thinking-display-updates-2026-08-18',
  'thinking-binding-controls-2026-08-01',
  'server-side-fallback-2026-07-01',
];

const SAMPLING_AND_FORCING = ['temperature', 'top_p', 'top_k', 'tool_choice'];

describe('AnthropicProvider request shape', () => {
  it('sends the full feature set for claude-opus-5-5', async () => {
    const server = await startServer();
    await collect(makeProvider(server).stream(makeRequest()));

    const body = lastBody(server);
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 64_000,
      stream: true,
      cache_control: { type: 'ephemeral' },
      system: [
        {
          type: 'text',
          text: 'You are Patch, a coding agent.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      thinking: {
        type: 'adaptive',
        display: 'updates',
        block_binding: { prefix_mismatch_behavior: 'drop_block' },
      },
      output_config: { effort: 'high' },
      fallbacks: 'default',
      tools: [
        {
          name: 'read_file',
          description: 'Read a file from the workspace.',
          input_schema: READ_FILE_TOOL.inputSchema,
          eager_input_streaming: true,
        },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello there' }] }],
    });
    for (const key of SAMPLING_AND_FORCING) expect(body).not.toHaveProperty(key);
    expect(server.requests[0]?.betas).toEqual(ALL_BETAS);
    expect(server.violations).toEqual([]);
  });

  it('sends only plain parameters for claude-haiku-4-5', async () => {
    const server = await startServer();
    await collect(makeProvider(server).stream(makeRequest({ model: 'claude-haiku-4-5' })));

    const body = lastBody(server);
    expect(body).toMatchObject({ model: 'claude-haiku-4-5', max_tokens: 64_000 });
    for (const key of ['thinking', 'output_config', 'fallbacks', ...SAMPLING_AND_FORCING]) {
      expect(body).not.toHaveProperty(key);
    }
    expect((body['tools'] as Array<Record<string, unknown>>)[0]).toHaveProperty(
      'eager_input_streaming',
      true,
    );
    expect(server.requests[0]?.headers['anthropic-beta']).toBeUndefined();
  });

  it('sends conservative parameters for an unknown model id', async () => {
    const server = await startServer();
    await collect(makeProvider(server).stream(makeRequest({ model: 'claude-experimental-x' })));

    const body = lastBody(server);
    expect(body['max_tokens']).toBe(32_000);
    for (const key of ['thinking', 'output_config', 'fallbacks', ...SAMPLING_AND_FORCING]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(server.requests[0]?.betas).toEqual([]);
  });

  it('sends adaptive thinking and effort but no beta features for claude-sonnet-5', async () => {
    const server = await startServer();
    await collect(makeProvider(server).stream(makeRequest({ model: 'claude-sonnet-5' })));
    expect(lastBody(server)['thinking']).toEqual({ type: 'adaptive' });
    expect(lastBody(server)).not.toHaveProperty('fallbacks');
    expect(lastBody(server)['output_config']).toEqual({ effort: 'high' });
    expect(server.requests[0]?.betas).toEqual([]);
  });

  it('uses the configured effort, and low effort for summaries', async () => {
    const server = await startServer();
    const provider = makeProvider(server, { effort: 'xhigh' });
    await collect(provider.stream(makeRequest()));
    expect(lastBody(server)['output_config']).toEqual({ effort: 'xhigh' });
    await collect(provider.stream(makeRequest({ purpose: 'summary', tools: [] })));
    expect(lastBody(server)['output_config']).toEqual({ effort: 'low' });
  });

  it.each(['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6'])(
    'sends explicit adaptive thinking and effort, without beta features, for %s',
    async (model) => {
      const server = await startServer();
      await collect(makeProvider(server).stream(makeRequest({ model })));
      const body = lastBody(server);
      expect(body).toMatchObject({ model, max_tokens: 64_000 });
      expect(body['thinking']).toEqual({ type: 'adaptive' });
      expect(body['output_config']).toEqual({ effort: 'high' });
      expect(body).not.toHaveProperty('fallbacks');
      expect(server.requests[0]?.betas).toEqual([]);
    },
  );

  it('requests progress updates but no fallbacks for claude-fable-5', async () => {
    const server = await startServer();
    await collect(makeProvider(server).stream(makeRequest({ model: 'claude-fable-5' })));
    expect(lastBody(server)['thinking']).toEqual({ type: 'adaptive', display: 'updates' });
    expect(lastBody(server)).not.toHaveProperty('fallbacks');
    expect(server.requests[0]?.betas).toEqual(['thinking-display-updates-2026-08-18']);
  });

  it('clamps xhigh effort to high on models whose effort scale lacks it', async () => {
    const server = await startServer();
    const provider = makeProvider(server, { effort: 'xhigh' });
    for (const model of ['claude-opus-4-6', 'claude-sonnet-4-6']) {
      await collect(provider.stream(makeRequest({ model })));
      expect(lastBody(server)['output_config'], model).toEqual({ effort: 'high' });
    }
    await collect(provider.stream(makeRequest({ model: 'claude-opus-4-7' })));
    expect(lastBody(server)['output_config']).toEqual({ effort: 'xhigh' });
  });

  it('omits fallbacks and their beta when disabled by option', async () => {
    const server = await startServer();
    await collect(makeProvider(server, { fallbacks: false }).stream(makeRequest()));
    expect(lastBody(server)).not.toHaveProperty('fallbacks');
    expect(server.requests[0]?.betas).toEqual(ALL_BETAS.slice(0, 2));
  });

  it('honours maxOutputTokens', async () => {
    const server = await startServer();
    await collect(makeProvider(server).stream(makeRequest({ maxOutputTokens: 1234 })));
    expect(lastBody(server)['max_tokens']).toBe(1234);
  });

  it('maps conversation blocks and drops what the API cannot accept', async () => {
    const server = await startServer();
    const messages: Message[] = [
      userText('Read a.ts'),
      {
        role: 'assistant',
        content: [
          { type: 'provider', provider: 'other-vendor', kind: 'reasoning', data: { opaque: true } },
          { type: 'text', text: '' },
          { type: 'tool_call', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'toolu_1', content: 'ENOENT', isError: true }],
      },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
      { role: 'user', content: [{ type: 'text', text: 'Try b.ts' }] },
    ];
    await collect(makeProvider(server).stream(makeRequest({ messages })));

    expect(lastBody(server)['messages']).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Read a.ts' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ENOENT', is_error: true },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Try b.ts' }] },
    ]);
    expect(server.violations).toEqual([]);
  });

  it('echoes a tool call whose input failed to parse with an empty input object', async () => {
    const server = await startServer();
    const messages: Message[] = [
      userText('Read it'),
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            id: 'toolu_bad',
            name: 'read_file',
            input: {},
            inputError: 'The tool input is not valid JSON (Unexpected end of JSON input).',
            rawInput: '{"path":',
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'toolu_bad', content: 'Invalid input', isError: true },
        ],
      },
    ];
    await collect(makeProvider(server).stream(makeRequest({ messages })));
    const sent = lastBody(server)['messages'] as Array<{ content: unknown[] }>;
    expect(sent[1]?.content).toEqual([
      { type: 'tool_use', id: 'toolu_bad', name: 'read_file', input: {} },
    ]);
  });

  it('omits an empty system prompt and an empty tool list', async () => {
    const server = await startServer();
    await collect(makeProvider(server).stream(makeRequest({ system: '', tools: [] })));
    const body = lastBody(server);
    expect(body).not.toHaveProperty('system');
    expect(body).not.toHaveProperty('tools');
    expect(body['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('sends the API key as x-api-key', async () => {
    const server = await startServer();
    await collect(makeProvider(server).stream(makeRequest()));
    expect(server.requests[0]?.headers['x-api-key']).toBe('test-key');
    expect(server.requests[0]?.headers['authorization']).toBeUndefined();
    expect(server.requests[0]?.headers['anthropic-version']).toBeTruthy();
    expect(server.requests[0]?.headers['anthropic-workspace-id']).toBeUndefined();
  });

  it('names the workspace for keys that belong to a whole organization', async () => {
    const server = await startServer();
    const provider = makeProvider(server, { workspaceId: 'wrkspc_01AbC' });
    await collect(provider.stream(makeRequest()));
    expect(server.requests[0]?.headers['anthropic-workspace-id']).toBe('wrkspc_01AbC');
  });

  it('sends an auth token as a bearer token and ignores ANTHROPIC_* environment variables', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key-must-not-be-used');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:9');
    const server = await startServer();
    const provider = new AnthropicProvider({
      authToken: 'token-123',
      baseUrl: server.url,
      maxRetries: 0,
    });
    await collect(provider.stream(makeRequest()));
    expect(server.requests[0]?.headers['authorization']).toBe('Bearer token-123');
    expect(server.requests[0]?.headers['x-api-key']).toBeUndefined();
  });
});
