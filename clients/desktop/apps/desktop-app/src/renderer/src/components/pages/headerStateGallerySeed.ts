import { useLayoutEffect, useState } from 'react';
import type { ArchivedChatSummary } from '@canopy/desktop-shared/types';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import type { BranchSyncAction } from '@/lib/githubBranchActions';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  buildDemoProject,
  HEADER_GALLERY_STATES,
  HEADER_STATE_GALLERY_PROJECT_ID,
  type HeaderGalleryState,
} from './headerStateGalleryData';

/**
 * Store seeding for the Header States gallery rows. Lives apart from the
 * page so the page file only exports components (react-refresh) and so the
 * Change review page can render the same seeded `WorktreeTopBar` rows
 * without duplicating the plumbing. Only one gallery page mounts at a time.
 */

/** Union of two key sets, avoiding Set spread (ES target restriction). */
function mergeKeySets(a: Set<string>, b: Set<string>): Set<string> {
  const merged = new Set<string>();
  a.forEach((value) => merged.add(value));
  b.forEach((value) => merged.add(value));
  return merged;
}

function galleryKey(state: HeaderGalleryState): string {
  return `${HEADER_STATE_GALLERY_PROJECT_ID}/${state.id}`;
}

/**
 * Seed the store slices the header reads, for the synthetic gallery workspace
 * only.
 *
 * Scoped on purpose: every write is keyed by the gallery's own project id, so
 * real workspaces are untouched. The synthetic project IS appended to
 * `projects` (the branch label and project chrome resolve through it), which
 * is why the page restores the previous array on unmount — `saveProjects()`
 * persists whatever the array holds at the time, so a fixture left behind
 * could be written into `workspaces/index.json` by an unrelated action.
 */
export function useSeededHeaderGalleryState(): boolean {
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const previousProjects = useProjectsStore.getState().projects;
    const previousHiddenWorkspaceIds =
      useProjectsStore.getState().hiddenWorkspaceIds;
    const states = HEADER_GALLERY_STATES;

    const uncommittedChanges: Record<string, boolean> = {};
    const hasUnpushedCommits: Record<string, boolean> = {};
    const hasUnpulledCommits: Record<string, boolean> = {};
    const hasRemoteTracking: Record<string, boolean> = {};
    const hasOriginRemote: Record<string, boolean> = {};
    const hasBranchBeenPushed: Record<string, boolean> = {};
    const commitsAhead: Record<string, boolean> = {};
    const baseBranches: Record<string, string> = {};
    const prStatuses: Record<string, WorktreePrStatus | null> = {};
    const creatingPr = new Set<string>();
    const committingAndPushing = new Set<string>();
    const activeBranchSyncAction: Record<string, BranchSyncAction | undefined> =
      {};
    const archivedChats: Record<string, ArchivedChatSummary[]> = {};

    for (const state of states) {
      const key = galleryKey(state);
      const p = state.projects ?? {};
      uncommittedChanges[key] = p.uncommittedChanges ?? false;
      hasUnpushedCommits[key] = p.hasUnpushedCommits ?? false;
      hasUnpulledCommits[key] = p.hasUnpulledCommits ?? false;
      hasRemoteTracking[key] = p.hasRemoteTracking ?? true;
      hasOriginRemote[key] = p.hasOriginRemote ?? true;
      hasBranchBeenPushed[key] = p.hasBranchBeenPushed ?? true;
      commitsAhead[key] = p.commitsAhead ?? false;
      baseBranches[key] = state.baseBranch ?? 'develop';
      if (state.prStatus) prStatuses[key] = state.prStatus;

      const g = state.github ?? {};
      if (g.creatingPr === true) creatingPr.add(key);
      if (g.committingAndPushing === true) committingAndPushing.add(key);
      if (g.activeBranchSyncAction) {
        activeBranchSyncAction[key] = g.activeBranchSyncAction;
      }

      // The archive control hides at zero, so seed one summary per count.
      archivedChats[key] = Array.from(
        { length: state.archivedChats ?? 0 },
        (_unused, index) => ({
          chatId: `${state.id}-archived-${index}`,
          title: `Archived chat ${index + 1}`,
          turnCount: 2,
          archivedAt: '2026-08-19T12:00:00.000Z',
          createdAt: '2026-08-18T12:00:00.000Z',
          restorable: true,
          providerType: 'claude',
          unread: false,
        }),
      );
    }

    useProjectsStore.setState((current) => ({
      projects: [...current.projects, buildDemoProject(states)],
      // Keep the fixture out of the sidebar. Set directly rather than through
      // `setHiddenWorkspaceIds`, which would persist the id into the user's
      // preferences; a plain `setState` stays in memory.
      hiddenWorkspaceIds: [
        ...current.hiddenWorkspaceIds,
        HEADER_STATE_GALLERY_PROJECT_ID,
      ],
      uncommittedChanges: {
        ...current.uncommittedChanges,
        ...uncommittedChanges,
      },
      hasUnpushedCommits: {
        ...current.hasUnpushedCommits,
        ...hasUnpushedCommits,
      },
      hasUnpulledCommits: {
        ...current.hasUnpulledCommits,
        ...hasUnpulledCommits,
      },
      hasRemoteTracking: { ...current.hasRemoteTracking, ...hasRemoteTracking },
      hasOriginRemote: { ...current.hasOriginRemote, ...hasOriginRemote },
      hasBranchBeenPushed: {
        ...current.hasBranchBeenPushed,
        ...hasBranchBeenPushed,
      },
      commitsAhead: { ...current.commitsAhead, ...commitsAhead },
      baseBranches: { ...current.baseBranches, ...baseBranches },
    }));

    useGitHubStore.setState((current) => ({
      prStatuses: { ...current.prStatuses, ...prStatuses },
      // Build the merged sets without spreading them: the renderer's ES
      // target does not allow Set iteration via spread.
      creatingPr: mergeKeySets(current.creatingPr, creatingPr),
      committingAndPushing: mergeKeySets(
        current.committingAndPushing,
        committingAndPushing,
      ),
      activeBranchSyncAction: {
        ...current.activeBranchSyncAction,
        ...activeBranchSyncAction,
      },
    }));

    useChatStore.setState((current) => ({
      archivedChats: { ...current.archivedChats, ...archivedChats },
    }));

    setReady(true);

    return (): void => {
      // Drop the synthetic workspace again. `saveProjects()` persists whatever
      // is in the array at the time, so leaving it behind risks a later real
      // mutation writing the gallery's fixture into `workspaces/index.json`.
      useProjectsStore.setState({
        projects: previousProjects,
        hiddenWorkspaceIds: previousHiddenWorkspaceIds,
      });
    };
  }, []);

  return ready;
}
