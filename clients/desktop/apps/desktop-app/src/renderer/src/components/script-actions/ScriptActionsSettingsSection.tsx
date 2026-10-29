import type { JSX } from 'react';
import { ScriptActionsReview } from '@canopy/ui-app/script-actions';
import { useChatStore } from '@/stores/chatStore';
import { useDesktopScriptActionsReviewProps } from './desktopScriptActions';

interface ScriptActionsSettingsSectionProps {
  readonly projectId: string;
  /** A worktree the settings view already scopes to, such as the inspected one. */
  readonly fallbackWorktreeId?: string;
}

/**
 * Detected scripts in Project and Workspace Settings → Scripts: the shared
 * review, inline, for the selected worktree of this project.
 */
export function ScriptActionsSettingsSection({
  projectId,
  fallbackWorktreeId,
}: ScriptActionsSettingsSectionProps): JSX.Element {
  const reviewProps = useDesktopScriptActionsReviewProps();
  const selected = useChatStore((state) => state.selectedWorktree);
  const worktreeId =
    selected !== null && selected.projectId === projectId
      ? selected.worktreeId
      : fallbackWorktreeId;
  if (worktreeId === undefined)
    return (
      <section
        className="space-y-1 rounded-lg border p-3"
        data-testid="script-actions-settings-no-worktree"
      >
        <h3 className="text-s font-medium fg-primary">Detected scripts</h3>
        <p className="text-xs fg-secondary">
          Open a worktree in this project to review the scripts found in it.
        </p>
      </section>
    );
  return (
    <div
      className="rounded-lg border p-3"
      data-testid="script-actions-settings"
    >
      <ScriptActionsReview
        {...reviewProps}
        projectId={projectId}
        worktreeId={worktreeId}
      />
    </div>
  );
}
