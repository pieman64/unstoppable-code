/**
 * Notes activity card — workspace-global markdown notes with branch-origin
 * badges. Available on both the Code worktree and Cowork activity rails; see
 * `WorkspaceMarkdownItemsSection` for the shared implementation and
 * `main/ipc/workspace-items.ts` for per-workspace-type storage.
 */
import type { JSX } from 'react';
import { NoteIcon as CentralNoteIcon } from '@canopy/ui-shared/icons/AppIcons';
import type { ActivitySectionRenderProps } from './activity-sections';
import {
  WorkspaceMarkdownItemsSection,
  useWorkspaceMarkdownItemsHeaderChrome,
} from './WorkspaceMarkdownItemsSection';

// eslint-disable-next-line react-refresh/only-export-components
export function useNotesHeaderChrome(
  projectId: string,
  worktreeId?: string,
): ReturnType<typeof useWorkspaceMarkdownItemsHeaderChrome> {
  return useWorkspaceMarkdownItemsHeaderChrome({
    projectId,
    ...(worktreeId !== undefined ? { worktreeId } : {}),
    kind: 'note',
    noun: 'note',
  });
}

export function NotesSection({
  projectId,
  worktreeId,
}: ActivitySectionRenderProps): JSX.Element {
  return (
    <WorkspaceMarkdownItemsSection
      projectId={projectId}
      worktreeId={worktreeId}
      kind="note"
      title="Notes"
      icon={<CentralNoteIcon size="sm" />}
      noun="note"
      mentionRepoName="Notes"
      testIdPrefix="workspace-notes"
    />
  );
}
