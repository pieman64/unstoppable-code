export {
  TerminalPane,
  type TerminalPaneProps,
} from './code/terminal/TerminalPane';
export { computeColsRowsForPixels } from './code/terminal/terminal-dimensions';
export { installTerminalLinks } from './code/terminal/terminal-links';
export {
  disposeInstance,
  getOrCreateInstance,
  peekInstance,
  TERMINAL_BG_COLOR,
  TERMINAL_THEME,
  type TerminalInstanceEntry,
} from './code/terminal/terminal-instances';
export {
  TerminalPanelSurface,
  type TerminalPanelSurfaceProps,
} from './code/terminal/TerminalPanelSurface';
export type { TerminalPanelHost } from './code/terminal/terminal-panel-host';
