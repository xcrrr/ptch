import { existsSync } from 'node:fs';
import { plural, splitLines } from '@patch/shared';
import { z } from 'zod';
import { computeFileDiff } from '../fs/diffing.js';
import type { ResolvedPath } from '../fs/paths.js';
import { detectLineEnding, readTextFile, type LineEnding, type TextFile } from '../fs/text-file.js';
import {
  assertUnchangedSinceRead,
  displayPathInput,
  preexistingChangesNote,
  requirePriorRead,
  writeResolvedFile,
} from './fs-helpers.js';
import { ToolError, defineTool, type ToolContext, type ToolResult } from './types.js';

export const writeFileInput = z.object({
  path: z.string().describe('Path of the file to create or overwrite.'),
  content: z.string().describe('The complete new file content.'),
});

type WriteFileInput = z.infer<typeof writeFileInput>;

interface WritePlan {
  resolved: ResolvedPath;
  /** The file being replaced; undefined when it is created. */
  existing?: TextFile;
  /** New content, "\n"-normalized and without BOM. */
  content: string;
  lineEnding: LineEnding;
  bom: boolean;
}

/** Validates the write and works out the bytes to produce, without touching the file. */
async function planWrite(input: WriteFileInput, ctx: ToolContext): Promise<WritePlan> {
  const resolved = await ctx.paths.resolve(input.path);
  if (resolved.isDirectory) {
    throw new ToolError(`${resolved.display} is a directory; write_file needs a file path.`);
  }
  const startsWithBom = input.content.startsWith('\uFEFF');
  const raw = startsWithBom ? input.content.slice(1) : input.content;
  const content = raw.replace(/\r\n/g, '\n');
  if (!resolved.exists) {
    return { resolved, content, lineEnding: detectLineEnding(raw), bom: startsWithBom };
  }
  const known = requirePriorRead(ctx, resolved, 'overwrite');
  const existing = await readTextFile(resolved.absolute, resolved.display);
  assertUnchangedSinceRead(resolved, known, existing.snapshot, {
    action: 'overwrite',
    requireFullRead: true,
  });
  return { resolved, existing, content, lineEnding: existing.lineEnding, bom: existing.bom };
}

function createsFile(input: WriteFileInput, ctx: ToolContext): boolean {
  try {
    return !existsSync(ctx.paths.resolveLexically(input.path));
  } catch {
    return true;
  }
}

/**
 * Creates a file (and parent directories) or replaces an existing one.
 * Safety: replacing an existing file requires that Patch read it (fully) or wrote it earlier in
 * this session, and that it has not changed on disk since (FileStateTracker snapshot vs disk);
 * otherwise ToolError("<path> has changed since it was last read. Read it again before writing.")
 * or ToolError("Read <path> before overwriting it."). Existing line endings and BOM are preserved.
 * If the file had uncommitted Git changes not made by Patch, the result says so.
 * Result content: "Created <path> (<n> lines)." / "Updated <path> (+a -r)."
 * Display: verb "create" (new file) or "write"; diff (FileDiff).
 * Permission subject: { kind: 'write', paths: [resolved] }. Preview: the diff.
 *
 * The safety checks also run in permission(), so a write that cannot succeed fails before the
 * user is asked to approve it. Writing identical content is reported as "No changes" and skipped.
 */
export const writeFileTool = defineTool({
  name: 'write_file',
  description:
    'Create a new file, or replace an existing file entirely. To replace an existing file you must have read it first in this session. Prefer edit_file for changes to existing files.',
  inputSchema: writeFileInput,
  permissionClass: 'write',
  summarize(input, ctx) {
    return {
      verb: createsFile(input, ctx) ? 'create' : 'write',
      target: displayPathInput(ctx, input.path),
      detail: plural(splitLines(input.content).length, 'line'),
    };
  },
  async permission(input, ctx) {
    const plan = await planWrite(input, ctx);
    return { kind: 'write', paths: [plan.resolved] };
  },
  async preview(input, ctx) {
    const plan = await planWrite(input, ctx);
    return { diff: computeFileDiff(plan.resolved.display, plan.existing?.content, plan.content) };
  },
  async execute(input, ctx): Promise<ToolResult> {
    const plan = await planWrite(input, ctx);
    const { resolved, existing } = plan;
    const { display } = resolved;
    if (existing && !existing.lossy && existing.content === plan.content) {
      return {
        content: `No changes: ${display} already has this content.`,
        display: { summary: 'no changes' },
      };
    }
    const note = existing ? await preexistingChangesNote(ctx, resolved) : undefined;
    const snapshot = await writeResolvedFile(resolved, plan.content, {
      lineEnding: plan.lineEnding,
      bom: plan.bom,
    });
    ctx.fileState.recordWrite(resolved.absolute, snapshot);

    const diff = computeFileDiff(display, existing?.content, plan.content);
    const lineCount = splitLines(plan.content).length;
    const message = existing
      ? `Updated ${display} (+${diff.added} -${diff.removed}).`
      : `Created ${display} (${plural(lineCount, 'line')}).`;
    return {
      content: note ? `${message}\n${note}` : message,
      display: {
        diff,
        summary: existing ? `+${diff.added} -${diff.removed}` : plural(lineCount, 'line'),
      },
    };
  },
});
