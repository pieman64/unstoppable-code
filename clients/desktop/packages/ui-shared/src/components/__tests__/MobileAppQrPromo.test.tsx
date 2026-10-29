/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MobileAppQrPromo, type MobileAppQrLink } from '../MobileAppQrPromo';
import type { StoreBadgeActivation } from '../StoreBadgeLink';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ACTIVATION: StoreBadgeActivation = { kind: 'anchor' };

const APPLE_LINK: MobileAppQrLink = {
  store: 'apple-app-store',
  url: 'https://apps.example.com/app',
  badgeSrc: 'data:image/png;base64,apple',
  qrSrc: 'data:image/png;base64,apple-qr',
};

const PLAY_LINK: MobileAppQrLink = {
  store: 'google-play',
  url: 'https://play.example.com/app',
  badgeSrc: 'data:image/png;base64,play',
  qrSrc: 'data:image/png;base64,play-qr',
};

describe('MobileAppQrPromo', () => {
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

  function render(
    links: readonly MobileAppQrLink[],
    overrides: { heading?: string; description?: string } = {},
  ): void {
    act(() =>
      root.render(
        <MobileAppQrPromo
          brandDisplayName="Canopy"
          links={links}
          activation={ACTIVATION}
          {...overrides}
        />,
      ),
    );
  }

  function qrImages(): HTMLImageElement[] {
    return Array.from(
      container.querySelectorAll<HTMLImageElement>(
        '[data-testid="mobile-app-qr"]',
      ),
    );
  }

  function badges(): Element[] {
    return Array.from(
      container.querySelectorAll('[data-testid^="store-badge-"]'),
    );
  }

  /** The `data-testid` suffixes of the rendered badges, in DOM order. */
  function badgeStores(): string[] {
    return badges().map((badge) =>
      (badge.getAttribute('data-testid') ?? '').replace('store-badge-', ''),
    );
  }

  function tab(slug: string): HTMLButtonElement {
    const element = container.querySelector<HTMLButtonElement>(
      `[data-testid="mobile-app-qr-tab-${slug}"]`,
    );
    if (!element) throw new Error(`Tab ${slug} missing`);
    return element;
  }

  it('renders a toggle and exactly one QR for a two-store brand', () => {
    render([APPLE_LINK, PLAY_LINK]);

    expect(
      container.querySelector('[data-testid="mobile-app-qr-promo"]'),
    ).not.toBeNull();
    expect(container.querySelector('[role="group"]')).not.toBeNull();
    expect(tab('app-store').getAttribute('aria-pressed')).toBe('true');
    expect(tab('play').getAttribute('aria-pressed')).toBe('false');

    // The whole point: a phone camera must not have two codes to choose from.
    const codes = qrImages();
    expect(codes).toHaveLength(1);
    expect(codes[0].getAttribute('data-store')).toBe('apple-app-store');
    expect(codes[0].getAttribute('src')).toBe(APPLE_LINK.qrSrc);
    expect(codes[0].getAttribute('alt')).toContain('App Store');

    // The badge follows the toggle. Showing the other store's badge next to a
    // QR code for this one reads as a second, competing choice.
    expect(badgeStores()).toEqual(['apple-app-store']);
    expect(badges()[0]?.getAttribute('data-dd-action-name')).toBe(
      'Download on the App Store',
    );
  });

  it('swaps the QR when the store toggle changes, keeping only one mounted', () => {
    render([APPLE_LINK, PLAY_LINK]);

    act(() => tab('play').click());

    const codes = qrImages();
    expect(codes).toHaveLength(1);
    expect(codes[0].getAttribute('data-store')).toBe('google-play');
    expect(codes[0].getAttribute('src')).toBe(PLAY_LINK.qrSrc);
    expect(codes[0].getAttribute('alt')).toContain('Google Play');
    expect(tab('play').getAttribute('aria-pressed')).toBe('true');
    expect(badges()[0]?.getAttribute('data-dd-action-name')).toBe(
      'Get it on Google Play',
    );
    expect(tab('app-store').getAttribute('aria-pressed')).toBe('false');
    // The badge swaps with the code, so the popover never offers a store the
    // QR above it does not point at.
    expect(badgeStores()).toEqual(['google-play']);
  });

  it('renders no toggle for a single-store brand', () => {
    render([PLAY_LINK]);

    expect(container.querySelector('[role="group"]')).toBeNull();
    const codes = qrImages();
    expect(codes).toHaveLength(1);
    expect(codes[0].getAttribute('data-store')).toBe('google-play');
    expect(badgeStores()).toEqual(['google-play']);
  });

  it('hides the tile but keeps the toggle and badge when the selected QR is missing', () => {
    render([{ ...APPLE_LINK, qrSrc: undefined }, PLAY_LINK]);

    expect(qrImages()).toHaveLength(0);
    expect(container.querySelector('[role="group"]')).not.toBeNull();
    // No code to scan, so the badge is the ONLY way through for this store —
    // it must survive the failure, and it must still be this store's badge.
    expect(badgeStores()).toEqual(['apple-app-store']);

    // The other store still works — a failed encode never blocks the popover.
    act(() => tab('play').click());
    expect(qrImages()).toHaveLength(1);
  });

  // The toggle used to be `role="tab"` with `aria-controls` pointing at the QR
  // tile, which is rendered only when generation succeeded — so exactly in the
  // failure state above, the reference dangled and the tablist had no panel.
  it('never points the toggle at an element that is not rendered', () => {
    for (const links of [
      [APPLE_LINK, PLAY_LINK],
      [{ ...APPLE_LINK, qrSrc: undefined }, PLAY_LINK],
    ]) {
      render(links);

      const controls = Array.from(
        container.querySelectorAll<HTMLElement>('[aria-controls]'),
      );
      for (const control of controls) {
        const target = control.getAttribute('aria-controls') ?? '';
        expect(
          container.querySelector(`#${CSS.escape(target)}`),
        ).not.toBeNull();
      }

      // Toggle buttons are plain pressed-state controls, so they owe no
      // tabpanel and no roving tabIndex.
      expect(container.querySelector('[role="tab"]')).toBeNull();
      expect(tab('app-store').hasAttribute('tabindex')).toBe(false);
    }
  });

  it('renders nothing when the brand declares no listings', () => {
    render([]);
    expect(container.innerHTML).toBe('');
  });

  it('falls back to the shared default copy', () => {
    render([APPLE_LINK]);

    const text = container.textContent ?? '';
    expect(text).toContain('Take Canopy with you');
    expect(text).toContain('Monitor your agents');
  });

  it('honors caller-supplied copy', () => {
    render([APPLE_LINK], {
      heading: 'Scan to get Canopy',
      description: 'Point your camera here.',
    });

    const text = container.textContent ?? '';
    expect(text).toContain('Scan to get Canopy');
    expect(text).toContain('Point your camera here.');
  });
});
