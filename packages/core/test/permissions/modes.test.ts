import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ResolvedPath } from '../../src/fs/paths.js';
import { analyzeCommand } from '../../src/permissions/command-risk.js';
import {
  PermissionManager,
  permissionClassOf,
  type PermissionDecision,
  type PermissionManagerOptions,
} from '../../src/permissions/manager.js';
import { PERMISSION_MODES, nextPermissionMode } from '../../src/permissions/modes.js';
import type { PermissionSubject } from '../../src/tools/types.js';

const root = path.join(tmpdir(), 'patch-modes-project');
const home = path.join(tmpdir(), 'patch-modes-home');
const outsideDir = path.join(tmpdir(), 'patch-modes-elsewhere');

function resolved(absolute: string, overrides: Partial<ResolvedPath> = {}): ResolvedPath {
  const insideProject = absolute === root || absolute.startsWith(root + path.sep);
  return {
    input: absolute,
    absolute,
    display: insideProject ? path.relative(root, absolute) || '.' : absolute,
    insideProject,
    exists: true,
    isDirectory: false,
    insideGitDir: false,
    ...overrides,
  };
}

const inside = (relative: string, overrides?: Partial<ResolvedPath>) =>
  resolved(path.join(root, relative), overrides);
const outside = (relative: string) => resolved(path.join(outsideDir, relative));

const read = (...paths: ResolvedPath[]): PermissionSubject => ({ kind: 'read', paths });
const write = (...paths: ResolvedPath[]): PermissionSubject => ({ kind: 'write', paths });
const run = (command: string, origin: 'agent' | 'user' = 'agent'): PermissionSubject => ({
  kind: 'execute',
  command,
  analysis: analyzeCommand(command, { cwd: root, projectRoot: root, home, shell: 'bash' }),
  origin,
});
const none: PermissionSubject = { kind: 'none' };

function manager(options?: PermissionManagerOptions): PermissionManager {
  return new PermissionManager(options);
}

function expectAsk(decision: PermissionDecision) {
  if (decision.type !== 'ask') throw new Error(`expected ask, got ${JSON.stringify(decision)}`);
  return decision.prompt;
}

/** A denial by plan mode, with its message for the model. */
function expectPlanDenial(decision: PermissionDecision, what: RegExp): void {
  if (decision.type !== 'deny') throw new Error(`expected deny, got ${JSON.stringify(decision)}`);
  expect(decision.reason).toBe('Plan mode (read-only)');
  expect(decision.message).toMatch(/^Plan mode is on: /);
  expect(decision.message).toMatch(what);
  expect(decision.message).toContain('present your plan with present_plan instead');
}

describe('permission modes', () => {
  it('cycle default → acceptEdits → plan → auto → default', () => {
    expect(PERMISSION_MODES).toEqual(['default', 'acceptEdits', 'plan', 'auto']);
    expect(nextPermissionMode('default')).toBe('acceptEdits');
    expect(nextPermissionMode('acceptEdits')).toBe('plan');
    expect(nextPermissionMode('plan')).toBe('auto');
    expect(nextPermissionMode('auto')).toBe('default');
  });

  it('start in the default mode unless told otherwise, and switch for later calls', () => {
    const permissions = manager();
    expect(permissions.mode).toBe('default');
    expect(manager({ mode: 'plan' }).mode).toBe('plan');
    expectAsk(permissions.evaluate(write(inside('src/a.ts'))));
    permissions.setMode('plan');
    expect(permissions.evaluate(write(inside('src/a.ts'))).type).toBe('deny');
    permissions.setMode('default');
    expectAsk(permissions.evaluate(write(inside('src/a.ts'))));
  });

  it('map subjects to their permission class', () => {
    expect(permissionClassOf(read(inside('a')))).toBe('read');
    expect(permissionClassOf(write(inside('a')))).toBe('write');
    expect(permissionClassOf(run('ls'))).toBe('execute');
    expect(permissionClassOf(none)).toBe('none');
  });

  it('allow calls that touch nothing outside Patch in every mode', () => {
    for (const mode of PERMISSION_MODES) {
      expect(manager({ mode }).evaluate(none)).toEqual({
        type: 'allow',
        reason: 'Nothing to approve',
      });
      expect(manager({ mode }).evaluate(none, 'none').type).toBe('allow');
    }
  });
});

describe('acceptEdits mode', () => {
  const accepting = () => manager({ mode: 'acceptEdits' });

  it('allows edits inside the project like "Yes, allow all edits this session"', () => {
    expect(accepting().evaluate(write(inside('src/a.ts')))).toEqual({
      type: 'allow',
      reason: 'Accepting edits (permission mode)',
    });
    expect(
      accepting().evaluate(write(inside('src/a.ts'), inside('src/b.ts', { exists: false }))).type,
    ).toBe('allow');
    // The same reach as the all-edits grant.
    const granted = manager();
    granted.grant({ kind: 'all-edits' });
    for (const subject of [
      write(inside('src/a.ts')),
      write(outside('notes.txt')),
      write(inside('.env', { sensitive: 'Environment file' })),
    ]) {
      expect(accepting().evaluate(subject).type).toBe(granted.evaluate(subject).type);
    }
  });

  it('still asks before writing outside the project or to sensitive files', () => {
    const outsidePrompt = expectAsk(accepting().evaluate(write(outside('notes.txt'))));
    expect(outsidePrompt.severity).toBe('danger');
    expect(outsidePrompt.sessionOption).toBeUndefined();
    const sensitive = expectAsk(
      accepting().evaluate(write(inside('.env', { sensitive: 'Environment file' }))),
    );
    expect(sensitive.severity).toBe('warning');
    expect(sensitive.sessionOption).toBeUndefined();
    // One file outside makes the whole call ask.
    expectAsk(accepting().evaluate(write(inside('src/a.ts'), outside('notes.txt'))));
  });

  it('never writes inside .git and keeps deny rules', () => {
    const git = accepting().evaluate(write(inside('.git/config', { insideGitDir: true })));
    expect(git).toMatchObject({ type: 'deny', reason: 'Inside .git' });
    const denied = manager({ mode: 'acceptEdits', config: { allow: [], deny: ['edit'] } });
    expect(denied.evaluate(write(inside('src/a.ts')))).toMatchObject({
      type: 'deny',
      reason: 'Denied by configuration rule "edit"',
    });
  });

  it('leaves commands and reads as they are', () => {
    expectAsk(accepting().evaluate(run('pnpm test')));
    expect(expectAsk(accepting().evaluate(run('rm -rf dist'))).severity).toBe('danger');
    expect(accepting().evaluate(run('ls src')).type).toBe('allow');
    expect(accepting().evaluate(read(inside('src/a.ts'))).type).toBe('allow');
    expectAsk(accepting().evaluate(read(outside('notes.txt'))));
  });

  it('leaves no grant behind when the mode changes back', () => {
    const permissions = accepting();
    expect(permissions.evaluate(write(inside('src/a.ts'))).type).toBe('allow');
    permissions.setMode('default');
    expectAsk(permissions.evaluate(write(inside('src/a.ts'))));
    expect(permissions.sessionGrants()).toEqual([]);
  });
});

describe('plan mode', () => {
  const planning = (options: PermissionManagerOptions = {}) =>
    manager({ ...options, mode: 'plan' });

  it('denies every write without asking, whatever grants and allow rules say', () => {
    expectPlanDenial(planning().evaluate(write(inside('src/a.ts'))), /files cannot be edited/);
    expectPlanDenial(
      planning().evaluate(write(inside('new.ts', { exists: false }))),
      /cannot be edited/,
    );
    expectPlanDenial(planning().evaluate(write(outside('notes.txt'))), /cannot be edited/);
    const granted = planning({
      config: { allow: ['edit'], deny: [] },
      flags: { allow: ['edit'], deny: [] },
    });
    granted.grant({ kind: 'all-edits' });
    expectPlanDenial(granted.evaluate(write(inside('src/a.ts'))), /cannot be edited/);
  });

  it('runs read-only commands that pass the strict gate', () => {
    for (const command of [
      'ls',
      'ls -la src',
      'cat src/a.ts',
      'git status',
      'git diff --stat',
      'git log --oneline -5',
      'rg foo src',
      'grep -n TODO src/a.ts',
      'cat src/a.ts | wc -l',
      'node --version',
    ]) {
      const decision = planning().evaluate(run(command));
      expect(decision, command).toEqual({ type: 'allow', reason: 'Read-only command' });
    }
  });

  it('denies other commands without asking, also when a rule or grant would allow them', () => {
    for (const command of [
      'pnpm test',
      'npm run build',
      'mkdir out',
      'touch a.txt',
      'echo hi > out.txt',
      'git commit -m x',
      'curl https://example.com',
      'rm -rf dist',
      'git push',
      // Read-only programs the strict gate does not let run without asking.
      'ls $HOME',
      'cat src/*.ts',
      'git diff HEAD~1',
      'python -c "print(1)"',
    ]) {
      expectPlanDenial(planning().evaluate(run(command)), /only read-only commands run/);
    }
    const allowed = planning({ config: { allow: ['bash:pnpm test', 'bash:*'], deny: [] } });
    allowed.grant({ kind: 'command-prefix', prefix: 'npm run build' });
    expectPlanDenial(allowed.evaluate(run('pnpm test')), /read-only commands/);
    expectPlanDenial(allowed.evaluate(run('npm run build')), /read-only commands/);
  });

  it('keeps denials of their own: deny rules, blocked commands and .git', () => {
    const rules = planning({ config: { allow: [], deny: ['bash:git log', 'edit'] } });
    expect(rules.evaluate(run('git log'))).toMatchObject({
      type: 'deny',
      reason: 'Denied by configuration rule "bash:git log"',
    });
    expect(rules.evaluate(write(inside('src/a.ts')))).toMatchObject({
      type: 'deny',
      reason: 'Denied by configuration rule "edit"',
    });
    expect(planning().evaluate(run('sudo ls'))).toMatchObject({
      type: 'deny',
      reason: expect.stringMatching(/^Blocked/),
    });
    expect(
      planning().evaluate(write(inside('.git/hooks/pre-commit', { insideGitDir: true }))),
    ).toMatchObject({ type: 'deny', reason: 'Inside .git' });
  });

  it('lets reads follow the regular rules', () => {
    expect(planning().evaluate(read(inside('src/a.ts')))).toEqual({
      type: 'allow',
      reason: 'Inside the project',
    });
    expect(expectAsk(planning().evaluate(read(outside('notes.txt')))).title).toBe(
      'Patch wants to read outside the project',
    );
    expectAsk(planning().evaluate(read(inside('.env', { sensitive: 'Environment file' }))));
    const granted = planning();
    granted.grant({ kind: 'read-path', path: outsideDir });
    expect(granted.evaluate(read(outside('notes.txt'))).type).toBe('allow');
  });

  it("leaves the user's own ! commands to the regular rules", () => {
    expect(planning().evaluate(run('pnpm test', 'user'))).toEqual({
      type: 'allow',
      reason: 'typed by the user',
    });
    expectAsk(planning().evaluate(run('rm -rf dist', 'user')));
  });

  it('goes by the stricter of the tool class and the subject, so new tools are covered', () => {
    // An execute-class tool (an MCP tool, say) is denied whatever its subject.
    expectPlanDenial(
      planning().evaluate(read(inside('src/a.ts')), 'execute'),
      /tools that could change something do not run/,
    );
    expectPlanDenial(planning().evaluate(none, 'execute'), /tools that could change something/);
    // A write-class tool too.
    expectPlanDenial(planning().evaluate(read(inside('src/a.ts')), 'write'), /cannot be edited/);
    // A read-only command from an execute-class tool still runs.
    expect(planning().evaluate(run('git status'), 'execute').type).toBe('allow');
    // A tool claiming a lesser class than its subject is held to the subject.
    expectPlanDenial(planning().evaluate(run('pnpm test'), 'read'), /read-only commands/);
    expectPlanDenial(planning().evaluate(write(inside('a.ts')), 'none'), /cannot be edited/);
    // Read and none classes keep the regular decision.
    expect(planning().evaluate(read(inside('src/a.ts')), 'read').type).toBe('allow');
    expectAsk(planning().evaluate(read(outside('notes.txt')), 'read'));
    expect(planning().evaluate(none, 'none').type).toBe('allow');
  });

  it('is listed by /permissions, as accepting edits is', () => {
    const descriptions = (permissions: PermissionManager) =>
      permissions.listRules().map((rule) => `${rule.effect} ${rule.source}: ${rule.description}`);
    expect(descriptions(planning())).toContain(
      'deny session: Deny: edits, and commands that are not read-only (plan mode)',
    );
    expect(descriptions(manager({ mode: 'acceptEdits' }))).toContain(
      'allow session: Allow: editing files inside the project (accepting edits)',
    );
    expect(descriptions(manager()).some((line) => line.includes('mode)'))).toBe(false);
  });
});
