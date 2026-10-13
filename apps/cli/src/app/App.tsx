import { Box, Static, Text, useApp, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PATCH_VERSION } from '@patch/core';
import { plural, splitLines } from '@patch/shared';
import type { ImageAttachment } from '../images.js';
import {
  attachImage,
  emptyComposer,
  insertText,
  type ComposerEffect,
  type ComposerState,
} from '../ui/composer-state.js';
import {
  AutoConfirmPrompt,
  Composer,
  Footer,
  McpApprovalPrompt,
  PermissionPrompt,
  PlanPrompt,
  Select,
  SessionPicker,
  SplashLogo,
  StatusLine,
  ToolRow,
  TranscriptItemView,
  useSpinner,
} from '../ui/components/index.js';
import { useSplash } from '../ui/hooks/useSplash.js';
import { useTerminalSize } from '../ui/hooks/useTerminalSize.js';
import { renderMarkdown } from '../ui/markdown.js';
import { permissionModeAccent } from '../ui/permission-mode.js';
import { displayWidth } from '../ui/text-layout.js';
import { INDENT, glyphs } from '../ui/theme.js';
import type { TranscriptItem } from '../ui/transcript.js';
import { tildify } from '../format.js';
import type { AppController, AppState } from './controller.js';
import { layoutLiveArea } from './layout.js';

export interface AppProps {
  controller: AppController;
  /** The prompt being edited when this instance mounts (the previous instance's, on a remount). */
  initialComposer?: ComposerState;
  /**
   * Called when the view must be remounted on a cleared screen (/clear, /resume, ctrl+l), with
   * the prompt being edited so the next instance continues it.
   */
  onRemount: (composer: ComposerState) => void;
  /**
   * Open a new conversation on a full-height start screen with the animated logo (interactive
   * terminals only). The logo fades out when the first message or command is sent.
   */
  splash?: boolean;
}

/** How long a footer hint ("No image in the clipboard") stays. */
const HINT_MS = 4000;

/** Nothing has been said yet: only the welcome header and startup notices. */
function isFreshStart(state: AppState): boolean {
  return (
    state.mode === 'idle' &&
    !state.exiting &&
    state.activity === null &&
    state.queue.length === 0 &&
    state.liveTools.length === 0 &&
    state.items.every(isHeaderItem)
  );
}

/** A permission prompt, plan review or the auto mode confirmation holds the keyboard. */
function isPrompt(state: AppState): boolean {
  return (
    state.mode === 'permission' || state.mode === 'plan-review' || state.mode === 'auto-confirm'
  );
}

function isHeaderItem(item: TranscriptItem): boolean {
  return item.kind === 'welcome' || item.kind === 'notice';
}

/** The welcome header and notices at the top of the transcript (shown on the start screen). */
function headerItems(items: readonly TranscriptItem[]): TranscriptItem[] {
  const end = items.findIndex((item) => !isHeaderItem(item));
  return end === -1 ? [...items] : items.slice(0, end);
}

/** The end of the streaming text that fits in `maxRows` terminal rows. */
function LiveText({ text, width, maxRows }: { text: string; width: number; maxRows: number }) {
  const textWidth = Math.max(20, width - INDENT);
  const rendered = useMemo(() => renderMarkdown(text, { width: textWidth }), [text, textWidth]);
  const lines = splitLines(rendered);
  // Rendered lines fit the width; counting wrapped rows anyway keeps the height exact.
  const rowWidth = Math.max(1, width - INDENT);
  const visible: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    const height = Math.max(1, Math.ceil(displayWidth(line) / rowWidth));
    if (used + height > maxRows) break;
    visible.unshift(line);
    used += height;
  }
  if (visible.length === 0) return null;
  return (
    <Box marginTop={1} paddingLeft={INDENT} flexDirection="column">
      <Text>{visible.join('\n')}</Text>
    </Box>
  );
}

export function App({
  controller,
  initialComposer = emptyComposer,
  onRemount,
  splash: splashEnabled = false,
}: AppProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [composer, setComposerState] = useState<ComposerState>(initialComposer);
  const splash = useSplash(
    splashEnabled,
    { fresh: isFreshStart(state), exiting: state.exiting },
    columns,
    rows,
    composer,
  );
  // The newest prompt, even before React re-renders, for handing over on a remount.
  const latestComposer = useRef(composer);
  const setComposer = useCallback((next: ComposerState) => {
    latestComposer.current = next;
    setComposerState(next);
  }, []);
  const [hint, setHint] = useHint();
  // Animate only while tools run; a waiting row stays still so a prompt never redraws.
  const animating = !isPrompt(state) && state.liveTools.some((t) => t.status === 'running');
  const spinnerFrame = useSpinner(animating);
  const mountedClearToken = useRef(state.clearScreenToken);

  useEffect(() => {
    if (state.exiting) exit();
  }, [state.exiting, exit]);

  useEffect(() => {
    if (state.clearScreenToken !== mountedClearToken.current) {
      onRemount(latestComposer.current);
      exit();
    }
  }, [state.clearScreenToken, onRemount, exit]);

  const composerActive = state.mode === 'idle' || state.mode === 'running';

  // Images arrive asynchronously (a clipboard read, a permission prompt), so they go into the
  // newest draft at its cursor.
  const pasteClipboardImage = useCallback(() => {
    setHint('Reading the clipboard…', true);
    controller.pasteClipboardImage().then(
      (result) => {
        if (result.ok) {
          setHint(null);
          setComposer(attachImage(latestComposer.current, result.attachment));
        } else {
          setHint(result.message);
        }
      },
      () => setHint('Could not read the clipboard.'),
    );
  }, [controller, setComposer, setHint]);

  const pastePath = useCallback(
    (path: string, raw: string) => {
      const asText = (message?: string) => {
        setComposer(insertText(latestComposer.current, raw));
        if (message) setHint(message);
      };
      controller.attachImage(path).then(
        (result) => {
          if (result.ok) setComposer(attachImage(latestComposer.current, result.attachment));
          else asText(result.reason === 'missing' ? undefined : result.message);
        },
        () => asText(),
      );
    },
    [controller, setComposer, setHint],
  );

  const handleEffect = useCallback(
    (effect: ComposerEffect) => {
      switch (effect.type) {
        case 'interrupt': {
          const outcome = controller.handleCtrlC(latestComposer.current.text.length > 0);
          if (outcome === 'clear-prompt') setComposer(emptyComposer);
          break;
        }
        case 'escape':
          if (controller.isBusy()) controller.interrupt();
          break;
        case 'exit':
          controller.requestExit();
          break;
        case 'clear-screen':
          controller.redraw();
          break;
        case 'expand':
          controller.expandLastTool();
          break;
        case 'paste-image':
          pasteClipboardImage();
          break;
        case 'cycle-mode':
          controller.cyclePermissionMode();
          break;
        default:
          break;
      }
    },
    [controller, setComposer, pasteClipboardImage],
  );

  // Ctrl+C must work even while a prompt or picker owns the keyboard; ctrl+o at a permission
  // prompt or plan review prints the request or plan in full above it.
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') controller.handleCtrlC(false);
      else if (key.ctrl && input === 'o' && isPrompt(controller.getState())) {
        controller.expandPermission();
      }
    },
    { isActive: !composerActive },
  );

  const dismissSplash = splash.dismiss;
  const submit = useCallback(
    (text: string, images?: ImageAttachment[]) => {
      // Cleared first: a submit that remounts the view (/resume <id>) must not hand the sent
      // text over as a draft.
      setComposer(emptyComposer);
      dismissSplash();
      controller.submit(text, images);
    },
    [controller, setComposer, dismissSplash],
  );

  const layout = layoutLiveArea({
    state,
    composer,
    composerActive,
    commands: state.commands,
    columns,
    rows,
  });

  // This instance is about to be replaced on a cleared screen (/clear, /resume, ctrl+l). Rendering
  // the new transcript here would print it once before the clear and once after.
  if (state.clearScreenToken !== mountedClearToken.current) return null;

  // A mode other than the default leads the footer, in its color, instead of the usual hints.
  const modeAccent =
    state.exitArmedAt === null && hint === null
      ? permissionModeAccent(state.permissionMode)
      : undefined;
  const footerLeft =
    state.exitArmedAt !== null
      ? 'Press Ctrl+C again to exit'
      : hint !== null
        ? hint
        : modeAccent
          ? composerActive
            ? 'shift+tab to change'
            : ''
          : state.mode === 'running'
            ? 'esc to interrupt · enter to queue a message'
            : isPrompt(state) || state.mode === 'mcp-approval'
              ? ''
              : '/ for commands · ! for shell · ↑ history';
  const footerRight = [
    state.footer.branch,
    state.footer.model,
    state.footer.contextPercent !== null ? `${state.footer.contextPercent}% context` : null,
  ]
    .filter(Boolean)
    .join(` ${glyphs.dot} `);

  const composerBlock = composerActive ? (
    <Box marginTop={1} flexDirection="column">
      <Composer
        state={composer}
        onChange={setComposer}
        onSubmit={submit}
        onEffect={handleEffect}
        onPastePath={pastePath}
        history={state.history}
        commands={state.commands}
        onMenuOpen={controller.refreshCommands}
        isActive={composerActive}
        width={columns}
        maxRows={layout.composerMaxRows}
        busy={state.mode === 'running'}
        placeholder={
          state.items.some((i) => i.kind === 'user')
            ? 'Reply to Patch'
            : 'What do you want to build?'
        }
      />
    </Box>
  ) : null;
  const footer = (
    <Footer left={footerLeft} right={footerRight} width={columns} accent={modeAccent} />
  );

  if (splash.phase !== 'off') {
    // The start screen fills the terminal (one row short, so Ink never repaints the screen):
    // the logo centered in the space above, the header, prompt and footer at the bottom. The
    // transcript is held back until the logo has faded and the screen has collapsed.
    return (
      <Box flexDirection="column" height={splash.height} overflow="hidden">
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          justifyContent="center"
          alignItems="center"
          overflow="hidden"
        >
          {splash.logo ? (
            <SplashLogo
              frame={splash.logo}
              caption={`v${PATCH_VERSION}`}
              captionLevel={splash.captionLevel}
            />
          ) : null}
        </Box>
        <Box ref={splash.bottomRef} flexDirection="column" flexShrink={0}>
          {headerItems(state.items).map((item) => (
            <TranscriptItemView key={item.id} item={item} width={columns} welcomeTitle={false} />
          ))}
          {composerBlock}
          {footer}
        </Box>
      </Box>
    );
  }

  return (
    <>
      <Static key={state.staticKey} items={state.items}>
        {(item) => (
          <TranscriptItemView
            key={item.id}
            item={item}
            width={columns}
            welcomeTitle={!splash.shown}
          />
        )}
      </Static>

      {layout.liveTextRows > 0 ? (
        <LiveText text={state.liveText} width={columns} maxRows={layout.liveTextRows} />
      ) : null}

      {layout.tools.length > 0 ? (
        <Box
          flexDirection="column"
          marginTop={1}
          {...(layout.toolsClip !== undefined
            ? { height: layout.toolsClip, overflow: 'hidden' as const }
            : {})}
        >
          {layout.hiddenTools > 0 && (
            <Text dimColor wrap="truncate-end">
              {`${' '.repeat(INDENT)}${glyphs.ellipsis} ${plural(layout.hiddenTools, 'earlier tool call')}`}
            </Text>
          )}
          {layout.tools.map((tool) => (
            <ToolRow
              key={tool.id}
              name={tool.name}
              summary={tool.summary}
              status={tool.status}
              display={tool.display}
              progress={tool.progress}
              durationMs={tool.durationMs}
              width={columns}
              spinnerFrame={spinnerFrame}
            />
          ))}
        </Box>
      ) : null}

      {state.mode === 'permission' && state.permission ? (
        <Box marginTop={1} flexDirection="column">
          <PermissionPrompt
            request={state.permission}
            onRespond={controller.respondPermission}
            width={columns}
            maxRows={layout.permissionMaxRows}
            isActive
          />
        </Box>
      ) : null}

      {state.mode === 'plan-review' && state.planReview ? (
        <Box marginTop={1} flexDirection="column">
          <PlanPrompt
            key={state.planReview.id}
            request={state.planReview}
            onRespond={controller.respondPlan}
            width={columns}
            maxRows={layout.planMaxRows}
            isActive
          />
        </Box>
      ) : null}

      {state.mode === 'auto-confirm' ? (
        <Box marginTop={1} flexDirection="column">
          <AutoConfirmPrompt onRespond={controller.respondAutoConfirm} width={columns} isActive />
        </Box>
      ) : null}

      {state.mode === 'mcp-approval' && state.mcpApproval ? (
        <Box marginTop={1} flexDirection="column">
          <McpApprovalPrompt
            request={state.mcpApproval}
            onRespond={controller.respondMcpApproval}
            width={columns}
            maxRows={layout.mcpApprovalMaxRows}
            isActive
          />
        </Box>
      ) : null}

      {state.mode === 'session-picker' && state.sessionChoices ? (
        <Box marginTop={1} flexDirection="column">
          <SessionPicker
            sessions={state.sessionChoices}
            onSelect={controller.selectSession}
            onCancel={controller.cancelPicker}
            width={columns}
            projectLabel={tildify(controller.runtime.workspace.projectRoot)}
            maxVisible={layout.pickerMaxVisible}
          />
        </Box>
      ) : null}

      {state.mode === 'model-picker' && state.modelChoices ? (
        <Box marginTop={1} flexDirection="column" paddingLeft={INDENT}>
          <Text bold wrap="truncate-end">
            Choose a model for this session
          </Text>
          <Box marginTop={1}>
            <Select
              options={state.modelChoices.map((m) => ({
                label: m.id,
                value: m.id,
                hint:
                  (m.id === state.footer.model ? 'current · ' : '') + (m.description ?? m.label),
              }))}
              initialIndex={Math.max(
                0,
                state.modelChoices.findIndex((m) => m.id === state.footer.model),
              )}
              onSelect={controller.selectModel}
              onCancel={controller.cancelPicker}
              maxVisible={layout.pickerMaxVisible}
              isActive
            />
          </Box>
          <Text dimColor wrap="truncate-end">
            Other model ids: /model {'<id>'}
          </Text>
        </Box>
      ) : null}

      {state.activity && !isPrompt(state) ? (
        <Box marginTop={1}>
          <StatusLine
            label={state.activity.label}
            startedAt={state.activity.startedAt}
            detail={state.activity.detail}
            hint="esc to interrupt"
          />
        </Box>
      ) : null}

      {layout.queue.length > 0 ? (
        <Box flexDirection="column" paddingLeft={INDENT}>
          {layout.queue.map((q, i) => (
            <Text key={i} dimColor wrap="truncate-end">
              queued: {q.split('\n')[0]}
            </Text>
          ))}
          {layout.hiddenQueue > 0 && (
            <Text dimColor wrap="truncate-end">
              {`${glyphs.ellipsis} ${layout.hiddenQueue} more queued`}
            </Text>
          )}
        </Box>
      ) : null}

      {composerBlock}
      {footer}
    </>
  );
}

/**
 * A brief dim message shown in the footer instead of the key hints, e.g. "No image in the
 * clipboard". It clears itself after HINT_MS unless `sticky` (then the next call replaces it).
 */
function useHint(): [string | null, (text: string | null, sticky?: boolean) => void] {
  const [hint, setHintText] = useState<string | null>(null);
  const timer = useRef<NodeJS.Timeout | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const setHint = useCallback((text: string | null, sticky = false) => {
    clearTimeout(timer.current);
    setHintText(text);
    if (text !== null && !sticky) timer.current = setTimeout(() => setHintText(null), HINT_MS);
  }, []);
  return [hint, setHint];
}
