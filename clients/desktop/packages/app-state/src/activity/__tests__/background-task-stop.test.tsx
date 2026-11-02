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
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyClientProvider } from '../../CanopyClientProvider';
import {
  backgroundTaskStopKey,
  backgroundTaskStopStoreFor,
  clearEndedBackgroundTaskStops,
  requestBackgroundTaskStop,
  useBackgroundTaskStop,
} from '../background-task-stop';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const REQUEST: BackgroundTaskStopRequest = {
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
  stopResponses: readonly Promise<BackgroundTaskStopOutcome>[] = [],
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
  };
  let responseIndex = 0;

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
      const response = stopResponses[responseIndex];
      responseIndex += 1;
      return response ?? Promise.resolve('stopped');
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

function StopStateProbe({ live }: { readonly live: boolean }): JSX.Element {
  const { stopping, stop } = useBackgroundTaskStop(REQUEST, live);
  return (
    <button
      type="button"
      data-testid="stop-state"
      onClick={(): void => {
        void stop();
      }}
    >
      {stopping ? 'Stopping…' : 'Stop'}
    </button>
  );
}

describe('background task stop requests', () => {
  it('sends the exact request and leaves stopped pending', async () => {
    const deferred = createDeferred<BackgroundTaskStopOutcome>();
    const fake = createFakeClient([deferred.promise]);
    const key = backgroundTaskStopKey(REQUEST);
    const pending = requestBackgroundTaskStop(fake.client, REQUEST);

    expect(fake.calls).toEqual([
      {
        name: 'activity.stopBackgroundTask',
        args: REQUEST,
      },
    ]);
    expect(
      backgroundTaskStopStoreFor(fake.client).getState().pending[key],
    ).toBeDefined();

    deferred.resolve('stopped');
    await expect(pending).resolves.toBe('stopped');
    expect(
      backgroundTaskStopStoreFor(fake.client).getState().pending[key],
    ).toBeDefined();
  });

  it.each(['already-finished', 'session-ended'] as const)(
    'clears pending when the host reports %s',
    async (outcome) => {
      const fake = createFakeClient([Promise.resolve(outcome)]);
      const key = backgroundTaskStopKey(REQUEST);

      await expect(
        requestBackgroundTaskStop(fake.client, REQUEST),
      ).resolves.toBe(outcome);
      expect(
        backgroundTaskStopStoreFor(fake.client).getState().pending[key],
      ).toBeUndefined();
    },
  );

  it('clears pending and rethrows a host rejection', async () => {
    const failure = new Error('host failed to stop task');
    const fake = createFakeClient([Promise.reject(failure)]);
    const key = backgroundTaskStopKey(REQUEST);

    await expect(requestBackgroundTaskStop(fake.client, REQUEST)).rejects.toBe(
      failure,
    );
    expect(
      backgroundTaskStopStoreFor(fake.client).getState().pending[key],
    ).toBeUndefined();
  });

  it('does not let a late outcome of an older stop clear a newer one', async () => {
    const older = createDeferred<BackgroundTaskStopOutcome>();
    const newer = createDeferred<BackgroundTaskStopOutcome>();
    const fake = createFakeClient([older.promise, newer.promise]);
    const key = backgroundTaskStopKey(REQUEST);
    const olderRequest = requestBackgroundTaskStop(fake.client, REQUEST);
    const newerRequest = requestBackgroundTaskStop(fake.client, REQUEST);

    older.resolve('already-finished');
    await expect(olderRequest).resolves.toBe('already-finished');
    expect(
      backgroundTaskStopStoreFor(fake.client).getState().pending[key],
    ).toBeDefined();

    newer.resolve('stopped');
    await expect(newerRequest).resolves.toBe('stopped');
    expect(
      backgroundTaskStopStoreFor(fake.client).getState().pending[key],
    ).toBeDefined();
  });

  it('keeps different task keys independent', async () => {
    const first = createDeferred<BackgroundTaskStopOutcome>();
    const second = createDeferred<BackgroundTaskStopOutcome>();
    const fake = createFakeClient([first.promise, second.promise]);
    const secondRequest: BackgroundTaskStopRequest = {
      ...REQUEST,
      taskId: 'task-two',
    };
    const firstKey = backgroundTaskStopKey(REQUEST);
    const secondKey = backgroundTaskStopKey(secondRequest);
    const firstPending = requestBackgroundTaskStop(fake.client, REQUEST);
    const secondPending = requestBackgroundTaskStop(fake.client, secondRequest);
    const store = backgroundTaskStopStoreFor(fake.client);

    first.resolve('already-finished');
    await expect(firstPending).resolves.toBe('already-finished');
    expect(store.getState().pending[firstKey]).toBeUndefined();
    expect(store.getState().pending[secondKey]).toBeDefined();

    second.resolve('already-finished');
    await expect(secondPending).resolves.toBe('already-finished');
    expect(store.getState().pending[secondKey]).toBeUndefined();
  });

  it('clears only ended tasks in the exact chat', async () => {
    const ended: BackgroundTaskStopRequest = {
      ...REQUEST,
      taskId: 'ended-in-chat',
    };
    const live: BackgroundTaskStopRequest = {
      ...REQUEST,
      taskId: 'live-in-chat',
    };
    const otherChat: BackgroundTaskStopRequest = {
      ...REQUEST,
      chatId: 'other-chat',
      taskId: 'other-chat-task',
    };
    const otherWorktree: BackgroundTaskStopRequest = {
      ...REQUEST,
      worktreeId: 'other-worktree',
      chatId: 'other-worktree-chat',
      taskId: 'other-worktree-task',
    };
    const requests: readonly BackgroundTaskStopRequest[] = [
      ended,
      live,
      otherChat,
      otherWorktree,
    ];
    const fake = createFakeClient(
      requests.map(() => Promise.resolve('stopped')),
    );
    for (const request of requests) {
      await requestBackgroundTaskStop(fake.client, request);
    }

    clearEndedBackgroundTaskStops(
      fake.client,
      {
        projectId: REQUEST.projectId,
        worktreeId: REQUEST.worktreeId,
        chatId: REQUEST.chatId,
      },
      new Set(['live-in-chat']),
    );

    const pending = backgroundTaskStopStoreFor(fake.client).getState().pending;
    expect(pending[backgroundTaskStopKey(ended)]).toBeUndefined();
    expect(pending[backgroundTaskStopKey(live)]).toBeDefined();
    expect(pending[backgroundTaskStopKey(otherChat)]).toBeDefined();
    expect(pending[backgroundTaskStopKey(otherWorktree)]).toBeDefined();
  });

  it('clears every pending stop in the exact chat when the live set is empty', async () => {
    const first: BackgroundTaskStopRequest = {
      ...REQUEST,
      taskId: 'first-task',
    };
    const second: BackgroundTaskStopRequest = {
      ...REQUEST,
      taskId: 'second-task',
    };
    const otherChat: BackgroundTaskStopRequest = {
      ...REQUEST,
      chatId: 'other-chat',
      taskId: 'other-task',
    };
    const fake = createFakeClient([
      Promise.resolve('stopped'),
      Promise.resolve('stopped'),
      Promise.resolve('stopped'),
    ]);
    await requestBackgroundTaskStop(fake.client, first);
    await requestBackgroundTaskStop(fake.client, second);
    await requestBackgroundTaskStop(fake.client, otherChat);

    clearEndedBackgroundTaskStops(
      fake.client,
      {
        projectId: REQUEST.projectId,
        worktreeId: REQUEST.worktreeId,
        chatId: REQUEST.chatId,
      },
      new Set(),
    );

    const pending = backgroundTaskStopStoreFor(fake.client).getState().pending;
    expect(pending[backgroundTaskStopKey(first)]).toBeUndefined();
    expect(pending[backgroundTaskStopKey(second)]).toBeUndefined();
    expect(pending[backgroundTaskStopKey(otherChat)]).toBeDefined();
  });

  it('reports stopping and clears it when live turns false', () => {
    const deferred = createDeferred<BackgroundTaskStopOutcome>();
    const fake = createFakeClient([deferred.promise]);
    const key = backgroundTaskStopKey(REQUEST);
    const container = document.createElement('div');
    document.body.append(container);
    const root: Root = createRoot(container);
    const render = (live: boolean): void => {
      act(() => {
        root.render(
          <CanopyClientProvider client={fake.client}>
            <StopStateProbe live={live} />
          </CanopyClientProvider>,
        );
      });
    };
    render(true);
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="stop-state"]',
    );

    expect(button?.textContent).toBe('Stop');
    act(() => button?.click());
    expect(button?.textContent).toBe('Stopping…');
    expect(
      backgroundTaskStopStoreFor(fake.client).getState().pending[key],
    ).toBeDefined();

    render(false);
    expect(button?.textContent).toBe('Stop');
    expect(
      backgroundTaskStopStoreFor(fake.client).getState().pending[key],
    ).toBeUndefined();
    render(true);
    expect(button?.textContent).toBe('Stop');

    act(() => root.unmount());
    container.remove();
  });
});
