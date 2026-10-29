/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatWatcherFiredInfo } from '@canopy/desktop-shared/types';
import { WatcherFiredTitle } from '../WatcherFiredTitle';

describe('WatcherFiredTitle', () => {
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
    document
      .querySelectorAll('[role="tooltip"]')
      .forEach((node) => node.remove());
  });

  it('opens combined watcher details from the keyboard and restores focus on Escape', () => {
    const watcherFired: ChatWatcherFiredInfo = {
      kind: 'Multiple watchers fired (2)',
      combinedWatchers: [
        {
          kind: 'Pipeline completion (Deploy)',
          text: 'Canopy watcher fired.\nDeploy pipeline finished',
        },
        {
          kind: 'GitHub workflow run (acme/api)',
          text: 'Canopy watcher fired.\nCI checks completed',
        },
      ],
    };
    act(() => {
      root.render(<WatcherFiredTitle watcherFired={watcherFired} />);
    });

    const title = container.querySelector(
      '[data-testid="watcher-fired-title"]',
    );
    if (!(title instanceof HTMLElement)) {
      throw new Error('Watcher title not found');
    }
    expect(title.textContent).toBe('Multiple watchers fired (2)');

    act(() => title.focus());
    act(() => {
      title.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    const tooltip = document.body.querySelector(
      '[data-testid="watcher-fired-tooltip"]',
    );
    if (!(tooltip instanceof HTMLElement)) {
      throw new Error('Combined watcher tooltip not found');
    }
    expect(tooltip.textContent).toContain(
      'Pipeline completion (Deploy) watcher has fired',
    );
    expect(tooltip.textContent).toContain('Deploy pipeline finished');
    expect(tooltip.textContent).toContain(
      'GitHub workflow run (acme/api) watcher has fired',
    );
    expect(tooltip.textContent).toContain('CI checks completed');
    const scrollRegion = tooltip.querySelector('.overflow-y-auto');
    expect(scrollRegion?.getAttribute('tabindex')).toBe('0');
    expect(scrollRegion?.getAttribute('aria-label')).toBe(
      'Combined watcher details',
    );
    expect(document.activeElement).toBe(scrollRegion);

    act(() => {
      scrollRegion?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(document.activeElement).toBe(title);
  });
});
