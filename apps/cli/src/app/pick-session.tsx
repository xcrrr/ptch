import { render } from 'ink';
import type { SessionSummary } from '@patch/core';
import { SessionPicker, sessionPickerMaxVisible } from '../ui/components/index.js';
import { useTerminalSize } from '../ui/hooks/useTerminalSize.js';

interface StartupPickerProps {
  sessions: readonly SessionSummary[];
  projectLabel: string;
  onSelect: (id: string) => void;
  onCancel: () => void;
}

/**
 * The picker sized to the terminal, following resizes. Ink repaints the whole screen (and clears
 * the scrollback) on every frame once its output reaches the terminal height, so it stays at most
 * `rows - 1` rows: the list scrolls instead.
 */
function StartupPicker({ sessions, projectLabel, onSelect, onCancel }: StartupPickerProps) {
  const { columns, rows } = useTerminalSize();
  return (
    <SessionPicker
      sessions={sessions}
      projectLabel={projectLabel}
      width={columns}
      maxVisible={sessionPickerMaxVisible(rows - 1)}
      onSelect={onSelect}
      onCancel={onCancel}
    />
  );
}

/** Shows the session list before the main UI starts (ptch --resume). Resolves null on cancel. */
export async function pickSession(
  sessions: readonly SessionSummary[],
  projectLabel: string,
  stdout: NodeJS.WriteStream = process.stdout,
  stdin: NodeJS.ReadStream = process.stdin,
): Promise<string | null> {
  let chosen: string | null = null;
  const instance = render(
    <StartupPicker
      sessions={sessions}
      projectLabel={projectLabel}
      onSelect={(id) => {
        chosen = id;
        instance.unmount();
      }}
      onCancel={() => instance.unmount()}
    />,
    { stdout, stdin, exitOnCtrlC: true, patchConsole: false },
  );
  await instance.waitUntilExit();
  instance.clear();
  return chosen;
}
