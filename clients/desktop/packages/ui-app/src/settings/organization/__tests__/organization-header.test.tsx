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
  OrganizationSummary,
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

const SUMMARIES: OrganizationSummary[] = MEMBERSHIPS.map((membership) => ({
  id: membership.id,
  name: membership.name,
  role: membership.role,
  memberCount: 1,
  subTeamCount: 0,
  logoUrl: null,
}));

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
  it('prefers the detail, with its counts', () => {
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
      memberCount: 2,
      teamCount: 1,
    });
  });

  it('falls back to the bootstrap membership, without counts', () => {
    expect(organizationHeaderModel('org-2', null, MEMBERSHIPS)).toEqual({
      id: 'org-2',
      name: 'Beta',
      logoUrl: null,
      viewerRole: 'MEMBER',
      isPersonal: false,
      memberCount: null,
      teamCount: null,
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

  function teamPage(organizationDetail: OrganizationDetail): JSX.Element {
    return (
      <TeamPage
        initialDetail={organizationDetail}
        organizations={SUMMARIES}
        viewerEmail="ada@example.com"
        billingEnabled
        memoryEnabled
        projectsEnabled
        billingNeedsAttention={false}
        activeTab="memory"
        mobileBrowser={false}
      />
    );
  }

  function html(testId: string): string | undefined {
    return container.querySelector(`[data-testid="${testId}"]`)?.outerHTML;
  }

  function switcherHtml(): string | undefined {
    return container
      .querySelector('[data-testid="team-org-switcher"]')
      ?.closest('label')?.outerHTML;
  }

  it('draws the live header’s markup from the cached detail', async () => {
    const client = createFakeSettingsClient({
      'settings.bootstrap': () => bootstrap(),
    });
    const organizationDetail = detail();

    await render(client, teamPage(organizationDetail));
    const liveHeader = html('team-overview-section');
    const liveSwitcher = switcherHtml();
    expect(liveHeader).toBeDefined();
    expect(liveSwitcher).toBeDefined();

    await act(async () => {
      await currentStore().getState().loadBootstrap('org-1');
    });
    currentStore()
      .getState()
      .rememberOrganizationDetail('org-1', organizationDetail);
    await render(client, <OrganizationSettingsPlaceholder route={ROUTE} />);

    expect(html('team-overview-section')).toBe(liveHeader);
    expect(switcherHtml()).toBe(liveSwitcher);
    const item = teamNavItem('memory');
    expect(
      container.querySelector('[data-testid="page-header-title"]')?.textContent,
    ).toBe(item.label);
    expect(
      container.querySelector('[data-testid="page-header-description"]')
        ?.textContent,
    ).toBe(item.description);
    // Read-only: nothing in the header acts on a page that has not loaded.
    expect(
      container
        .querySelector('[data-testid="team-overview-section"]')
        ?.closest('[inert]'),
    ).not.toBeNull();
    // The body is the tab's skeleton: Memory's facts load as a list.
    expect(
      container.querySelector(
        '[data-testid="organization-settings-loading"] [data-testid="delayed-loading-placeholder"] [data-testid="settings-skeleton-list"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="centered-loading-spinner"]'),
    ).toBeNull();
  });

  it('holds the name and counts with placeholder bars when nothing is cached', async () => {
    const client = createFakeSettingsClient({
      'settings.bootstrap': () => new Promise<never>(() => {}),
    });
    await render(client, <OrganizationSettingsPlaceholder route={ROUTE} />);

    const header = container.querySelector(
      '[data-testid="team-overview-section"]',
    );
    expect(header).not.toBeNull();
    expect(header?.querySelector('h1')?.textContent).toBe('');
    expect(
      header?.querySelectorAll('.canopy-inline-skeleton').length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      header?.querySelector('[data-testid="team-overview-member-count"]'),
    ).toBeNull();
    // No visible loading copy; "Loading" is announced to assistive tech only.
    const visible = container.cloneNode(true);
    if (!(visible instanceof HTMLElement)) throw new Error('No clone');
    visible.querySelectorAll('.sr-only').forEach((node) => node.remove());
    expect(visible.textContent).not.toMatch(/Loading/);
  });

  it('draws a membership without counts until a tab loads the detail', async () => {
    const client = createFakeSettingsClient({
      'settings.bootstrap': () => bootstrap(),
    });
    await render(client, <CaptureStore />);
    await act(async () => {
      await currentStore().getState().loadBootstrap('org-1');
    });
    await render(client, <OrganizationSettingsPlaceholder route={ROUTE} />);

    const header = container.querySelector(
      '[data-testid="team-overview-section"]',
    );
    expect(header?.querySelector('h1')?.textContent).toBe('Acme');
    expect(
      header?.querySelector('[data-testid="team-overview-member-count"]'),
    ).toBeNull();
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
    await render(client, teamPage(detail()));

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="team-name-edit"]')
        ?.click();
    });
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

    expect(currentStore().getState().organizationDetails['org-1']?.name).toBe(
      'Renamed',
    );
  });
});
