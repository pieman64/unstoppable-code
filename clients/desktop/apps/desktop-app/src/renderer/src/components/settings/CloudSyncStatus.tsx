import type { JSX } from 'react';
import type { TelemetrySyncStatus } from '@canopy/desktop-shared/types';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';
import { LoadingSpinner } from '@/components/shared/loading';
import { formatRelativeTime } from '@/lib/format';

export interface CloudSyncStatusProps {
  status: TelemetrySyncStatus | null;
  /**
   * Whether a usable cloud credential currently resolves to an account, from
   * `useCanopyCloudCredentialUsable()`. `null` while that load is still in
   * flight, so an in-flight read never flashes a disconnected label at a
   * linked user.
   */
  cloudConnected: boolean | null;
}

function pendingSuffix(pendingCount: number): string {
  return pendingCount > 0 ? ` · ${pendingCount} pending` : '';
}

/**
 * Presentational last-sync status line for the Privacy → Activity sharing
 * section.
 *
 * Renders the current {@link TelemetrySyncStatus} phase (syncing, synced,
 * failed, paused, waiting, or privacy enabled) as a status line with a status
 * dot / spinner idiom matching `CanopyCloudAccountSection`.
 *
 * `TelemetrySyncStatus` is deliberately network-truth only: when the cloud
 * credential is missing, the flush loop resolves the scope as `unavailable` and
 * defers WITHOUT recording an upload error, because that is not an upload
 * failure. Main therefore keeps reporting the last successful `lastSyncedAt`
 * while the queue silently grows, so this component must merge in account
 * connectivity — otherwise a disconnected account renders as a green
 * "Synced 14h ago · 237 pending", which reads as healthy while nothing can
 * upload. That merge is this component's job by contract; see the
 * {@link TelemetrySyncStatus} doc comment.
 */
export function CloudSyncStatus({
  status,
  cloudConnected,
}: CloudSyncStatusProps): JSX.Element | null {
  if (status === null) {
    return null;
  }

  const { isSyncing, pendingCount, sharingActive, lastSyncedAt, lastErrorAt } =
    status;

  let content: JSX.Element;

  // CAN-3512: sync that should run but does not reads `Sync paused`. A stalled
  // queue ranks below the more specific sign-in and upload-failure states,
  // which name their own fix.
  const paused = (
    <span
      data-testid="settings-cloud-sync-status-paused"
      className="inline-flex items-center gap-1.5 fg-secondary"
    >
      <span
        aria-hidden="true"
        className={`inline-block h-2.5 w-2.5 rounded-full ${OPERATIONAL_STATUS_COLORS.paused.background}`}
      />
      <span>Sync paused{pendingSuffix(pendingCount)}</span>
    </span>
  );

  if (!sharingActive) {
    content = <span className="fg-secondary">Privacy enabled</span>;
  } else if (isSyncing) {
    content = (
      <span className="inline-flex items-center gap-1.5 fg-secondary">
        <LoadingSpinner />
        <span>Syncing…{pendingSuffix(pendingCount)}</span>
      </span>
    );
  } else if (cloudConnected === false) {
    // Ranked above `upload-failed`: a missing credential is the cause of any
    // failure recorded under it, and "Sign in" is the actionable next step
    // where "Sync failed" is not. Matches the account card's red dot directly
    // above, so the two rows can no longer disagree about the same account.
    content = (
      <span className="inline-flex items-center gap-1.5 fg-destructive">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-destructive" />
        <span>Sign in to sync{pendingSuffix(pendingCount)}</span>
      </span>
    );
  } else if (status.lastError === 'upload-failed') {
    const when = lastErrorAt ? ` ${formatRelativeTime(lastErrorAt)}` : '';
    content = (
      <span className="inline-flex items-center gap-1.5 fg-destructive">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-destructive" />
        <span>
          Sync failed{when}
          {pendingSuffix(pendingCount)}
        </span>
      </span>
    );
  } else if (status.pausedReason === 'queue-stalled') {
    content = paused;
  } else if (lastSyncedAt) {
    content = (
      <span className="inline-flex items-center gap-1.5 fg-secondary">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-success" />
        <span>
          Synced {formatRelativeTime(lastSyncedAt)}
          {pendingSuffix(pendingCount)}
        </span>
      </span>
    );
  } else {
    content = (
      <span className="fg-secondary">
        {pendingCount > 0 ? `${pendingCount} pending` : 'Waiting to sync…'}
      </span>
    );
  }

  return (
    <div data-testid="settings-cloud-sync-status" className="text-xs">
      {content}
    </div>
  );
}
