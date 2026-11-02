import { useEffect, useState } from 'react';
import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/desktop-shared/types';
import type { PipelineRepoChoice } from './PipelineTriggerModal';

interface PipelineWorktreeContext {
  cwd?: string;
  /**
   * The task's folder lookup has settled (or there is no task), so the
   * dialog can list pipelines once instead of again when `cwd` arrives.
   */
  cwdResolved: boolean;
  repoChoices: PipelineRepoChoice[];
}

export function ensureWorkspaceRootRepoChoice(
  choices: PipelineRepoChoice[],
): PipelineRepoChoice[] {
  // Repo discovery intentionally omits non-Git workspace roots. Pipeline
  // dispatch can still run from that directory, so keep it selectable for
  // local-only multi-repo workspaces, whether temporary or persistent.
  if (choices.some((choice) => choice.repoId === WORKSPACE_ROOT_REPO_ID)) {
    return choices;
  }
  return [
    {
      repoId: WORKSPACE_ROOT_REPO_ID,
      repoName: WORKSPACE_ROOT_REPO_NAME,
    },
    ...choices,
  ];
}

export function usePipelineWorktreeContext(
  projectId: string | undefined,
  worktreeId: string | undefined,
): PipelineWorktreeContext {
  const [cwd, setCwd] = useState<string | undefined>(undefined);
  // The task whose folder lookup last settled, so a switched task reads as
  // unresolved until its own lookup settles.
  const [resolvedTask, setResolvedTask] = useState<string | null>(null);
  const taskKey =
    projectId && worktreeId ? JSON.stringify([projectId, worktreeId]) : null;
  const [repoChoices, setRepoChoices] = useState<PipelineRepoChoice[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function loadCwd(): Promise<void> {
      if (!projectId || !worktreeId) {
        setCwd(undefined);
        return;
      }
      try {
        const path = await window.api.getWorktreePath({
          projectId,
          worktreeId,
        });
        if (!cancelled) setCwd(path);
      } catch {
        if (!cancelled) setCwd(undefined);
      }
      if (!cancelled) setResolvedTask(taskKey);
    }

    async function loadRepos(): Promise<void> {
      if (!projectId || !worktreeId) {
        setRepoChoices([]);
        return;
      }
      try {
        const entries = await window.api.listWorktreeRepoEntries({
          projectId,
          worktreeId,
        });
        if (!cancelled) {
          setRepoChoices(
            ensureWorkspaceRootRepoChoice(
              entries.map((entry) => ({
                repoId: entry.repoId,
                repoName: entry.repoName,
              })),
            ),
          );
        }
      } catch {
        if (!cancelled) setRepoChoices([]);
      }
    }

    void loadCwd();
    void loadRepos();
    return (): void => {
      cancelled = true;
    };
  }, [projectId, taskKey, worktreeId]);

  return {
    cwd,
    cwdResolved: taskKey === null || resolvedTask === taskKey,
    repoChoices,
  };
}
