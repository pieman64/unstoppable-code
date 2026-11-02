import { useEffect, useState, type JSX, type MouseEvent } from 'react';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '@/stores/sidebarStore';

export interface SidebarResizeHandleProps {
  /** Latest raw candidate width (px), at most once per drag frame plus release. */
  onResize: (widthPx: number) => void;
  /** Current sidebar width (px), reflected via `aria-valuenow`. */
  width: number;
  minWidth?: number;
  maxWidth?: number;
  /** Stable selector for hosts that render more than one sidebar surface. */
  testId?: string;
  /**
   * Called with `true` when a drag starts and `false` when it ends. Lets
   * `AppSidebar` disable the width transition while dragging so the sidebar
   * edge tracks the pointer instead of rubber-banding behind it.
   */
  onDragStateChange?: (dragging: boolean) => void;
}

/**
 * Right-edge drag handle for the sidebar. The sidebar is left-anchored, so
 * `event.clientX` approximates the candidate width directly. The raw value
 * is passed straight to `onResize` — `useSidebarStore`'s `setWidth` action is
 * the single clamp, so there is no local clamping here.
 */
export function SidebarResizeHandle({
  onResize,
  width,
  minWidth = SIDEBAR_MIN_WIDTH,
  maxWidth = SIDEBAR_MAX_WIDTH,
  testId = 'sidebar-resize-handle',
  onDragStateChange,
}: SidebarResizeHandleProps): JSX.Element {
  const [isResizing, setIsResizing] = useState(false);

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setIsResizing(true);
    onDragStateChange?.(true);
    onResize(event.clientX);
  };

  useEffect(() => {
    if (!isResizing) {
      return;
    }

    let frame: number | null = null;
    let pendingWidth: number | null = null;
    const cancelFrame = (): void => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
    };
    const flush = (): void => {
      frame = null;
      if (pendingWidth === null) return;
      const nextWidth = pendingWidth;
      pendingWidth = null;
      onResize(nextWidth);
    };
    const handleMouseMove = (event: globalThis.MouseEvent): void => {
      pendingWidth = event.clientX;
      if (frame === null) frame = window.requestAnimationFrame(flush);
    };
    const finish = (): void => {
      cancelFrame();
      flush();
      setIsResizing(false);
      onDragStateChange?.(false);
    };
    const handleMouseUp = (event: globalThis.MouseEvent): void => {
      pendingWidth = event.clientX;
      finish();
    };

    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('blur', finish);

    return (): void => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('blur', finish);
      cancelFrame();
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
    };
  }, [isResizing, onResize, onDragStateChange]);

  return (
    <div
      className="sidebar-resize-handle absolute inset-y-0 -right-1 z-10 w-2 shrink-0 cursor-col-resize"
      onMouseDown={handleMouseDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      data-testid={testId}
      data-resizing={isResizing ? 'true' : undefined}
    />
  );
}
