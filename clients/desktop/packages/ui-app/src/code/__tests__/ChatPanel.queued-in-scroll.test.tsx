/** @jest-environment jsdom */

/**
 * CAN-2524: queued messages must render INSIDE the transcript's scroll
 * container.
 *
 * They used to be a flex sibling BELOW it, with no `shrink-0` and no height
 * bound, so a growing queue took height from the `flex-1` transcript until
 * scroll-back was unreachable. The desktop transcript has always rendered its
 * queue inside its own scroll area; this pins the shared panel to that.
 */
import { act, type JSX, useEffect } from 'react';
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
import type { ChatInputDeliveryView } from '@canopy/protocol/portal';
import { ChatPanel } from '../ChatPanel';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../ChatComposer', () => ({
  ChatComposer: (): JSX.Element => <div data-testid="composer" />,
}));

function Seeder({
  chatId = 'c1',
  withHistory = true,
  withQueue = true,
  withRoute = true,
  inputDelivery,
}: {
  chatId?: string;
  withHistory?: boolean;
  withQueue?: boolean;
  withRoute?: boolean;
  inputDelivery?: readonly ChatInputDeliveryView[];
}): null {
  // Zustand actions are closure-based and do not use `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const hydrate = useChatStore((state) => state.hydrate);
  useEffect(() => {
    hydrate(
      chatId,
      withHistory
        ? [
            {
              chatId,
              messageId: 'm1',
              role: 'user',
              status: 'complete',
              text: 'hello',
              createdAtMs: 1,
            },
          ]
        : [],
      {
        ...(withRoute
          ? {
              route: {
                scope: 'worktree',
                workspaceLocalId: 'ws',
                worktreeLocalId: 'wt',
              },
            }
          : {}),
        queuedMessages: withQueue
          ? [
              {
                id: 'q1',
                supersedesUserMessageId: 'user-q1',
                text: 'queued one',
                origin: 'portal',
                promptSource: 'human',
                enqueuedAtMs: 1,
              },
              {
                id: 'q2',
                supersedesUserMessageId: 'user-q2',
                text: 'queued two',
                origin: 'portal',
                promptSource: 'human',
                enqueuedAtMs: 2,
              },
            ]
          : [],
        ...(inputDelivery ? { inputDelivery } : {}),
      },
    );
  }, [chatId, hydrate, inputDelivery, withHistory, withQueue, withRoute]);
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
    // This test only renders and asserts DOM placement -- it needs no command
    // to succeed. Rejecting (rather than resolving a cast `undefined`) keeps
    // the stub honest: an accidental dependency on a command result surfaces
    // instead of silently reading `undefined`.
    command<K extends CommandName>(name: K): Promise<CommandMap[K]['result']> {
      return Promise.reject(
        new Error(`unexpected command in placement test: ${String(name)}`),
      );
    },
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
}

describe('ChatPanel queued messages placement', () => {
  it('renders the queue inside the transcript scroll container', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={makeClient()}>
          <Seeder />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    // Resolve the lazily-imported transcript chunk.
    await act(async () => {
      await Promise.resolve();
    });

    const transcript = container.querySelector(
      '[data-testid="chat-transcript"]',
    );
    const queue = container.querySelector(
      '[data-testid="queued-message-list"]',
    );

    expect(transcript).not.toBeNull();
    expect(queue).not.toBeNull();
    // The assertion that matters: containment, not mere presence. A sibling
    // below the scroll container also "renders", which is exactly the bug.
    expect(transcript?.contains(queue as Node)).toBe(true);

    act(() => {
      root.unmount();
    });
  });

  it('blocks the queued message text from session replay', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={makeClient()}>
          <Seeder chatId="replay-block" />
          <ChatPanel chatId="replay-block" />
        </CanopyClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const queued = Array.from(
      container.querySelectorAll('[data-testid="queued-message-bubble"]'),
    );
    expect(queued.map((bubble) => bubble.textContent)).toEqual([
      expect.stringContaining('queued one'),
      expect.stringContaining('queued two'),
    ]);
    for (const bubble of queued) {
      expect(bubble.closest('.ph-no-capture')).not.toBeNull();
    }
    // The transcript itself is not blocked by the queue's marker.
    expect(
      container
        .querySelector('[data-testid="chat-transcript"]')
        ?.closest('.ph-no-capture'),
    ).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it('renders a queued first send inside the transcript when there are no messages yet', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={makeClient()}>
          <Seeder chatId="first-send" withHistory={false} />
          <ChatPanel chatId="first-send" />
        </CanopyClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const transcript = container.querySelector(
      '[data-testid="chat-transcript"]',
    );
    const queue = container.querySelector(
      '[data-testid="queued-message-list"]',
    );

    expect(transcript).not.toBeNull();
    expect(queue).not.toBeNull();
    expect(transcript?.contains(queue)).toBe(true);
    // The queue lives in the reading column, not a full-width sibling.
    expect(
      queue?.parentElement?.className.includes(
        'max-w-[var(--chat-reading-width)]',
      ),
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="chat-transcript-empty"]'),
    ).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it('renders footerStatus under the queue inside the transcript', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={makeClient()}>
          <Seeder chatId="first-send-status" withHistory={false} />
          <ChatPanel
            chatId="first-send-status"
            footerStatus={<p data-testid="host-footer-status">Starting</p>}
          />
        </CanopyClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const transcript = container.querySelector(
      '[data-testid="chat-transcript"]',
    );
    const queue = container.querySelector(
      '[data-testid="queued-message-list"]',
    );
    const status = container.querySelector(
      '[data-testid="host-footer-status"]',
    );

    expect(transcript?.contains(status)).toBe(true);
    expect(queue?.nextElementSibling).toBe(status);

    act(() => {
      root.unmount();
    });
  });

  it('aligns the sibling queue of a host-supplied transcript with the reading column', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={makeClient()}>
          <Seeder chatId="host-transcript" withHistory={false} />
          <ChatPanel
            chatId="host-transcript"
            renderTranscript={() => <div data-testid="host-transcript" />}
          />
        </CanopyClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const queue = container.querySelector(
      '[data-testid="queued-message-list"]',
    );

    expect(queue).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="host-transcript"]')
        ?.contains(queue),
    ).toBe(false);
    expect(queue?.parentElement?.className).toContain(
      'max-w-[var(--chat-reading-width)]',
    );

    act(() => {
      root.unmount();
    });
  });

  it('hands a host-supplied transcript the chat and its queued prompt count', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const seen: {
      chatId?: string;
      queuedPromptCount?: number;
      queuedPromptMessageIds?: readonly string[];
    }[] = [];
    act(() => {
      root.render(
        <CanopyClientProvider client={makeClient()}>
          <Seeder chatId="host-queue-count" />
          <ChatPanel
            chatId="host-queue-count"
            renderTranscript={({
              chatId,
              queuedPromptCount,
              queuedPromptMessageIds,
            }) => {
              seen.push({ chatId, queuedPromptCount, queuedPromptMessageIds });
              return <div data-testid="host-transcript" />;
            }}
          />
        </CanopyClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The host's transcript sees queued sends, so a queued prompt re-arms
    // bottom-follow and its later dequeue is not mistaken for a fresh send.
    expect(seen.at(-1)).toEqual({
      chatId: 'host-queue-count',
      queuedPromptCount: 2,
      queuedPromptMessageIds: ['user-q1', 'user-q2'],
    });

    act(() => {
      root.unmount();
    });
  });

  it('keeps the host loading placeholder, with the queue aligned below, while history loads', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={makeClient()}>
          <Seeder chatId="loading-history" withHistory={false} />
          <ChatPanel
            chatId="loading-history"
            emptyState={<p data-testid="host-history-loading">Loading</p>}
          />
        </CanopyClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const placeholder = container.querySelector(
      '[data-testid="chat-transcript-empty"]',
    );
    const queue = container.querySelector(
      '[data-testid="queued-message-list"]',
    );
    expect(
      placeholder?.querySelector('[data-testid="host-history-loading"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="chat-transcript"]'),
    ).toBeNull();
    expect(queue?.parentElement?.className).toContain(
      'max-w-[var(--chat-reading-width)]',
    );

    act(() => {
      root.unmount();
    });
  });

  it('treats input-delivery rows without a queue target as no queue tail', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={makeClient()}>
          <Seeder
            chatId="untargeted-delivery"
            withHistory={false}
            withQueue={false}
            withRoute={false}
            inputDelivery={[
              {
                id: 'd1',
                revision: 1,
                state: 'pending',
                text: 'delivering',
                attachmentCount: 0,
                canWithdraw: false,
              },
            ]}
          />
          <ChatPanel chatId="untargeted-delivery" />
        </CanopyClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="chat-transcript-empty"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="queued-message-list"]'),
    ).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it('keeps the empty state when queue actions are disabled for input-delivery rows', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={makeClient()}>
          <Seeder
            chatId="view-only-delivery"
            withHistory={false}
            withQueue={false}
            inputDelivery={[
              {
                id: 'd1',
                revision: 1,
                state: 'pending',
                text: 'delivering',
                attachmentCount: 0,
                canWithdraw: false,
              },
            ]}
          />
          <ChatPanel chatId="view-only-delivery" queueActionsEnabled={false} />
        </CanopyClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="chat-transcript-empty"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="queued-message-list"]'),
    ).toBeNull();

    act(() => {
      root.unmount();
    });
  });
});
