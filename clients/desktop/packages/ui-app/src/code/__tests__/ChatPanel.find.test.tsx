/** @jest-environment jsdom */

import { act, type JSX, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import { useSurfaceFindStore } from '../../find/surface-find-store';
import { ChatPanel } from '../ChatPanel';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../ChatComposer', () => ({
  ChatComposer: (): JSX.Element => <div data-testid="composer" />,
}));
jest.mock('../ChatTranscript', () => ({
  ChatTranscript: ({ footerSlot }: { footerSlot?: ReactNode }): JSX.Element => (
    <div data-testid="chat-transcript">
      <p>hello alpha</p>
      {footerSlot}
    </div>
  ),
}));

function createClient(): CanopyClient {
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
    },
    query<K extends QueryName>(): Promise<QueryMap[K]['result']> {
      return Promise.reject(new Error('unused'));
    },
    command<K extends CommandName>(): Promise<CommandMap[K]['result']> {
      return Promise.reject(new Error('unused'));
    },
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
}

describe('ChatPanel find scope (CAN-3048)', () => {
  afterEach(() => {
    const store = useSurfaceFindStore.getState();
    store.close();
    for (const entry of Object.values(store.controllers)) {
      store.unregisterController(entry.controller);
    }
  });

  it('registers the chat with the find bar when given a scope, and not otherwise', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const render = (withScope: boolean): void => {
      act(() => {
        root.render(
          <CanopyClientProvider client={createClient()}>
            <ChatPanel
              chatId="c1"
              {...(withScope ? { findScope: { title: 'Launch plan' } } : {})}
            />
          </CanopyClientProvider>,
        );
      });
    };

    render(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(useSurfaceFindStore.getState().hasController('chat', 'c1')).toBe(
      false,
    );
    expect(container.querySelector('[data-find-surface="chat"]')).toBeNull();

    render(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(useSurfaceFindStore.getState().hasController('chat', 'c1')).toBe(
      true,
    );
    expect(useSurfaceFindStore.getState().controllers['chat:c1']?.title).toBe(
      'Launch plan',
    );
    expect(
      container
        .querySelector('[data-testid="chat-panel"]')
        ?.getAttribute('data-find-scope'),
    ).toBe('c1');

    act(() => root.unmount());
    container.remove();
    expect(useSurfaceFindStore.getState().hasController('chat', 'c1')).toBe(
      false,
    );
  });
});
