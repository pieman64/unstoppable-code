import type { JSX } from 'react';
import { ScriptActionsReview } from '@canopy/ui-app/script-actions';
import { useChatStore } from '@/stores/chatStore';
import { useDesktopScriptActionsReviewProps } from './desktopScriptActions';
import { Heading, Surface } from '@canopy/ui-shared/components';

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
  const reviewProps = useDesktopScriptActionsReviewProps();
  const selected = useChatStore((state) => state.selectedWorktree);
  const worktreeId =
    selected !== null && selected.projectId === projectId
      ? selected.worktreeId
      : fallbackWorktreeId;
  const noWorktreeNote = (
    <p className="text-xs fg-secondary">
      Open a worktree in this project to review the scripts found in it.
    </p>
  );
  if (worktreeId === undefined)
    return surface === 'card' ? (
      <Surface
        as="section"
        variant="outline"
        padding="compact"
        gap="tight"
        data-testid="script-actions-settings-no-worktree"
      >
        <Heading level={3} variant="title">
          Detected scripts
        </Heading>
        {noWorktreeNote}
      </Surface>
    ) : (
      <section
        className="space-y-1"
        data-testid="script-actions-settings-no-worktree"
      >
        {noWorktreeNote}
      </section>
    );
  const review = (
    <ScriptActionsReview
      {...reviewProps}
      projectId={projectId}
      worktreeId={worktreeId}
    />
  );
  return surface === 'card' ? (
    <Surface
      variant="outline"
      padding="compact"
      data-testid="script-actions-settings"
    >
      {review}
    </Surface>
  ) : (
    <div data-testid="script-actions-settings">{review}</div>
  );
}
