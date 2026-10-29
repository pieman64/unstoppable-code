/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SidebarRemoteControlSubtitle,
  sidebarRemoteControlSubtitleLabel,
  type SidebarRemoteControlStatus,
} from '../SidebarAccountSubtitle';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('SidebarAccountSubtitle', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderStatus(status: SidebarRemoteControlStatus): HTMLElement {
    act(() => {
      root.render(<SidebarRemoteControlSubtitle status={status} />);
    });
    const subtitle = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-account-remote-control-subtitle"]',
    );
    if (!subtitle) throw new Error('status subtitle not rendered');
    return subtitle;
  }

  function dotOf(subtitle: HTMLElement): HTMLElement {
    const dot = subtitle.querySelector<HTMLElement>(
      '[data-testid="sidebar-account-remote-control-dot"]',
    );
    if (!dot) throw new Error('status dot not rendered');
    return dot;
  }

  function pingOf(subtitle: HTMLElement): HTMLElement | null {
    return subtitle.querySelector<HTMLElement>(
      '[data-testid="sidebar-account-remote-control-ping"]',
    );
  }

  it('labels each status for the row accessible name', () => {
    expect(sidebarRemoteControlSubtitleLabel('active')).toBe(
      'Remote control active',
    );
    expect(sidebarRemoteControlSubtitleLabel('reconnecting')).toBe(
      'Remote control reconnecting',
    );
    expect(sidebarRemoteControlSubtitleLabel('disconnected')).toBe(
      'Remote control disconnected',
    );
  });

  it('renders the active line with a solid info dot and no ping', () => {
    const subtitle = renderStatus('active');
    expect(subtitle.textContent).toBe('Remote control active');
    expect(subtitle.getAttribute('data-status')).toBe('active');
    expect(subtitle.hasAttribute('title')).toBe(false);
    expect(subtitle.className).toContain('fg-tertiary');
    const dot = dotOf(subtitle);
    expect(dot.getAttribute('aria-hidden')).toBe('true');
    expect(dot.innerHTML).toContain('bg-fg-info');
    expect(pingOf(subtitle)).toBeNull();
    expect(container.querySelector('[aria-label]')).toBeNull();
  });

  it('renders the reconnecting line as its own text with a reduced-motion-safe ping', () => {
    const subtitle = renderStatus('reconnecting');
    expect(subtitle.textContent).toBe('Remote control reconnecting');
    expect(subtitle.getAttribute('data-status')).toBe('reconnecting');
    expect(subtitle.hasAttribute('title')).toBe(false);
    const ping = pingOf(subtitle);
    expect(ping?.className).toContain('animate-ping');
    expect(ping?.className).toContain('motion-reduce:animate-none');
    expect(dotOf(subtitle).innerHTML).toContain('bg-fg-info');
    expect(container.querySelector('[aria-label]')).toBeNull();
  });

  it('renders the disconnected line in the failed ink', () => {
    const subtitle = renderStatus('disconnected');
    expect(subtitle.textContent).toBe('Remote control disconnected');
    expect(subtitle.getAttribute('data-status')).toBe('disconnected');
    expect(subtitle.className).toContain('fg-destructive-strong');
    expect(subtitle.className).not.toContain('fg-tertiary');
    expect(dotOf(subtitle).innerHTML).toContain('bg-fg-destructive-strong');
    expect(pingOf(subtitle)).toBeNull();
  });

  // DESIGN.md: a row that shows its label gets no tooltip repeating it. The
  // full text is offered on hover only when the line is actually truncated.
  function hoverWithWidths(
    element: Element | null | undefined,
    scrollWidth: number,
    clientWidth: number,
  ): void {
    if (!(element instanceof HTMLElement)) throw new Error('no text element');
    Object.defineProperty(element, 'scrollWidth', {
      configurable: true,
      value: scrollWidth,
    });
    Object.defineProperty(element, 'clientWidth', {
      configurable: true,
      value: clientWidth,
    });
    act(() => {
      element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
  }

  it.each(['active', 'reconnecting', 'disconnected'] as const)(
    'offers the %s label as a tooltip only while it is truncated',
    (status) => {
      const text = renderStatus(status).lastElementChild;
      hoverWithWidths(text, 100, 100);
      expect(text?.hasAttribute('title')).toBe(false);
      hoverWithWidths(text, 180, 100);
      expect(text?.getAttribute('title')).toBe(
        sidebarRemoteControlSubtitleLabel(status),
      );
      hoverWithWidths(text, 100, 100);
      expect(text?.hasAttribute('title')).toBe(false);
    },
  );
});
