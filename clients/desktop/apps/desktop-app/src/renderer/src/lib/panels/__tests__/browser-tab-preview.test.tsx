/**
 * @jest-environment jsdom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BrowserSessionSnapshot } from '@canopy/desktop-shared/types';
import type { PanelTabModel } from '@canopy/ui-shared/panels';
import { useBrowserStore } from '@/stores/browserStore';
import {
  browserTabPreviewSourceRect,
  recordBrowserTabPreview,
  renderBrowserTabHoverCard,
  resetBrowserTabPreviewsForTests,
} from '../browser-tab-preview';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function browserTab(browserId: string): PanelTabModel {
  return {
    panelId: `panel-browser-${browserId}`,
    kind: 'browser',
    title: 'browser',
    instance: { browserId },
  };
}

function snapshot(
  overrides: Partial<BrowserSessionSnapshot> = {},
): BrowserSessionSnapshot {
  return {
    id: 'b1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    createdAt: 1,
    updatedAt: 2,
    url: 'http://localhost:5173/checkout',
    title: 'Checkout',
    status: 'ready',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    themeMode: 'light',
    pickMode: false,
    recording: false,
    ...overrides,
  };
}

function seed(session: BrowserSessionSnapshot): void {
  useBrowserStore.setState({
    worktrees: {
      'project-1/worktree-1': {
        browserOrder: [session.id],
        activeBrowserId: session.id,
        browsers: { [session.id]: session },
        live: new Set([session.id]),
        hydrated: true,
      },
    },
  });
}

const frame = (): HTMLImageElement => document.createElement('img');

describe('browser tab previews', () => {
  let container: HTMLDivElement;
  let root: Root;
  let scaled: number;

  beforeEach(() => {
    scaled = 0;
    resetBrowserTabPreviewsForTests(() => {
      scaled += 1;
      return `data:image/jpeg;base64,frame-${scaled}`;
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useBrowserStore.setState({ worktrees: {} });
    resetBrowserTabPreviewsForTests();
  });

  function show(card: ReactNode): void {
    act(() => root.render(<>{card}</>));
  }

  const q = (testId: string): HTMLElement | null =>
    container.querySelector(`[data-testid="${testId}"]`);

  it('renders nothing for tabs that are not browser tabs', () => {
    expect(
      renderBrowserTabHoverCard({ panelId: 'c', kind: 'chat', title: 'Chat' }),
    ).toBeNull();
    expect(
      renderBrowserTabHoverCard({ panelId: 'b', kind: 'browser', title: 'B' }),
    ).toBeNull();
  });

  it('shows the title and location, with the site icon before any capture', () => {
    seed(snapshot());
    show(renderBrowserTabHoverCard(browserTab('b1')));
    expect(q('browser-tab-preview-title')?.textContent).toBe('Checkout');
    expect(q('browser-tab-preview-url')?.textContent).toBe(
      'localhost:5173/checkout',
    );
    expect(q('browser-tab-preview-image')).toBeNull();
    expect(q('panel-tab-browser-globe-b1')).not.toBeNull();
  });

  it('shows the latest capture of the page, live while the card is open', () => {
    seed(snapshot());
    show(renderBrowserTabHoverCard(browserTab('b1')));
    act(() => {
      recordBrowserTabPreview('b1', 'http://localhost:5173/checkout', frame());
    });
    expect(q('browser-tab-preview-image')?.getAttribute('src')).toBe(
      'data:image/jpeg;base64,frame-1',
    );
  });

  it('never shows an earlier page under a new URL', () => {
    recordBrowserTabPreview('b1', 'http://localhost:5173/checkout', frame());
    seed(snapshot({ url: 'http://localhost:5173/orders', title: 'Orders' }));
    show(renderBrowserTabHoverCard(browserTab('b1')));
    expect(q('browser-tab-preview-image')).toBeNull();
    expect(q('browser-tab-preview-placeholder')).not.toBeNull();
  });

  it('scales a burst of frames of one page once', () => {
    const url = 'http://localhost:5173/checkout';
    recordBrowserTabPreview('b1', url, frame(), 1000);
    recordBrowserTabPreview('b1', url, frame(), 1500);
    expect(scaled).toBe(1);
    recordBrowserTabPreview('b1', url, frame(), 2100);
    expect(scaled).toBe(2);
    recordBrowserTabPreview(
      'b1',
      'http://localhost:5173/orders',
      frame(),
      2200,
    );
    expect(scaled).toBe(3);
  });

  it('keeps a bounded number of previews, dropping the oldest', () => {
    for (let index = 0; index < 25; index += 1) {
      recordBrowserTabPreview(`b${index}`, 'https://example.com/', frame());
    }
    seed(snapshot({ id: 'b0', url: 'https://example.com/' }));
    show(renderBrowserTabHoverCard(browserTab('b0')));
    expect(q('browser-tab-preview-image')).toBeNull();
    seed(snapshot({ id: 'b24', url: 'https://example.com/' }));
    show(renderBrowserTabHoverCard(browserTab('b24')));
    expect(q('browser-tab-preview-image')).not.toBeNull();
  });

  it('records nothing for a blank page or a failed scale', () => {
    recordBrowserTabPreview('b1', '', frame());
    expect(scaled).toBe(0);
    resetBrowserTabPreviewsForTests(() => null);
    recordBrowserTabPreview('b1', 'https://example.com/', frame());
    seed(snapshot({ url: 'https://example.com/' }));
    show(renderBrowserTabHoverCard(browserTab('b1')));
    expect(q('browser-tab-preview-image')).toBeNull();
  });
});

describe('browserTabPreviewSourceRect', () => {
  it.each([
    // A tall page keeps its full width and is cut at 16:9 from the top.
    [1600, 1200, { width: 1600, height: 900 }],
    // A wide page keeps its full height and is cut at 16:9 from the left,
    // so the preview never shows an empty band.
    [2400, 900, { width: 1600, height: 900 }],
    // Exactly 16:9 is drawn whole.
    [1280, 720, { width: 1280, height: 720 }],
  ])('%sx%s draws %o', (width, height, expected) => {
    expect(browserTabPreviewSourceRect(width, height)).toEqual(expected);
  });
});
