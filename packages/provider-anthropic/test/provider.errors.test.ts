import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import { ProviderError, type ProviderErrorKind } from '@patch/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { toProviderError } from '../src/errors.js';
import { AnthropicProvider } from '../src/provider.js';
import {
  closeServers,
  collect,
  collectError,
  makeProvider,
  makeRequest,
  startServer,
} from './helpers.js';

afterEach(closeServers);

describe('AnthropicProvider HTTP error mapping', () => {
  const cases: Array<[number, string, string, ProviderErrorKind, boolean]> = [
    [401, 'authentication_error', 'invalid x-api-key', 'auth', false],
    [
      403,
      'permission_error',
      'Your API key does not have permission to use this model.',
      'permission',
      false,
    ],
    [404, 'not_found_error', 'model: claude-nope', 'not_found', false],
    [
      429,
      'rate_limit_error',
      'Number of request tokens has exceeded your rate limit.',
      'rate_limit',
      true,
    ],
    [529, 'overloaded_error', 'Overloaded', 'overloaded', true],
    [500, 'api_error', 'Internal server error', 'server', true],
    [503, 'api_error', 'Service unavailable', 'server', true],
    [408, 'timeout_error', 'Request timed out', 'timeout', true],
    [
      400,
      'invalid_request_error',
      'messages.1.content.0: unexpected block',
      'invalid_request',
      false,
    ],
    [
      400,
      'invalid_request_error',
      'prompt is too long: 1050000 tokens > 1000000 maximum',
      'context_length',
      false,
    ],
    [
      400,
      'invalid_request_error',
      'input length and `max_tokens` exceed context limit: 190000 + 64000 > 200000',
      'context_length',
      false,
    ],
    [
      400,
      'invalid_request_error',
      'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.',
      'workspace',
      false,
    ],
    [
      400,
      'invalid_request_error',
      'anthropic-workspace-id header must be a valid workspace ID.',
      'workspace',
      false,
    ],
    [
      400,
      'invalid_request_error',
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
      'billing',
      false,
    ],
    [
      413,
      'request_too_large',
      'Request exceeds the maximum allowed number of bytes.',
      'context_length',
      false,
    ],
  ];

  it.each(cases)('maps HTTP %i %s', async (status, type, message, kind, retryable) => {
    const server = await startServer();
    server.enqueue({ status, error: { type, message } });

    const { events, error } = await collectError(makeProvider(server).stream(makeRequest()));

    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind, retryable, status, provider: 'anthropic', message });
    expect(error.requestId).toMatch(/^req_mock_/);
    expect(error.cause).toBeUndefined();
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    ['rate_limit_error', 'rate_limit'],
    ['api_error', 'server'],
    ['authentication_error', 'auth'],
    ['invalid_request_error', 'invalid_request'],
  ] as const)('maps a mid-stream %s event', async (type, kind) => {
    const server = await startServer();
    server.enqueue({
      status: 500,
      error: { type, message: `mid-stream ${type}` },
      midStream: true,
    });
    const { events, error } = await collectError(makeProvider(server).stream(makeRequest()));
    expect(events.map((e) => e.type)).toEqual(['message_start']);
    expect(error).toMatchObject({ kind, message: `mid-stream ${type}`, status: undefined });
  });

  it('maps a mid-stream context-length error', async () => {
    const server = await startServer();
    server.enqueue({
      status: 400,
      error: {
        type: 'invalid_request_error',
        message: 'prompt is too long: 2000000 tokens > 1000000 maximum',
      },
      midStream: true,
    });
    const { error } = await collectError(makeProvider(server).stream(makeRequest()));
    expect(error.kind).toBe('context_length');
  });

  it('retries retryable errors inside the SDK when maxRetries allows', async () => {
    const server = await startServer();
    server.enqueue(
      {
        status: 529,
        error: { type: 'overloaded_error', message: 'Overloaded' },
        headers: { 'retry-after-ms': '10' },
      },
      {
        status: 500,
        error: { type: 'api_error', message: 'boom' },
        headers: { 'retry-after-ms': '10' },
      },
      { content: [{ type: 'text', text: 'recovered' }] },
    );
    const { end } = await collect(makeProvider(server, { maxRetries: 2 }).stream(makeRequest()));
    expect(end.message.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(server.requests).toHaveLength(3);
  });

  it('retries once with maxRetries 1 and then reports the error', async () => {
    const server = await startServer();
    const failure = {
      status: 500,
      error: { type: 'api_error', message: 'still broken' },
      headers: { 'retry-after-ms': '10' },
    };
    server.enqueue(failure, failure, { content: [{ type: 'text', text: 'too late' }] });
    const { error } = await collectError(
      makeProvider(server, { maxRetries: 1 }).stream(makeRequest()),
    );
    expect(error).toMatchObject({ kind: 'server', message: 'still broken' });
    expect(server.requests).toHaveLength(2);
  });

  it('does not retry non-retryable errors', async () => {
    const server = await startServer();
    server.enqueue({ status: 401, error: { type: 'authentication_error', message: 'bad key' } });
    const { error } = await collectError(
      makeProvider(server, { maxRetries: 3 }).stream(makeRequest()),
    );
    expect(error.kind).toBe('auth');
    expect(server.requests).toHaveLength(1);
  });
});

describe('AnthropicProvider transport failures', () => {
  const rawServers: Server[] = [];
  afterEach(async () => {
    for (const server of rawServers.splice(0)) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  async function rawServer(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    rawServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('maps a refused connection to network', async () => {
    const server = await startServer();
    const url = server.url;
    await server.close();
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: url, maxRetries: 0 });
    const { error } = await collectError(provider.stream(makeRequest()));
    expect(error).toMatchObject({ kind: 'network', retryable: true });
    expect(error.message).toMatch(/^Connection failed( \([A-Z_]+\))?\.$/);
  });

  it('maps a request timeout to timeout', async () => {
    const url = await rawServer(() => {
      // Never answers.
    });
    const provider = new AnthropicProvider({
      apiKey: 'k',
      baseUrl: url,
      maxRetries: 0,
      timeoutMs: 200,
    });
    const { error } = await collectError(provider.stream(makeRequest()));
    expect(error).toMatchObject({ kind: 'timeout', retryable: true });
  });

  it('maps a connection dropped mid-stream to network', async () => {
    const url = await rawServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const start = {
        type: 'message_start',
        message: {
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      res.write(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`);
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: url, maxRetries: 0 });
    const { events, error } = await collectError(provider.stream(makeRequest()));
    expect(events.map((e) => e.type)).toEqual(['message_start']);
    expect(error).toMatchObject({ kind: 'network', retryable: true });
  });

  it('reports a stream that ends without message_stop', async () => {
    const url = await rawServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const start = {
        type: 'message_start',
        message: {
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      res.end(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`);
    });
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: url, maxRetries: 0 });
    const { error } = await collectError(provider.stream(makeRequest()));
    expect(error).toMatchObject({
      kind: 'network',
      message: 'The response stream ended before the message was complete.',
    });
  });
});

describe('toProviderError', () => {
  it('passes ProviderErrors through unchanged', () => {
    const original = new ProviderError('rate_limit', 'x', { provider: 'anthropic' });
    expect(toProviderError(original)).toBe(original);
  });

  it('maps aborts from any source', () => {
    expect(toProviderError(new APIUserAbortError()).kind).toBe('aborted');
    expect(toProviderError(Object.assign(new Error('x'), { name: 'AbortError' })).kind).toBe(
      'aborted',
    );
    const controller = new AbortController();
    controller.abort();
    expect(toProviderError(new Error('anything'), controller.signal).kind).toBe('aborted');
  });

  it('includes the system error code of a connection failure', () => {
    const cause = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    expect(toProviderError(new APIConnectionError({ cause })).message).toBe(
      'Connection failed (ECONNREFUSED).',
    );
  });

  it('maps an API error without a body by its status', () => {
    const error = new APIError(502, undefined, undefined, new Headers());
    expect(toProviderError(error)).toMatchObject({
      kind: 'server',
      message: 'The API returned an internal error.',
    });
  });

  it('maps a missing-credentials error to auth', () => {
    const error = new Error(
      'Could not resolve authentication method. Expected one of apiKey, authToken...',
    );
    expect(toProviderError(error)).toMatchObject({
      kind: 'auth',
      message: 'No API key or auth token is configured.',
    });
  });

  it('keeps unexpected errors as unknown with a single-line message', () => {
    expect(toProviderError(new Error('first line\n    at stack frame'))).toMatchObject({
      kind: 'unknown',
      message: 'first line at stack frame',
    });
    expect(toProviderError('not an error')).toMatchObject({
      kind: 'unknown',
      message: 'Unexpected error.',
    });
  });

  it('truncates very long API messages', () => {
    const body = {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'x'.repeat(2000) },
    };
    const error = toProviderError(new APIError(400, body, undefined, new Headers()));
    expect(error.message.length).toBeLessThanOrEqual(500);
  });
});
