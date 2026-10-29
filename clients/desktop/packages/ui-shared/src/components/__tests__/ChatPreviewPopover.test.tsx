/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { ChatPreviewPopover } from '../ChatPreviewPopover';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('ChatPreviewPopover', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('blocks the portaled message previews from session replay and records chat titles', () => {
    act(() => {
      root.render(
        <ChatPreviewPopover
          anchorRect={new DOMRect(0, 0, 20, 20)}
          heading="Chats"
          rows={[
            {
              chatId: 'private-chat',
              title: 'Private chat title',
              providerType: 'claude',
              preview: 'Private message preview',
            },
          ]}
        />,
      );
    });

    const popover = document.body.lastElementChild;
    expect(popover).not.toBe(container);
    expect(popover?.textContent).toContain('Private message preview');
    expect(popover?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(false);
    const blocks = popover?.querySelectorAll(`.${REPLAY_BLOCK_CLASS}`) ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.textContent).toBe('Private message preview');
    expect(popover?.textContent).toContain('Private chat title');
    const title = Array.from(popover?.querySelectorAll('span') ?? []).find(
      (span) => span.textContent === 'Private chat title',
    );
    expect(title?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(
      Array.from(popover?.querySelectorAll('div') ?? [])
        .find((div) => div.textContent === 'Chats')
        ?.closest(`.${REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
  });

  it('renders GitHub branding for a Copilot chat preview', () => {
    act(() => {
      root.render(
        <ChatPreviewPopover
          anchorRect={new DOMRect(0, 0, 20, 20)}
          heading="Chats"
          rows={[
            {
              chatId: 'copilot-chat',
              title: 'Copilot review',
              providerType: 'copilot',
              preview: 'Ready',
            },
          ]}
        />,
      );
    });
    expect(
      document.body.querySelector(
        'svg[data-app-icon="true"][data-glyph="mark-github"]',
      ),
    ).not.toBeNull();
  });

  it('renders the Ollama logo for Ollama chats', () => {
    act(() => {
      root.render(
        <ChatPreviewPopover
          anchorRect={new DOMRect(0, 0, 20, 20)}
          heading="Chats"
          rows={[
            {
              chatId: 'ollama-chat',
              title: 'Local model',
              providerType: 'ollama',
              preview: 'Ready',
            },
          ]}
        />,
      );
    });

    const logo = document.body.querySelector('svg[fill-rule="evenodd"]');
    expect(logo).not.toBeNull();
  });

  it('prefers the host scheduleLabel over the generic scheduled time', () => {
    act(() => {
      root.render(
        <ChatPreviewPopover
          anchorRect={new DOMRect(0, 0, 20, 20)}
          heading="Scheduled"
          rows={[
            {
              chatId: 'scheduled-chat',
              title: 'Hourly report',
              providerType: 'claude',
              preview: 'Summarize the runner savings',
              scheduledAt: '2026-09-30T18:00:00.000Z',
              scheduleLabel: 'Every hour · next 6:00 PM',
            },
          ]}
        />,
      );
    });

    const text = document.body.textContent ?? '';
    expect(text).toContain('Every hour · next 6:00 PM');
    expect(text).not.toContain('Scheduled for');
  });

  it('falls back to the generic scheduled time without a scheduleLabel', () => {
    act(() => {
      root.render(
        <ChatPreviewPopover
          anchorRect={new DOMRect(0, 0, 20, 20)}
          heading="Scheduled"
          rows={[
            {
              chatId: 'scheduled-chat',
              title: 'Later',
              providerType: 'claude',
              preview: 'Send this later',
              scheduledAt: '2026-09-30T18:00:00.000Z',
            },
          ]}
        />,
      );
    });

    expect(document.body.textContent ?? '').toContain('Scheduled for');
  });
});
