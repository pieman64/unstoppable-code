import { useCallback, type JSX } from 'react';
import { ResizeHandle } from '../shared/ResizeHandle';

interface TerminalSplitGutterProps {
  /**
   * Called while the user drags the gutter. `fraction` is the new left-pane
   * fraction of the split, clamped to [0.1, 0.9].
   */
  onDrag: (fraction: number) => void;
  /** Called once when the drag ends. */
  onCommit?: () => void;
  /** DOM element whose horizontal bounds define the split area. */
  containerRef: { current: HTMLElement | null };
  /** Position of this gutter in the split (0-indexed, between panes N and N+1). */
  index: number;
  /** Number of panes in the split. */
  paneCount: number;
}

export function TerminalSplitGutter({
  onDrag,
  onCommit,
  containerRef,
  index,
  paneCount,
}: TerminalSplitGutterProps): JSX.Element {
  const updateFromPointer = useCallback(
    (clientX: number): void => {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const bounds = container.getBoundingClientRect();
      if (bounds.width <= 0) {
        return;
      }
      let fraction = (clientX - bounds.left) / bounds.width;
      if (!Number.isFinite(fraction)) {
        return;
      }
      if (fraction < 0.1) fraction = 0.1;
      if (fraction > 0.9) fraction = 0.9;
      onDrag(fraction);
    },
    [containerRef, onDrag],
  );

  return (
    <ResizeHandle
      orientation="horizontal"
      className="w-1.5 items-stretch"
      onDrag={updateFromPointer}
      onCommit={onCommit}
      ariaLabel={`Resize terminal split ${index + 1} of ${paneCount - 1}`}
    />
  );
}
