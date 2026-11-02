/** @jest-environment jsdom */

/**
 * A queued first send must stay on screen while the lazily imported
 * transcript chunk is still loading: the Suspense fallback carries the queue
 * tail and the host status in the reading column.
 */
import { act, type JSX, use, useEffect } from 'react';
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

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const neverLoads = new Promise<never>(() => {});

jest.mock('../ChatComposer', () => ({
  ChatComposer: (): JSX.Element => <div data-testid="composer" />,
}));
// Suspends forever so the panel stays on its Suspense fallback.
jest.mock('../ChatTranscript', () => ({
  ChatTranscript: (): JSX.Element => use(neverLoads),
}));

function Seeder(): null {
  // Zustand actions are closure-based and do not use `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const hydrate = useChatStore((state) => state.hydrate);
  useEffect(() => {
    hydrate('first-send', [], {
      route: {
        scope: 'worktree',
        workspaceLocalId: 'ws',
        worktreeLocalId: 'wt',
      },
      queuedMessages: [
        { id: 'q1', text: 'queued one', origin: 'portal', enqueuedAtMs: 1 },
      ],
    });
  }, [hydrate]);
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

describe('ChatPanel lazy transcript fallback', () => {
  it('keeps a queued first send and the host status visible while the transcript loads', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={makeClient()}>
          <Seeder />
          <ChatPanel
            chatId="first-send"
            footerStatus={<p data-testid="host-footer-status">Starting</p>}
          />
        </CanopyClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const fallback = container.querySelector(
      '[data-testid="chat-transcript-loading"]',
    );
    const queue = fallback?.querySelector(
      '[data-testid="queued-message-list"]',
    );
    expect(queue).not.toBeNull();
    expect(queue?.nextElementSibling).toBe(
      fallback?.querySelector('[data-testid="host-footer-status"]'),
    );
    expect(queue?.parentElement?.className).toContain(
      'max-w-[var(--chat-reading-width)]',
    );

    act(() => {
      root.unmount();
    });
  });
});
