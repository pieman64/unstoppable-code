/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  SidebarAccountFooter,
  SidebarPersonAvatar,
  SidebarAccountRow,
} from '../SidebarAccountFooter';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The trigger's accessible label, from `aria-labelledby` or `aria-label`. */
function accessibleLabel(element: Element | null | undefined): string | null {
  const ids = element?.getAttribute('aria-labelledby');
  if (!ids) return element?.getAttribute('aria-label') ?? null;
  return ids
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

describe('SidebarAccountFooter', () => {
  let container: HTMLElement;
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

  function render(
    props: Partial<Parameters<typeof SidebarAccountFooter>[0]> = {},
  ): void {
    act(() => {
      root.render(
        <SidebarAccountFooter
          identity={{ name: 'Ada Lovelace', image: null, signedIn: true }}
          menu={(close) => (
            <button type="button" data-testid="menu-row" onClick={close}>
              Row
            </button>
          )}
          {...props}
        />,
      );
    });
  }

  it('renders initials for a signed-in identity without an avatar', () => {
    render();
    expect(container.textContent).toContain('A');
    expect(
      container.querySelector('[data-testid="sidebar-account-identity"]')
        ?.textContent,
    ).toBe('Ada Lovelace');
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows the signing-in label while sign-in is in progress', () => {
    render({
      identity: { name: 'Ada', signedIn: true, signingIn: true },
    });
    expect(
      container.querySelector('[data-testid="sidebar-account-identity"]')
        ?.textContent,
    ).toBe('Signing in…');
  });

  it('renders the avatar only for http(s) sources', () => {
    render({
      identity: { name: 'Ada', image: 'https://x/a.png', signedIn: true },
    });
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://x/a.png',
    );
    render({ identity: { name: 'Ada', image: 'file:///etc', signedIn: true } });
    expect(container.querySelector('img')).toBeNull();
  });

  it('draws the person round', () => {
    render({
      identity: { name: 'Ada', image: 'https://x/a.png', signedIn: true },
    });
    expect(container.querySelector('img')?.classList).toContain('rounded-full');
  });

  it('labels the trigger and shows the attention dot', () => {
    render({
      attention: {
        dotClassName: 'bg-warning',
        label: 'usage requires attention',
      },
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-account-row"]',
    );
    // Label-in-name: the accessible name starts with the visible name and
    // carries the subtitle's text before the attention state.
    expect(accessibleLabel(trigger)).toBe(
      'Ada Lovelace, usage requires attention',
    );
    expect(container.querySelector('.bg-warning')).not.toBeNull();
  });

  it('falls back to the person icon and a signed-out label', () => {
    render({ identity: { name: 'Not signed in', signedIn: false } });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-account-row"]',
    );
    // Action-oriented copy: point at what the user can do, not the absence.
    expect(trigger?.getAttribute('aria-label')).toBe('Sign in');
  });

  it('opens the menu from the trigger and lets a row close it', () => {
    render();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-account-row"]',
    );
    expect(
      document.body.querySelector('[data-testid="sidebar-account-menu"]'),
    ).toBeNull();
    act(() => trigger?.click());
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    const row = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="menu-row"]',
    );
    expect(row).not.toBeNull();
    act(() => row?.click());
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens a 256px menu outside any instant-feedback scope by default', () => {
    render();
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="sidebar-account-row"]')
        ?.click();
    });
    const menu = document.body.querySelector<HTMLElement>(
      '[data-testid="sidebar-account-menu"]',
    );
    const tokens = menu?.className.split(/\s+/) ?? [];
    expect(tokens).toContain('w-64');
    expect(tokens).not.toContain('w-56');
    expect(tokens).not.toContain('sidebar-instant-interactions');
  });

  it('narrows the menu and re-enters the sidebar instant-feedback scope for the desktop host', () => {
    render({ menuWidth: 'compact', menuInstantInteractions: true });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="sidebar-account-row"]')
        ?.click();
    });
    const menu = document.body.querySelector<HTMLElement>(
      '[data-testid="sidebar-account-menu"]',
    );
    const tokens = menu?.className.split(/\s+/) ?? [];
    expect(tokens).toContain('w-56');
    expect(tokens).toContain('sidebar-instant-interactions');
    expect(tokens).not.toContain('w-64');
  });

  it('emits the desktop sidebar test ids by default', () => {
    render({
      identity: { name: 'Ada', image: null, signedIn: true },
      attention: { dotClassName: 'bg-warning', label: 'attention' },
    });
    for (const id of [
      'sidebar-account-list-item',
      'sidebar-account-row',
      'sidebar-account-identity',
      'sidebar-account-initials',
      'sidebar-account-attention-dot',
    ]) {
      expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    render({ identity: { name: 'Not signed in', signedIn: false } });
    expect(
      container.querySelector('[data-testid="sidebar-account-icon"]'),
    ).not.toBeNull();
  });

  it('returns focus to the account trigger when the menu closes via Escape', () => {
    render();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-account-row"]',
    );
    if (!trigger) throw new Error('trigger missing');
    act(() => trigger.click());
    const menu = document.body.querySelector<HTMLElement>(
      '[data-testid="sidebar-account-menu"]',
    );
    expect(menu).not.toBeNull();
    act(() => {
      menu?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // The menu was anchored to the non-focusable row wrapper; focus must land
    // on the trigger button, not on that wrapper or <body>.
    expect(document.activeElement).toBe(trigger);
  });

  // Review finding on #3105: FloatingMenu restores focus only on Escape and on
  // its own close-on-select path, which the shared row disables so hosts can
  // decide per row. A host row that calls the supplied `close` must therefore
  // get the trigger focused back, or keyboard focus falls to the body.
  it('returns focus to the account trigger when a menu row closes the menu', () => {
    render();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-account-row"]',
    );
    act(() => trigger?.click());
    const row = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="menu-row"]',
    );
    expect(row).not.toBeNull();
    act(() => {
      row?.focus();
      row?.click();
    });
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('renders a later valid avatar after an earlier URL failed', () => {
    render({
      identity: { name: 'Ada', image: 'https://x/broken.png', signedIn: true },
    });
    const img = container.querySelector<HTMLImageElement>('img');
    if (!img) throw new Error('avatar missing');
    act(() => {
      img.dispatchEvent(new Event('error'));
    });
    expect(container.querySelector('img')).toBeNull();
    // A different URL must not be suppressed by the earlier failure.
    render({
      identity: { name: 'Ada', image: 'https://x/fixed.png', signedIn: true },
    });
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://x/fixed.png',
    );
  });

  it('labels the signed-out trigger with the action, not the absence', () => {
    render({ identity: { name: 'Sign in', signedIn: false } });
    expect(
      container
        .querySelector('[data-testid="sidebar-account-row"]')
        ?.getAttribute('aria-label'),
    ).toBe('Sign in');
  });

  it('centers a name-only row at the single-line height', () => {
    render();
    const listItem = container.querySelector(
      '[data-testid="sidebar-account-list-item"]',
    );
    const identity = container.querySelector(
      '[data-testid="sidebar-account-identity"]',
    );
    expect(listItem?.className).toMatch(/(^|\s)h-8(\s|$)/);
    expect(listItem?.className).toContain('items-center');
    expect(
      container.querySelector('[data-testid="sidebar-account-row"]')?.className,
    ).toContain('items-center');
    expect(identity?.parentElement?.className).toContain('justify-center');
    expect(identity?.parentElement?.childElementCount).toBe(1);
  });

  it('includes the plan subtitle text in the accessible name', () => {
    render({
      subtitle: <span>Trial · 30 days left</span>,
      subtitleLabel: 'Trial, 30 days left',
    });
    expect(
      accessibleLabel(
        container.querySelector('[data-testid="sidebar-account-row"]'),
      ),
    ).toBe('Ada Lovelace, Trial, 30 days left');
  });

  it('exposes an unframed row that fills its host and adds no divider or padding', () => {
    act(() => {
      root.render(
        <SidebarAccountRow
          identity={{ name: 'Ada', image: null, signedIn: true }}
          menu={() => null}
        />,
      );
    });
    const rootEl = container.firstElementChild;
    expect(rootEl?.className).toContain('w-full');
    expect(rootEl?.className).toContain('min-w-0');
    expect(rootEl?.className).not.toContain('border-t');
    expect(rootEl?.className).not.toContain('px-2');
  });

  it('expands the account row to a 44px touch target on coarse pointers', () => {
    render();
    expect(
      container.querySelector('[data-testid="sidebar-account-list-item"]')
        ?.className,
    ).toContain('pointer-coarse:min-h-11');
  });

  it('frames the footer variant with the sidebar divider around the same row', () => {
    render();
    const rootEl = container.firstElementChild;
    expect(rootEl?.querySelector('.border-t')).not.toBeNull();
    expect(
      rootEl?.querySelector('[data-testid="sidebar-account-row"]'),
    ).not.toBeNull();
  });

  it('renders the context row between the divider and the account row (CAN-4268)', () => {
    render({
      contextRow: <div data-testid="host-context-row">Studio desktop</div>,
    });
    const framed = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-account-footer"]',
    );
    const contextRow = framed?.querySelector(
      '[data-testid="host-context-row"]',
    );
    const accountRow = framed?.querySelector(
      '[data-testid="sidebar-account-row"]',
    );
    expect(framed?.className).toContain('border-t');
    expect(contextRow).not.toBeNull();
    expect(accountRow).not.toBeNull();
    expect(
      contextRow && accountRow
        ? contextRow.compareDocumentPosition(accountRow) &
            Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).toBeTruthy();
  });

  it('adds nothing above the account row without a context row', () => {
    render({ contextRow: null });
    const framed = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-account-footer"]',
    );
    expect(framed?.firstElementChild?.textContent).toContain('Ada Lovelace');
  });

  // ---- desktop adoption: the last details the desktop row carried itself ----

  it('inks the identity text with a usage-alert tone', () => {
    const identityClassName = (): string =>
      container.querySelector('[data-testid="sidebar-account-identity"]')
        ?.className ?? '';

    render();
    expect(identityClassName()).not.toContain('fg-warning');
    expect(identityClassName()).not.toContain('fg-destructive');
    render({ identityTone: 'warning' });
    expect(identityClassName()).toContain('fg-warning');
    render({ identityTone: 'destructive' });
    expect(identityClassName()).toContain('fg-destructive');
    expect(identityClassName()).not.toContain('fg-warning');
  });

  it('spreads host data attributes onto the trigger', () => {
    render({
      rowAttributes: { 'data-onboarding-anchor': 'sidebar-account-row' },
    });
    expect(
      container
        .querySelector('[data-testid="sidebar-account-row"]')
        ?.getAttribute('data-onboarding-anchor'),
    ).toBe('sidebar-account-row');
  });

  it('marks the banner stack for the sidebar scroll fade and takes a placement class', () => {
    render({ className: 'mt-1' });
    const rootEl = container.firstElementChild;
    expect(rootEl?.className).toContain('mt-1');
    expect(rootEl?.className).toContain('relative');
    // The stack renders even when empty (CSS `empty:hidden` collapses it) so
    // the desktop scroll-fade selector can key off the marker.
    const stack = container.querySelector('[data-sidebar-footer-banners]');
    expect(stack).not.toBeNull();
    expect(stack?.className).toContain('empty:hidden');
  });

  it('honors host test ids so existing selectors keep working', () => {
    render({ testIds: { row: 'sidebar-account-menu-trigger' } });
    expect(
      container.querySelector('[data-testid="sidebar-account-menu-trigger"]'),
    ).not.toBeNull();
  });
  describe('session replay', () => {
    const blocked = (element: Element | null): boolean =>
      element?.closest(`.${REPLAY_BLOCK_CLASS}`) != null;

    it('blocks the avatar and name but records the trigger and plan subtitle', () => {
      render({
        identity: {
          name: 'Ada Lovelace',
          image: 'https://x/a.png',
          signedIn: true,
        },
        subtitle: <span data-testid="plan">Enterprise</span>,
        subtitleLabel: 'Enterprise plan',
      });
      expect(
        blocked(
          container.querySelector('[data-testid="sidebar-account-avatar"]'),
        ),
      ).toBe(true);
      expect(
        blocked(
          container.querySelector('[data-testid="sidebar-account-identity"]'),
        ),
      ).toBe(true);
      expect(
        blocked(container.querySelector('[data-testid="sidebar-account-row"]')),
      ).toBe(false);
      expect(blocked(container.querySelector('[data-testid="plan"]'))).toBe(
        false,
      );

      render();
      expect(
        blocked(
          container.querySelector('[data-testid="sidebar-account-initials"]'),
        ),
      ).toBe(true);
    });

    it('keeps the name out of every recorded attribute', () => {
      render({
        identity: {
          name: 'Ada Lovelace',
          image: 'https://x/a.png',
          signedIn: true,
        },
        subtitleLabel: 'Enterprise plan',
        attention: { dotClassName: 'bg-warning', label: 'usage warning' },
      });
      const trigger = container.querySelector(
        '[data-testid="sidebar-account-row"]',
      );
      // rrweb keeps no attributes of a blocked element, and nothing inside it.
      const recorded = Array.from(container.querySelectorAll('*')).filter(
        (element) => !blocked(element),
      );
      for (const element of recorded) {
        for (const attribute of element.getAttributeNames()) {
          expect(element.getAttribute(attribute)).not.toContain('Ada');
        }
      }
      expect(accessibleLabel(trigger)).toBe(
        'Ada Lovelace, Enterprise plan, usage warning',
      );
    });
  });
});

describe('SidebarPersonAvatar', () => {
  let container: HTMLElement;
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

  function render(
    props: Partial<Parameters<typeof SidebarPersonAvatar>[0]> = {},
  ): void {
    act(() => {
      root.render(
        <SidebarPersonAvatar
          name="Ada Lovelace"
          image="https://example.com/ada.png"
          {...props}
        />,
      );
    });
  }

  const byTestId = (testId: string): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  it('draws the person as a 16px round avatar, the size of a row icon', () => {
    render();
    const avatar = byTestId('sidebar-person-avatar');
    expect(avatar?.tagName).toBe('IMG');
    expect(avatar?.getAttribute('src')).toBe('https://example.com/ada.png');
    expect(avatar?.getAttribute('alt')).toBe('');
    expect(avatar?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
    expect(avatar?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['h-4', 'w-4', 'rounded-full']),
    );
  });

  it('falls back to the initial for a missing, unsafe, or broken image', () => {
    render({ image: null });
    expect(byTestId('sidebar-person-avatar')).toBeNull();
    expect(byTestId('sidebar-person-avatar-initial')?.textContent).toBe('A');
    expect(
      byTestId('sidebar-person-avatar-initial')?.classList.contains(
        REPLAY_BLOCK_CLASS,
      ),
    ).toBe(true);

    render({ image: 'file:///etc/passwd' });
    expect(byTestId('sidebar-person-avatar')).toBeNull();

    render({ image: 'https://example.com/broken.png' });
    act(() => {
      byTestId('sidebar-person-avatar')?.dispatchEvent(new Event('error'));
    });
    expect(byTestId('sidebar-person-avatar')).toBeNull();
    expect(
      byTestId('sidebar-person-avatar-initial')?.className.split(/\s+/),
    ).toEqual(
      expect.arrayContaining(['h-4', 'w-4', 'rounded-full', 'bg-muted']),
    );
  });
});
