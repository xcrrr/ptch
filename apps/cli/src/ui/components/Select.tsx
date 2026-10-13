import { Box, Text, useInput, type Key } from 'ink';
import { useCallback, useRef, useState } from 'react';
import { glyphs, theme } from '../theme.js';
import type { SelectProps } from './props.js';

const DEFAULT_MAX_VISIBLE = 10;

export interface ListNavigationOptions {
  count: number;
  initialIndex?: number;
  isActive?: boolean;
  /** Digits 1-9 select (and submit) the matching item directly. */
  numbered?: boolean;
  maxVisible?: number;
  onSubmit: (index: number) => void;
  onCancel?: () => void;
}

export interface ListNavigation {
  /** Highlighted item (0 when the list is empty). */
  index: number;
  /** Visible window [start, end). */
  start: number;
  end: number;
}

interface ListView {
  index: number;
  start: number;
}

/**
 * Keyboard navigation for vertical lists: Up/Down and k/j move (wrapping), PageUp/PageDown jump
 * a page, Home/End go to the ends, Enter submits, Esc cancels. The visible window scrolls only as
 * far as needed to keep the highlighted item in view.
 */
export function useListNavigation(options: ListNavigationOptions): ListNavigation {
  const { count, isActive = true } = options;
  const visible = Math.max(1, options.maxVisible ?? DEFAULT_MAX_VISIBLE);
  const [view, setView] = useState<ListView>(() =>
    viewFor(clampIndex(options.initialIndex ?? 0, count), 0, visible, count),
  );
  const current = viewFor(clampIndex(view.index, count), view.start, visible, count);

  // Several key events can arrive before React re-renders; the handler reads the latest values.
  const latest = useRef({ view: current, count, visible, options });
  latest.current = { view: current, count, visible, options };

  const handleInput = useCallback((input: string, key: Key) => {
    const { view: shown, count: total, visible: pageSize, options: opts } = latest.current;
    const select = (index: number): void => {
      const next = viewFor(index, shown.start, pageSize, total);
      latest.current = { ...latest.current, view: next };
      setView(next);
    };
    if (key.escape) {
      opts.onCancel?.();
      return;
    }
    if (total === 0) return;
    const letter = key.ctrl || key.meta ? '' : input;
    if (key.return) opts.onSubmit(shown.index);
    else if (key.upArrow || letter === 'k') select((shown.index - 1 + total) % total);
    else if (key.downArrow || letter === 'j') select((shown.index + 1) % total);
    else if (key.pageUp) select(Math.max(0, shown.index - pageSize));
    else if (key.pageDown) select(Math.min(total - 1, shown.index + pageSize));
    else if (key.home) select(0);
    else if (key.end) select(total - 1);
    else if (opts.numbered && /^[1-9]$/.test(letter) && Number(letter) <= total) {
      const index = Number(letter) - 1;
      select(index);
      opts.onSubmit(index);
    }
  }, []);

  useInput(handleInput, { isActive });
  return {
    index: current.index,
    start: current.start,
    end: Math.min(count, current.start + visible),
  };
}

function clampIndex(index: number, count: number): number {
  return Math.min(Math.max(0, index), Math.max(0, count - 1));
}

/** Smallest scroll from `start` that keeps `index` inside a window of `visible` items. */
function viewFor(index: number, start: number, visible: number, count: number): ListView {
  let next = start;
  if (index < next) next = index;
  if (index >= next + visible) next = index - visible + 1;
  next = Math.min(Math.max(0, next), Math.max(0, count - visible));
  return { index, start: next };
}

/**
 * Vertical list: Up/Down (and k/j) move, Enter selects, Esc cancels, digits 1-9 select directly
 * when `numbered`.
 */
export function Select<T>({
  options,
  onSelect,
  onCancel,
  initialIndex,
  isActive = true,
  numbered = false,
  maxVisible,
}: SelectProps<T>) {
  const { index, start, end } = useListNavigation({
    count: options.length,
    initialIndex,
    isActive,
    numbered,
    maxVisible,
    onCancel,
    onSubmit: (selected) => {
      const option = options[selected];
      if (option) onSelect(option.value);
    },
  });
  const numberWidth = `${options.length}.`.length;
  return (
    <Box flexDirection="column">
      {start > 0 && <Text dimColor>{`  ↑ ${start} more`}</Text>}
      {options.slice(start, end).map((option, offset) => {
        const position = start + offset;
        const selected = position === index;
        const danger = option.tone === 'danger';
        const color = danger ? theme.danger : selected ? theme.accent : undefined;
        return (
          <Text key={position} wrap="truncate-end">
            {selected ? (
              <Text color={danger ? theme.danger : theme.accent}>{`${glyphs.pointer} `}</Text>
            ) : (
              '  '
            )}
            {numbered && <Text dimColor>{`${position + 1}.`.padStart(numberWidth)} </Text>}
            <Text color={color}>{option.label}</Text>
            {option.hint && <Text dimColor>{`  ${option.hint}`}</Text>}
          </Text>
        );
      })}
      {end < options.length && <Text dimColor>{`  ↓ ${options.length - end} more`}</Text>}
    </Box>
  );
}
