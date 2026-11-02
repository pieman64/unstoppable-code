/** @jest-environment jsdom */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyClientProvider } from '@canopy/app-state';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { useLiveBackgroundTaskStore } from '@/stores/liveBackgroundTaskStore';
import { AgentBlock } from '../AgentBlock';
import {
  NativeTaskStopContext,
  type NativeTaskStopControls,
} from '../native-task-stop';
import type { ToolResult } from '../types';

jest.mock('@/stores/activityStore', () => ({
  useActivityStore: (): undefined => undefined,
}));

const TARGET = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};
const CONTROLS: NativeTaskStopControls = {
  target: TARGET,
  onError: jest.fn(),
};
const FINISHED_RESULT: ToolResult = {
  output: 'Finished the investigation.',
  isError: false,
};
const stopBgProcess = jest.fn().mockResolvedValue('stopped');

Object.defineProperty(window, 'api', {
  configurable: true,
  value: { activity: { stopBgProcess } },
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stopBgProcess.mockReset();
  stopBgProcess.mockResolvedValue('stopped');
  useLiveBackgroundTaskStore.getState().reset();
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

function setLiveTask(): void {
  useLiveBackgroundTaskStore.getState().applyPush({
    ...TARGET,
    sessionActive: true,
    liveTasks: [{ taskId: 'native-task-1', toolUseId: 'tool-1' }],
  });
}

function renderAgentBlock(options: {
  context?: NativeTaskStopControls | null;
  nativeTaskStop?: boolean;
  result?: ToolResult;
}): void {
  act(() =>
    root.render(
      <CanopyClientProvider client={ipcCanopyClient}>
        <NativeTaskStopContext.Provider value={options.context ?? null}>
          <AgentBlock
            toolUseId="tool-1"
            chatId="chat-1"
            subagentType="general-purpose"
            description="Investigate the issue"
            prompt="Look into it"
            runInBackground
            result={options.result}
            subBlocks={[]}
            nativeTaskStop={options.nativeTaskStop}
            renderSubBlock={(): null => null}
          />
        </NativeTaskStopContext.Provider>
      </CanopyClientProvider>,
    ),
  );
}

describe('AgentBlock native task Stop', () => {
  it('stops the live task for the exact chat target', async () => {
    setLiveTask();
    renderAgentBlock({ context: CONTROLS, nativeTaskStop: true });

    const stop = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-task-stop"]',
    );
    expect(stop?.getAttribute('aria-label')).toBe('Stop agent');
    if (!stop) throw new Error('Expected the native agent stop button');

    await act(async () => {
      stop.click();
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });

    expect(stopBgProcess).toHaveBeenCalledWith({
      ...TARGET,
      taskId: 'native-task-1',
    });
  });

  it('does not show Stop without a matching live task', () => {
    renderAgentBlock({ context: CONTROLS, nativeTaskStop: true });
    expect(
      container.querySelector('[data-testid="agent-task-stop"]'),
    ).toBeNull();
  });

  it('does not show Stop without a native Claude stop context', () => {
    setLiveTask();
    renderAgentBlock({ context: null, nativeTaskStop: true });
    expect(
      container.querySelector('[data-testid="agent-task-stop"]'),
    ).toBeNull();
  });

  it('does not opt in the codex_agent rendering path', () => {
    setLiveTask();
    renderAgentBlock({ context: CONTROLS });
    expect(
      container.querySelector('[data-testid="agent-task-stop"]'),
    ).toBeNull();
  });

  it('does not show Stop for a completed row', () => {
    setLiveTask();
    renderAgentBlock({
      context: CONTROLS,
      nativeTaskStop: true,
      result: FINISHED_RESULT,
    });
    expect(
      container.querySelector('[data-testid="agent-task-stop"]'),
    ).toBeNull();
  });
});
