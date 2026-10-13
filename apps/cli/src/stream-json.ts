import { redactSecrets, type AgentEvent, type TurnResult } from '@patch/core';
import { estimateCostUsd, type ModelPricing } from '@patch/shared';

/** Longest single text value written to the stream; the rest is cut, with a marker. */
const MAX_TEXT_CHARS = 20_000;
const MAX_LINE_CHARS = 400;
const MAX_DISPLAY_LINES = 12;

/** One NDJSON record of `--output-format stream-json`. Every record has a `type`. */
export type StreamRecord = { type: string } & Record<string, unknown>;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text;
}

/** Credentials never reach the stream, whatever a tool or the model printed. */
function clean(text: string, max = MAX_LINE_CHARS): string {
  return clip(redactSecrets(text), max);
}

/**
 * Turns the agent's events into NDJSON records for programs that supervise a run (Patch Cloud's
 * worker, scripts). The stream is a log, not a replay: assistant text is delivered once per
 * contiguous run (no token deltas), and tool calls are described by their one-line summary and
 * outcome, never by their full input or output, so file contents do not travel in it.
 */
export class StreamJsonEmitter {
  private text = '';

  constructor(
    private readonly write: (record: StreamRecord) => void,
    private readonly pricing: () => ModelPricing | undefined,
  ) {}

  init(fields: { sessionId: string; model: string; mode: string; version: string }): void {
    this.write({
      type: 'init',
      session_id: fields.sessionId,
      model: fields.model,
      permission_mode: fields.mode,
      patch_version: fields.version,
    });
  }

  /** Records that this run could not ask the user, so an action was skipped. */
  permissionDenied(message: string): void {
    this.write({ type: 'permission_denied', message: clean(message) });
  }

  event(event: AgentEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.text += event.text;
        break;
      case 'text_end':
        this.flushText();
        break;
      case 'model_start':
        this.write({ type: 'model_start', step: event.step, model: event.model });
        break;
      case 'tool_start':
        this.flushText();
        this.write({
          type: 'tool_start',
          id: event.id,
          name: event.name,
          verb: event.summary.verb,
          target: clean(event.summary.target),
          ...(event.summary.detail ? { detail: clean(event.summary.detail) } : {}),
        });
        break;
      case 'tool_end': {
        const { display } = event.result;
        this.write({
          type: 'tool_end',
          id: event.id,
          name: event.name,
          verb: event.summary.verb,
          target: clean(event.summary.target),
          is_error: event.result.isError === true,
          ...(event.denied ? { denied: true } : {}),
          duration_ms: event.durationMs,
          ...(display?.summary ? { summary: clean(display.summary) } : {}),
          ...(display?.lines?.length
            ? { lines: display.lines.slice(0, MAX_DISPLAY_LINES).map((line) => clean(line)) }
            : {}),
          ...(display?.diff
            ? {
                diff: {
                  path: display.diff.path,
                  added: display.diff.added,
                  removed: display.diff.removed,
                  is_new: display.diff.isNew,
                },
              }
            : {}),
        });
        break;
      }
      case 'hosted_tool_end':
        this.write({
          type: 'hosted_tool',
          kind: event.kind,
          verb: event.summary.verb,
          target: clean(event.summary.target),
          is_error: event.isError,
          ...(event.display.summary ? { summary: clean(event.display.summary) } : {}),
        });
        break;
      case 'usage': {
        const cost = estimateCostUsd(event.usage, this.pricing());
        this.write({
          type: 'usage',
          model: event.model,
          input_tokens: event.usage.inputTokens,
          output_tokens: event.usage.outputTokens,
          cache_read_tokens: event.usage.cacheReadTokens,
          cache_write_tokens: event.usage.cacheWriteTokens,
          ...(event.usage.webSearches ? { web_searches: event.usage.webSearches } : {}),
          ...(cost !== undefined ? { cost_usd: Number(cost.toFixed(6)) } : {}),
          context_tokens: event.contextTokens,
          context_window: event.contextWindow,
        });
        break;
      }
      case 'notice':
        this.write({
          type: 'notice',
          level: event.level,
          text: clean(event.text, 2_000),
          ...(event.hint ? { hint: clean(event.hint, 2_000) } : {}),
        });
        break;
      case 'compaction':
        this.write({ type: 'compaction', auto: event.auto, messages: event.messagesCompacted });
        break;
      default:
        break;
    }
  }

  /** Writes any assistant text still buffered. Call before the final result. */
  flushText(): void {
    if (!this.text) return;
    this.write({ type: 'text', text: clean(this.text, MAX_TEXT_CHARS) });
    this.text = '';
  }
}

export interface ResultFields {
  result: TurnResult;
  text: string;
  sessionId: string;
  model: string;
  durationMs: number;
  costUsd?: number;
  permissionDenials: string[];
}

/** The closing record: the same fields as `--output-format json`, with `type: "result"`. */
export function resultRecord(fields: ResultFields): StreamRecord {
  const { result } = fields;
  return {
    type: 'result',
    status: result.status,
    is_error: result.status !== 'completed',
    result: clip(redactSecrets(fields.text), 100_000),
    session_id: fields.sessionId,
    model: fields.model,
    steps: result.steps,
    tool_calls: result.toolCalls,
    duration_ms: fields.durationMs,
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      cache_read_tokens: result.usage.cacheReadTokens,
      cache_write_tokens: result.usage.cacheWriteTokens,
      ...(result.usage.webSearches ? { web_searches: result.usage.webSearches } : {}),
    },
    ...(fields.costUsd !== undefined
      ? { estimated_cost_usd: Number(fields.costUsd.toFixed(6)) }
      : {}),
    ...(fields.permissionDenials.length > 0
      ? { permission_denials: fields.permissionDenials }
      : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}
