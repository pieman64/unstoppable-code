/**
 * Panel-tab drag-and-drop vocabulary shared by the tab bar (drag source +
 * strip drop target) and the group body (edge/center drop target).
 *
 * In-process drag identity travels through the {@link LocalSelectionTransfer}
 * singleton under {@link PanelTabTransferIdentifier} — NEVER through native
 * `dataTransfer` payloads: `dataTransfer.getData()` is unreadable during
 * `dragover` (browser security), while the transfer singleton is readable at
 * any time (doc 07 §3.1/C2). Drop handlers must clear the transfer after
 * handling a drop; `dragend` on the source clears it as the fallback for
 * aborted drags.
 */

import type { DropDirection } from '../../panels/drop-geometry';
import type { PanelDropEdge } from '../../panels/registry-types';
import {
  LocalSelectionTransfer,
  TransferIdentifier,
} from '../../panels/transfer';

/** The in-process identity of a dragged panel tab. */
export interface DraggedPanelTab {
  readonly panelId: string;
  readonly sourceGroupId: string;
}

/**
 * The module-level transfer identifier for panel-tab drags. One identifier
 * per dragged-thing kind (VS Code's `DraggedEditorIdentifier.prototype`
 * analogue); shared by every drag source and drop target in the panel system.
 */
export const PanelTabTransferIdentifier =
  new TransferIdentifier<DraggedPanelTab>('panel-tab');

/** Starts a panel-tab drag: writes the identity into the transfer singleton. */
export function startPanelTabDrag(tab: DraggedPanelTab): void {
  LocalSelectionTransfer.getInstance().setData(
    [tab],
    PanelTabTransferIdentifier,
  );
}

/** Whether a panel-tab drag is currently in flight. Readable during dragover. */
export function hasActivePanelTabDrag(): boolean {
  return LocalSelectionTransfer.getInstance().hasData(
    PanelTabTransferIdentifier,
  );
}

/** The dragged tab's identity, or `null` when no panel-tab drag is active. */
export function readPanelTabDrag(): DraggedPanelTab | null {
  return (
    LocalSelectionTransfer.getInstance().getData(
      PanelTabTransferIdentifier,
    )?.[0] ?? null
  );
}

/** Clears the panel-tab transfer (after a handled drop, or on dragend). */
export function clearPanelTabDrag(): void {
  LocalSelectionTransfer.getInstance().clearData(PanelTabTransferIdentifier);
}

/**
 * Maps a {@link computeDropTarget} classification onto the intent-level
 * {@link PanelDropEdge} vocabulary used by `PanelIntentCallbacks.onMovePanel`
 * (`up`→`top`, `down`→`bottom`; `left`/`right`/`center` pass through).
 */
export function dropDirectionToDropEdge(
  direction: DropDirection,
): PanelDropEdge {
  switch (direction) {
    case 'up':
      return 'top';
    case 'down':
      return 'bottom';
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'center':
      return 'center';
  }
}
