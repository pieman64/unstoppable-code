/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { SidebarStylePicker } from '../SidebarStylePicker';
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
it('offers both text-only styles in a labelled dropdown and respects disabled saves', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const change = jest.fn();
  try {
    act(() =>
      root.render(<SidebarStylePicker value="advanced" onChange={change} />),
    );
    const trigger =
      container.querySelector<HTMLButtonElement>('[role="combobox"]');
    expect(trigger?.getAttribute('aria-label')).toBe('Sidebar style');
    expect(trigger?.textContent).toContain('Advanced');
    act(() => trigger?.click());
    const advanced = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-style-advanced"]',
    );
    const compact = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-style-compact"]',
    );
    expect(advanced?.getAttribute('aria-selected')).toBe('true');
    expect(compact?.getAttribute('aria-selected')).toBe('false');
    expect(
      advanced?.querySelector('[data-testid="sidebar-style-preview-advanced"]'),
    ).toBeNull();
    expect(
      compact?.querySelector('[data-testid="sidebar-style-preview-compact"]'),
    ).toBeNull();
    act(() => compact?.click());
    expect(change).toHaveBeenCalledWith('compact');
    act(() =>
      root.render(
        <SidebarStylePicker value="compact" disabled busy onChange={change} />,
      ),
    );
    expect(trigger?.textContent).toContain('Compact');
    expect(trigger?.disabled).toBe(true);
    expect(trigger?.getAttribute('aria-busy')).toBe('true');
    act(() => trigger?.click());
    expect(change).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
