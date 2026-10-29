/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BackgroundTaskHostActions } from '@canopy/ui-app';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import type * as HeaderChromeModule from '@canopy/ui-app/code/activity/background-tasks-section';
import type { BackgroundProcess } from '@canopy/desktop-shared/types';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { BackgroundProcessesSection } from '../BackgroundProcessesSection';

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));
jest.mock('../ActivitySection', () => ({
  ActivitySection: ({ children }: { children: JSX.Element }): JSX.Element => (
    <div>{children}</div>
  ),
}));
jest.mock('@canopy/ui-app', () => ({
  backgroundTasksHeaderChrome: jest.requireActual<typeof HeaderChromeModule>(
    '@canopy/ui-app/code/activity/background-tasks-section',
  ).backgroundTasksHeaderChrome,
  BackgroundTasksList: ({
    tasks,
    actions,
  }: {
    tasks: readonly BackgroundTask[];
    actions?: BackgroundTaskHostActions;
  }): JSX.Element => (
    <button
      data-testid="select-process"
      onClick={() => actions?.onSelectedTaskChange?.(tasks[0] ?? null)}
    >
      Select
    </button>
  ),
}));
jest.mock('../WorkflowRunView', () => ({ WorkflowRunView: (): null => null }));

const reportUiState = jest.mocked(useCurrentUiStateReporter);
const process: BackgroundProcess = {
  id: 'process-1',
  chatId: 'chat-1',
  toolUseId: 'tool-1',
  taskId: 'task-1',
  toolName: 'Task',
  kind: 'agent',
  description: 'Review',
  status: 'running',
  startedAt: 1,
  updatedAt: 2,
  outputLines: [],
  canStop: true,
};

it('reports the shared background-process slice from the single panel owner', () => {
  const container = document.createElement('div');
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      <BackgroundProcessesSection
        projectId="project-1"
        worktreeId="worktree-1"
        processes={[process]}
      />,
    );
  });

  expect(reportUiState).toHaveBeenLastCalledWith(
    'chat.backgroundProcesses',
    expect.objectContaining({ total: 1, running: 1, detailModalOpen: false }),
  );

  act(() => {
    container
      .querySelector<HTMLButtonElement>('[data-testid="select-process"]')
      ?.click();
  });
  expect(reportUiState).toHaveBeenLastCalledWith(
    'chat.backgroundProcesses',
    expect.objectContaining({
      detailModalOpen: true,
      selectedTaskId: 'task-1',
    }),
  );

  act(() => root.unmount());
});
