import { measureElement, type DOMElement } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ComposerState } from '../composer-state.js';
import { INTRO_MS, OUTRO_MS, introFrame, outroFrame, type LogoFrame } from '../logo.js';
import { SPLASH_LOGO_ROWS } from '../components/SplashLogo.js';
import { useAnimationClock } from './useAnimationClock.js';

/**
 * The start screen's life: the logo animates in, stays, fades out after the first submit, then
 * the screen collapses to the normal layout (the header and prompt slide up).
 */
type SplashPhase = 'intro' | 'idle' | 'outro' | 'collapse' | 'off';

const SPLASH_MIN_ROWS = 18;
const SPLASH_MIN_COLUMNS = 40;
const COLLAPSE_MS = 220;
/** Caption timing, inside the logo's intro and outro. */
const CAPTION_IN_START_MS = 700;
const CAPTION_IN_MS = 450;
const CAPTION_OUT_MS = 220;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export interface SplashView {
  phase: SplashPhase;
  /** Whether this view opened on the start screen (the header then has no title line). */
  shown: boolean;
  /** The logo frame to draw, or null when it is gone. */
  logo: LogoFrame | null;
  captionLevel: number;
  /** Height of the start screen in rows. */
  height: number;
  bottomRef: RefObject<DOMElement | null>;
  /** Starts the fade-out (first message or command). */
  dismiss: () => void;
}

/** State and animation of the start screen. */
export function useSplash(
  enabled: boolean,
  /** `fresh`: nothing has been said yet; `exiting`: the view is closing. */
  state: { fresh: boolean; exiting: boolean },
  columns: number,
  rows: number,
  /** The draft: a long one can leave no room for the logo. */
  composer: ComposerState,
): SplashView {
  const [phase, setPhase] = useState<SplashPhase>(() =>
    enabled && state.fresh && rows >= SPLASH_MIN_ROWS && columns >= SPLASH_MIN_COLUMNS
      ? 'intro'
      : 'off',
  );
  const [shown] = useState(phase !== 'off');
  const bottomRef = useRef<DOMElement>(null);
  /** Where the intro was when the fade-out started (it can start before the intro ends). */
  const introAtDismiss = useRef(INTRO_MS);
  /** Height of the header, prompt and footer when the collapse started. */
  const collapseTo = useRef(0);

  const introElapsed = useAnimationClock(phase === 'intro', INTRO_MS, () =>
    setPhase((p) => (p === 'intro' ? 'idle' : p)),
  );
  const outroElapsed = useAnimationClock(phase === 'outro', OUTRO_MS, () => {
    collapseTo.current = bottomRef.current ? measureElement(bottomRef.current).height : 0;
    setPhase((p) => (p === 'outro' ? 'collapse' : p));
  });
  const collapseElapsed = useAnimationClock(phase === 'collapse', COLLAPSE_MS, () =>
    setPhase((p) => (p === 'collapse' ? 'off' : p)),
  );

  const dismiss = useCallback(() => {
    setPhase((p) => {
      if (p !== 'intro' && p !== 'idle') return p;
      introAtDismiss.current = p === 'intro' ? introElapsed : INTRO_MS;
      return 'outro';
    });
  }, [introElapsed]);

  const { fresh } = state;
  useEffect(() => {
    if (phase === 'off') return;
    if (state.exiting) {
      setPhase('off');
      return;
    }
    if (phase !== 'intro' && phase !== 'idle') return;
    // No room for the logo (a small window, a long draft): straight to the normal layout.
    const bottom = bottomRef.current ? measureElement(bottomRef.current).height : 0;
    if (columns < SPLASH_MIN_COLUMNS || rows - 1 - bottom < SPLASH_LOGO_ROWS) setPhase('off');
    // Something started without a submit from this view.
    else if (!fresh) dismiss();
  }, [phase, state.exiting, columns, rows, composer, fresh, dismiss]);

  const logo = useMemo((): LogoFrame | null => {
    if (phase === 'intro') return introFrame(introElapsed);
    if (phase === 'idle') return introFrame(INTRO_MS);
    if (phase !== 'outro') return null;
    const from = introFrame(introAtDismiss.current);
    const out = outroFrame(outroElapsed);
    return {
      intensity: (x, y) => from.intensity(x, y) * out.intensity(x, y),
      color: from.color,
    };
  }, [phase, introElapsed, outroElapsed]);

  const captionIn = (elapsed: number) => clamp01((elapsed - CAPTION_IN_START_MS) / CAPTION_IN_MS);
  const captionLevel =
    phase === 'intro'
      ? captionIn(introElapsed)
      : phase === 'idle'
        ? 1
        : phase === 'outro'
          ? Math.min(captionIn(introAtDismiss.current), 1 - clamp01(outroElapsed / CAPTION_OUT_MS))
          : 0;

  const full = Math.max(1, rows - 1);
  const height =
    phase === 'collapse'
      ? Math.max(
          collapseTo.current,
          Math.round(
            full -
              (full - collapseTo.current) * (1 - (1 - clamp01(collapseElapsed / COLLAPSE_MS)) ** 3),
          ),
        )
      : full;

  return { phase, shown, logo, captionLevel, height, bottomRef, dismiss };
}
