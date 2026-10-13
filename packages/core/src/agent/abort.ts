import {
  ProviderError,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
} from '@patch/shared';

/** Resolution value of `untilAborted` when the signal fired first. */
export const ABORTED: unique symbol = Symbol('aborted');

/**
 * Waits for `promise` unless `signal` fires first, in which case it resolves with `ABORTED`
 * right away (the work behind `promise` may still be running). A later rejection of the losing
 * promise is swallowed so it never surfaces as an unhandled rejection.
 */
export function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof ABORTED> {
  promise.catch(() => undefined);
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Runs `fn` and turns a synchronous throw into a rejected promise. */
export function attempt<T>(fn: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => resolve(fn()));
}

/**
 * Streams a model request and enforces the provider contract that a fired signal ends the stream
 * promptly with a ProviderError of kind 'aborted', even when the provider is slow to notice.
 * Leaving the loop early (or aborting) closes the provider's stream.
 */
export async function* streamModel(
  provider: ModelProvider,
  request: ModelRequest,
  signal: AbortSignal,
): AsyncGenerator<ModelEvent, void, undefined> {
  const iterator = provider.stream({ ...request, signal })[Symbol.asyncIterator]();
  let exhausted = false;
  try {
    for (;;) {
      const next = await untilAborted(iterator.next(), signal);
      if (next === ABORTED) {
        throw new ProviderError('aborted', 'Request aborted', { provider: provider.id });
      }
      if (next.done) {
        exhausted = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!exhausted) closeQuietly(iterator);
  }
}

/** Asks an iterator to clean up without waiting for it (it may be stuck behind a pending next). */
function closeQuietly(iterator: AsyncIterator<unknown>): void {
  try {
    iterator.return?.().catch(() => undefined);
  } catch {
    // A misbehaving iterator must not mask the original outcome.
  }
}
