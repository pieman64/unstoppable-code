/**
 * @jest-environment jsdom
 */
/**
 * Tests for the shared {@link ChatTab} close affordance: server-rendered
 * markup plus the disabled close button's DOM behavior.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { ChatTab } from '../ChatTab';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('ChatTab', () => {
  it('keeps the hover-revealed close button visible on coarse-pointer (touch) devices', () => {
    // The close button rests at `opacity-0` and reveals on `group-hover`,
    // which never fires on touch — without the `pointer-coarse` escape hatch
    // a phone user cannot close a chat tab at all (CAN-1268).
    const html = renderToString(
      <ChatTab label="Chat one" onClose={() => {}} />,
    );
    expect(html).toContain('aria-label="Close tab"');
    expect(html).toContain('pointer-coarse:opacity-100');
  });

  it('renders no close button when the tab is pinned', () => {
    const html = renderToString(
      <ChatTab label="Chat one" onClose={() => {}} pinned />,
    );
    expect(html).not.toContain('aria-label="Close tab"');
  });

  it('keeps the close button hover-revealed but inert when close is disabled without a reason', () => {
    const html = renderToString(
      <ChatTab
        label="Chat one"
        dataTestId="chat-tab-one"
        onClose={() => {}}
        closeDisabled
      />,
    );
    expect(html).toContain('data-testid="chat-tab-one-close"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('opacity-0');
    expect(html).toContain('group-hover:opacity-100');
  });

  it('shows an always-visible disabled close button with a reason', () => {
    const html = renderToString(
      <ChatTab
        label="Chat one"
        dataTestId="chat-tab-one"
        onClose={() => {}}
        closeDisabled
        closeDisabledReason="Stop its delegates to close this chat"
      />,
    );
    expect(html).toContain('data-close-disabled="true"');
    expect(html).toContain('aria-disabled="true"');
    // Not hover-revealed: the reason is not otherwise visible on the tab.
    expect(html).not.toContain('opacity-0');
  });
});

describe('ChatTab disabled close (DOM)', () => {
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

  it('ignores clicks, never selects the tab, and explains itself in a tooltip', () => {
    const onClose = jest.fn();
    const onSelect = jest.fn();
    act(() => {
      root.render(
        <ChatTab
          label="Chat one"
          dataTestId="chat-tab-one"
          onClose={onClose}
          onSelect={onSelect}
          closeDisabled
          closeDisabledReason="Stop its delegates to close this chat"
        />,
      );
    });
    const close = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-tab-one-close"]',
    );
    expect(close).not.toBeNull();

    act(() => {
      close?.click();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();

    act(() => {
      close?.parentElement?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    expect(document.body.textContent).toContain(
      'Stop its delegates to close this chat',
    );
  });

  it('still closes when close is not disabled', () => {
    const onClose = jest.fn();
    act(() => {
      root.render(
        <ChatTab
          label="Chat one"
          dataTestId="chat-tab-one"
          onClose={onClose}
        />,
      );
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="chat-tab-one-close"]')
        ?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
