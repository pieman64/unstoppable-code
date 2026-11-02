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
  requestBackgroundTaskStop,
} from '@canopy/app-state';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { useLiveBackgroundTaskStore } from '@/stores/liveBackgroundTaskStore';
import {
  deriveNativeTaskStopTarget,
  useReconcileNativeTaskStops,
  type NativeTaskStopTarget,
} from '../native-task-stop';

const TARGET: NativeTaskStopTarget = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

const REQUEST = { ...TARGET, taskId: 'task-1' };
const stopBgProcess = jest.fn().mockResolvedValue('stopped');
const listLiveBgTasks = jest.fn().mockResolvedValue({
  chats: {
    'chat-1': {
      sessionActive: true,
      liveTasks: [{ taskId: 'task-1', toolUseId: 'tool-1' }],
    },
  },
});

Object.defineProperty(window, 'api', {
  configurable: true,
  value: { activity: { stopBgProcess, listLiveBgTasks } },
});

function Reconciler({ target }: { target: NativeTaskStopTarget }): JSX.Element {
  useReconcileNativeTaskStops(target);
  return <div data-testid="task-stop-reconciler" />;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stopBgProcess.mockReset();
  stopBgProcess.mockResolvedValue('stopped');
  listLiveBgTasks.mockReset();
  listLiveBgTasks.mockResolvedValue({
    chats: {
      'chat-1': {
        sessionActive: true,
        liveTasks: [{ taskId: 'task-1', toolUseId: 'tool-1' }],
      },
    },
  });
  useLiveBackgroundTaskStore.getState().reset();
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

function renderReconciler(): void {
  act(() =>
    root.render(
      <CanopyClientProvider client={ipcCanopyClient}>
        <Reconciler target={TARGET} />
      </CanopyClientProvider>,
    ),
  );
}

function pendingStop(): number | undefined {
  return backgroundTaskStopStoreFor(ipcCanopyClient).getState().pending[
    backgroundTaskStopKey(REQUEST)
  ];
}

describe('deriveNativeTaskStopTarget', () => {
  it('only enables a writable Claude target', () => {
    expect(
      deriveNativeTaskStopTarget({
        readOnly: false,
        target: TARGET,
        lockedHarness: 'claude',
      }),
    ).toBe(TARGET);
    expect(
      deriveNativeTaskStopTarget({
        readOnly: true,
        target: TARGET,
        lockedHarness: 'claude',
      }),
    ).toBeNull();
    expect(
      deriveNativeTaskStopTarget({
        readOnly: false,
        target: TARGET,
        lockedHarness: 'codex',
      }),
    ).toBeNull();
    expect(
      deriveNativeTaskStopTarget({
        readOnly: false,
        target: null,
        lockedHarness: 'claude',
      }),
    ).toBeNull();
  });
});

describe('useReconcileNativeTaskStops', () => {
  it('keeps a stop pending while live and clears it after the mirror drops the task', async () => {
    const mirror = useLiveBackgroundTaskStore.getState();
    mirror.applyPush({
      ...TARGET,
      sessionActive: true,
      liveTasks: [{ taskId: 'task-1', toolUseId: 'tool-1' }],
    });
    await mirror.refreshWorktree(TARGET.projectId, TARGET.worktreeId);
    renderReconciler();

    await act(async () => {
      await requestBackgroundTaskStop(ipcCanopyClient, REQUEST);
    });

    expect(stopBgProcess).toHaveBeenCalledWith(REQUEST);
    expect(pendingStop()).toBeDefined();

    act(() => {
      useLiveBackgroundTaskStore.getState().applyPush({
        ...TARGET,
        sessionActive: true,
        liveTasks: [],
      });
    });

    expect(pendingStop()).toBeUndefined();
  });

  it('does not infer that a missing task ended before the worktree is hydrated', async () => {
    await act(async () => {
      await requestBackgroundTaskStop(ipcCanopyClient, REQUEST);
    });
    renderReconciler();

    expect(pendingStop()).toBeDefined();

    act(() => {
      useLiveBackgroundTaskStore.getState().applyPush({
        ...TARGET,
        sessionActive: false,
        liveTasks: [],
      });
    });

    expect(pendingStop()).toBeDefined();
  });
});
