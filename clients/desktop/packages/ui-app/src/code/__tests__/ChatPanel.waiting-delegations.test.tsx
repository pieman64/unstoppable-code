/** @jest-environment jsdom */

import { act, type JSX, useContext, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import { CanopyClientProvider, useChatStore } from '@canopy/app-state';
import { ChatPanel } from '../ChatPanel';
import { ChatWaitingDelegationsContext } from '../ChatPartView';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../ChatComposer', () => ({
  ChatComposer: (): JSX.Element => <div data-testid="composer" />,
}));
// The transcript reads the waiting set from context; render it as text so the
// test checks the seam between the store and the delegate cards.
jest.mock('../ChatTranscript', () => ({
  ChatTranscript: function WaitingProbe(): JSX.Element {
    const waiting = useContext(ChatWaitingDelegationsContext);
    return (
      <div data-testid="waiting-probe">{Array.from(waiting).join(',')}</div>
    );
  },
}));

function Seeder({ ids }: { ids: readonly string[] }): null {
  // Zustand actions are closure-based and do not use `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const hydrate = useChatStore((state) => state.hydrate);
  useEffect(() => {
    // A queued row keeps the transcript mounted in an otherwise empty chat.
    hydrate('c1', [], {
      waitingDelegationIds: ids,
      queuedMessages: [
        { id: 'ordinary', text: 'Later', origin: 'portal', enqueuedAtMs: 1 },
      ],
    });
  }, [hydrate, ids]);
  return null;
}

function makeClient(): CanopyClient {
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
    command<K extends CommandName>(name: K): Promise<CommandMap[K]['result']> {
      return Promise.reject(new Error(`unexpected command: ${String(name)}`));
    },
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
}

describe('ChatPanel waiting delegations', () => {
  it('gives the transcript the thread waiting ids and clears them once claimed', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const client = makeClient();
    const waiting = ['delegate-1'];
    const render = async (ids: readonly string[]): Promise<void> => {
      act(() => {
        root.render(
          <CanopyClientProvider client={client}>
            <Seeder ids={ids} />
            <ChatPanel chatId="c1" />
          </CanopyClientProvider>,
        );
      });
      await act(async () => {
        await Promise.resolve();
      });
    };
    const probe = (): string | null | undefined =>
      container.querySelector('[data-testid="waiting-probe"]')?.textContent;

    await render(waiting);
    expect(probe()).toBe('delegate-1');

    await render([]);
    expect(probe()).toBe('');

    act(() => root.unmount());
  });
});
