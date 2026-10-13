import {
  HOOK_EVENTS,
  PROJECT_MCP_FILE,
  TOOL_HOOK_EVENTS,
  countChanges,
  describeError,
  describeStatus,
  getGitDiff,
  getGitStatus,
} from '@patch/core';
import {
  estimateCostUsd,
  formatTokens,
  formatUsd,
  oneLine,
  plural,
  shortId,
  type HostedToolKind,
} from '@patch/shared';
import { tildify } from '../format.js';
import { describePermissionMode } from '../ui/permission-mode.js';
import type { HelpSection, StatusRow } from '../ui/transcript.js';
import type { AppController } from './controller.js';

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  args?: string;
  /** Read-only commands may run while a turn is in progress. */
  availableWhileBusy?: boolean;
  run(app: AppController, args: string): void | Promise<void>;
}

const INIT_PROMPT = `Analyze this repository and write a PATCH.md file at the project root that will help you work in this codebase in future sessions.

Include, concisely and only what is true for this repository:
- What the project is, in one or two sentences.
- Exact commands to install dependencies, build, run tests (including a single test), lint, typecheck, and run the app.
- Code style and conventions that are not obvious from configuration files.
- Architecture: key directories and how the main pieces fit together.
- Gotchas: anything surprising a new contributor would get wrong.

Keep it under 80 lines. No generic advice and no filler. Read the existing README, configuration files, and representative source files first. If PATCH.md already exists, improve it while keeping its useful content.`;

/** Names and aliases of the built-in commands, which custom commands can never replace. */
export function builtInCommandNames(commands: readonly SlashCommand[]): Set<string> {
  return new Set(commands.flatMap((command) => [command.name, ...(command.aliases ?? [])]));
}

/** Longest key of a help row naming a directory; a longer one goes into the description. */
const MAX_HELP_PATH_KEY = 24;

function helpSections(app: AppController): HelpSection[] {
  const { config, workspace } = app.runtime;
  const custom = app.customCommandInfos();
  // ~/.patch/commands/, or wherever PATCH_HOME puts it.
  const userDir = `${tildify(config.paths.commandsDir, workspace.home)}/`;
  return [
    {
      title: 'Commands',
      rows: app.commands.map((c) => ({
        key: `/${c.name}${c.args ? ` ${c.args}` : ''}`,
        description: c.description,
      })),
    },
    {
      title: 'Custom commands',
      rows: [
        ...custom.map((c) => ({
          key: `/${c.name}${c.args ? ` ${c.args}` : ''}`,
          description: c.tag ? `${c.description} (${c.tag})` : c.description,
        })),
        {
          key: '.patch/commands/',
          description: 'Project commands: <name>.md holds the prompt that /<name> sends',
        },
        userDir.length <= MAX_HELP_PATH_KEY
          ? { key: userDir, description: 'Your own commands, for every project' }
          : { key: 'your commands', description: `${userDir} (for every project)` },
      ],
    },
    {
      title: 'Input',
      rows: [
        { key: 'enter', description: 'Send' },
        { key: '\\ enter  alt+enter', description: 'New line' },
        { key: '↑ ↓', description: 'Previous prompts' },
        { key: 'tab', description: 'Complete a command' },
        {
          key: 'shift+tab',
          description: 'Switch mode: default, accept edits, plan (research first), auto',
        },
        { key: 'alt+v  ctrl+v', description: 'Paste an image from the clipboard' },
        { key: '@<image path>', description: 'Attach an image file (or drop the file here)' },
        {
          key: '!<command>',
          description: 'Run a shell command yourself (output is shared with Patch)',
        },
        { key: '/<command>', description: 'Run a Patch command' },
      ],
    },
    {
      title: 'While Patch works',
      rows: [
        { key: 'esc', description: 'Interrupt the current turn' },
        { key: 'enter', description: 'Queue a message for when the turn finishes' },
        {
          key: 'ctrl+o',
          description:
            'Show the full output of the last tool call (at an approval: the full request)',
        },
      ],
    },
    {
      title: 'Session',
      rows: [
        { key: 'ctrl+c', description: 'Interrupt; on an empty prompt press twice to exit' },
        { key: 'ctrl+d', description: 'Exit on an empty prompt' },
        { key: 'ctrl+l', description: 'Clear the screen' },
      ],
    },
  ];
}

async function statusRows(app: AppController): Promise<StatusRow[]> {
  const { runtime } = app;
  const { workspace, config } = runtime;
  const handle = app.sessionHandle;
  const rows: StatusRow[] = [];

  rows.push({
    label: 'Repository',
    value: tildify(workspace.projectRoot, workspace.home),
    ...(workspace.isGit ? {} : { detail: 'directory mode (no Git)' }),
  });
  if (workspace.git) {
    try {
      const status = await getGitStatus(workspace.git.root);
      const tracking =
        status.upstream && (status.ahead || status.behind)
          ? `${status.upstream} · ${status.ahead} ahead, ${status.behind} behind`
          : (status.upstream ?? undefined);
      rows.push({
        label: 'Branch',
        value: status.branch ?? (status.head ? `detached @${status.head.slice(0, 7)}` : 'detached'),
        ...(tracking ? { detail: tracking } : {}),
      });
      const counts = countChanges(status);
      rows.push({
        label: 'Changes',
        value:
          counts.total === 0 ? 'clean' : `${counts.total} ${counts.total === 1 ? 'file' : 'files'}`,
        ...(counts.total > 0 ? { detail: describeStatus(status) } : {}),
      });
    } catch (error) {
      rows.push({ label: 'Branch', value: 'unavailable', detail: describeError(error).title });
    }
  }

  const model = handle.agent.model;
  const info = runtime.provider.getModelInfo(model);
  rows.push({
    label: 'Model',
    value: model,
    detail: [runtime.provider.displayName, config.effort ? `effort ${config.effort}` : undefined]
      .filter(Boolean)
      .join(' · '),
  });
  rows.push({
    label: 'Session',
    value: shortId(handle.session.id),
    detail: oneLine(handle.session.title(), 60),
  });
  rows.push({
    label: 'Mode',
    value: describePermissionMode(handle.permissions.mode),
    detail: 'shift+tab to change',
  });
  const context = handle.agent.contextUsage();
  rows.push({
    label: 'Context',
    value:
      context.tokens > 0
        ? `${formatTokens(context.tokens)} / ${formatTokens(context.window)}`
        : 'empty',
    ...(context.tokens > 0 && context.window > 0
      ? { detail: `${Math.round((context.tokens / context.window) * 100)}% used` }
      : {}),
  });
  const usage = handle.session.usageTotals();
  if (usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0) {
    const cost = estimateCostUsd(usage, info.pricing);
    const searches = usage.webSearches
      ? ` · ${plural(usage.webSearches, 'web search', 'web searches')}`
      : '';
    rows.push({
      label: 'Usage',
      value: `${formatTokens(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)} in · ${formatTokens(usage.outputTokens)} out${searches}`,
      ...(cost !== undefined ? { detail: `≈ ${formatUsd(cost)} this session` } : {}),
    });
  }
  // Instruction files are read when a session starts; edits (a PATCH.md from /init) wait for /clear.
  const instructionsChanged = await runtime.instructionsChanged();
  rows.push({
    label: 'Instructions',
    value:
      workspace.instructions.length > 0
        ? workspace.instructions.map((f) => f.display).join(', ')
        : 'none',
    ...(instructionsChanged
      ? { detail: 'changed on disk; /clear starts a conversation that uses them' }
      : workspace.instructions.length === 0
        ? { detail: 'add a PATCH.md at the project root (or run /init)' }
        : {}),
  });
  rows.push({ label: 'Shell', value: runtime.shell.label });
  rows.push({
    label: 'Search',
    value: runtime.ripgrep ? 'ripgrep' : 'built-in (ripgrep not found)',
  });
  rows.push(webStatusRow(app));
  const mcp = runtime.mcp.summary();
  rows.push({ label: 'MCP', value: mcp.value, ...(mcp.detail ? { detail: mcp.detail } : {}) });
  rows.push({ label: 'Config', value: tildify(config.paths.configFile, workspace.home) });
  if (config.debug && runtime.logger.filePath) {
    rows.push({ label: 'Debug log', value: tildify(runtime.logger.filePath, workspace.home) });
  }
  return rows;
}

/** One row per configured hook: event, command, and its matcher and timeout. */
function hookRows(app: AppController): StatusRow[] {
  const { config, workspace } = app.runtime;
  const configFile = tildify(config.paths.configFile, workspace.home);
  const rows: StatusRow[] = [];
  for (const event of HOOK_EVENTS) {
    for (const hook of config.hooks[event]) {
      const tools = TOOL_HOOK_EVENTS.includes(event)
        ? hook.matcher
          ? `matcher ${hook.matcher}`
          : 'all tools'
        : undefined;
      rows.push({
        label: event,
        value: oneLine(hook.command, 100),
        detail: [tools, `timeout ${hook.timeoutMs / 1000}s`].filter(Boolean).join(' · '),
      });
    }
  }
  if (rows.length === 0) {
    return [{ label: 'none', value: `Add hooks under "hooks" in ${configFile}` }];
  }
  rows.push({
    label: 'config',
    value: configFile,
    detail: 'hooks run in the project root; only your user configuration can define them',
  });
  return rows;
}

/** Characters of a server's command line or URL in /mcp (the middle is cut). */
const MCP_TARGET_CHARS = 60;

/** `text` cut to `max` characters in the middle: a command line keeps its program and script. */
function cutMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`;
}

/**
 * One row per MCP server: its state (with the reason when it failed or was skipped), transport and
 * tool count, then a dim row listing its tools.
 */
function mcpRows(app: AppController): StatusRow[] {
  const { mcp, config, workspace } = app.runtime;
  const configFile = tildify(config.paths.configFile, workspace.home);
  const statuses = mcp.status();
  if (statuses.length === 0) {
    return [
      {
        label: 'none',
        value: `Add servers under "mcpServers" in ${configFile}, or in .mcp.json in the project`,
      },
    ];
  }
  const rows: StatusRow[] = [];
  for (const status of statuses) {
    const state =
      status.state === 'pending' || status.state === 'connecting' ? 'starting' : status.state;
    const parts = [state, status.transport];
    if (status.origin === 'project') parts.push(PROJECT_MCP_FILE);
    if (status.state === 'connected') parts.push(plural(status.tools.length, 'tool'));
    rows.push({
      label: status.name,
      value: parts.join(' · '),
      detail: status.reason ?? cutMiddle(oneLine(status.target, 1_000), MCP_TARGET_CHARS),
    });
    if (status.tools.length > 0) {
      rows.push({ label: '', value: '', detail: status.tools.join(', ') });
    }
  }
  rows.push({
    label: 'config',
    value: configFile,
    detail: `${PROJECT_MCP_FILE} servers start once approved`,
  });
  return rows;
}

const WEB_TOOL_NAMES: Record<HostedToolKind, string> = { web_search: 'search', web_fetch: 'fetch' };

/** Web search and fetch in this session: what is on, or why nothing is, and domain limits. */
function webStatusRow(app: AppController): StatusRow {
  const { config, provider, workspace } = app.runtime;
  const { agent } = app.sessionHandle;
  const offered = agent.hostedTools.map((tool) => tool.kind);
  const supported = provider.getModelInfo(agent.model).hostedTools ?? [];
  const on = offered.filter((kind) => supported.includes(kind));
  if (on.length === 0) {
    const detail = config.web.disabledByEnv
      ? 'PATCH_NO_WEB is set'
      : offered.length > 0
        ? `not available with ${agent.model}`
        : `turned off in ${tildify(config.paths.configFile, workspace.home)}`;
    return { label: 'Web', value: 'off', detail };
  }
  const { allowedDomains, blockedDomains } = config.web;
  const domains =
    allowedDomains.length > 0
      ? `only ${allowedDomains.join(', ')}`
      : blockedDomains.length > 0
        ? `except ${blockedDomains.join(', ')}`
        : undefined;
  return {
    label: 'Web',
    value: on.map((kind) => WEB_TOOL_NAMES[kind]).join(', '),
    ...(domains ? { detail: domains } : {}),
  };
}

export function createCommands(): SlashCommand[] {
  return [
    {
      name: 'help',
      aliases: ['?'],
      description: 'Show commands and keyboard shortcuts',
      availableWhileBusy: true,
      run(app) {
        app.commit({ kind: 'help', sections: helpSections(app) });
      },
    },
    {
      name: 'status',
      description: 'Repository, branch, model, session and context usage',
      availableWhileBusy: true,
      async run(app) {
        app.commit({ kind: 'status', title: 'Status', rows: await statusRows(app) });
      },
    },
    {
      name: 'model',
      args: '[model-id]',
      description: 'Show or change the model for this session',
      run(app, args) {
        if (args) {
          app.setModel(args.trim());
          return;
        }
        app.openModelPicker(app.runtime.provider.listModels());
      },
    },
    {
      name: 'permissions',
      args: '[reset]',
      description: 'Show permission rules; "reset" clears approvals given this session',
      availableWhileBusy: true,
      run(app, args) {
        const permissions = app.sessionHandle.permissions;
        if (args.trim() === 'reset') {
          permissions.resetSession();
          app.notice('info', 'Cleared the approvals given in this session.');
          return;
        }
        if (args.trim()) {
          app.notice(
            'warn',
            `Unknown argument: ${args.trim()}`,
            'Use /permissions or /permissions reset.',
          );
          return;
        }
        const rows = permissions.listRules().map((rule) => ({
          label: rule.effect,
          value: rule.description,
          detail: rule.source === 'default' ? undefined : rule.source,
        }));
        app.commit({
          kind: 'status',
          title: 'Permissions',
          rows: [
            ...rows,
            {
              label: 'rules',
              value: 'Add persistent rules under "permissions" in ~/.patch/config.json',
              detail: '/permissions reset clears session approvals',
            },
          ],
        });
      },
    },
    {
      name: 'plan',
      description: 'Turn plan mode on or off: research and present a plan before any change',
      availableWhileBusy: true,
      run(app, args) {
        if (args.trim()) {
          app.notice(
            'warn',
            `Unknown argument: ${args.trim()}`,
            'Use /plan to turn plan mode on or off.',
          );
          return;
        }
        const on = app.sessionHandle.permissions.mode !== 'plan';
        app.setPermissionMode(on ? 'plan' : 'default');
        app.notice(
          'info',
          on
            ? 'Plan mode is on: Patch researches and presents a plan before changing anything.'
            : 'Plan mode is off.',
          on
            ? 'Approve the plan when it is ready, or turn plan mode off with /plan or shift+tab.'
            : undefined,
        );
      },
    },
    {
      name: 'auto',
      description: 'Turn auto mode on or off: no prompts except destructive commands, secrets',
      availableWhileBusy: true,
      run(app, args) {
        if (args.trim()) {
          app.notice(
            'warn',
            `Unknown argument: ${args.trim()}`,
            'Use /auto to turn auto mode on or off.',
          );
          return;
        }
        if (app.sessionHandle.permissions.mode === 'auto') {
          app.setPermissionMode('default');
          app.notice('info', 'Auto mode is off: Patch asks before acting again.');
          return;
        }
        app.enterAutoMode(true);
      },
    },
    {
      name: 'hooks',
      description: 'Show the hooks configured in ~/.patch/config.json',
      availableWhileBusy: true,
      run(app) {
        app.commit({ kind: 'status', title: 'Hooks', rows: hookRows(app) });
      },
    },
    {
      name: 'mcp',
      description: 'Show MCP servers, their status and tools',
      availableWhileBusy: true,
      run(app) {
        app.commit({ kind: 'status', title: 'MCP servers', rows: mcpRows(app) });
      },
    },
    {
      name: 'diff',
      description: 'Show uncommitted changes',
      availableWhileBusy: true,
      async run(app) {
        const git = app.runtime.workspace.git;
        if (!git) {
          app.notice('info', 'No Git repository detected.', 'Patch is working in directory mode.');
          return;
        }
        try {
          const [diff, status] = await Promise.all([
            getGitDiff(git.root, { scope: 'all' }),
            getGitStatus(git.root),
          ]);
          const untracked = status.files
            .filter((f) => f.worktree === 'untracked')
            .map((f) => f.path);
          if (!diff.trim() && untracked.length === 0) {
            app.notice('info', 'No uncommitted changes.');
            return;
          }
          const counts = countChanges(status);
          app.commit({
            kind: 'git-diff',
            title: `${counts.total} changed ${counts.total === 1 ? 'file' : 'files'} · ${describeStatus(status)}`,
            diff,
            untracked,
          });
        } catch (error) {
          const friendly = describeError(error);
          app.notice('error', `Could not read the diff: ${friendly.title}`);
        }
      },
    },
    {
      name: 'clear',
      aliases: ['new'],
      description: 'Start a new conversation (the current one stays resumable)',
      async run(app) {
        const previous = app.session;
        const handle = await app.runtime.newSession(app.sessionHandle.agent.model);
        // The mode carries over to the new conversation (resumed sessions start in the default).
        handle.permissions.setMode(app.sessionHandle.permissions.mode);
        app.switchSession(handle, false);
        if (previous.hasMessages()) {
          app.notice(
            'info',
            `New conversation. The previous one (${shortId(previous.id)}) can be reopened with /resume.`,
          );
        }
        // Like the instruction files, custom commands are read again for the new conversation.
        await app.reloadCustomCommands();
      },
    },
    {
      name: 'compact',
      args: '[instructions]',
      description: 'Summarize the conversation to free up context',
      async run(app, args) {
        const instructions = args.trim() || undefined;
        try {
          const result = await app.runBusy('Compacting conversation', (signal) =>
            app.sessionHandle.agent.compact({ signal, instructions }),
          );
          if (result) {
            app.commit({
              kind: 'compaction',
              summary: result.summary,
              auto: false,
              messagesCompacted: result.messagesCompacted,
            });
          }
        } catch (error) {
          if (error instanceof Error && error.message === 'Nothing to compact yet.') {
            app.notice('info', 'Nothing to compact yet.');
            return;
          }
          const friendly = describeError(error, {
            credentialHint: app.runtime.credentialHint,
            model: app.sessionHandle.agent.model,
          });
          app.notice(
            friendly.title === 'Interrupted.' ? 'info' : 'error',
            friendly.title,
            friendly.hint,
          );
        }
      },
    },
    {
      name: 'resume',
      args: '[session-id]',
      description: 'Switch to a previous session in this project',
      run(app, args) {
        const id = args.trim();
        if (id) {
          app.selectSession(id);
          return;
        }
        const sessions = app.runtime.store
          .list({ projectRoot: app.runtime.workspace.projectRoot, limit: 30 })
          .filter((s) => s.id !== app.session.id);
        if (sessions.length === 0) {
          app.notice('info', 'No other sessions for this project yet.');
          return;
        }
        app.openSessionPicker(sessions);
      },
    },
    {
      name: 'init',
      description: 'Create or improve PATCH.md project instructions',
      run(app) {
        app.startTurn(INIT_PROMPT, '/init');
      },
    },
    {
      name: 'exit',
      aliases: ['quit', 'q'],
      description: 'Exit Patch',
      availableWhileBusy: true,
      run(app) {
        app.requestExit();
      },
    },
  ];
}
