'use client';

import type { JSX } from 'react';
import { Notice, NoticeButton } from './Notice';
import { TRY_AGAIN_LABEL, TRYING_AGAIN_LABEL } from './useRetry';

export interface BackgroundServiceNoticeProps {
  /** The latest Try again: `failed` once one ended without reaching it. */
  readonly retry: 'idle' | 'running' | 'failed';
  readonly onRetry: () => void;
}

/**
 * The local background service can't be reached (CAN-5541). Static copy only:
 * no path, error message or authority id, so replay and autocapture stay
 * safe. Pure display; the host decides when it shows.
 */
export function BackgroundServiceNotice({
  retry,
  onRetry,
}: BackgroundServiceNoticeProps): JSX.Element {
  const running = retry === 'running';
  return (
    <Notice
      intent="attention"
      title={
        retry === 'failed'
          ? "Still couldn't reach the background service"
          : "Couldn't reach the background service"
      }
      className="pointer-events-auto"
      data-testid="background-service-notice"
      actions={
        <NoticeButton
          busy={running}
          busyLabel={TRYING_AGAIN_LABEL}
          onClick={onRetry}
          data-testid="background-service-notice-retry"
        >
          {TRY_AGAIN_LABEL}
        </NoticeButton>
      }
    >
      {retry === 'failed'
        ? 'Files and folders may not load. Try again in a moment.'
        : 'Files and folders may not load.'}
    </Notice>
  );
}
