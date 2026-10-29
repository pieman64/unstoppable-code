/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// This test exercises the GATE, not the bar: the real WorktreeTopBar needs
// the CanopyClientProvider harness, which is the gallery's concern, not the
// flag's.
jest.mock('@/components/panels/WorktreeTopBar', () => ({
  WorktreeTopBar: (): JSX.Element => <div data-testid="stub-top-bar" />,
}));

import type { JSX } from 'react';
import { HeaderStateGalleryPage } from '../HeaderStateGalleryPage';
import { HEADER_STATE_GALLERY_PROJECT_ID } from '../headerStateGalleryData';
import { useProjectsStore } from '@/stores/projectsStore';

/**
 * The sidebar entry is flag-gated, but `header-states` must stay in the App
 * Advisor navigation allowlist (an unlisted page is dropped silently), so a
 * packaged build can still be NAVIGATED here by asking the advisor for the
 * page by name. The page therefore gates itself: flag off → placeholder, no
 * gallery, and — the part that would regress silently — no synthetic
 * workspace seeded into the projects store.
 */

interface DevInfoWindow {
  devInfo?: { isDev: boolean };
}

const devInfoWindow: DevInfoWindow = window;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  delete devInfoWindow.devInfo;
  window.localStorage.clear();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(<HeaderStateGalleryPage />);
    await Promise.resolve();
  });
}

describe('HeaderStateGalleryPage flag gate', () => {
  it('renders a placeholder and seeds nothing when the flag is off', async () => {
    // Packaged-build shape: no devInfo, flag key irrelevant.
    await render();

    expect(
      container.querySelector('[data-testid="header-states-page-disabled"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="header-states-page"]'),
    ).toBeNull();
    expect(
      useProjectsStore
        .getState()
        .projects.some((p) => p.id === HEADER_STATE_GALLERY_PROJECT_ID),
    ).toBe(false);
  });

  it('renders the gallery when the dev opt-in is set', async () => {
    devInfoWindow.devInfo = { isDev: true };
    window.localStorage.setItem('canopy.dev.headerStatesPage', '1');
    await render();

    expect(
      container.querySelector('[data-testid="header-states-page"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="header-states-page-disabled"]'),
    ).toBeNull();
  });
});
