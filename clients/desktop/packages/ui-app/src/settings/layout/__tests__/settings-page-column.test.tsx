/**
 * @jest-environment jsdom
 */
// Every settings page and every host frame (loading, error, placeholder)
// sits in one shared column, so the header keeps its left edge and width
// across pages, organization tabs and host states.
//
// Coverage: the column itself; the account frame (which owns the column for
// every `account.*` kind); the host states; the TeamPage shell (which owns it
// for every organization tab kind); the Organizations list; the invoice
// drill-downs. The digest and member-profile drill-downs and the
// organization memory layout assert it in their own suites.
// `COLUMN_OWNERS` names the owner for every page kind, so a new kind fails
// to compile until it says which shell gives it the column.

import type { JSX, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  OrganizationDetail,
  SettingsPageDataKind,
} from '@canopy/protocol/settings';
import type { InvoiceDetail } from '@canopy/protocol/settings/billing';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';
import { AccountSettingsFrame } from '../../account/AccountSettingsFrame';
import { AccountInvoicePage } from '../../billing/AccountInvoicePage';
import { OrganizationInvoicePage } from '../../billing/OrganizationInvoicePage';
import { OrganizationListPage } from '../../organization/OrganizationListPage';
import {
  OrganizationTestHost,
  seatChargeSlot,
} from '../../organization/__tests__/helpers/members-section-harness';
import { TeamPage } from '../../organization/team-page';
import type { TeamTab } from '../../navigation/organization-nav-items';
import { HostedSettingsRouteLoading } from '../../pages/HostedSettingsPage';
import { HOSTED_SETTINGS_PAGES } from '../../pages/registry';
import { HostedSettingsErrorState } from '../../pages/HostedSettingsStates';
import {
  SettingsPageColumn,
  TEAM_PAGE_COLUMN_CLASS,
} from '../SettingsPageColumn';
import {
  SettingsPageNotice,
  SettingsPageNoticeProvider,
} from '../settings-page-notice';

jest.mock('../../organization/team-panel', () => ({
  TeamPanel: (): JSX.Element => <div data-testid="team-panel" />,
}));
jest.mock('@canopy/ui-shared/components/InvoiceDetailView', () => ({
  InvoiceDetailView: (): JSX.Element => <div data-testid="invoice-view" />,
}));

const COLUMN = '[data-testid="settings-page-column"]';

/**
 * The shell that puts each page kind in the column. Each owner is rendered
 * in this file or in the suite named beside it.
 */
type ColumnOwner =
  | 'account frame'
  | 'organizations list'
  | 'team page'
  | 'digest drill-down (digest-pages.test.tsx)'
  | 'member profile (MemberProfilePage.data-sharing.test.tsx)'
  | 'memory layout (OrganizationMemoryLayout.test.tsx)'
  | 'organization invoice';

const COLUMN_OWNERS: { readonly [K in SettingsPageDataKind]: ColumnOwner } = {
  'account.account': 'account frame',
  'account.profile': 'account frame',
  'account.digests': 'account frame',
  'account.digest': 'account frame',
  'account.notifications': 'account frame',
  'account.labs': 'account frame',
  'account.appearance': 'account frame',
  'account.integrations': 'account frame',
  'account.security': 'account frame',
  'account.billing': 'account frame',
  'account.invoice': 'account frame',
  'organization.list': 'organizations list',
  'organization.feed': 'team page',
  'organization.feedItem': 'team page',
  'organization.statistics': 'team page',
  'organization.digests': 'team page',
  'organization.digest': 'digest drill-down (digest-pages.test.tsx)',
  'organization.members': 'team page',
  'organization.member':
    'member profile (MemberProfilePage.data-sharing.test.tsx)',
  'organization.memberDigest': 'digest drill-down (digest-pages.test.tsx)',
  'organization.groups': 'team page',
  'organization.projects': 'team page',
  'organization.memory.facts':
    'memory layout (OrganizationMemoryLayout.test.tsx)',
  'organization.memory.graph':
    'memory layout (OrganizationMemoryLayout.test.tsx)',
  'organization.memory.ops':
    'memory layout (OrganizationMemoryLayout.test.tsx)',
  'organization.memory.fact':
    'memory layout (OrganizationMemoryLayout.test.tsx)',
  'organization.settings': 'team page',
  'organization.invoice': 'organization invoice',
};

function render(node: ReactNode, pathname = '/account/security'): HTMLElement {
  const { host } = createTestSettingsHost({ pathname });
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    <TestSettingsHost host={host}>{node}</TestSettingsHost>,
  );
  return container;
}

/** The page's outermost element is the one shared column, and only one. */
function expectInOneColumn(container: HTMLElement): HTMLElement {
  const columns = container.querySelectorAll<HTMLElement>(COLUMN);
  expect(columns).toHaveLength(1);
  const column = columns[0];
  if (column === undefined) throw new Error('No settings column');
  expect(column.className.startsWith(TEAM_PAGE_COLUMN_CLASS)).toBe(true);
  expect(container.firstElementChild).toBe(column);
  return column;
}

describe('page kinds', () => {
  it('names a column owner for every registered page kind', () => {
    expect(Object.keys(COLUMN_OWNERS).sort()).toEqual(
      Object.keys(HOSTED_SETTINGS_PAGES).sort(),
    );
  });
});

describe('SettingsPageColumn', () => {
  it("is desktop Settings' 640px column that stretches under the header", () => {
    for (const token of [
      'mx-auto',
      'w-full',
      'max-w-176',
      'min-h-full',
      'flex-1',
      'flex-col',
      'gap-6',
      'px-4',
      'sm:px-8',
      'pt-8',
      'pb-16',
    ])
      expect(TEAM_PAGE_COLUMN_CLASS.split(' ')).toContain(token);
    expect(TEAM_PAGE_COLUMN_CLASS).not.toContain('max-w-5xl');
  });

  it('keeps the wide column for feeds and charts', () => {
    const container = render(
      <SettingsPageColumn width="wide">
        <p />
      </SettingsPageColumn>,
    );
    const column = container.querySelector(COLUMN);
    expect(column?.className.split(' ')).toContain('max-w-5xl');
    expect(column?.className.split(' ')).not.toContain('max-w-176');
  });

  it('renders a main landmark and adds placement classes', () => {
    const container = render(
      <SettingsPageColumn as="main" className="relative">
        <p />
      </SettingsPageColumn>,
    );
    const column = container.querySelector(COLUMN);
    expect(column?.tagName).toBe('MAIN');
    expect(column?.className).toBe(`${TEAM_PAGE_COLUMN_CLASS} relative`);
  });

  it('adds no second width or inset when nested', () => {
    const container = render(
      <SettingsPageColumn>
        <SettingsPageColumn>
          <p data-testid="inner" />
        </SettingsPageColumn>
      </SettingsPageColumn>,
    );
    expectInOneColumn(container);
    const inner = container.querySelector(
      '[data-testid="inner"]',
    )?.parentElement;
    expect(inner?.className).not.toContain('max-w-176');
    expect(inner?.className).not.toContain('px-4');
  });
});

describe('SettingsPageNotice', () => {
  it('renders the host notice where the page places it, or nothing', () => {
    expect(render(<SettingsPageNotice />).innerHTML).toBe('');
    const container = render(
      <SettingsPageNoticeProvider notice={<p data-testid="notice" />}>
        <SettingsPageNotice />
      </SettingsPageNoticeProvider>,
    );
    expect(container.querySelector('[data-testid="notice"]')).not.toBeNull();
  });
});

describe('host frames', () => {
  it('frames every account page in the column, the body at its full width', () => {
    const container = render(
      <AccountSettingsFrame freeAccess={false}>
        <p data-testid="content" />
      </AccountSettingsFrame>,
    );
    const column = expectInOneColumn(container);
    expect(column.tagName).toBe('MAIN');
    const body = container.querySelector(
      '[data-testid="account-settings-body"]',
    );
    expect(body?.className).not.toContain('max-w-3xl');
    expect(body?.className.split(' ')).toContain('w-full');
    expect(
      body?.contains(container.querySelector('[data-testid="content"]')),
    ).toBe(true);
  });

  it.each([
    'signed_out',
    'expired',
    'forbidden',
    'unsupported_server',
    'uncertain',
    'failed',
  ] as const)('puts the %s state in the column', (code) => {
    expectInOneColumn(render(<HostedSettingsErrorState code={code} />));
  });

  it('puts a loading route outside the account frame in the column', () => {
    const column = expectInOneColumn(
      render(
        <HostedSettingsRouteLoading route={{ scope: 'organizations' }} />,
        '/organizations',
      ),
    );
    expect(
      column.querySelector('[data-testid="settings-skeleton-list"]'),
    ).not.toBeNull();
  });

  it('keeps host states inside the account frame without a second inset', () => {
    const container = render(
      <AccountSettingsFrame freeAccess={false}>
        <HostedSettingsRouteLoading
          route={{ scope: 'account', page: 'security' }}
        />
        <HostedSettingsErrorState code="failed" />
      </AccountSettingsFrame>,
    );
    expectInOneColumn(container);
    expect(
      container.querySelector(
        '[data-testid="account-settings-body"] [data-testid="settings-skeleton-form"]',
      ),
    ).not.toBeNull();
  });

  it('shows a host notice below the account header', () => {
    const container = render(
      <SettingsPageNoticeProvider notice={<p data-testid="notice" />}>
        <AccountSettingsFrame freeAccess={false}>
          <p data-testid="content" />
        </AccountSettingsFrame>
      </SettingsPageNoticeProvider>,
    );
    const header = container.querySelector('[data-testid="page-header"]');
    const notice = container.querySelector('[data-testid="notice"]');
    expect(header?.contains(notice ?? null)).toBe(false);
    expect(
      (header?.compareDocumentPosition(notice ?? document) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

function detail(
  overrides: Partial<OrganizationDetail> = {},
): OrganizationDetail {
  return {
    id: 'org-1',
    name: 'Acme',
    viewerRole: 'OWNER',
    members: [],
    subTeams: [],
    usageStatsMinRole: 'ADMIN',
    canViewUsageStats: true,
    logoUrl: null,
    githubConnection: { connected: false, accountLogin: null },
    ...overrides,
  };
}

function renderTeamPage(activeTab: TeamTab): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    <OrganizationTestHost
      client={createFakeSettingsClient()}
      slots={{ seatCharge: seatChargeSlot(() => new Promise<never>(() => {})) }}
    >
      <TeamPage
        initialDetail={detail()}
        viewerEmail="owner@example.com"
        billingEnabled
        memoryEnabled={false}
        projectsEnabled={false}
        mobileBrowser={false}
        activeTab={activeTab}
      />
    </OrganizationTestHost>,
  );
  return container;
}

describe('organization pages', () => {
  it.each<TeamTab>(['members', 'groups', 'digests', 'settings'])(
    'renders the %s tab shell in the column with a reserved header slot',
    (tab) => {
      const container = renderTeamPage(tab);
      const column = expectInOneColumn(container);
      expect(column.className).toContain('relative');
      expect(
        container.querySelector('[data-testid="page-header-actions"]')
          ?.className,
        // A 28px capsule's height: every settings header action is compact.
      ).toContain('min-h-7');
      expect(column.className.split(' ')).toContain('max-w-176');
      // The settings rail's scope picker names and switches the
      // organization, so the page draws no switcher or identity block.
      expect(
        container.querySelector('[data-testid="team-org-switcher"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="team-overview-section"]'),
      ).toBeNull();
      expect(container.querySelector('h1')?.textContent).toBe(
        container.querySelector('[data-testid="page-header-title"]')
          ?.textContent,
      );
    },
  );

  it.each<TeamTab>(['feed', 'statistics', 'memory'])(
    'renders the %s tab in the wide column',
    (tab) => {
      const container = renderTeamPage(tab);
      const columns = container.querySelectorAll<HTMLElement>(COLUMN);
      expect(columns).toHaveLength(1);
      expect(columns[0]?.className.split(' ')).toContain('max-w-5xl');
      expect(container.firstElementChild).toBe(columns[0]);
    },
  );

  it('renders the Organizations list in the column with the notice after its heading', () => {
    const container = render(
      <SettingsPageNoticeProvider notice={<p data-testid="notice" />}>
        <OrganizationListPage
          route={{ scope: 'organizations' }}
          page={{ kind: 'organization.list', data: {} }}
        />
      </SettingsPageNoticeProvider>,
      '/organization',
    );
    const column = expectInOneColumn(container);
    expect(column.tagName).toBe('MAIN');
    const notice = container.querySelector('[data-testid="notice"]');
    expect(notice?.previousElementSibling?.querySelector('h1')).not.toBeNull();
    expect(notice?.nextElementSibling?.getAttribute('data-testid')).toBe(
      'team-panel',
    );
  });

  const INVOICE: InvoiceDetail = {
    id: 'inv-1',
    number: 'INV-1',
    issuedAt: '2026-10-01T00:00:00.000Z',
    periodStart: '2026-09-01T00:00:00.000Z',
    periodEnd: '2026-10-01T00:00:00.000Z',
    currency: 'usd',
    status: 'PAID',
    isCurrent: false,
    billTo: { kind: 'user', name: 'Ada', email: null },
    lineItems: [],
    subtotalUsd: 0,
    taxUsd: 0,
    totalUsd: 0,
    amountPaidUsd: 0,
    amountRefundedUsd: 0,
    credits: {
      usageGroups: [],
      totalUsedCredits: 0,
      addedGroups: [],
      totalAddedCredits: 0,
    },
  };

  it('renders the organization invoice in the column at document width', () => {
    const container = render(
      <OrganizationInvoicePage
        route={{
          scope: 'organization',
          organizationId: 'org-1',
          page: 'settings',
        }}
        page={{ kind: 'organization.invoice', data: { invoice: INVOICE } }}
      />,
      '/organization/org-1/billing/invoices/inv-1',
    );
    expectInOneColumn(container);
    expect(
      container.querySelector('[data-testid="invoice-view"]')?.parentElement
        ?.className,
    ).toBe('w-full max-w-3xl');
  });

  it('renders the account invoice inside the account frame without a second inset', () => {
    const container = render(
      <AccountSettingsFrame freeAccess={false}>
        <AccountInvoicePage
          route={{ scope: 'account', page: 'billing' }}
          page={{ kind: 'account.invoice', data: { invoice: INVOICE } }}
        />
      </AccountSettingsFrame>,
      '/account/billing/invoices/inv-1',
    );
    expectInOneColumn(container);
  });
});
