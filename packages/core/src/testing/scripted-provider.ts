import {
  ProviderError,
  type ContentBlock,
  type HostedToolKind,
  type Message,
  type ModelEvent,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type StopReason,
  type Usage,
} from '@patch/shared';

export interface ScriptedToolCall {
  id?: string;
  name: string;
  input: Record<string, unknown>;
  /** Simulate an unparsable streamed input. */
  inputError?: string;
}

/** A hosted tool call the provider runs within the response. */
export interface ScriptedHostedCall {
  id?: string;
  kind: HostedToolKind;
  /** Query or URL. */
  detail: string;
  /** Outcome ("8 results"); omitted, the call stays open (e.g. in a paused response). */
  summary?: string;
  isError?: boolean;
  /** The call was made in an earlier (paused) response: only its result is stored here. */
  continued?: boolean;
}

/** Convenience description of one model response. */
export interface ScriptedResponse {
  /** Progress notes emitted before the text. */
  progress?: string[];
  /** Hosted tool calls (and results) emitted after the progress notes, before the text. */
  hosted?: ScriptedHostedCall[];
  text?: string;
  toolCalls?: ScriptedToolCall[];
  /** Defaults to 'tool_use' when toolCalls are present, else 'end_turn'. */
  stopReason?: StopReason;
  usage?: Partial<Usage>;
  /** Split text into chunks of this many characters with `chunkDelayMs` between them. */
  chunkSize?: number;
  chunkDelayMs?: number;
  /** Throw this error instead of responding (after emitting nothing). */
  error?: ProviderError;
  refusal?: { category: string | null; explanation: string | null };
}

export type ScriptStep =
  ScriptedResponse | ((request: ModelRequest) => ScriptedResponse | Promise<ScriptedResponse>);

const DEFAULT_INFO: ModelInfo = {
  id: 'scripted-model',
  label: 'Scripted',
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  known: true,
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError('aborted', 'Request aborted', { provider: 'scripted' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError('aborted', 'Request aborted', { provider: 'scripted' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A deterministic ModelProvider for tests. Each `stream()` call consumes the next script step.
 * Every request is recorded (deep-copied) in `requests` so tests can assert on what was sent.
 */
export class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted';
  readonly displayName = 'Scripted';
  readonly requests: ModelRequest[] = [];
  private readonly steps: ScriptStep[];
  private callCounter = 0;
  private readonly info: ModelInfo;

  constructor(steps: ScriptStep[], info: Partial<ModelInfo> = {}) {
    this.steps = [...steps];
    this.info = { ...DEFAULT_INFO, ...info };
  }

  /** Appends more steps (e.g. between turns). */
  push(...steps: ScriptStep[]): void {
    this.steps.push(...steps);
  }

  get remaining(): number {
    return this.steps.length;
  }

  getModelInfo(model: string): ModelInfo {
    return { ...this.info, id: model };
  }

  listModels(): ModelInfo[] {
    return [this.info];
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const { signal, ...rest } = request;
    this.requests.push(structuredClone(rest) as ModelRequest);
    const step = this.steps.shift();
    if (!step) {
      throw new ProviderError('unknown', 'ScriptedProvider: no scripted response left', {
        provider: 'scripted',
      });
    }
    const response = typeof step === 'function' ? await step(request) : step;
    if (signal?.aborted)
      throw new ProviderError('aborted', 'Request aborted', { provider: 'scripted' });
    if (response.error) throw response.error;

    yield { type: 'message_start', model: request.model };
    const content: ContentBlock[] = [];

    for (const note of response.progress ?? []) {
      yield { type: 'thinking' };
      yield { type: 'progress', text: note };
      content.push({
        type: 'provider',
        provider: 'scripted',
        kind: 'progress',
        data: { text: note },
        displayText: note,
      });
    }

    for (const call of response.hosted ?? []) {
      const id = call.id ?? `hosted_${++this.callCounter}`;
      const { kind, detail } = call;
      yield { type: 'hosted_tool_start', id, kind, detail };
      if (!call.continued) {
        content.push({
          type: 'provider',
          provider: 'scripted',
          kind: 'hosted_call',
          data: { id, kind, detail },
          displayText: detail,
          hostedTool: { phase: 'call', id, kind, detail },
        });
      }
      if (call.summary === undefined) continue;
      const isError = call.isError ?? false;
      yield { type: 'hosted_tool_end', id, kind, summary: call.summary, isError };
      content.push({
        type: 'provider',
        provider: 'scripted',
        kind: 'hosted_result',
        data: { id, summary: call.summary },
        displayText: call.summary,
        hostedTool: { phase: 'result', id, kind, summary: call.summary, isError },
      });
    }

    if (response.text) {
      const size = response.chunkSize ?? response.text.length;
      for (let i = 0; i < response.text.length; i += size) {
        if (response.chunkDelayMs && i > 0) await sleep(response.chunkDelayMs, signal);
        if (signal?.aborted) {
          throw new ProviderError('aborted', 'Request aborted', { provider: 'scripted' });
        }
        yield { type: 'text_delta', text: response.text.slice(i, i + size) };
      }
      content.push({ type: 'text', text: response.text });
    }

    for (const call of response.toolCalls ?? []) {
      const id = call.id ?? `call_${++this.callCounter}`;
      yield { type: 'tool_call_start', id, name: call.name };
      yield { type: 'tool_call_delta', id, inputBytes: JSON.stringify(call.input).length };
      content.push({
        type: 'tool_call',
        id,
        name: call.name,
        input: call.input,
        ...(call.inputError ? { inputError: call.inputError, rawInput: '{"broken' } : {}),
      });
    }

    const stopReason: StopReason =
      response.stopReason ?? ((response.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn');
    const usage: Usage = {
      inputTokens: response.usage?.inputTokens ?? 100,
      outputTokens: response.usage?.outputTokens ?? 20,
      cacheReadTokens: response.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: response.usage?.cacheWriteTokens ?? 0,
      ...(response.usage?.webSearches ? { webSearches: response.usage.webSearches } : {}),
    };
    const message: Message = { role: 'assistant', content };
    yield {
      type: 'message_end',
      message,
      stopReason,
      usage,
      model: request.model,
      ...(response.refusal ? { refusal: response.refusal } : {}),
    };
  }
}

export function textResponse(
  text: string,
  extra: Partial<ScriptedResponse> = {},
): ScriptedResponse {
  return { text, ...extra };
}

export function toolResponse(
  calls: ScriptedToolCall[],
  text?: string,
  extra: Partial<ScriptedResponse> = {},
): ScriptedResponse {
  return { toolCalls: calls, ...(text ? { text } : {}), ...extra };
}
