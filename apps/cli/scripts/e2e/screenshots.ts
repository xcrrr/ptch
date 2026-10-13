/**
 * Regenerates the README screenshots in docs/images from real sessions: the built `ptch` binary
 * in a pseudo-terminal, scripted through the mock Anthropic API, rendered to SVG (see svg.ts).
 *
 *   pnpm build && pnpm -C apps/cli screenshots
 *
 * These are the local agent UI (switched on with PATCH_ENABLE_LOCAL=1, see terminal.ts). The cloud
 * view, which is what `ptch` opens, has its own pictures: `pnpm -C apps/cli screenshots:cloud`.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startMockAnthropicServer,
  type MockAnthropicServer,
} from '@patch/provider-anthropic/testing';
import { git, makeWorkspace, reply, text, tool, type Workspace } from './harness.js';
import type { SvgOptions } from './svg.js';
import { MAIN_JS, TerminalSession } from './terminal.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..', '..');
const IMAGES_DIR = join(REPO_ROOT, 'docs', 'images');
const COLS = 100;
/** Tall enough that a whole session stays on screen; blank rows are trimmed from the pictures. */
const ROWS = 60;
const MAX_BYTES = 150 * 1024;
const TITLE = 'ptch — ~/code/demo-app';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Context {
  server: MockAnthropicServer;
  launch: (rows?: number) => TerminalSession;
  save: (file: string, term: TerminalSession, options?: SvgOptions) => Promise<void>;
}

type Shot = (ctx: Context) => Promise<void>;

const shots: Record<string, Shot> = {
  async welcome({ launch, save }) {
    // A typical window height, so the logo sits where it does for most people.
    const term = launch(26);
    await term.waitFor('What do you want to build?');
    await term.waitFor('v0.1.0');
    // Let the intro (and its sweep of light) finish.
    await sleep(1_500);
    await save('welcome.svg', term);
    await quit(term);
  },

  async session({ server, launch, save }) {
    server.enqueue(
      reply(
        text("I'll run the tests first."),
        tool('bash', { command: 'node --test', description: 'Run the test suite' }),
      ),
      reply(
        text(
          'One failure: a session should be expired exactly at its expiry time. ' +
            'Let me find the check.',
        ),
        tool('grep', { pattern: 'isExpired', path: 'src' }),
        tool('read_file', { path: 'src/auth/session.js' }),
      ),
      reply(
        text(
          '`isExpired` compares with `>`, so a session is still valid at the instant it expires. ' +
            'Switching to `>=`.',
        ),
        tool('edit_file', {
          path: 'src/auth/session.js',
          old_string: 'return now > session.expiresAt;',
          new_string: 'return now >= session.expiresAt;',
        }),
      ),
      reply(tool('bash', { command: 'node --test', description: 'Re-run the tests' })),
      reply(
        text(
          'Fixed: `isExpired` now uses `>=`, so a session expires exactly at `expiresAt`, as its ' +
            'doc comment says. All 4 tests pass.',
        ),
      ),
    );
    const term = launch();
    await term.waitFor('What do you want to build?');
    await term.submit('The session tests are failing. Can you find the cause and fix it?');
    // `node` runs arbitrary code, so each run is approved on its own (no session option).
    await term.waitFor('Patch wants to run a command', { timeoutMs: 30_000 });
    await term.press('enter'); // Yes
    await term.waitFor('Patch wants to edit src/auth/session.js', { timeoutMs: 30_000 });
    await sleep(300);
    // The prompt with the turn that led to it: from the sentence before the edit downward.
    await save('permission.svg', term, { fromLine: await lineOf(term, '`isExpired` compares') });
    await term.press('enter'); // Yes
    await term.waitFor('Patch wants to run a command', { timeoutMs: 30_000 });
    await term.press('enter'); // Yes
    await term.waitFor('All 4 tests pass', { timeoutMs: 30_000 });
    await term.waitFor('Reply to Patch');
    await sleep(300);
    await save('session.svg', term);
    await quit(term);
  },
};

/** Index of the last buffer line containing `needle` (inline code renders without backticks). */
async function lineOf(term: TerminalSession, needle: string): Promise<number> {
  const plain = needle.replace(/`/g, '');
  const lines = (await term.transcript()).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.includes(plain)) return i;
  }
  throw new Error(`"${plain}" is not on screen`);
}

async function quit(term: TerminalSession): Promise<void> {
  await term.submit('/exit');
  const code = await Promise.race([
    term.exited,
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error('ptch did not exit')), 8000),
    ),
  ]);
  if (code !== 0) throw new Error(`ptch exited with code ${code}`);
}

/** A committed PATCH.md, so the welcome header lists it like in a real project. */
function addInstructions(ws: Workspace): void {
  writeFileSync(
    join(ws.repo, 'PATCH.md'),
    '# demo-app\n\nRun the tests with `node --test`. Keep changes small and covered by a test.\n',
  );
  git(ws.repo, 'add', 'PATCH.md');
  git(ws.repo, 'commit', '-q', '-m', 'Add PATCH.md');
}

async function main(): Promise<void> {
  if (!existsSync(MAIN_JS)) throw new Error('Build first: pnpm build');
  mkdirSync(IMAGES_DIR, { recursive: true });
  for (const [name, shot] of Object.entries(shots)) {
    // The repository sits at ~/code/demo-app of a throwaway home directory, so paths read naturally.
    const ws = makeWorkspace({ repoPath: join('home', 'code', 'demo-app') });
    const userHome = join(ws.root, 'home');
    addInstructions(ws);
    const server = await startMockAnthropicServer({ strict: true });
    const sessions: TerminalSession[] = [];
    const launch = (rows = ROWS) => {
      const term = TerminalSession.start({
        cwd: ws.repo,
        cols: COLS,
        rows,
        env: {
          ANTHROPIC_API_KEY: 'test-key',
          ANTHROPIC_BASE_URL: server.url,
          PATCH_HOME: ws.home,
          HOME: userHome,
          USERPROFILE: userHome,
        },
      });
      sessions.push(term);
      return term;
    };
    const save = async (file: string, term: TerminalSession, options: SvgOptions = {}) => {
      const picture = await term.svg({ title: TITLE, ...options });
      const bytes = Buffer.byteLength(picture.svg);
      if (bytes > MAX_BYTES) throw new Error(`${file} is ${bytes} bytes (limit ${MAX_BYTES})`);
      const path = join(IMAGES_DIR, file);
      writeFileSync(path, picture.svg);
      const shown = (await term.transcript()).split('\n').slice(picture.from, picture.to);
      console.log(
        `\n${relative(REPO_ROOT, path)}: ${picture.width}x${picture.height}, ` +
          `${shown.length} rows, ${(bytes / 1024).toFixed(1)} KB`,
      );
      console.log(shown.map((line) => `  | ${line.trimEnd()}`).join('\n'));
    };
    try {
      await shot({ server, launch, save });
      if (server.violations.length > 0) {
        throw new Error(`API conformance violations:\n${server.violations.join('\n')}`);
      }
    } catch (error) {
      for (const term of sessions) console.error(`----- ${name} -----\n${await term.screen()}`);
      throw error;
    } finally {
      for (const term of sessions) term.kill();
      // A session still running holds its working directory, which would block the cleanup.
      await Promise.race([Promise.all(sessions.map((term) => term.exited)), sleep(3000)]);
      await server.close();
      ws.cleanup();
    }
  }
}

await main();
// The pseudo-terminal's console host keeps the event loop alive.
process.exit(0);
