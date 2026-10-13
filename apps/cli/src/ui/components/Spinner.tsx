import { Text } from 'ink';
import { useEffect, useState } from 'react';
import { glyphs } from '../theme.js';

export const SPINNER_INTERVAL_MS = 80;

/** Current spinner frame, advancing every 80ms while `active`. */
export function useSpinner(active = true): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % glyphs.spinner.length);
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active]);
  return glyphs.spinner[frame] ?? glyphs.spinner[0];
}

export interface SpinnerProps {
  color?: string;
}

/** A self-animating spinner glyph. */
export function Spinner({ color }: SpinnerProps) {
  const frame = useSpinner();
  return <Text color={color}>{frame}</Text>;
}
