import { memo, type JSX } from 'react';
import {
  WorktreeTopBar as SharedWorktreeTopBar,
  type WorktreeTopBarPinnedAction,
} from '@canopy/ui-app';
import type { WorktreeViewMode } from '@/lib/worktree-layout-prefs';
import { PrStatusBar } from '@/components/github/PrStatusBar';
import { WorktreeLaunchButton } from '@/components/activity/WorktreeLaunchButton';
import { CollapsedTitlebarToggle } from '@/components/sidebar/CollapsedTitlebarToggle';
import { WorkspaceLayoutControls } from '@/components/panels/WorkspaceLayoutControls';

export interface WorktreeTopBarProps {
  projectId: string;
  worktreeId: string;
  viewMode: WorktreeViewMode;
  viewModeReady: boolean;
  /**
   * Runnable pinned scripts, from `useWorktreeScriptActions` in WorktreePart
   * (the header gallery passes fixed samples). Omitted means none.
   */
  pinnedActions?: readonly WorktreeTopBarPinnedAction[];
}

/**
 * The persistent worktree top bar, mounted by WorktreePart ABOVE the panel
 * grid and spanning the full content-region width whenever a worktree is
 * selected. This is a thin smart wrapper: the bar's frame, layout, and styles
 * live in the shared `@canopy/ui-app` {@link SharedWorktreeTopBar} (also
 * mounted by the web portal); this file only wires desktop stores and injects
 * the desktop-only children into its slots:
 *
 * - {@link PrStatusBar} (branch/PR/CI state + git actions) filling the status
 *   region;
 * - {@link WorktreeLaunchButton} (Launch/Stop scripts + the aggregated
 *   dev-server open control) in the launch cluster;
 * - {@link SaveLayoutDefaultControl} as the trailing accessory;
 * - the pinned scripts it is given, before the launch cluster.
 *
 * When the sidebar is collapsed, the persistent titlebar corner overlay (the
 * sidebar toggle and adjacent controls, rendered by App.tsx) occupies the
 * worktree top bar's leading edge. Reserve that corner in every view mode so
 * its drag region never covers the New Chat button.
 */
export const WorktreeTopBar = memo(function WorktreeTopBar({
  projectId,
  worktreeId,
  viewMode,
  viewModeReady,
  pinnedActions,
}: WorktreeTopBarProps): JSX.Element {
  return (
    <SharedWorktreeTopBar
      leadingAccessory={<CollapsedTitlebarToggle />}
      pinnedActions={pinnedActions}
      statusContent={
        <PrStatusBar
          projectId={projectId}
          worktreeId={worktreeId}
          viewMode={viewMode}
          viewModeReady={viewModeReady}
        />
      }
      launchControl={
        <WorktreeLaunchButton projectId={projectId} worktreeId={worktreeId} />
      }
      trailingAccessory={
        <WorkspaceLayoutControls
          projectId={projectId}
          worktreeId={worktreeId}
        />
      }
    />
  );
});
