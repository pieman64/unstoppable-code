import { useEffect, useRef, useState, type JSX } from 'react';
import type { SecureStorageFailure } from '@canopy/execution-engine/types/secure-storage';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { getSecureStorageNotice } from '@/lib/secureStorageNotice';

interface SecureStorageNoticeProps {
  failure: SecureStorageFailure | null;
  onRetry?: () => void;
  retrying?: boolean;
}

/**
 * Desktop OS-store adapter; presentation is the shared, browser-safe Notice.
 * Main remembers the credential store's state rather than checking it on
 * every read (CAN-6087). When the notice appears, main re-checks it (throttled)
 * and the caller reloads if it changed; Try again re-checks before the
 * caller's own reload.
 */
export function SecureStorageNotice({
  failure,
  onRetry,
  retrying = false,
}: SecureStorageNoticeProps): JSX.Element | null {
  const [rechecking, setRechecking] = useState(false);
  const notice = getSecureStorageNotice(failure);
  const shown = notice !== null;
  const onRetryRef = useRef(onRetry);
  useEffect(() => {
    onRetryRef.current = onRetry;
  }, [onRetry]);
  useEffect(() => {
    if (!shown) return;
    let active = true;
    window.api
      .recheckSecureStorage({ trigger: 'shown' })
      .then(({ changed }) => {
        if (active && changed) onRetryRef.current?.();
      })
      .catch((error: unknown) => {
        // The notice keeps showing the state its caller last read.
        reportClientAppError(error);
      });
    return (): void => {
      active = false;
    };
  }, [shown]);
  if (!notice) return null;
  const retry = async (): Promise<void> => {
    if (!onRetry) return;
    setRechecking(true);
    try {
      await window.api.recheckSecureStorage({ trigger: 'retry' });
    } catch (error) {
      // The caller's reload still reports the current state.
      reportClientAppError(error);
    } finally {
      setRechecking(false);
    }
    onRetry();
  };
  const busy = retrying || rechecking;
  return (
    <Notice
      intent="attention"
      title={notice.title}
      data-testid="secure-storage-notice"
      data-storage-state={notice.state}
      actions={
        notice.retryable && onRetry ? (
          <NoticeButton
            data-testid="secure-storage-retry"
            disabled={busy}
            onClick={(): void => void retry()}
          >
            {busy ? 'Trying again…' : 'Try again'}
          </NoticeButton>
        ) : undefined
      }
    >
      {notice.description}
    </Notice>
  );
}
