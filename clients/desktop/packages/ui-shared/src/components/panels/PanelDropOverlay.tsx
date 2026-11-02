import { memo, useRef, type JSX, type NamedExoticComponent } from 'react';
import { useFlipBox } from '../../lib/flip-box';
import type { DropDirection, DropOverlayBox } from '../../panels/drop-geometry';

/**
 * The five always-positioned drop hit-zone edges. `top|bottom|left|right`
 * map to the split directions `up|down|left|right`; `center` is the merge
 * zone. Matches the protocol `PanelDropEdge` vocabulary used by
 * `PanelIntentCallbacks.onMovePanel`.
 */
export const PANEL_DROP_ZONE_EDGES = [
  'top',
  'bottom',
  'left',
  'right',
  'center',
] as const;

export type PanelDropZoneEdge = (typeof PANEL_DROP_ZONE_EDGES)[number];

export interface PanelDropOverlayProps {
  /** The group this overlay gives drop feedback for. */
  groupId: string;
  /**
   * The computed drop direction (from `computeDropTarget`), or `null` when
   * the pointer has not produced a classification yet.
   */
  direction: DropDirection | null;
  /**
   * The proportional overlay rectangle (fractions 0–1 of the group body,
   * from `computeDropTarget`), or `null` to render no highlight box.
   */
  overlayBox: DropOverlayBox | null;
  /** Whether the overlay renders at all (a drag is over this group). */
  visible: boolean;
  /**
   * Whether to also render the five static per-edge hit-zone elements
   * (`panel-drop-zone-${groupId}-${edge}`). Off by default; the DnD wiring
   * (Phase 6) opts in while a drag is in flight so synthetic-drop tests have
   * stable, addressable targets. The zones mirror `computeDropTarget`'s
   * default geometry: 10% edge strips (EDGE_THRESHOLD_FACTOR) around a
   * center merge region, so dispatching at any zone's center classifies to
   * that zone's direction.
   * @defaultValue false
   */
  showZones?: boolean;
}

function toPercent(fraction: number): string {
  return `${fraction * 100}%`;
}

/** The highlight's move between zones: a compositor translate and stretch. */
const BOX_MOVE = { durationMs: 100, easing: 'ease-out' } as const;

/**
 * Controlled, display-only drop feedback for ONE panel group: the moving
 * highlight box VS Code's `DropOverlay.positionOverlay` renders, plus
 * (optionally) five static hit zones. The caller owns all pointer math —
 * feed it `computeDropTarget(bounds, pointer)` results; this component never
 * listens to drag events itself.
 *
 * Render it inside the group's body (`.canopy-panel-group-body`, which is
 * `position: relative`); the overlay fills that box and is transparent to
 * pointer events.
 */
function PanelDropOverlayComponent({
  groupId,
  direction,
  overlayBox,
  visible,
  showZones,
}: PanelDropOverlayProps): JSX.Element | null {
  const boxRef = useRef<HTMLDivElement>(null);
  useFlipBox(boxRef, BOX_MOVE);
  if (!visible) {
    return null;
  }

  return (
    <div
      className="canopy-panel-drop-overlay"
      data-testid={`panel-drop-overlay-${groupId}`}
      data-direction={direction ?? undefined}
      aria-hidden="true"
    >
      {(showZones ?? false)
        ? PANEL_DROP_ZONE_EDGES.map((edge) => (
            <div
              key={edge}
              className={`canopy-panel-drop-zone canopy-panel-drop-zone-${edge}`}
              data-testid={`panel-drop-zone-${groupId}-${edge}`}
              data-edge={edge}
            />
          ))
        : null}
      {direction !== null && overlayBox !== null ? (
        <div
          ref={boxRef}
          className="canopy-panel-drop-overlay-box"
          style={{
            top: toPercent(overlayBox.top),
            left: toPercent(overlayBox.left),
            width: toPercent(overlayBox.width),
            height: toPercent(overlayBox.height),
          }}
        />
      ) : null}
    </div>
  );
}

export const PanelDropOverlay: NamedExoticComponent<PanelDropOverlayProps> =
  memo(PanelDropOverlayComponent);
