/**
 * @jest-environment jsdom
 */
import { renderToString } from 'react-dom/server';
import { act, type ComponentProps, type JSX, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { OrganizationDetail } from '@canopy/protocol/settings';
import { createFakeSettingsClient } from '../../__tests__/helpers/test-settings-host';
import {
  OrganizationTestHost,
  seatChargeSlot,
} from './helpers/members-section-harness';

import {
  organizationSettingsSubtabItem,
  TEAM_NAV_ITEMS,
} from '../../navigation/organization-nav-items';
import { TeamPage } from '../team-page';

const client = createFakeSettingsClient();
const webSlots = {
  seatCharge: seatChargeSlot(() => new Promise<never>(() => {})),
};

/**
 * The web host: with the seat-charge slot the Members invite stays inline,
 * as it is on the web.
 */
function WebOrganizationHost({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <OrganizationTestHost client={client} slots={webSlots}>
      {children}
    </OrganizationTestHost>
  );
}

type TeamPageProps = ComponentProps<typeof TeamPage>;

function buildDetail(
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

/** Renders the whole page shell. */
function renderShell(overrides: Partial<TeamPageProps> = {}): HTMLElement {
  const props: TeamPageProps = {
    initialDetail: buildDetail(),
    viewerEmail: 'owner@example.com',
    billingEnabled: true,
    memoryEnabled: false,
    projectsEnabled: false,
    mobileBrowser: false,
    activeTab: 'memory',
    ...overrides,
  };
  const container = document.createElement('div');
  container.innerHTML = renderToString(
    <WebOrganizationHost>
      <TeamPage {...props} />
    </WebOrganizationHost>,
  );
  return container;
}

const LAPSED: NonNullable<TeamPageProps['lapsed']> = {
  trialEndedAt: '2026-05-01T00:00:00.000Z',
  lapseReason: 'trial_ended',
  requiredPlanName: 'Business',
};

it('replaces the Personal header when the same organization is promoted by a router refresh', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    value: true,
    configurable: true,
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  const props: TeamPageProps = {
    initialDetail: buildDetail({ isPersonal: true, name: 'Personal' }),
    viewerEmail: 'owner@example.com',
    billingEnabled: false,
    memoryEnabled: false,
    projectsEnabled: false,
    mobileBrowser: false,
    activeTab: 'memory',
  };
  try {
    await act(async () => {
      root.render(
        <WebOrganizationHost>
          <TeamPage {...props} />
        </WebOrganizationHost>,
      );
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="team-personal-header"]'),
    ).not.toBeNull();
    await act(async () => {
      root.render(
        <WebOrganizationHost>
          <TeamPage
            {...props}
            initialDetail={buildDetail({
              isPersonal: false,
              name: 'Promoted team',
            })}
          />
        </WebOrganizationHost>,
      );
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="team-personal-header"]'),
    ).toBeNull();
    // The settings rail names the organization; the page's h1 is its title.
    expect(
      container.querySelector('[data-testid="team-overview-section"]'),
    ).toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe('Memory');
  } finally {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  }
});

/** Other names a section has used for its page, beyond the rail label. */
const PAGE_NAME_SYNONYMS: Partial<
  Record<TeamPageProps['activeTab'], string[]>
> = {
  feed: ['Feed', 'Activity'],
};

function byTestId(shell: HTMLElement, testId: string): HTMLElement {
  const el = shell.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`TeamPage rendered no [data-testid="${testId}"]`);
  return el;
}

/** Whether `first` comes before `second` in document order. */
function precedes(first: Element, second: Element): boolean {
  return (
    (first.compareDocumentPosition(second) &
      Node.DOCUMENT_POSITION_FOLLOWING) !==
    0
  );
}

// Which rows exist, which are inert while lapsed, and where the billing dot
// sits are the settings rail's rules (`settings-nav-model.test.ts`,
// `WebSettingsNav.test.tsx`). The page only names the destination it is on.
describe('TeamPage page header', () => {
  it.each(TEAM_NAV_ITEMS.map((item) => [item.key, item] as const))(
    'names the %s page as its h1',
    (activeTab, navItem) => {
      const shell = renderShell({ activeTab, projectsEnabled: true });
      // Settings shows its first page the viewer gets: General for an owner.
      const item =
        activeTab === 'settings'
          ? organizationSettingsSubtabItem('general')
          : navItem;

      const header = byTestId(shell, 'page-header');
      expect(
        shell.querySelectorAll('[data-testid="page-header"]'),
      ).toHaveLength(1);
      const title = byTestId(header, 'page-header-title');
      expect(title.tagName).toBe('H1');
      expect(title.textContent).toBe(item.label);
      expect(byTestId(header, 'page-header-description').textContent).toBe(
        item.description,
      );

      // The settings rail's scope picker names the organization, so the page
      // draws no identity block above its header.
      expect(shell.querySelectorAll('h1')).toHaveLength(1);
      expect(
        shell.querySelector('[data-testid="team-overview-section"]'),
      ).toBeNull();

      expect(shell.querySelector('[data-testid="team-tabs"]')).toBeNull();
      expect(shell.querySelector('[data-testid^="team-tab-"]')).toBeNull();
    },
  );

  // The header already names the page, so the content below starts with the
  // content itself (`docs/ux-writing.md`, "Page headers").
  it.each(TEAM_NAV_ITEMS.map((item) => [item.key, item] as const))(
    'does not restate the %s page name below the header',
    (activeTab, item) => {
      const shell = renderShell({
        activeTab,
        projectsEnabled: true,
        initialDetail: buildDetail({
          members: [
            {
              id: 'user-1',
              name: 'Owner',
              email: 'owner@example.com',
              image: null,
              role: 'OWNER',
              subTeamIds: [],
            },
          ],
        }),
      });
      const header = byTestId(shell, 'page-header');
      const restatements = new Set(
        [item.label, ...(PAGE_NAME_SYNONYMS[activeTab] ?? [])].map((name) =>
          name.toLowerCase(),
        ),
      );
      const repeated = Array.from(
        shell.querySelectorAll<HTMLElement>('h1, h2, h3'),
      )
        .filter(
          (heading) => !header.contains(heading) && precedes(header, heading),
        )
        .map((heading) =>
          (heading.textContent ?? '')
            .replace(/[\d+]+$/, '')
            .trim()
            .toLowerCase(),
        )
        .filter((text) => restatements.has(text));
      expect(repeated).toEqual([]);
    },
  );

  it('sits above the page notices', () => {
    const shell = renderShell({
      activeTab: 'settings',
      justJoined: true,
      lapsed: LAPSED,
    });

    const header = byTestId(shell, 'page-header');
    expect(precedes(header, byTestId(shell, 'team-joined-notice'))).toBe(true);
    expect(precedes(header, byTestId(shell, 'team-lapsed-notice'))).toBe(true);
  });

  it('names the page under the Personal header for a personal organization', () => {
    const shell = renderShell({
      initialDetail: buildDetail({ isPersonal: true, name: 'Personal' }),
      activeTab: 'statistics',
    });

    const header = byTestId(shell, 'page-header');
    expect(shell.querySelector('h1')?.textContent).toBe('Personal');
    expect(byTestId(header, 'page-header-title').textContent).toBe(
      'Statistics',
    );
    expect(precedes(byTestId(shell, 'team-personal-header'), header)).toBe(
      true,
    );
  });
});

// A page's sole action sits in the page header, so the panel below holds only
// its rows. The sections stay controlled by the shell for the open state.
describe('TeamPage header actions', () => {
  const ACTIONS = [
    ['members', 'team-add-member'],
    ['groups', 'team-create-subteam'],
    ['digests', 'org-digest-settings-link'],
  ] as const;

  it.each(ACTIONS)(
    'puts the %s action in the page header for a manager',
    (activeTab, testId) => {
      const shell = renderShell({ activeTab });
      const header = byTestId(shell, 'page-header');
      expect(header.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
      expect(shell.querySelectorAll(`[data-testid="${testId}"]`)).toHaveLength(
        1,
      );
    },
  );

  // The owner case opens a portal, which the string renderer cannot host; the
  // members route test covers the flag reaching the shell.
  it('never opens the invite dialog on arrival for a viewer who cannot invite', () => {
    const dialog = '[data-testid="add-member-dialog"]';
    for (const overrides of [
      { initialDetail: buildDetail({ viewerRole: 'MEMBER' }) },
      { lapsed: LAPSED },
    ]) {
      expect(
        renderShell({
          activeTab: 'members',
          inviteOnLoad: true,
          ...overrides,
        }).querySelector(dialog),
      ).toBeNull();
    }
  });

  it('links Digest settings to the organization settings', () => {
    const shell = renderShell({ activeTab: 'digests' });
    expect(
      byTestId(shell, 'org-digest-settings-link').getAttribute('href'),
    ).toBe('/organization/org-1/settings');
  });

  it.each(ACTIONS)(
    'shows no %s action to a plain member',
    (activeTab, testId) => {
      const shell = renderShell({
        activeTab,
        initialDetail: buildDetail({ viewerRole: 'MEMBER' }),
      });
      expect(shell.querySelector(`[data-testid="${testId}"]`)).toBeNull();
    },
  );

  it.each(ACTIONS)(
    'shows no %s action while the organization is lapsed',
    (activeTab, testId) => {
      const shell = renderShell({ activeTab, lapsed: LAPSED });
      expect(shell.querySelector(`[data-testid="${testId}"]`)).toBeNull();
    },
  );

  it('puts the Timeline live control in the page header, before the search row', async () => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      value: true,
      configurable: true,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <WebOrganizationHost>
            <TeamPage
              initialDetail={buildDetail()}
              viewerEmail="owner@example.com"
              billingEnabled={false}
              memoryEnabled={false}
              projectsEnabled={false}
              mobileBrowser={false}
              activeTab="feed"
            />
          </WebOrganizationHost>,
        );
        await Promise.resolve();
      });
      const header = byTestId(container, 'page-header');
      const live =
        header.querySelector('[data-testid="team-feed-live-toggle"]') ??
        header.querySelector('[data-testid="team-feed-refresh"]');
      expect(live).not.toBeNull();
      expect(
        container.querySelectorAll(
          '[data-testid="team-feed-live-toggle"], [data-testid="team-feed-refresh"]',
        ),
      ).toHaveLength(1);
      expect(
        byTestId(container, 'team-feed-search')
          .closest('[data-page-search-row]')
          ?.contains(live),
      ).toBe(false);
    } finally {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      container.remove();
    }
  });

  it('gives the other pages no header action', () => {
    for (const activeTab of ['statistics', 'projects', 'settings'] as const) {
      const shell = renderShell({ activeTab, projectsEnabled: true });
      const header = byTestId(shell, 'page-header');
      expect(header.querySelector('button, a')).toBeNull();
    }
  });
});

describe('TeamPage digests content', () => {
  it('renders the server-supplied archive content on the digests page', () => {
    const shell = renderShell({
      activeTab: 'digests',
      digestContent: (
        <p data-testid="archive-body">Organization work digests</p>
      ),
    });

    expect(shell.querySelector('[data-testid="archive-body"]')).not.toBeNull();
  });

  it('replaces archive content with the lapsed panel on a lapsed org', () => {
    const shell = renderShell({
      activeTab: 'digests',
      digestContent: (
        <p data-testid="archive-body">Organization work digests</p>
      ),
      lapsed: LAPSED,
    });

    // Outside LAPSED_LIVE_TABS, so the shell substitutes the lapsed panel for
    // the archive rather than rendering a live archive under a lapsed org.
    expect(shell.querySelector('[data-testid="archive-body"]')).toBeNull();
  });
});

describe('Projects page', () => {
  it('renders its section while lapsed', () => {
    const shell = renderShell({
      projectsEnabled: true,
      activeTab: 'projects',
      lapsed: LAPSED,
    });
    expect(
      shell.querySelector('[data-testid="team-projects-section"]'),
    ).not.toBeNull();
  });
});

describe('Personal organization shell (CAN-3597)', () => {
  const personalDetail = (): OrganizationDetail =>
    buildDetail({
      isPersonal: true,
      name: 'Personal',
      members: [
        {
          id: 'user-1',
          name: 'Owner',
          email: 'owner@example.com',
          image: null,
          role: 'OWNER',
          subTeamIds: [],
        },
      ],
    });

  it('renders the Personal header without branding, counts, or the switcher', () => {
    const shell = renderShell({ initialDetail: personalDetail() });
    const header = shell.querySelector('[data-testid="team-personal-header"]');
    expect(header?.textContent).toContain('Personal');
    expect(
      shell.querySelector('[data-testid="team-overview-section"]'),
    ).toBeNull();
    expect(shell.querySelector('[data-testid="team-org-switcher"]')).toBeNull();
  });

  it('draws no Personal header for an ordinary organization', () => {
    const shell = renderShell();
    expect(
      shell.querySelector('[data-testid="team-personal-header"]'),
    ).toBeNull();
    expect(shell.querySelector('[data-testid="team-org-switcher"]')).toBeNull();
  });
});
