'use client';

import type { JSX, ReactNode } from 'react';
import {
  LOADING_PLACEHOLDER_DELAY_MS,
  useDelayedFlag,
} from '../lib/useDelayedFlag';

export interface DelayedLoadingPlaceholderProps {
  /** The placeholder: a settings skeleton or `CenteredLoadingSpinner`. */
  readonly children: ReactNode;
  readonly delayMs?: number;
  /** Size or placement of the reserved box. */
  readonly className?: string;
}

/**
 * Holds a loading placeholder's space from the first render and shows it only
 * once the delay passes, so content that arrives quickly never flashes a
 * skeleton and never shifts the layout. Unmounting it (content arrived)
 * cancels the timer. The placeholder appears in one step, with no fade.
 */
export function DelayedLoadingPlaceholder({
  children,
  delayMs = LOADING_PLACEHOLDER_DELAY_MS,
  className = '',
}: DelayedLoadingPlaceholderProps): JSX.Element {
  const visible = useDelayedFlag(true, delayMs);
  return (
    <div
      data-testid="delayed-loading-placeholder"
      data-visible={visible ? 'true' : 'false'}
      className={`flex min-h-full flex-1 flex-col ${visible ? '' : 'invisible'} ${className}`}
    >
      {children}
    </div>
  );
}
