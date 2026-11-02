/**
 * @jest-environment jsdom
 */
/* eslint-disable @typescript-eslint/require-await -- act() callbacks stay async so React flushes the settled promises they trigger. */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SettingsStoreProvider } from '@canopy/app-state/settings';
import type { SettingsRoute } from '@canopy/protocol/settings';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type TestSettingsHostOptions,
} from '../../__tests__/helpers/test-settings-host';
import { AccountPage } from '../AccountPage';
import { AccountSettingsFrame } from '../AccountSettingsFrame';
import { NotificationsPage } from '../NotificationsPage';
import { HostedSettingsPage } from '../../pages/HostedSettingsPage';
import { SecurityPage } from '../SecurityPage';
import { TEAM_PAGE_COLUMN_CLASS } from '../../layout/SettingsPageColumn';

jest.mock('../digest-preferences-section', () => ({
  DigestPreferencesSection: (): JSX.Element => (
    <div data-testid="digest-preferences" />
  ),
}));

jest.mock('../install-update-emails-section', () => ({
  InstallUpdateEmailsSection: (): JSX.Element => (
    <div data-testid="account-install-update-emails" />
  ),
}));

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

async function render(
  node: ReactNode,
  options: TestSettingsHostOptions = {},
): Promise<void> {
  const client = createFakeSettingsClient({
    'account.security.authSources': () => ({
      user: { name: 'Ada', email: 'ada@example.com', twoFactorEnabled: false },
      sources: [],
    }),
    'account.apiKeys.list': () => [],
    'account.notifications.push.read': () => ({ pushEnabled: true }),
  });
  const { host } = createTestSettingsHost({ client, ...options });
  await act(async () => {
    root.render(<TestSettingsHost host={host}>{node}</TestSettingsHost>);
  });
  // The panels defer their first load by a macrotask; let it run and settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('account page modules', () => {
  it('renders the Account panel from page data', async () => {
    await render(
      <AccountPage
        route={{ scope: 'account', page: 'account' }}
        page={{
          kind: 'account.account',
          data: {
            initialName: 'Ada Lovelace',
            initialImage: null,
            role: 'MEMBER',
            email: 'ada@example.com',
          },
        }}
      />,
    );

    expect(
      container
        .querySelector('[data-testid="profile-name-input"]')
        ?.getAttribute('value'),
    ).toBe('Ada Lovelace');
    expect(
      container.querySelector('[data-testid="account-email"]')?.textContent,
    ).toBe('ada@example.com');
    expect(
      container.querySelector('[data-testid="account-role"]')?.textContent,
    ).toBe('Member');
  });

  it('renders the Security panel from page data', async () => {
    await render(
      <SecurityPage
        route={{ scope: 'account', page: 'security' }}
        page={{
          kind: 'account.security',
          data: { brandDisplayName: 'Canopy', emailPasswordAuthEnabled: true },
        }}
      />,
    );

    expect(container.textContent).toContain('Sign-in methods');
    // No credential yet, and email/password sign-in is on: offer to set one.
    expect(container.textContent).toContain('Set password');
    expect(
      container.querySelector('[data-testid="account-api-keys-section"]')
        ?.textContent,
    ).toContain('Create manual API keys for Canopy clients');
  });

  it('hides the password row when the page data turns email sign-in off', async () => {
    await render(
      <SecurityPage
        route={{ scope: 'account', page: 'security' }}
        page={{
          kind: 'account.security',
          data: {
            brandDisplayName: 'Canopy',
            emailPasswordAuthEnabled: false,
          },
        }}
      />,
    );

    expect(container.textContent).not.toContain('Set password');
  });

  it.each([
    ['?digestUnsubscribed=1', true],
    ['', false],
  ])(
    'acknowledges a digest unsubscribe from the query (%s)',
    async (search, shown) => {
      await render(<NotificationsPage />, { search });

      expect(
        container.querySelector(
          '[data-testid="digest-unsubscribed-notice"]',
        ) !== null,
      ).toBe(shown);
      expect(
        container.querySelector('[data-testid="digest-preferences"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="account-push-preferences"]'),
      ).not.toBeNull();
    },
  );

  it.each(['item', 'all'])(
    'preserves the install update unsubscribe acknowledgement (%s)',
    async (scope) => {
      await render(<NotificationsPage />, {
        search: `?installUpdatesUnsubscribed=${scope}`,
      });
      expect(
        container.querySelector(
          '[data-testid="install-updates-unsubscribed-notice"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="account-install-update-emails"]',
        ),
      ).not.toBeNull();
    },
  );

  it('frames account pages with the header for the current path', async () => {
    await render(
      <AccountSettingsFrame
        freeAccess={false}
        before={<nav data-testid="rail" />}
      >
        <p data-testid="content" />
      </AccountSettingsFrame>,
      { pathname: '/account/security' },
    );

    // The shared settings column holds the header; the page body keeps its
    // reading measure beneath it.
    const main = container.querySelector('main');
    expect(main?.getAttribute('data-testid')).toBe('settings-page-column');
    expect(main?.className).toBe(TEAM_PAGE_COLUMN_CLASS);
    expect(
      Array.from(main?.children ?? []).map(
        (child) => child.getAttribute('data-testid') ?? child.tagName,
      ),
    ).toEqual(['rail', 'page-header', 'account-settings-body']);
    const body = container.querySelector(
      '[data-testid="account-settings-body"]',
    );
    expect(body?.className).not.toContain('max-w-3xl');
    expect(
      Array.from(body?.children ?? []).map(
        (child) => child.getAttribute('data-testid') ?? child.tagName,
      ),
    ).toEqual(['content']);
    // The header reserves its actions slot on every account page.
    expect(
      container.querySelector('[data-testid="page-header-actions"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="page-header-title"]')?.textContent,
    ).toBe('Security');
  });

  it('renders the after region below the page content', async () => {
    await render(
      <AccountSettingsFrame
        freeAccess={false}
        before={<nav data-testid="rail" />}
        after={<section data-testid="after" />}
      >
        <p data-testid="content" />
      </AccountSettingsFrame>,
      { pathname: '/account/security' },
    );

    const body = container.querySelector(
      '[data-testid="account-settings-body"]',
    );
    expect(
      Array.from(body?.children ?? []).map(
        (child) => child.getAttribute('data-testid') ?? child.tagName,
      ),
    ).toEqual(['content', 'after']);
  });
});

describe('HostedSettingsPage accountFrameAfter', () => {
  async function renderHostedPage(
    route: SettingsRoute,
    pageData: () => unknown,
  ): Promise<void> {
    const client = createFakeSettingsClient({
      'settings.pageData': pageData,
    });
    const { host } = createTestSettingsHost({ client });
    await act(async () => {
      root.render(
        <TestSettingsHost host={host}>
          <SettingsStoreProvider client={client} accountId="account-1">
            <HostedSettingsPage
              route={route}
              freeAccess={false}
              accountFrameAfter={<section data-testid="after" />}
            />
          </SettingsStoreProvider>
        </TestSettingsHost>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('renders after the account frame while the page data loads', async () => {
    await renderHostedPage(
      { scope: 'account', page: 'security' },
      () => new Promise<never>(() => {}),
    );

    // The page's skeleton stands in for its body, before the host's rows.
    expect(
      container.querySelector(
        '[data-testid="account-settings-body"] [data-testid="settings-skeleton-form"]',
      ),
    ).not.toBeNull();
    const body = container.querySelector(
      '[data-testid="account-settings-body"]',
    );
    expect(body?.lastElementChild?.getAttribute('data-testid')).toBe('after');
  });

  it('renders after the account frame when the page data fails', async () => {
    await renderHostedPage({ scope: 'account', page: 'security' }, () => {
      throw new Error('offline');
    });

    expect(
      container.querySelector('[data-testid="hosted-settings-failed"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="hosted-settings-route-loading"]'),
    ).toBeNull();
    const body = container.querySelector(
      '[data-testid="account-settings-body"]',
    );
    expect(body?.lastElementChild?.getAttribute('data-testid')).toBe('after');
  });

  it('never renders it for organization routes', async () => {
    await renderHostedPage(
      { scope: 'organization', organizationId: 'org-1', page: 'members' },
      () => new Promise<never>(() => {}),
    );

    // An organization tab loads under the organization header instead.
    expect(
      container.querySelector('[data-testid="organization-settings-loading"]'),
    ).not.toBeNull();
    expect(container.querySelector('main')).toBeNull();
    expect(container.querySelector('[data-testid="after"]')).toBeNull();
  });
});
