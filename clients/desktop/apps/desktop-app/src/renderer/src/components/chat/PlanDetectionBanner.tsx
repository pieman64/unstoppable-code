import { type JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { DocumentIcon } from '@canopy/ui-shared/icons/AppIcons';
import type { DetectedPlanEntry } from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';

// Stable empty reference so the Zustand selector below does not return a fresh
// array each render (which would loop useSyncExternalStore — "Maximum update
// depth exceeded") when no detections exist for this worktree yet.
const EMPTY_DETECTED_PLANS: DetectedPlanEntry[] = [];

interface PlanDetectionBannerProps {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export function PlanDetectionBanner({
  projectId,
  worktreeId,
  chatId,
}: PlanDetectionBannerProps): JSX.Element {
  const key = `${projectId}/${worktreeId}`;
  const entries = useActivityStore(
    (state) => state.detectedPlans[key] ?? EMPTY_DETECTED_PLANS,
  );
  const updateDetectedPlan = useActivityStore(
    (state) => state.updateDetectedPlan,
  );

  const pending = entries.filter(
    (e) =>
      e.detectedInChatId === chatId && e.status === 'detected' && !e.bannerSeen,
  );

  if (pending.length === 0) {
    return <></>;
  }

  const label =
    pending.length === 1
      ? 'a plan document'
      : `${String(pending.length)} plan documents`;

  const handleImport = (): void => {
    useActivityStore.getState().openImportModal({
      projectId,
      worktreeId,
      initialTab: 'detected',
      originChatId: chatId,
    });
  };

  const handleDismiss = (): void => {
    for (const entry of pending) {
      void updateDetectedPlan(projectId, worktreeId, entry.id, {
        bannerSeen: true,
      });
    }
  };

  return (
    <Notice
      intent="neutral"
      icon={<DocumentIcon size={16} aria-hidden="true" />}
      title={pending.length === 1 ? 'Plan detected' : 'Plans detected'}
      data-testid="plan-detection-banner"
      onDismiss={handleDismiss}
      dismissLabel="Dismiss plan detection notice"
      dismissTestId="plan-detection-banner-dismiss"
      actions={
        <NoticeButton
          variant="primary"
          data-testid="plan-detection-banner-import"
          onClick={handleImport}
        >
          Import
        </NoticeButton>
      }
    >
      Found {label} in this conversation.
    </Notice>
  );
}
