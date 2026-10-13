import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeCommand, type AnalyzeCommandOptions } from '../../src/permissions/command-risk.js';
import { PermissionManager } from '../../src/permissions/manager.js';
import { syntaxViolation } from '../../src/permissions/strict-gate.js';
import { makeTempDir, writeFiles } from '../../src/testing/index.js';

let project: { dir: string; cleanup: () => void };
let options: AnalyzeCommandOptions;

beforeAll(() => {
  project = makeTempDir('patch-gate-');
  writeFiles(project.dir, {
    'src/a.ts': 'export const a = 1;\n',
    'a.txt': 'hello\n',
    'sub/package.json': '{}\n',
    'scripts/build.js': 'console.log(1);\n',
  });
  options = { cwd: project.dir, projectRoot: project.dir, home: project.dir, platform: 'linux' };
});

afterAll(() => project.cleanup());

const analyze = (command: string, extra: Partial<AnalyzeCommandOptions> = {}) =>
  analyzeCommand(command, { ...options, ...extra });

describe('strict gate: commands that must never run without asking', () => {
  // Each of these was found to be classified "safe" by the detailed classifier at some point.
  it.each([
    "test -v 'a[$(touch pwned)]'",
    "[ -v 'a[$(id)]' ]",
    "[[ -v 'a[$(id)]' ]]",
    'export PATH+=:/tmp/evil',
    'x=b; y=$((x))',
    'cat <<< $((1+1))',
    'time { rm -rf build; }',
    'coproc sudo ls',
    'nohup -- sudo ls',
    'builtin -- echo hi',
    'git constructor',
    'npm constructor',
    'pnpm __proto__',
    'read -r HOME',
    'cat docs*/notes.md',
    'cd d* && cat notes.md',
    'echo $ANTHROPIC_API_KEY',
    'ls ~',
    'ls # rm -rf /',
    'printf -v x %s y',
    'let x=1',
    'eval ls',
    'echo hi > out.txt',
    'ls &',
    'ls\nrm -rf build',
    'man ls',
    'jq . package.json',
  ])('%s is not auto-approved', (command) => {
    const analysis = analyze(command);
    expect(analysis.risk, command).not.toBe('safe');
  });

  it('treats a backslash as an escape under Git Bash but as a separator under PowerShell', () => {
    expect(analyze('ls \\-la', { platform: 'win32' }).risk).not.toBe('safe');
    expect(syntaxViolation('Get-ChildItem src\\app', 'powershell')).toBeUndefined();
    expect(syntaxViolation('ls src\\app', 'bash')).toBe('Uses a backslash escape');
  });

  it('never auto-approves a pipe into a code evaluator', () => {
    for (const shell of ['powershell', undefined] as const) {
      const analysis = analyze('Get-Content f.ps1 | iex', { platform: 'win32', shell });
      expect(analysis.risk).not.toBe('safe');
    }
    expect(analyze('cat f.ps1 | Invoke-Expression', { platform: 'win32' }).risk).not.toBe('safe');
  });

  it('rejects unterminated quotes, control characters and non-ASCII words outside quotes', () => {
    expect(syntaxViolation("echo 'unterminated", 'bash')).toBe('Has an unterminated quote');
    expect(syntaxViolation('echo \u0007', 'bash')).toBeDefined();
    expect(syntaxViolation('ls -la', 'bash')).toBe('Uses non-ASCII characters outside quotes');
    expect(syntaxViolation("echo 'héllo'", 'bash')).toBeUndefined();
  });

  it('treats % @ ^ as special only for Windows shells', () => {
    expect(syntaxViolation('git log --format=%h', 'bash')).toBeUndefined();
    expect(syntaxViolation('echo %PATH%', 'cmd')).toBeDefined();
    expect(syntaxViolation('echo @args', 'powershell')).toBeDefined();
  });
});

describe('strict gate: ordinary read-only commands stay frictionless', () => {
  it.each([
    'ls',
    'ls -la src',
    'cat src/a.ts',
    'head -n 5 a.txt',
    'wc -l a.txt',
    'pwd',
    'echo hi',
    'git status',
    'git diff',
    'git diff --stat',
    'git log --oneline -5',
    "git log --format='%h %s' -3",
    'git show HEAD',
    'rg foo src',
    'grep -n foo a.txt',
    "find . -name '*.ts'",
    'node --version',
    'pnpm --version',
    'cat a.txt | wc -l',
    'cd src && ls',
  ])('%s stays safe', (command) => {
    expect(analyze(command).risk, analyze(command).reasons.join('; ')).toBe('safe');
  });
});

describe('strict gate: session approvals', () => {
  it.each([
    ['pnpm test', 'pnpm test'],
    ['npm run build', 'npm run build'],
    ['CI=1 pnpm test', 'pnpm test'],
    ['timeout 60 pnpm test', 'pnpm test'],
    ['python -m pytest -q', 'python -m pytest'],
    ['uv run pytest', 'uv run pytest'],
    ['node scripts/build.js', 'node scripts/build.js'],
    ["git commit -m 'fix: handle empty input'", 'git commit'],
    ['cd sub && pnpm test', 'pnpm test'],
  ])('%s can be remembered as "%s"', (command, prefix) => {
    const analysis = analyze(command);
    expect(analysis.rulePrefix, analysis.reasons.join('; ')).toBe(prefix);
    expect(analysis.rememberable).not.toBe(false);
  });

  it.each([
    'node -e "require(1)"',
    'python -c pass',
    'npx create-foo',
    'pnpm dlx foo',
    'pnpm exec foo',
    'curl https://example.com',
    'pnpm test > out.txt',
    'docker compose up -d',
    'bash -c ls',
    'PATH=/tmp/evil pnpm test',
  ])('%s cannot be remembered', (command) => {
    const analysis = analyze(command);
    expect(analysis.rulePrefix, command).toBeUndefined();
    expect(analysis.rulePrefixes ?? [], command).toEqual([]);
  });

  it('does not let an approved script cover inline code for the same interpreter', () => {
    const permissions = new PermissionManager();
    permissions.grant({ kind: 'command-prefix', prefix: 'node scripts/build.js' });
    const subject = (command: string) => ({
      kind: 'execute' as const,
      command,
      analysis: analyze(command),
      origin: 'agent' as const,
    });
    expect(permissions.evaluate(subject('node scripts/build.js --watch=false')).type).toBe('allow');
    expect(permissions.evaluate(subject('node -e "process.exit(1)"')).type).toBe('ask');
    expect(permissions.evaluate(subject('node -p 1')).type).toBe('ask');
  });
});

describe('session approvals cover only the approved shape', () => {
  /** Approves `command` the way the UI does: through the prompt's session option. */
  function approve(command: string): PermissionManager {
    const permissions = new PermissionManager();
    const decision = permissions.evaluate({
      kind: 'execute',
      command,
      analysis: analyze(command),
      origin: 'agent',
    });
    if (decision.type !== 'ask') throw new Error(`${command} did not ask`);
    const option = decision.prompt.sessionOption;
    if (!option) throw new Error(`${command} offered no session option`);
    for (const grant of option.grants ?? [option.grant]) permissions.grant(grant);
    return permissions;
  }
  const decide = (permissions: PermissionManager, command: string) =>
    permissions.evaluate({ kind: 'execute', command, analysis: analyze(command), origin: 'agent' })
      .type;

  it('covers the same command and arguments passed through after --', () => {
    const permissions = approve('pnpm test');
    expect(decide(permissions, 'pnpm test')).toBe('allow');
    expect(decide(permissions, 'pnpm test -- --run src/a.test.ts')).toBe('allow');
  });

  it.each([
    ['npm test', 'npm test --script-sh=./hook.sh'],
    ['npm test', 'npm test --node-opt=--require=./hook.js'],
    ['npm run build', 'npm run build --globalconf=./rc'],
    ['go test ./...', "go test -exec 'sh -c x' ./..."],
    ['go test ./...', 'GOROOT=/opt/other/go go test ./...'],
    ['go test ./...', 'GOTOOLCHAIN=go1.99.0 go test ./...'],
    ['make test', 'CC=/opt/other/cc make test'],
    ['CI=1 pnpm test', 'NODE_OPTIONS=--require=./hook.js pnpm test'],
    ['dotnet build', 'dotnet build -p:CustomBeforeMicrosoftCommonTargets=/opt/other/x.targets'],
    ['mvn test', 'mvn test -Dmaven.ext.class.path=/opt/other/x.jar'],
    ['gradle test', 'gradle test -Dorg.gradle.java.home=/opt/other/jdk'],
    ['jest', `jest --config='{"setupFiles":["/opt/other/s.js"]}'`],
  ])('after approving "%s", "%s" asks again', (approved, later) => {
    const permissions = approve(approved);
    expect(decide(permissions, approved)).toBe('allow');
    expect(decide(permissions, later)).toBe('ask');
  });

  it.each([
    'pnpm node scripts/gen.js',
    'yarn node scripts/gen.js',
    'pnpm bash scripts/ci.sh',
    'npm init -y',
    'go run ./cmd/gen',
    'deno run --allow-read scripts/a.ts',
  ])('never offers to remember %s', (command) => {
    expect(analyze(command).rulePrefixes ?? []).toEqual([]);
  });
});

describe('secret checks see through git pathspec magic', () => {
  it.each([
    "git log -p -- ':(literal).env'",
    "git show HEAD ':(icase).npmrc'",
    "git grep -h . ':(top).env'",
    "git log -p ':(icase)id_rsa'",
    "git log -p -- ':/.env'",
  ])('%s asks', (command) => {
    expect(analyze(command).risk).not.toBe('safe');
  });
});
