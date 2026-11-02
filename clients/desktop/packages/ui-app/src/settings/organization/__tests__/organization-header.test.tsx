/**
 * @jest-environment jsdom
 */
/* eslint-disable @typescript-eslint/require-await -- act() callbacks stay async so React flushes the settled promises they trigger. */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SettingsStoreProvider,
  useSettingsStoreApi,
  type SettingsStore,
} from '@canopy/app-state/settings';
import type {
  OrganizationDetail,
  OrganizationSettingsRoute,
  SettingsBootstrap,
  SettingsOrganizationMembership,
} from '@canopy/protocol/settings';
import {
  createFakeSettingsClient,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';
import { teamNavItem } from '../../navigation/organization-nav-items';
import {
  OrganizationSettingsPlaceholder,
  organizationHeaderModel,
  organizationTabForRoute,
} from '../organization-header';
import { TeamPage } from '../team-page';
import {
  buildOrganizationDetail,
  OrganizationTestHost,
} from './helpers/members-section-harness';

/**
 * The read-only organization header a loading tab draws (CAN-4558 item C)
 * must be the live header's markup exactly, so it holds still when the page
 * replaces it.
 */

const MEMBERSHIPS: SettingsOrganizationMembership[] = [
  {
    id: 'org-1',
    name: 'Acme',
    logoUrl: null,
    role: 'OWNER',
    isPersonal: false,
  },
  {
    id: 'org-2',
    name: 'Beta',
    logoUrl: null,
    role: 'MEMBER',
    isPersonal: false,
  },
];

function detail(
  overrides: Partial<OrganizationDetail> = {},
): OrganizationDetail {
  return buildOrganizationDetail({
    members: [
      {
        id: 'u1',
        name: 'Ada',
        email: 'ada@example.com',
        image: null,
        role: 'OWNER',
        subTeamIds: [],
      },
      {
        id: 'u2',
        name: 'Grace',
        email: 'grace@example.com',
        image: null,
        role: 'MEMBER',
        subTeamIds: ['team-1'],
      },
    ],
    subTeams: [{ id: 'team-1', name: 'Platform', memberCount: 1 }],
    ...overrides,
  });
}

function bootstrap(
  memberships: SettingsOrganizationMembership[] = MEMBERSHIPS,
): SettingsBootstrap {
  return {
    version: 1,
    viewer: { id: 'account-1', email: 'ada@example.com', name: 'Ada' },
    account: {
      billingEnabled: true,
      digestsEnabled: true,
      integrationsEnabled: true,
      freeAccess: false,
    },
    organizations: memberships,
    organization: null,
  };
}

const ROUTE: OrganizationSettingsRoute = {
  scope: 'organization',
  organizationId: 'org-1',
  page: 'memory',
};

describe('organizationHeaderModel', () => {
  it('prefers the detail', () => {
    expect(
      organizationHeaderModel(
        'org-1',
        detail({ name: 'Acme Labs' }),
        MEMBERSHIPS,
      ),
    ).toEqual({
      id: 'org-1',
      name: 'Acme Labs',
      logoUrl: null,
      viewerRole: 'OWNER',
      isPersonal: false,
    });
  });

  it('falls back to the bootstrap membership', () => {
    expect(organizationHeaderModel('org-2', null, MEMBERSHIPS)).toEqual({
      id: 'org-2',
      name: 'Beta',
      logoUrl: null,
      viewerRole: 'MEMBER',
      isPersonal: false,
    });
  });

  it('never uses another organization’s detail', () => {
    expect(organizationHeaderModel('org-2', detail(), MEMBERSHIPS)?.name).toBe(
      'Beta',
    );
  });

  it('is null when nothing is known', () => {
    expect(organizationHeaderModel('org-9', null, MEMBERSHIPS)).toBeNull();
  });
});

describe('organizationTabForRoute', () => {
  const base = { scope: 'organization', organizationId: 'org-1' } as const;

  it('names the tab of routes under the organization header', () => {
    expect(organizationTabForRoute({ ...base, page: 'feed' })).toBe('feed');
    expect(
      organizationTabForRoute({ ...base, page: 'feed', itemId: 'item-1' }),
    ).toBe('feed');
    expect(organizationTabForRoute({ ...base, page: 'members' })).toBe(
      'members',
    );
    expect(
      organizationTabForRoute({ ...base, page: 'memory', memoryView: 'graph' }),
    ).toBe('memory');
    expect(
      organizationTabForRoute({ ...base, page: 'settings', subtab: 'billing' }),
    ).toBe('settings');
  });

  it('is null for drill-downs, the list and account pages', () => {
    expect(
      organizationTabForRoute({ ...base, page: 'members', userId: 'u1' }),
    ).toBeNull();
    expect(
      organizationTabForRoute({ ...base, page: 'digests', digestId: 'd1' }),
    ).toBeNull();
    expect(
      organizationTabForRoute({ ...base, page: 'settings', invoiceId: 'i1' }),
    ).toBeNull();
    expect(organizationTabForRoute({ scope: 'organizations' })).toBeNull();
    expect(
      organizationTabForRoute({ scope: 'account', page: 'account' }),
    ).toBeNull();
  });
});

describe('OrganizationSettingsPlaceholder', () => {
  let container: HTMLElement;
  let root: Root;
  let store: SettingsStore | null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    store = null;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function CaptureStore(): null {
    store = useSettingsStoreApi();
    return null;
  }

  async function render(
    client: FakeSettingsClient,
    children: ReactNode,
  ): Promise<void> {
    await act(async () => {
      root.render(
        <OrganizationTestHost client={client}>
          <SettingsStoreProvider client={client} accountId="account-1">
            <CaptureStore />
            {children}
          </SettingsStoreProvider>
        </OrganizationTestHost>,
      );
    });
  }

  function currentStore(): SettingsStore {
    if (store === null) throw new Error('No store');
    return store;
  }

  function teamPage(
    organizationDetail: OrganizationDetail,
    activeTab: 'memory' | 'settings' = 'memory',
  ): JSX.Element {
    return (
      <TeamPage
        initialDetail={organizationDetail}
        viewerEmail="ada@example.com"
        billingEnabled
        memoryEnabled
        projectsEnabled
        activeTab={activeTab}
        mobileBrowser={false}
      />
    );
  }

  function html(testId: string): string | undefined {
    return container.querySelector(`[data-testid="${testId}"]`)?.outerHTML;
  }

  it('draws the live page header, with no organization block', async () => {
    const client = createFakeSettingsClient({
      'settings.bootstrap': () => bootstrap(),
    });
    const organizationDetail = detail();

    await render(client, teamPage(organizationDetail));
    const liveHeader = html('page-header');
    expect(liveHeader).toBeDefined();
    expect(html('team-overview-section')).toBeUndefined();

    await act(async () => {
      await currentStore().getState().loadBootstrap('org-1');
    });
    currentStore()
      .getState()
      .rememberOrganizationDetail('org-1', organizationDetail);
    await render(client, <OrganizationSettingsPlaceholder route={ROUTE} />);

    expect(html('page-header')).toBe(liveHeader);
    expect(html('team-overview-section')).toBeUndefined();
    expect(html('team-org-switcher')).toBeUndefined();
    const item = teamNavItem('memory');
    expect(
      container.querySelector('[data-testid="page-header-title"]')?.textContent,
    ).toBe(item.label);
    expect(
      container.querySelector('[data-testid="page-header-description"]')
        ?.textContent,
    ).toBe(item.description);
    // The body is the tab's skeleton: Memory's facts load as a list.
    expect(
      container.querySelector(
        '[data-testid="organization-settings-loading"] [data-testid="delayed-loading-placeholder"] [data-testid="settings-skeleton-list"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="centered-loading-spinner"]'),
    ).toBeNull();
    // No visible loading copy; "Loading" is announced to assistive tech only.
    const visible = container.cloneNode(true);
    if (!(visible instanceof HTMLElement)) throw new Error('No clone');
    visible.querySelectorAll('.sr-only').forEach((node) => node.remove());
    expect(visible.textContent).not.toMatch(/Loading/);
  });

  it('names a Settings page by its own title while it loads', async () => {
    const client = createFakeSettingsClient({
      'settings.bootstrap': () => new Promise<never>(() => {}),
    });
    await render(
      client,
      <OrganizationSettingsPlaceholder
        route={{ ...ROUTE, page: 'settings', subtab: 'policies' }}
      />,
    );
    expect(
      container.querySelector('[data-testid="page-header-title"]')?.textContent,
    ).toBe('Policies');
    expect(
      container.querySelector('[data-testid="page-header-title"]')?.tagName,
    ).toBe('H1');
  });

  function organizationBootstrap(
    organization: Partial<NonNullable<SettingsBootstrap['organization']>>,
  ): SettingsBootstrap {
    return {
      ...bootstrap(),
      organization: {
        id: 'org-1',
        name: 'Acme',
        viewerRole: 'OWNER',
        isPersonal: false,
        visibleTabs: ['members', 'settings'],
        disabledTabs: [],
        billingNeedsAttention: false,
        billingEnabled: true,
        memoryEnabled: false,
        digestsEnabled: false,
        projectsEnabled: false,
        canViewUsageStats: true,
        freeAccess: false,
        githubConnected: true,
        lapse: null,
        ...organization,
      },
    };
  }

  async function placeholderTitle(
    organization: Partial<NonNullable<SettingsBootstrap['organization']>>,
    route: OrganizationSettingsRoute,
  ): Promise<string | null | undefined> {
    const client = createFakeSettingsClient({
      'settings.bootstrap': () => organizationBootstrap(organization),
    });
    await render(client, <CaptureStore />);
    await act(async () => {
      await currentStore().getState().loadBootstrap('org-1');
    });
    await render(client, <OrganizationSettingsPlaceholder route={route} />);
    return container.querySelector('[data-testid="page-header-title"]')
      ?.textContent;
  }

  it('names Billing as the loaded page will with free access on', async () => {
    expect(
      await placeholderTitle(
        { freeAccess: true },
        { ...ROUTE, page: 'settings', subtab: 'billing' },
      ),
    ).toBe('AI Credits');
  });

  it('names the first page a member gets on a bare Settings route', async () => {
    // A member has no General; the loaded page opens Usage instead.
    expect(
      await placeholderTitle(
        { viewerRole: 'MEMBER' },
        { ...ROUTE, page: 'settings' },
      ),
    ).toBe('Usage');
  });

  it('draws the Personal header for the personal organization', async () => {
    const client = createFakeSettingsClient({
      'settings.bootstrap': () =>
        bootstrap([{ ...MEMBERSHIPS[0], isPersonal: true }]),
    });
    await render(client, <CaptureStore />);
    await act(async () => {
      await currentStore().getState().loadBootstrap('org-1');
    });
    await render(client, <OrganizationSettingsPlaceholder route={ROUTE} />);

    expect(
      container.querySelector('[data-testid="team-personal-header"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="team-org-switcher"]'),
    ).toBeNull();
  });

  it('renders a body in place of the skeleton', async () => {
    const client = createFakeSettingsClient({
      'settings.bootstrap': () => bootstrap(),
    });
    await render(
      client,
      <OrganizationSettingsPlaceholder
        route={ROUTE}
        body={<p data-testid="failure-body">Failed</p>}
      />,
    );
    expect(
      container.querySelector('[data-testid="failure-body"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="delayed-loading-placeholder"]'),
    ).toBeNull();
  });

  it('keeps a rename in the store so the next tab draws it', async () => {
    const client = createFakeSettingsClient({
      'organization.rename': () => detail({ name: 'Renamed' }),
    });
    await render(client, teamPage(detail(), 'settings'));

    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="team-name-input"]',
    );
    if (input === null) throw new Error('No name input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'Renamed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.form?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      client.calls.filter((call) => call.operation === 'organization.rename'),
    ).toHaveLength(1);

    expect(currentStore().getState().organizationDetails['org-1']?.name).toBe(
      'Renamed',
    );
  });
});
