export type ProviderErrorKind =
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'rate_limit'
  | 'overloaded'
  | 'invalid_request'
  /** The key belongs to an organization and the request named no (or an invalid) workspace. */
  | 'workspace'
  /** The account has no credits left (or billing is not set up). */
  | 'billing'
  | 'context_length'
  | 'network'
  | 'timeout'
  | 'server'
  | 'aborted'
  | 'unknown';

export interface ProviderErrorOptions {
  provider: string;
  status?: number;
  retryable?: boolean;
  requestId?: string;
  cause?: unknown;
}

/** A normalized failure from a model provider. Providers must never leak raw SDK errors. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly requestId?: string;

  constructor(kind: ProviderErrorKind, message: string, options: ProviderErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    this.provider = options.provider;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/** Thrown (or used as a reason) when an operation is cancelled by the user. */
export class AbortError extends Error {
  override readonly name = 'AbortError';
  constructor(message = 'Interrupted') {
    super(message);
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof AbortError) return true;
  if (error instanceof ProviderError) return error.kind === 'aborted';
  if (error instanceof Error && error.name === 'AbortError') return true;
  return false;
}

/** Throws an AbortError if the signal has fired. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortError();
}
