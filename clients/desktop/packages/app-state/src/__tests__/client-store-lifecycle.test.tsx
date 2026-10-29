/** @jest-environment jsdom */
import { StrictMode, act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyClient,
  CommandMap,
  CommandName,
  DomainEventMap,
  DomainEventName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import {
  CanopyClientProvider,
  useWorkspaceCapabilities,
} from '../CanopyClientProvider';
import { useChatStore } from '../chat/create-chat-store';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function trackedClient(): {
  client: CanopyClient;
  subscribed: jest.Mock;
  unsubscribed: jest.Mock;
} {
  const subscribed = jest.fn();
  const unsubscribed = jest.fn();
  const client: CanopyClient = {
    capabilities: {
      localExecution: false,
      terminalPty: false,
      fileSystemAccess: 'read',
      voice: false,
      settingsScope: 'api-keys-only',
      pipelines: 'crud-only',
      routing: 'url',
    },
    query<K extends QueryName>(): Promise<QueryMap[K]['result']> {
      return Promise.reject(new Error('unused'));
    },
    command<K extends CommandName>(): Promise<CommandMap[K]['result']> {
      return Promise.reject(new Error('unused'));
    },
    subscribe<K extends DomainEventName>(
      name: K,
      handler: (event: DomainEventMap[K]) => void,
    ): Unsubscribe {
      void handler;
      subscribed(name);
      return (): void => {
        unsubscribed(name);
      };
    },
  };
  return { client, subscribed, unsubscribed };
}

function Consumer(): JSX.Element {
  useChatStore((state) => state.threads);
  return <></>;
}

function WorkspaceCapabilitiesConsumer({
  localId,
}: {
  readonly localId: string;
}): JSX.Element {
  const capabilities = useWorkspaceCapabilities(localId);
  return <output>{capabilities.workspaceRemoval ?? 'unavailable'}</output>;
}

describe('CanopyClientProvider store lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('disposes client-bound stores on client swap and provider unmount', async () => {
    const first = trackedClient();
    const second = trackedClient();

    act(() => {
      root.render(
        <CanopyClientProvider client={first.client}>
          <Consumer />
        </CanopyClientProvider>,
      );
    });
    expect(first.subscribed).toHaveBeenCalledWith('chat.message');

    act(() => {
      root.render(
        <CanopyClientProvider client={second.client}>
          <Consumer />
        </CanopyClientProvider>,
      );
    });
    await act(async () => Promise.resolve());
    expect(first.unsubscribed).toHaveBeenCalledTimes(1);
    expect(second.subscribed).toHaveBeenCalledWith('chat.message');

    act(() => root.unmount());
    await act(async () => Promise.resolve());
    expect(second.unsubscribed).toHaveBeenCalledTimes(1);
  });

  it('keeps one live subscription through StrictMode effect replay', async () => {
    const tracked = trackedClient();

    act(() => {
      root.render(
        <StrictMode>
          <CanopyClientProvider client={tracked.client}>
            <Consumer />
          </CanopyClientProvider>
        </StrictMode>,
      );
    });
    await act(async () => Promise.resolve());

    expect(tracked.subscribed).toHaveBeenCalledTimes(1);
    expect(tracked.unsubscribed).not.toHaveBeenCalled();
  });

  it('resolves row capabilities and falls back to the flat set in one hook', () => {
    const rowCapabilities = {
      ...trackedClient().client.capabilities,
      workspaceRemoval: 'archive',
    } as const;
    const resolved = trackedClient();
    const rowAwareClient: CanopyClient = {
      ...resolved.client,
      capabilitiesFor: (localId: string) =>
        localId === 'cloud:ws:a'
          ? rowCapabilities
          : resolved.client.capabilities,
    };

    act(() => {
      root.render(
        <CanopyClientProvider client={rowAwareClient}>
          <WorkspaceCapabilitiesConsumer localId="cloud:ws:a" />
        </CanopyClientProvider>,
      );
    });
    expect(container.textContent).toBe('archive');

    act(() => {
      root.render(
        <CanopyClientProvider client={resolved.client}>
          <WorkspaceCapabilitiesConsumer localId="cloud:ws:a" />
        </CanopyClientProvider>,
      );
    });
    expect(container.textContent).toBe('unavailable');
  });
});
