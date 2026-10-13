import { truncateMiddle } from '@patch/shared';
import { z } from 'zod';
import { analyzeCommand } from '../permissions/command-risk.js';
import { LiveTail } from '../shell/live-tail.js';
import { formatCommandOutput } from '../shell/output.js';
import { runCommand, type CommandResult } from '../shell/process.js';
import { defineTool, ToolError, type ToolContext } from './types.js';

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 600_000;

const MAX_TARGET_CHARS = 200;
const PROGRESS_TAIL_LINES = 5;
/** ~10 progress updates per second at most. */
const PROGRESS_INTERVAL_MS = 100;
const FAILURE_TAIL_LINES = 4;
const DETAIL_MAX_LINES = 200;
const DETAIL_MAX_CHARS = 20_000;

export const bashInput = z.object({
  command: z.string().describe('The command to run.'),
  description: z
    .string()
    .optional()
    .describe('A short description of what the command does (5-10 words), shown to the user.'),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(MAX_BASH_TIMEOUT_MS)
    .optional()
    .describe(
      `Timeout in milliseconds (default ${DEFAULT_BASH_TIMEOUT_MS}, max ${MAX_BASH_TIMEOUT_MS}).`,
    ),
});

/**
 * Runs a command with runCommand() in ctx.cwd using ctx.shell, streaming a live tail to
 * ctx.onProgress (last 5 lines, throttled to ~10 updates/s). Never throws for non-zero exit: the
 * result is isError when exitCode !== 0, timed out, or aborted. Content via formatCommandOutput().
 * Display: verb "bash", target = the command (first line, ≤ 200 chars), detail = description;
 * summary like "42 passed · 1 failed · 8.1s", "exit 1 · 3.2s" or "done · 0.4s";
 * lines = tail of output on failure (≤ 4 lines); detail = truncated full output for expansion.
 * Permission subject: { kind: 'execute', command, analysis: analyzeCommand(...), origin: 'agent' }.
 */
export const bashTool = defineTool({
  name: 'bash',
  description:
    'Run a shell command in the working directory and return its stdout, stderr, and exit code. Commands run non-interactively (no TTY, no stdin): avoid prompts, pagers, editors, and watch modes. Each call starts a fresh shell, so use `cd <dir> && <command>` when needed. Prefer the dedicated read/search tools over cat, grep, or find.',
  inputSchema: bashInput,
  permissionClass: 'execute',
  summarize(input) {
    const description = input.description?.trim();
    return {
      verb: 'bash',
      target: commandTarget(input.command),
      ...(description ? { detail: description } : {}),
    };
  },
  permission(input, ctx) {
    return {
      kind: 'execute',
      command: input.command,
      analysis: analyzeCommand(input.command, {
        cwd: ctx.cwd,
        projectRoot: ctx.projectRoot,
        home: ctx.home,
        shell: ctx.shell.kind,
      }),
      origin: 'agent',
    };
  },
  async execute(input, ctx) {
    if (input.command.trim() === '') {
      throw new ToolError('The command is empty. Provide a shell command to run.');
    }
    if (input.command.includes('\0')) {
      throw new ToolError(
        'The command contains a NUL character, which cannot be passed to a shell.',
      );
    }
    const timeoutMs = input.timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS;
    const progress = ctx.onProgress ? new ProgressReporter(ctx) : undefined;
    let result: CommandResult;
    try {
      result = await runCommand(input.command, {
        shell: ctx.shell,
        cwd: ctx.cwd,
        timeoutMs,
        signal: ctx.signal,
        ...(progress ? { onOutput: progress.push } : {}),
      });
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error));
    } finally {
      progress?.stop();
    }

    const formatted = formatCommandOutput(result, { tailLines: FAILURE_TAIL_LINES, timeoutMs });
    const isError = result.exitCode !== 0 || result.timedOut || result.aborted;
    const detail = expandedOutput(result);
    return {
      content: formatted.content,
      isError,
      display: {
        summary: formatted.summary,
        ...(isError && formatted.tail.length > 0 ? { lines: formatted.tail } : {}),
        ...(detail ? { detail } : {}),
      },
    };
  },
});

/** First line of the command, marked with "…" when lines or characters were cut. */
function commandTarget(command: string): string {
  const lines = command.trim().split(/\r?\n/);
  const first = (lines[0] ?? '').trim();
  const suffix = lines.length > 1 ? ' …' : '';
  if (first.length + suffix.length <= MAX_TARGET_CHARS) return first + suffix;
  return `${first.slice(0, MAX_TARGET_CHARS - 1)}…`;
}

function expandedOutput(result: CommandResult): string | undefined {
  const text = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n');
  if (text === '') return undefined;
  return truncateMiddle(text, { maxLines: DETAIL_MAX_LINES, maxChars: DETAIL_MAX_CHARS }).text;
}

/** Feeds output into a LiveTail and reports it at most every PROGRESS_INTERVAL_MS. */
class ProgressReporter {
  private readonly tail = new LiveTail(PROGRESS_TAIL_LINES);
  private lastReport = Number.NEGATIVE_INFINITY;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly ctx: ToolContext) {}

  readonly push = (chunk: string, stream: 'stdout' | 'stderr'): void => {
    if (this.stopped) return;
    this.tail.push(chunk, stream);
    if (this.timer) return;
    const wait = this.lastReport + PROGRESS_INTERVAL_MS - performance.now();
    if (wait <= 0) this.report();
    else this.timer = setTimeout(() => this.report(), wait);
  };

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private report(): void {
    this.timer = undefined;
    this.lastReport = performance.now();
    try {
      this.ctx.onProgress?.(this.tail.snapshot());
    } catch (error) {
      this.ctx.logger.warn('bash progress callback failed', error);
    }
  }
}
