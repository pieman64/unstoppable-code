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

describe('SidebarAccountMenuHeader avatar', () => {
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

  function render(
    props: Partial<Parameters<typeof SidebarAccountMenuHeader>[0]> = {},
  ): void {
    act(() => {
      root.render(
        <SidebarAccountMenuHeader
          name="Ada Lovelace"
          email="ada@example.com"
          image="https://example.com/ada.png"
          {...props}
        />,
      );
    });
  }

  const byTestId = (testId: string): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  it('draws the person as a 16px round avatar, the size of a row icon', () => {
    render();
    const avatar = byTestId('sidebar-person-avatar');
    expect(avatar?.tagName).toBe('IMG');
    expect(avatar?.getAttribute('src')).toBe('https://example.com/ada.png');
    expect(avatar?.getAttribute('alt')).toBe('');
    expect(avatar?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
    expect(avatar?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['h-4', 'w-4', 'rounded-full']),
    );
  });

  it('falls back to the initial for a missing, unsafe, or broken image', () => {
    render({ image: null });
    expect(byTestId('sidebar-person-avatar')).toBeNull();
    expect(byTestId('sidebar-person-avatar-initial')?.textContent).toBe('A');
    expect(
      byTestId('sidebar-person-avatar-initial')?.classList.contains(
        REPLAY_BLOCK_CLASS,
      ),
    ).toBe(true);

    render({ image: 'file:///etc/passwd' });
    expect(byTestId('sidebar-person-avatar')).toBeNull();

    render({ image: 'https://example.com/broken.png' });
    act(() => {
      byTestId('sidebar-person-avatar')?.dispatchEvent(new Event('error'));
    });
    expect(byTestId('sidebar-person-avatar')).toBeNull();
    expect(
      byTestId('sidebar-person-avatar-initial')?.className.split(/\s+/),
    ).toEqual(
      expect.arrayContaining(['h-4', 'w-4', 'rounded-full', 'bg-muted']),
    );
  });
});
