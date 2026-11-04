import type { JSX } from 'react';
import { ScriptActionsReview } from '@canopy/ui-app/script-actions';
import { useChatStore } from '@/stores/chatStore';
import { useDesktopScriptActionsReviewProps } from './desktopScriptActions';
import { Heading } from '@canopy/ui-shared/components';

interface ScriptActionsSettingsSectionProps {
  readonly projectId: string;
  /** A worktree the settings view already scopes to, such as the inspected one. */
  readonly fallbackWorktreeId?: string;
  /** `plain` drops the frame, for a settings page section that has its own. */
  readonly surface?: 'card' | 'plain';
}

/**
 * Detected scripts in Project and Workspace Settings → Scripts: the shared
 * review, inline, for the selected worktree of this project.
 */
export function ScriptActionsSettingsSection({
  projectId,
  fallbackWorktreeId,
  surface = 'card',
}: ScriptActionsSettingsSectionProps): JSX.Element {
  const frame = surface === 'card' ? 'rounded-lg border p-3' : '';
  const reviewProps = useDesktopScriptActionsReviewProps();
  const selected = useChatStore((state) => state.selectedWorktree);
  const worktreeId =
    selected !== null && selected.projectId === projectId
      ? selected.worktreeId
      : fallbackWorktreeId;
  if (worktreeId === undefined)
    return (
      <section
        className={`space-y-1 ${frame}`}
        data-testid="script-actions-settings-no-worktree"
      >
        {surface === 'card' && (
          <Heading level={3} variant="title">
            Detected scripts
          </Heading>
        )}
        <p className="text-xs fg-secondary">
          Open a worktree in this project to review the scripts found in it.
        </p>
      </section>
    );
  return (
    <div className={frame} data-testid="script-actions-settings">
      <ScriptActionsReview
        {...reviewProps}
        projectId={projectId}
        worktreeId={worktreeId}
      />
    </div>
  );
}
