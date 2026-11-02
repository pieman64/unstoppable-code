/** @jest-environment jsdom */
import type {
  BackgroundTaskStopOutcome,
  BackgroundTaskStopRequest,
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TaskStopAction } from '../TaskStopAction';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const TARGET: BackgroundTaskStopRequest = {
  projectId: 'project-one',
  worktreeId: 'worktree-one',
  chatId: 'chat-one',
  taskId: 'task-one',
};

interface FakeCanopyClient {
  readonly client: CanopyClient;
  readonly calls: Array<{
    readonly name: CommandName;
    readonly args: CommandMap[CommandName]['args'];
  }>;
}

function createFakeClient(
  stopResponse: () => Promise<BackgroundTaskStopOutcome>,
  backgroundTaskStop?: boolean,
): FakeCanopyClient {
  const calls: FakeCanopyClient['calls'] = [];
  const capabilities: CanopyCapabilities = {
    localExecution: false,
    terminalPty: false,
    fileSystemAccess: 'read',
    voice: false,
    settingsScope: 'api-keys-only',
    pipelines: 'read-only',
    routing: 'url',
    overviewNotifications: true,
    ...(backgroundTaskStop === undefined ? {} : { backgroundTaskStop }),
  };

  function command<K extends CommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']>;
  function command(
    name: CommandName,
    args: CommandMap[CommandName]['args'],
  ): Promise<unknown> {
    calls.push({ name, args });
    if (name === 'activity.stopBackgroundTask') {
      return stopResponse();
    }
    return Promise.reject(new Error(`Unexpected command: ${name}`));
  }

  const client: CanopyClient = {
    capabilities,
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

  return { client, calls };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value): void => resolvePromise?.(value),
    reject: (reason): void => rejectPromise?.(reason),
  };
}

interface MountedClientTree {
  readonly container: HTMLDivElement;
  readonly render: (children: JSX.Element) => void;
  readonly unmount: () => void;
}

function mountWithClient(
  client: CanopyClient,
  children: JSX.Element,
): MountedClientTree {
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  const render = (nextChildren: JSX.Element): void => {
    act(() => {
      root.render(
        <CanopyClientProvider client={client}>
          {nextChildren}
        </CanopyClientProvider>,
      );
    });
  };
  render(children);
  return {
    container,
    render,
    unmount: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function neverResolve(): Promise<BackgroundTaskStopOutcome> {
  return new Promise((): void => {});
}

function stopAction(
  options: {
    readonly target?: BackgroundTaskStopRequest;
    readonly live?: boolean;
    readonly dataTestId?: string;
    readonly onError?: (error: unknown) => void;
  } = {},
): JSX.Element {
  return (
    <TaskStopAction
      target={options.target ?? TARGET}
      live={options.live ?? true}
      accessibleLabel="Stop agent"
      dataTestId={options.dataTestId ?? 'task-stop'}
      onError={options.onError}
    />
  );
}

describe('TaskStopAction', () => {
  it('renders nothing when the capability is unset', () => {
    const fake = createFakeClient(neverResolve, undefined);
    const mounted = mountWithClient(fake.client, stopAction());

    expect(
      mounted.container.querySelector('[data-testid="task-stop"]'),
    ).toBeNull();

    mounted.unmount();
  });

  it('renders nothing when the task is not live', () => {
    const fake = createFakeClient(neverResolve, true);
    const mounted = mountWithClient(fake.client, stopAction({ live: false }));

    expect(
      mounted.container.querySelector('[data-testid="task-stop"]'),
    ).toBeNull();

    mounted.unmount();
  });

  it('sends the exact task request and shows a disabled Stopping… button', () => {
    const deferred = createDeferred<BackgroundTaskStopOutcome>();
    const fake = createFakeClient(() => deferred.promise, true);
    const mounted = mountWithClient(fake.client, stopAction());
    const button = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="task-stop"]',
    );

    expect(button?.textContent).toBe('Stop');
    act(() => button?.click());

    expect(fake.calls).toEqual([
      {
        name: 'activity.stopBackgroundTask',
        args: TARGET,
      },
    ]);
    expect(button?.textContent).toBe('Stopping…');
    expect(button?.disabled).toBe(true);

    mounted.unmount();
  });

  it('keeps a stopped task pending until live becomes false', async () => {
    const deferred = createDeferred<BackgroundTaskStopOutcome>();
    const fake = createFakeClient(() => deferred.promise, true);
    const mounted = mountWithClient(fake.client, stopAction());
    const button = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="task-stop"]',
    );

    act(() => button?.click());
    await act(async () => {
      deferred.resolve('stopped');
      await deferred.promise;
    });
    expect(button?.textContent).toBe('Stopping…');

    mounted.render(stopAction({ live: false }));
    expect(
      mounted.container.querySelector('[data-testid="task-stop"]'),
    ).toBeNull();

    mounted.render(stopAction({ live: true }));
    expect(
      mounted.container.querySelector('[data-testid="task-stop"]')?.textContent,
    ).toBe('Stop');

    mounted.unmount();
  });

  it.each(['already-finished', 'session-ended'] as const)(
    'returns to Stop when the host reports %s',
    async (outcome) => {
      const deferred = createDeferred<BackgroundTaskStopOutcome>();
      const fake = createFakeClient(() => deferred.promise, true);
      const mounted = mountWithClient(fake.client, stopAction());
      const button = mounted.container.querySelector<HTMLButtonElement>(
        '[data-testid="task-stop"]',
      );

      act(() => button?.click());
      await act(async () => {
        deferred.resolve(outcome);
        await deferred.promise;
      });

      expect(button?.textContent).toBe('Stop');
      expect(button?.disabled).toBe(false);

      mounted.unmount();
    },
  );

  it('returns to Stop and reports a rejection once', async () => {
    const deferred = createDeferred<BackgroundTaskStopOutcome>();
    const fake = createFakeClient(() => deferred.promise, true);
    const onError = jest.fn<void, [unknown]>();
    const mounted = mountWithClient(fake.client, stopAction({ onError }));
    const button = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="task-stop"]',
    );
    const failure = new Error('stop failed');

    act(() => button?.click());
    await act(async () => {
      deferred.reject(failure);
      await deferred.promise.catch(() => undefined);
    });

    expect(button?.textContent).toBe('Stop');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);

    mounted.unmount();
  });

  it('keeps different tasks pending independently', async () => {
    const first = createDeferred<BackgroundTaskStopOutcome>();
    const second = createDeferred<BackgroundTaskStopOutcome>();
    const responses = [first, second];
    let callIndex = 0;
    const fake = createFakeClient(() => {
      const response = responses[callIndex];
      callIndex += 1;
      return response?.promise ?? Promise.resolve('already-finished');
    }, true);
    const secondTarget: BackgroundTaskStopRequest = {
      ...TARGET,
      taskId: 'task-two',
    };
    const mounted = mountWithClient(
      fake.client,
      <div>
        {stopAction({ dataTestId: 'first-stop' })}
        {stopAction({ target: secondTarget, dataTestId: 'second-stop' })}
      </div>,
    );
    const buttons = mounted.container.querySelectorAll<HTMLButtonElement>(
      'button[data-testid$="-stop"]',
    );

    act(() => buttons[0]?.click());
    act(() => buttons[1]?.click());
    expect(buttons[0]?.textContent).toBe('Stopping…');
    expect(buttons[1]?.textContent).toBe('Stopping…');

    await act(async () => {
      first.resolve('already-finished');
      await first.promise;
    });
    expect(buttons[0]?.textContent).toBe('Stop');
    expect(buttons[1]?.textContent).toBe('Stopping…');

    mounted.unmount();
  });

  it('shares pending state across mounts of the same task', () => {
    const deferred = createDeferred<BackgroundTaskStopOutcome>();
    const fake = createFakeClient(() => deferred.promise, true);
    const mounted = mountWithClient(
      fake.client,
      <div>
        {stopAction({ dataTestId: 'first-copy' })}
        {stopAction({ dataTestId: 'second-copy' })}
      </div>,
    );
    const first = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="first-copy"]',
    );
    const second = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="second-copy"]',
    );

    act(() => first?.click());

    expect(first?.textContent).toBe('Stopping…');
    expect(second?.textContent).toBe('Stopping…');
    expect(second?.disabled).toBe(true);

    mounted.unmount();
  });
});
