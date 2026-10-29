/** @jest-environment jsdom */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BackgroundProcess } from '@canopy/desktop-shared/types';
import { BackgroundTasksList } from '@canopy/ui-app/code/activity/BackgroundTasksList';
import { backgroundProcessToTask } from '@/lib/background-tasks';
import {
  useBackgroundTaskActions,
  extractTerminalStatusFromStopError,
} from '../useBackgroundTaskActions';

function Harness({
  process = PROCESS,
}: {
  readonly process?: BackgroundProcess;
}): JSX.Element {
  const actions = useBackgroundTaskActions({
    projectId: 'proj',
    worktreeId: 'wt',
    processes: [process],
  });
  return (
    <BackgroundTasksList
      tasks={[backgroundProcessToTask(process)]}
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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  handleSdkSystemEvent.mockClear();
  stopBgProcess.mockReset();
  stopBgProcess.mockResolvedValue('stopped');
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

async function clickStop(): Promise<void> {
  act(() => root.render(<Harness />));
  const stop = container.querySelector<HTMLButtonElement>(
    '[data-testid="activity-bg-stop"]',
  );
  if (!stop) throw new Error('Expected a stop button');
  await act(async () => {
    stop.click();
    await Promise.resolve();
  });
}

describe('extractTerminalStatusFromStopError', () => {
  it('treats a missing provider session as an already-stopped task', () => {
    expect(
      extractTerminalStatusFromStopError(
        new Error(
          "Error invoking remote method 'activity:stop-bg-process': Error: No active session is available to stop that task",
        ),
      ),
    ).toBe('stopped');
  });

  it('treats an unknown task as an already-stopped task', () => {
    expect(
      extractTerminalStatusFromStopError(new Error('Unknown task task-1')),
    ).toBe('stopped');
    expect(
      extractTerminalStatusFromStopError(new Error('No such task: task-1')),
    ).toBe('stopped');
  });

  it('keeps recognizing the provider "is not running" and status shapes', () => {
    expect(
      extractTerminalStatusFromStopError(
        new Error('Task task-1 is not running'),
      ),
    ).toBe('stopped');
    expect(
      extractTerminalStatusFromStopError(
        new Error('task failed, status: killed'),
      ),
    ).toBe('killed');
  });

  it('leaves an unrelated failure unresolved', () => {
    expect(
      extractTerminalStatusFromStopError(
        new Error(
          'Stopping individual tasks is not supported for Codex sessions',
        ),
      ),
    ).toBeNull();
  });
});

describe('useBackgroundTaskActions', () => {
  it('marks the card stopped when main has no session left to stop', async () => {
    stopBgProcess.mockRejectedValue(
      new Error('No active session is available to stop that task'),
    );

    await clickStop();

    expect(handleSdkSystemEvent).toHaveBeenCalledWith(
      'proj',
      'wt',
      'chat-1',
      expect.objectContaining({
        subtype: 'task_notification',
        task_id: 'task-1',
        status: 'stopped',
      }),
    );
  });

  it('keeps reporting a successful stop', async () => {
    await clickStop();

    expect(stopBgProcess).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      taskId: 'task-1',
    });
    expect(handleSdkSystemEvent).toHaveBeenCalledWith(
      'proj',
      'wt',
      'chat-1',
      expect.objectContaining({
        subtype: 'task_notification',
        task_id: 'task-1',
        status: 'stopped',
      }),
    );
  });

  it('does not overwrite the precise notification main emits for a dead task', async () => {
    stopBgProcess.mockResolvedValue('already-finished');

    await clickStop();

    expect(handleSdkSystemEvent).not.toHaveBeenCalled();
  });

  it('reads the workflow run when its detail modal opens', async () => {
    const workflow: BackgroundProcess = {
      ...PROCESS,
      kind: 'workflow',
      runId: 'wf-1',
      transcriptDir: '/tmp/wf-1',
    };
    act(() => root.render(<Harness process={workflow} />));
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
});
