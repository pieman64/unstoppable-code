/**
 * Prompts activity card — workspace-global reusable prompt snippets with
 * branch-origin badges. An @-mention of a prompt is EXPANDED into the
 * outgoing message at send time (unlike notes/attachments, which stay
 * file-reference pills). Available on both the Code worktree and Cowork
 * activity rails.
 */
import type { JSX } from 'react';
import { EditBigIcon } from '@canopy/ui-shared/icons/AppIcons';
import type { ActivitySectionRenderProps } from './activity-sections';
import {
  WorkspaceMarkdownItemsSection,
  useWorkspaceMarkdownItemsHeaderChrome,
} from './WorkspaceMarkdownItemsSection';

// eslint-disable-next-line react-refresh/only-export-components
export function usePromptsHeaderChrome(
  projectId: string,
  worktreeId?: string,
): ReturnType<typeof useWorkspaceMarkdownItemsHeaderChrome> {
  return useWorkspaceMarkdownItemsHeaderChrome({
    projectId,
    ...(worktreeId !== undefined ? { worktreeId } : {}),
    kind: 'prompt',
    noun: 'prompt',
  });
}

export function PromptsSection({
  projectId,
  worktreeId,
}: ActivitySectionRenderProps): JSX.Element {
  return (
    <WorkspaceMarkdownItemsSection
      projectId={projectId}
      worktreeId={worktreeId}
      kind="prompt"
      title="Prompts"
      icon={<EditBigIcon size="sm" />}
      noun="prompt"
      mentionRepoName="Prompts"
      testIdPrefix="workspace-prompts"
    />
  );
}
