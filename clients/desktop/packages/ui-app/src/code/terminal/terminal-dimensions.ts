// Predict a terminal's cols/rows before its pane exists, so a new PTY starts
// at the size its pane will fit to. A shell draws its first prompt at the
// start size; a later resize only reaches it as SIGWINCH, which can leave that
// prompt wrapped for the wrong width.

import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import {
  createTerminalHostContainer,
  TERMINAL_GEOMETRY_OPTIONS,
} from './terminal-geometry';
import { proposeUsableTerminalSize } from './terminal-resize-guard';

/**
 * The size a terminal pane filling `area` fits to. A hidden xterm with the
 * pane's geometry options opens in a pane-style host over the whole area (which
 * must be a positioned element) and its fit is returned as proposed. Null when
 * the area is hidden or too small, or xterm cannot measure. The probe is
 * disposed either way.
 */
export function measureTerminalDimensions(
  area: HTMLElement,
): { cols: number; rows: number } | null {
  const doc = area.ownerDocument;
  const layer = doc.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  layer.style.position = 'absolute';
  layer.style.inset = '0';
  layer.style.overflow = 'hidden';
  layer.style.visibility = 'hidden';
  layer.style.pointerEvents = 'none';
  const container = createTerminalHostContainer(doc);
  layer.appendChild(container);
  let term: Terminal | undefined;
  try {
    area.appendChild(layer);
    term = new Terminal({ ...TERMINAL_GEOMETRY_OPTIONS });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    return proposeUsableTerminalSize(fit, layer);
  } catch {
    return null;
  } finally {
    term?.dispose();
    layer.remove();
  }
}

const PROBE_SIZE_PX = 400;

let cachedCellSize: { widthPx: number; heightPx: number } | null = null;

// Mount a throwaway xterm off-screen, read the ratio between its fixed probe
// size and the proposed cols/rows to derive per-cell pixel dimensions. Cached
// after the first successful measurement. The ratio includes the fit's
// scrollbar allowance and rounding, so it only estimates; a pane's own size
// comes from `measureTerminalDimensions`.
function measureCellSize(): { widthPx: number; heightPx: number } | null {
  if (cachedCellSize !== null) {
    return cachedCellSize;
  }

  if (typeof document === 'undefined') {
    return null;
  }

  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.left = '-9999px';
  probe.style.top = '0';
  probe.style.width = `${PROBE_SIZE_PX}px`;
  probe.style.height = `${PROBE_SIZE_PX}px`;
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  document.body.appendChild(probe);

  const term = new Terminal({ ...TERMINAL_GEOMETRY_OPTIONS });
  const fit = new FitAddon();
  term.loadAddon(fit);

  try {
    term.open(probe);
    const proposed = fit.proposeDimensions();
    if (proposed && proposed.cols > 0 && proposed.rows > 0) {
      cachedCellSize = {
        widthPx: PROBE_SIZE_PX / proposed.cols,
        heightPx: PROBE_SIZE_PX / proposed.rows,
      };
    }
  } finally {
    term.dispose();
    probe.remove();
  }

  return cachedCellSize;
}

/**
 * Estimates cols/rows for a pixel size that has no pane to measure, such as
 * the desktop composer's terminal drawer.
 */
export function computeColsRowsForPixels(
  widthPx: number,
  heightPx: number,
): { cols: number; rows: number } | null {
  if (widthPx <= 0 || heightPx <= 0) {
    return null;
  }
  const cell = measureCellSize();
  if (cell === null) {
    return null;
  }
  return {
    cols: Math.max(2, Math.floor(widthPx / cell.widthPx)),
    rows: Math.max(1, Math.floor(heightPx / cell.heightPx)),
  };
}
