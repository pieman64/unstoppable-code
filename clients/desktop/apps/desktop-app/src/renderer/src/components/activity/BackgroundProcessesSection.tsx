import { useCallback, useMemo, type JSX } from 'react';
import { ProcessIcon } from '@canopy/ui-shared/icons';
import type { BackgroundProcess } from '@canopy/desktop-shared/types';
import { ActivitySection, type CollapsedIconColor } from './ActivitySection';
import {
  BackgroundTasksList,
  backgroundTasksHeaderChrome,
  type BackgroundTasksSectionHostModel,
} from '@canopy/ui-app';
import { backgroundProcessToTask } from '@/lib/background-tasks';
import { useBackgroundTaskActions } from './useBackgroundTaskActions';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useEarlyAccessTitle } from '@/lib/earlyAccessTitles';
import {
  BACKGROUND_PROCESSES_UI_STATE_KEY,
  reportBackgroundProcessSelection,
  selectedBackgroundProcessTaskId,
} from '@/lib/current-ui-state/backgroundProcessesUiState';

// eslint-disable-next-line react-refresh/only-export-components
export function useBackgroundProcessesHeaderChrome(
  processes: readonly BackgroundProcess[],
): { subtitle: string; collapsedIconColor: CollapsedIconColor } {
  return backgroundTasksHeaderChrome(processes);
}

/** Owns the `chat.backgroundProcesses` App Advisor slice while the section body is mounted. */
function BackgroundProcessesUiStateReporter({
  projectId,
  worktreeId,
  processes,
}: {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly processes: readonly BackgroundProcess[];
}): null {
  const selectedTaskId = useCurrentUiStateStore((state) =>
    selectedBackgroundProcessTaskId(
      state.slices[BACKGROUND_PROCESSES_UI_STATE_KEY],
      projectId,
      worktreeId,
    ),
  );
  useCurrentUiStateReporter(BACKGROUND_PROCESSES_UI_STATE_KEY, {
    projectId,
    worktreeId,
    total: processes.length,
    running: processes.filter((process) => process.status === 'running').length,
    detailModalOpen: selectedTaskId !== null,
    ...(selectedTaskId ? { selectedTaskId } : {}),
  });
  return null;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useBackgroundProcessesSectionHostModel({
  projectId,
  worktreeId,
  processes,
}: {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly processes: readonly BackgroundProcess[];
}): BackgroundTasksSectionHostModel {
  const tasks = useMemo(
    () => processes.map(backgroundProcessToTask),
    [processes],
  );
  const reportSelection = useCallback(
    (selectedTaskId: string | null): void => {
      reportBackgroundProcessSelection({
        projectId,
        worktreeId,
        processes,
        selectedTaskId,
      });
    },
    [processes, projectId, worktreeId],
  );
  const actions = useBackgroundTaskActions({
    projectId,
    worktreeId,
    processes,
    onSelectedTaskIdChange: reportSelection,
  });
  return useMemo(
    () => ({
      tasks,
      actions,
      supplementaryContent: (
        <BackgroundProcessesUiStateReporter
          projectId={projectId}
          worktreeId={worktreeId}
          processes={processes}
        />
      ),
    }),
    [actions, processes, projectId, tasks, worktreeId],
  );
}

export function BackgroundProcessesSection({
  projectId,
  worktreeId,
  processes,
}: {
  projectId: string;
  worktreeId: string;
  processes: BackgroundProcess[];
}): JSX.Element {
  const headerChrome = useBackgroundProcessesHeaderChrome(processes);
  const title = useEarlyAccessTitle('Agent Background Processes');
  const model = useBackgroundProcessesSectionHostModel({
    projectId,
    worktreeId,
    processes,
  });
  return (
    <ActivitySection
      icon={<ProcessIcon />}
      title={title}
      subtitle={headerChrome.subtitle}
      collapsedIconColor={headerChrome.collapsedIconColor}
    >
      <BackgroundTasksList tasks={model.tasks} actions={model.actions} />
      {model.supplementaryContent}
    </ActivitySection>
  );
}
