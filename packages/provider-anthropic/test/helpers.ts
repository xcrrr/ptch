import {
  isProviderError,
  type Message,
  type ModelEvent,
  type ModelRequest,
  type ProviderError,
  type ToolSpec,
} from '@patch/shared';
import { AnthropicProvider, type AnthropicProviderOptions } from '../src/provider.js';
import type { MessageEndEvent } from '../src/stream.js';
import {
  startMockAnthropicServer,
  type MockAnthropicServer,
  type MockServerOptions,
} from '../src/testing/mock-server.js';

export type MessageEnd = MessageEndEvent;

const servers: MockAnthropicServer[] = [];

/** Starts a mock server that closeServers() (call it in afterEach) shuts down. */
export async function startServer(options?: MockServerOptions): Promise<MockAnthropicServer> {
  const server = await startMockAnthropicServer(options);
  servers.push(server);
  return server;
}

export async function closeServers(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => server.close()));
}

export function makeProvider(
  server: MockAnthropicServer,
  options: AnthropicProviderOptions = {},
): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: 'test-key',
    baseUrl: server.url,
    maxRetries: 0,
    ...options,
  });
}

export function userText(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

export const READ_FILE_TOOL: ToolSpec = {
  name: 'read_file',
  description: 'Read a file from the workspace.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

export function makeRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'claude-opus-5-5',
    system: 'You are Patch, a coding agent.',
    messages: [userText('Hello there')],
    tools: [READ_FILE_TOOL],
    ...overrides,
  };
}

export async function collect(
  stream: AsyncIterable<ModelEvent>,
): Promise<{ events: ModelEvent[]; end: MessageEnd }> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  const end = events.at(-1);
  if (end?.type !== 'message_end') throw new Error('stream did not end with message_end');
  return { events, end };
}

/** Consumes a stream that must fail; returns the events seen before the ProviderError. */
export async function collectError(
  stream: AsyncIterable<ModelEvent>,
): Promise<{ events: ModelEvent[]; error: ProviderError }> {
  const events: ModelEvent[] = [];
  try {
    for await (const event of stream) events.push(event);
  } catch (error) {
    if (!isProviderError(error)) throw error;
    return { events, error };
  }
  throw new Error('stream completed without an error');
}

export function lastBody(server: MockAnthropicServer): Record<string, unknown> {
  const request = server.requests.at(-1);
  if (!request) throw new Error('no request recorded');
  return request.body;
}

/** A conversation continued with the assistant's stored message and a follow-up user turn. */
export function continueWith(
  request: ModelRequest,
  assistant: Message,
  next: Message,
): ModelRequest {
  return { ...request, messages: [...request.messages, assistant, next] };
}
