/** @jest-environment jsdom */

/**
 * Compact queue (Labs): queued messages leave the transcript tail for one-line
 * rows in a list directly above the composer, as on desktop.
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
import type {
  ChatInputDeliveryView,
  ChatTurnPhase,
} from '@canopy/protocol/portal';
import {
  ChatComposerShell,
  CompactQueueProvider,
  Notice,
} from '@canopy/ui-shared/components';
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
  forceLockFirst = false,
  firstTurnPhase,
  inputDelivery,
}: {
  chatId?: string;
  withHistory?: boolean;
  withQueue?: boolean;
  withRoute?: boolean;
  forceLockFirst?: boolean;
  firstTurnPhase?: ChatTurnPhase;
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
                ...(forceLockFirst ? { forceLocked: true } : {}),
                ...(firstTurnPhase ? { turnPhase: firstTurnPhase } : {}),
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
  }, [
    chatId,
    firstTurnPhase,
    forceLockFirst,
    hydrate,
    inputDelivery,
    withHistory,
    withQueue,
    withRoute,
  ]);
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

describe('ChatPanel compact queue', () => {
  it('lists queued messages above the composer instead of in the transcript', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={makeClient()}>
          <CompactQueueProvider value>
            <Seeder />
            <ChatPanel chatId="c1" />
          </CompactQueueProvider>
        </CanopyClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const transcript = container.querySelector(
      '[data-testid="chat-transcript"]',
    );
    expect(transcript).not.toBeNull();
    expect(
      transcript?.querySelector('[data-testid="queued-message-bubble"]'),
    ).toBeNull();

    const list = container.querySelector('[role="list"]');
    expect(list?.getAttribute('aria-label')).toBe('Queued messages');
    expect(
      Array.from(
        list?.querySelectorAll('[data-testid="queued-message-preview"]') ?? [],
        (row) => row.textContent,
      ),
    ).toEqual(['queued one', 'queued two']);
    // The list sits right before the composer.
    const composer = container.querySelector('[data-testid="composer"]');
    expect(
      list && composer
        ? list.compareDocumentPosition(composer) &
            Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).toBeTruthy();
    expect(transcript?.contains(list)).toBe(false);
    // Cloud queues cannot be reordered yet, so the rows have no handle.
    expect(
      container.querySelector('[data-testid="queued-message-drag-handle"]'),
    ).toBeNull();
    act(() => root.unmount());
  });

  it('lands the list on the host composer box, under the notices above it', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    // A host composer stacks a notice above its box, as the desktop and
    // Portal composers do.
    const renderComposer = (): JSX.Element => (
      <div data-testid="host-composer">
        <Notice data-testid="host-notice">Chat state changed.</Notice>
        <ChatComposerShell dataTestId="host-composer-box">
          <textarea aria-label="Message" />
        </ChatComposerShell>
      </div>
    );
    act(() => {
      root.render(
        <CanopyClientProvider client={makeClient()}>
          <CompactQueueProvider value>
            <Seeder />
            <ChatPanel chatId="c1" renderComposer={renderComposer} />
          </CompactQueueProvider>
        </CanopyClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const stack = container.querySelector(
      '[data-testid="queued-message-stack"]',
    );
    const notice = container.querySelector('[data-testid="host-notice"]');
    const box = container.querySelector('[data-testid="host-composer-box"]');
    expect(stack).toBeInstanceOf(Element);
    expect(notice).toBeInstanceOf(Element);
    expect(box).toBeInstanceOf(Element);
    // Inside the composer, after its notice, and directly before the box,
    // so the card tucks under the box rather than across the notice.
    expect(
      container
        .querySelector('[data-testid="host-composer"]')
        ?.contains(stack ?? null),
    ).toBe(true);
    expect(
      notice && stack
        ? notice.compareDocumentPosition(stack) &
            Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).toBeTruthy();
    const slot = box?.previousElementSibling;
    expect(slot?.hasAttribute('data-composer-tray-slot')).toBe(true);
    expect(slot?.contains(stack ?? null)).toBe(true);
    expect(container.querySelectorAll('[role="list"]')).toHaveLength(1);
    act(() => root.unmount());
  });

  it('offers Send now only on rows the host lets force', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={makeClient()}>
          <CompactQueueProvider value>
            <Seeder forceLockFirst />
            <ChatPanel chatId="c1" />
          </CompactQueueProvider>
        </CanopyClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    const rows = Array.from(
      container.querySelectorAll('[data-testid="queued-message-bubble"]'),
    );
    expect(rows).toHaveLength(2);
    // A force-locked row (say, a rebound delivery the host already sent)
    // must not offer to send it again.
    expect(
      rows[0].querySelector('[data-testid="queued-message-interrupt"]'),
    ).toBeNull();
    expect(
      rows[1].querySelector('[data-testid="queued-message-interrupt"]'),
    ).toBeInstanceOf(Element);
    act(() => root.unmount());
  });

  it('offers Retry on a row outside a foreground turn', async () => {
    // With no foreground turn the row's force retries rather than interrupts;
    // the compact row preserves that distinction.
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={makeClient()}>
          <CompactQueueProvider value>
            <Seeder firstTurnPhase="idle" />
            <ChatPanel chatId="c1" />
          </CompactQueueProvider>
        </CanopyClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    const rows = Array.from(
      container.querySelectorAll('[data-testid="queued-message-bubble"]'),
    );
    expect(rows).toHaveLength(2);
    expect(
      rows[0].querySelector('[data-testid="queued-message-retry"]')
        ?.textContent,
    ).toBe('Try again');
    expect(
      rows[0].querySelector('[data-testid="queued-message-interrupt"]'),
    ).toBeNull();
    act(() => root.unmount());
  });
});
