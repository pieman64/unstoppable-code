import type { JSX, ReactNode } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { Popover } from '@canopy/ui-shared/components';

export interface ReviewPopoverShellProps {
  /** The diff line or selection the popover hangs off. */
  anchorRect: DOMRect;
  /** Names the popover for assistive tech. */
  label: string;
  onClose: () => void;
  dataTestId?: string;
  children: ReactNode;
}

/**
 * The shared shell for the diff review popovers: the shared `Popover` at the
 * line or selection, 320px wide and 6px off it, flipping above when there is
 * no room below. It owns focus (in on open, Tab kept inside, back on close),
 * Escape and outside presses; an outside press closes it and still lands, so
 * picking another line takes one press. Presses inside never reach the diff,
 * where they would start a line selection. The cards draw their own sections
 * to the popover's edges. Both the single-item `ReviewCommentPopover` and
 * the multi-item `ReviewLinePopover` render through this so their
 * positioning and dismissal behavior stay identical.
 */
export function ReviewPopoverShell({
  anchorRect,
  label,
  onClose,
  dataTestId,
  children,
}: ReviewPopoverShellProps): JSX.Element {
  return (
    <Popover
      open
      onOpenChange={(next): void => {
        if (!next) onClose();
      }}
      anchorRect={anchorRect}
      ownerDocument={document}
      width="lg"
      gap={6}
      inset="flush"
      containEvents
      outsidePressSwallowsClick={false}
      aria-label={label}
      data-testid={dataTestId}
    >
      {/* Portaled out of the diff viewer's replay block, so it carries its
          own: review comments, annotations, drafts, and the code they
          quote. */}
      <div className={POSTHOG_REPLAY_BLOCK_CLASS}>{children}</div>
    </Popover>
  );
}
