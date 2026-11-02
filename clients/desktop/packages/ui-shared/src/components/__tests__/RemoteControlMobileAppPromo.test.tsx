/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { RemoteControlMobileAppPromo } from '../RemoteControlMobileAppPromo';
import type { MobileAppStoreLink } from '../StoreBadgeLink';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const links: readonly MobileAppStoreLink[] = [
  {
    store: 'apple-app-store',
    url: 'https://apps.apple.com/app/id1',
    badgeSrc: '/apple.svg',
  },
  {
    store: 'google-play',
    url: 'https://play.google.com/store/apps/details?id=test',
    badgeSrc: '/google.png',
  },
];

it.each([false, true])(
  'leaves no divider or spacing with no listings (visible=%s)',
  (visible) => {
    expect(
      renderToStaticMarkup(
        <RemoteControlMobileAppPromo
          brandDisplayName="Example"
          links={[]}
          visible={visible}
          activation={{ kind: 'anchor' }}
        />,
      ),
    ).toBe('');
  },
);

it('renders nothing for an ineligible account with configured listings', () => {
  expect(
    renderToStaticMarkup(
      <RemoteControlMobileAppPromo
        brandDisplayName="Example"
        links={links}
        visible={false}
        activation={{ kind: 'anchor' }}
      />,
    ),
  ).toBe('');
});

it.each(
  [links, links.slice(0, 1), links.slice(1)].map((configured) => [configured]),
)(
  'keeps exact shared copy, accessible badges and web destinations',
  (configured) => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <RemoteControlMobileAppPromo
        brandDisplayName="Example"
        links={configured}
        visible
        activation={{ kind: 'anchor' }}
      />,
    );
    expect(container.querySelector('h2')?.textContent).toBe(
      'Use Remote Control from your phone',
    );
    expect(container.querySelector('p')?.textContent).toBe(
      'Install the Example mobile app to monitor your agents and manage your projects from your phone.',
    );
    expect(container.querySelectorAll('a')).toHaveLength(configured.length);
    for (const link of configured) {
      const badge = container.querySelector(
        `[data-testid="store-badge-${link.store}"]`,
      );
      expect(badge?.getAttribute('href')).toBe(link.url);
      expect(badge?.getAttribute('target')).toBe('_blank');
      expect(badge?.getAttribute('rel')).toBe('noreferrer noopener');
      expect(badge?.querySelector('img')?.getAttribute('alt')).toBe(
        link.store === 'apple-app-store'
          ? 'Download on the App Store'
          : 'Get it on Google Play',
      );
    }
    expect(container.querySelector('.flex-wrap')).not.toBeNull();
  },
);

it('activates each exact store and URL once through the desktop callback', () => {
  const container = document.createElement('div');
  const root: Root = createRoot(container);
  const onActivate = jest.fn();
  try {
    act(() =>
      root.render(
        <RemoteControlMobileAppPromo
          brandDisplayName="Example"
          links={links}
          visible
          activation={{ kind: 'callback', onActivate }}
        />,
      ),
    );
    for (const link of links) {
      act(() => {
        container
          .querySelector<HTMLButtonElement>(
            `[data-testid="store-badge-${link.store}"]`,
          )
          ?.click();
      });
    }
    expect(onActivate.mock.calls).toEqual(
      links.map((link) => [link.store, link.url]),
    );
  } finally {
    act(() => root.unmount());
  }
});
