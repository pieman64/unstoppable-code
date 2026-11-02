/** @jest-environment jsdom */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CanopyClientProvider,
  backgroundTaskStopKey,
  backgroundTaskStopStoreFor,
} from '@canopy/app-state';
import type { BackgroundProcess } from '@canopy/desktop-shared/types';
import type { BackgroundTaskHostActions } from '@canopy/ui-app';
import { BackgroundTasksList } from '@canopy/ui-app/code/activity/BackgroundTasksList';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { backgroundProcessToTask } from '@/lib/background-tasks';
import { useGitHubStore } from '@/stores/githubStore';
import { useBackgroundTaskActions } from '../useBackgroundTaskActions';

function Harness({
  processes,
}: {
  readonly processes: readonly BackgroundProcess[];
}): JSX.Element {
  const actions = useBackgroundTaskActions({
    projectId: 'proj',
    worktreeId: 'wt',
    processes,
  });
  return (
    <BackgroundTasksList
      tasks={processes.map(backgroundProcessToTask)}
      actions={actions}
    />
  );
}

const handleSdkSystemEvent = jest.fn();
jest.mock('@/stores/activityStore', () => ({
  useActivityStore: (
    selector: (value: { handleSdkSystemEvent: jest.Mock }) => unknown,
  ): unknown => selector({ handleSdkSystemEvent }),
}));

jest.mock('../WorkflowRunView', () => ({ WorkflowRunView: (): null => null }));

const PROCESS: BackgroundProcess = {
  id: 'toolu_bg',
  chatId: 'chat-1',
  toolUseId: 'toolu_bg',
  taskId: 'task-1',
  toolName: 'Bash',
  kind: 'bash',
  description: 'npm run dev',
  status: 'running',
  startedAt: 1000,
  updatedAt: 2000,
  outputLines: [],
  canStop: true,
};

const STOPPED_PROCESS: BackgroundProcess = {
  ...PROCESS,
  status: 'stopped',
  canStop: false,
};

const readWorkflowRun = jest.fn().mockResolvedValue(null);
const stopBgProcess = jest.fn().mockResolvedValue('stopped');
Object.defineProperty(window, 'api', {
  configurable: true,
  value: {
    activity: {
      stopBgProcess,
      readWorkflowRun,
      onBgProcessOutput: jest.fn(() => jest.fn()),
    },
  },
});

const addToast = jest
  .spyOn(useGitHubStore.getState(), 'addToast')
  .mockImplementation((): void => undefined);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  handleSdkSystemEvent.mockClear();
  addToast.mockClear();
  stopBgProcess.mockReset();
  stopBgProcess.mockResolvedValue('stopped');
  const stopStore = backgroundTaskStopStoreFor(ipcCanopyClient);
  Object.keys(stopStore.getState().pending).forEach((key) =>
    stopStore.getState().clearPending(key),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderList(processes: readonly BackgroundProcess[] = [PROCESS]): void {
  act(() =>
    root.render(
      <CanopyClientProvider client={ipcCanopyClient}>
        <Harness processes={processes} />
      </CanopyClientProvider>,
    ),
  );
}

async function clickStop(): Promise<void> {
  renderList();
  const stop = container.querySelector<HTMLButtonElement>(
    '[data-testid="activity-bg-stop"]',
  );
  if (!stop) throw new Error('Expected a stop button');
  await act(async () => {
    stop.click();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

describe('useBackgroundTaskActions', () => {
  it('keeps a stopped task live and pending until its terminal update arrives', async () => {
    await clickStop();

    expect(stopBgProcess).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      taskId: 'task-1',
    });
    expect(container.textContent).toContain('running');
    expect(
      container.querySelector('[data-testid="activity-bg-stop"]')?.textContent,
    ).toBe('Stopping…');
    expect(
      backgroundTaskStopStoreFor(ipcCanopyClient).getState().pending[
        backgroundTaskStopKey({
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'chat-1',
          taskId: 'task-1',
        })
      ],
    ).toBeDefined();
    expect(handleSdkSystemEvent).not.toHaveBeenCalled();

    renderList([STOPPED_PROCESS]);

    expect(container.textContent).toContain('Stopped');
    expect(
      container.querySelector('[data-testid="activity-bg-stop"]'),
    ).toBeNull();
    expect(handleSdkSystemEvent).not.toHaveBeenCalled();
  });

  it('does not synthesize a stopped event for an already-finished outcome', async () => {
    stopBgProcess.mockResolvedValue('already-finished');

    await clickStop();

    expect(container.textContent).toContain('running');
    expect(
      container.querySelector('[data-testid="activity-bg-stop"]')?.textContent,
    ).toBe('Stop');
    expect(handleSdkSystemEvent).not.toHaveBeenCalled();
  });

  it('reports one failed stop without changing the process status', async () => {
    stopBgProcess.mockRejectedValue(new Error('Could not reach the task.'));

    await clickStop();

    expect(container.textContent).toContain('running');
    expect(handleSdkSystemEvent).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining('Could not reach the task.'),
      'error',
      undefined,
      { category: 'Chat', projectId: 'proj', worktreeId: 'wt' },
    );
  });

  it('reads the workflow run when its detail modal opens', async () => {
    const workflow: BackgroundProcess = {
      ...PROCESS,
      kind: 'workflow',
      runId: 'wf-1',
      transcriptDir: '/tmp/wf-1',
    };
    renderList([workflow]);
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="activity-bg-item"]')
        ?.click();
      await Promise.resolve();
    });
    expect(readWorkflowRun).toHaveBeenCalledWith({
      transcriptDir: '/tmp/wf-1',
      runId: 'wf-1',
    });
  });

  it('feeds the drawer workflow progress from the run, only while subscribed', async () => {
    const workflow: BackgroundProcess = {
      ...PROCESS,
      id: 'toolu_wf',
      kind: 'workflow',
      runId: 'wf-2',
      transcriptDir: '/tmp/wf-2',
    };
    const captured: { actions: BackgroundTaskHostActions | null } = {
      actions: null,
    };
    function Capture(): null {
      captured.actions = useBackgroundTaskActions({
        projectId: 'proj',
        worktreeId: 'wt',
        processes: [workflow, PROCESS],
      });
      return null;
    }
    act(() => root.render(<Capture />));
    readWorkflowRun.mockClear();
    const onProgress = jest.fn();
    const [workflowTask, shellTask] = [workflow, PROCESS].map(
      backgroundProcessToTask,
    );
    const subscribe = captured.actions?.subscribeWorkflowProgress;
    if (!subscribe || !workflowTask || !shellTask) {
      throw new Error('Expected workflow progress');
    }
    // A task with no run to read subscribes to nothing.
    subscribe(shellTask, onProgress)();
    expect(readWorkflowRun).not.toHaveBeenCalled();
    const unsubscribe = subscribe(workflowTask, onProgress);
    await act(async () => {
      await Promise.resolve();
    });
    expect(readWorkflowRun).toHaveBeenCalledWith({
      transcriptDir: '/tmp/wf-2',
      runId: 'wf-2',
    });
    unsubscribe();
  });
});
