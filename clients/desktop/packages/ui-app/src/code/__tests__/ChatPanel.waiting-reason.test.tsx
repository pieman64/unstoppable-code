/** @jest-environment jsdom */

import { act, type JSX, type ReactNode, useEffect } from 'react';
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
import type { PortalQueuedMessage } from '@canopy/protocol/portal';
import { QUEUED_MESSAGE_WAITING_REASON_COPY } from '@canopy/ui-shared';
import { ChatPanel } from '../ChatPanel';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../ChatComposer', () => ({
  ChatComposer: (): JSX.Element => <div data-testid="composer" />,
}));
// The queued list is ChatPanel's transcript footer; keep this test focused on
// its shared bubble rendering without loading the transcript's full UI.
jest.mock('../ChatTranscript', () => ({
  ChatTranscript: ({ footerSlot }: { footerSlot?: ReactNode }): JSX.Element => (
    <div data-testid="transcript">{footerSlot}</div>
  ),
}));

function Seeder(): null {
  // Zustand actions are closure-based and do not use `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const hydrate = useChatStore((state) => state.hydrate);
  useEffect(() => {
    const queuedMessages: PortalQueuedMessage[] = [
      {
        id: 'waiting',
        text: 'waiting follow-up',
        origin: 'portal',
        enqueuedAtMs: 1,
        waitingReason: 'steer_unavailable',
      },
      {
        id: 'ordinary',
        text: 'ordinary follow-up',
        origin: 'portal',
        enqueuedAtMs: 2,
      },
      {
        id: 'held-foreground',
        text: 'held foreground follow-up',
        origin: 'portal',
        enqueuedAtMs: 3,
        turnPhase: 'foreground',
        waitingReason: 'background_work',
      },
      {
        id: 'held-idle',
        text: 'held idle follow-up',
        origin: 'portal',
        enqueuedAtMs: 4,
        turnPhase: 'idle',
        waitingReason: 'background_work',
      },
    ];
    hydrate('c1', [], {
      route: {
        scope: 'worktree',
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      },
      queuedMessages,
    });
  }, [hydrate]);
  return null;
}

interface ClientCommandCall {
  readonly name: CommandName;
  readonly args: unknown;
}

function makeClient(commandCalls: ClientCommandCall[] = []): CanopyClient {
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
    command<K extends CommandName>(
      name: K,
      args: CommandMap[K]['args'],
    ): Promise<CommandMap[K]['result']> {
      commandCalls.push({ name, args });
      const result = Promise.reject(
        new Error(`unexpected command: ${String(name)}`),
      );
      void result.catch(() => {});
      return result;
    },
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
}

describe('ChatPanel queued-message waiting reason', () => {
  it('renders the host waiting reason and omits it for ordinary rows', async () => {
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
    await act(async () => {
      await Promise.resolve();
    });

    const bubbles = Array.from(
      container.querySelectorAll('[data-testid="queued-message-bubble"]'),
    );
    const waitingBubble = bubbles.find((bubble) =>
      bubble.textContent?.includes('waiting follow-up'),
    );
    const waitingReason = waitingBubble?.querySelector(
      '[data-testid="queued-message-waiting-reason"]',
    );
    expect(waitingReason?.getAttribute('data-waiting-reason')).toBe(
      'steer_unavailable',
    );
    expect(waitingReason?.textContent).toBe(
      QUEUED_MESSAGE_WAITING_REASON_COPY.steer_unavailable,
    );

    const ordinaryBubble = bubbles.find((bubble) =>
      bubble.textContent?.includes('ordinary follow-up'),
    );
    expect(ordinaryBubble).toBeDefined();
    expect(
      ordinaryBubble?.querySelector(
        '[data-testid="queued-message-waiting-reason"]',
      ),
    ).toBeNull();

    act(() => root.unmount());
  });

  it('runs rows held for background work now regardless of turn phase', async () => {
    const commandCalls: ClientCommandCall[] = [];
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyClientProvider client={makeClient(commandCalls)}>
          <Seeder />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const heldForeground = Array.from(
      container.querySelectorAll('[data-testid="queued-message-bubble"]'),
    ).find((bubble) =>
      bubble.textContent?.includes('held foreground follow-up'),
    );
    const heldIdle = Array.from(
      container.querySelectorAll('[data-testid="queued-message-bubble"]'),
    ).find((bubble) => bubble.textContent?.includes('held idle follow-up'));

    for (const bubble of [heldForeground, heldIdle]) {
      expect(bubble).toBeDefined();
      const waitingReason = bubble?.querySelector(
        '[data-testid="queued-message-waiting-reason"]',
      );
      expect(waitingReason?.getAttribute('data-waiting-reason')).toBe(
        'background_work',
      );
      expect(waitingReason?.textContent).toBe(
        QUEUED_MESSAGE_WAITING_REASON_COPY.background_work,
      );
      expect(
        bubble?.querySelector('[data-testid="queued-message-run-now"]'),
      ).not.toBeNull();
      expect(
        bubble?.querySelector('[data-testid="queued-message-retry"]'),
      ).toBeNull();
      expect(
        bubble?.querySelector('[data-testid="queued-message-interrupt"]'),
      ).toBeNull();
    }

    const runNow = heldForeground?.querySelector<HTMLButtonElement>(
      '[data-testid="queued-message-run-now"]',
    );
    if (!runNow) throw new Error('Missing queued-message-run-now button');
    await act(async () => {
      runNow.click();
      await Promise.resolve();
    });
    expect(commandCalls).toContainEqual({
      name: 'chat.queue.force',
      args: {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'c1',
        entryId: 'held-foreground',
      },
    });

    act(() => root.unmount());
  });
});
