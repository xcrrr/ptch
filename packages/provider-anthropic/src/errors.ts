import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import { oneLine, ProviderError, type ProviderErrorKind } from '@patch/shared';

export const PROVIDER_ID = 'anthropic';

const MAX_MESSAGE_CHARS = 500;

const RETRYABLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  'rate_limit',
  'overloaded',
  'server',
  'network',
  'timeout',
]);

const DEFAULT_MESSAGES: Record<ProviderErrorKind, string> = {
  auth: 'Authentication failed.',
  permission: 'Permission denied.',
  not_found: 'The requested resource was not found.',
  rate_limit: 'Rate limit exceeded.',
  overloaded: 'The API is temporarily overloaded.',
  invalid_request: 'The request was invalid.',
  workspace: 'This API key needs a workspace ID.',
  billing: 'The account has no API credits left.',
  context_length: 'The prompt is too long for the model’s context window.',
  network: 'Connection failed.',
  timeout: 'The request timed out.',
  server: 'The API returned an internal error.',
  aborted: 'Request aborted.',
  unknown: 'Unexpected error.',
};

const CONTEXT_LENGTH_PATTERN =
  /prompt is too long|context[ _-]?(?:window|length|limit)|too many (?:input )?tokens/i;

/** "This API key is not scoped to a workspace…" and "anthropic-workspace-id header must be…". */
const WORKSPACE_PATTERN = /anthropic-workspace-id|not scoped to a workspace/i;

/** "Your credit balance is too low to access the Anthropic API…". */
const BILLING_PATTERN = /credit balance|purchase credits|plans & billing/i;

const NETWORK_ERROR_CODES = /^(?:E[A-Z]+|UND_ERR_[A-Z_]+)$/;

export interface ApiErrorDetails {
  /** `error.type` from the response body, e.g. "overloaded_error". */
  type?: string;
  /** `error.message` from the response body. */
  message?: string;
  requestId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the `{type:'error', error:{type, message}}` body the API returns with every error. */
export function apiErrorDetails(error: APIError): ApiErrorDetails {
  const details: ApiErrorDetails = {};
  const body: unknown = error.error;
  if (isRecord(body)) {
    const inner = body['error'];
    if (isRecord(inner)) {
      if (typeof inner['type'] === 'string') details.type = inner['type'];
      if (typeof inner['message'] === 'string') details.message = inner['message'];
    }
    if (typeof body['request_id'] === 'string') details.requestId = body['request_id'];
  }
  details.type ??= error.type ?? undefined;
  details.requestId = error.requestID ?? details.requestId;
  return details;
}

function makeError(
  kind: ProviderErrorKind,
  message: string | undefined,
  extra: { status?: number; requestId?: string } = {},
): ProviderError {
  const text = message ? oneLine(message, MAX_MESSAGE_CHARS) : DEFAULT_MESSAGES[kind];
  return new ProviderError(kind, text || DEFAULT_MESSAGES[kind], {
    provider: PROVIDER_ID,
    status: extra.status,
    retryable: RETRYABLE_KINDS.has(kind),
    requestId: extra.requestId,
  });
}

export function abortedError(): ProviderError {
  return makeError('aborted', undefined);
}

export function isContextLengthMessage(message: string | undefined): boolean {
  return message !== undefined && CONTEXT_LENGTH_PATTERN.test(message);
}

function kindFromStatus(
  status: number,
  message: string | undefined,
): ProviderErrorKind | undefined {
  if (status === 529) return 'overloaded';
  if (status === 400 || status === 422) {
    return isContextLengthMessage(message) ? 'context_length' : 'invalid_request';
  }
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 409) return 'server';
  if (status === 413) return 'context_length';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return undefined;
}

/** Maps an API `error.type` (used for mid-stream `error` events, which carry no HTTP status). */
function kindFromType(type: string | undefined, message: string | undefined): ProviderErrorKind {
  switch (type) {
    case 'overloaded_error':
      return 'overloaded';
    case 'authentication_error':
      return 'auth';
    case 'permission_error':
      return 'permission';
    case 'not_found_error':
      return 'not_found';
    case 'rate_limit_error':
      return 'rate_limit';
    case 'timeout_error':
      return 'timeout';
    case 'api_error':
      return 'server';
    case 'request_too_large':
      return 'context_length';
    case 'billing_error':
      return 'billing';
    case 'invalid_request_error':
      return isContextLengthMessage(message) ? 'context_length' : 'invalid_request';
    default:
      return 'unknown';
  }
}

function fromApiError(error: APIError): ProviderError {
  const details = apiErrorDetails(error);
  const kind =
    details.type === 'overloaded_error'
      ? 'overloaded'
      : WORKSPACE_PATTERN.test(details.message ?? '')
        ? 'workspace'
        : details.type === 'billing_error' || BILLING_PATTERN.test(details.message ?? '')
          ? 'billing'
          : ((error.status !== undefined
              ? kindFromStatus(error.status, details.message)
              : undefined) ?? kindFromType(details.type, details.message));
  return makeError(kind, details.message, { status: error.status, requestId: details.requestId });
}

/** Finds a system error code (ECONNREFUSED, UND_ERR_SOCKET, ...) in an error's cause chain. */
function networkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && isRecord(current); depth++) {
    const code = current['code'];
    if (typeof code === 'string' && NETWORK_ERROR_CODES.test(code)) return code;
    current = current['cause'];
  }
  return undefined;
}

function connectionFailure(error: unknown, prefix: string): ProviderError {
  const code = networkErrorCode(error);
  return makeError('network', code ? `${prefix} (${code}).` : `${prefix}.`);
}

/** undici reports a dropped connection while reading a body as `TypeError: terminated`. */
function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  return /terminated|fetch failed|network|socket/i.test(error.message);
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Normalizes anything thrown while talking to the API into a ProviderError. Raw SDK errors,
 * response bodies and stack traces never leave this function; only the API's own one-line
 * `error.message` (or a generic message) is kept.
 */
export function toProviderError(error: unknown, signal?: AbortSignal | null): ProviderError {
  if (error instanceof ProviderError) return error;
  if (signal?.aborted || error instanceof APIUserAbortError || isAbortLike(error)) {
    return abortedError();
  }
  if (error instanceof APIConnectionTimeoutError) return makeError('timeout', undefined);
  if (error instanceof APIConnectionError) return connectionFailure(error, 'Connection failed');
  if (error instanceof APIError) return fromApiError(error);
  if (isTransportFailure(error)) {
    return connectionFailure(error, 'Connection lost while streaming the response');
  }
  if (error instanceof Error && /authentication method/i.test(error.message)) {
    return makeError('auth', 'No API key or auth token is configured.');
  }
  if (error instanceof SyntaxError) {
    return makeError('server', 'The API returned a malformed response stream.');
  }
  return makeError('unknown', error instanceof Error ? error.message : undefined);
}
