/**
 * @jest-environment jsdom
 */
/* eslint-disable @typescript-eslint/require-await -- act() callbacks stay async so React flushes the settled promises they trigger. */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SettingsStoreProvider } from '@canopy/app-state/settings';
import {
  ACCOUNT_PAGE_DATA_KINDS,
  ORGANIZATION_PAGE_DATA_KINDS,
  type SettingsPageDataKind,
  type SettingsRoute,
} from '@canopy/protocol/settings';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';
import { HostedSettingsPage } from '../HostedSettingsPage';
import { SLOW_LOAD_NOTE_DELAY_MS } from '@canopy/ui-shared/lib';
import {
  HOSTED_SETTINGS_PAGE_SKELETONS,
  SETTINGS_PAGE_SLOW_LOAD_NOTE,
  settingsPageSkeleton,
  type SettingsPageSkeletonVariant,
} from '../loading-skeletons';

const ALL_KINDS: readonly SettingsPageDataKind[] = [
  ...ACCOUNT_PAGE_DATA_KINDS,
  ...ORGANIZATION_PAGE_DATA_KINDS,
];

const VARIANT_TEST_IDS: Record<SettingsPageSkeletonVariant, string> = {
  list: 'settings-skeleton-list',
  form: 'settings-skeleton-form',
  table: 'settings-skeleton-table',
  cards: 'settings-skeleton-cards',
  chart: 'settings-skeleton-chart-bars',
  graph: 'settings-skeleton-chart-graph',
  spinner: 'centered-loading-spinner',
};

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node);
  });
}

describe('HOSTED_SETTINGS_PAGE_SKELETONS', () => {
  it('maps every page-data kind, and nothing else', () => {
    expect(Object.keys(HOSTED_SETTINGS_PAGE_SKELETONS).sort()).toEqual(
      [...ALL_KINDS].sort(),
    );
  });

  it.each([
    ['organization.members', 'list'],
    ['organization.groups', 'list'],
    ['organization.projects', 'list'],
    ['organization.list', 'list'],
    ['organization.settings', 'form'],
    ['account.security', 'form'],
    ['account.notifications', 'form'],
    ['organization.statistics', 'chart'],
    ['organization.memory.graph', 'graph'],
    ['organization.memory.ops', 'table'],
    ['account.digests', 'cards'],
    ['organization.digests', 'cards'],
    ['account.billing', 'cards'],
  ] as const)('%s loads as %s', (kind, variant) => {
    expect(HOSTED_SETTINGS_PAGE_SKELETONS[kind]).toBe(variant);
  });
});

describe('settingsPageSkeleton', () => {
  it.each(ALL_KINDS)(
    '%s renders its skeleton in a delayed placeholder, with no text',
    async (kind) => {
      await render(settingsPageSkeleton(kind));
      const placeholder = container.querySelector(
        '[data-testid="delayed-loading-placeholder"]',
      );
      expect(placeholder?.getAttribute('data-visible')).toBe('false');
      const skeleton = placeholder?.querySelector(
        `[data-testid="${VARIANT_TEST_IDS[HOSTED_SETTINGS_PAGE_SKELETONS[kind]]}"]`,
      );
      expect(skeleton?.getAttribute('role')).toBe('status');
      // Only the screen-reader "Loading" label; never visible copy.
      expect(container.textContent).toBe('Loading');
    },
  );

  it('says the page is slow below its skeleton once the load runs long', async () => {
    jest.useFakeTimers();
    try {
      await render(settingsPageSkeleton('account.account'));
      const note = (): Element | null =>
        container.querySelector(
          '[data-testid="delayed-loading-placeholder"] > [data-testid="slow-load-note"]',
        );
      expect(note()?.textContent).toBe('');
      await act(async () => {
        jest.advanceTimersByTime(SLOW_LOAD_NOTE_DELAY_MS);
      });
      expect(note()?.textContent).toBe(SETTINGS_PAGE_SLOW_LOAD_NOTE);
      expect(SETTINGS_PAGE_SLOW_LOAD_NOTE).toBe('Still loading settings…');
    } finally {
      jest.useRealTimers();
    }
  });

  it('draws the requested number of list rows', async () => {
    await render(settingsPageSkeleton('organization.members', 5));
    expect(
      container.querySelector('[data-testid="settings-skeleton-list"]')
        ?.children.length,
    ).toBe(6);
  });
});

describe('HostedSettingsPage while a route loads', () => {
  async function renderLoading(
    route: SettingsRoute,
    pathname: string,
  ): Promise<void> {
    const client = createFakeSettingsClient({
      'settings.pageData': () => new Promise<never>(() => {}),
      'settings.bootstrap': () => new Promise<never>(() => {}),
    });
    const { host } = createTestSettingsHost({ client, pathname });
    await render(
      <TestSettingsHost host={host}>
        <SettingsStoreProvider client={client} accountId="account-1">
          <HostedSettingsPage route={route} freeAccess={false} />
        </SettingsStoreProvider>
      </TestSettingsHost>,
    );
  }

  it('shows an account page’s header and its skeleton, without loading copy', async () => {
    await renderLoading(
      { scope: 'account', page: 'digests' },
      '/account/digests',
    );

    const frame = container.querySelector('main');
    expect(
      frame?.querySelector('[data-testid="page-header-title"]')?.textContent,
    ).toBe('Digests');
    expect(
      frame?.querySelector(
        '[data-testid="account-settings-body"] [data-testid="settings-skeleton-cards"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).not.toMatch(/Loading account settings/);
    expect(container.textContent).not.toMatch(/Loading[^]*…/);
  });

  it('shows an organization tab’s skeleton under its headers', async () => {
    await renderLoading(
      { scope: 'organization', organizationId: 'org-1', page: 'statistics' },
      '/organization/org-1/statistics',
    );

    const placeholder = container.querySelector(
      '[data-testid="organization-settings-loading"]',
    );
    expect(
      placeholder?.querySelector('[data-testid="page-header-title"]'),
    ).not.toBeNull();
    expect(
      placeholder?.querySelector(
        '[data-testid="settings-skeleton-chart-bars"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="centered-loading-spinner"]'),
    ).toBeNull();
  });

  it('shows the Organizations list’s header and skeleton in the settings column', async () => {
    await renderLoading({ scope: 'organizations' }, '/organizations');

    const column = container.querySelector(
      '[data-testid="settings-page-column"]',
    );
    expect(
      column?.querySelector('[data-testid="page-header-title"]')?.textContent,
    ).toBe('Organizations');
    expect(
      column?.querySelector('[data-testid="page-header-description"]')
        ?.textContent,
    ).toBe('Open an organization, answer an invitation, or start a new one.');
    // The actions slot keeps its height, but "New organization" waits for
    // the list.
    const actions = column?.querySelector(
      '[data-testid="page-header-actions"]',
    );
    expect(actions).not.toBeNull();
    expect(actions?.childElementCount).toBe(0);
    expect(
      container.querySelector('[data-testid="team-panel-create"]'),
    ).toBeNull();
    // The header comes before the skeleton.
    const header = column?.querySelector('[data-testid="page-header"]');
    const skeleton = column?.querySelector(
      '[data-testid="hosted-settings-route-loading"] [data-testid="settings-skeleton-list"]',
    );
    expect(skeleton).not.toBeNull();
    expect(
      header && skeleton
        ? header.compareDocumentPosition(skeleton) &
            Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).not.toBe(0);
  });

  it('centers a spinner for a page whose shape is not predictable', async () => {
    await renderLoading(
      {
        scope: 'organization',
        organizationId: 'org-1',
        page: 'members',
        userId: 'user-2',
      },
      '/organization/org-1/members/user-2',
    );

    expect(
      container.querySelector(
        '[data-testid="settings-page-column"] [data-testid="centered-loading-spinner"]',
      ),
    ).not.toBeNull();
  });
});
