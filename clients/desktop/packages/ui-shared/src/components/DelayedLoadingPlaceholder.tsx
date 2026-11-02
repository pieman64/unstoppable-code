'use client';

import type { JSX, ReactNode } from 'react';
import {
  LOADING_PLACEHOLDER_DELAY_MS,
  SLOW_LOAD_NOTE_DELAY_MS,
  useDelayedFlag,
} from '../lib/useDelayedFlag';
import { SlowLoadNote } from './SlowLoadNote';

export interface DelayedLoadingPlaceholderProps {
  /** The placeholder: a skeleton in the content's shape, or `CenteredLoadingSpinner`. */
  readonly children: ReactNode;
  readonly delayMs?: number;
  /**
   * What is still loading, said once the load runs past `slowAfterMs`:
   * "Still loading workflows…". It sits below the placeholder, so the
   * placeholder never moves when it appears. Omitted, no note shows.
   */
  readonly slowNote?: ReactNode;
  /** Wait, from mount, before `slowNote` shows. */
  readonly slowAfterMs?: number;
  /** Size or placement of the reserved box. */
  readonly className?: string;
}

/**
 * Holds a loading placeholder's space from the first render and shows it only
 * once the delay passes, so content that arrives quickly never flashes a
 * skeleton and never shifts the layout. Unmounting it (content arrived)
 * cancels the timers. The placeholder appears in one step, with no fade.
 * Given a `slowNote`, a load that runs long also says what is slow.
 */
export function DelayedLoadingPlaceholder({
  children,
  delayMs = LOADING_PLACEHOLDER_DELAY_MS,
  slowNote,
  slowAfterMs = SLOW_LOAD_NOTE_DELAY_MS,
  className = '',
}: DelayedLoadingPlaceholderProps): JSX.Element {
  const visible = useDelayedFlag(true, delayMs);
  // Only a placeholder with a note arms the second clock.
  const slow = useDelayedFlag(slowNote !== undefined, slowAfterMs);
  return (
    <div
      data-testid="delayed-loading-placeholder"
      data-visible={visible ? 'true' : 'false'}
      className={`flex min-h-full flex-1 flex-col ${visible ? '' : 'invisible'} ${className}`}
    >
      {children}
      {slowNote === undefined ? null : (
        <SlowLoadNote show={slow} className="mt-3">
          {slowNote}
        </SlowLoadNote>
      )}
    </div>
  );
}
