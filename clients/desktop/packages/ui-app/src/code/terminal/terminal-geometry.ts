// What decides a terminal pane's cols/rows, shared by the pane's cached xterm
// (`terminal-instances`) and the probe that predicts its size before the pane
// exists (`terminal-dimensions`). Keep every option that changes a cell's
// size or the fitted area here, so the two cannot drift apart.

import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/** xterm options that change the cell size or the area a fit leaves for cells. */
export const TERMINAL_GEOMETRY_OPTIONS = {
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  fontSize: 13,
  // A fit reserves the scrollbar's width only while scrollback is enabled.
  scrollback: 5000,
} as const;

/**
 * The element an xterm opens into, filling its pane host. xterm renders the
 * terminal's text as DOM inside it, so it is blocked from session replay from
 * creation, before it is attached anywhere.
 */
export function createTerminalHostContainer(doc: Document): HTMLDivElement {
  const container = doc.createElement('div');
  container.className = `${REPLAY_BLOCK_CLASS} canopy-terminal-host h-full w-full`;
  container.style.height = '100%';
  container.style.width = '100%';
  return container;
}
