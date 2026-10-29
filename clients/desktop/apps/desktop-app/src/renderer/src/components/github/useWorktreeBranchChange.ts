import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BranchEntry,
  HomeBranchTargetsResponse,
} from '@canopy/desktop-shared/types';
import {
  createOptionsForBranchTarget,
  type HomeBranchTarget,
} from '@/stores/homeComposerStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { extractIpcErrorMessage } from '@/lib/errors';

interface WorktreeBranchChangeInput {
  projectId: string;
  worktreeId: string;
  currentBranch: string;
  /** The worktree's tracked base, where a new issue branch starts. */
  baseBranch: string | null | undefined;
}

export interface WorktreeBranchChange {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Opens the picker and reloads its targets so the lists stay current. */
  openPicker: () => void;
  /** Null while the targets load. */
  targets: HomeBranchTargetsResponse | null;
  /** Switches the worktree to a PR's head, a branch or an issue's branch. */
  selectTarget: (target: HomeBranchTarget) => void;
}

/**
 * State for the worktree header's Change branch picker: the New Task branch
 * targets, applied to an existing single-repo worktree through the same
 * switch and create operations as Branch info's branch picker.
 */
export function useWorktreeBranchChange({
  projectId,
  worktreeId,
  currentBranch,
  baseBranch,
}: WorktreeBranchChangeInput): WorktreeBranchChange {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<HomeBranchTargetsResponse | null>(
    null,
  );
  // Worktrees with a switch in flight. The header stays mounted when the open
  // worktree changes, so one worktree's switch must not hold back another's.
  const changingRef = useRef(new Set<string>());
  // The latest open's load. A pick waits for it, so switch versus create is
  // never decided from a list that is still loading or belongs to an earlier
  // open; null after a project change.
  const loadRef = useRef<Promise<HomeBranchTargetsResponse | null> | null>(
    null,
  );

  useEffect(
    () => (): void => {
      loadRef.current = null;
    },
    [projectId],
  );

  const openPicker = useCallback((): void => {
    setTargets(null);
    setOpen(true);
    const load = window.api
      .homeListBranchTargets({ workspaceId: projectId })
      .catch((err: unknown): null => {
        useGitHubStore
          .getState()
          .addToast(extractIpcErrorMessage(err), 'error');
        return null;
      });
    loadRef.current = load;
    void load.then((loaded): void => {
      if (loadRef.current === load) setTargets(loaded);
    });
  }, [projectId]);

  const changeBranch = useCallback(
    async (target: HomeBranchTarget): Promise<void> => {
      const changingKey = `${projectId}:${worktreeId}`;
      if (changingRef.current.has(changingKey)) {
        useGitHubStore
          .getState()
          .addToast(
            'This worktree is still switching branches. Try again when it finishes.',
            'info',
          );
        return;
      }
      changingRef.current.add(changingKey);
      try {
        // Failed loads already showed a toast.
        const loaded = await loadRef.current;
        if (!loaded) return;
        const branches = loaded.branches;
        // An issue's suggested branch that does not exist yet comes back as
        // `branchName`; everything else names an existing branch.
        const options = createOptionsForBranchTarget(target, branches);
        const branchName = options?.existingBranch ?? options?.branchName;
        if (!options || !branchName || branchName === currentBranch) return;
        const entryFor = (name: string): BranchEntry | undefined =>
          branches.find((branch) => branch.name === name);
        let result: { branchName: string };
        if (options.existingBranch) {
          result = await window.api.switchBranch({
            projectId,
            worktreeId,
            branchName,
            // A PR head missing from the list is fetched from the remote.
            isRemote:
              entryFor(branchName)?.isRemote ??
              (target.kind === 'branch' ? target.isRemote : true),
          });
        } else {
          const startBranch = baseBranch ?? loaded.defaultBranch ?? '';
          result = await window.api.createBranch({
            projectId,
            worktreeId,
            newBranchName: branchName,
            baseBranch: startBranch,
            // Start from origin whenever it has the base, as Branch info's
            // picker does; a local base may be behind it.
            baseBranchIsRemote: entryFor(startBranch)?.hasRemoteRef === true,
          });
        }
        const projects = useProjectsStore.getState();
        projects.updateBranchName(projectId, worktreeId, result.branchName);
        void projects.refreshDiffStats();
      } catch (err: unknown) {
        useGitHubStore
          .getState()
          .addToast(extractIpcErrorMessage(err), 'error');
      } finally {
        changingRef.current.delete(changingKey);
      }
    },
    [baseBranch, currentBranch, projectId, worktreeId],
  );

  const selectTarget = useCallback(
    (target: HomeBranchTarget): void => {
      void changeBranch(target);
    },
    [changeBranch],
  );

  return { open, setOpen, openPicker, targets, selectTarget };
}
