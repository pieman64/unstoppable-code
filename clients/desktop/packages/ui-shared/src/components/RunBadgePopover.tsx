import { useLayoutEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import {
  getInitialBadgePopoverPosition,
  getMeasuredBadgePopoverPosition,
} from './ChatPreviewPopover';

export interface RunBadgeRow {
  id: string;
  label: string;
  /** Status text rendered on the right of the row. */
  statusText: string;
  /** Tailwind text-* class applied to `statusText`. */
  statusClass: string;
  /** Tailwind bg-* class applied to the leading dot. */
  dotClass: string;
}

export interface RunBadgePopoverProps {
  anchorRect: DOMRect;
  rows: RunBadgeRow[];
  heading: string;
  emptyText: string;
}

/**
 * Shared popover body for the script (rocket) and hook badges. Both list the
 * currently-active runs for a worktree with a label, a colored dot, and a
 * status word, so they reuse one component differentiated only by `heading`
 * and the empty-state copy.
 */
export function RunBadgePopover({
  anchorRect,
  rows,
  heading,
  emptyText,
}: RunBadgePopoverProps): JSX.Element {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>(
    getInitialBadgePopoverPosition(anchorRect),
  );

  useLayoutEffect((): void => {
    const el = popoverRef.current;
    if (!el) return;
    setPosition(
      getMeasuredBadgePopoverPosition(
        anchorRect,
        el.offsetHeight,
        el.offsetWidth,
      ),
    );
  }, [anchorRect]);

  return createPortal(
    <div
      ref={popoverRef}
      data-testid="worktree-row-script-popover"
      className="pointer-events-none fixed z-tooltip min-w-40 max-w-65 rounded-lg bg-popover px-3 py-2 shadow-lg"
      style={{ top: position.top, left: position.left }}
    >
      <div className="mb-1 text-3xs font-semibold fg-secondary">{heading}</div>
      {rows.length === 0 ? (
        <div className="text-xs fg-secondary">{emptyText}</div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <div key={row.id} className="flex items-center gap-1.5 text-xs">
              <span
                className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${row.dotClass}`}
              />
              <span className="truncate fg-primary">{row.label}</span>
              <span className={`ml-auto shrink-0 ${row.statusClass}`}>
                {row.statusText}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
