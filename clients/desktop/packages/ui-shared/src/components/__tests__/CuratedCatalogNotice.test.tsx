/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CuratedCatalogNotice } from '../CuratedCatalogNotice';

describe('CuratedCatalogNotice', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows the catalog error and retries', () => {
    const onRetry = jest.fn();
    act(() =>
      root.render(
        <CuratedCatalogNotice
          error="Catalog unavailable"
          stale={false}
          onRetry={onRetry}
          cloudDisplayName="Acme Cloud"
        />,
      ),
    );

    const notice = container.querySelector(
      '[data-testid="plugins-curated-pipelines-error"]',
    );
    expect(notice?.textContent).toContain("Couldn't load curated workflows.");
    expect(notice?.textContent).toContain('Catalog unavailable');
    act(() => notice?.querySelector('button')?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the saved-catalog message when stale', () => {
    act(() =>
      root.render(
        <CuratedCatalogNotice
          error={null}
          stale
          onRetry={jest.fn()}
          cloudDisplayName="Acme Cloud"
        />,
      ),
    );

    expect(
      container.querySelector('[data-testid="plugins-curated-pipelines-stale"]')
        ?.textContent,
    ).toContain('Connect to Acme Cloud');
  });
});
