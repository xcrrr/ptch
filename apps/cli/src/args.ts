export type OutputFormat = 'text' | 'json' | 'stream-json';

export interface CliArgs {
  /** Positional words joined with spaces (initial prompt). */
  prompt?: string;
  /** Non-interactive mode (-p / --print). */
  print: boolean;
  continue: boolean;
  resume: boolean;
  /** Session id or prefix given to --resume. */
  resumeId?: string;
  model?: string;
  debug: boolean;
  allowEdits: boolean;
  allowCommands: string[];
  /** Start in plan mode (--plan). */
  plan: boolean;
  /** Start in auto mode (--auto). */
  auto: boolean;
  outputFormat: OutputFormat;
  maxSteps?: number;
  help: boolean;
  version: boolean;
  /** Hidden: ask for the local agent UI (needs PATCH_ENABLE_LOCAL=1; Patch runs in the cloud). */
  local: boolean;
}

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** A session id (hex) or a conversation id of Patch Cloud (cnv_...). */
const SESSION_ID_PATTERN = /^(?:[0-9a-f][0-9a-f-]{3,35}|cnv_[0-9a-z]{3,40})$/i;

function defaults(): CliArgs {
  return {
    print: false,
    continue: false,
    resume: false,
    debug: false,
    allowEdits: false,
    allowCommands: [],
    plan: false,
    auto: false,
    outputFormat: 'text',
    help: false,
    version: false,
    local: false,
  };
}

/**
 * Parses ptch's command line. Supports `--opt value`, `--opt=value`, `--` to end options, and an
 * optional session id after `--resume` (only consumed when it looks like an id).
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args = defaults();
  const positionals: string[] = [];
  let printValue: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] as string;
    if (raw === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!raw.startsWith('-') || raw === '-') {
      positionals.push(raw);
      continue;
    }

    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const name = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    const next = argv[i + 1];
    const takeValue = (label: string): string => {
      if (inline !== undefined) return inline;
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        throw new UsageError(`${label} needs a value.`);
      }
      i++;
      return next;
    };

    switch (name) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-v':
      case '--version':
        args.version = true;
        break;
      case '-p':
      case '--print':
        args.print = true;
        if (inline !== undefined) printValue = inline;
        else if (next !== undefined && !next.startsWith('-')) {
          printValue = next;
          i++;
        }
        break;
      case '-c':
      case '--continue':
        args.continue = true;
        break;
      case '-r':
      case '--resume':
        args.resume = true;
        if (inline !== undefined) args.resumeId = inline;
        else if (next !== undefined && SESSION_ID_PATTERN.test(next)) {
          args.resumeId = next;
          i++;
        }
        break;
      case '-m':
      case '--model':
        args.model = takeValue('--model');
        break;
      case '--debug':
        args.debug = true;
        break;
      case '--local':
        args.local = true;
        break;
      case '--allow-edits':
        args.allowEdits = true;
        break;
      case '--allow-command':
        args.allowCommands.push(takeValue('--allow-command'));
        break;
      case '--plan':
        args.plan = true;
        break;
      case '--auto':
        args.auto = true;
        break;
      case '--output-format': {
        const value = takeValue('--output-format');
        if (value !== 'text' && value !== 'json' && value !== 'stream-json') {
          throw new UsageError(
            `--output-format must be "text", "json" or "stream-json" (got "${value}").`,
          );
        }
        args.outputFormat = value;
        break;
      }
      case '--max-steps': {
        const value = Number(takeValue('--max-steps'));
        if (!Number.isInteger(value) || value < 1) {
          throw new UsageError('--max-steps must be a positive integer.');
        }
        args.maxSteps = value;
        break;
      }
      default:
        throw new UsageError(`Unknown option: ${name}. Run "ptch --help" for usage.`);
    }
  }

  const positional = positionals.join(' ').trim();
  const prompt = [printValue, positional]
    .filter((p) => p && p.trim())
    .join(' ')
    .trim();
  if (prompt) args.prompt = prompt;

  if (args.continue && args.resume) {
    throw new UsageError('Use either --continue or --resume, not both.');
  }
  if (args.plan && args.auto) {
    throw new UsageError(
      'Use either --plan or --auto, not both: plan mode changes nothing, auto mode acts without asking.',
    );
  }
  if (!args.print) {
    if (args.allowEdits || args.allowCommands.length > 0) {
      throw new UsageError(
        '--allow-edits and --allow-command apply to --print mode. Interactive sessions ask instead.',
      );
    }
    if (args.outputFormat !== 'text') {
      throw new UsageError('--output-format applies to --print mode.');
    }
  }
  if (args.print && args.resume && !args.resumeId) {
    throw new UsageError('--print with --resume needs a session id (ptch -p "..." --resume <id>).');
  }
  return args;
}

export const HELP_TEXT = `Patch — your coding agent, in the cloud

Usage
  ptch                          Open Patch Cloud: chat, runs and project memory (signs you in first)
  ptch "<message>"              Open Patch Cloud and send a first message
  ptch --resume [id]            Open an earlier conversation (or choose one)
  ptch --continue               Open the most recent conversation
  ptch cloud <command>          Scripted access to Patch Cloud (ptch cloud for help)
  ptch login | logout | whoami  Sign in to Patch Cloud in your browser (one account for web, CLI and phone)

In Patch Cloud, type / for commands: /new /resume /projects /runs /run /brain /push /whoami /help

Sandbox agent (what Patch Cloud runs inside its task containers; not for everyday use)
  ptch -p "<prompt>"            Run one task non-interactively and print the result
  ptch -p --plan "<prompt>"     Research and print a plan, without changing anything

Options
  -p, --print [prompt]          Non-interactive mode. Reads the prompt (or extra context) from stdin when piped
  -c, --continue                Open the most recent conversation
  -r, --resume [id]             Open a conversation by id; without an id, choose from a list
  -m, --model <id>              Print mode: model for this run (default: PATCH_MODEL, config, or claude-opus-5-5)
      --plan                    Print mode: research and present a plan, without changing anything
      --auto                    Print mode: no permission prompts, except for destructive
                                commands and secret files (denied in print mode)
      --allow-edits             Print mode: allow file edits inside the project
      --allow-command <prefix>  Print mode: allow commands starting with <prefix> (repeatable)
      --output-format <fmt>     Print mode: "text" (default), "json" (one result object) or
                                "stream-json" (one JSON record per line while it runs)
      --max-steps <n>           Print mode: limit model round-trips for one prompt (default 200)
      --debug                   Write detailed logs to ~/.patch/logs
  -v, --version                 Print the version
  -h, --help                    Show this help

Environment
  PATCH_SITE                    Website to sign in through (default https://ptch.vercel.app)
  PATCH_CLOUD_URL, PATCH_CLOUD_TOKEN   Use a Patch Cloud address and API token instead of a browser sign-in
  PATCH_NO_BROWSER=1            Do not open a browser to sign in; show the address instead
  PATCH_HOME                    Override the config directory (default ~/.patch)
  ANTHROPIC_API_KEY             Print mode only: API key for Anthropic
  ANTHROPIC_WORKSPACE_ID        Print mode only: workspace for an organization-wide key (wrkspc_...)
  PATCH_MODEL                   Print mode only: default model id
  PATCH_EFFORT                  Print mode only: reasoning effort: low, medium, high, xhigh, max
  PATCH_NO_WEB=1                Print mode only: turn off web search and web fetch
  PATCH_DEBUG=1                 Same as --debug

Docs: README.md in the Patch repository.`;
