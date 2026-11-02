import type { ITheme } from '@xterm/xterm';

export const TERMINAL_BG_COLOR = '#0b0c10';

/**
 * Terminals retain a dark surface in every app appearance. Selection therefore
 * uses the default dark bg-muted value, rather than the light theme's black
 * overlay. xterm accepts color strings, not CSS variables. Keep the focused
 * and unfocused colors identical and leave ANSI foreground colors intact.
 */
export const TERMINAL_THEME: ITheme = {
  background: TERMINAL_BG_COLOR,
  foreground: '#e6e6e6',
  cursor: '#e6e6e6',
  selectionBackground: 'rgba(255, 255, 255, 0.105)',
  selectionInactiveBackground: 'rgba(255, 255, 255, 0.105)',
};
