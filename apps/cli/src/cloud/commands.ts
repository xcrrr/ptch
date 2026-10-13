import { execFile } from 'node:child_process';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import chalk from 'chalk';
import {
  PERMISSION_PROFILES,
  isTerminal,
  type EventRecord,
  type PermissionProfile,
  type ProjectRecord,
  type TaskRecord,
} from '@patch/cloud-protocol';
import { unsafePathReason } from '@patch/cloud-protocol/archive';
import { cleanTerminalOutput, hasHiddenControls } from '../ui/text-layout.js';
import { CloudApi, CloudApiError } from './client.js';
import { DEFAULT_SITE, TokenSession, loginWithBrowser, logoutDevice } from './auth.js';
import { createSecretStore, type SecretStore } from './secrets.js';
import { CloudConfigError, CloudConfigStore, normalizeCloudUrl } from './config.js';
import { STATUS_LABEL, ago, duration, money, renderEvent, taskRuntime } from './format.js';
import {
  SnapshotError,
  buildArchive,
  planSnapshot,
  renderPreview,
  type SnapshotPlan,
} from './snapshot.js';

const execFileAsync = promisify(execFile);

export interface CloudIO {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  cwd: string;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  /** Test hooks: where tokens are kept, and how the browser is opened. */
  secretStore?: SecretStore;
  openBrowser?: (url: string) => Promise<void>;
  /** Test hook: answers prompts without a terminal. */
  answers?: { token?: string; confirm?: boolean };
  signal?: AbortSignal;
}

export const CLOUD_HELP = `Patch Cloud — hand work to the cloud from your terminal

Usage
  ptch                              Open Patch Cloud in your terminal: chat, runs, project memory (needs a terminal)
  ptch login [--site <url>]         Sign in through your browser (shared with the website and the phone app)
        --no-browser                Print the sign-in address instead of opening it
  ptch logout                       Sign this device out (also revokes it on Patch Cloud)
  ptch whoami                       Who you are signed in as, and where
  ptch cloud login <url>            Legacy: connect with a pasted API token (input hidden)
  ptch cloud status                 Cloud status: worker, queue, budget
  ptch cloud submit "<prompt>"      Upload this repository's state and run a task
        --profile plan|edits|auto   What the agent may do (default: auto, inside the sandbox)
        --model <id>  --max-cost <usd>  --max-time <minutes>  --max-steps <n>
        --project <name|id>         Cloud project (default: linked or created for this repo)
        --dry-run                   Show exactly what would be uploaded, then stop
        --list-files                With --dry-run: list every file
        --yes                       Do not ask for confirmation
        --follow                    Stream the log until the task ends
  ptch cloud list [--status s] [--limit n]
  ptch cloud show <task>            Details of one task
  ptch cloud logs <task> [--follow] [--verbose]
  ptch cloud cancel <task>
  ptch cloud retry <task>           Run the same task again (a new task)
  ptch cloud result <task>          The agent's answer and what it changed
  ptch cloud apply <task> [--apply] Save the result patch; with --apply, apply it if it fits cleanly
  ptch cloud projects               List cloud projects
  ptch cloud brain [list|add|search] ...   Project memory

<task> can be a task id or any unique prefix of one.
Environment: PATCH_CLOUD_URL and PATCH_CLOUD_TOKEN override the saved connection.`;

interface Flags {
  positionals: string[];
  values: Map<string, string>;
  bools: Set<string>;
}

const VALUE_FLAGS = new Set([
  'profile',
  'model',
  'max-cost',
  'max-time',
  'max-steps',
  'project',
  'status',
  'limit',
  'kind',
  'title',
  'body',
  'tags',
]);
const BOOL_FLAGS = new Set([
  'yes',
  'dry-run',
  'list-files',
  'follow',
  'apply',
  'verbose',
  'json',
  'force',
]);
const SHORT: Record<string, string> = { y: 'yes', f: 'follow', v: 'verbose' };

class UsageProblem extends Error {}

function parseFlags(args: string[]): Flags {
  const out: Flags = { positionals: [], values: new Map(), bools: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--') {
      out.positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--') || (arg.startsWith('-') && arg.length === 2)) {
      const raw = arg.startsWith('--') ? arg.slice(2) : (SHORT[arg.slice(1)] ?? arg.slice(1));
      const eq = raw.indexOf('=');
      const name = eq === -1 ? raw : raw.slice(0, eq);
      if (BOOL_FLAGS.has(name)) out.bools.add(name);
      else if (VALUE_FLAGS.has(name)) {
        const value = eq === -1 ? args[++i] : raw.slice(eq + 1);
        if (value === undefined) throw new UsageProblem(`--${name} needs a value.`);
        out.values.set(name, value);
      } else throw new UsageProblem(`Unknown option --${name}. Run "ptch cloud" for usage.`);
    } else out.positionals.push(arg);
  }
  return out;
}

function number(flags: Flags, name: string, min: number, max: number): number | undefined {
  const raw = flags.values.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new UsageProblem(`--${name} must be a number between ${min} and ${max}.`);
  }
  return value;
}

function ask(io: CloudIO, question: string): Promise<string> {
  const rl = createInterface({
    input: io.stdin,
    output: io.stderr as NodeJS.WritableStream,
    terminal: false,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function readSecret(io: CloudIO, label: string): Promise<string> {
  if (io.answers?.token !== undefined) return io.answers.token;
  if (!io.stdin.isTTY) {
    const rl = createInterface({ input: io.stdin });
    const line = await new Promise<string>((resolve) => rl.once('line', resolve));
    rl.close();
    return line;
  }
  io.stderr.write(label);
  return new Promise((resolve) => {
    const stdin = io.stdin;
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          io.stderr.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          io.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function confirm(io: CloudIO, question: string): Promise<boolean> {
  if (io.answers?.confirm !== undefined) return io.answers.confirm;
  if (!io.stdin.isTTY) return false;
  const answer = await ask(io, `${question} [y/N] `);
  return /^y(es)?$/i.test(answer.trim());
}

function colorStatus(status: TaskRecord['status']): string {
  const label = STATUS_LABEL[status];
  switch (status) {
    case 'succeeded':
      return chalk.green(label);
    case 'failed':
      return chalk.red(label);
    case 'running':
    case 'starting':
      return chalk.cyan(label);
    case 'interrupted':
      return chalk.yellow(label);
    default:
      return chalk.dim(label);
  }
}

/**
 * The one way a command prints. Everything goes through `cleanTerminalOutput`: text from Patch
 * Cloud (titles, logs, errors, names) can carry escape sequences, and only the plain colours
 * Patch adds itself survive.
 */
function out(io: CloudIO, text = ''): void {
  io.stdout.write(`${cleanTerminalOutput(text)}\n`);
}
function err(io: CloudIO, text: string): void {
  io.stderr.write(`${cleanTerminalOutput(text)}\n`);
}

/** Entry point of `ptch cloud ...`. Returns the process exit code. */
export async function runCloud(argv: string[], io: CloudIO): Promise<number> {
  const config = new CloudConfigStore(io.env, io.homeDir);
  const [command, ...rest] = argv;
  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      out(io, CLOUD_HELP);
      return 0;
    }
    if (command === 'login') return await login(io, config, rest);
    if (command === 'logout') return await logout(io, config);
    const api = await connect(io, config);
    if (!api) {
      err(io, 'Not signed in to Patch Cloud. Run: ptch login');
      return 2;
    }
    const flags = parseFlags(rest);
    switch (command) {
      case 'whoami':
        return await whoami(io, api);
      case 'status':
        return await status(io, api);
      case 'submit':
        return await submit(io, api, config, flags);
      case 'list':
      case 'ls':
        return await list(io, api, flags);
      case 'show':
        return await show(io, api, flags);
      case 'logs':
        return await logs(io, api, flags);
      case 'cancel':
        return await cancel(io, api, flags);
      case 'retry':
        return await retry(io, api, flags);
      case 'result':
        return await result(io, api, flags);
      case 'apply':
        return await apply(io, api, config, flags);
      case 'projects':
        return await projects(io, api);
      case 'brain':
        return await brain(io, api, config, flags);
      default:
        err(io, `Unknown command "ptch cloud ${command}". Run "ptch cloud" for usage.`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageProblem) {
      err(io, error.message);
      return 2;
    }
    if (
      error instanceof CloudApiError ||
      error instanceof CloudConfigError ||
      error instanceof SnapshotError
    ) {
      err(io, error.message);
      return 1;
    }
    if ((error as Error).name === 'AbortError') {
      err(io, 'Interrupted. The task keeps running in the cloud.');
      return 130;
    }
    throw error;
  }
}

/** The API client for this machine: a static token, or the browser sign-in with automatic renewal. */
async function connect(io: CloudIO, config: CloudConfigStore): Promise<CloudApi | null> {
  const creds = config.credentials();
  if (creds) return new CloudApi(creds, io.fetchImpl);
  const oauth = config.oauth();
  if (!oauth) return null;
  const store = io.secretStore ?? (await createSecretStore(io.env, io.homeDir));
  const session = new TokenSession(store, oauth.tokenUrl, io.fetchImpl);
  return new CloudApi({ url: oauth.url, token: '' }, io.fetchImpl, session);
}

async function logout(io: CloudIO, config: CloudConfigStore): Promise<number> {
  const oauth = config.oauth();
  if (oauth) {
    const store = io.secretStore ?? (await createSecretStore(io.env, io.homeDir));
    const revoked = await logoutDevice(store, oauth.revokeUrl, io.fetchImpl);
    out(
      io,
      revoked
        ? 'Signed out. This device can no longer use Patch Cloud.'
        : 'Signed out on this device. Patch Cloud could not be reached to revoke it: remove this device under Settings in Patch HQ.',
    );
  } else {
    out(io, 'Saved connection removed.');
  }
  config.clearCredentials();
  return 0;
}

async function whoami(io: CloudIO, api: CloudApi): Promise<number> {
  const me = await api.me();
  out(io, `Signed in as ${me.account?.name ?? 'unknown'} on ${api.url}`);
  if (me.client) out(io, `Device      ${me.client.device} (${me.client.name})`);
  else out(io, `Credential  ${me.kind ?? 'none'}`);
  if (me.version) out(io, `Patch Cloud ${me.version}`);
  return 0;
}

async function login(io: CloudIO, config: CloudConfigStore, args: string[]): Promise<number> {
  const target = args[0];
  if (!target || target.startsWith('-')) return browserLogin(io, config, args);
  const url = normalizeCloudUrl(target);
  const token = (await readSecret(io, `API token for ${url} (input hidden): `)).trim();
  if (!token.startsWith('pct_')) {
    err(
      io,
      'That does not look like a Patch Cloud token (they start with "pct_"). Create one on the host: patch-cloud admin create-token <name>',
    );
    return 2;
  }
  const status = await new CloudApi({ url, token }, io.fetchImpl).status();
  config.saveCredentials({ url, token });
  out(
    io,
    `Connected to ${url} (Patch Cloud ${status.version}). Worker: ${status.worker.online ? 'online' : 'offline'}.`,
  );
  out(io, `Saved to ${config.path}.`);
  return 0;
}

async function browserLogin(
  io: CloudIO,
  config: CloudConfigStore,
  args: string[],
): Promise<number> {
  let site: string | undefined;
  let browser = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--site') {
      site = args[++i];
      if (!site) throw new UsageProblem('--site needs an address.');
    } else if (arg?.startsWith('--site=')) site = arg.slice('--site='.length);
    else if (arg === '--no-browser') browser = false;
    else
      throw new UsageProblem(
        `Unknown option ${arg}. Usage: ptch login [--site <url>] [--no-browser]`,
      );
  }
  const target = site ?? io.env.PATCH_SITE?.trim() ?? config.oauth()?.site ?? DEFAULT_SITE;
  out(io, `Signing in to ${target}`);
  const { tokens, discovery } = await loginWithBrowser(target, {
    ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
    ...(browser
      ? io.openBrowser
        ? { open: io.openBrowser }
        : {}
      : { open: async () => undefined }),
    announce: (url) => out(io, `If the browser does not open, visit this address:\n  ${url}`),
    ...(io.signal ? { signal: io.signal } : {}),
  });
  const store = io.secretStore ?? (await createSecretStore(io.env, io.homeDir));
  await store.set(tokens);
  config.saveOAuth(discovery.api, {
    site: new URL(discovery.authorize).origin,
    tokenUrl: discovery.token,
    revokeUrl: discovery.revoke,
  });
  const me = await new CloudApi(
    { url: discovery.api, token: tokens.accessToken },
    io.fetchImpl,
  ).me();
  out(io, `Signed in as ${me.account?.name ?? 'owner'} on ${discovery.api}.`);
  out(io, `Tokens are kept in ${store.label}. Sign out with: ptch logout`);
  return 0;
}

async function status(io: CloudIO, api: CloudApi): Promise<number> {
  const s = await api.status();
  out(io, `Patch Cloud ${s.version} at ${api.url}`);
  out(
    io,
    `Worker   ${s.worker.online ? chalk.green('online') : chalk.red('offline')}${s.worker.sandbox ? `  (${s.worker.sandbox})` : ''}${s.worker.lastSeen ? `  last seen ${ago(s.worker.lastSeen)}` : ''}`,
  );
  const q = s.queue;
  out(
    io,
    `Queue    ${q.queued} queued · ${q.starting + q.running} running · ${q.succeeded} succeeded · ${q.failed} failed · ${q.interrupted} interrupted · ${q.cancelled} cancelled`,
  );
  const b = s.budget;
  out(
    io,
    `Spend    ${money(b.spentTodayUsd)} today${b.dailyLimitUsd !== null ? ` of ${money(b.dailyLimitUsd)}` : ''} · ${money(b.spentMonthUsd)} this month${b.monthlyLimitUsd !== null ? ` of ${money(b.monthlyLimitUsd)}` : ''}${b.blocked ? chalk.yellow('  (limit reached: queued tasks wait)') : ''}`,
  );
  return 0;
}

async function projectsList(api: CloudApi): Promise<ProjectRecord[]> {
  return api.listProjects();
}

async function projects(io: CloudIO, api: CloudApi): Promise<number> {
  const list = await projectsList(api);
  if (list.length === 0)
    out(io, 'No projects yet. "ptch cloud submit" creates one for the current repository.');
  for (const p of list) {
    out(
      io,
      `${p.id}  ${p.name}  (${p.taskCount} tasks${p.lastTaskAt ? `, last ${ago(p.lastTaskAt)}` : ''})`,
    );
  }
  return 0;
}

function profileOf(flags: Flags): PermissionProfile {
  const value = flags.values.get('profile') ?? 'auto';
  if (!(PERMISSION_PROFILES as readonly string[]).includes(value)) {
    throw new UsageProblem(`--profile must be one of: ${PERMISSION_PROFILES.join(', ')}.`);
  }
  return value as PermissionProfile;
}

/** The cloud project for this repository, and whether it still has to be created. */
async function resolveProject(
  api: CloudApi,
  config: CloudConfigStore,
  plan: SnapshotPlan,
  flags: Flags,
): Promise<{ project: ProjectRecord | null; name: string }> {
  const all = await projectsList(api);
  const wanted = flags.values.get('project');
  if (wanted) {
    const found = all.find((p) => p.id === wanted || p.slug === wanted || p.name === wanted);
    if (found) return { project: found, name: found.name };
    return { project: null, name: wanted };
  }
  const linked = config.projectFor(plan.root);
  const linkedProject = linked ? all.find((p) => p.id === linked) : undefined;
  if (linkedProject) return { project: linkedProject, name: linkedProject.name };
  const byRemote = plan.remote ? all.filter((p) => p.gitRemote === plan.remote) : [];
  if (byRemote.length === 1 && byRemote[0]) return { project: byRemote[0], name: byRemote[0].name };
  const name = basename(plan.root);
  const byName = all.find((p) => p.name === name);
  return byName ? { project: byName, name } : { project: null, name };
}

async function submit(
  io: CloudIO,
  api: CloudApi,
  config: CloudConfigStore,
  flags: Flags,
): Promise<number> {
  let prompt = flags.positionals.join(' ').trim();
  if (!prompt && !io.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of io.stdin)
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
    prompt = Buffer.concat(chunks).toString('utf8').trim();
  }
  if (!prompt) throw new UsageProblem('Usage: ptch cloud submit "<what the agent should do>"');
  const profile = profileOf(flags);

  const plan = await planSnapshot(io.cwd);
  const { project, name } = await resolveProject(api, config, plan, flags);

  for (const line of renderPreview(
    plan,
    { host: api.url, project: project ? name : `${name} (will be created)`, profile },
    { listFiles: flags.bools.has('list-files') },
  )) {
    out(io, line);
  }
  out(io);
  out(io, `  Task: ${prompt.length > 300 ? `${prompt.slice(0, 300)}…` : prompt}`);
  out(io);
  if (flags.bools.has('dry-run')) {
    out(io, 'Dry run: nothing was uploaded.');
    return 0;
  }
  if (plan.files.length === 0) {
    err(io, 'There are no files to upload.');
    return 1;
  }
  if (!flags.bools.has('yes')) {
    if (!io.stdin.isTTY && io.answers?.confirm === undefined) {
      err(
        io,
        'This would upload the files listed above. Run it in a terminal to confirm, or pass --yes.',
      );
      return 2;
    }
    if (!(await confirm(io, 'Upload these files and start the task?'))) {
      out(io, 'Cancelled. Nothing was uploaded.');
      return 1;
    }
  }

  const target =
    project ?? (await api.createProject({ name, description: '', gitRemote: plan.remote }));
  if (!project) out(io, `Created cloud project "${target.name}".`);
  config.linkProject(plan.root, target.id);

  const built = await buildArchive(plan);
  if (built.unreadable.length > 0) {
    err(
      io,
      `Could not read ${built.unreadable.length} file(s), left out: ${built.unreadable.slice(0, 5).join(', ')}`,
    );
  }
  out(
    io,
    `Uploading ${built.manifest.fileCount} files (${(built.archive.length / 1024 / 1024).toFixed(1)} MB compressed)…`,
  );
  const snapshot = await api.uploadSnapshot(target.id, built.archive, built.manifest);

  const maxMinutes = number(flags, 'max-time', 1, 1440);
  const maxCost = number(flags, 'max-cost', 0.01, 1000);
  const maxSteps = number(flags, 'max-steps', 1, 1000);
  const limits = {
    ...(maxCost !== undefined ? { maxCostUsd: maxCost } : {}),
    ...(maxMinutes !== undefined ? { maxDurationSec: Math.round(maxMinutes * 60) } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
  };
  const model = flags.values.get('model');
  const title = flags.values.get('title');
  const task = await api.createTask({
    projectId: target.id,
    snapshotId: snapshot.id,
    prompt,
    profile,
    origin: 'cli',
    ...(title ? { title } : {}),
    ...(model ? { model } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  });
  out(
    io,
    `Queued ${chalk.bold(task.id)}  (${task.profile}, limit ${money(task.limits.maxCostUsd)} / ${duration(task.limits.maxDurationSec * 1000)})`,
  );
  if (!flags.bools.has('follow')) {
    out(io, `Follow it:  ptch cloud logs ${task.id} --follow`);
    out(io, `The task runs on the cloud host; you can close this terminal.`);
    return 0;
  }
  return followTask(io, api, task.id, flags.bools.has('verbose'));
}

async function resolveTaskId(api: CloudApi, input: string | undefined): Promise<string> {
  if (!input) throw new UsageProblem('Give a task id (or a unique prefix of one).');
  if (/^tsk_[0-9a-z]{20,}$/.test(input)) return input;
  const tasks = await api.listTasks({ limit: 200 });
  const matches = tasks.filter((t) => t.id.startsWith(input) || t.id.startsWith(`tsk_${input}`));
  if (matches.length === 1 && matches[0]) return matches[0].id;
  if (matches.length === 0) throw new UsageProblem(`No task starts with "${input}".`);
  throw new UsageProblem(`"${input}" matches ${matches.length} tasks; use more characters.`);
}

async function followTask(
  io: CloudIO,
  api: CloudApi,
  id: string,
  verbose: boolean,
  after = 0,
): Promise<number> {
  const final = await api.follow(
    id,
    (event) => {
      const line = renderEvent(event, { verbose });
      if (line !== null) out(io, line);
    },
    { after, ...(io.signal ? { signal: io.signal } : {}) },
  );
  const { task } = await api.getTask(id);
  out(io);
  out(
    io,
    `${colorStatus(task.status)}  ${money(task.costUsd)}${taskRuntime(task) ? `  ${taskRuntime(task)}` : ''}${task.error ? `\n${task.error}` : ''}`,
  );
  if (task.status === 'succeeded') out(io, `Result: ptch cloud result ${id}`);
  void final;
  return task.status === 'succeeded' ? 0 : 1;
}

async function list(io: CloudIO, api: CloudApi, flags: Flags): Promise<number> {
  const status = flags.values.get('status');
  const limit = number(flags, 'limit', 1, 200) ?? 20;
  const tasks = await api.listTasks({ limit, ...(status ? { status } : {}) });
  if (tasks.length === 0) {
    out(io, 'No tasks yet.');
    return 0;
  }
  if (flags.bools.has('json')) {
    out(io, JSON.stringify(tasks, null, 2));
    return 0;
  }
  for (const t of tasks) {
    const title = t.title.length > 52 ? `${t.title.slice(0, 51)}…` : t.title;
    out(
      io,
      `${t.id}  ${colorStatus(t.status).padEnd(t.status === 'succeeded' ? 19 : 18)}  ${money(t.costUsd).padStart(7)}  ${ago(t.createdAt).padEnd(12)} ${title}`,
    );
  }
  return 0;
}

async function show(io: CloudIO, api: CloudApi, flags: Flags): Promise<number> {
  const id = await resolveTaskId(api, flags.positionals[0]);
  const detail = await api.getTask(id);
  const t = detail.task;
  if (flags.bools.has('json')) {
    out(io, JSON.stringify(detail, null, 2));
    return 0;
  }
  out(io, `${chalk.bold(t.title)}`);
  out(
    io,
    `${t.id}  ${colorStatus(t.status)}${t.cancelRequested && !isTerminal(t.status) ? chalk.yellow('  (cancel requested)') : ''}`,
  );
  out(io, `Created   ${ago(t.createdAt)}${t.startedAt ? `  ·  ran ${taskRuntime(t)}` : ''}`);
  out(
    io,
    `Profile   ${t.profile}${t.model ? `  ·  model ${t.model}` : ''}  ·  limits ${money(t.limits.maxCostUsd)}, ${duration(t.limits.maxDurationSec * 1000)}, ${t.limits.maxSteps} steps`,
  );
  out(
    io,
    `Usage     ${money(t.costUsd)}  ·  ${t.tokens.input} in / ${t.tokens.output} out tokens  ·  ${t.steps} steps, ${t.toolCalls} tool calls`,
  );
  if (detail.snapshot) {
    out(
      io,
      `Snapshot  ${detail.snapshot.fileCount} files  ·  base ${detail.snapshot.baseCommit?.slice(0, 10) ?? 'none'}  ·  ${detail.snapshot.dirtyFiles.length} uncommitted file(s) included`,
    );
  }
  if (t.error) out(io, `Error     ${t.error}`);
  if (t.resultSummary) out(io, `\n${t.resultSummary}`);
  if (detail.artifacts.length > 0) {
    out(io, `\nArtifacts: ${detail.artifacts.map((a) => a.name).join(', ')}`);
  }
  return 0;
}

async function logs(io: CloudIO, api: CloudApi, flags: Flags): Promise<number> {
  const id = await resolveTaskId(api, flags.positionals[0]);
  const verbose = flags.bools.has('verbose');
  if (flags.bools.has('follow')) return followTask(io, api, id, verbose);
  let cursor = 0;
  for (let page = 0; page < 50; page++) {
    const batch = await api.events(id, cursor);
    for (const event of batch.events) {
      const line = renderEvent(event, { verbose });
      if (line !== null) out(io, line);
    }
    if (batch.events.length < 2000) break;
    cursor = batch.cursor;
  }
  return 0;
}

async function cancel(io: CloudIO, api: CloudApi, flags: Flags): Promise<number> {
  const id = await resolveTaskId(api, flags.positionals[0]);
  const task = await api.cancelTask(id);
  out(
    io,
    task.status === 'cancelled'
      ? 'Cancelled.'
      : 'Cancel requested; the worker stops the task within a few seconds.',
  );
  return 0;
}

async function retry(io: CloudIO, api: CloudApi, flags: Flags): Promise<number> {
  const id = await resolveTaskId(api, flags.positionals[0]);
  const task = await api.retryTask(id);
  out(io, `Queued ${task.id} (a new task with the same prompt and snapshot).`);
  return 0;
}

interface ChangedFile {
  path: string;
  status?: string;
  added?: number;
  removed?: number;
}

async function changesOf(
  api: CloudApi,
  id: string,
): Promise<{ files: ChangedFile[]; skipped: Array<{ path: string; reason: string }> }> {
  const page = await api.events(id, 0);
  const event = [...page.events].reverse().find((e: EventRecord) => e.type === 'task.changes');
  return {
    files: (event?.data.files as ChangedFile[] | undefined) ?? [],
    skipped: (event?.data.skipped as Array<{ path: string; reason: string }> | undefined) ?? [],
  };
}

async function result(io: CloudIO, api: CloudApi, flags: Flags): Promise<number> {
  const id = await resolveTaskId(api, flags.positionals[0]);
  const detail = await api.getTask(id);
  const t = detail.task;
  out(
    io,
    `${chalk.bold(t.title)}  ${colorStatus(t.status)}  ${money(t.costUsd)}${taskRuntime(t) ? `  ${taskRuntime(t)}` : ''}`,
  );
  if (!isTerminal(t.status)) {
    out(io, `Still ${t.status}. Follow it with: ptch cloud logs ${id} --follow`);
    return 1;
  }
  if (t.error) out(io, `\n${t.error}`);
  const answer = detail.artifacts.find((a) => a.kind === 'answer');
  if (answer) out(io, `\n${(await api.downloadArtifact(answer.id)).toString('utf8').trimEnd()}`);
  else if (t.resultSummary) out(io, `\n${t.resultSummary}`);

  const changes = await changesOf(api, id);
  if (changes.files.length > 0) {
    out(io, `\nChanged files (${changes.files.length}):`);
    for (const f of changes.files) {
      out(
        io,
        `  ${(f.status ?? 'modified').padEnd(9)} ${f.path}${f.added !== undefined ? `  +${f.added} -${f.removed ?? 0}` : ''}`,
      );
    }
  }
  if (changes.skipped.length > 0) {
    out(io, `\nNot transferred (${changes.skipped.length}):`);
    for (const s of changes.skipped.slice(0, 20)) out(io, `  ${s.path}  (${s.reason})`);
  }
  if (detail.artifacts.some((a) => a.kind === 'patch')) {
    out(io, `\nGet the changes:  ptch cloud apply ${id}`);
  }
  return t.status === 'succeeded' ? 0 : 1;
}

/**
 * Checks a patch that came over the network before git sees it: only plain text edits of files
 * inside the repository. Symlinks, renames, binary patches and anything touching .git are refused.
 */
export function validatePatch(patch: string): string | null {
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      for (const path of [header[1], header[2]]) {
        const reason =
          unsafePathReason(path ?? '') ??
          (hasHiddenControls(path ?? '') ? 'the path contains control characters' : null);
        if (reason) return `${JSON.stringify(path)}: ${reason}`;
      }
    } else if (line.startsWith('diff --git ')) {
      // A file header this check cannot read (an odd character in the name): git must not see it.
      return 'a file header in the patch is not in the plain form';
    } else if (
      /^(new|deleted|old|new) mode 120000/.test(line) ||
      /^(rename|copy) (from|to) /.test(line)
    ) {
      return `unexpected "${line.slice(0, 40)}" in the patch`;
    } else if (line.startsWith('GIT binary patch') || line.startsWith('Binary files')) {
      return 'the patch contains a binary change';
    }
  }
  return null;
}

/** The first of these paths that exists and is a symbolic link, if any. */
async function linkedDirectory(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      if ((await lstat(path)).isSymbolicLink()) return path;
    } catch {
      // not there yet
    }
  }
  return null;
}

async function apply(
  io: CloudIO,
  api: CloudApi,
  config: CloudConfigStore,
  flags: Flags,
): Promise<number> {
  const id = await resolveTaskId(api, flags.positionals[0]);
  const detail = await api.getTask(id);
  const patchArtifact = detail.artifacts.find((a) => a.kind === 'patch');
  if (!patchArtifact) {
    out(io, `Task ${id} (${detail.task.status}) produced no file changes.`);
    return 1;
  }
  const patch = (await api.downloadArtifact(patchArtifact.id)).toString('utf8');
  const problem = validatePatch(patch);
  if (problem) {
    err(io, `Refusing this patch: ${problem}.`);
    return 1;
  }

  const plan = await planSnapshot(io.cwd);
  const linked = config.projectFor(plan.root);
  if (linked && linked !== detail.task.projectId) {
    err(io, 'This task belongs to a different cloud project than this repository. Not applying.');
    return 1;
  }
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
    err(io, 'Refusing a task id that is not a plain id. Not saving anything.');
    return 1;
  }
  const dir = join(plan.root, '.patch', 'cloud');
  // The patch is saved inside the repository: not through a link that points somewhere else.
  const linkedBefore = await linkedDirectory([join(plan.root, '.patch'), dir]);
  if (linkedBefore) {
    err(
      io,
      `${linkedBefore} is a symbolic link. Refusing to save the patch through it; remove the link and run this again.`,
    );
    return 1;
  }
  await mkdir(dir, { recursive: true });
  const linkedAfter = await linkedDirectory([join(plan.root, '.patch'), dir]);
  if (linkedAfter) {
    err(io, `${linkedAfter} is a symbolic link. Refusing to save the patch through it.`);
    return 1;
  }
  const file = join(dir, `${id}.patch`);
  await writeFile(file, patch, { flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
    // Same task, same patch: keep the existing file rather than overwrite anything.
  });
  const changed = (patch.match(/^diff --git /gm) ?? []).length;
  out(io, `Saved the patch (${changed} file(s)) to ${file}`);
  if (!flags.bools.has('apply')) {
    out(
      io,
      `Nothing in your working tree was changed. To apply it:  ptch cloud apply ${id} --apply`,
    );
    out(io, `Or by hand:  git apply --check "${file}" && git apply "${file}"`);
    return 0;
  }

  try {
    await execFileAsync('git', ['apply', '--check', file], { cwd: plan.root });
  } catch (error) {
    err(io, 'The patch does not apply cleanly to your working tree, so nothing was changed:');
    err(io, String((error as { stderr?: string }).stderr ?? error).trim());
    err(io, `The patch is saved at ${file}; you can resolve it by hand.`);
    return 1;
  }
  await execFileAsync('git', ['apply', file], { cwd: plan.root });
  out(io, `Applied. Review it with "git diff"; nothing was committed.`);
  return 0;
}

async function brain(
  io: CloudIO,
  api: CloudApi,
  config: CloudConfigStore,
  flags: Flags,
): Promise<number> {
  const [sub = 'list', ...rest] = flags.positionals;
  const plan = await planSnapshot(io.cwd);
  const projectId = flags.values.get('project') ?? config.projectFor(plan.root);
  if (!projectId) {
    err(
      io,
      'This repository is not linked to a cloud project yet. Run "ptch cloud submit" once, or pass --project.',
    );
    return 1;
  }
  if (sub === 'add') {
    const title = flags.values.get('title') ?? rest.join(' ');
    if (!title)
      throw new UsageProblem(
        'Usage: ptch cloud brain add "<title>" [--kind note|decision|knowledge] [--body "<text>"]',
      );
    const kind = flags.values.get('kind') ?? 'note';
    if (!['note', 'decision', 'knowledge'].includes(kind))
      throw new UsageProblem('--kind must be note, decision or knowledge.');
    const entry = await api.addBrainEntry(projectId, {
      kind: kind as 'note' | 'decision' | 'knowledge',
      title,
      body: flags.values.get('body') ?? '',
      tags: (flags.values.get('tags') ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    });
    out(io, `Saved ${entry.kind} ${entry.id}.`);
    return 0;
  }
  const q = sub === 'search' ? rest.join(' ') : undefined;
  const kind = flags.values.get('kind');
  const entries = await api.brain(projectId, { ...(q ? { q } : {}), ...(kind ? { kind } : {}) });
  if (entries.length === 0) out(io, 'Nothing in the brain yet.');
  for (const e of entries) {
    out(
      io,
      `${chalk.bold(e.title)}  ${chalk.dim(`${e.kind} · ${e.source} · ${ago(e.createdAt)}`)}`,
    );
    if (e.body) out(io, `  ${e.body.split('\n').slice(0, 3).join('\n  ')}`);
  }
  return 0;
}
