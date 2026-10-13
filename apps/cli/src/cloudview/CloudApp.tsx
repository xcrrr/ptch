import { Box, Static, Text, useApp, useInput, useStdout, type Key } from 'ink';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { PATCH_VERSION } from '@patch/core';
import { CHAT_SUGGESTIONS } from '@patch/cloud-protocol';
import {
  emptyComposer,
  setText,
  type ComposerEffect,
  type ComposerState,
} from '../ui/composer-state.js';
import {
  Composer,
  Footer,
  Select,
  SplashLogo,
  StatusLine,
  useSpinner,
} from '../ui/components/index.js';
import { useSplash } from '../ui/hooks/useSplash.js';
import { useTerminalSize } from '../ui/hooks/useTerminalSize.js';
import { displayWidth, padEndToWidth, toDisplayText, truncateToWidth } from '../ui/text-layout.js';
import { glyphs, INDENT, theme } from '../ui/theme.js';
import { HeaderLine, ItemView, hostLabel } from './blocks.js';
import type { CloudViewController, CloudViewState, PickerState } from './controller.js';
import { activeChooseProject, buildItems, committedCount, latestPendingProposal } from './model.js';

export interface CloudAppProps {
  controller: CloudViewController;
  initialComposer?: ComposerState;
  /** The view must be remounted on a cleared screen (/new, /resume), carrying the draft. */
  onRemount: (composer: ComposerState) => void;
  /** Open a new conversation on the full-height start screen with the animated logo. */
  splash?: boolean;
}

/** What owns the keyboard. */
type Focus = 'composer' | 'proposal' | 'push' | 'picker' | 'follow' | 'sign-in' | 'none';

function focusOf(state: CloudViewState): Focus {
  if (state.signIn.status === 'waiting') return 'sign-in';
  if (!state.booted && state.phase === 'ready') return 'none';
  if (state.loadingConversation) return 'none';
  if (state.picker) return 'picker';
  if (state.follow) return 'follow';
  if (state.push) return 'push';
  return 'composer';
}

/** The sign-in address without its long query: where it goes, not every parameter of it. */
function shortAddress(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}…`;
  } catch {
    return `${toDisplayText(url).slice(0, 40)}…`;
  }
}

function useClock(active: boolean, ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}

/**
 * Asks the terminal to report when it gains or loses the focus (ESC [ I, ESC [ O; Ink delivers
 * them as the input "[I" and "[O"), so runs are only polled while someone is looking.
 */
function useTerminalFocusReports(): void {
  const { stdout } = useStdout();
  useEffect(() => {
    if (!stdout.isTTY) return;
    stdout.write('[?1004h');
    return () => {
      stdout.write('[?1004l');
    };
  }, [stdout]);
}

export function CloudApp({
  controller,
  initialComposer = emptyComposer,
  onRemount,
  splash: splashEnabled = false,
}: CloudAppProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [composer, setComposerState] = useState<ComposerState>(initialComposer);
  const latestComposer = useRef(composer);
  const setComposer = useCallback((next: ComposerState) => {
    latestComposer.current = next;
    setComposerState(next);
  }, []);
  const mountedClearToken = useRef(state.clearScreenToken);
  useTerminalFocusReports();

  const fresh = controller.isFresh();
  const splash = useSplash(
    splashEnabled,
    { fresh, exiting: state.exiting },
    columns,
    rows,
    composer,
  );

  const focus = focusOf(state);
  const connecting = state.phase === 'ready' && !state.booted;
  const waiting = state.busy !== null || connecting || state.loadingConversation;
  const spinnerFrame = useSpinner(
    waiting ||
      state.proposal?.busy != null ||
      state.push?.busy === true ||
      state.picker?.options.some((o) => o.spinner) === true ||
      Object.values(state.tasks).some((t) => t.status === 'running' || t.status === 'starting'),
  );
  const now = useClock(state.connection === 'offline', 1000);

  useEffect(() => {
    if (state.exiting) exit();
  }, [state.exiting, exit]);

  useEffect(() => {
    if (state.clearScreenToken !== mountedClearToken.current) {
      onRemount(latestComposer.current);
      exit();
    }
  }, [state.clearScreenToken, onRemount, exit]);

  // A failed message comes back into the prompt; a proposal's prompt is edited there.
  const seenDraft = useRef(state.draft?.token ?? 0);
  useEffect(() => {
    if (state.draft && state.draft.token !== seenDraft.current) {
      seenDraft.current = state.draft.token;
      setComposer(setText(state.draft.text));
    }
  }, [state.draft, setComposer]);

  // The keys of a proposal act only while the prompt is empty, so a message that begins with
  // y, n, p or e is typed as usual.
  const proposalKey = useCallback(
    (input: string, key: Key, draft: ComposerState): boolean => {
      const ui = controller.getState().proposal;
      if (!ui || ui.editing || ui.busy || draft.text !== '') return false;
      if (key.return || input === 'y') controller.perform(controller.startProposal());
      else if (input === 'n' || key.escape) controller.perform(controller.dismissProposal());
      else if (input === 'p') controller.cycleProfile();
      else if (input === 'e') controller.beginProposalEdit();
      else return false;
      return true;
    },
    [controller],
  );

  const handleEffect = useCallback(
    (effect: ComposerEffect) => {
      switch (effect.type) {
        case 'interrupt': {
          const outcome = controller.handleCtrlC(latestComposer.current.text.length > 0);
          if (outcome === 'clear-prompt') setComposer(emptyComposer);
          break;
        }
        case 'escape': {
          const ui = controller.getState().proposal;
          if (ui?.editing) {
            controller.cancelProposalEdit();
            setComposer(emptyComposer);
          } else if (latestComposer.current.text !== '') {
            setComposer(emptyComposer);
          }
          break;
        }
        case 'exit':
          controller.requestExit();
          break;
        default:
          break;
      }
    },
    [controller, setComposer],
  );

  const submit = useCallback(
    (text: string) => {
      setComposer(emptyComposer);
      splash.dismiss();
      controller.perform(controller.submit(text));
    },
    [controller, setComposer, splash],
  );

  // Ctrl+C always works; the keys of a proposal, an upload question and a followed run.
  useInput(
    (input, key) => {
      if (input === '[I' || input === '[O') {
        controller.setFocused(input === '[I');
        return;
      }
      if (key.ctrl && input === 'c') {
        controller.handleCtrlC(false);
        return;
      }
      if (focus === 'composer' || focus === 'picker') return;
      if (focus === 'push') {
        if (key.return || input === 'y') controller.perform(controller.confirmPush());
        else if (input === 'n' || key.escape) controller.cancelPush();
      } else if (focus === 'follow') {
        if (key.escape || input === 'q') controller.stopFollowing();
      } else if (focus === 'sign-in') {
        if (key.escape) controller.handleCtrlC(false);
        else if (input === 'c') controller.perform(controller.copySignInAddress());
      }
    },
    { isActive: true },
  );

  const built = useMemo(
    () =>
      buildItems(state.entries, {
        tasks: state.tasks,
        missing: new Set(state.missing),
        facts: state.facts,
        activeProposal: latestPendingProposal(state.entries)?.messageId ?? null,
        activeChoose: activeChooseProject(state.entries)?.messageId ?? null,
        now: Date.now(),
      }),
    [state.entries, state.tasks, state.missing, state.facts],
  );
  const committedRef = useRef(0);
  const committed = committedCount(built, committedRef.current);
  committedRef.current = committed;

  if (state.clearScreenToken !== mountedClearToken.current) return null;

  const projectName = (id: string): string | null =>
    state.projects.find((p) => p.id === id)?.name ?? null;
  const missing = new Set(state.missing);
  const renderItem = (b: (typeof built)[number]): ReactNode => (
    <ItemView
      key={b.item.id}
      item={b.item}
      width={columns}
      tasks={state.tasks}
      missing={missing}
      facts={state.facts}
      projectName={projectName}
      proposal={state.proposal}
      spinnerFrame={spinnerFrame}
      keysActive={composer.text === ''}
      cloudVersion={state.cloudVersion}
    />
  );

  // ---------------------------------------------------------------- footer
  const footerLeft = (() => {
    if (state.exitArmedAt !== null) return 'Press Ctrl+C again to exit';
    if (state.hint) return state.hint;
    switch (focus) {
      case 'picker':
        return '';
      case 'proposal':
        return '';
      case 'push':
        return 'y upload · n cancel';
      case 'follow':
        return 'esc stop following (the run keeps going)';
      case 'sign-in':
        return state.signIn.url ? 'c copies the full address · esc cancel' : 'esc to cancel';
      default:
        return state.proposal?.editing
          ? 'enter keeps the prompt · esc cancels'
          : '/ for commands · ↑ history';
    }
  })();
  const workerText =
    state.phase !== 'ready'
      ? 'signed out'
      : state.connection === 'offline'
        ? 'offline'
        : state.worker === 'unknown'
          ? ''
          : `worker ${state.worker}`;
  const footerRight = [
    state.project?.name ?? (state.phase === 'ready' ? 'no project' : ''),
    workerText,
  ]
    .filter(Boolean)
    .join(` ${glyphs.dot} `);
  // On a wide terminal the hint and the status stay close together.
  const footer = <Footer left={footerLeft} right={footerRight} width={Math.min(columns, 100)} />;

  // ---------------------------------------------------------------- banner and panels
  const banner =
    state.connection === 'offline' ? (
      <Box paddingLeft={INDENT} marginTop={1}>
        <Text color={theme.warning} wrap="truncate-end">
          {`Patch Cloud is unreachable. ${
            state.retryAt !== null && state.retryAt > now
              ? `Trying again in ${Math.max(1, Math.ceil((state.retryAt - now) / 1000))}s`
              : 'Trying again now'
          }. Your conversation stays here.`}
        </Text>
      </Box>
    ) : state.connection === 'expired' ? (
      <Box paddingLeft={INDENT} marginTop={1}>
        <Text color={theme.warning} wrap="truncate-end">
          Your sign-in expired or was revoked. Type /login to sign in again.
        </Text>
      </Box>
    ) : null;

  const signInPanel =
    state.phase === 'signed-out' ? (
      <Box flexDirection="column" paddingLeft={INDENT} marginTop={1}>
        <Text bold>Sign in to Patch Cloud</Text>
        {state.signIn.status === 'waiting' ? (
          <>
            <Text dimColor>
              {state.signIn.url
                ? 'Your browser should open. If it does not, press c to copy the address.'
                : 'Contacting Patch Cloud…'}
            </Text>
            {state.signIn.url ? <Text>{shortAddress(state.signIn.url)}</Text> : null}
            <Text>
              <Text color={theme.accent}>{spinnerFrame}</Text>
              <Text dimColor> Waiting for you to approve this device</Text>
            </Text>
          </>
        ) : state.signIn.status === 'failed' ? (
          <>
            <Text color={theme.danger}>
              {glyphs.cross} {toDisplayText(state.signIn.message ?? 'The sign-in failed.')}
            </Text>
            <Text dimColor>Type /login to try again, or ctrl+c twice to leave.</Text>
          </>
        ) : (
          <Text dimColor>You are signed out. Type /login to sign in.</Text>
        )}
      </Box>
    ) : null;

  const composerOpen = focus === 'composer';
  const placeholder = state.proposal?.editing
    ? 'Edit the prompt'
    : state.entries.some((e) => e.kind === 'message' || e.kind === 'pending-user')
      ? 'Reply to Patch'
      : (CHAT_SUGGESTIONS[0] as string);
  const composerBlock = composerOpen ? (
    <Box marginTop={1} flexDirection="column">
      <Composer
        state={composer}
        onChange={setComposer}
        onSubmit={submit}
        onKey={proposalKey}
        onEffect={handleEffect}
        history={state.history}
        commands={state.commands}
        isActive
        width={columns}
        maxRows={Math.max(3, Math.min(12, rows - 12))}
        busy={state.busy !== null}
        placeholder={placeholder}
      />
    </Box>
  ) : null;

  const pickerBlock = state.picker ? (
    <PickerView
      picker={state.picker}
      rows={rows}
      columns={columns}
      spinnerFrame={spinnerFrame}
      onSelect={(value) => controller.perform(controller.selectPicker(value))}
      onCancel={() => controller.cancelPicker()}
    />
  ) : null;

  const activity = connecting ? (
    <Box paddingLeft={INDENT} marginTop={1}>
      <Text wrap="truncate-end">
        <Text color={theme.accent}>{spinnerFrame}</Text>
        <Text dimColor>{` Connecting to ${hostLabel(state.host ?? 'Patch Cloud')}…`}</Text>
      </Text>
    </Box>
  ) : state.loadingConversation ? (
    <Box paddingLeft={INDENT} marginTop={1}>
      <Text>
        <Text color={theme.accent}>{spinnerFrame}</Text>
        <Text dimColor> Opening the conversation…</Text>
      </Text>
    </Box>
  ) : state.busy ? (
    <Box marginTop={1}>
      <StatusLine label={state.busy.label} startedAt={state.busy.startedAt} hint="" />
    </Box>
  ) : state.follow ? (
    <Box paddingLeft={INDENT} marginTop={1}>
      <Text wrap="truncate-end">
        <Text color={theme.accent}>{spinnerFrame}</Text>
        <Text dimColor>{` Following ${toDisplayText(state.follow.title)}`}</Text>
      </Text>
    </Box>
  ) : null;

  const pushBlock = state.push ? (
    <Box paddingLeft={INDENT} marginTop={1} flexDirection="column">
      <Text wrap="wrap">{toDisplayText(state.push.question)}</Text>
      <Text dimColor>
        {state.push.busy ? 'Uploading…' : 'y or enter uploads · n or esc cancels'}
      </Text>
    </Box>
  ) : null;

  // ---------------------------------------------------------------- the start screen
  if (splash.phase !== 'off') {
    const header = built.find((b) => b.item.kind === 'header');
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
          {header?.item.kind === 'header' ? (
            <HeaderLine entry={header.item.entry} width={columns} />
          ) : null}
          {activity}
          {signInPanel}
          {banner}
          {pickerBlock}
          {pushBlock}
          {composerBlock}
          {footer}
        </Box>
      </Box>
    );
  }

  return (
    <>
      <Static items={built.slice(0, committed)}>{(b) => renderItem(b)}</Static>
      {built.slice(committed).map(renderItem)}
      {activity}
      {signInPanel}
      {banner}
      {pickerBlock}
      {pushBlock}
      {composerBlock}
      {footer}
    </>
  );
}

/** A list the user chooses from: conversations, projects, runs, Brain entries. */
function PickerView({
  picker,
  rows,
  columns,
  spinnerFrame,
  onSelect,
  onCancel,
}: {
  picker: PickerState;
  rows: number;
  columns: number;
  spinnerFrame: string;
  onSelect: (value: string) => void;
  onCancel: () => void;
}) {
  const maxVisible = Math.max(3, Math.min(10, rows - 12));
  const oneLine = (text: string): string => toDisplayText(text).replace(/\s+/g, ' ');
  // The hints form a column of the same width; it is the title that gives way when the row is
  // too long, never the status in front of it.
  // (a hint keeps its spaces: the status in front of it is padded to a column)
  const hints = picker.options.map((o) =>
    toDisplayText(o.hint ?? '')
      .split('\n')
      .join(' '),
  );
  const hintWidth = Math.max(0, ...hints.map(displayWidth));
  const labels = picker.options.map((o) =>
    o.mark ? `${o.spinner ? spinnerFrame : o.mark} ${oneLine(o.label)}` : oneLine(o.label),
  );
  const budget = Math.max(10, columns - INDENT - 2 - (hintWidth > 0 ? 2 + hintWidth : 0) - 1);
  const labelWidth = Math.min(budget, Math.max(0, ...labels.map(displayWidth)));
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={INDENT}>
      <Text bold wrap="truncate-end">
        {toDisplayText(picker.title)}
      </Text>
      {picker.subtitle ? (
        <Text dimColor wrap="truncate-end">
          {toDisplayText(picker.subtitle)}
        </Text>
      ) : null}
      <Box marginTop={1}>
        <Select
          key={`${picker.kind}:${picker.title}`}
          options={picker.options.map((o, i) => ({
            label: padEndToWidth(truncateToWidth(labels[i] ?? '', labelWidth), labelWidth),
            value: o.value,
            ...(hints[i] ? { hint: hints[i] } : {}),
          }))}
          initialIndex={picker.initialIndex ?? 0}
          onSelect={onSelect}
          onCancel={onCancel}
          maxVisible={maxVisible}
          isActive
        />
      </Box>
      {picker.footer ? (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {picker.footer}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
