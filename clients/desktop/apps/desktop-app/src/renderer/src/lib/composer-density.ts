import type { ComposerDensity } from '@canopy/ui-rich/editor';

/**
 * Buffer (px) applied around each panel-height boundary so dragging a splitter
 * across a boundary does not flicker between density steps. Mirrors the
 * width-based COMPACT_TOOLBAR_HYSTERESIS_PX pattern in ChatInput.
 */
export const COMPOSER_DENSITY_HYSTERESIS_PX = 24;

// Rank orders the steps shortest (0) to tallest (3).
const DENSITY_RANK: Record<ComposerDensity, number> = {
  minimal: 0,
  compact: 1,
  cozy: 2,
  comfortable: 3,
};

const DENSITY_BY_RANK: readonly ComposerDensity[] = [
  'minimal',
  'compact',
  'cozy',
  'comfortable',
];

// Lowest panel height (px) at which each step's band begins.
//   minimal:     [0, 260)
//   compact:     [260, 360)
//   cozy:        [360, 460)
//   comfortable: [460, +inf)
const DENSITY_MIN_HEIGHT: Record<ComposerDensity, number> = {
  minimal: 0,
  compact: 260,
  cozy: 360,
  comfortable: 460,
};

function bandForHeight(panelHeightPx: number): ComposerDensity {
  if (panelHeightPx >= DENSITY_MIN_HEIGHT.comfortable) return 'comfortable';
  if (panelHeightPx >= DENSITY_MIN_HEIGHT.cozy) return 'cozy';
  if (panelHeightPx >= DENSITY_MIN_HEIGHT.compact) return 'compact';
  return 'minimal';
}

/**
 * Resolve the composer density step for a measured panel height. Returns
 * `comfortable` when the height is unmeasured (null / <= 0). Applies hysteresis
 * relative to the current step so transitions only occur once the height has
 * cleared the crossed boundary by COMPOSER_DENSITY_HYSTERESIS_PX.
 */
export function resolveComposerDensity(
  panelHeightPx: number | null,
  current: ComposerDensity,
): ComposerDensity {
  if (panelHeightPx === null || panelHeightPx <= 0) {
    return 'comfortable';
  }
  const raw = bandForHeight(panelHeightPx);
  if (raw === current) {
    return current;
  }
  if (DENSITY_RANK[raw] > DENSITY_RANK[current]) {
    // Growing: require the height to clear the next crossed boundary by the buffer.
    const next = DENSITY_BY_RANK[DENSITY_RANK[current] + 1];
    return panelHeightPx >=
      DENSITY_MIN_HEIGHT[next] + COMPOSER_DENSITY_HYSTERESIS_PX
      ? raw
      : current;
  }
  // Shrinking: require the height to drop below the current band's floor by the buffer.
  return panelHeightPx <
    DENSITY_MIN_HEIGHT[current] - COMPOSER_DENSITY_HYSTERESIS_PX
    ? raw
    : current;
}

/**
 * Find the element whose height drives the composer density: the composer
 * root's nearest ancestor that generates a box. `display: contents` wrappers
 * (e.g. ChatContent's cancel-shortcut root) have no box, so they measure 0px
 * and never fire ResizeObserver; skip past them to the real panel.
 * Callers resolve this once per effect run, so it assumes the ancestors'
 * `display` stays fixed for the composer's lifetime.
 */
export function findComposerDensityPanel(
  node: HTMLElement | null,
): HTMLElement | null {
  let panel = node?.parentElement ?? null;
  while (
    panel &&
    panel.ownerDocument.defaultView?.getComputedStyle(panel).display ===
      'contents'
  ) {
    panel = panel.parentElement;
  }
  return panel;
}
