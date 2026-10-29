/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarNoneFoundRow } from '../SidebarNoneFoundRow';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('SidebarNoneFoundRow', () => {
  let container: HTMLDivElement;
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

  it('reads None found and carries no action', () => {
    act(() => {
      root.render(
        <SidebarNoneFoundRow data-testid="empty" labelTestId="empty-label" />,
      );
    });
    const row = container.querySelector('[data-testid="empty"]');
    expect(row?.textContent).toBe('None found');
    expect(
      container.querySelector('[data-testid="empty-label"]')?.textContent,
    ).toBe('None found');
    expect(row?.querySelector('button')).toBeNull();
    // Only the alignment slot and the label.
    expect(row?.childElementCount).toBe(2);
  });

  it('reads a host-supplied label in the same row', () => {
    act(() => {
      root.render(
        <SidebarNoneFoundRow
          data-testid="empty"
          labelTestId="empty-label"
          label="Your chats show up here"
        />,
      );
    });
    expect(
      container.querySelector('[data-testid="empty-label"]')?.textContent,
    ).toBe('Your chats show up here');
    expect(container.textContent).not.toContain('None found');
  });

  it('aligns its label with a chat title and a project name', () => {
    act(() => {
      root.render(<SidebarNoneFoundRow labelTestId="empty-label" />);
    });
    const label = container.querySelector('[data-testid="empty-label"]');
    const row = label?.parentElement;
    // A row's geometry: 6px inset, a 20px leading slot, a 6px gap.
    expect(row?.classList).toContain('h-8');
    expect(row?.classList).toContain('px-1.5');
    expect(row?.classList).toContain('gap-1.5');
    // Touch layouts raise it to the 44px minimum every sidebar row keeps.
    expect(row?.classList).toContain('pointer-coarse:min-h-11');
    const slot = label?.previousElementSibling;
    expect(slot?.getAttribute('aria-hidden')).toBe('true');
    expect(slot?.classList).toContain('h-5');
    expect(slot?.classList).toContain('w-5');
    expect(slot?.classList).toContain('shrink-0');
    expect(slot?.textContent).toBe('');
    expect(label?.classList).toContain('truncate');
    expect(label?.classList).toContain('fg-quaternary');
  });
});
