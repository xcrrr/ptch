import { FileStateTracker } from '../../src/fs/file-state.js';
import { PathPolicy } from '../../src/fs/paths.js';
import { noopLogger, type Logger } from '../../src/logging/logger.js';
import type { ShellInfo } from '../../src/shell/shell.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../../src/tools/types.js';

export interface TestContextOptions {
  cwd: string;
  /** Defaults to `gitRoot ?? cwd`. */
  projectRoot?: string;
  gitRoot?: string | null;
  /** Defaults to a directory that does not exist, so `~` paths never touch the real home. */
  home?: string;
  signal?: AbortSignal;
  logger?: Logger;
}

const testShell: ShellInfo = {
  kind: 'bash',
  executable: 'bash',
  label: 'bash',
  argsFor: (command) => ['-c', command],
};

/** A ToolContext over a temp directory, with a fresh FileStateTracker. */
export function makeToolContext(options: TestContextOptions): ToolContext {
  const gitRoot = options.gitRoot ?? null;
  const projectRoot = options.projectRoot ?? gitRoot ?? options.cwd;
  const home = options.home ?? `${options.cwd}-home`;
  return {
    cwd: options.cwd,
    projectRoot,
    gitRoot,
    home,
    signal: options.signal ?? new AbortController().signal,
    paths: new PathPolicy({ cwd: options.cwd, projectRoot, home }),
    fileState: new FileStateTracker(),
    shell: testShell,
    logger: options.logger ?? noopLogger,
  };
}

/** A logger that keeps warnings and errors so tests can assert nothing unexpected happened. */
export function recordingLogger(): { logger: Logger; problems: string[] } {
  const problems: string[] = [];
  const logger: Logger = {
    ...noopLogger,
    warn: (message) => problems.push(`warn: ${message}`),
    error: (message) => problems.push(`error: ${message}`),
    child: () => logger,
  };
  return { logger, problems };
}

/** Runs a tool the way the agent does: input validation, permission subject, then execute. */
export async function runTool<Input>(
  tool: ToolDefinition<Input>,
  input: Input,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = tool.inputSchema.parse(input);
  await tool.permission(parsed, ctx);
  return tool.execute(parsed, ctx);
}

/** Line endings normalized, for assertions on tool output. */
export function lines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}
