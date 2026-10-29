import {
  useEffect,
  useRef,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

export const REVIEW_POPOVER_WIDTH = 320;

/**
 * Compute a viewport-fixed position for a review popover from its anchor rect.
 * Mirrors `computePopoverPosition` in `PlanDocumentPanel.tsx`: prefers placing
 * the popover below the anchor, flips above when it would run off the bottom,
 * and clamps to stay on screen.
 */
export function computeReviewPopoverPosition(
  rect: DOMRect,
  estHeight: number,
): { top: number; left: number } {
  const left = Math.min(
    Math.max(rect.left, 8),
    window.innerWidth - REVIEW_POPOVER_WIDTH - 8,
  );
  let top = rect.bottom + 6;
  if (top + estHeight > window.innerHeight - 8) {
    top = Math.max(8, rect.top - estHeight - 6);
  }
  return { top, left };
}

export interface ReviewPopoverShellProps {
  anchorRect: DOMRect;
  /** Estimated height used only for above/below flipping. */
  estHeight?: number;
  /** Classes on the fixed positioned container (visuals/scroll live here). */
  containerClassName?: string;
  onClose: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  dataTestId?: string;
  children: ReactNode;
}

/**
 * The shared floating-popover shell for the diff review popovers: fixed
 * positioned + portaled to `document.body` so it is never clipped by the diff
 * viewer's scroll container, closes on Escape or an outside click, and stops
 * mouse events from bubbling to the diff (which would trigger line selection).
 * Both the single-item `ReviewCommentPopover` and the multi-item
 * `ReviewLinePopover` render through this so their positioning and dismissal
 * behavior stay identical.
 */
export function ReviewPopoverShell({
  anchorRect,
  estHeight = 220,
  containerClassName,
  onClose,
  onMouseEnter,
  onMouseLeave,
  dataTestId,
  children,
}: ReviewPopoverShellProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const { top, left } = computeReviewPopoverPosition(anchorRect, estHeight);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) {
        return;
      }
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target)
      ) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return (): void => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [onClose]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  // Portaled out of the diff viewer's replay block, so it carries its own:
  // review comments, annotations, drafts, and the code they quote.
  return createPortal(
    <div
      ref={containerRef}
      className={`${POSTHOG_REPLAY_BLOCK_CLASS} fixed z-dropdown ${containerClassName ?? ''}`}
      style={{ top, left, width: REVIEW_POPOVER_WIDTH }}
      onMouseDown={(event): void => event.stopPropagation()}
      onMouseUp={(event): void => event.stopPropagation()}
      onClick={(event): void => event.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onKeyDown={handleKeyDown}
      data-testid={dataTestId}
    >
      {children}
    </div>,
    document.body,
  );
}
