/**
 * End-to-end scenarios: the built `ptch` binary in a real pseudo-terminal, talking to the
 * conformance-checking mock Anthropic API. Each scenario prints the final screen transcript and
 * fails on unexpected screens or on any API conformance violation.
 *
 *   pnpm build && pnpm -C apps/cli exec tsx scripts/e2e/run.ts [scenario ...]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { mcpTestServerEntry, pngBytes } from '@patch/core/testing';
import {
  startMockAnthropicServer,
  type MockAnthropicServer,
} from '@patch/provider-anthropic/testing';
import {
  makeWorkspace,
  note,
  reply,
  text,
  tool,
  webFetch,
  webSearch,
  type Workspace,
} from './harness.js';
import { MAIN_JS, TerminalSession } from './terminal.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, '..', '..', '.e2e-output');

// ---------------------------------------------------------------------------------------------
// Helpers

interface Context {
  ws: Workspace;
  server: MockAnthropicServer;
  launch: (args?: string[], env?: Record<string, string>) => TerminalSession;
}

type Scenario = (ctx: Context) => Promise<void>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectExit(term: TerminalSession): Promise<void> {
  const code = await Promise.race([
    term.exited,
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error('ptch did not exit')), 8000),
    ),
  ]);
  assert(code === 0, `expected exit code 0, got ${code}`);
}

// ---------------------------------------------------------------------------------------------
// Scenarios

const scenarios: Record<string, Scenario> = {
  async 'start-screen'({ launch }) {
    const logoRow = '▄▄▄▄▄   ▄█▄▄   ▄▄▄▄▄  █▄▄▄▄';
    const term = launch();
    const start = await term.waitFor((s) => s.includes(logoRow) && s.includes('v0.1.0'));
    const lines = start.split('\n');
    const logoAt = lines.findIndex((l) => l.includes(logoRow));
    const promptAt = lines.findIndex((l) => l.includes('What do you want to build?'));
    assert(logoAt > 3, `logo should sit in the middle of the screen, found on row ${logoAt}`);
    assert(promptAt >= term.rows - 3, `prompt should be at the bottom, found on row ${promptAt}`);
    assert(!start.includes('ptch 0.1.0'), 'the header under the logo should have no title line');
    await term.submit('/help');
    // The end of the help (its start can be scrolled above a short window).
    await term.waitFor((s) => s.includes('Clear the screen') && !s.includes(logoRow));
    const transcript = await term.transcript();
    assert(transcript.includes('/compact'), '/help should list /compact');
    const header = transcript.indexOf('demo-app · main');
    assert(header !== -1 && header < transcript.indexOf('/compact'), 'header should stay on top');
    assert(!transcript.slice(header).includes(logoRow), 'logo should be gone after /help');
    await term.submit('/exit');
    await expectExit(term);
  },

  async 'read-only'({ server, launch, ws }) {
    writeFileSync(
      join(ws.repo, 'PATCH.md'),
      '# demo-app\n\nRun tests with `npm test`. Never use default exports.\n',
    );
    server.enqueue(
      reply(
        note('Looking at the auth module first.'),
        text("I'll read the session and token code."),
        tool('list_directory', { path: 'src' }),
        tool('read_file', { path: 'src/auth/session.js' }),
        tool('read_file', { path: 'src/auth/token-store.js' }),
      ),
      reply(
        text(
          'Authentication is session based.\n\n' +
            '- `createSession` (`src/auth/session.js:4`) issues a token and sets `expiresAt` from `SESSION_TTL_MS`.\n' +
            '- Tokens live in an in-memory map in `src/auth/token-store.js`; `revokeToken` deletes them.\n' +
            '- `refreshSession` revokes the old token and issues a new one.\n\n' +
            'There is no persistence: restarting the process logs everyone out.',
        ),
      ),
    );
    const term = launch();
    const welcome = await term.waitFor('What do you want to build?');
    assert(/ready · PATCH\.md/.test(welcome), 'welcome should list PATCH.md');
    await term.submit('Explain how authentication works.');
    await term.waitFor('There is no persistence');
    const system = JSON.stringify(server.requests[0]?.body.system ?? '');
    assert(system.includes('Never use default exports.'), 'PATCH.md missing from system prompt');
    const screen = await term.screen();
    assert(/read\s+src\/auth\/session\.js/.test(screen), 'read row for session.js missing');
    assert(/ls\s+src/.test(screen), 'ls row missing');
    assert(screen.includes('Looking at the auth module first.'), 'progress note missing');
    await term.submit('/exit');
    await expectExit(term);
  },

  async editing({ server, launch, ws }) {
    server.enqueue(
      reply(
        text("I'll read the session module first."),
        tool('read_file', { path: 'src/auth/session.js' }),
      ),
      reply(
        text('Adding `remainingTtl` next to `isExpired`.'),
        tool('edit_file', {
          path: 'src/auth/session.js',
          old_string: 'export async function refreshSession',
          new_string:
            '/** Milliseconds until the session expires (0 when expired). */\nexport function remainingTtl(session, now = Date.now()) {\n  return Math.max(0, session.expiresAt - now);\n}\n\nexport async function refreshSession',
        }),
      ),
      reply(
        tool('write_file', {
          path: 'test/remaining-ttl.test.js',
          content:
            "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { createSession, remainingTtl } from '../src/auth/session.js';\n\ntest('remainingTtl counts down to zero', () => {\n  const session = createSession('u1', 0);\n  assert.equal(remainingTtl(session, session.expiresAt - 5), 5);\n  assert.equal(remainingTtl(session, session.expiresAt + 5), 0);\n});\n",
        }),
      ),
      reply(tool('bash', { command: 'npm test', description: 'Run the test suite' })),
      reply(
        text(
          'Added `remainingTtl` with a test. The new test passes; the one existing failure (`isExpired` at the boundary) is unrelated.',
        ),
      ),
    );
    const term = launch();
    await term.waitFor('What do you want to build?');
    await term.submit('Add a helper function and tests.');
    await term.waitFor('Patch wants to edit src/auth/session.js');
    await term.press('enter'); // Yes (once)
    await term.waitFor(/Patch wants to (create|edit) test\/remaining-ttl\.test\.js/);
    await term.press('down');
    await term.press('enter'); // Yes, allow all edits this session
    await term.waitFor('Patch wants to run a command');
    await term.press('down');
    await term.press('enter'); // allow "npm test" for the session
    await term.waitFor('Added remainingTtl', { timeoutMs: 30_000 });
    const content = readFileSync(join(ws.repo, 'src/auth/session.js'), 'utf8');
    assert(content.includes('export function remainingTtl'), 'edit not applied');
    assert(existsSync(join(ws.repo, 'test/remaining-ttl.test.js')), 'test file not created');
    const transcript = await term.transcript();
    assert(/edit\s+src\/auth\/session\.js/.test(transcript), 'edit row missing');
    assert(/bash\s+npm test/.test(transcript), 'bash row missing');
    await term.submit('/diff');
    await term.waitFor('remainingTtl');
    await term.submit('/exit');
    await expectExit(term);
  },

  async 'plan-mode'({ server, launch, ws }) {
    const lastContent = (request: { body: Record<string, unknown> }) => {
      const messages = request.body.messages as Array<{ content: unknown }>;
      return JSON.stringify(messages.at(-1)?.content);
    };
    const plan =
      '## Add remainingTtl\n\n1. Add `remainingTtl(session, now)` to `src/auth/session.js`.\n2. Run `npm test`.';
    server.enqueue(
      (request) => {
        const last = lastContent(request);
        assert(last.includes('<plan-mode state=\\"on\\">'), `plan mode note missing: ${last}`);
        assert(JSON.stringify(request.body.system).includes('present_plan'), 'system prompt');
        return reply(
          text("I'll read the session module first."),
          tool('read_file', { path: 'src/auth/session.js' }),
        );
      },
      reply(
        tool('edit_file', {
          path: 'src/auth/session.js',
          old_string: 'export async function refreshSession',
          new_string:
            'export function remainingTtl(session, now = Date.now()) {\n  return Math.max(0, session.expiresAt - now);\n}\n\nexport async function refreshSession',
        }),
      ),
      (request) => {
        const last = lastContent(request);
        assert(last.includes('Plan mode is on'), `the edit should be denied in plan mode: ${last}`);
        return reply(text('Here is the plan.'), tool('present_plan', { plan }));
      },
      (request) => {
        const last = lastContent(request);
        assert(last.includes('The user approved your plan'), `approval missing: ${last}`);
        return reply(
          tool('edit_file', {
            path: 'src/auth/session.js',
            old_string: 'export async function refreshSession',
            new_string:
              'export function remainingTtl(session, now = Date.now()) {\n  return Math.max(0, session.expiresAt - now);\n}\n\nexport async function refreshSession',
          }),
        );
      },
      reply(text('Added `remainingTtl` as planned.')),
    );
    const term = launch();
    await term.waitFor('What do you want to build?');
    await term.press('shift-tab');
    await term.waitFor('⏵⏵ accepting edits · shift+tab to change');
    await term.press('shift-tab');
    await term.waitFor('⏸ plan mode · shift+tab to change');
    await term.submit('Add a remainingTtl helper.');
    const prompt = await term.waitFor('Patch has a plan');
    assert(prompt.includes('Add remainingTtl'), 'the plan should be shown');
    assert(prompt.includes('Yes, and accept edits'), 'approval options missing');
    assert(
      !readFileSync(join(ws.repo, 'src/auth/session.js'), 'utf8').includes('remainingTtl'),
      'plan mode must not edit',
    );
    await term.press('enter'); // Yes, and accept edits
    await term.waitFor('Added remainingTtl as planned.', { timeoutMs: 30_000 });
    await term.waitFor('⏵⏵ accepting edits · shift+tab to change');
    assert(
      readFileSync(join(ws.repo, 'src/auth/session.js'), 'utf8').includes('remainingTtl'),
      'the approved edit was not applied',
    );
    const transcript = await term.transcript();
    assert(/plan\s+Add remainingTtl · approved · accepting edits/.test(transcript), 'plan row');
    assert(transcript.includes('╭'), 'the approved plan should stay in a frame');
    assert(!transcript.includes('Patch wants to edit'), 'accepted edits must not ask');
    assert(/edit\s+src\/auth\/session\.js/.test(transcript), 'edit row missing');
    await term.submit('/exit');
    await expectExit(term);
  },

  async 'auto-mode'({ server, launch, ws }) {
    mkdirSync(join(ws.repo, 'build'), { recursive: true });
    writeFileSync(join(ws.repo, 'build', 'bundle.js'), 'built');
    server.enqueue(
      reply(text('Reading the config first.'), tool('read_file', { path: 'src/config.js' })),
      reply(
        tool('edit_file', { path: 'src/config.js', old_string: '3,', new_string: '5,' }),
        tool('bash', { command: 'npm test', description: 'Run the test suite' }),
      ),
      reply(tool('bash', { command: 'rm -rf build', description: 'Remove build output' })),
    );
    const term = launch();
    await term.waitFor('What do you want to build?');
    await term.press('shift-tab', 3);
    await term.waitFor('Destructive commands and secret files still ask. Turn it on?');
    await term.press('enter'); // Yes
    await term.waitFor('⏵⏵⏵ auto mode · no permission prompts · shift+tab to change');
    await term.submit('Raise the retry limit and clean the build output.');
    // The edit and `npm test` ran without a prompt; the destructive command still asks.
    const prompt = await term.waitFor('Potentially destructive command', { timeoutMs: 30_000 });
    assert(prompt.includes('rm -rf build'), 'the destructive command should be shown');
    assert(
      readFileSync(join(ws.repo, 'src/config.js'), 'utf8').includes('RETRY_LIMIT: 5'),
      'the edit should apply without a prompt',
    );
    await term.press('esc');
    await term.waitFor(/declined/);
    assert(existsSync(join(ws.repo, 'build', 'bundle.js')), 'build/ was deleted');
    const transcript = await term.transcript();
    assert(/edit\s+src\/config\.js/.test(transcript), 'edit row missing');
    assert(/bash\s+npm test/.test(transcript), 'npm test row missing');
    assert(/bash\s+rm -rf build/.test(transcript), 'rm row missing');
    assert(!transcript.includes('Patch wants to edit'), 'edits must not ask in auto mode');
    assert(!transcript.includes('Patch wants to run a command'), 'commands must not ask');
    await term.submit('/exit');
    await expectExit(term);
  },

  async debugging({ server, launch, ws }) {
    server.enqueue(
      reply(
        text('Running the tests to see the failure.'),
        tool('bash', { command: 'npm test', description: 'Run the test suite' }),
      ),
      reply(
        note('The boundary test fails; isExpired uses a strict comparison.'),
        tool('read_file', { path: 'src/auth/session.js' }),
      ),
      reply(
        tool('edit_file', {
          path: 'src/auth/session.js',
          old_string: 'return now > session.expiresAt;',
          new_string: 'return now >= session.expiresAt;',
        }),
      ),
      reply(tool('bash', { command: 'npm test', description: 'Re-run the tests' })),
      reply(
        text(
          'Fixed: `isExpired` now treats the expiry instant as expired (`>=`). All 4 tests pass.',
        ),
      ),
    );
    const term = launch();
    await term.waitFor('What do you want to build?');
    await term.submit('Run the tests and fix the failing test.');
    await term.waitFor('Patch wants to run a command');
    await term.press('down');
    await term.press('enter'); // allow npm test for the session
    await term.waitFor('Patch wants to edit src/auth/session.js', { timeoutMs: 30_000 });
    await term.press('enter');
    await term.waitFor('All 4 tests pass', { timeoutMs: 30_000 });
    const transcript = await term.transcript();
    assert(/3 passed . 1 failed/.test(transcript), 'first test summary missing');
    assert(/4 passed/.test(transcript), 'second test summary missing');
    assert(
      readFileSync(join(ws.repo, 'src/auth/session.js'), 'utf8').includes('>='),
      'fix missing',
    );
    await term.submit('/exit');
    await expectExit(term);
  },

  async search({ server, launch }) {
    server.enqueue(
      reply(tool('grep', { pattern: 'RETRY_LIMIT' })),
      reply(
        text(
          '`RETRY_LIMIT` is defined in `src/config.js:2` and used twice in `src/http/client.js`: as the default for `retries` (line 3) and in the delay check (line 10). The second use ignores a custom `retries` argument.',
        ),
      ),
    );
    const term = launch();
    await term.waitFor('What do you want to build?');
    await term.submit('Find everywhere RETRY_LIMIT is used.');
    await term.waitFor('ignores a custom');
    const screen = await term.screen();
    assert(/grep\s+"RETRY_LIMIT"/.test(screen) && /3 matches in 2 files/.test(screen), 'grep row');
    await term.submit('/exit');
    await expectExit(term);
  },

  async 'shell-permission'({ server, launch }) {
    server.enqueue(reply(tool('bash', { command: 'npm test', description: 'Run the test suite' })));
    const term = launch();
    await term.waitFor('What do you want to build?');
    await term.submit('Run the test suite.');
    const prompt = await term.waitFor('Patch wants to run a command');
    assert(prompt.includes('npm test'), 'command not shown in prompt');
    assert(/don't ask again for "npm test"/.test(prompt), 'session option missing');
    await term.press('down', 2);
    await term.press('enter'); // No
    await term.waitFor(/declined/);
    await term.submit('/exit');
    await expectExit(term);
  },

  async 'dangerous-command'({ server, launch, ws }) {
    mkdirSync(join(ws.repo, 'dist'), { recursive: true });
    writeFileSync(join(ws.repo, 'dist', 'bundle.js'), 'built');
    server.enqueue(
      reply(tool('bash', { command: 'rm -rf dist/', description: 'Remove build output' })),
    );
    const term = launch();
    await term.waitFor('What do you want to build?');
    await term.submit('Clean the build output.');
    const prompt = await term.waitFor('Potentially destructive command');
    assert(prompt.includes('rm -rf dist/'), 'command missing');
    assert(!/for this session/.test(prompt), 'destructive prompt must not offer a session option');
    await term.press('esc');
    await term.waitFor(/declined/);
    assert(existsSync(join(ws.repo, 'dist', 'bundle.js')), 'dist was deleted');
    // Blocked commands never reach a prompt.
    server.enqueue(
      reply(tool('bash', { command: 'sudo rm -rf /tmp/x' })),
      reply(text('That needs elevated privileges; run it yourself if you need it.')),
    );
    await term.submit('Delete it with sudo.');
    await term.waitFor('run it yourself');
    await term.submit('/exit');
    await expectExit(term);
  },

  async sessions({ server, launch }) {
    server.enqueue(reply(text('The project is a small Node service with session handling.')));
    let term = launch();
    await term.waitFor('What do you want to build?');
    await term.submit('What is this project?');
    await term.waitFor('small Node service');
    await term.submit('/exit');
    const exitScreen = await term.waitFor('Resume this session with: ptch --resume', {
      inTranscript: true,
    });
    await expectExit(term);
    const id = /ptch --resume ([0-9a-f]+)/.exec(exitScreen)?.[1];
    assert(id, 'no resume id printed');

    server.enqueue((request) => {
      const messages = request.body.messages as Array<{ role: string }>;
      assert(
        messages.length >= 3,
        `continued request should include history, got ${messages.length} messages`,
      );
      return reply(text('Yes — we discussed the project overview before.'));
    });
    term = launch(['--continue']);
    await term.waitFor(`resumed ${id}`, { inTranscript: true });
    await term.waitFor('small Node service', { inTranscript: true });
    await term.submit('Do you remember what we discussed?');
    await term.waitFor('discussed the project overview');
    await term.submit('/exit');
    await expectExit(term);

    term = launch(['--resume']);
    await term.waitFor('Resume a session');
    await term.press('enter');
    await term.waitFor(`resumed ${id}`, { inTranscript: true });
    await term.submit('/exit');
    await expectExit(term);
  },

  async 'slash-commands'({ server, launch, ws }) {
    const term = launch();
    await term.waitFor('What do you want to build?');
    await term.type('/co');
    await term.waitFor('/compact');
    await term.press('backspace', 3);
    await term.submit('/help');
    await term.waitFor('While Patch works');
    await term.submit('/status');
    await term.waitFor(/Branch\s+main/);
    await term.submit('/permissions');
    await term.waitFor('Permissions');
    await term.submit('/model');
    await term.waitFor('Choose a model');
    await term.press('down');
    await term.press('enter');
    await term.waitFor(/Using Claude .* for this session/);
    await term.submit('/diff');
    await term.waitFor('No uncommitted changes.');
    writeFileSync(
      join(ws.repo, 'src/config.js'),
      readFileSync(join(ws.repo, 'src/config.js'), 'utf8').replace('3,', '5,'),
    );
    await term.submit('/diff');
    await term.waitFor('RETRY_LIMIT: 5');
    await term.submit('!git status --short');
    await term.waitFor(/M src\/config\.js/);
    server.enqueue(reply(text('Noted: RETRY_LIMIT is now 5.')));
    await term.submit('I changed the retry limit.');
    await term.waitFor('Noted: RETRY_LIMIT is now 5.');
    server.enqueue(
      reply(
        text(
          '## Goal\nTrack configuration changes.\n\n## Current state\nRETRY_LIMIT changed to 5.',
        ),
      ),
    );
    await term.submit('/compact');
    await term.waitFor('Conversation compacted', { timeoutMs: 20_000 });
    await term.submit('/clear');
    await term.waitFor('What do you want to build?');
    await term.submit('/resume');
    await term.waitFor('Resume a session');
    await term.press('esc');
    await term.submit('/exit');
    await expectExit(term);
  },

  async interrupt({ server, launch }) {
    server.enqueue({
      ...reply(text('This is a long answer that streams slowly. '.repeat(40))),
      delayMs: 60,
      chunkSize: 6,
    });
    const term = launch();
    await term.waitFor('What do you want to build?');
    await term.submit('Write a long essay.');
    await term.waitFor('streams slowly');
    await term.press('esc');
    await term.waitFor('Interrupted.');
    server.enqueue(reply(text('Short answer instead.')));
    await term.submit('Keep it short.');
    // Idle again (the answer can be on screen a moment before the turn ends): Ctrl+C now arms
    // the exit instead of interrupting.
    await term.waitFor((s) => s.includes('Short answer instead.') && s.includes('/ for commands'));
    await term.press('ctrl-c');
    await term.waitFor('Press Ctrl+C again to exit');
    await term.press('ctrl-c');
    await expectExit(term);
  },

  async images({ server, launch, ws }) {
    mkdirSync(join(ws.repo, 'docs'), { recursive: true });
    const screenshot = join(ws.repo, 'docs', 'screenshot.png');
    writeFileSync(screenshot, pngBytes(1280, 720));
    server.enqueue(
      reply(
        text('Let me look at the file too.'),
        tool('read_file', { path: 'docs/screenshot.png' }),
      ),
      reply(text('Both show the same black 1280×720 screenshot.')),
    );
    const term = launch();
    await term.waitFor('What do you want to build?');
    // A dropped file arrives as one pasted chunk, quoted when the path has spaces.
    term.write(`"${screenshot}"`);
    await term.waitFor(/\[Image #1\] screenshot\.png · 1280×720 · /);
    term.write(screenshot);
    await term.waitFor(/\[Image #2\] screenshot\.png/);
    await term.press('backspace', 2); // the space, then the whole [Image #2] token
    await term.waitFor((s) => !s.includes('[Image #2]'));
    await term.submit('What does this show?');
    // Idle again (the answer can be on screen a moment before the turn ends).
    await term.waitFor(
      (s) => s.includes('same black 1280×720 screenshot') && s.includes('/ for commands'),
      { timeoutMs: 20_000 },
    );

    const first = server.requests[0]?.body.messages as Array<{ content: unknown[] }>;
    const sent = first.at(-1)?.content ?? [];
    assert(
      sent.length === 2,
      `expected an image and the text, got ${JSON.stringify(sent).slice(0, 200)}`,
    );
    const [image, prompt] = sent as Array<Record<string, unknown>>;
    const source = image?.['source'] as Record<string, unknown> | undefined;
    assert(image?.['type'] === 'image' && source?.['media_type'] === 'image/png', 'image block');
    assert(source?.['data'] === pngBytes(1280, 720).toString('base64'), 'image data');
    assert(
      prompt?.['type'] === 'text' && prompt['text'] === '[Image #1] What does this show?',
      `prompt text was ${JSON.stringify(prompt)}`,
    );
    const second = JSON.stringify(server.requests[1]?.body.messages ?? []);
    assert(/"type":"tool_result".*"type":"image"/.test(second), 'tool result image missing');

    const transcript = await term.transcript();
    assert(transcript.includes('› [Image #1] What does this show?'), 'user line missing');
    assert(/\[Image #1\] screenshot\.png · 1280×720 · /.test(transcript), 'image line missing');
    assert(
      /read\s+docs\/screenshot\.png · image 1280×720/.test(transcript),
      'read row for the image missing',
    );
    await term.submit('/exit');
    await expectExit(term);
  },

  async 'custom-commands'({ server, launch, ws }) {
    mkdirSync(join(ws.repo, '.patch', 'commands'), { recursive: true });
    writeFileSync(
      join(ws.repo, '.patch', 'commands', 'review.md'),
      '---\ndescription: Review code for bugs\nargument-hint: [path]\n---\n' +
        'Review the code in $ARGUMENTS for bugs. List each finding with its file and line.\n',
    );
    const expectExpanded = (path: string) => (request: { body: Record<string, unknown> }) => {
      const messages = request.body.messages as Array<{ content: unknown }>;
      const last = JSON.stringify(messages.at(-1)?.content);
      assert(
        last.includes(`Review the code in ${path} for bugs. List each finding`),
        `the model should get the expanded prompt, got ${last}`,
      );
      assert(!last.includes('/review'), 'the model should not get the typed command');
    };
    server.enqueue((request) => {
      expectExpanded('src/auth')(request);
      return reply(text('No bugs found in src/auth.'));
    });
    const term = launch();
    await term.waitFor('What do you want to build?');
    await term.type('/rev');
    await term.waitFor((s) => s.includes('/review [path]') && s.includes('(project)'));
    await term.press('backspace', 4);
    await term.submit('/review src/auth');
    await term.waitFor('No bugs found in src/auth.');
    const transcript = await term.transcript();
    assert(transcript.includes('› /review src/auth'), 'the typed command should be echoed');
    assert(transcript.includes('.patch/commands/review.md'), 'the command file should be shown');
    await term.submit('/help');
    await term.waitFor('Custom commands');
    await term.submit('/exit');
    await expectExit(term);

    // Print mode expands custom commands too.
    server.enqueue((request) => {
      expectExpanded('src/http')(request);
      return reply(text('No bugs found in src/http.'));
    });
    const result = await runPtch(['-p', '/review src/http'], {
      cwd: ws.repo,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'test-key',
        ANTHROPIC_BASE_URL: server.url,
        PATCH_HOME: ws.home,
      },
    });
    assert(result.status === 0, `print mode exit ${result.status}: ${result.stderr}`);
    assert(result.stdout.includes('No bugs found in src/http.'), 'print stdout');
  },

  async hooks({ server, launch, ws }) {
    mkdirSync(join(ws.repo, 'dist'), { recursive: true });
    writeFileSync(join(ws.repo, 'dist', 'bundle.js'), 'built');
    // A guard that refuses `rm -rf`, and a "formatter" that logs the files written.
    writeFileSync(
      join(ws.home, 'guard.cjs'),
      "let input = '';\nprocess.stdin.on('data', (c) => (input += c));\nprocess.stdin.on('end', () => {\n" +
        "  if (JSON.parse(input).input.command.includes('rm -rf')) {\n" +
        "    process.stderr.write('Deleting files is not allowed here.');\n    process.exitCode = 2;\n  }\n});\n",
    );
    writeFileSync(
      join(ws.home, 'format.cjs'),
      `require('fs').appendFileSync(${JSON.stringify(join(ws.home, 'formatted.log'))}, process.env.PATCH_FILE + '\\n');\n`,
    );
    const home = ws.home.replace(/\\/g, '/');
    writeFileSync(
      join(ws.home, 'config.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'bash', command: `node "${home}/guard.cjs"` }],
          PostToolUse: [{ matcher: 'write_file', command: `node "${home}/format.cjs"` }],
        },
      }),
    );
    server.enqueue(
      reply(tool('bash', { command: 'rm -rf dist/', description: 'Remove build output' })),
      (request) => {
        const messages = request.body.messages as Array<{ content: unknown }>;
        const last = JSON.stringify(messages.at(-1)?.content);
        assert(
          last.includes('Deleting files is not allowed here.'),
          `hook reason missing: ${last}`,
        );
        return reply(tool('write_file', { path: 'notes/todo.md', content: '- clean dist\n' }));
      },
      reply(text('I left dist/ alone and noted the cleanup in notes/todo.md.')),
    );
    const term = launch();
    await term.waitFor('What do you want to build?');
    await term.submit('/hooks');
    await term.waitFor(/PreToolUse\s+node .*guard\.cjs/);
    await term.submit('Clean the build output.');
    // Hooks never replace the permission check: the command is still confirmed first.
    await term.waitFor('Potentially destructive command');
    await term.press('enter');
    await term.waitFor('blocked by hook');
    await term.waitFor('Patch wants to create notes/todo.md');
    await term.press('enter');
    await term.waitFor('noted the cleanup');
    assert(existsSync(join(ws.repo, 'dist', 'bundle.js')), 'the hook should have kept dist/');
    const formatted = readFileSync(join(ws.home, 'formatted.log'), 'utf8').trim();
    assert(
      formatted.replace(/\\/g, '/').endsWith('/notes/todo.md'),
      `PostToolUse should get the absolute file path, got "${formatted}"`,
    );
    await term.submit('/exit');
    await expectExit(term);
  },

  async web({ server, launch, ws }) {
    const pages = [
      { url: 'https://vitest.dev/blog/vitest-4', title: 'Vitest 4 is out!' },
      { url: 'https://github.com/vitest-dev/vitest/releases', title: 'Releases' },
    ];
    server.enqueue(
      // The server pauses its loop before running the search; Patch continues the turn.
      {
        ...reply(text("I'll look up the release notes."), {
          type: 'server_tool_use',
          id: 'srvtoolu_e2e_search',
          name: 'web_search',
          input: { query: 'vitest 4 release notes' },
        }),
        stop_reason: 'pause_turn',
      },
      reply(
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_e2e_search', results: pages },
        ...webFetch('https://vitest.dev/blog/vitest-4', {
          text: 'Vitest 4 release notes. '.repeat(612),
        }),
        ...webFetch('https://vitest.dev/guide/migration-v4', { error: 'url_not_accessible' }),
        text('Vitest 4 is out. '),
        {
          type: 'text',
          text: 'Browser mode is now stable.',
          citations: [{ ...pages[0]!, cited_text: 'Browser Mode is stable' }],
        },
        text('\n\nSource: https://vitest.dev/blog/vitest-4'),
      ),
    );
    let term = launch();
    await term.waitFor('What do you want to build?');
    await term.submit('What changed in Vitest 4?');
    await term.waitFor('Source: https://vitest.dev/blog/vitest-4');
    const rows = (screen: string) => {
      assert(/search\s+vitest 4 release notes\n\s+2 results/.test(screen), 'search row missing');
      assert(/fetch\s+vitest\.dev\/blog\/vitest-4\n\s+14 KB/.test(screen), 'fetch row missing');
      assert(
        /fetch\s+vitest\.dev\/guide\/migration-v4\n\s+page not accessible/.test(screen),
        'failed fetch row missing',
      );
    };
    const screen = await term.transcript();
    rows(screen);
    assert(screen.includes('Vitest 4 is out. Browser mode is now stable.'), 'cited text missing');
    const first = server.requests[0]?.body ?? {};
    const tools = (first['tools'] as Array<{ type?: string }>).map((t) => t.type);
    assert(
      tools.includes('web_search_20260209') && tools.includes('web_fetch_20260209'),
      `web tools missing from the request: ${tools.join(', ')}`,
    );
    assert(JSON.stringify(first['system']).includes('# Web'), 'web guidance missing');
    const continued = server.requests[1]?.body['messages'] as Array<{ role: string }>;
    assert(continued.at(-1)?.role === 'assistant', 'the paused turn got a user message');

    // The next request sends the server tool blocks and citations back as they came.
    server.enqueue(reply(text('Glad it helped.')));
    await term.submit('Thanks!');
    await term.waitFor('Glad it helped.');
    await term.submit('/status');
    await term.waitFor(/Web\s+search, fetch/);
    await term.submit('/exit');
    await term.waitFor('Resume this session with: ptch --resume', { inTranscript: true });
    await expectExit(term);

    term = launch(['--continue']);
    await term.waitFor('resumed ', { inTranscript: true });
    rows(await term.transcript());
    await term.submit('/exit');
    await expectExit(term);

    // Print mode prints the rows to stderr; PATCH_NO_WEB keeps the tools out of the request.
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_BASE_URL: server.url,
      PATCH_HOME: ws.home,
    };
    server.enqueue(reply(...webSearch('vitest 4', pages), text('Found two pages.')));
    let result = await runPtch(['-p', 'Search for vitest 4'], { cwd: ws.repo, env });
    assert(result.status === 0, `print mode exit ${result.status}: ${result.stderr}`);
    assert(
      /search\s+vitest 4 · 2 results/.test(stripVTControlCharacters(result.stderr)),
      `print stderr search row missing; stderr was:\n${result.stderr}`,
    );
    server.enqueue(reply(text('No web today.')));
    result = await runPtch(['-p', 'hi'], { cwd: ws.repo, env: { ...env, PATCH_NO_WEB: '1' } });
    assert(result.status === 0, `PATCH_NO_WEB exit ${result.status}: ${result.stderr}`);
    const offline = server.requests.at(-1)?.body['tools'] as Array<{ name: string }>;
    assert(!offline.some((t) => t.name.startsWith('web_')), 'PATCH_NO_WEB still sent web tools');
  },

  async mcp({ server, launch, ws }) {
    // A server of the user's own, and one the repository proposes in .mcp.json.
    writeFileSync(
      join(ws.home, 'config.json'),
      JSON.stringify({ mcpServers: { test: mcpTestServerEntry() } }),
    );
    writeFileSync(
      join(ws.repo, '.mcp.json'),
      JSON.stringify({ mcpServers: { proj: mcpTestServerEntry('--name=proj') } }),
    );
    server.enqueue(
      (request) => {
        const tools = (request.body['tools'] as Array<{ name: string }>).map((t) => t.name);
        assert(tools.includes('mcp__test__echo'), `MCP tools missing: ${tools.join(', ')}`);
        assert(tools.includes('mcp__proj__echo'), 'the approved project server has no tools');
        return reply(
          text('Asking the test server.'),
          tool('mcp__test__echo', { text: 'hello from patch' }),
        );
      },
      (request) => {
        const messages = request.body.messages as Array<{ content: unknown }>;
        const last = JSON.stringify(messages.at(-1)?.content);
        assert(last.includes('echo: hello from patch'), `MCP result missing: ${last}`);
        return reply(text('The test server echoed it back.'));
      },
    );
    const term = launch();
    const approval = await term.waitFor("This project's .mcp.json wants to start an MCP server");
    assert(
      /proj\s+.*node.*mcp-test-server\.mjs/.test(approval),
      'approval should show the command',
    );
    await term.press('down');
    await term.press('enter'); // Yes, and remember for this project
    await term.waitFor('What do you want to build?');
    const approvals = readFileSync(join(ws.home, 'mcp-approvals.json'), 'utf8');
    assert(approvals.includes('"proj"'), 'the approval should be remembered');
    // The prompt waits for the servers, so the first request has their tools.
    await term.submit('Echo something through MCP.');
    const prompt = await term.waitFor('Patch wants to use an MCP tool');
    assert(prompt.includes('test · echo'), 'the prompt should name the server and tool');
    assert(prompt.includes('{"text":"hello from patch"}'), 'the prompt should show the arguments');
    await term.press('enter'); // Yes
    await term.waitFor('The test server echoed it back.');
    const transcript = await term.transcript();
    assert(/mcp\s+test · echo\s+text: "hello from patch"/.test(transcript), 'mcp row missing');
    assert(/^\s+1 line$/m.test(transcript), 'the outcome should be on the second line');
    await term.submit('/mcp');
    await term.waitFor(/test\s+connected · stdio · 8 tools/);
    await term.waitFor(/proj\s+connected · stdio · \.mcp\.json · 8 tools/);
    await term.waitFor('echo, pixel, huge_image');
    await term.submit('/exit');
    await expectExit(term);
  },

  async 'no-api-key'({ launch }) {
    const term = launch([], { ANTHROPIC_API_KEY: '' });
    const screen = await term.waitFor('No Anthropic API key found.');
    assert(/no API key/.test(screen), 'welcome status should say no API key');
    await term.submit('hello');
    await term.waitFor(/No Anthropic API key found[\s\S]*No Anthropic API key found/);
    await term.press('ctrl-d');
    await expectExit(term);
  },

  async 'directory-mode'({ server, launch }) {
    server.enqueue(reply(text('Directory mode works.')));
    const term = launch();
    await term.waitFor('No Git repository detected.');
    await term.submit('hello');
    await term.waitFor('Directory mode works.');
    await term.submit('/diff');
    await term.waitFor('Patch is working in directory mode.');
    await term.submit('/exit');
    await expectExit(term);
  },
};

interface PtchResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs ptch without a pty. Asynchronous on purpose: the mock server lives in this process, so a
 * synchronous spawn would block it from answering.
 */
function runPtch(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; encoding?: 'utf8' },
): Promise<PtchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN_JS, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`ptch ${args.join(' ')} timed out\n${stderr}`));
    }, 30_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

// Print mode runs without a pty.
async function printModeChecks(server: MockAnthropicServer, ws: Workspace): Promise<void> {
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_BASE_URL: server.url,
    PATCH_HOME: ws.home,
  };
  server.enqueue(
    reply(tool('read_file', { path: 'README.md' })),
    reply(text('demo-app is a small service with session handling and an HTTP client.')),
  );
  let result = await runPtch(['-p', 'describe this repository'], {
    cwd: ws.repo,
    env,
    encoding: 'utf8',
  });
  assert(result.status === 0, `print mode exit ${result.status}: ${result.stderr}`);
  assert(result.stdout.includes('demo-app is a small service'), 'print stdout');
  assert(
    /read\s+README\.md/.test(stripVTControlCharacters(result.stderr)),
    `print stderr tool row missing; stderr was:\n${result.stderr}`,
  );

  server.enqueue(
    reply(tool('bash', { command: 'npm test' })),
    reply(text('I could not run the tests without approval.')),
  );
  result = await runPtch(['-p', 'run tests', '--output-format', 'json'], {
    cwd: ws.repo,
    env,
    encoding: 'utf8',
  });
  const json = JSON.parse(result.stdout) as { status: string; permission_denials?: string[] };
  assert(json.status === 'completed', 'json status');
  assert((json.permission_denials ?? []).length === 1, 'json should list the skipped command');
  assert(/--allow-command "npm test"/.test(result.stderr), 'stderr should explain the flag');

  result = await runPtch(['-p', 'hi'], {
    cwd: ws.repo,
    env: { ...env, ANTHROPIC_API_KEY: '' },
    encoding: 'utf8',
  });
  assert(result.status === 2 && result.stderr.includes('No Anthropic API key found.'), 'no key');

  result = await runPtch(['-p', 'x', '--bogus'], { cwd: ws.repo, env, encoding: 'utf8' });
  assert(result.status === 2 && result.stderr.includes('Unknown option'), 'usage error');

  server.enqueue({
    status: 401,
    error: { type: 'authentication_error', message: 'invalid x-api-key' },
  });
  result = await runPtch(['-p', 'hi'], { cwd: ws.repo, env, encoding: 'utf8' });
  assert(result.status === 1, `auth failure exit ${result.status}`);
  assert(result.stderr.includes('Anthropic request failed: authentication error.'), result.stderr);

  writeFileSync(join(ws.repo, 'diagram.png'), pngBytes(64, 32));
  server.enqueue(reply(text('A small black diagram.')));
  result = await runPtch(['-p', 'what is in @diagram.png?'], {
    cwd: ws.repo,
    env,
    encoding: 'utf8',
  });
  assert(result.status === 0, `print mode image exit ${result.status}: ${result.stderr}`);
  const content = JSON.stringify(server.requests.at(-1)?.body.messages ?? []);
  assert(/"type":"image".*"text":"what is in @diagram\.png\?"/.test(content), 'print image');
  console.log('print mode: ok');
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!existsSync(MAIN_JS)) throw new Error('Build first: pnpm build');
  mkdirSync(OUT_DIR, { recursive: true });
  const requested = process.argv.slice(2);
  const names = requested.length > 0 ? requested : [...Object.keys(scenarios), 'print'];
  let failed = 0;

  for (const name of names) {
    const ws = makeWorkspace({ git: name !== 'directory-mode' });
    const server = await startMockAnthropicServer({ strict: true });
    const sessions: TerminalSession[] = [];
    const launch = (args: string[] = [], env: Record<string, string> = {}) => {
      const term = TerminalSession.start({
        cwd: ws.repo,
        args,
        env: {
          ANTHROPIC_API_KEY: 'test-key',
          ANTHROPIC_BASE_URL: server.url,
          PATCH_HOME: ws.home,
          ...env,
        },
      });
      sessions.push(term);
      return term;
    };
    const started = Date.now();
    try {
      if (name === 'print') await printModeChecks(server, ws);
      else {
        const scenario = scenarios[name];
        if (!scenario) throw new Error(`Unknown scenario: ${name}`);
        await scenario({ ws, server, launch });
      }
      assert(
        server.violations.length === 0,
        `API conformance violations:\n${server.violations.join('\n')}`,
      );
      console.log(`✓ ${name} (${Date.now() - started}ms)`);
    } catch (error) {
      failed++;
      console.log(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      for (const [index, term] of sessions.entries()) {
        writeFileSync(join(OUT_DIR, `${name}-${index}.txt`), await term.transcript());
        writeFileSync(join(OUT_DIR, `${name}-${index}.raw.txt`), term.raw);
        term.kill();
      }
      // A session still running holds its working directory, which would block the cleanup.
      await Promise.race([
        Promise.all(sessions.map((term) => term.exited)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      await server.close();
      try {
        ws.cleanup();
      } catch (error) {
        console.log(`  (could not remove ${ws.root}: ${String(error)})`);
      }
    }
  }
  console.log(failed === 0 ? '\nAll scenarios passed.' : `\n${failed} scenario(s) failed.`);
  console.log(`Transcripts: ${OUT_DIR}`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
