export const MIN_TERMINAL_RESIZE_WIDTH_PX = 160;
export const MIN_TERMINAL_RESIZE_HEIGHT_PX = 72;
export const MIN_TERMINAL_RESIZE_COLS = 20;
export const MIN_TERMINAL_RESIZE_ROWS = 4;

export interface TerminalResizeCandidate {
  hostWidthPx: number;
  hostHeightPx: number;
  cols: number;
  rows: number;
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function isUsableTerminalResizeCandidate(
  candidate: TerminalResizeCandidate,
): boolean {
  return (
    isFinitePositive(candidate.hostWidthPx) &&
    isFinitePositive(candidate.hostHeightPx) &&
    Number.isInteger(candidate.cols) &&
    Number.isInteger(candidate.rows) &&
    candidate.hostWidthPx >= MIN_TERMINAL_RESIZE_WIDTH_PX &&
    candidate.hostHeightPx >= MIN_TERMINAL_RESIZE_HEIGHT_PX &&
    candidate.cols >= MIN_TERMINAL_RESIZE_COLS &&
    candidate.rows >= MIN_TERMINAL_RESIZE_ROWS
  );
}

/** A source of proposed sizes, such as xterm's FitAddon. */
export interface TerminalFitProposer {
  proposeDimensions(): { cols: number; rows: number } | undefined;
}

/** The part of a pane host the guard reads. */
export interface TerminalFitHost {
  readonly isConnected: boolean;
  getBoundingClientRect(): { width: number; height: number };
}

/**
 * The fit's proposed size for `host`, or null when the host is missing,
 * detached, hidden or too small, the proposal is missing or not a usable size,
 * or the fit throws (for example before xterm has opened).
 */
export function proposeUsableTerminalSize(
  fit: TerminalFitProposer,
  host: TerminalFitHost | null | undefined,
): { cols: number; rows: number } | null {
  if (!host?.isConnected) return null;
  let proposed: { cols: number; rows: number } | undefined;
  try {
    proposed = fit.proposeDimensions();
  } catch {
    return null;
  }
  if (proposed === undefined) return null;
  const rect = host.getBoundingClientRect();
  if (
    !isUsableTerminalResizeCandidate({
      hostWidthPx: rect.width,
      hostHeightPx: rect.height,
      cols: proposed.cols,
      rows: proposed.rows,
    })
  )
    return null;
  return { cols: proposed.cols, rows: proposed.rows };
}
