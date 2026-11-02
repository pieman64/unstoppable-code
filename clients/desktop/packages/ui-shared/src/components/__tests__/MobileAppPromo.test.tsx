/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MobileAppPromo } from '../MobileAppPromo';
import type { MobileAppStoreLink } from '../StoreBadgeLink';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const links: readonly MobileAppStoreLink[] = [
  {
    store: 'apple-app-store',
    url: 'https://apps.apple.com/app/id1',
    badgeSrc: '/apple.svg',
  },
];

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
});

it('pins "Not now" to the corner with a wrapper, since Button stays relative', () => {
  const onDismiss = jest.fn();
  act(() => {
    root.render(
      <MobileAppPromo
        brandDisplayName="Example"
        links={links}
        activation={{ kind: 'anchor' }}
        onDismiss={onDismiss}
      />,
    );
  });
  const dismiss = container.querySelector<HTMLButtonElement>(
    '[data-testid="mobile-app-promo-dismiss"]',
  );
  expect(dismiss?.textContent).toBe('Not now');
  // Button's own `relative` wins over a caller's `absolute`, so the
  // positioning lives on the wrapper and the Button carries none.
  expect(dismiss?.classList).not.toContain('absolute');
  const wrapper = dismiss?.parentElement;
  expect(wrapper?.classList).toContain('absolute');
  expect(wrapper?.classList).toContain('right-3');
  expect(wrapper?.classList).toContain('top-3');

  act(() => dismiss?.click());
  expect(onDismiss).toHaveBeenCalledTimes(1);
});
