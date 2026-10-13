import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandAnalysis } from '../../src/permissions/command-risk.js';
import { FileStateTracker } from '../../src/fs/file-state.js';
import { PathPolicy } from '../../src/fs/paths.js';
import { noopLogger, type Logger } from '../../src/logging/logger.js';
import { makeTempDir, writeFiles } from '../../src/testing/index.js';
import { bashInput, bashTool, DEFAULT_BASH_TIMEOUT_MS } from '../../src/tools/bash.js';
import { ToolError, type ToolContext, type ToolProgress } from '../../src/tools/types.js';
import { isPosixShell, NODE, node, shell } from '../shell/helpers.js';

const { analyzeCommand } = vi.hoisted(() => ({
  analyzeCommand: vi.fn((command: string): CommandAnalysis => ({
    command,
    risk: 'normal',
    reasons: ['Runs project code'],
    segments: [],
    unparsable: false,
  })),
}));

vi.mock('../../src/permissions/command-risk.js', () => ({ analyzeCommand }));

let dir: string;
let cleanup: () => void;

beforeEach(() => {
  ({ dir, cleanup } = makeTempDir('patch-bash-'));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  const home = homedir();
  return {
    cwd: dir,
    projectRoot: dir,
    gitRoot: null,
    home,
    signal: new AbortController().signal,
    paths: new PathPolicy({ cwd: dir, projectRoot: dir, home }),
    fileState: new FileStateTracker(),
    shell,
    logger: noopLogger,
    ...overrides,
  };
}

function input(command: string, extra: { description?: string; timeout_ms?: number } = {}) {
  return bashInput.parse({ command, ...extra });
}

describe('bash tool: summarize', () => {
  it('shows the command as the target and the description as detail', () => {
    expect(
      bashTool.summarize(input('pnpm test', { description: ' Run the unit tests ' }), context()),
    ).toEqual({
      verb: 'bash',
      target: 'pnpm test',
      detail: 'Run the unit tests',
    });
  });

  it('omits an empty description', () => {
    expect(bashTool.summarize(input('ls', { description: '  ' }), context())).toEqual({
      verb: 'bash',
      target: 'ls',
    });
  });

  it('uses the first line of a multi-line command', () => {
    expect(bashTool.summarize(input('\n  cd app &&\r\n  make\n'), context()).target).toBe(
      'cd app && …',
    );
  });

  it('caps the target at 200 characters', () => {
    const target = bashTool.summarize(input(`echo ${'x'.repeat(500)}`), context()).target;
    expect(target).toHaveLength(200);
    expect(target.endsWith('…')).toBe(true);
  });
});

describe('bash tool: permission', () => {
  it('describes an agent-initiated execution with the command analysis', async () => {
    const ctx = context({ cwd: dir, projectRoot: dir, home: '/home/dev' });
    const subject = await bashTool.permission(input('rm -rf build'), ctx);
    expect(analyzeCommand).toHaveBeenCalledWith('rm -rf build', {
      cwd: dir,
      projectRoot: dir,
      home: '/home/dev',
      shell: shell.kind,
    });
    expect(subject).toEqual({
      kind: 'execute',
      command: 'rm -rf build',
      analysis: analyzeCommand.mock.results[0]!.value,
      origin: 'agent',
    });
  });
});

describe('bash tool: input schema', () => {
  it('bounds the timeout', () => {
    expect(bashInput.safeParse({ command: 'ls', timeout_ms: 999 }).success).toBe(false);
    expect(bashInput.safeParse({ command: 'ls', timeout_ms: 600_001 }).success).toBe(false);
    expect(bashInput.safeParse({ command: 'ls', timeout_ms: 1.5e3 }).success).toBe(true);
    expect(DEFAULT_BASH_TIMEOUT_MS).toBe(120_000);
  });
});

describe.runIf(isPosixShell)('bash tool: execute', () => {
  it('returns the output of a successful command', async () => {
    const result = await bashTool.execute(input('echo hello'), context());
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/^Exit code 0 · \d+(?:ms|\.\ds)\n\nhello$/);
    expect(result.display?.summary).toMatch(/^1 line · /);
    expect(result.display?.lines).toBeUndefined();
    expect(result.display?.detail).toBe('hello');
  });

  it('runs in the context working directory', async () => {
    writeFiles(dir, { 'here.txt': 'x' });
    const result = await bashTool.execute(input('ls'), context());
    expect(result.content).toContain('here.txt');
  });

  it('reports a failing command as an error with the tail of its output', async () => {
    writeFiles(dir, {
      'fail.cjs': `for (let i = 1; i <= 6; i++) console.log('step ' + i);
                   console.error('Error: something broke');
                   process.exit(2);`,
    });
    const result = await bashTool.execute(input(node('fail.cjs')), context());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^Exit code 2 · /);
    expect(result.content).toContain('stdout:\nstep 1\n');
    expect(result.content).toContain('stderr:\nError: something broke');
    expect(result.display?.summary).toMatch(/^exit 2 · /);
    // Lines that explain the failure win over the plain end of the output.
    expect(result.display?.lines).toEqual(['Error: something broke']);
  });

  it('falls back to the last lines when no line explains the failure', async () => {
    writeFiles(dir, {
      'quiet.cjs': `for (let i = 1; i <= 6; i++) console.log('step ' + i);
                    process.exit(3);`,
    });
    const result = await bashTool.execute(input(node('quiet.cjs')), context());
    expect(result.display?.lines).toEqual(['step 3', 'step 4', 'step 5', 'step 6']);
  });

  it('summarizes test runner output', async () => {
    const result = await bashTool.execute(
      input(
        `echo ' Test Files  2 passed (2)'; echo '      Tests  42 passed | 1 failed (43)'; exit 1`,
      ),
      context(),
    );
    expect(result.isError).toBe(true);
    expect(result.display?.summary).toMatch(/^42 passed · 1 failed · /);
  });

  it('stops a command at its timeout and says so', async () => {
    const started = Date.now();
    const result = await bashTool.execute(
      input(`echo partial; ${NODE} -e 'setTimeout(() => {}, 60000)'`, { timeout_ms: 1000 }),
      context(),
    );
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(result.isError).toBe(true);
    expect(result.content).toBe('Command timed out after 1s and was stopped.\n\npartial');
    expect(result.display?.summary).toMatch(/^timed out · /);
  });

  it('stops a command when the turn is aborted', async () => {
    const controller = new AbortController();
    const ctx = context({
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    const result = await bashTool.execute(
      input(`echo started; ${NODE} -e 'setTimeout(() => {}, 60000)'`),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe('Command was interrupted by the user.\n\nstarted');
    expect(result.display?.summary).toMatch(/^interrupted · /);
  });

  it('streams a throttled live tail of the output', async () => {
    writeFiles(dir, {
      'ticker.cjs': `let i = 0;
                     const timer = setInterval(() => {
                       console.log('tick ' + ++i);
                       if (i === 40) clearInterval(timer);
                     }, 10);`,
    });
    const updates: Array<{ at: number; progress: ToolProgress }> = [];
    const result = await bashTool.execute(
      input(node('ticker.cjs')),
      context({ onProgress: (progress) => updates.push({ at: performance.now(), progress }) }),
    );
    const settled = updates.length;
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(result.isError).toBe(false);
    expect(updates.length).toBe(settled);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    // 40 lines over ~400ms would be ~40 updates unthrottled.
    expect(updates.length).toBeLessThan(15);
    for (let i = 1; i < updates.length; i++) {
      expect(updates[i]!.at - updates[i - 1]!.at).toBeGreaterThanOrEqual(90);
    }
    for (const { progress } of updates) {
      expect(progress.tail.length).toBeLessThanOrEqual(5);
      expect(progress.tail.at(-1)).toBe(`tick ${progress.totalLines}`);
    }
  });

  it('runs a command longer than the Git Bash command-line limit in full', async () => {
    // Git Bash used to cut such commands after ~8,190 characters and report exit code 0.
    const lines = Array.from(
      { length: 300 },
      (_, i) => `export const value${i} = 'zażółć ${'x'.repeat(20)}';`,
    );
    const command = [`cat > out.ts <<'EOF'`, ...lines, 'EOF', 'echo wrote out.ts'].join('\n');
    expect(command.length).toBeGreaterThan(10_000);

    const result = await bashTool.execute(input(command), context());
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/^Exit code 0 · .*\n\nwrote out\.ts$/);
    expect(readFileSync(join(dir, 'out.ts'), 'utf8')).toBe(`${lines.join('\n')}\n`);
  });

  it('keeps running when the progress callback throws', async () => {
    const warn = vi.fn();
    const logger: Logger = { ...noopLogger, warn };
    const result = await bashTool.execute(
      input('echo one'),
      context({
        logger,
        onProgress: () => {
          throw new Error('ui bug');
        },
      }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('one');
    expect(warn).toHaveBeenCalled();
  });
});

describe('bash tool: invalid calls', () => {
  it('rejects an empty command', async () => {
    await expect(bashTool.execute(input('   \n'), context())).rejects.toThrow(ToolError);
    await expect(bashTool.execute(input(''), context())).rejects.toThrow('The command is empty');
  });

  it('rejects a command containing a NUL character', async () => {
    await expect(bashTool.execute(input('echo a\0b'), context())).rejects.toThrow('NUL character');
  });

  it('turns a shell that cannot start into a ToolError', async () => {
    const missing = `${dir}/missing-shell`;
    const error = await bashTool
      .execute(input('echo hi'), context({ shell: { ...shell, executable: missing } }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).message).toBe(`Could not start shell ${missing}: ENOENT`);
  });
});
