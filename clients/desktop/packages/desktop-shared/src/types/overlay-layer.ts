/**
 * Native overlay layers: transparent views the main window raises above its
 * in-app browser views, so app UI can draw over a live page. Each slot is one
 * layer owned by one renderer surface.
 */
export type OverlayLayerSlot = 'notifications';

export interface OverlayLayerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bounds are main-renderer CSS px; `null` hides the layer. */
export interface OverlayLayerSetBoundsRequest {
  slot: OverlayLayerSlot;
  bounds: OverlayLayerRect | null;
}

/** Moves keyboard focus into the slot's layer, or back to the main page. */
export interface OverlayLayerFocusRequest {
  slot: OverlayLayerSlot;
  target: 'layer' | 'main';
}

export interface OverlayLayerApi {
  setBounds(request: OverlayLayerSetBoundsRequest): Promise<void>;
  focus(request: OverlayLayerFocusRequest): Promise<void>;
}
