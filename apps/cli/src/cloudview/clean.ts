import { relativeTime } from '@patch/shared';
import { stripControls } from '../ui/text-layout.js';

/**
 * Patch Cloud's answers are data, not terminal input: any string in them (names, titles, texts,
 * dates, ids, errors) can carry escape sequences or bidirectional controls. `cleanDeep` removes
 * them from every string of a value, so nothing downstream has to remember to.
 */
export function cleanDeep<T>(value: T): T {
  if (typeof value === 'string') return stripControls(value) as T;
  if (Array.isArray(value)) return value.map((item) => cleanDeep(item)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[stripControls(key)] = cleanDeep(item);
    return out as T;
  }
  return value;
}

/**
 * The same API, with everything it returns cleaned (see `cleanDeep`), including the events of
 * a followed run. Every call site of the cloud view gets safe data by default.
 */
export function sanitizeApi<T extends object>(api: T): T {
  return new Proxy(api, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (property === 'follow' && typeof args[1] === 'function') {
          const onEvent = args[1] as (event: unknown) => void;
          args[1] = (event: unknown) => onEvent(cleanDeep(event));
        }
        const result: unknown = value.apply(target, args);
        return result instanceof Promise ? result.then((data) => cleanDeep(data)) : result;
      };
    },
  });
}

/**
 * "3m ago" for a date from Patch Cloud, or "some time ago" when it is not a date (the view must
 * never fail on a field it cannot read).
 */
export function since(iso: string, now: Date = new Date()): string {
  return Number.isNaN(Date.parse(iso)) ? 'at an unknown time' : relativeTime(iso, now);
}
