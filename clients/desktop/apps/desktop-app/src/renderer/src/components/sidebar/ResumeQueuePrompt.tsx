import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import {
  BulletListIcon,
  CheckIcon,
  PauseIcon,
  WarningIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import type {
  ResumeQueueEntry,
  ResumeQueueSnapshot,
} from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { LoadingSpinner } from '@/components/shared/loading';
import { openResumeQueueEntry } from '@/lib/usage-limit/open-resumed-session';
import {
  resumeQueueProgress,
  useResumeQueueStore,
} from '@/stores/resumeQueueStore';
import {
  SidebarFooterBanner,
  SidebarFooterBannerIcon,
} from './SidebarFooterBanner';

/**
 * How long a finished queue's pill stays before it clears itself when its
 * modal was not just closed.
 */
export const RESUME_QUEUE_AUTO_DISMISS_MS = 30_000;

/**
 * A healthy one-session queue names its session and opens it; failed,
 * stopped, and skipped entries keep the queue's own status and route.
 */
function singleChipEntry(
  snapshot: ResumeQueueSnapshot | null,
): ResumeQueueEntry | null {
  if (!snapshot || snapshot.error || snapshot.entries.length !== 1) return null;
  const [entry] = snapshot.entries;
  return entry &&
    (entry.status === 'waiting' ||
      entry.status === 'resuming' ||
      entry.status === 'resumed')
    ? entry
    : null;
}

export function ResumeQueuePrompt(): JSX.Element | null {
  const {
    snapshot,
    isOpen,
    open,
    dismissQueue,
    connectionError,
    openWithNavigationError,
    navigationPending,
  } = useResumeQueueStore(
    useShallow((state) => ({
      snapshot: state.snapshot,
      isOpen: state.isOpen,
      open: state.open,
      dismissQueue: state.dismiss,
      connectionError: state.connectionError,
      openWithNavigationError: state.openWithNavigationError,
      navigationPending: state.pendingNavigationCount > 0,
    })),
  );
  const openingRef = useRef(false);
  const mountedRef = useRef(false);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);
  const progress = snapshot ? resumeQueueProgress(snapshot) : null;
  // Failed sessions and queue errors keep the pill until the user reviews them.
  const finishedCleanly = Boolean(
    progress?.total &&
    !progress.active &&
    !snapshot?.error &&
    !connectionError &&
    !snapshot?.entries.some((entry) => entry.status === 'failed'),
  );
  // Dismiss on the user's behalf, as Done does. One request at a time, so the
  // close transition and the timer never race each other. The queue rejects
  // the request if new sessions were enqueued meanwhile; a failed request
  // leaves the pill for the timer to retry.
  const dismiss = useCallback((): void => {
    void dismissQueue().catch((): void => undefined);
  }, [dismissQueue]);
  // Closing the modal over a cleanly finished queue clears the pill at once:
  // the user has already seen the result. Starts from the current state, so
  // a queue that was closed at mount waits for the timer instead. A pending
  // navigation keeps the queue as its retry route.
  const wasOpen = useRef(isOpen);
  useEffect(() => {
    const closed = wasOpen.current && !isOpen;
    wasOpen.current = isOpen;
    if (
      closed &&
      finishedCleanly &&
      useResumeQueueStore.getState().pendingNavigationCount === 0
    )
      dismiss();
  }, [isOpen, finishedCleanly, dismiss]);
  // A queue that finishes while its modal is closed clears itself after a
  // delay. Never while the modal is open.
  useEffect(() => {
    if (!finishedCleanly || isOpen || opening || navigationPending) return;
    const timer = setTimeout(() => {
      if (useResumeQueueStore.getState().pendingNavigationCount > 0) return;
      dismiss();
    }, RESUME_QUEUE_AUTO_DISMISS_MS);
    return (): void => clearTimeout(timer);
  }, [finishedCleanly, isOpen, opening, navigationPending, dismiss]);
  if (!snapshot?.entries.length && !snapshot?.error && !connectionError)
    return null;
  const processed = progress?.processed ?? 0;
  const total = progress?.total ?? 0;
  const needsAttention = Boolean(snapshot?.error || connectionError);
  const paused = Boolean(progress?.active && snapshot?.paused);
  const running = Boolean(progress?.active && !snapshot?.paused);
  const single = connectionError ? null : singleChipEntry(snapshot);
  const status = needsAttention
    ? 'Queue needs attention'
    : single
      ? single.status === 'resumed'
        ? 'Resumed'
        : paused
          ? 'Paused'
          : 'Resuming'
      : running
        ? 'Resuming sessions'
        : paused
          ? 'Paused'
          : 'Resume queue finished';
  const openSingle = (entry: ResumeQueueEntry): void => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    useResumeQueueStore.getState().clearNavigationError();
    void openResumeQueueEntry(entry)
      .then((opened): void => {
        if (!opened.ok) openWithNavigationError(opened.error);
      })
      .finally((): void => {
        openingRef.current = false;
        if (mountedRef.current) setOpening(false);
      });
  };
  return (
    <SidebarFooterBanner
      testId="resume-queue-sidebar"
      surface="status"
      {...(single
        ? {
            // The visible label names the button, so the user-authored
            // title stays in masked text rather than an attribute.
            onClick: (): void => openSingle(single),
            trailingAction: {
              ariaLabel: 'Open resume queue',
              icon: <BulletListIcon size={16} aria-hidden="true" />,
              onClick: open,
              testId: 'resume-queue-sidebar-open-queue',
            },
          }
        : {
            onClick: open,
            ariaLabel: `Open resume queue: ${status}, ${processed} of ${total}`,
          })}
    >
      {/* The glyph carries the state, as on the update banner; the label
          stays primary and starts on the same edge as every other banner. */}
      <SidebarFooterBannerIcon
        tone={needsAttention ? 'warning' : running ? 'accent' : 'secondary'}
      >
        {needsAttention ? (
          <WarningIcon size={16} aria-hidden="true" />
        ) : running ? (
          <LoadingSpinner tone="accent" />
        ) : paused ? (
          <PauseIcon size={16} aria-hidden="true" />
        ) : (
          <CheckIcon size={16} aria-hidden="true" />
        )}
      </SidebarFooterBannerIcon>
      {single ? (
        <span className="min-w-0 flex-1 truncate">
          {status} ·{' '}
          <span
            data-testid="resume-queue-sidebar-title"
            className={POSTHOG_REPLAY_MASK_CLASS}
          >
            {single.title}
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{status}</span>
      )}
      <span
        data-testid="resume-queue-sidebar-count"
        className="text-2xs tabular-nums fg-primary"
      >
        {processed}/{total}
      </span>
    </SidebarFooterBanner>
  );
}
