import { useEffect, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import {
  CheckIcon,
  PauseIcon,
  WarningIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { LoadingSpinner } from '@/components/shared/loading';
import {
  resumeQueueProgress,
  useResumeQueueStore,
} from '@/stores/resumeQueueStore';
import {
  SidebarFooterBanner,
  SidebarFooterBannerIcon,
} from './SidebarFooterBanner';

/** How long a finished queue's pill stays before it clears itself. */
export const RESUME_QUEUE_AUTO_DISMISS_MS = 30_000;

export function ResumeQueuePrompt(): JSX.Element | null {
  const { snapshot, isOpen, open, apply, connectionError } =
    useResumeQueueStore(
      useShallow((state) => ({
        snapshot: state.snapshot,
        isOpen: state.isOpen,
        open: state.open,
        apply: state.apply,
        connectionError: state.connectionError,
      })),
    );
  const progress = snapshot ? resumeQueueProgress(snapshot) : null;
  // Failed sessions and queue errors keep the pill until the user reviews them.
  const finishedCleanly = Boolean(
    progress?.total &&
    !progress.active &&
    !snapshot?.error &&
    !connectionError &&
    !snapshot?.entries.some((entry) => entry.status === 'failed'),
  );
  // Dismiss on the user's behalf, as Done does. Never while the queue modal
  // is open: closing it restarts the countdown.
  useEffect(() => {
    if (!finishedCleanly || isOpen) return;
    const timer = setTimeout(() => {
      // The queue rejects this if new sessions were enqueued meanwhile.
      window.api
        .controlResumeQueue('dismiss')
        .then(apply)
        .catch((): void => undefined);
    }, RESUME_QUEUE_AUTO_DISMISS_MS);
    return (): void => clearTimeout(timer);
  }, [finishedCleanly, isOpen, apply]);
  if (!snapshot?.entries.length && !snapshot?.error && !connectionError)
    return null;
  const processed = progress?.processed ?? 0;
  const total = progress?.total ?? 0;
  const needsAttention = Boolean(snapshot?.error || connectionError);
  const paused = Boolean(progress?.active && snapshot?.paused);
  const running = Boolean(progress?.active && !snapshot?.paused);
  const status = needsAttention
    ? 'Queue needs attention'
    : running
      ? 'Resuming sessions'
      : paused
        ? 'Paused'
        : 'Resume queue finished';
  return (
    <SidebarFooterBanner
      testId="resume-queue-sidebar"
      onClick={open}
      ariaLabel={`Open resume queue: ${status}, ${processed} of ${total}`}
      surface="status"
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
      <span className="min-w-0 flex-1 truncate">{status}</span>
      <span
        data-testid="resume-queue-sidebar-count"
        className="text-2xs tabular-nums fg-primary"
      >
        {processed}/{total}
      </span>
    </SidebarFooterBanner>
  );
}
