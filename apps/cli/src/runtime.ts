import { homedir } from 'node:os';
import {
  Agent,
  FileStateTracker,
  HookRunner,
  McpApprovalStore,
  McpManager,
  PATCH_VERSION,
  PathPolicy,
  PermissionManager,
  SessionStore,
  ToolRegistry,
  buildSystemPrompt,
  countChanges,
  countHooks,
  createDefaultTools,
  createLogger,
  detectGitRepo,
  detectProject,
  detectShell,
  detectWorkspace,
  findGuidanceFiles,
  findRipgrep,
  getGitLog,
  getGitStatus,
  hostedToolsFor,
  loadConfig,
  loadCustomCommands,
  loadInstructions,
  loadProjectMcpServers,
  mergeMcpServers,
  type CustomCommandSet,
  type GitFileStatus,
  type GitStatus,
  type InstructionFile,
  type Logger,
  type McpNotice,
  type PermissionRules,
  type ResolvedConfig,
  type Session,
  type ShellInfo,
  type SystemPromptContext,
  type WorkspaceInfo,
} from '@patch/core';
import {
  AnthropicProvider,
  DEFAULT_ANTHROPIC_MODEL,
  hasAnthropicCredentials,
} from '@patch/provider-anthropic';
import type { ModelProvider } from '@patch/shared';
import type { CliArgs } from './args.js';
import { tildify } from './format.js';
import {
  directoryUpdateNote,
  modelDirectory,
  recordedDirectory,
  sameDirectory,
  samePath,
  type DirectoryContext,
} from './working-directory.js';

export interface RuntimeOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  args: CliArgs;
  homeDir?: string;
  /** Test hook: supply a model provider instead of Anthropic. */
  providerFactory?: (config: ResolvedConfig, logger: Logger) => ModelProvider;
  /** Test hook: pretend credentials exist (used with providerFactory). */
  assumeCredentials?: boolean;
}

/** Everything that belongs to one conversation. Replaced on /clear and /resume. */
export interface SessionHandle {
  session: Session;
  agent: Agent;
  permissions: PermissionManager;
  fileState: FileStateTracker;
  /** The tools' path policy (also used for images the user attaches). */
  paths: PathPolicy;
}

export type ResolveSessionResult = { ok: true; session: Session } | { ok: false; message: string };

export interface RuntimeNotice {
  level: 'info' | 'warn' | 'error';
  text: string;
  hint?: string;
}

function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function describeChange(file: GitFileStatus): string {
  const state =
    file.index === 'unmerged' || file.worktree === 'unmerged'
      ? 'conflict'
      : file.worktree === 'untracked'
        ? 'untracked'
        : file.worktree !== 'unmodified'
          ? file.worktree
          : file.index;
  const path = file.origPath ? `${file.origPath} -> ${file.path}` : file.path;
  return `${state}: ${path}`;
}

/** Git status of the workspace's repository; null outside Git or when git failed. */
async function readGitStatus(workspace: WorkspaceInfo, logger: Logger): Promise<GitStatus | null> {
  if (!workspace.git) return null;
  return getGitStatus(workspace.git.root).catch((error: unknown) => {
    logger.warn('git status failed', error);
    return null;
  });
}

/** Process-wide state: configuration, workspace, provider, storage, tools. */
export class Runtime {
  readonly config: ResolvedConfig;
  readonly logger: Logger;
  readonly shell: ShellInfo;
  readonly provider: ModelProvider;
  readonly store: SessionStore;
  readonly tools: ToolRegistry;
  readonly ripgrep: boolean;
  readonly hasCredentials: boolean;
  readonly permissionFlags: PermissionRules;
  /** The user's hooks from ~/.patch/config.json, shared by every session's agent. */
  readonly hooks: HookRunner;
  /**
   * MCP servers: the user's and the project's (.mcp.json, once approved). Started once, before
   * the first request (startMcp); their tools join `tools` for every session of this process.
   */
  readonly mcp: McpManager;
  private mcpStart: Promise<McpNotice[]> | undefined;
  private currentWorkspace: WorkspaceInfo;
  private currentGitStatus: GitStatus | null;
  private currentCustomCommands: CustomCommandSet;
  /**
   * Set once a session was opened with the current workspace snapshot: the next new session
   * (/clear) reads the workspace again first. The snapshot taken at startup serves the first
   * session as is.
   */
  private workspaceUsed = false;

  private constructor(init: {
    config: ResolvedConfig;
    logger: Logger;
    workspace: WorkspaceInfo;
    shell: ShellInfo;
    provider: ModelProvider;
    store: SessionStore;
    tools: ToolRegistry;
    ripgrep: boolean;
    hasCredentials: boolean;
    permissionFlags: PermissionRules;
    gitStatus: GitStatus | null;
    customCommands: CustomCommandSet;
    mcp: McpManager;
  }) {
    this.config = init.config;
    this.logger = init.logger;
    this.currentWorkspace = init.workspace;
    this.shell = init.shell;
    this.provider = init.provider;
    this.store = init.store;
    this.tools = init.tools;
    this.ripgrep = init.ripgrep;
    this.hasCredentials = init.hasCredentials;
    this.permissionFlags = init.permissionFlags;
    this.currentGitStatus = init.gitStatus;
    this.currentCustomCommands = init.customCommands;
    this.mcp = init.mcp;
    this.hooks = new HookRunner({
      hooks: init.config.hooks,
      shell: init.shell,
      projectRoot: init.workspace.projectRoot,
      cwd: init.workspace.cwd,
      logger: init.logger.child('hooks'),
    });
  }

  /**
   * The workspace as of the newest session: read at startup and again when /clear starts a new
   * session, so instruction files (PATCH.md...), guidance files, project details and Git state
   * edited meanwhile are picked up. The working directory and project root never change: sessions,
   * prompt history and path rules are keyed by them.
   */
  get workspace(): WorkspaceInfo {
    return this.currentWorkspace;
  }

  /** Git status taken with `workspace` (null outside Git or when git failed). */
  get gitStatus(): GitStatus | null {
    return this.currentGitStatus;
  }

  static async create(options: RuntimeOptions): Promise<Runtime> {
    const home = options.homeDir ?? homedir();
    const config = loadConfig({
      env: options.env,
      defaultModel: DEFAULT_ANTHROPIC_MODEL,
      flags: { model: options.args.model, debug: options.args.debug },
      homeDir: home,
    });
    if (options.args.maxSteps) config.maxStepsPerTurn = options.args.maxSteps;
    const logger = createLogger({ enabled: config.debug, dir: config.paths.logsDir });
    logger.info(`Patch ${PATCH_VERSION} starting`, {
      cwd: options.cwd,
      platform: process.platform,
      node: process.version,
      model: config.model,
      modelSource: config.modelSource,
    });
    for (const warning of config.warnings) logger.warn(warning);

    const [workspace, rg] = await Promise.all([
      detectWorkspace({
        cwd: options.cwd,
        home,
        userInstructionsPath: config.paths.userInstructions,
      }),
      findRipgrep().catch(() => null),
    ]);
    const shell = detectShell({ configured: config.shell, env: options.env });
    const [gitStatus, customCommands] = await Promise.all([
      readGitStatus(workspace, logger),
      loadCustomCommands({
        projectRoot: workspace.projectRoot,
        userDir: config.paths.commandsDir,
        home,
      }),
    ]);
    logger.debug('workspace', {
      projectRoot: workspace.projectRoot,
      isGit: workspace.isGit,
      branch: workspace.git?.branch,
      project: workspace.project.label,
      shell: shell.label,
      ripgrep: Boolean(rg),
      customCommands: customCommands.commands.length,
      hooks: countHooks(config.hooks),
    });

    const provider = options.providerFactory
      ? options.providerFactory(config, logger)
      : new AnthropicProvider({
          apiKey: config.anthropic.apiKey,
          authToken: config.anthropic.authToken,
          baseUrl: config.anthropic.baseUrl,
          workspaceId: config.anthropic.workspaceId,
          effort: config.effort,
          logger: logger.child('anthropic'),
        });

    const permissionFlags: PermissionRules = {
      allow: [
        ...(options.args.allowEdits ? ['edit'] : []),
        ...options.args.allowCommands.map((prefix) => `bash:${prefix}`),
      ],
      deny: [],
    };

    // Reading .mcp.json starts nothing: its servers wait for the user's approval.
    const project = loadProjectMcpServers(workspace.projectRoot, config.warnings);
    const mcp = new McpManager({
      servers: mergeMcpServers(config.mcpServers, project.servers, config.warnings),
      projectRoot: workspace.projectRoot,
      approvals: new McpApprovalStore(config.paths.mcpApprovals),
      logger: logger.child('mcp'),
    });

    return new Runtime({
      config,
      logger,
      workspace,
      shell,
      provider,
      store: new SessionStore(config.paths.sessionsDir),
      tools: new ToolRegistry(createDefaultTools()),
      ripgrep: Boolean(rg),
      hasCredentials: options.assumeCredentials ?? hasAnthropicCredentials(config.anthropic),
      permissionFlags,
      gitStatus,
      customCommands,
      mcp,
    });
  }

  /**
   * Starts the MCP servers that may start (see McpManager) and adds their tools to `tools`,
   * before any request uses the tool list. Answer the project approval first, if one is pending
   * (McpManager.pendingApprovals); servers still unapproved are skipped. Runs once; resolves to
   * the notices to show (failed servers, tools left out). Never throws.
   */
  startMcp(signal?: AbortSignal): Promise<McpNotice[]> {
    this.mcpStart ??= (async () => {
      const { tools, notices } = await this.mcp.start({
        signal,
        reservedNames: this.tools.names(),
      });
      try {
        this.tools.extend(tools);
      } catch (error) {
        // A request already used the tool list: it stays as it is for this process.
        this.logger.error('MCP tools could not be added', error);
        return [
          ...notices,
          { level: 'warn' as const, text: 'MCP tools are not available in this session.' },
        ];
      }
      return notices;
    })();
    return this.mcpStart;
  }

  /** Stops the MCP servers. Call before exiting. Never throws. */
  async close(): Promise<void> {
    await this.mcp.close();
  }

  /**
   * Custom slash commands (Markdown prompts in .patch/commands, .claude/commands and
   * ~/.patch/commands) as last read: at startup or by reloadCustomCommands.
   */
  get customCommands(): CustomCommandSet {
    return this.currentCustomCommands;
  }

  /** Reads the custom commands again (files added, edited or removed since). Never throws. */
  async reloadCustomCommands(): Promise<CustomCommandSet> {
    this.currentCustomCommands = await loadCustomCommands({
      projectRoot: this.workspace.projectRoot,
      userDir: this.config.paths.commandsDir,
      home: this.workspace.home,
    });
    return this.currentCustomCommands;
  }

  /** How credentials are configured, for messages ("ANTHROPIC_API_KEY or ~/.patch/config.json"). */
  get credentialHint(): string {
    return 'ANTHROPIC_API_KEY or the Patch configuration (~/.patch/config.json)';
  }

  /**
   * The web tools a session starting on `model` offers, as the system prompt describes them: the
   * user's web settings, as far as the model supports them.
   */
  webTools(model: string): { search: boolean; fetch: boolean } {
    const supported = this.provider.getModelInfo(model).hostedTools ?? [];
    return {
      search: this.config.web.search && supported.includes('web_search'),
      fetch: this.config.web.fetch && supported.includes('web_fetch'),
    };
  }

  /** The system prompt for a new session on `model`, from the current workspace snapshot. */
  private async buildSystemPrompt(model: string): Promise<string> {
    let gitSnapshot: SystemPromptContext['gitSnapshot'] = null;
    const git = this.workspace.git;
    if (git) {
      try {
        // Taken with the workspace snapshot; retried here when that attempt failed.
        const status = this.currentGitStatus ?? (await getGitStatus(git.root));
        this.currentGitStatus = status;
        const recentCommits = git.hasCommits ? await getGitLog(git.root, { limit: 5 }) : [];
        gitSnapshot = {
          counts: countChanges(status),
          changedPaths: status.files.filter((f) => f.worktree !== 'ignored').map(describeChange),
          recentCommits,
        };
      } catch (error) {
        this.logger.warn('git snapshot failed', error);
      }
    }
    return buildSystemPrompt({
      workspace: this.workspace,
      shell: this.shell,
      date: localDate(),
      gitSnapshot,
      ripgrep: this.ripgrep,
      web: this.webTools(model),
      mcp: this.mcp.configured,
    });
  }

  /**
   * Reads the workspace again (see `workspace`). The project root stays fixed, so Git state is
   * taken over only while the repository still has that root; on any failure the previous
   * snapshot is kept.
   */
  private async refreshWorkspace(): Promise<void> {
    const previous = this.currentWorkspace;
    const { cwd, projectRoot } = previous;
    try {
      const [git, project, instructions, guidance] = await Promise.all([
        detectGitRepo(cwd),
        detectProject(projectRoot),
        this.readInstructions(),
        findGuidanceFiles(projectRoot),
      ]);
      // detectWorkspace's rule: the repository root, else the working directory.
      const detectedRoot = git?.root ?? cwd;
      const sameRoot = samePath(detectedRoot, projectRoot);
      this.currentWorkspace = {
        ...previous,
        project,
        instructions,
        guidance,
        ...(sameRoot ? { git, isGit: git !== null } : {}),
      };
      if (!sameRoot) {
        this.logger.warn('project root changed on disk; keeping the one Patch started with', {
          projectRoot,
          detectedRoot,
        });
      }
    } catch (error) {
      this.logger.warn('could not read the workspace again', error);
    }
    this.currentGitStatus = await readGitStatus(this.currentWorkspace, this.logger);
  }

  private readInstructions(): Promise<InstructionFile[]> {
    const { cwd, projectRoot, home } = this.currentWorkspace;
    return loadInstructions({
      projectRoot,
      cwd,
      home,
      userInstructionsPath: this.config.paths.userInstructions,
    });
  }

  /**
   * True when the instruction files on disk differ from the ones in `workspace` (added, edited or
   * removed since they were read); a new session (/clear) would use them.
   */
  async instructionsChanged(): Promise<boolean> {
    const loaded = this.workspace.instructions;
    try {
      const onDisk = await this.readInstructions();
      return (
        onDisk.length !== loaded.length ||
        onDisk.some(
          (file, i) => file.path !== loaded[i]?.path || file.content !== loaded[i]?.content,
        )
      );
    } catch (error) {
      this.logger.debug('could not read the instruction files', error);
      return false;
    }
  }

  /**
   * Creates and persists a new session and its agent. Every session after the first reads the
   * workspace again first, so edits made meanwhile (a PATCH.md written by /init, a new branch)
   * reach its system prompt.
   */
  async newSession(model = this.config.model): Promise<SessionHandle> {
    if (this.workspaceUsed) await this.refreshWorkspace();
    const system = await this.buildSystemPrompt(model);
    const session = this.store.create({
      cwd: this.workspace.cwd,
      projectRoot: this.workspace.projectRoot,
      isGit: this.workspace.isGit,
      branch: this.workspace.git?.branch ?? null,
      provider: this.provider.id,
      model,
      patchVersion: PATCH_VERSION,
      system,
    });
    this.logger.info('session created', { id: session.id, model });
    return this.openSession(session);
  }

  /** Wraps a loaded session with a fresh agent, permission state and file tracker. */
  openSession(session: Session, modelOverride?: string): SessionHandle {
    this.workspaceUsed = true;
    const fileState = new FileStateTracker();
    const permissions = new PermissionManager({
      config: this.config.permissions,
      flags: this.permissionFlags,
    });
    const paths = new PathPolicy({
      cwd: this.workspace.cwd,
      projectRoot: this.workspace.projectRoot,
      home: this.workspace.home,
    });
    const agent = new Agent({
      provider: this.provider,
      session,
      tools: this.tools,
      // From the user's settings only; the provider leaves out what the model cannot use.
      hostedTools: hostedToolsFor(this.config.web),
      permissions,
      toolContext: {
        cwd: this.workspace.cwd,
        projectRoot: this.workspace.projectRoot,
        gitRoot: this.workspace.git?.root ?? null,
        home: this.workspace.home,
        paths,
        fileState,
        shell: this.shell,
        logger: this.logger.child('tools'),
      },
      logger: this.logger.child('agent'),
      maxStepsPerTurn: this.config.maxStepsPerTurn,
      autoCompact: this.config.autoCompact,
      hooks: this.hooks,
    });
    if (modelOverride && modelOverride !== agent.model) agent.setModel(modelOverride);
    return { session, agent, permissions, fileState, paths };
  }

  /** Loads a session by id or unique prefix with a user-presentable error. */
  resolveSession(idOrPrefix: string): ResolveSessionResult {
    const resolved = this.store.resolve(idOrPrefix);
    if ('error' in resolved) {
      if (resolved.error === 'ambiguous') {
        return {
          ok: false,
          message: `Session id "${idOrPrefix}" is ambiguous (${resolved.matches.length} matches). Use more characters.`,
        };
      }
      return { ok: false, message: `No session found for "${idOrPrefix}".` };
    }
    try {
      return { ok: true, session: this.store.load(resolved.id) };
    } catch (error) {
      return {
        ok: false,
        message: `Could not load session ${idOrPrefix}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** The model to use when resuming: an explicit --model/PATCH_MODEL wins over the session's. */
  resumeModelOverride(): string | undefined {
    return this.config.modelSource === 'flag' || this.config.modelSource === 'env'
      ? this.config.model
      : undefined;
  }

  /** Where this process runs (tools resolve relative paths and run commands here). */
  get directory(): DirectoryContext {
    return { cwd: this.workspace.cwd, projectRoot: this.workspace.projectRoot };
  }

  /**
   * The notes (`UserTurn.notes`) to send with the next prompt of `session`; call right before
   * each turn. A session resumed from another directory still names the old working directory in
   * its frozen system prompt, while tools use this process's. While the directory the model last
   * heard about differs, this returns a note naming the current one: the agent stores it in the
   * same message as the prompt, after repairing the history and after any automatic compaction,
   * so it reaches the model with the first prompt sent from here and is not repeated afterwards
   * (history stays append-only; the system prompt is never rebuilt). Sessions that are only
   * viewed stay untouched, and a compaction that summarizes the note away makes the next turn
   * send it again.
   */
  turnNotes(session: Session): string[] {
    const known = modelDirectory(session);
    const current = this.directory;
    if (sameDirectory(known, current)) return [];
    this.logger.info('working directory update sent', { from: known.cwd, to: current.cwd });
    return [directoryUpdateNote(current, known)];
  }

  /** Warning for a session recorded in a different directory than this process runs in. */
  directoryNotice(session: Session): RuntimeNotice | undefined {
    const recorded = recordedDirectory(session);
    if (sameDirectory(recorded, this.directory)) return undefined;
    const home = this.workspace.home;
    return {
      level: 'warn',
      text: `This session was recorded in ${tildify(recorded.cwd, home)}; Patch is running in ${tildify(this.workspace.cwd, home)}.`,
      hint: 'Patch tells the model about the new directory. Paths mentioned earlier in the conversation may be relative to the old one.',
    };
  }
}
