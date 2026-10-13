import type { PermissionMode } from '@patch/core';
import { glyphs, theme } from './theme.js';

/** The footer's mark for a permission mode ("⏸ plan mode"); none for the default mode. */
export function permissionModeAccent(
  mode: PermissionMode,
): { text: string; color: string } | undefined {
  switch (mode) {
    case 'default':
      return undefined;
    case 'acceptEdits':
      return { text: `${glyphs.acceptEdits} accepting edits`, color: theme.acceptEdits };
    case 'plan':
      return { text: `${glyphs.planMode} plan mode`, color: theme.planMode };
    case 'auto':
      return {
        text: `${glyphs.autoMode} auto mode ${glyphs.dot} no permission prompts`,
        color: theme.autoMode,
      };
  }
}

/** A permission mode in words, for /status. */
export function describePermissionMode(mode: PermissionMode): string {
  switch (mode) {
    case 'default':
      return 'default';
    case 'acceptEdits':
      return 'accepting edits';
    case 'plan':
      return 'plan mode';
    case 'auto':
      return 'auto mode (no permission prompts)';
  }
}
