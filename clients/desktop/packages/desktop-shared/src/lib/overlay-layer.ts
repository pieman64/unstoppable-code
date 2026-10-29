import type { OverlayLayerSlot } from '../types/overlay-layer';

/** Frame-name prefix of the `about:blank` popups that back overlay layers. */
export const OVERLAY_LAYER_FRAME_PREFIX = 'canopy-overlay-layer:';

export const OVERLAY_LAYER_SLOTS: readonly OverlayLayerSlot[] = [
  'notifications',
];

export function isOverlayLayerSlot(value: unknown): value is OverlayLayerSlot {
  return OVERLAY_LAYER_SLOTS.some((slot) => slot === value);
}

/**
 * The popup frame name for one opening of a slot. The nonce keeps a reloaded
 * page from targeting a stale named window.
 */
export function overlayLayerFrameName(
  slot: OverlayLayerSlot,
  nonce: string,
): string {
  return `${OVERLAY_LAYER_FRAME_PREFIX}${slot}:${nonce}`;
}

/** The slot a popup frame name opens, or `null` for any other frame name. */
export function parseOverlayLayerFrameName(
  frameName: string,
): OverlayLayerSlot | null {
  if (!frameName.startsWith(OVERLAY_LAYER_FRAME_PREFIX)) return null;
  const [slot, nonce, ...rest] = frameName
    .slice(OVERLAY_LAYER_FRAME_PREFIX.length)
    .split(':');
  if (rest.length > 0 || !nonce) return null;
  return isOverlayLayerSlot(slot) ? slot : null;
}
