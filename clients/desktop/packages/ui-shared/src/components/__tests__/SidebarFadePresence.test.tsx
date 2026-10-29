/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { SidebarFadePresence } from '../SidebarFadePresence';

describe('SidebarFadePresence', () => {
  it('renders opening content immediately', () => {
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <SidebarFadePresence open={false}>Nested item</SidebarFadePresence>,
      );
    });
    act(() => {
      root.render(<SidebarFadePresence open>Nested item</SidebarFadePresence>);
    });

    expect(
      container
        .querySelector('.sidebar-fade-presence')
        ?.getAttribute('data-state'),
    ).toBe('open');
    expect(container.textContent).toContain('Nested item');

    act(() => root.unmount());
  });

  it('removes closing content immediately', () => {
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <SidebarFadePresence open>
          <button type="button">Nested item</button>
        </SidebarFadePresence>,
      );
    });

    act(() => {
      root.render(
        <SidebarFadePresence open={false}>
          <button type="button">Nested item</button>
        </SidebarFadePresence>,
      );
    });

    expect(container.querySelector('.sidebar-fade-presence')).toBeNull();
    expect(container.textContent).not.toContain('Nested item');
    act(() => root.unmount());
  });
});
