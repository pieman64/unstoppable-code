import { useMemo } from 'react';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { SidebarSurfaceProps } from '@canopy/ui-app';
import type {
  SpaceNotificationMenuChoice,
  SpaceNotificationMenuState,
} from '@canopy/ui-shared/components';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  spaceNotificationMenuStateFor,
  useSpaceNotificationStore,
} from '@/stores/spaceNotificationStore';

type SpaceNotificationSidebarProps = Pick<
  SidebarSurfaceProps,
  | 'getWorktreeNotificationSettings'
  | 'onWorktreeNotificationSettingsRequested'
  | 'onSetWorktreeNotificationLevel'
>;

/** Whether this desktop shows per-space notification choices (CAN-3615). */
export function useSpaceNotificationControlsEnabled(): boolean {
  return useFeatureFlagsStore((s) =>
    s.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedSpaceNotificationSettings.key),
  );
}

/**
 * Per-space notification choices for the code worktree menus. One host-level
 * subscription feeds every row's synchronous read, so rows hold no
 * subscription of their own; a row's menu refreshes its space when it opens.
 */
export function useSpaceNotificationSidebarProps(): SpaceNotificationSidebarProps {
  const enabled = useSpaceNotificationControlsEnabled();
  const snapshot = useSpaceNotificationStore((s) => s.snapshot);
  const progress = useSpaceNotificationStore((s) => s.progress);
  return useMemo((): SpaceNotificationSidebarProps => {
    // Signed-out and guest sessions have no saved choices to show or change,
    // so their menus carry no notification group at all.
    if (!enabled || !snapshot.accountKey) return {};
    return {
      getWorktreeNotificationSettings: (
        projectId,
        worktreeId,
      ): SpaceNotificationMenuState =>
        spaceNotificationMenuStateFor(
          { snapshot, progress },
          { projectId, worktreeId },
        ),
      onWorktreeNotificationSettingsRequested: (
        projectId,
        worktreeId,
      ): void => {
        void useSpaceNotificationStore
          .getState()
          .refresh({ projectId, worktreeId });
      },
      onSetWorktreeNotificationLevel: (
        projectId,
        worktreeId,
        choice: SpaceNotificationMenuChoice,
      ): void => {
        void useSpaceNotificationStore
          .getState()
          .setChoice({ projectId, worktreeId }, choice);
      },
    };
  }, [enabled, snapshot, progress]);
}
