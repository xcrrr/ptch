import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ResolvedPath } from '../../src/fs/paths.js';
import { analyzeCommand } from '../../src/permissions/command-risk.js';
import {
  PermissionManager,
  validateRules,
  type PermissionDecision,
  type PermissionManagerOptions,
} from '../../src/permissions/manager.js';
import type { PermissionSubject } from '../../src/tools/types.js';

const root = path.join(tmpdir(), 'patch-manager-project');
const home = path.join(tmpdir(), 'patch-manager-home');
const outsideDir = path.join(tmpdir(), 'patch-manager-elsewhere');

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
const outside = (relative: string, overrides?: Partial<ResolvedPath>) =>
  resolved(path.join(outsideDir, relative), overrides);

const read = (...paths: ResolvedPath[]): PermissionSubject => ({ kind: 'read', paths });
const write = (...paths: ResolvedPath[]): PermissionSubject => ({ kind: 'write', paths });
const run = (command: string, origin: 'agent' | 'user' = 'agent'): PermissionSubject => ({
  kind: 'execute',
  command,
  analysis: analyzeCommand(command, { cwd: root, projectRoot: root, home }),
  origin,
});

function manager(options?: PermissionManagerOptions): PermissionManager {
  return new PermissionManager(options);
}

function expectAsk(decision: PermissionDecision) {
  if (decision.type !== 'ask') throw new Error(`expected ask, got ${JSON.stringify(decision)}`);
  return decision.prompt;
}

describe('PermissionManager session grants and protected files', () => {
  it('does not let a program grant cover writes inside .git', () => {
    const permissions = manager();
    permissions.grant({ kind: 'command-prefix', prefix: 'cp' });
    permissions.grant({ kind: 'command-prefix', prefix: 'echo' });
    expect(permissions.evaluate(run('cp a.txt b.txt')).type).toBe('allow');
    for (const command of [
      'cp evil.sh .git/hooks/pre-commit',
      'cd .git && echo x > hooks/pre-commit',
      'echo x > .gi?/config',
    ]) {
      const prompt = expectAsk(permissions.evaluate(run(command)));
      expect(prompt.reason, command).toMatch(/\.git directory/);
      expect(prompt.sessionOption, command).toBeUndefined();
    }
  });

  it('does not let a program grant cover reads of secret files', () => {
    const permissions = manager();
    permissions.grant({ kind: 'command-prefix', prefix: 'cat' });
    permissions.grant({ kind: 'command-prefix', prefix: 'grep' });
    for (const command of ['cat .en*', 'cat < .env', 'grep -r KEY .', 'cat a | grep -r KEY']) {
      const prompt = expectAsk(permissions.evaluate(run(command)));
      expect(prompt.reason, command).toMatch(/secrets/);
      expect(prompt.sessionOption, command).toBeUndefined();
    }
  });
});

describe('PermissionManager reads', () => {
  it('allows non-sensitive reads inside the project', () => {
    expect(manager().evaluate(read(inside('src/a.ts')))).toEqual({
      type: 'allow',
      reason: 'Inside the project',
    });
  });

  it('asks before reading outside the project and offers the containing directory', () => {
    const file = outside('notes/todo.txt');
    const prompt = expectAsk(manager().evaluate(read(file)));
    expect(prompt).toEqual({
      title: 'Patch wants to read outside the project',
      subjectLine: file.display,
      severity: 'normal',
      reason: 'Outside the project root',
      sessionOption: {
        label: `Yes, allow reading ${path.dirname(file.display)} this session`,
        grant: { kind: 'read-path', path: path.dirname(file.absolute) },
      },
    });
  });

  it('offers the directory itself when reading a directory', () => {
    const directory = outside('notes', { isDirectory: true });
    const prompt = expectAsk(manager().evaluate(read(directory)));
    expect(prompt.sessionOption?.grant).toEqual({ kind: 'read-path', path: directory.absolute });
    expect(prompt.sessionOption?.label).toBe(
      `Yes, allow reading ${directory.display} this session`,
    );
  });

  it('asks before reading sensitive files and offers only that file', () => {
    const env = inside('.env', { sensitive: 'Environment file' });
    const prompt = expectAsk(manager().evaluate(read(env)));
    expect(prompt).toEqual({
      title: 'Patch wants to read a sensitive file',
      subjectLine: '.env',
      severity: 'warning',
      reason: 'This file may contain secrets. Its contents will be sent to the model provider.',
      sessionOption: {
        label: 'Yes, allow reading .env this session',
        grant: { kind: 'read-path', path: env.absolute },
      },
    });
  });

  it('applies read-path grants to files under the directory but not to other sensitive files', () => {
    const permissions = manager();
    permissions.grant({ kind: 'read-path', path: path.join(outsideDir, 'notes') });
    expect(permissions.evaluate(read(outside('notes/deep/a.txt'))).type).toBe('allow');
    expect(permissions.evaluate(read(outside('other/a.txt'))).type).toBe('ask');
    const secret = outside('notes/.env', { sensitive: 'Environment file' });
    expect(permissions.evaluate(read(secret)).type).toBe('ask');
    permissions.grant({ kind: 'read-path', path: secret.absolute });
    expect(permissions.evaluate(read(secret))).toEqual({
      type: 'allow',
      reason: `Allowed for this session (reading ${secret.absolute})`,
    });
  });

  it('does not let a sibling directory with a common prefix match a grant', () => {
    const permissions = manager();
    permissions.grant({ kind: 'read-path', path: path.join(outsideDir, 'notes') });
    expect(permissions.evaluate(read(outside('notes-private/a.txt'))).type).toBe('ask');
  });

  it('honors read rules from config, with deny winning even inside the project', () => {
    const permissions = manager({
      config: { allow: [`read:${outsideDir}`], deny: [`read:${path.join(root, 'private')}`] },
    });
    expect(permissions.evaluate(read(outside('a.txt')))).toEqual({
      type: 'allow',
      reason: `Allowed by configuration rule "read:${outsideDir}"`,
    });
    expect(permissions.evaluate(read(inside('private/key.txt')))).toEqual({
      type: 'deny',
      reason: `Denied by configuration rule "read:${path.join(root, 'private')}"`,
      message: `This action is denied by the user's Patch configuration (rule read:${path.join(root, 'private')}).`,
    });
  });
});

describe('PermissionManager writes', () => {
  it('asks to edit or create files inside the project with an all-edits option', () => {
    expect(expectAsk(manager().evaluate(write(inside('src/a.ts'))))).toEqual({
      title: `Patch wants to edit ${path.join('src', 'a.ts')}`,
      subjectLine: path.join('src', 'a.ts'),
      severity: 'normal',
      sessionOption: { label: 'Yes, allow all edits this session', grant: { kind: 'all-edits' } },
    });
    expect(expectAsk(manager().evaluate(write(inside('new.ts', { exists: false })))).title).toBe(
      'Patch wants to create new.ts',
    );
  });

  it('asks with danger and no session option when writing outside the project', () => {
    const prompt = expectAsk(manager().evaluate(write(outside('x.txt'))));
    expect(prompt.title).toBe('Patch wants to write outside the project');
    expect(prompt.severity).toBe('danger');
    expect(prompt.sessionOption).toBeUndefined();
  });

  it('asks with a warning and no session option for sensitive files', () => {
    const prompt = expectAsk(
      manager().evaluate(write(inside('.env', { sensitive: 'Environment file' }))),
    );
    expect(prompt.severity).toBe('warning');
    expect(prompt.sessionOption).toBeUndefined();
    expect(prompt.reason).toBe('This file may contain secrets.');
  });

  it('denies writes inside .git regardless of grants and rules', () => {
    const permissions = manager({ config: { allow: ['edit', 'bash:*'], deny: [] } });
    permissions.grant({ kind: 'all-edits' });
    expect(permissions.evaluate(write(inside('.git/config', { insideGitDir: true })))).toEqual({
      type: 'deny',
      reason: 'Inside .git',
      message: 'Patch does not modify files inside .git. Use git commands instead.',
    });
  });

  it('applies the all-edits grant only to non-sensitive files inside the project', () => {
    const permissions = manager();
    permissions.grant({ kind: 'all-edits' });
    expect(permissions.evaluate(write(inside('src/a.ts')))).toEqual({
      type: 'allow',
      reason: 'Allowed for this session (all edits)',
    });
    expect(permissions.evaluate(write(outside('a.ts'))).type).toBe('ask');
    expect(
      permissions.evaluate(write(inside('.env', { sensitive: 'Environment file' }))).type,
    ).toBe('ask');
  });

  it('honors edit rules from config and flags; deny wins', () => {
    expect(
      manager({ flags: { allow: ['edit'], deny: [] } }).evaluate(write(inside('a.ts'))),
    ).toEqual({
      type: 'allow',
      reason: 'Allowed by command-line rule "edit"',
    });
    const denied = manager({
      config: { allow: ['edit'], deny: [] },
      flags: { allow: [], deny: ['edit'] },
    });
    expect(denied.evaluate(write(inside('a.ts')))).toEqual({
      type: 'deny',
      reason: 'Denied by command-line rule "edit"',
      message: "This action is denied by the user's Patch configuration (rule edit).",
    });
  });

  it('combines several paths into one decision', () => {
    const permissions = manager();
    expect(permissions.evaluate(write())).toEqual({ type: 'allow', reason: 'No files involved' });
    const both = expectAsk(
      permissions.evaluate(write(inside('a.ts'), inside('b.ts', { exists: false }))),
    );
    expect(both.title).toBe('Patch wants to edit 2 files');
    expect(both.subjectLine).toBe('a.ts, b.ts');
    expect(both.sessionOption?.grant).toEqual({ kind: 'all-edits' });
    const mixed = expectAsk(permissions.evaluate(write(inside('a.ts'), outside('b.ts'))));
    expect(mixed.severity).toBe('danger');
    expect(mixed.sessionOption).toBeUndefined();
    const withGit = permissions.evaluate(
      write(inside('a.ts'), inside('.git/HEAD', { insideGitDir: true })),
    );
    expect(withGit.type).toBe('deny');
  });
});

describe('PermissionManager commands', () => {
  it('allows safe commands and asks for normal ones with a session option', () => {
    const permissions = manager();
    expect(permissions.evaluate(run('git status'))).toEqual({
      type: 'allow',
      reason: 'Read-only command',
    });
    expect(expectAsk(permissions.evaluate(run('pnpm test -- --run foo')))).toEqual({
      title: 'Patch wants to run a command',
      subjectLine: 'pnpm test -- --run foo',
      severity: 'normal',
      reason: 'Runs package scripts or tooling (pnpm test)',
      sessionOption: {
        label: 'Yes, and don\'t ask again for "pnpm test" this session',
        grant: { kind: 'command-prefix', prefix: 'pnpm test', options: [], variables: [] },
      },
    });
  });

  it('marks network commands with a warning', () => {
    const prompt = expectAsk(manager().evaluate(run('npm install')));
    expect(prompt.title).toBe('Patch wants to run a command that uses the network');
    expect(prompt.severity).toBe('warning');
    expect(prompt.sessionOption?.grant).toEqual({
      kind: 'command-prefix',
      prefix: 'npm install',
      options: [],
      variables: [],
    });
  });

  it('asks every time for destructive commands, without a session option', () => {
    expect(expectAsk(manager().evaluate(run('rm -rf dist')))).toEqual({
      title: 'Potentially destructive command',
      subjectLine: 'rm -rf dist',
      severity: 'danger',
      reason: 'Deletes files (rm)',
    });
  });

  it('omits the session option when the command cannot be remembered', () => {
    for (const command of [
      'cat $(ls)',
      'pnpm test "oops',
      'pnpm test && rm -rf dist',
      'pnpm test && cat $(ls)',
      'cat /etc/passwd',
      // Prefixes that would normalize to empty can never match, so no option is offered.
      '""',
      '"" 5 -xf sed',
      '" " foo',
    ]) {
      expect(expectAsk(manager().evaluate(run(command))).sessionOption, command).toBeUndefined();
    }
  });

  it('offers one session option per prefix for a chained command of rememberable segments', () => {
    const prompt = expectAsk(manager().evaluate(run('git add . && git commit -m x')));
    expect(prompt.sessionOption?.grants).toEqual([
      { kind: 'command-prefix', prefix: 'git add', options: [], variables: [] },
      { kind: 'command-prefix', prefix: 'git commit', options: ['-m'], variables: [] },
    ]);
    expect(prompt.sessionOption?.label).toBe(
      'Yes, and don\'t ask again for "git add" and "git commit" this session',
    );
    // Granting the option (both prefixes) then covers the chained command.
    const permissions = manager();
    for (const grant of prompt.sessionOption?.grants ?? []) permissions.grant(grant);
    expect(permissions.evaluate(run('git add . && git commit -m x')).type).toBe('allow');
  });

  it('denies blocked commands with an explanation for the model', () => {
    expect(manager().evaluate(run('sudo rm x'))).toEqual({
      type: 'deny',
      reason: 'Blocked: Requires elevated privileges (sudo)',
      message:
        'This command was blocked: Requires elevated privileges (sudo). Patch never runs commands that require elevated privileges or perform system-level destructive operations. If it is truly needed, tell the user the exact command to run themselves.',
    });
  });

  it('handles user-typed commands', () => {
    const permissions = manager();
    for (const command of ['ls', 'pnpm test', 'curl https://example.com']) {
      expect(permissions.evaluate(run(command, 'user'))).toEqual({
        type: 'allow',
        reason: 'typed by the user',
      });
    }
    const prompt = expectAsk(permissions.evaluate(run('git push --force', 'user')));
    expect(prompt).toMatchObject({ title: 'Potentially destructive command', severity: 'danger' });
    expect(prompt.sessionOption).toBeUndefined();
    expect(permissions.evaluate(run('sudo apt install x', 'user'))).toMatchObject({
      type: 'deny',
      message:
        'Patch does not run commands that require elevated privileges. Run it in your own terminal.',
    });
  });

  it('applies config deny rules to user-typed commands', () => {
    const permissions = manager({ config: { allow: [], deny: ['bash:git push'] } });
    expect(permissions.evaluate(run('git push', 'user')).type).toBe('deny');
  });
});

describe('PermissionManager command grants', () => {
  it('allows commands covered by a session prefix grant on a word boundary', () => {
    const permissions = manager();
    permissions.grant({ kind: 'command-prefix', prefix: 'pnpm test' });
    expect(permissions.evaluate(run('pnpm test --run foo'))).toEqual({
      type: 'allow',
      reason: 'Allowed for this session ("pnpm test")',
    });
    expect(permissions.evaluate(run('cd sub && pnpm test')).type).toBe('allow');
    expect(permissions.evaluate(run('FOO=1 timeout 60 pnpm test')).type).toBe('allow');
    expect(permissions.evaluate(run('pnpm testing')).type).toBe('ask');
  });

  it('requires every segment of a compound command to be covered', () => {
    const permissions = manager();
    permissions.grant({ kind: 'command-prefix', prefix: 'pnpm test' });
    expect(permissions.evaluate(run('pnpm test && pnpm lint')).type).toBe('ask');
    permissions.grant({ kind: 'command-prefix', prefix: 'pnpm lint' });
    expect(permissions.evaluate(run('pnpm test && pnpm lint')).type).toBe('allow');
    expect(permissions.evaluate(run('pnpm test | tee out.log')).type).toBe('ask');
  });

  it('never lets session grants cover destructive or unrememberable commands', () => {
    const permissions = manager();
    permissions.grant({ kind: 'command-prefix', prefix: 'git' });
    permissions.grant({ kind: 'command-prefix', prefix: 'pnpm test' });
    permissions.grant({ kind: 'command-prefix', prefix: 'cat' });
    expect(permissions.evaluate(run('git push')).type).toBe('ask');
    expect(permissions.evaluate(run('pnpm test && rm -rf dist')).type).toBe('ask');
    expect(permissions.evaluate(run('pnpm test $(ls)')).type).toBe('ask');
    expect(permissions.evaluate(run('cat ~/.ssh/config')).type).toBe('ask');
    expect(permissions.evaluate(run('pnpm test "oops')).type).toBe('ask');
  });

  it('does not let an interpreter or shell grant cover inline code or stdin scripts', () => {
    const permissions = manager();
    permissions.grant({ kind: 'command-prefix', prefix: 'node script.js' });
    permissions.grant({ kind: 'command-prefix', prefix: 'python manage.py' });
    permissions.grant({ kind: 'command-prefix', prefix: 'bash' });
    expect(permissions.evaluate(run('node script.js')).type).toBe('allow');
    expect(permissions.evaluate(run('node -e "process.exit()"')).type).toBe('ask');
    expect(permissions.evaluate(run('node other.js')).type).toBe('ask');
    expect(permissions.evaluate(run('python manage.py migrate')).type).toBe('allow');
    expect(permissions.evaluate(run('python -c "import os"')).type).toBe('ask');
    expect(permissions.evaluate(run('bash build.sh')).type).toBe('allow');
    for (const command of ['cat x | bash', 'base64 -d <<< X | bash', 'bash < f', 'bash -s < f']) {
      expect(permissions.evaluate(run(command)).type, command).toBe('ask');
    }
    expect(permissions.evaluate(run('bash <<< "rm -rf ~"')).type).toBe('deny');
  });

  it('does not let a project-tool grant cover options that run an arbitrary command', () => {
    const grants = ['go test', 'cargo test', 'make test', 'npm test'];
    const permissions = manager();
    for (const prefix of grants) permissions.grant({ kind: 'command-prefix', prefix });
    // The ordinary command the user approved stays allowed.
    expect(permissions.evaluate(run('go test ./...')).type).toBe('allow');
    expect(permissions.evaluate(run('cargo test')).type).toBe('allow');
    expect(permissions.evaluate(run('make test')).type).toBe('allow');
    expect(permissions.evaluate(run('npm test')).type).toBe('allow');
    // Options that make the tool run an arbitrary command are not covered.
    for (const command of [
      "go test -exec 'rm -rf /home/user' ./...",
      "go test -toolexec 'sh -c x' ./...",
      'cargo test --config build.rustc-wrapper=/bin/evil',
      'make test SHELL=/bin/evil',
      'npm test --node-options=--import=data:text/javascript,1',
      'npm run build --script-shell=sh',
    ]) {
      expect(permissions.evaluate(run(command)).type, command).toBe('ask');
    }
  });

  it('does not let a network-tool grant cover options that run local code or load config', () => {
    const permissions = manager();
    for (const prefix of ['ssh', 'scp', 'rsync', 'curl', 'wget']) {
      permissions.grant({ kind: 'command-prefix', prefix });
    }
    // The ordinary approved commands stay allowed.
    // Network tools are never remembered: even the plain commands ask again (strict gate).
    expect(permissions.evaluate(run('ssh -T git@github.com')).type).toBe('ask');
    expect(permissions.evaluate(run('rsync -a src/ backup/')).type).toBe('ask');
    expect(permissions.evaluate(run('curl https://example.com')).type).toBe('ask');
    expect(permissions.evaluate(run('wget https://x')).type).toBe('ask');
    // Options that run a local command, load a config file, or name a transfer program are not.
    for (const command of [
      "ssh -o ProxyCommand='sh -c x' host",
      'ssh -o PermitLocalCommand=yes -o LocalCommand=rm host',
      'ssh -o KnownHostsCommand=evil host',
      'ssh -F /tmp/cfg host',
      'ssh -oProxyCommand=evil host',
      'scp -S ./payload.sh a host:b',
      "rsync -e 'sh -c x' a host:b",
      'rsync --rsync-path=/bin/evil a host:b',
      'curl -K cfg https://x',
      'curl --config cfg https://x',
      'wget -e output_document=/home/user/.bashrc https://x',
      'wget --execute=output_document=x https://x',
    ]) {
      expect(permissions.evaluate(run(command)).type, command).toBe('ask');
    }
  });

  it('does not let a docker run grant cover privileged or host-mount options', () => {
    const permissions = manager();
    permissions.grant({ kind: 'command-prefix', prefix: 'docker run' });
    permissions.grant({ kind: 'command-prefix', prefix: 'docker exec' });
    // Container runs are never remembered (strict gate): each one asks.
    expect(permissions.evaluate(run('docker run --rm alpine echo hi')).type).toBe('ask');
    expect(permissions.evaluate(run('docker run --rm -v .:/app alpine sh')).type).toBe('ask');
    expect(permissions.evaluate(run('docker run --rm -p 3000:3000 myapp')).type).toBe('ask');
    for (const command of [
      'docker run --rm --privileged alpine sh',
      'docker run --rm --mount type=bind,src=/,dst=/host alpine sh',
      'docker run --rm --mount type=bind,source=/etc,target=/host alpine sh',
      'docker run --pid=host --privileged alpine nsenter',
      'docker run --rm --cap-add=ALL alpine sh',
      'docker run --rm --security-opt seccomp=unconfined alpine sh',
      'docker run --rm --userns=host alpine sh',
      'docker run --rm --network=host alpine sh',
      'docker run --rm -v ..:/x alpine sh',
      'docker run --rm -v /etc:/host alpine sh',
      'docker run --rm --volumes-from other alpine sh',
      'docker run --rm -u root alpine sh',
      'docker exec -u root app sh',
      'docker exec --privileged app sh',
    ]) {
      expect(permissions.evaluate(run(command)).type, command).toBe('ask');
    }
  });

  it('does not let a grant cover a script that redefines the granted program', () => {
    const permissions = manager();
    permissions.grant({ kind: 'command-prefix', prefix: 'pnpm test' });
    expect(permissions.evaluate(run('pnpm test')).type).toBe('allow');
    // A function that redefines pnpm as a fork bomb, and a plain fork bomb, must not slip through.
    expect(permissions.evaluate(run('pnpm(){ pnpm test & pnpm test & }; pnpm test')).type).not.toBe(
      'allow',
    );
    expect(permissions.evaluate(run('pnpm test; :(){ :&:& };:')).type).not.toBe('allow');
    expect(permissions.evaluate(run(':(){ :&:& };:')).type).toBe('deny');
  });

  it('allows commands covered by config and flag prefix rules, including destructive ones', () => {
    const permissions = manager({
      config: { allow: ['bash:pnpm test'], deny: [] },
      flags: { allow: ['bash:git push'], deny: [] },
    });
    expect(permissions.evaluate(run('pnpm test'))).toEqual({
      type: 'allow',
      reason: 'Allowed by configuration rule "bash:pnpm test"',
    });
    expect(permissions.evaluate(run('git push origin main'))).toEqual({
      type: 'allow',
      reason: 'Allowed by command-line rule "bash:git push"',
    });
    expect(permissions.evaluate(run('pnpm test && git push')).type).toBe('allow');
    expect(permissions.evaluate(run('pnpm test && rm x')).type).toBe('ask');
  });

  it('lets deny rules win over allow rules and match every spelling of the command', () => {
    const permissions = manager({
      config: { allow: ['bash:*', 'bash:git'], deny: ['bash:git push'] },
    });
    for (const command of [
      'git push',
      'git -C . push origin',
      'cd x && git push',
      'bash -c "git push"',
      'env git push',
    ]) {
      expect(permissions.evaluate(run(command)), command).toEqual({
        type: 'deny',
        reason: 'Denied by configuration rule "bash:git push"',
        message: "This action is denied by the user's Patch configuration (rule bash:git push).",
      });
    }
    expect(permissions.evaluate(run('git status')).type).toBe('allow');
  });

  it('allows everything but blocked commands with bash:*', () => {
    const permissions = manager({ flags: { allow: ['bash:*'], deny: [] } });
    expect(permissions.evaluate(run('rm -rf dist'))).toEqual({
      type: 'allow',
      reason: 'Allowed by command-line rule "bash:*"',
    });
    expect(permissions.evaluate(run('echo "unbalanced')).type).toBe('allow');
    expect(permissions.evaluate(run('sudo ls')).type).toBe('deny');
    expect(permissions.evaluate(run('rm -rf /')).type).toBe('deny');
  });

  it('never allows blocked commands, whatever the rules and grants', () => {
    const permissions = manager({
      config: { allow: ['bash:*', 'bash:sudo'], deny: [] },
      flags: { allow: ['bash:*', 'bash:sudo ls'], deny: [] },
    });
    permissions.grant({ kind: 'command-prefix', prefix: 'sudo' });
    for (const command of ['sudo ls', 'shutdown -h now', ':(){ :|:& };:', 'curl x | sudo sh']) {
      expect(permissions.evaluate(run(command)).type, command).toBe('deny');
      expect(permissions.evaluate(run(command, 'user')).type, command).toBe('deny');
    }
  });

  it('denies every command with a bash:* deny rule', () => {
    const permissions = manager({ config: { allow: [], deny: ['bash:*'] } });
    expect(permissions.evaluate(run('ls')).type).toBe('deny');
    expect(permissions.evaluate(run('ls', 'user')).type).toBe('deny');
  });
});

describe('PermissionManager session state and listing', () => {
  it('de-duplicates grants and resets them', () => {
    const permissions = manager();
    permissions.grant({ kind: 'all-edits' });
    permissions.grant({ kind: 'all-edits' });
    permissions.grant({ kind: 'command-prefix', prefix: 'pnpm  test' });
    permissions.grant({ kind: 'command-prefix', prefix: 'pnpm test' });
    expect(permissions.sessionGrants()).toHaveLength(2);
    permissions.resetSession();
    expect(permissions.sessionGrants()).toEqual([]);
    expect(permissions.evaluate(write(inside('a.ts'))).type).toBe('ask');
  });

  it('lists defaults, config, flags and session grants in plain language', () => {
    const permissions = manager({
      config: { allow: ['bash:pnpm test', 'not a rule'], deny: ['bash:git push'] },
      flags: { allow: ['edit'], deny: [] },
    });
    permissions.grant({ kind: 'command-prefix', prefix: 'pnpm lint' });
    permissions.grant({ kind: 'read-path', path: outsideDir });
    const rules = permissions.listRules();
    expect(
      rules.filter((rule) => rule.source === 'default').map((rule) => rule.description),
    ).toContain('Ask before editing files');
    expect(rules.filter((rule) => rule.source !== 'default')).toEqual([
      {
        source: 'config',
        effect: 'allow',
        description: 'Allow: commands starting with "pnpm test" (config)',
      },
      {
        source: 'config',
        effect: 'deny',
        description: 'Deny: commands starting with "git push" (config)',
      },
      {
        source: 'flag',
        effect: 'allow',
        description: 'Allow: editing files inside the project (command line)',
      },
      {
        source: 'session',
        effect: 'allow',
        description: 'Allow: commands starting with "pnpm lint" (session)',
      },
      { source: 'session', effect: 'allow', description: `Allow: reading ${outsideDir} (session)` },
    ]);
    for (const rule of rules) expect(['allow', 'ask', 'deny']).toContain(rule.effect);
  });
});

describe('validateRules', () => {
  it('accepts every documented form', () => {
    expect(
      validateRules({
        allow: [
          'edit',
          'bash:pnpm test',
          'bash:*',
          'bash:npm run *',
          `read:${outsideDir}`,
          ' Edit ',
        ],
        deny: ['bash:git push', 'bash:*'],
      }),
    ).toEqual([]);
  });

  it('reports malformed rules with actionable messages', () => {
    const problems = validateRules({
      allow: [
        '',
        'bash:',
        'read:relative/dir',
        'write:/x',
        'edit:src',
        'bash:ls && rm x',
        'bash:np*m',
      ],
      deny: ['read'],
    });
    expect(problems).toEqual([
      'Invalid allow rule "": the rule is empty; expected "edit", "bash:<command prefix>", "bash:*", "read:<absolute directory>", "mcp:<server>" or "mcp:<server>__<tool>".',
      'Invalid allow rule "bash:": expected a command prefix after "bash:", e.g. "bash:pnpm test".',
      'Invalid allow rule "read:relative/dir": read rules need an absolute directory, not "relative/dir".',
      'Invalid allow rule "write:/x": unknown rule type "write"; expected "edit", "bash:<command prefix>", "bash:*", "read:<absolute directory>", "mcp:<server>" or "mcp:<server>__<tool>".',
      'Invalid allow rule "edit:src": "edit" does not take a value.',
      'Invalid allow rule "bash:ls && rm x": a command prefix cannot contain shell operators; add one rule per command.',
      'Invalid allow rule "bash:np*m": wildcards are only supported at the end ("bash:npm run *") or alone ("bash:*").',
      'Invalid deny rule "read": expected an absolute directory after "read:".',
    ]);
  });

  it('ignores invalid rules when evaluating', () => {
    const permissions = manager({ config: { allow: ['bash:', 'nonsense'], deny: ['edit:src'] } });
    expect(permissions.evaluate(write(inside('a.ts'))).type).toBe('ask');
    expect(permissions.evaluate(run('pnpm test')).type).toBe('ask');
  });
});
