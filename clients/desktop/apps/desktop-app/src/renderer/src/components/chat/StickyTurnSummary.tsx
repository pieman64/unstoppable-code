import { useCallback, type JSX, type ReactNode } from 'react';
import {
  applyStickyUserHeight,
  STICKY_USER_HEIGHT_ATTRIBUTE,
  STICKY_USER_HEIGHT_PROPERTY,
} from './sticky-user-height';

const STICKY_SECTION_SELECTOR = '[data-chat-sticky-section]';

/**
 * A completed turn's summary chip, pinned below its section's sticky user
 * message. The containing block is the turn's own wrapper, so the chip
 * unsticks at the turn's end and the next turn's chip takes the slot.
 */
export function StickyTurnSummary({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  // A chip that mounts after its header was measured (a turn expanded or
  // completed later) picks up the height already published for its section.
  const syncPublishedHeight = useCallback((chip: HTMLDivElement | null) => {
    if (!chip) return;
    const section = chip.closest<HTMLElement>(STICKY_SECTION_SELECTOR);
    const height = section?.getAttribute(STICKY_USER_HEIGHT_ATTRIBUTE);
    if (height) applyStickyUserHeight(chip, height);
  }, []);
  return (
    <div
      ref={syncPublishedHeight}
      className="sticky z-10"
      // `+ 0.5rem` preserves the same inter-item gap the chip has in normal
      // flow (`space-y-2`) when it pins below the header.
      style={{
        top: `calc(var(${STICKY_USER_HEIGHT_PROPERTY}, 0px) + 0.5rem)`,
      }}
      data-testid="sticky-turn-summary"
    >
      {children}
    </div>
  );
}
