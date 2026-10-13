import { type Dirent } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { formatBytes, formatCount, plural } from '@patch/shared';
import { z } from 'zod';
import { describeFsError, isMissingError } from '../fs/fs-errors.js';
import type { ResolvedPath } from '../fs/paths.js';
import { isDefaultIgnoredDir } from '../fs/walk.js';
import { displayPathInput, mapWithConcurrency, resolveSearchPath } from './fs-helpers.js';
import { ToolError, defineTool, type ToolContext, type ToolResult } from './types.js';

export const MAX_LIST_ENTRIES = 500;

export const listDirectoryInput = z.object({
  path: z.string().optional().describe('Directory to list (default: the working directory).'),
  depth: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe('How many levels to descend (default 1).'),
});

/** Entries read before the listing stops descending, which bounds the work on huge trees. */
const MAX_DISCOVERED_ENTRIES = 20 * MAX_LIST_ENTRIES;
const STAT_CONCURRENCY = 32;

type NodeKind = 'directory' | 'file' | 'symlink' | 'other';

interface ListNode {
  name: string;
  absolute: string;
  kind: NodeKind;
  size?: number;
  linkTarget?: string;
  /** Read children (directories that were expanded). */
  children?: ListNode[];
  annotation?: 'not expanded' | 'permission denied';
  included: boolean;
}

function kindOf(entry: Dirent): NodeKind {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  if (entry.isSymbolicLink()) return 'symlink';
  return 'other';
}

/** Directories first, then everything else; case-insensitive name order within each group. */
function compareNodes(a: ListNode, b: ListNode): number {
  const groupA = a.kind === 'directory' ? 0 : 1;
  const groupB = b.kind === 'directory' ? 0 : 1;
  if (groupA !== groupB) return groupA - groupB;
  const byFold = a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en');
  if (byFold !== 0) return byFold;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

async function describeEntry(directory: string, entry: Dirent): Promise<ListNode> {
  const absolute = path.join(directory, entry.name);
  const node: ListNode = { name: entry.name, absolute, kind: kindOf(entry), included: false };
  try {
    if (node.kind === 'file') node.size = (await lstat(absolute)).size;
    else if (node.kind === 'symlink') node.linkTarget = await readlink(absolute);
  } catch {
    // The entry vanished or is unreadable; list it without details.
  }
  return node;
}

async function readChildren(directory: string): Promise<ListNode[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nodes = await mapWithConcurrency(entries, STAT_CONCURRENCY, (entry) =>
    describeEntry(directory, entry),
  );
  return nodes.sort(compareNodes);
}

/** True when the listed directory is itself inside (or is) a directory that is never expanded. */
function insideIgnoredDirectory(ctx: ToolContext, resolved: ResolvedPath): boolean {
  let location = resolved.absolute;
  if (resolved.insideProject) {
    // display is relative to cwd; anchor it at the project root so only project segments count.
    const cwdInProject = path.relative(ctx.projectRoot, ctx.cwd).split(path.sep).join('/');
    location = path.posix.join(cwdInProject, resolved.display);
  }
  return location.split(/[\\/]+/).some((segment) => segment !== '' && isDefaultIgnoredDir(segment));
}

interface Tree {
  roots: ListNode[];
  discovered: number;
  /** Discovery stopped at MAX_DISCOVERED_ENTRIES; deeper levels were not read completely. */
  incomplete: boolean;
}

/** Reads the tree breadth-first up to `depth` levels. */
async function readTree(root: string, depth: number, expandIgnored: boolean): Promise<Tree> {
  const markIgnored = (nodes: ListNode[]) => {
    if (expandIgnored) return;
    for (const node of nodes) {
      if (node.kind === 'directory' && isDefaultIgnoredDir(node.name)) {
        node.annotation = 'not expanded';
      }
    }
  };
  const roots = await readChildren(root);
  markIgnored(roots);
  let discovered = roots.length;
  let incomplete = false;
  let level = roots;
  for (let current = 1; current < depth && level.length > 0; current++) {
    const expandable = level.filter(
      (node) => node.kind === 'directory' && node.annotation === undefined,
    );
    await mapWithConcurrency(expandable, STAT_CONCURRENCY, async (node) => {
      if (discovered >= MAX_DISCOVERED_ENTRIES) {
        incomplete = true;
        node.annotation = 'not expanded';
        return;
      }
      try {
        node.children = await readChildren(node.absolute);
        markIgnored(node.children);
        discovered += node.children.length;
      } catch {
        node.annotation = 'permission denied';
      }
    });
    level = expandable.flatMap((node) => node.children ?? []);
  }
  return { roots, discovered, incomplete };
}

/** Marks up to `limit` nodes as included, level by level, so shallow entries always show. */
function selectBreadthFirst(roots: ListNode[], limit: number): number {
  let included = 0;
  let level = roots;
  while (level.length > 0 && included < limit) {
    const next: ListNode[] = [];
    for (const node of level) {
      if (included >= limit) break;
      node.included = true;
      included++;
      next.push(...(node.children ?? []));
    }
    level = next;
  }
  return included;
}

function label(node: ListNode): string {
  switch (node.kind) {
    case 'directory': {
      const note =
        node.annotation ?? (node.children && node.children.length === 0 ? 'empty' : undefined);
      return note ? `${node.name}/  (${note})` : `${node.name}/`;
    }
    case 'file':
      return node.size === undefined ? node.name : `${node.name}  ${formatBytes(node.size)}`;
    case 'symlink':
      return node.linkTarget === undefined
        ? `${node.name}  (symlink)`
        : `${node.name} -> ${node.linkTarget}`;
    default:
      return `${node.name}  (special file)`;
  }
}

function render(nodes: ListNode[], indent: string, lines: string[]): void {
  for (const node of nodes) {
    if (!node.included) continue;
    lines.push(`${indent}${label(node)}`);
    if (node.children) render(node.children, `${indent}  `, lines);
  }
  const hidden = nodes.filter((node) => !node.included).length;
  if (hidden > 0) lines.push(`${indent}... ${plural(hidden, 'more entry', 'more entries')}`);
}

/**
 * Lists a directory as an indented tree: directories end with "/", files show size
 * ("src/", "  index.ts  1.2 KB"). Sorted: directories first, then files, alphabetical.
 * Does not expand DEFAULT_IGNORED_DIRS (shown as "node_modules/  (not expanded)") unless the
 * listed path itself is inside one. Caps at MAX_LIST_ENTRIES with an explicit
 * "... N more entries" note. A file path → ToolError suggesting read_file.
 * Display: verb "ls", target display path, summary "<n> entries". Permission: read.
 *
 * When capped, entries are chosen breadth-first (every top-level entry before any nested one)
 * and each truncated directory says how many of its entries were left out. Symbolic links are
 * shown with their target and never followed.
 */
export const listDirectoryTool = defineTool({
  name: 'list_directory',
  description:
    'List the contents of a directory as a tree (directories end with "/"). Large generated directories such as node_modules are not expanded.',
  inputSchema: listDirectoryInput,
  permissionClass: 'read',
  summarize(input, ctx) {
    const depth = input.depth ?? 1;
    return {
      verb: 'ls',
      target: displayPathInput(ctx, input.path),
      ...(depth > 1 ? { detail: `depth ${depth}` } : {}),
    };
  },
  async permission(input, ctx) {
    return { kind: 'read', paths: [await resolveSearchPath(ctx, input.path)] };
  },
  async execute(input, ctx): Promise<ToolResult> {
    const resolved = await resolveSearchPath(ctx, input.path);
    const { display } = resolved;
    if (!resolved.exists) throw new ToolError(`Directory not found: ${display}`);
    if (!resolved.isDirectory) {
      throw new ToolError(`${display} is a file, not a directory. Use read_file to read it.`);
    }
    let tree: Tree;
    try {
      tree = await readTree(
        resolved.absolute,
        input.depth ?? 1,
        insideIgnoredDirectory(ctx, resolved),
      );
    } catch (error) {
      if (isMissingError(error)) throw new ToolError(`Directory not found: ${display}`);
      throw new ToolError(`Could not list ${display}: ${describeFsError(error)}.`);
    }
    if (tree.roots.length === 0) {
      return { content: `${display} is empty.`, display: { summary: 'empty' } };
    }
    const shown = selectBreadthFirst(tree.roots, MAX_LIST_ENTRIES);
    const lines: string[] = [];
    render(tree.roots, '', lines);
    const total = `${formatCount(tree.discovered)}${tree.incomplete ? '+' : ''}`;
    if (shown < tree.discovered || tree.incomplete) {
      lines.push(
        '',
        `Showing ${formatCount(shown)} of ${total} entries. List a subdirectory or use a smaller depth to see the rest.`,
      );
    }
    return {
      content: lines.join('\n'),
      display: {
        summary: `${total} ${tree.discovered === 1 && !tree.incomplete ? 'entry' : 'entries'}`,
      },
    };
  },
});
