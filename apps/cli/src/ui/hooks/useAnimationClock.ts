import { useEffect, useRef, useState } from 'react';

/** ~30 frames per second, matching Ink's render limit. */
export const ANIMATION_FRAME_MS = 33;

/**
 * Milliseconds since `running` became true, advancing every frame and stopping at `durationMs`,
 * when `onDone` is called once. When `running` turns false the last value is kept.
 */
export function useAnimationClock(
  running: boolean,
  durationMs: number,
  onDone?: () => void,
): number {
  const [elapsed, setElapsed] = useState(0);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    setElapsed(0);
    const timer = setInterval(() => {
      const t = Date.now() - start;
      setElapsed(Math.min(t, durationMs));
      if (t >= durationMs) {
        clearInterval(timer);
        done.current?.();
      }
    }, ANIMATION_FRAME_MS);
    return () => clearInterval(timer);
  }, [running, durationMs]);

  return elapsed;
}
