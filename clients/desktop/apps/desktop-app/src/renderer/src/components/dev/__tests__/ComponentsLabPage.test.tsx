/** @jest-environment jsdom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

jest.mock('@/lib/theme', () => ({ applyTheme: jest.fn() }));

// jsdom has no layout observers or media queries; the stageshow stages need
// all three. Reduced motion is on, so every stage shows its poster and no
// script runs.
class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
Object.assign(globalThis, {
  ResizeObserver: NoopObserver,
  IntersectionObserver: NoopObserver,
});
window.matchMedia = (query: string): MediaQueryList => ({
  matches: query.includes('reduce'),
  media: query,
  onchange: null,
  addListener: (): void => undefined,
  removeListener: (): void => undefined,
  addEventListener: (): void => undefined,
  removeEventListener: (): void => undefined,
  dispatchEvent: (): boolean => false,
});

import { ComponentsLabPage } from '../ComponentsLabPage';
import { COMPONENTS_LAB_ENTRIES } from '../componentsLabCatalog';
import { PENDING_UNIFICATIONS } from '../componentsLabPendingData';

describe('ComponentsLabPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  function mount(search: string): void {
    window.history.replaceState(null, '', `/components-lab.html${search}`);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<ComponentsLabPage />));
  }

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders every unified sheet without throwing in the all view', () => {
    mount('?component=all&theme=light');
    for (const entry of COMPONENTS_LAB_ENTRIES) {
      const sheet = container.querySelector(
        `[data-testid="components-lab-${entry.id}"]`,
      );
      if (entry.group === 'Unified') expect(sheet).not.toBeNull();
      else expect(sheet).toBeNull();
      // Each stage mounts inside its own sheet, above the specimens.
      expect(
        sheet?.querySelector(`[data-stage="${entry.id}"] .ss-stage`) ?? null,
      ).toEqual(entry.Stage && sheet ? expect.anything() : null);
    }
  });

  it('opens one entry from the URL and switches entries from the catalog', () => {
    mount('?component=not-unified&theme=light');
    expect(
      container.querySelector('[data-testid="components-lab-not-unified"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="components-lab-button"]'),
    ).toBeNull();
    expect(container.querySelectorAll('[data-pending]').length).toBe(
      PENDING_UNIFICATIONS.length,
    );
    expect(
      container.querySelector('[data-pending="menus"]')?.textContent,
    ).toContain('Menus, listboxes and pickers');

    const buttonRow = Array.from(
      container.querySelectorAll<HTMLButtonElement>('nav button'),
    ).find((row) => (row.textContent ?? '').trim() === 'Button');
    if (!buttonRow) throw new Error('No Button catalog row');
    act(() => buttonRow.click());

    expect(
      container.querySelector('[data-testid="components-lab-button"]'),
    ).not.toBeNull();
    expect(window.location.search).toContain('component=button');
  });

  it('opens on an overview grid with one card per unified component', () => {
    mount('?theme=light');
    const grid = container.querySelector(
      '[data-testid="components-lab-overview"]',
    );
    expect(grid).not.toBeNull();
    // Only entries with a stage get a card; a bare specimen has nothing to show.
    const unified = COMPONENTS_LAB_ENTRIES.filter(
      (entry) => entry.group === 'Unified' && entry.Stage,
    );
    expect(
      grid?.querySelectorAll('[data-testid^="components-lab-card-"]').length,
    ).toBe(unified.length);
    // The sheets are not mounted until a card is opened.
    expect(
      container.querySelector('[data-testid="components-lab-button"]'),
    ).toBeNull();

    const open = container.querySelector<HTMLButtonElement>(
      '[data-testid="components-lab-card-button"] button[aria-label="Open the Button sheet"]',
    );
    if (!open) throw new Error('No Open sheet link on the Button card');
    act(() => open.click());

    expect(
      container.querySelector('[data-testid="components-lab-button"]'),
    ).not.toBeNull();
    expect(window.location.search).toContain('component=button');
  });
});
