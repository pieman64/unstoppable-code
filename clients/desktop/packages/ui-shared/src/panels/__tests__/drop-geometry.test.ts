import {
  computeDropTarget,
  EDGE_THRESHOLD_FACTOR,
  GROUP_PREFERRED_AXIS_EDGE_THRESHOLD_FACTOR,
  SPLIT_THRESHOLD_DIVISOR,
} from '../drop-geometry';
import type { DropOverlayBox, DropTargetBounds } from '../drop-geometry';

const BOUNDS: DropTargetBounds = { width: 300, height: 300 };

const FULL_BOX: DropOverlayBox = { top: 0, left: 0, width: 1, height: 1 };
const UP_BOX: DropOverlayBox = { top: 0, left: 0, width: 1, height: 0.5 };
const DOWN_BOX: DropOverlayBox = { top: 0.5, left: 0, width: 1, height: 0.5 };
const LEFT_BOX: DropOverlayBox = { top: 0, left: 0, width: 0.5, height: 1 };
const RIGHT_BOX: DropOverlayBox = { top: 0, left: 0.5, width: 0.5, height: 1 };

describe('computeDropTarget', () => {
  it('exports the upstream threshold constants', () => {
    expect(EDGE_THRESHOLD_FACTOR).toBe(0.1);
    expect(GROUP_PREFERRED_AXIS_EDGE_THRESHOLD_FACTOR).toBe(0.3);
    expect(SPLIT_THRESHOLD_DIVISOR).toBe(3);
  });

  it('classifies the dead center as a merge with a full-size overlay', () => {
    const result = computeDropTarget(BOUNDS, { x: 150, y: 150 });
    expect(result.direction).toBe('center');
    expect(result.overlayBox).toEqual(FULL_BOX);
  });

  describe('edge thresholds (default: dragging editors, prefer vertical split)', () => {
    // Edge threshold is 10% of 300 = 30.
    it('left edge → left with a left-half overlay', () => {
      const result = computeDropTarget(BOUNDS, { x: 10, y: 150 });
      expect(result.direction).toBe('left');
      expect(result.overlayBox).toEqual(LEFT_BOX);
    });

    it('right edge → right with a right-half overlay', () => {
      const result = computeDropTarget(BOUNDS, { x: 290, y: 150 });
      expect(result.direction).toBe('right');
      expect(result.overlayBox).toEqual(RIGHT_BOX);
    });

    it('top edge → up with a top-half overlay', () => {
      const result = computeDropTarget(BOUNDS, { x: 150, y: 10 });
      expect(result.direction).toBe('up');
      expect(result.overlayBox).toEqual(UP_BOX);
    });

    it('bottom edge → down with a bottom-half overlay', () => {
      const result = computeDropTarget(BOUNDS, { x: 150, y: 290 });
      expect(result.direction).toBe('down');
      expect(result.overlayBox).toEqual(DOWN_BOX);
    });

    it('just inside the edge threshold is still a merge', () => {
      expect(computeDropTarget(BOUNDS, { x: 31, y: 31 }).direction).toBe(
        'center',
      );
      expect(computeDropTarget(BOUNDS, { x: 269, y: 269 }).direction).toBe(
        'center',
      );
    });
  });

  describe('boundary values exactly at thresholds', () => {
    it('exactly at the edge threshold is a split (center requires strict inequality)', () => {
      // x === edgeWidthThreshold (30) fails `mousePosX > edgeWidthThreshold`.
      expect(computeDropTarget(BOUNDS, { x: 30, y: 150 }).direction).toBe(
        'left',
      );
      expect(computeDropTarget(BOUNDS, { x: 270, y: 150 }).direction).toBe(
        'right',
      );
      expect(computeDropTarget(BOUNDS, { x: 150, y: 30 }).direction).toBe('up');
      expect(computeDropTarget(BOUNDS, { x: 150, y: 270 }).direction).toBe(
        'down',
      );
    });

    it('exactly at the 33% split threshold falls through to the middle band (prefer vertical)', () => {
      // splitWidthThreshold = 100; x === 100 is not < 100 and x === 200 is
      // not > 200, so both fall to the up/down middle column.
      expect(computeDropTarget(BOUNDS, { x: 100, y: 10 }).direction).toBe('up');
      expect(computeDropTarget(BOUNDS, { x: 200, y: 10 }).direction).toBe('up');
    });

    it('middle column resolves up strictly below the midpoint and down at or past it', () => {
      // y === height / 2 (150) is unreachable in the middle column (it would
      // be inside the center merge zone), so probe both sides of the strict
      // `mousePosY < editorControlHeight / 2` comparison at the edge strips.
      expect(computeDropTarget(BOUNDS, { x: 150, y: 30 }).direction).toBe('up');
      expect(computeDropTarget(BOUNDS, { x: 150, y: 270 }).direction).toBe(
        'down',
      );
      expect(computeDropTarget(BOUNDS, { x: 150, y: 299 }).direction).toBe(
        'down',
      );
    });
  });

  describe('preferSplitVertically: true (default) — full-height side columns', () => {
    it('the 0–33% x band is left even in the top edge strip', () => {
      expect(computeDropTarget(BOUNDS, { x: 50, y: 5 }).direction).toBe('left');
    });

    it('the 66–100% x band is right even in the bottom edge strip', () => {
      expect(computeDropTarget(BOUNDS, { x: 250, y: 295 }).direction).toBe(
        'right',
      );
    });

    it('the middle column splits up/down at the vertical midpoint', () => {
      expect(computeDropTarget(BOUNDS, { x: 150, y: 5 }).direction).toBe('up');
      expect(computeDropTarget(BOUNDS, { x: 150, y: 295 }).direction).toBe(
        'down',
      );
    });
  });

  describe('preferSplitVertically: false — full-width top/bottom bands', () => {
    const options = { preferSplitVertically: false };

    it('the 0–33% y band is up even at the left edge strip', () => {
      expect(
        computeDropTarget(BOUNDS, { x: 5, y: 50 }, options).direction,
      ).toBe('up');
    });

    it('the 66–100% y band is down even at the right edge strip', () => {
      expect(
        computeDropTarget(BOUNDS, { x: 295, y: 250 }, options).direction,
      ).toBe('down');
    });

    it('the middle band splits left/right at the horizontal midpoint', () => {
      expect(
        computeDropTarget(BOUNDS, { x: 5, y: 150 }, options).direction,
      ).toBe('left');
      expect(
        computeDropTarget(BOUNDS, { x: 295, y: 150 }, options).direction,
      ).toBe('right');
    });
  });

  describe('isDraggingGroup widens the preferred-axis edge threshold to 30%', () => {
    it('prefer vertical: x within 30% of the width is a split for groups but a merge for editors', () => {
      // Width edge threshold becomes 300 * 0.3 = 90; height stays at 30.
      const pointer = { x: 80, y: 150 };
      expect(computeDropTarget(BOUNDS, pointer).direction).toBe('center');
      expect(
        computeDropTarget(BOUNDS, pointer, { isDraggingGroup: true }).direction,
      ).toBe('left');
    });

    it('prefer horizontal: y within 30% of the height is a split for groups but a merge for editors', () => {
      const pointer = { x: 150, y: 80 };
      const horizontal = { preferSplitVertically: false };
      expect(computeDropTarget(BOUNDS, pointer, horizontal).direction).toBe(
        'center',
      );
      expect(
        computeDropTarget(BOUNDS, pointer, {
          ...horizontal,
          isDraggingGroup: true,
        }).direction,
      ).toBe('up');
    });
  });

  describe('enableSplitting: false collapses the edge thresholds to 0', () => {
    it('any strictly interior pointer merges', () => {
      const options = { enableSplitting: false };
      expect(computeDropTarget(BOUNDS, { x: 1, y: 1 }, options).direction).toBe(
        'center',
      );
      expect(
        computeDropTarget(BOUNDS, { x: 299, y: 299 }, options).direction,
      ).toBe('center');
      expect(
        computeDropTarget(BOUNDS, { x: 1, y: 1 }, options).overlayBox,
      ).toEqual(FULL_BOX);
    });
  });

  describe('degenerate bounds', () => {
    it('zero-size bounds never produce NaN', () => {
      const result = computeDropTarget({ width: 0, height: 0 }, { x: 0, y: 0 });
      expect(['up', 'down', 'left', 'right', 'center']).toContain(
        result.direction,
      );
      for (const value of Object.values(result.overlayBox)) {
        expect(Number.isFinite(value)).toBe(true);
      }
    });

    it('tiny bounds classify without NaN', () => {
      const result = computeDropTarget(
        { width: 1, height: 1 },
        { x: 0.5, y: 0.5 },
      );
      expect(result.direction).toBe('center');
      for (const value of Object.values(result.overlayBox)) {
        expect(Number.isFinite(value)).toBe(true);
      }
    });
  });
});
