/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PanelEmptyGroupCatalog } from '../PanelEmptyGroupCatalog';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('PanelEmptyGroupCatalog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('lists what can be opened and opens the chosen surface', () => {
    const openFiles = jest.fn();
    const openMore = jest.fn();
    act(() =>
      root.render(
        <PanelEmptyGroupCatalog
          title="Open in Side Panel"
          testId="catalog"
          onMore={openMore}
          entries={[
            {
              key: 'files',
              label: 'File explorer',
              icon: <span />,
              testId: 'catalog-files',
              onActivate: openFiles,
            },
            {
              key: 'browser',
              label: 'Browser',
              icon: <span />,
              testId: 'catalog-browser',
              busy: true,
              disabled: true,
              onActivate: jest.fn(),
            },
          ]}
        />,
      ),
    );

    expect(container.querySelector('h2')?.textContent).toBe(
      'Open in Side Panel',
    );
    const labels = Array.from(container.querySelectorAll('button'), (button) =>
      button.textContent?.trim(),
    );
    expect(labels).toEqual(['File explorer', 'Browser', 'More…']);

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="catalog-files"]')
        ?.click(),
    );
    expect(openFiles).toHaveBeenCalledTimes(1);

    const browser = container.querySelector<HTMLButtonElement>(
      '[data-testid="catalog-browser"]',
    );
    expect(browser?.disabled).toBe(true);
    expect(browser?.getAttribute('aria-busy')).toBe('true');

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="catalog-more"]')
        ?.click(),
    );
    expect(openMore).toHaveBeenCalledTimes(1);
  });

  it('draws the open add menu inside the More row, which it anchors to', () => {
    act(() =>
      root.render(
        <PanelEmptyGroupCatalog
          title="Open in Side Panel"
          testId="catalog"
          onMore={jest.fn()}
          moreMenu={<div data-testid="add-menu" />}
          entries={[]}
        />,
      ),
    );
    const more = container.querySelector('[data-testid="catalog-more"]');
    expect(more?.getAttribute('aria-expanded')).toBe('true');
    expect(
      more?.parentElement?.querySelector('[data-testid="add-menu"]'),
    ).not.toBeNull();
  });
});
