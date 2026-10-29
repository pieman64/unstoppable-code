import type { BackgroundProcess } from '@canopy/desktop-shared/types';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';

export const BACKGROUND_PROCESSES_UI_STATE_KEY = 'chat.backgroundProcesses';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function selectedBackgroundProcessTaskId(
  value: unknown,
  projectId: string,
  worktreeId: string,
): string | null {
  if (
    !isRecord(value) ||
    value.projectId !== projectId ||
    value.worktreeId !== worktreeId ||
    value.detailModalOpen !== true ||
    typeof value.selectedTaskId !== 'string'
  ) {
    return null;
  }
  return value.selectedTaskId;
}

/**
 * Update modal selection without mounting another reporter for each transcript
 * copy of the list. This preserves the single shared slice owner while still
 * letting a modal opened from chat immediately update App Advisor state.
 */
export function reportBackgroundProcessSelection(input: {
  projectId: string;
  worktreeId: string;
  processes: readonly BackgroundProcess[];
  selectedTaskId: string | null;
}): void {
  const store = useCurrentUiStateStore.getState();
  const current = store.slices[BACKGROUND_PROCESSES_UI_STATE_KEY];
  const matchingCurrent =
    isRecord(current) &&
    current.projectId === input.projectId &&
    current.worktreeId === input.worktreeId
      ? current
      : null;
  store.updateSlice(BACKGROUND_PROCESSES_UI_STATE_KEY, {
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    total:
      typeof matchingCurrent?.total === 'number'
        ? matchingCurrent.total
        : input.processes.length,
    running:
      typeof matchingCurrent?.running === 'number'
        ? matchingCurrent.running
        : input.processes.filter((process) => process.status === 'running')
            .length,
    detailModalOpen: input.selectedTaskId !== null,
    ...(input.selectedTaskId ? { selectedTaskId: input.selectedTaskId } : {}),
  });
}
