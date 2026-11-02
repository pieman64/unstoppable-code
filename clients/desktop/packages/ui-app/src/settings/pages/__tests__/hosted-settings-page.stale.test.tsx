/**
 * @jest-environment jsdom
 */
/* eslint-disable @typescript-eslint/require-await -- act() callbacks stay async so React flushes the settled promises they trigger. */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import type * as ReactModule from 'react';
import type * as ProtocolSettingsModule from '@canopy/protocol/settings';
import type * as PreloadablePageModule from '../preloadable-page';
import { createRoot, type Root } from 'react-dom/client';
import {
  SettingsStoreProvider,
  useSettingsStoreApi,
  type SettingsStore,
} from '@canopy/app-state/settings';
import {
  parseSettingsRoute,
  settingsRouteToPath,
  type OrganizationTeamPageData,
  type SettingsPageData,
  type SettingsRoute,
} from '@canopy/protocol/settings';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';
import { HostedSettingsPage } from '../HostedSettingsPage';

/**
 * The previous page held during the loading delay (CAN-4558 item C). Pages
 * are stand-ins, so the test exercises only the hold, the placeholder and
 * the swap.
 */
jest.mock('../registry', () => {
  const { createElement } = jest.requireActual<typeof ReactModule>('react');
  const { preloadablePage } = jest.requireActual<typeof PreloadablePageModule>(
    '../preloadable-page',
  );
  const { settingsRouteToPath: toPath } = jest.requireActual<
    typeof ProtocolSettingsModule
  >('@canopy/protocol/settings');
  const pages = new Map<string, unknown>();
  const pageFor = (kind: string): unknown => {
    const existing = pages.get(kind);
    if (existing !== undefined) return existing;
    const created = preloadablePage(() =>
      Promise.resolve({
        default: ({ route }: { route: SettingsRoute }): JSX.Element =>
          createElement(
            'button',
            {
              type: 'button',
              'data-testid': 'stand-in-page',
              'data-route': toPath(route),
            },
            kind,
          ),
      }),
    );
    pages.set(kind, created);
    return created;
  };
  return {
    HOSTED_SETTINGS_PAGES: new Proxy(
      {},
      { get: (_target, kind): unknown => pageFor(String(kind)) },
    ),
  };
});

const ORG_FEED: SettingsRoute = {
  scope: 'organization',
  organizationId: 'org-1',
  page: 'feed',
};
const ORG_MEMBERS: SettingsRoute = {
  scope: 'organization',
  organizationId: 'org-1',
  page: 'members',
};
const OTHER_ORG_FEED: SettingsRoute = {
  scope: 'organization',
  organizationId: 'org-2',
  page: 'feed',
};

function team(organizationId: string): OrganizationTeamPageData {
  return {
    detail: {
      id: organizationId,
      name: organizationId === 'org-1' ? 'Northwind' : 'Fabrikam',
      viewerRole: 'OWNER',
      members: [],
      subTeams: [],
      usageStatsMinRole: 'ADMIN',
      canViewUsageStats: true,
      logoUrl: null,
      githubConnection: { connected: false, accountLogin: null },
    },
    organizations: [],
    viewerEmail: 'ada@example.com',
    billingEnabled: true,
    memoryEnabled: true,
    digestsEnabled: true,
    projectsEnabled: true,
    billingNeedsAttention: false,
    freeAccess: false,
    lapsed: null,
    mobileBrowser: false,
  };
}

function pageData(route: SettingsRoute): SettingsPageData {
  if (route.scope !== 'organization') throw new Error('organization only');
  return route.page === 'members'
    ? { kind: 'organization.members', data: team(route.organizationId) }
    : { kind: 'organization.feed', data: team(route.organizationId) };
}

interface Pending {
  resolve(): void;
  reject(error: unknown): void;
}

let container: HTMLElement;
let root: Root;
let pending: Map<string, Pending>;
let capturedStore: SettingsStore | null;

const client = createFakeSettingsClient({
  'settings.pageData': (input) => {
    const route =
      typeof input === 'object' && input !== null && 'route' in input
        ? parseSettingsRoute(input.route)
        : null;
    if (route === null) throw new Error('expected a route');
    return new Promise((resolve, reject) => {
      pending.set(settingsRouteToPath(route), {
        resolve: () => resolve(pageData(route)),
        reject,
      });
    });
  },
  'settings.bootstrap': () => new Promise<never>(() => {}),
});
const { host } = createTestSettingsHost({ client });

function CaptureStore(): null {
  capturedStore = useSettingsStoreApi();
  return null;
}

function Tree({
  route,
  accountId = 'account-1',
}: {
  readonly route: SettingsRoute;
  readonly accountId?: string;
}): JSX.Element {
  return (
    <TestSettingsHost host={host}>
      <SettingsStoreProvider client={client} accountId={accountId}>
        <CaptureStore />
        <HostedSettingsPage route={route} freeAccess={false} />
      </SettingsStoreProvider>
    </TestSettingsHost>
  );
}

async function show(route: SettingsRoute, accountId?: string): Promise<void> {
  await act(async () => {
    root.render(<Tree route={route} accountId={accountId} />);
  });
}

async function settle(route: SettingsRoute): Promise<void> {
  await act(async () => {
    pending.get(settingsRouteToPath(route))?.resolve();
  });
  // The stand-in chunk loads, then the page renders.
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

function shownPage(): HTMLElement | null {
  return container.querySelector('[data-testid="stand-in-page"]');
}

function placeholder(): Element | null {
  return container.querySelector(
    '[data-testid="organization-settings-loading"]',
  );
}

/** The placeholder's delayed skeleton box. */
function skeleton(): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '[data-testid="organization-settings-loading"] [data-testid="delayed-loading-placeholder"]',
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  pending = new Map();
  capturedStore = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  jest.useRealTimers();
});

async function openFeed(): Promise<void> {
  await show(ORG_FEED);
  await settle(ORG_FEED);
  expect(shownPage()?.dataset.route).toBe('/organization/org-1');
}

describe('HostedSettingsPage holds the previous page while the next loads', () => {
  it('keeps the previous tab, inert, until the delay passes, then shows the placeholder', async () => {
    await openFeed();

    await show(ORG_MEMBERS);
    expect(shownPage()?.dataset.route).toBe('/organization/org-1');
    expect(shownPage()?.closest('[inert]')).not.toBeNull();
    expect(placeholder()).toBeNull();

    await advance(199);
    expect(shownPage()?.dataset.route).toBe('/organization/org-1');
    expect(placeholder()).toBeNull();

    await advance(1);
    expect(shownPage()).toBeNull();
    expect(placeholder()).not.toBeNull();
    // The held page already used up the delay, so the tab's skeleton shows
    // at once instead of leaving the body empty for a second delay.
    await advance(0);
    expect(skeleton()?.dataset.visible).toBe('true');
    expect(
      skeleton()?.querySelector('[data-testid="settings-skeleton-list"]'),
    ).not.toBeNull();

    await settle(ORG_MEMBERS);
    expect(placeholder()).toBeNull();
    expect(shownPage()?.dataset.route).toBe('/organization/org-1/members');
    expect(shownPage()?.closest('[inert]')).toBeNull();
  });

  it('swaps in one step when the next tab arrives inside the delay', async () => {
    await openFeed();

    await show(ORG_MEMBERS);
    await advance(100);
    await settle(ORG_MEMBERS);
    expect(placeholder()).toBeNull();
    expect(shownPage()?.dataset.route).toBe('/organization/org-1/members');

    await advance(500);
    expect(placeholder()).toBeNull();
    expect(shownPage()?.closest('[inert]')).toBeNull();
  });

  it('never holds a page across organizations', async () => {
    await openFeed();

    await show(OTHER_ORG_FEED);
    expect(shownPage()).toBeNull();
    expect(placeholder()).not.toBeNull();
    // Nothing was held, so the skeleton waits out the delay.
    await advance(199);
    expect(skeleton()?.dataset.visible).toBe('false');
    await advance(1);
    expect(skeleton()?.dataset.visible).toBe('true');
  });

  it('never holds a page across accounts', async () => {
    await openFeed();

    await show(ORG_MEMBERS, 'account-2');
    expect(shownPage()).toBeNull();
    expect(placeholder()).not.toBeNull();
  });

  it('drops the held page after a refresh', async () => {
    await openFeed();

    await act(async () => {
      void capturedStore?.getState().refresh();
    });
    await show(ORG_MEMBERS);
    expect(shownPage()).toBeNull();
    expect(placeholder()).not.toBeNull();
  });

  it('shows a failure under the organization header, and holds nothing after it', async () => {
    await openFeed();

    await show(ORG_MEMBERS);
    await act(async () => {
      pending.get('/organization/org-1/members')?.reject(new Error('offline'));
    });
    expect(shownPage()).toBeNull();
    expect(
      placeholder()?.querySelector('[data-testid="hosted-settings-failed"]'),
    ).not.toBeNull();

    // After the failure, the next tab starts from the placeholder.
    await show({ ...ORG_FEED, page: 'groups' });
    expect(shownPage()).toBeNull();
    expect(placeholder()).not.toBeNull();
  });
});

describe('HostedSettingsPage Try again', () => {
  function failure(): Element | null {
    return container.querySelector('[data-testid="hosted-settings-failed"]');
  }

  function retryButton(): HTMLButtonElement {
    const button = failure()?.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('no button');
    return button;
  }

  it('keeps the failure on screen, its capsule spinning, until the reload settles', async () => {
    await show(ORG_MEMBERS);
    await act(async () => {
      pending.get('/organization/org-1/members')?.reject(new Error('offline'));
    });
    expect(failure()?.textContent).toContain("Couldn't load these settings.");
    expect(retryButton().textContent).toBe('Try again');

    await act(async () => retryButton().click());
    // The failure stays while the reload runs; nothing blanks to a skeleton.
    expect(failure()).not.toBeNull();
    expect(retryButton().textContent).toBe('Trying again…');
    expect(retryButton().getAttribute('aria-busy')).toBe('true');
    expect(retryButton().disabled).toBe(true);
    expect(skeleton()).toBeNull();

    await settle(ORG_MEMBERS);
    expect(failure()).toBeNull();
    expect(shownPage()?.dataset.route).toBe('/organization/org-1/members');
  });

  it('spins only on the route its retry started from', async () => {
    const groups: SettingsRoute = { ...ORG_FEED, page: 'groups' };
    await show(ORG_MEMBERS);
    await act(async () => {
      pending.get('/organization/org-1/members')?.reject(new Error('offline'));
    });
    // Try again on Members hangs while the viewer moves to another tab.
    await act(async () => retryButton().click());
    expect(retryButton().textContent).toBe('Trying again…');

    await show(groups);
    await act(async () => {
      pending.get(settingsRouteToPath(groups))?.reject(new Error('offline'));
    });
    expect(failure()?.textContent).toContain("Couldn't load these settings.");
    expect(retryButton().textContent).toBe('Try again');
    expect(retryButton().disabled).toBe(false);
  });

  it('shows the failure again, ready for another try, when the reload fails', async () => {
    await show(ORG_MEMBERS);
    await act(async () => {
      pending.get('/organization/org-1/members')?.reject(new Error('offline'));
    });
    await act(async () => retryButton().click());
    await act(async () => {
      pending.get('/organization/org-1/members')?.reject(new Error('offline'));
    });
    expect(retryButton().textContent).toBe('Try again');
    expect(retryButton().disabled).toBe(false);
  });
});
