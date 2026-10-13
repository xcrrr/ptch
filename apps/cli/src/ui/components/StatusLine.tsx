import { formatElapsed } from '@patch/shared';
import { Text } from 'ink';
import { useEffect, useState } from 'react';
import { glyphs, theme } from '../theme.js';
import type { StatusLineProps } from './props.js';
import { useSpinner } from './Spinner.js';

const CLOCK_INTERVAL_MS = 1000;

/**
 * Activity line shown while the agent works:
 *   "⠹ Running pnpm test  14s · esc to interrupt"
 * The spinner sits in the two-column gutter so the label lines up with indented output.
 */
export function StatusLine({ label, startedAt, detail, hint }: StatusLineProps) {
  const frame = useSpinner();
  const now = useClock(CLOCK_INTERVAL_MS);
  const elapsed = formatElapsed(Math.max(0, now - startedAt));
  const meta = [elapsed, detail, hint].filter(Boolean).join(` ${glyphs.dot} `);
  return (
    <Text wrap="truncate-end">
      <Text color={theme.accent}>{frame}</Text> {label}
      <Text dimColor>{`  ${meta}`}</Text>
    </Text>
  );
}

function useClock(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
