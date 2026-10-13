import { isAbortError, isProviderError, type ProviderError } from '@patch/shared';
import type { FriendlyError } from './agent/events.js';

const PROVIDER_LABELS: Record<string, string> = { anthropic: 'Anthropic' };

function providerLabel(error: ProviderError): string {
  return PROVIDER_LABELS[error.provider] ?? error.provider;
}

/**
 * Converts any error into a precise, user-presentable message. Never exposes stack traces or raw
 * SDK payloads. `context.credentialHint` names where credentials come from (e.g.
 * "ANTHROPIC_API_KEY or ~/.patch/config.json").
 */
export function describeError(
  error: unknown,
  context: { credentialHint?: string; model?: string } = {},
): FriendlyError {
  if (isAbortError(error)) return { title: 'Interrupted.' };
  if (isProviderError(error)) {
    const name = providerLabel(error);
    const detail = error.message ? ` ${error.message.replace(/\.$/, '')}.` : '';
    switch (error.kind) {
      case 'auth':
        return {
          title: `${name} request failed: authentication error.`,
          hint: `Check ${context.credentialHint ?? 'your API key'}.`,
        };
      case 'permission':
        return {
          title: `${name} request failed: this API key is not allowed to use ${context.model ?? 'this model'}.`,
          hint: 'Check the key’s workspace and model access in the provider console, or pick another model with /model.',
        };
      case 'not_found':
        return {
          title: `${name} request failed: model ${context.model ? `"${context.model}" ` : ''}was not found.`,
          hint: 'Choose a model with /model or set PATCH_MODEL.',
        };
      case 'rate_limit':
        return {
          title: `${name} rate limit reached.`,
          hint: 'Wait a moment and try again. Patch already retried automatically.',
        };
      case 'overloaded':
        return {
          title: `${name} is temporarily overloaded.`,
          hint: 'Try again in a moment. Patch already retried automatically.',
        };
      case 'context_length':
        return {
          title: 'The conversation no longer fits in the model’s context window.',
          hint: 'Run /compact to summarize earlier context, or /clear to start fresh.',
        };
      case 'network':
        return {
          title: `Could not reach ${name}.${detail}`,
          hint: 'Check your network connection (and proxy settings, if any).',
        };
      case 'timeout':
        return {
          title: `${name} request timed out.`,
          hint: 'Try again; long requests may take a while.',
        };
      case 'server':
        return {
          title: `${name} returned a server error${error.status ? ` (${error.status})` : ''}.`,
          hint: 'This is usually temporary. Try again.',
        };
      case 'workspace':
        return /valid workspace id/i.test(error.message)
          ? {
              title: `${name} did not accept the workspace ID.`,
              hint: 'Check ANTHROPIC_WORKSPACE_ID (or anthropic.workspaceId in ~/.patch/config.json). Copy the ID, which starts with wrkspc_, from Settings → Workspaces in the Anthropic Console.',
            }
          : {
              title: `This ${name} API key belongs to your whole organization, so Patch has to say which workspace to use.`,
              hint: 'Set ANTHROPIC_WORKSPACE_ID to the workspace ID (it starts with wrkspc_; find it under Settings → Workspaces in the Anthropic Console), or create an API key inside a workspace instead.',
            };
      case 'billing':
        return {
          title: `Your ${name} account has no API credits left.`,
          hint: 'Add credits under Plans & Billing in the Anthropic Console (console.anthropic.com), then try again. API usage is billed separately from a Claude subscription.',
        };
      case 'invalid_request':
        return {
          title: `${name} rejected the request.${detail}`,
          hint: 'Run with --debug for details. If this persists after /compact, please report it.',
        };
      default:
        return { title: `${name} request failed.${detail}`, hint: 'Run with --debug for details.' };
    }
  }
  if (error instanceof Error) {
    return { title: error.message || 'Unexpected error.', hint: 'Run with --debug for details.' };
  }
  return { title: 'Unexpected error.', hint: 'Run with --debug for details.' };
}
