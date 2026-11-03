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
import { CompactQueueProvider } from '@canopy/ui-shared/components/chat/QueuedMessageRow';
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
      pipelines: 'crud-only',
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

function Seeder({ held }: { readonly held: boolean }): null {
  // Zustand actions are closure-based and do not use `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const hydrate = useChatStore((state) => state.hydrate);
  useEffect(() => {
    const queuedMessages: PortalQueuedMessage[] = [
      {
        id: 'try-it',
        text: 'try it prompt',
        origin: 'portal',
        enqueuedAtMs: 1,
        turnPhase: 'idle',
        retryable: true,
        ...(held
          ? { retryBlockedReason: 'insufficient_credits' as const }
          : {}),
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
  }, [held, hydrate]);
  return null;
}

const FORCE_CALL = {
  name: 'chat.queue.force',
  args: {
    projectId: 'ws-1',
    worktreeId: 'wt-1',
    chatId: 'c1',
    entryId: 'try-it',
  },
};

async function renderPanel(
  commandCalls: ClientCommandCall[],
  compact: boolean,
  creditNoticeHandled = false,
): Promise<{
  container: HTMLDivElement;
  lift: () => Promise<void>;
  unmount: () => void;
}> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = makeClient(commandCalls);
  const render = async (held: boolean): Promise<void> => {
    act(() => {
      root.render(
        <CanopyClientProvider client={client}>
          <CompactQueueProvider value={compact}>
            <Seeder held={held} />
            <ChatPanel
              chatId="c1"
              queuedCreditNoticeHandled={creditNoticeHandled}
            />
          </CompactQueueProvider>
        </CanopyClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
  };
  await render(true);
  return {
    container,
    // Funding confirmed: the host republishes the row without its hold.
    lift: () => render(false),
    unmount: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function click(button: HTMLButtonElement | null): Promise<void> {
  if (!button) throw new Error('Missing button');
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

describe('ChatPanel credit-held queued retry', () => {
  it('leaves recovery copy with a host-supplied notice while retaining the disabled row', async () => {
    const { container, unmount } = await renderPanel([], false, true);
    expect(container.textContent).not.toContain(
      'Add credits, then click Retry',
    );
    expect(
      container
        .querySelector('[data-testid="queued-message-retry"]')
        ?.getAttribute('aria-disabled'),
    ).toBe('true');
    unmount();
  });

  it.each([
    ['transcript bubble', false, 'queued-message-retry', 'Try again'],
    ['compact row', true, 'queued-message-retry', 'Try again'],
  ] as const)(
    'keeps the %s disabled until the hold lifts, then sends once',
    async (_surface, compact, testId, label) => {
      const commandCalls: ClientCommandCall[] = [];
      const { container, lift, unmount } = await renderPanel(
        commandCalls,
        compact,
      );
      const action = (): HTMLButtonElement | null =>
        container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);

      expect(action()?.textContent).toBe(label);
      expect(container.textContent).toContain(
        'Add credits, then click Try again',
      );
      expect(action()?.getAttribute('aria-disabled')).toBe('true');
      expect(
        container.querySelector('[data-testid="queued-message-steer"]'),
      ).toBeNull();
      if (!compact) {
        expect(
          container.querySelector('[data-testid="queued-message-interrupt"]'),
        ).toBeNull();
      }
      await click(action());
      expect(commandCalls).toEqual([]);

      await lift();
      expect(action()?.hasAttribute('aria-disabled')).toBe(false);
      expect(commandCalls).toEqual([]);
      await click(action());
      expect(commandCalls).toEqual([FORCE_CALL]);

      unmount();
    },
  );
});
