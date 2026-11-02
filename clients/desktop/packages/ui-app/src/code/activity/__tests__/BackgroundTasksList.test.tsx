/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  BackgroundTaskStopOutcome,
  BackgroundTaskStopRequest,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import { BackgroundTasksList } from '../BackgroundTasksList';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const RUNNING_TASK: BackgroundTask = {
  id: 'bash-1',
  kind: 'bash',
  status: 'running',
  title: 'npm run dev',
  ownerToolUseId: 'bash-1',
  parentTaskId: null,
  startedAt: 1,
  settledAt: null,
  updatedAt: 2,
  lastDescription: null,
  summary: null,
  outputLines: [],
  canStop: true,
};

const STOP_TARGET: BackgroundTaskStopRequest = {
  projectId: 'project-one',
  worktreeId: 'worktree-one',
  chatId: 'chat-one',
  taskId: 'bash-1',
};

/** A client that can stop background tasks; every Stop answers `stop()`. */
function createStopClient(
  stop: (args: unknown) => Promise<BackgroundTaskStopOutcome>,
): CanopyClient {
  function command<K extends CommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']>;
  function command(
    name: CommandName,
    args: CommandMap[CommandName]['args'],
  ): Promise<unknown> {
    if (name === 'activity.stopBackgroundTask') {
      return stop(args);
    }
    return Promise.reject(new Error(`Unexpected command: ${name}`));
  }
  return {
    capabilities: {
      localExecution: false,
      terminalPty: false,
      fileSystemAccess: 'read',
      voice: false,
      settingsScope: 'api-keys-only',
      pipelines: 'read-only',
      routing: 'url',
      overviewNotifications: true,
      backgroundTaskStop: true,
    },
    query<K extends QueryName>(
      name: K,
      args: QueryMap[K]['args'],
    ): Promise<QueryMap[K]['result']> {
      void args;
      return Promise.reject(new Error(`Unexpected query: ${name}`));
    },
    command,
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
}

describe('BackgroundTasksList', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('is memoized for stable transcript props', () => {
    expect(BackgroundTasksList).toHaveProperty(
      '$$typeof',
      Symbol.for('react.memo'),
    );
  });

  it('disables Stop until the stopped task ends', async () => {
    let resolveStop: (outcome: BackgroundTaskStopOutcome) => void = () =>
      undefined;
    const stop = jest.fn(
      () =>
        new Promise<BackgroundTaskStopOutcome>((resolve) => {
          resolveStop = resolve;
        }),
    );
    const client = createStopClient(stop);
    const stopTarget = jest.fn(() => STOP_TARGET);
    const render = (task: BackgroundTask): void =>
      act(() =>
        root.render(
          <CanopyClientProvider client={client}>
            <BackgroundTasksList tasks={[task]} actions={{ stopTarget }} />
          </CanopyClientProvider>,
        ),
      );
    render(RUNNING_TASK);
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-bg-stop"]',
    );
    if (!button) throw new Error('Expected a stop button');
    expect(stopTarget).toHaveBeenCalledWith(RUNNING_TASK);
    act(() => button.click());
    act(() => button.click());
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(STOP_TARGET);
    expect(button.textContent).toBe('Stopping…');
    expect(button.disabled).toBe(true);
    await act(async () => {
      resolveStop('stopped');
      await Promise.resolve();
    });
    // A sent stop reads as stopping until the host reports the task ended.
    expect(button.textContent).toBe('Stopping…');
    expect(button.disabled).toBe(true);
    render({ ...RUNNING_TASK, status: 'stopped', settledAt: 3 });
    expect(
      container.querySelector('[data-testid="activity-bg-stop"]'),
    ).toBeNull();
  });

  it('reports selection and closes the modal when the selected task disappears', () => {
    const onSelectedTaskChange = jest.fn();
    const actions = { onSelectedTaskChange };
    act(() =>
      root.render(
        <BackgroundTasksList tasks={[RUNNING_TASK]} actions={actions} />,
      ),
    );
    act(() =>
      container
        .querySelector<HTMLElement>('[data-testid="activity-bg-item"]')
        ?.click(),
    );
    expect(onSelectedTaskChange).toHaveBeenCalledWith(RUNNING_TASK);
    expect(
      document.querySelector('[data-testid="bg-process-detail-modal"]'),
    ).not.toBeNull();
    act(() =>
      root.render(<BackgroundTasksList tasks={[]} actions={actions} />),
    );
    expect(onSelectedTaskChange).toHaveBeenLastCalledWith(null);
    expect(
      document.querySelector('[data-testid="bg-process-detail-modal"]'),
    ).toBeNull();
  });
});
