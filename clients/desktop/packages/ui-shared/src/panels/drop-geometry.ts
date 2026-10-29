/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from VS Code OSS:
// src/vs/workbench/browser/parts/editor/editorDropTarget.ts
// (DropOverlay.positionOverlay / doPositionOverlay geometry only — no DOM).
// Upstream commit c4632cac (2026-06-30).

/**
 * The five drop targets of the editor-group drop overlay. VS Code models this
 * as `GroupDirection (UP/DOWN/LEFT/RIGHT) | undefined` where `undefined` means
 * "merge into the group"; here the merge case is the explicit `'center'`
 * member so results are self-describing.
 */
export type DropDirection = 'up' | 'down' | 'left' | 'right' | 'center';

/**
 * Edge threshold factor used when dragging editors, and when dragging groups
 * along the non-preferred split axis (10% of the control's dimension).
 * Upstream: `editorDropTarget.ts` `positionOverlay` (`0.1` literals).
 */
export const EDGE_THRESHOLD_FACTOR = 0.1;

/**
 * Larger edge threshold factor used when dragging a whole group along the
 * preferred split axis (30% of the control's dimension). Upstream:
 * `editorDropTarget.ts` `positionOverlay` (`0.3` literals).
 */
export const GROUP_PREFERRED_AXIS_EDGE_THRESHOLD_FACTOR = 0.3;

/**
 * Once a split has been decided, the 33%/66% lines that pick which edge:
 * `splitWidthThreshold = width / 3`, `splitHeightThreshold = height / 3`.
 * Upstream: `editorDropTarget.ts` `positionOverlay`.
 */
export const SPLIT_THRESHOLD_DIVISOR = 3;

/** Size of the drop-target control (the editor group's content area). */
export interface DropTargetBounds {
  readonly width: number;
  readonly height: number;
}

/** Pointer position relative to the top-left of the drop-target control. */
export interface DropTargetPointer {
  readonly x: number;
  readonly y: number;
}

export interface ComputeDropTargetOptions {
  /**
   * Whether a whole group (vs. individual editors/tabs) is being dragged.
   * Groups get a larger edge threshold along the preferred split axis.
   * Defaults to `false`.
   */
  readonly isDraggingGroup?: boolean;
  /**
   * When `false`, the edge thresholds collapse to 0 so the center merge zone
   * covers the entire control (only merging is offered). Mirrors VS Code's
   * `splitOnDragAndDrop` part option. Defaults to `true`.
   */
  readonly enableSplitting?: boolean;
  /**
   * Which orientation gets the larger, full-height/full-width side hit zones.
   * Mirrors `openSideBySideDirection === 'right'`, which is VS Code's
   * default, so this defaults to `true`.
   */
  readonly preferSplitVertically?: boolean;
}

/**
 * The overlay rectangle to render for a drop target, expressed as fractions
 * (0–1) of the control's bounds. Multiply by 100 for CSS percentage values —
 * VS Code renders these exact rectangles as `'0'`/`'50%'`/`'100%'` styles.
 */
export interface DropOverlayBox {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface DropTargetResult {
  readonly direction: DropDirection;
  readonly overlayBox: DropOverlayBox;
}

const OVERLAY_BOXES: Readonly<Record<DropDirection, DropOverlayBox>> = {
  up: { top: 0, left: 0, width: 1, height: 0.5 },
  down: { top: 0.5, left: 0, width: 1, height: 0.5 },
  left: { top: 0, left: 0, width: 0.5, height: 1 },
  right: { top: 0, left: 0.5, width: 0.5, height: 1 },
  center: { top: 0, left: 0, width: 1, height: 1 },
};

/**
 * Pure port of `DropOverlay.positionOverlay`'s hit-zone math: classifies a
 * pointer position over a drop-target control into one of the five drop
 * targets and returns the proportional overlay rectangle VS Code renders for
 * that target.
 *
 * The center merge zone is everything strictly inside
 * `[edgeWidthThreshold, width - edgeWidthThreshold] ×
 * [edgeHeightThreshold, height - edgeHeightThreshold]`. Outside it, the
 * 33%/66% split thresholds pick the edge, with the preferred orientation
 * getting the larger hit zones:
 *
 * `preferSplitVertically` (default):
 * ```
 * ----------------------------------------------
 * |        |       SPLIT UP        |           |
 * | SPLIT  |-----------------------|   SPLIT   |
 * |        |         MERGE         |           |
 * | LEFT   |-----------------------|   RIGHT   |
 * |        |       SPLIT DOWN      |           |
 * ----------------------------------------------
 * ```
 *
 * `preferSplitVertically: false`:
 * ```
 * ----------------------------------------------
 * |               SPLIT UP                     |
 * |--------------------------------------------|
 * |  SPLIT LEFT  |    MERGE   |  SPLIT RIGHT   |
 * |--------------------------------------------|
 * |               SPLIT DOWN                   |
 * ----------------------------------------------
 * ```
 */
export function computeDropTarget(
  bounds: DropTargetBounds,
  pointer: DropTargetPointer,
  options?: ComputeDropTargetOptions,
): DropTargetResult {
  const isDraggingGroup = options?.isDraggingGroup ?? false;
  const enableSplitting = options?.enableSplitting ?? true;
  const preferSplitVertically = options?.preferSplitVertically ?? true;

  const editorControlWidth = bounds.width;
  const editorControlHeight = bounds.height;
  const mousePosX = pointer.x;
  const mousePosY = pointer.y;

  let edgeWidthThresholdFactor: number;
  let edgeHeightThresholdFactor: number;
  if (enableSplitting) {
    if (isDraggingGroup) {
      // give larger threshold when dragging group depending on preferred split direction
      edgeWidthThresholdFactor = preferSplitVertically
        ? GROUP_PREFERRED_AXIS_EDGE_THRESHOLD_FACTOR
        : EDGE_THRESHOLD_FACTOR;
    } else {
      edgeWidthThresholdFactor = EDGE_THRESHOLD_FACTOR; // 10% threshold to split if dragging editors
    }

    if (isDraggingGroup) {
      // give larger threshold when dragging group depending on preferred split direction
      edgeHeightThresholdFactor = preferSplitVertically
        ? EDGE_THRESHOLD_FACTOR
        : GROUP_PREFERRED_AXIS_EDGE_THRESHOLD_FACTOR;
    } else {
      edgeHeightThresholdFactor = EDGE_THRESHOLD_FACTOR; // 10% threshold to split if dragging editors
    }
  } else {
    edgeWidthThresholdFactor = 0;
    edgeHeightThresholdFactor = 0;
  }

  const edgeWidthThreshold = editorControlWidth * edgeWidthThresholdFactor;
  const edgeHeightThreshold = editorControlHeight * edgeHeightThresholdFactor;

  const splitWidthThreshold = editorControlWidth / SPLIT_THRESHOLD_DIVISOR; // offer to split left/right at 33%
  const splitHeightThreshold = editorControlHeight / SPLIT_THRESHOLD_DIVISOR; // offer to split up/down at 33%

  // No split if mouse is above certain threshold in the center of the view
  let direction: DropDirection;
  if (
    mousePosX > edgeWidthThreshold &&
    mousePosX < editorControlWidth - edgeWidthThreshold &&
    mousePosY > edgeHeightThreshold &&
    mousePosY < editorControlHeight - edgeHeightThreshold
  ) {
    direction = 'center';
  }

  // Offer to split otherwise
  else {
    // User prefers to split vertically: offer a larger hitzone
    // for this direction like so:
    // ----------------------------------------------
    // |        |       SPLIT UP        |           |
    // | SPLIT  |-----------------------|   SPLIT   |
    // |        |         MERGE         |           |
    // | LEFT   |-----------------------|   RIGHT   |
    // |        |       SPLIT DOWN      |           |
    // ----------------------------------------------
    if (preferSplitVertically) {
      if (mousePosX < splitWidthThreshold) {
        direction = 'left';
      } else if (mousePosX > splitWidthThreshold * 2) {
        direction = 'right';
      } else if (mousePosY < editorControlHeight / 2) {
        direction = 'up';
      } else {
        direction = 'down';
      }
    }

    // User prefers to split horizontally: offer a larger hitzone
    // for this direction like so:
    // ----------------------------------------------
    // |               SPLIT UP                     |
    // |--------------------------------------------|
    // |  SPLIT LEFT  |    MERGE   |  SPLIT RIGHT   |
    // |--------------------------------------------|
    // |               SPLIT DOWN                   |
    // ----------------------------------------------
    else {
      if (mousePosY < splitHeightThreshold) {
        direction = 'up';
      } else if (mousePosY > splitHeightThreshold * 2) {
        direction = 'down';
      } else if (mousePosX < editorControlWidth / 2) {
        direction = 'left';
      } else {
        direction = 'right';
      }
    }
  }

  return { direction, overlayBox: OVERLAY_BOXES[direction] };
}
