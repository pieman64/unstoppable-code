/** @jest-environment jsdom */

/**
 * A message the host is delivering to an idle agent renders as sent: a user
 * bubble in the transcript with the ordinary working row under it, never as a
 * queued draft. Messages waiting behind it stay queued.
 */
import { act, type JSX, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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
import { ChatPanel } from '../ChatPanel';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../ChatComposer', () => ({
  ChatComposer: (): JSX.Element => <div data-testid="composer" />,
}));

const DELIVERING: PortalQueuedMessage = {
  id: 'conversation-v2-request:request-1',
  text: 'hi from muse',
  origin: 'portal',
  promptSource: 'human',
  enqueuedAtMs: 2,
  editLocked: true,
  forceLocked: true,
  delivering: true,
};

const WAITING: PortalQueuedMessage = {
  id: 'conversation-v2-request:request-2',
  text: 'and another thing',
  origin: 'portal',
  promptSource: 'human',
  enqueuedAtMs: 3,
};

function Seeder({
  queuedMessages,
}: {
  queuedMessages: readonly PortalQueuedMessage[];
}): null {
  // Zustand actions are closure-based and do not use `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const hydrate = useChatStore((state) => state.hydrate);
  useEffect(() => {
    hydrate(
      'c1',
      [
        {
          chatId: 'c1',
          messageId: 'm1',
          role: 'user',
          status: 'complete',
          text: 'howdy',
          createdAtMs: 1,
        },
      ],
      {
        route: {
          scope: 'worktree',
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        },
        queuedMessages: [...queuedMessages],
      },
    );
  }, [hydrate, queuedMessages]);
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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

async function render(
  queuedMessages: readonly PortalQueuedMessage[],
  footerStatus?: JSX.Element,
): Promise<void> {
  act(() => {
    root.render(
      <CanopyClientProvider client={makeClient()}>
        <Seeder queuedMessages={queuedMessages} />
        <ChatPanel
          chatId="c1"
          {...(footerStatus === undefined ? {} : { footerStatus })}
        />
      </CanopyClientProvider>,
    );
  });
  // Resolve the lazily-imported transcript chunk.
  await act(async () => {
    await Promise.resolve();
  });
}

function sentBubbles(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-testid="chat-transcript"] [data-testid="chat-message"]',
    ),
    (node) => node.textContent ?? '',
  );
}

describe('ChatPanel delivering messages', () => {
  it('renders a delivering message as sent, with the working row under it', async () => {
    await render([DELIVERING]);

    expect(
      container.querySelector('[data-testid="queued-message-bubble"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('Queued');
    const bubbles = sentBubbles();
    expect(bubbles).toHaveLength(2);
    expect(bubbles[1]).toContain('hi from muse');

    const working = container.querySelector(
      '[data-testid="chat-transcript-streaming"]',
    );
    const delivering = container.querySelector(
      '[data-testid="chat-transcript-delivering"]',
    );
    expect(working).not.toBeNull();
    expect(delivering?.contains(working)).toBe(true);
  });

  it('keeps messages waiting behind it queued', async () => {
    await render([DELIVERING, WAITING]);

    const queued = container.querySelectorAll(
      '[data-testid="queued-message-bubble"]',
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.textContent).toContain('and another thing');
    expect(sentBubbles().at(-1)).toContain('hi from muse');
  });

  it("leaves the working row to the host's own status", async () => {
    await render(
      [DELIVERING],
      <div data-testid="host-status">Starting chat…</div>,
    );

    expect(
      container.querySelector('[data-testid="chat-transcript-streaming"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="host-status"]'),
    ).not.toBeNull();
    expect(sentBubbles().at(-1)).toContain('hi from muse');
  });
});
