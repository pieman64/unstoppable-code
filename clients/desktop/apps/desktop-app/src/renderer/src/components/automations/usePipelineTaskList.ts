import { useCallback, useEffect, useState } from 'react';
import type { AutomationPipelineTaskList } from '@canopy/ui-shared/components';
import { useProjectsStore } from '@/stores/projectsStore';
import { getAutomationWorktreeLabel } from '@/components/automations/form/automationFormState';

/**
 * The existing tasks a pipeline automation may run in on a project: a code
 * project's worktrees from the projects store, or a cowork project's Work
 * Entries over the existing `workEntries.list` IPC, which the store does not
 * mirror. `undefined` loads nothing.
 */
export function usePipelineTaskList(projectId: string | undefined): {
  tasks: AutomationPipelineTaskList;
  retry: () => void;
} {
  const project = useProjectsStore((state) =>
    projectId === undefined
      ? undefined
      : state.projects.find((candidate) => candidate.id === projectId),
  );
  const coworkProjectId = project?.type === 'cowork' ? project.id : undefined;
  const [loaded, setLoaded] = useState<{
    projectId: string;
    tasks: AutomationPipelineTaskList;
  }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!coworkProjectId) return undefined;
    let cancelled = false;
    setLoaded({ projectId: coworkProjectId, tasks: { status: 'loading' } });
    window.api.workEntries.list({ projectId: coworkProjectId }).then(
      (listed) => {
        if (cancelled) return;
        setLoaded({
          projectId: coworkProjectId,
          tasks: {
            status: 'ready',
            options: listed.entries.map((entry) => ({
              id: entry.id,
              label: entry.title || entry.id,
            })),
          },
        });
      },
      () => {
        if (!cancelled)
          setLoaded({ projectId: coworkProjectId, tasks: { status: 'error' } });
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [coworkProjectId, attempt]);
  const retry = useCallback((): void => setAttempt((n) => n + 1), []);
  if (!project) return { tasks: { status: 'loading' }, retry };
  if (project.type !== 'cowork')
    return {
      tasks: {
        status: 'ready',
        options: project.worktrees.map((worktree) => ({
          id: worktree.id,
          label: getAutomationWorktreeLabel(worktree),
        })),
      },
      retry,
    };
  return {
    tasks:
      loaded?.projectId === project.id ? loaded.tasks : { status: 'loading' },
    retry,
  };
}
