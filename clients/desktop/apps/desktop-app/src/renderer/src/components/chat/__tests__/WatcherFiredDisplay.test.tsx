import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import { UserBubble } from '../UserBubble';
import { QueuedMessageBubble } from '../QueuedMessageBubble';
import { hostQueueViewsToQueuedMessages } from '@/stores/chat/queue-mirror';
import type { DisplayMessage } from '../types';
import type { QueuedChatMessage } from '@/stores/chatStore';

jest.mock('../ChatBlockRenderer', () => ({
  ChatBlockRenderer: (): JSX.Element => <span>Message body</span>,
}));

/**
 * The sent and queued bubbles share one surface: `bg-quaternary` under a
 * `shadow-sm` plus an inset hairline on a line token, which is what keeps the
 * bubble separated from a near-black `bg-base` in dark mode. The info variant
 * swaps only the tint and keeps the hairline.
 */
const BUBBLE_HAIRLINE =
  'inset-ring-[length:var(--border-hairline)] inset-ring-line-secondary';

function userMessage(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id: 'user-1',
    role: 'user',
    blocks: [{ type: 'text', text: 'Canopy watcher fired.' }],
    timestamp: 1,
    ...overrides,
  };
}

describe('watcher-fired user bubble', () => {
  it('renders the broadcast title line and info tint for watcher messages', () => {
    const html = renderToStaticMarkup(
      <UserBubble
        message={userMessage({
          watcherFired: { kind: 'Pipeline completion (Deploy)' },
        })}
      />,
    );

    expect(html).toContain('data-testid="watcher-fired-title"');
    expect(html).toContain('Pipeline completion (Deploy) watcher has fired');
    expect(html).toContain('bg-info-subtle');
    expect(html).toContain(BUBBLE_HAIRLINE);
    expect(html).not.toContain('rounded-xl bg-quaternary');
  });

  it('keeps the neutral surface and no title line for user-typed messages', () => {
    const html = renderToStaticMarkup(<UserBubble message={userMessage()} />);

    expect(html).not.toContain('data-testid="watcher-fired-title"');
    expect(html).toContain('rounded-xl bg-quaternary');
    expect(html).toContain(BUBBLE_HAIRLINE);
    expect(html).not.toContain('bg-info-subtle');
  });
});

describe('steering user bubble', () => {
  it('renders the steering icon and title above a picked-up steering message', () => {
    const html = renderToStaticMarkup(
      <UserBubble
        message={userMessage({
          blocks: [
            {
              type: 'text',
              text: 'Use the latest test result',
              steering: { startsTurn: false, rootUserMessageId: 'root-1' },
            },
          ],
        })}
      />,
    );

    expect(html).toContain('data-testid="steering-title"');
    expect(html).toContain('data-testid="steering-title-icon"');
    expect(html).toContain('>Steering<');
    expect(html).toContain('data-glyph="chevrons-up"');
  });
});

describe('watcher-fired queued bubble', () => {
  const baseQueued: QueuedChatMessage = {
    hostQueueEntryId: 'queue-1',
    origin: 'desktop',
    enqueuedAtMs: 1,
    text: 'Canopy watcher fired.',
  };

  it('renders the broadcast title line and muted info tint for watcher rows', () => {
    const html = renderToStaticMarkup(
      <QueuedMessageBubble
        message={{
          ...baseQueued,
          watcherFired: { kind: 'Hook (CI guard)' },
        }}
        index={0}
        onClear={(): void => undefined}
        onEdit={(): void => undefined}
      />,
    );

    expect(html).toContain('data-testid="watcher-fired-title"');
    expect(html).toContain('Hook (CI guard) watcher has fired');
    // Same vertical inset as the sent bubble: the queued state must not read
    // taller than the message it becomes.
    expect(html).toContain('px-3 py-1.5');
    expect(html).not.toMatch(/\bp-3\b/);
    expect(html).toContain('bg-info-subtle');
    expect(html).toContain(BUBBLE_HAIRLINE);
    expect(html).not.toContain('rounded-xl bg-quaternary');
    // Watcher rows stay editable and deletable like any queued message.
    expect(html).toContain('data-testid="queued-message-edit"');
    expect(html).toContain('data-testid="queued-message-cancel"');
  });

  it('reads the marker from renderer-local queued dispatch options', () => {
    const html = renderToStaticMarkup(
      <QueuedMessageBubble
        message={{
          text: 'Canopy watcher fired.',
          dispatchOptions: {
            watcherFired: { kind: 'Chat completion (Fix login bug)' },
          },
        }}
        index={0}
        onClear={(): void => undefined}
      />,
    );

    expect(html).toContain('Chat completion (Fix login bug) watcher has fired');
    expect(html).toContain('bg-info-subtle');
  });

  // Queued rows share the sent bubble's `bg-quaternary` + hairline surface;
  // the queued state reads from the dimmer text and its own controls, not a
  // separate background.
  it('keeps the default surface and no title line for user-typed queued rows', () => {
    const html = renderToStaticMarkup(
      <QueuedMessageBubble
        message={baseQueued}
        index={0}
        onClear={(): void => undefined}
      />,
    );

    expect(html).not.toContain('data-testid="watcher-fired-title"');
    expect(html).toContain('rounded-xl bg-quaternary');
    expect(html).toContain(BUBBLE_HAIRLINE);
    expect(html).not.toContain('bg-info-subtle');
  });
});

describe('host queue mirror', () => {
  it('carries watcher and steering eligibility from host queue views into mirror rows', () => {
    const rows = hostQueueViewsToQueuedMessages([
      {
        id: 'queue-1',
        text: 'Canopy watcher fired.',
        origin: 'desktop',
        enqueuedAtMs: 42,
        watcherFired: { kind: 'GitHub workflow run (acme/api)' },
      },
      {
        id: 'queue-2',
        text: 'typed follow-up',
        origin: 'desktop',
        enqueuedAtMs: 43,
        canSteer: true,
      },
    ]);

    expect(rows[0].watcherFired).toEqual({
      kind: 'GitHub workflow run (acme/api)',
    });
    expect(rows[1].watcherFired).toBeUndefined();
    expect(rows[0].canSteer).toBeUndefined();
    expect(rows[1].canSteer).toBe(true);
  });
});
