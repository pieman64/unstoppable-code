/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { SidebarAccountMenuHeader } from '../SidebarAccountMenuHeader';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('SidebarAccountMenuHeader (CAN-4057)', () => {
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

  function header(): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      '[data-testid="sidebar-account-menu-header-identity"]',
    );
  }

  it('names the person with avatar and email, out of replay and focus', () => {
    act(() =>
      root.render(
        <SidebarAccountMenuHeader
          name="Ada Lovelace"
          email="ada@example.com"
        />,
      ),
    );
    const element = header();
    expect(element?.textContent).toBe('AAda Lovelaceada@example.com');
    expect(element?.querySelector('[role^="menuitem"]')).toBeNull();
    expect(element?.querySelector('button, a, [tabindex]')).toBeNull();
    const spans = element ? Array.from(element.querySelectorAll('span')) : [];
    const name = spans.find((span) => span.textContent === 'Ada Lovelace');
    const email = spans.find((span) => span.textContent === 'ada@example.com');
    expect(name?.className).toContain(REPLAY_BLOCK_CLASS);
    expect(name?.className).toContain('truncate');
    expect(email?.className).toContain(REPLAY_BLOCK_CLASS);
  });

  it('shows the email alone when there is no name, and nothing with neither', () => {
    act(() =>
      root.render(
        <SidebarAccountMenuHeader name=" " email="ada@example.com" />,
      ),
    );
    expect(header()?.textContent).toBe('Aada@example.com');
    act(() => root.render(<SidebarAccountMenuHeader name="" email="" />));
    expect(header()).toBeNull();
  });
});
