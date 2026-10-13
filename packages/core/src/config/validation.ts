import { z } from 'zod';

/** Top-level keys that are never reported as unknown (editor schema hints). */
const IGNORED_KEYS = new Set(['$schema']);

const EXPECTED_TYPE_NAMES: Record<string, string> = {
  string: 'a string',
  number: 'a number',
  int: 'a whole number',
  boolean: 'true or false',
  object: 'an object',
  array: 'a list',
  record: 'an object',
};

type Path = Array<string | number>;

interface FieldProblem {
  /** Path of the setting (object keys only), e.g. ["permissions", "allow"]. */
  path: string[];
  description: string;
  /** Indexes of the invalid items of a list; undefined when the setting as a whole is invalid. */
  itemIndexes?: number[];
}

/**
 * Validates a JSON object against an object schema without ever failing as a whole: unknown keys
 * are reported, and each invalid setting is reported and dropped (for lists, only the invalid
 * items are dropped) while everything valid is kept. Messages never echo values, which may be
 * credentials. `source` names the file in messages, e.g. "~/.patch/config.json".
 */
export function parseLeniently<S extends z.ZodObject>(
  schema: S,
  raw: Record<string, unknown>,
  source: string,
  warnings: string[],
): z.infer<S> | undefined {
  warnUnknownKeys(schema, raw, [], source, warnings);
  const data = structuredClone(raw);
  const first = schema.safeParse(data);
  if (first.success) return first.data;

  const problems = collectProblems(schema, first.error.issues);
  for (const problem of problems) warnings.push(describeProblem(problem, source));
  // The invalid items of a list are dropped at once, so no drop shifts another one's index.
  for (const problem of mergeByPath(problems)) dropInvalid(data, problem);
  const second = schema.safeParse(data);
  if (second.success) return second.data;
  warnings.push(`Could not apply the settings in ${source}. Using defaults.`);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unwrapOptional(schema: z.ZodType): z.ZodType {
  return schema instanceof z.ZodOptional ? unwrapOptional(schema.unwrap() as z.ZodType) : schema;
}

/** The nested object schema at `key`, if the setting is itself a group of settings. */
function childObjectSchema(schema: z.ZodObject, key: string): z.ZodObject | undefined {
  if (!Object.hasOwn(schema.shape, key)) return undefined;
  const child = unwrapOptional(schema.shape[key] as z.ZodType);
  return child instanceof z.ZodObject ? child : undefined;
}

/** The object schema of the items at `key`, if the setting is a list of objects. */
function itemObjectSchema(schema: z.ZodObject, key: string): z.ZodObject | undefined {
  if (!Object.hasOwn(schema.shape, key)) return undefined;
  const child = unwrapOptional(schema.shape[key] as z.ZodType);
  if (!(child instanceof z.ZodArray)) return undefined;
  const item = unwrapOptional(child.element as z.ZodType);
  return item instanceof z.ZodObject ? item : undefined;
}

function warnUnknownKeys(
  schema: z.ZodObject,
  value: Record<string, unknown>,
  prefix: string[],
  source: string,
  warnings: string[],
): void {
  for (const key of Object.keys(value)) {
    if (prefix.length === 0 && IGNORED_KEYS.has(key)) continue;
    const path = [...prefix, key];
    if (!Object.hasOwn(schema.shape, key)) {
      warnings.push(`Unknown setting "${path.join('.')}" in ${source}`);
      continue;
    }
    const nested = value[key];
    const child = childObjectSchema(schema, key);
    if (child && isRecord(nested)) warnUnknownKeys(child, nested, path, source, warnings);
    const item = itemObjectSchema(schema, key);
    if (item && Array.isArray(nested)) {
      nested.forEach((entry, index) => {
        if (!isRecord(entry)) return;
        for (const name of Object.keys(entry)) {
          if (Object.hasOwn(item.shape, name)) continue;
          warnings.push(
            `Unknown setting "${name}" in item ${index + 1} of "${path.join('.')}" in ${source}`,
          );
        }
      });
    }
  }
}

/**
 * Groups issues by the setting they belong to (the deepest known key on the issue path). Invalid
 * items of a list are grouped too, except items that are objects (`["hooks", "Stop", 1,
 * "command"]`): each of those is reported on its own, naming the field.
 */
function collectProblems(schema: z.ZodObject, issues: readonly z.core.$ZodIssue[]): FieldProblem[] {
  const problems = new Map<string, FieldProblem>();
  for (const issue of issues) {
    const { path, rest } = settingPath(schema, issue.path as Path);
    if (path.length === 0) continue;
    const itemIndex = typeof rest[0] === 'number' ? rest[0] : undefined;
    const field = itemIndex !== undefined && rest.length > 1 ? rest.slice(1).join('.') : undefined;
    const key = field === undefined ? path.join('.') : `${path.join('.')}[${itemIndex}]`;
    const existing = problems.get(key);
    if (existing) {
      if (itemIndex !== undefined && !existing.itemIndexes?.includes(itemIndex)) {
        existing.itemIndexes?.push(itemIndex);
      }
      continue;
    }
    problems.set(key, {
      path,
      description:
        field === undefined ? describeIssue(issue) : `"${field}": ${describeIssue(issue)}`,
      itemIndexes: itemIndex === undefined ? undefined : [itemIndex],
    });
  }
  return [...problems.values()];
}

/** One problem per setting, with every invalid item of a list (undefined: the whole setting). */
function mergeByPath(problems: readonly FieldProblem[]): FieldProblem[] {
  const merged = new Map<string, FieldProblem>();
  for (const problem of problems) {
    const key = problem.path.join('.');
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...problem, itemIndexes: problem.itemIndexes?.slice() });
    } else if (existing.itemIndexes === undefined || problem.itemIndexes === undefined) {
      existing.itemIndexes = undefined;
    } else {
      existing.itemIndexes.push(...problem.itemIndexes);
    }
  }
  return [...merged.values()];
}

function settingPath(schema: z.ZodObject, issuePath: Path): { path: string[]; rest: Path } {
  const path: string[] = [];
  let current: z.ZodObject | undefined = schema;
  for (const segment of issuePath) {
    if (!current || typeof segment !== 'string' || !Object.hasOwn(current.shape, segment)) break;
    path.push(segment);
    current = childObjectSchema(current, segment);
  }
  return { path, rest: issuePath.slice(path.length) };
}

function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return `expected ${EXPECTED_TYPE_NAMES[issue.expected] ?? issue.expected}`;
    case 'invalid_value':
      return `expected one of ${issue.values.map((v) => String(v)).join(', ')}`;
    case 'too_small':
      if (issue.origin === 'string' && Number(issue.minimum) === 1) return 'must not be empty';
      return `must be ${issue.inclusive ? 'at least' : 'greater than'} ${issue.minimum}`;
    case 'too_big':
      return `must be ${issue.inclusive ? 'at most' : 'less than'} ${issue.maximum}${issue.origin === 'string' ? ' characters' : ''}`;
    case 'invalid_format':
      return issue.format === 'url' ? 'expected a URL' : `expected a valid ${issue.format}`;
    default:
      return issue.message.charAt(0).toLowerCase() + issue.message.slice(1);
  }
}

function describeProblem(problem: FieldProblem, source: string): string {
  const name = `"${problem.path.join('.')}"`;
  if (problem.itemIndexes === undefined) {
    return `Invalid setting ${name} in ${source}: ${problem.description}. Ignoring it.`;
  }
  const count = problem.itemIndexes.length;
  const positions = problem.itemIndexes.map((i) => i + 1).join(', ');
  return count === 1
    ? `Invalid item ${positions} of ${name} in ${source}: ${problem.description}. Ignoring it.`
    : `Invalid items ${positions} of ${name} in ${source}: ${problem.description}. Ignoring them.`;
}

function dropInvalid(data: Record<string, unknown>, problem: FieldProblem): void {
  const parentPath = problem.path.slice(0, -1);
  const key = problem.path[problem.path.length - 1]!;
  let parent: unknown = data;
  for (const segment of parentPath) parent = isRecord(parent) ? parent[segment] : undefined;
  if (!isRecord(parent)) return;
  const value = parent[key];
  if (problem.itemIndexes !== undefined && Array.isArray(value)) {
    const invalid = new Set(problem.itemIndexes);
    parent[key] = value.filter((_, index) => !invalid.has(index));
  } else {
    delete parent[key];
  }
}
