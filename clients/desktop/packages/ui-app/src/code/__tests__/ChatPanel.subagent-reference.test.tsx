/** @jest-environment jsdom */
import type { ChatAgentSentInfo } from '@canopy/protocol/portal';

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
import { withSubagentReference } from '@canopy/ui-shared';
import { ChatPanel } from '../ChatPanel';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../ChatComposer', () => ({
  ChatComposer: (): JSX.Element => <div data-testid="composer" />,
}));
jest.mock('../ChatTranscript', () => ({
  ChatTranscript: ({ footerSlot }: { footerSlot?: ReactNode }): JSX.Element => (
    <div data-testid="transcript">{footerSlot}</div>
  ),
}));

interface QueueSeed {
  readonly agentSent?: ChatAgentSentInfo;
  readonly id: string;
  readonly text: string;
}

function Seeder({
  messages,
}: {
  readonly messages: readonly QueueSeed[];
}): null {
  // Zustand actions are closure-based and do not use `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const hydrate = useChatStore((state) => state.hydrate);
  useEffect(() => {
    hydrate('c1', [], {
      route: {
        scope: 'worktree',
        workspaceLocalId: 'ws',
        worktreeLocalId: 'wt',
      },
      queuedMessages: messages.map((message, index) => ({
        ...message,
        origin: 'portal' as const,
        enqueuedAtMs: index + 1,
      })),
    });
  }, [hydrate, messages]);
  return null;
}

async function flushLazyTranscript(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function createClient(): CanopyClient {
  function command<K extends CommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']>;
  function command(
    name: CommandName,
    args: CommandMap[CommandName]['args'],
  ): Promise<unknown> {
    void args;
    if (name === 'chat.queue.set_edit_lock') return Promise.resolve();
    return Promise.reject(new Error('unused'));
  }

  return {
    capabilities: {
      localExecution: false,
      terminalPty: false,
      fileSystemAccess: 'read',
      voice: false,
      settingsScope: 'limited',
      pipelines: 'view-only',
      routing: 'portal',
      overviewNotifications: true,
    },
    query<K extends QueryName>(): Promise<QueryMap[K]['result']> {
      return Promise.reject(new Error('unused'));
    },
    command,
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
}

describe('ChatPanel queued subagent references', () => {
  it('renders a reference chip above its display body and leaves ordinary text unchanged', async () => {
    const text = withSubagentReference(
      { kind: 'managed', id: 'child-1', title: 'Review source' },
      'Queued for the parent.',
    );
    const messages: readonly QueueSeed[] = [
      { id: 'q1', text },
      { id: 'q2', text: 'An ordinary queued message.' },
    ];
    const container = document.createElement('div');
    const root = createRoot(container);
    act((): void => {
      root.render(
        <CanopyClientProvider client={createClient()}>
          <Seeder messages={messages} />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();

    const bubbles = container.querySelectorAll(
      '[data-testid="queued-message-bubble"]',
    );
    expect(bubbles).toHaveLength(2);
    expect(
      container.querySelectorAll('[data-testid="subagent-reference-chip"]'),
    ).toHaveLength(1);
    expect(bubbles[0]?.textContent).toContain('Queued for the parent.');
    expect(bubbles[1]?.textContent).toContain('An ordinary queued message.');
    expect(container.textContent).not.toContain(
      'canopy-subagent:managed:child-1',
    );

    act((): void => root.unmount());
  });

  it('uses the receiving route for queued agent titles and keeps the marker while editing', async () => {
    const messages: readonly QueueSeed[] = [
      {
        id: 'agent-queued',
        text: 'Visible body',
        agentSent: {
          sender: {
            kind: 'project',
            projectType: 'code',
            projectId: 'ws',
            taskId: 'task',
            chatId: 'origin',
          },
          chatTitle: 'Captured title',
          projectLabel: 'Same project label',
        },
      },
    ];
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() =>
      root.render(
        <CanopyClientProvider client={createClient()}>
          <Seeder messages={messages} />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      ),
    );
    await flushLazyTranscript();
    expect(
      container.querySelector('[data-testid="agent-sent-title"]')?.textContent,
    ).toBe('Captured title');
    expect(container.textContent).not.toContain('Same project label');
    await act(async (): Promise<void> => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="queued-message-edit"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector(
        '[data-testid="queued-message-editor"] [data-testid="agent-sent-title"]',
      )?.textContent,
    ).toBe('Captured title');
    act(() => root.unmount());
  });

  it('keeps the original encoded text in the queued-message editor', async () => {
    const text = withSubagentReference(
      { kind: 'managed', id: 'child-1', title: 'Review source' },
      'Queued for the parent.',
    );
    const messages: readonly QueueSeed[] = [{ id: 'q1', text }];
    const container = document.createElement('div');
    const root = createRoot(container);
    act((): void => {
      root.render(
        <CanopyClientProvider client={createClient()}>
          <Seeder messages={messages} />
          <ChatPanel chatId="c1" />
        </CanopyClientProvider>,
      );
    });
    await flushLazyTranscript();

    await act(async (): Promise<void> => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="queued-message-edit"]')
        ?.click();
      await Promise.resolve();
    });

    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[data-testid="queued-message-edit-input"]',
      )?.value,
    ).toBe(text);

    act((): void => root.unmount());
  });
});
