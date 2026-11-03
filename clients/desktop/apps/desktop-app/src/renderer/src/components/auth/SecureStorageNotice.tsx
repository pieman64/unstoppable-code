import type { JSX } from 'react';
import type { SecureStorageFailure } from '@canopy/desktop-shared/types/secure-storage';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { getSecureStorageNotice } from '@/lib/secureStorageNotice';

interface SecureStorageNoticeProps {
  failure: SecureStorageFailure | null;
  onRetry?: () => void;
  retrying?: boolean;
}

/** Desktop OS-store adapter; presentation is the shared, browser-safe Notice. */
export function SecureStorageNotice({
  failure,
  onRetry,
  retrying = false,
}: SecureStorageNoticeProps): JSX.Element | null {
  const notice = getSecureStorageNotice(failure);
  if (!notice) return null;
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
            disabled={retrying}
            onClick={onRetry}
          >
            {retrying ? 'Trying again…' : 'Try again'}
          </NoticeButton>
        ) : undefined
      }
    >
      {notice.description}
    </Notice>
  );
}
