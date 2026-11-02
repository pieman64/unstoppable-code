'use client';

import type { JSX, ReactNode } from 'react';

export interface SlowLoadNoteProps {
  /** What is still on its way, as one sentence: "Still loading workflows…". */
  readonly children: ReactNode;
  /** The load has run past `SLOW_LOAD_NOTE_DELAY_MS`. */
  readonly show: boolean;
  /** Placement only: margin and alignment. */
  readonly className?: string;
}

/**
 * One quiet line that says what is slow, for a load that has run long. The
 * live region stays mounted while the load runs and fills in when `show`
 * turns true, so assistive technology announces the line once; while it is
 * empty it takes no space. It never carries a spinner: the skeleton already
 * says "loading".
 */
export function SlowLoadNote({
  children,
  show,
  className = '',
}: SlowLoadNoteProps): JSX.Element {
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="slow-load-note"
      data-visible={show ? 'true' : 'false'}
      className={`text-pretty text-xs fg-tertiary ${className}`}
    >
      {show ? children : null}
    </p>
  );
}
