/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PluginsDiscoveryListLoading } from '../PluginsDiscoveryListLoading';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

// The loading state is the list's own shape, so entries replace it in place:
// section headings over the list's two-column grid of entry rows, announced
// once as a busy status rather than as visible "Loading…" copy.
it('stands in with the discovery list layout while entries load', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(<PluginsDiscoveryListLoading />));

  const status = container.querySelector(
    '[data-testid="plugins-discovery-list-skeleton"]',
  );
  expect(status?.getAttribute('role')).toBe('status');
  expect(status?.getAttribute('aria-busy')).toBe('true');
  expect(status?.getAttribute('aria-label')).toBe('Loading Customize');
  const grids = container.querySelectorAll('.md\\:grid-cols-2');
  expect(grids).toHaveLength(2);
  expect(grids[0]?.children).toHaveLength(4);
  expect(container.textContent).toBe('');
  act(() => root.unmount());
});
