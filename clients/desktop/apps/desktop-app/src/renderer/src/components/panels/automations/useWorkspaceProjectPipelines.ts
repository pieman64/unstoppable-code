import { useEffect, useState } from 'react';
import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';

/** A workspace's own on-demand workflows, as its checkout declares them. */
export interface WorkspaceProjectPipelines {
  readonly pipelines: readonly PipelineInfo[];
  /** The checkout they were read from; opening one needs it. */
  readonly cwd: string | undefined;
}

const NONE: WorkspaceProjectPipelines = { pipelines: [], cwd: undefined };

/**
 * The project pipelines in this panel's checkout, read the way the Workflows
 * Library reads them: the worktree's path, then `discoverProject`. A
 * workspace with no checkout path (the Orchestrator) or a failed read has
 * none. Read when the panel's workspace or worktree changes.
 */
export function useWorkspaceProjectPipelines(
  projectId: string,
  worktreeId: string,
): WorkspaceProjectPipelines {
  const key = `${projectId}\0${worktreeId}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    value: WorkspaceProjectPipelines;
  }>({ key: '', value: NONE });

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      let value = NONE;
      try {
        const cwd = await window.api.getWorktreePath({ projectId, worktreeId });
        if (cwd) {
          const result = await window.pipelines.discoverProject(cwd);
          value = {
            pipelines: result.success && result.data ? result.data : [],
            cwd,
          };
        }
      } catch {
        value = NONE;
      }
      if (!cancelled) setLoaded({ key, value });
    })();
    return (): void => {
      cancelled = true;
    };
  }, [key, projectId, worktreeId]);

  return loaded.key === key ? loaded.value : NONE;
}
