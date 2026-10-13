import { chalkStderr } from 'chalk';
import {
  PATCH_VERSION,
  describeError,
  expandCustomCommand,
  type AgentEvent,
  type CustomCommand,
  type PermissionRequest,
  type PermissionResponse,
  type PlanReviewRequest,
  type PlanReviewResponse,
  type SessionStartSource,
  type TurnResult,
} from '@patch/core';
import { estimateCostUsd, shortId, type ImageBlock } from '@patch/shared';
import { builtInCommandNames, createCommands } from './app/commands.js';
import { parseSlashInput, partitionCustomCommands, shadowedNotice } from './app/custom-commands.js';
import type { OutputFormat } from './args.js';
import { apiKeyInstruction } from './credentials.js';
import { toolLine } from './format.js';
import { StreamJsonEmitter, resultRecord } from './stream-json.js';
import { attachImageFile, imageMentions } from './images.js';
import type { Runtime, SessionHandle } from './runtime.js';

export interface PrintOptions {
  prompt: string;
  /**
   * The text whose `@path` image mentions are attached: the prompt the user typed, never piped
   * input added to it (default: `prompt`).
   */
  mentionsFrom?: string;
  outputFormat: OutputFormat;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream & { isTTY?: boolean };
  signal: AbortSignal;
  /** How the session started, for SessionStart hooks (run before the prompt is sent). */
  sessionStart?: SessionStartSource;
}

export interface PrintPrompt {
  /** The prompt to send: a custom command's expanded prompt, or the text as given. */
  prompt: string;
  /** The custom command the text named. */
  command?: CustomCommand;
  /** Problems with the custom command files, worth showing when a command was asked for. */
  warnings: string[];
}

/**
 * A prompt naming a custom command ("/review src/auth") becomes that command's prompt, as in an
 * interactive session (where built-in commands win over custom ones of the same name). Any other
 * text is returned as is.
 */
export function expandPrintPrompt(runtime: Runtime, text: string): PrintPrompt {
  const slash = parseSlashInput(text);
  if (!slash) return { prompt: text, warnings: [] };
  const set = runtime.customCommands;
  const { usable, shadowed } = partitionCustomCommands(set, builtInCommandNames(createCommands()));
  const hidden = shadowed.find((candidate) => candidate.name === slash.name);
  const warnings = [...set.warnings, ...(hidden ? [shadowedNotice(hidden).text] : [])];
  const command = usable.find((candidate) => candidate.name === slash.name);
  if (!command) return { prompt: text, warnings };
  return { prompt: expandCustomCommand(command, slash.args), command, warnings };
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_INTERRUPTED = 130;

function exitCodeFor(result: TurnResult): number {
  switch (result.status) {
    case 'completed':
      return EXIT_OK;
    case 'interrupted':
      return EXIT_INTERRUPTED;
    default:
      return EXIT_FAILURE;
  }
}

/** Builds the guidance returned to the model when an action needs approval in print mode. */
function permissionHint(request: PermissionRequest): string {
  if (request.subject.kind === 'write') return 're-run with --allow-edits';
  if (request.subject.kind === 'execute') {
    const prefix = request.subject.analysis.rulePrefix;
    return prefix ? `re-run with --allow-command "${prefix}"` : 'run it interactively';
  }
  if (request.subject.kind === 'mcp') {
    const { server, tool } = request.subject;
    return `add "mcp:${server}__${tool}" (or "mcp:${server}") to "permissions.allow" in ~/.patch/config.json`;
  }
  return 'run it interactively';
}

/**
 * Runs one agent turn without the interactive UI. Assistant text streams to stdout (text format)
 * or is returned as one JSON object (json format); tool activity and notices go to stderr.
 * Returns the process exit code.
 */
export async function runPrint(
  runtime: Runtime,
  handle: SessionHandle,
  options: PrintOptions,
): Promise<number> {
  const { stdout, stderr, outputFormat } = options;
  const color = chalkStderr;
  const json = outputFormat === 'json';
  const stream = outputFormat === 'stream-json';
  /** json and stream-json keep stdout for machine-readable output only. */
  const quiet = json || stream;
  const emitter = stream
    ? new StreamJsonEmitter(
        (record) => void stdout.write(JSON.stringify(record) + '\n'),
        () => runtime.provider.getModelInfo(handle.agent.model).pricing,
      )
    : undefined;
  const startedAt = Date.now();

  if (!runtime.hasCredentials) {
    const instruction = apiKeyInstruction();
    stderr.write(
      `${instruction.title}\n\n  ${instruction.command}\n\n${color.dim(instruction.note)}\n`,
    );
    return EXIT_USAGE;
  }

  let wroteText = false;
  let endsWithNewline = true;
  const skipped: string[] = [];
  /** The plan that ended the run (plan mode), the result in json format. */
  let deliveredPlan: string | undefined;

  /** A presented plan is part of the answer: stdout, after a blank line. */
  const printPlan = (plan: string): void => {
    if (quiet) return;
    if (wroteText && !endsWithNewline) stdout.write('\n');
    stdout.write(`${wroteText ? '\n' : ''}${plan.trimEnd()}\n`);
    wroteText = true;
    endsWithNewline = true;
  };

  const onEvent = (event: AgentEvent): void => {
    if (emitter) {
      emitter.event(event);
      return;
    }
    switch (event.type) {
      case 'text_delta':
        if (!quiet) {
          stdout.write(event.text);
          wroteText = true;
          endsWithNewline = event.text.endsWith('\n');
        }
        break;
      case 'text_end':
        if (!quiet && wroteText && !endsWithNewline) {
          stdout.write('\n');
          endsWithNewline = true;
        }
        break;
      case 'tool_end': {
        const line = `  ${toolLine(event.summary, event.result.display)}`;
        const status = event.denied ? ' (declined)' : '';
        stderr.write(
          `${event.result.isError ? color.red(line + status) : color.dim(line + status)}\n`,
        );
        if (event.result.display?.plan) printPlan(event.result.display.plan);
        break;
      }
      case 'hosted_tool_end': {
        const line = `  ${toolLine(event.summary, event.display)}`;
        stderr.write(`${event.isError ? color.red(line) : color.dim(line)}\n`);
        break;
      }
      case 'notice':
        stderr.write(
          `${event.level === 'error' ? color.red(event.text) : event.level === 'warn' ? color.yellow(event.text) : color.dim(event.text)}\n`,
        );
        if (event.hint) stderr.write(`${color.dim(`  ${event.hint}`)}\n`);
        break;
      case 'compaction':
        stderr.write(`${color.dim('Context compacted.')}\n`);
        break;
      default:
        break;
    }
  };

  const requestPermission = async (request: PermissionRequest): Promise<PermissionResponse> => {
    // What asks in auto mode are its guardrails, which no flag lifts.
    const auto = handle.permissions.mode === 'auto';
    const hint = auto ? 'run it interactively' : permissionHint(request);
    skipped.push(`${request.prompt.subjectLine} (${hint})`);
    const { title, subjectLine } = request.prompt;
    const denial = auto
      ? `Denied in auto mode: ${title} — ${subjectLine}. Auto mode still asks before destructive commands and secret files, and print mode cannot ask; ${hint} to allow it.`
      : `Needs approval: ${title} — ${subjectLine}. Skipped; ${hint} to allow it.`;
    if (emitter) emitter.permissionDenied(denial);
    else stderr.write(`${color.yellow(denial)}\n`);
    return {
      decision: 'deny',
      feedback: auto
        ? "This action needs the user's approval even in auto mode (a destructive command, or one that may touch secrets), and nobody can approve it in this non-interactive run, so it was not run. Continue without it if you can, and finish by stating exactly what still needs to be done or approved."
        : 'Patch is running non-interactively, so this action could not be approved. Continue without it if you can, and finish by stating exactly what still needs to be done or approved.',
    };
  };

  emitter?.init({
    sessionId: handle.session.id,
    model: handle.agent.model,
    mode: handle.permissions.mode,
    version: PATCH_VERSION,
  });

  if (options.sessionStart) {
    await handle.agent.runSessionStartHooks(options.sessionStart, {
      signal: options.signal,
      onEvent,
    });
    if (options.signal.aborted) {
      stderr.write(`${color.dim('Interrupted.')}\n`);
      return EXIT_INTERRUPTED;
    }
  }

  // `@path` mentions of images. Reads that need approval are skipped like tool calls.
  const images: ImageBlock[] = [];
  for (const mention of imageMentions(options.mentionsFrom ?? options.prompt)) {
    const attached = await attachImageFile(mention, {
      paths: handle.paths,
      permissions: handle.permissions,
      requestPermission,
    }).catch((error: unknown) => {
      runtime.logger.warn('could not attach a mentioned image', error);
      return {
        ok: false as const,
        reason: 'invalid' as const,
        message: describeError(error).title,
      };
    });
    if (attached.ok) {
      images.push(attached.attachment.image);
      stderr.write(`${color.dim(`  attached ${attached.attachment.description}`)}\n`);
    } else {
      const line = `@${mention} was not attached. ${attached.message}`;
      stderr.write(`${attached.reason === 'missing' ? color.dim(line) : color.yellow(line)}\n`);
    }
  }

  let notes: string[] = [];
  try {
    notes = runtime.turnNotes(handle.session);
  } catch (error) {
    runtime.logger.warn('could not prepare the working directory update', error);
  }
  // In plan mode (--plan) nobody is here to approve the plan: it is printed and the run ends.
  const reviewPlan = async (request: PlanReviewRequest): Promise<PlanReviewResponse> => {
    deliveredPlan = request.plan;
    return { decision: 'end_turn' };
  };
  const result = await handle.agent.runTurn(
    { text: options.prompt, notes, ...(images.length > 0 ? { images } : {}) },
    { signal: options.signal, onEvent, requestPermission, reviewPlan },
  );

  if (!quiet && wroteText && !endsWithNewline) stdout.write('\n');

  if (emitter) {
    emitter.flushText();
    const info = runtime.provider.getModelInfo(handle.agent.model);
    stdout.write(
      JSON.stringify(
        resultRecord({
          result,
          text: deliveredPlan ?? result.finalText,
          sessionId: handle.session.id,
          model: handle.agent.model,
          durationMs: Date.now() - startedAt,
          costUsd: estimateCostUsd(result.usage, info.pricing),
          permissionDenials: skipped,
        }),
      ) + '\n',
    );
  } else if (json) {
    const info = runtime.provider.getModelInfo(handle.agent.model);
    const cost = estimateCostUsd(result.usage, info.pricing);
    const payload = {
      type: 'result',
      status: result.status,
      is_error: result.status !== 'completed',
      result: deliveredPlan ?? result.finalText,
      session_id: handle.session.id,
      model: handle.agent.model,
      steps: result.steps,
      tool_calls: result.toolCalls,
      duration_ms: Date.now() - startedAt,
      usage: {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        cache_read_tokens: result.usage.cacheReadTokens,
        cache_write_tokens: result.usage.cacheWriteTokens,
        ...(result.usage.webSearches ? { web_searches: result.usage.webSearches } : {}),
      },
      ...(cost !== undefined ? { estimated_cost_usd: Number(cost.toFixed(6)) } : {}),
      ...(skipped.length > 0 ? { permission_denials: skipped } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
    stdout.write(`${JSON.stringify(payload)}\n`);
  } else if (result.status === 'error' && result.error) {
    // The agent already emitted the notice; nothing more to print.
  } else if (result.status === 'interrupted') {
    stderr.write(`${color.dim('Interrupted.')}\n`);
  }

  if (!quiet && runtime.config.debug) {
    stderr.write(
      color.dim(
        `session ${shortId(handle.session.id)} · ${result.steps} steps · log ${runtime.logger.filePath ?? ''}\n`,
      ),
    );
  }
  return exitCodeFor(result);
}

/** Reads all of stdin when it is piped (not a TTY). Returns undefined for a TTY. */
export async function readPipedStdin(stdin: NodeJS.ReadStream): Promise<string | undefined> {
  if (stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.trim() ? text : undefined;
}

/** Combines an explicit prompt with piped input. */
export function combinePrompt(
  prompt: string | undefined,
  piped: string | undefined,
): string | undefined {
  if (prompt && piped) return `${prompt}\n\n<stdin>\n${piped.trimEnd()}\n</stdin>`;
  return prompt ?? piped;
}

export function describeFatal(error: unknown): string {
  const friendly = describeError(error);
  return friendly.hint ? `${friendly.title}\n${friendly.hint}` : friendly.title;
}
