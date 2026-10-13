/** Longest string kept in a log line; longer strings are cut with an explicit marker. */
export const MAX_LOG_STRING_CHARS = 10_000;
/** Nesting depth beyond which objects are summarized instead of expanded. */
const MAX_DEPTH = 10;
const UNSERIALIZABLE = '[Unserializable]';

type Recurse = (value: unknown) => unknown;

export function truncateForLog(text: string): string {
  if (text.length <= MAX_LOG_STRING_CHARS) return text;
  const omitted = text.length - MAX_LOG_STRING_CHARS;
  return `${text.slice(0, MAX_LOG_STRING_CHARS)}… [${omitted} more chars]`;
}

/**
 * JSON for arbitrary log data. Never throws: Errors become `{name, message, stack, ...}`, circular
 * references become "[Circular]", bigints become strings, long strings are truncated, binary
 * buffers are summarized and anything that fails to serialize becomes "[Unserializable]".
 */
export function serializeLogData(data: unknown): string {
  return JSON.stringify(toLoggable(data, [], 0)) ?? 'undefined';
}

function toLoggable(value: unknown, ancestors: object[], depth: number): unknown {
  switch (typeof value) {
    case 'string':
      return truncateForLog(value);
    case 'bigint':
    case 'symbol':
      return value.toString();
    case 'function':
      return `[Function ${value.name || 'anonymous'}]`;
    case 'object':
      break;
    default:
      return value;
  }
  if (value === null) return null;
  if (ancestors.includes(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? '[Array]' : '[Object]';
  ancestors.push(value);
  try {
    return objectToLoggable(value, (child) => toLoggable(child, ancestors, depth + 1));
  } catch {
    return UNSERIALIZABLE;
  } finally {
    ancestors.pop();
  }
}

function objectToLoggable(value: object, recurse: Recurse): unknown {
  if (value instanceof Error) return errorToLoggable(value, recurse);
  if (Array.isArray(value)) return value.map(recurse);
  if (value instanceof Map) return Array.from(value, ([k, v]) => [recurse(k), recurse(v)]);
  if (value instanceof Set) return Array.from(value, recurse);
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength} bytes]`;
  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === 'function') return recurse(withToJson.toJSON());
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) result[key] = recurse(readProperty(value, key));
  return result;
}

/** A property value, or a marker when its getter throws (one bad field must not hide the rest). */
function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return UNSERIALIZABLE;
  }
}

/** name, message and stack (not enumerable on Errors), then own fields such as `code`, then cause. */
function errorToLoggable(error: Error, recurse: Recurse): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: error.name,
    message: recurse(error.message),
    stack: recurse(error.stack),
  };
  for (const key of Object.keys(error)) {
    if (!Object.hasOwn(result, key)) result[key] = recurse(readProperty(error, key));
  }
  if (error.cause !== undefined && !Object.hasOwn(result, 'cause')) {
    result.cause = recurse(error.cause);
  }
  return result;
}
