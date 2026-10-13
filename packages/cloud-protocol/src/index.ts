export * from './tasks.js';
export * from './events.js';
export * from './brain.js';
export * from './status.js';
export * from './secrets.js';
export * from './network.js';
export * from './conversations.js';
export * from './paths.js';
export * from './brain-graph.js';

/** Version of the HTTP API. Part of every route: `/api/v1/...`. */
export const API_VERSION = 'v1';

/** Largest workspace archive the API accepts, and the CLI refuses to build. */
export const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;
export const MAX_SNAPSHOT_FILES = 50_000;
export const MAX_SNAPSHOT_FILE_BYTES = 10 * 1024 * 1024;

/** Header carrying the JSON manifest of a snapshot upload. */
export const SNAPSHOT_MANIFEST_HEADER = 'x-snapshot-manifest';
/** Mutating browser requests must send this header (cheap CSRF defence next to SameSite). */
export const CSRF_HEADER = 'x-phq';

export interface ApiErrorBody {
  error: { code: string; message: string };
}
