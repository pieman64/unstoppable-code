/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ExplorerFact,
  ExplorerFactDetail,
} from '@canopy/protocol/settings/organization-memory';
import type {
  OrganizationRole,
  OrganizationTeamPageData,
  SettingsOperationName,
  SettingsRoute,
} from '@canopy/protocol/settings';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsHandler,
  type TestSettingsHostOptions,
} from '../../__tests__/helpers/test-settings-host';
import {
  chooseSettingsOption,
  settingsSelectTrigger,
} from '../../__tests__/helpers/settings-select';
import { teamNavItem } from '../../navigation/organization-nav-items';
import { buildOrganizationDetail } from '../../organization/__tests__/helpers/members-section-harness';
import { OrganizationMemoryFactPage } from '../OrganizationMemoryFactPage';
import { OrganizationMemoryFactsPage } from '../OrganizationMemoryFactsPage';
import { OrganizationMemoryGraphPage } from '../OrganizationMemoryGraphPage';
import { OrganizationMemoryOpsPage } from '../OrganizationMemoryOpsPage';
import { memoryPoliciesHref } from '../OrganizationMemoryLayout';

// The graph view's canvas needs APIs jsdom lacks; the layout tests only need
// the page around it.
jest.mock('../EntityGraphView', () => ({
  EntityGraphView: (): ReactNode => <div data-testid="entity-graph-view" />,
}));

const ORG_ID = 'org-1';

function memoryRoute(
  extra: Partial<Extract<SettingsRoute, { scope: 'organization' }>> = {},
): SettingsRoute {
  return {
    scope: 'organization',
    organizationId: ORG_ID,
    page: 'memory',
    ...extra,
  };
}

function team(
  role: OrganizationRole = 'OWNER',
  overrides: Partial<OrganizationTeamPageData> = {},
): OrganizationTeamPageData {
  return {
    detail: buildOrganizationDetail({ viewerRole: role }),
    organizations: [
      {
        id: ORG_ID,
        name: 'Acme',
        role,
        memberCount: 1,
        subTeamCount: 0,
        logoUrl: null,
      },
    ],
    viewerEmail: 'owner@example.com',
    billingEnabled: false,
    memoryEnabled: true,
    digestsEnabled: true,
    projectsEnabled: true,
    billingNeedsAttention: false,
    freeAccess: false,
    lapsed: null,
    mobileBrowser: false,
    ...overrides,
  };
}

const FACT: ExplorerFact = {
  id: 'fact-1',
  factText: 'Deploys go out on Tuesdays',
  evidenceType: 'OBSERVED',
  evidenceQuote: 'we deploy on Tuesdays',
  validAt: null,
  invalidAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  expiredAt: null,
  invalidatedById: null,
  liveness: 'live',
  entities: [],
};

const DETAIL: ExplorerFactDetail = {
  ...FACT,
  sources: [],
  supersessionChain: [],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function setup(
  handlers: Partial<Record<SettingsOperationName, FakeSettingsHandler>> = {},
  options: Omit<TestSettingsHostOptions, 'client'> = {},
): ReturnType<typeof createTestSettingsHost> {
  const client = createFakeSettingsClient(handlers);
  return createTestSettingsHost({ ...options, client });
}

async function render(
  host: ReturnType<typeof createTestSettingsHost>['host'],
  page: ReactNode,
): Promise<void> {
  await act(async () => {
    root.render(<TestSettingsHost host={host}>{page}</TestSettingsHost>);
    await Promise.resolve();
  });
}

function query(testId: string): Element | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function factsPage(
  initialFacts: ExplorerFact[],
  teamData: OrganizationTeamPageData | undefined,
): ReactNode {
  return (
    <OrganizationMemoryFactsPage
      route={memoryRoute()}
      page={{
        kind: 'organization.memory.facts',
        data: {
          enabled: true,
          initialFacts,
          initialNextCursor: null,
          ...(teamData === undefined ? {} : { team: teamData }),
        },
      }}
    />
  );
}

describe('OrganizationMemoryLayout', () => {
  it('renders the organization shell with the views under its header when the page carries team data', async () => {
    const { host } = setup();
    await render(host, factsPage([FACT], team()));

    // The settings rail names the organization; the page header is its h1.
    expect(query('team-overview-section')).toBeNull();
    const title = query('page-header-title');
    expect(title?.tagName).toBe('H1');
    expect(title?.textContent).toBe(teamNavItem('memory').label);
    expect(query('page-header-description')?.textContent).toBe(
      teamNavItem('memory').description,
    );
    // The views sit under the header, not in its actions slot.
    const header = query('page-header');
    const views = query('memory-views-tabs');
    expect(views).not.toBeNull();
    expect(header?.contains(views)).toBe(false);
    expect(
      Array.from(views?.querySelectorAll('button') ?? []).map((tab) => [
        tab.textContent,
        tab.getAttribute('aria-pressed'),
      ]),
    ).toEqual([
      ['Facts', 'true'],
      ['Graph', 'false'],
      ['Operations', 'false'],
    ]);
    expect(query('memory-fact-fact-1')).not.toBeNull();
    // The rail moves around the organization; there is no back link.
    expect(container.textContent).not.toContain('← Organization');
    expect(query('memory-fact-back')).toBeNull();
  });

  it('keeps the shared column and an h1 page header without team data', async () => {
    const { host } = setup();
    await render(host, factsPage([FACT], undefined));

    expect(query('team-overview-section')).toBeNull();
    expect(query('settings-page-column')?.tagName).toBe('MAIN');
    const title = query('page-header-title');
    expect(title?.tagName).toBe('H1');
    expect(title?.textContent).toBe(teamNavItem('memory').label);
    expect(query('memory-views-tabs')).not.toBeNull();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('switches views through the settings router', async () => {
    const push = jest.fn();
    const { host } = setup({}, { router: { push } });
    await render(host, factsPage([FACT], team()));

    const graph = query('memory-views-tab-graph');
    if (!(graph instanceof HTMLButtonElement)) throw new Error('no graph tab');
    await act(async () => {
      graph.click();
      await Promise.resolve();
    });
    expect(push).toHaveBeenCalledWith('/organization/org-1/memory/graph');
  });

  it('selects the page view on Graph and Operations without a width override', async () => {
    const { host } = setup();
    await render(
      host,
      <OrganizationMemoryGraphPage
        route={memoryRoute({ memoryView: 'graph' })}
        page={{
          kind: 'organization.memory.graph',
          data: { enabled: true, team: team() },
        }}
      />,
    );
    expect(query('memory-views-tab-graph')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(query('entity-graph-view')).not.toBeNull();
    expect(query('settings-page-column')?.className).toContain('max-w-5xl');

    await render(
      host,
      <OrganizationMemoryOpsPage
        route={memoryRoute({ memoryView: 'ops' })}
        page={{
          kind: 'organization.memory.ops',
          data: {
            enabled: true,
            team: team(),
            jobs: [],
            counts: { PENDING: 0, RUNNING: 0, DONE: 0, FAILED: 0, DEAD: 0 },
            searchEntries: [],
            config: {
              embedderId: 'e',
              rerankerId: 'r',
              tauRerank: null,
              tauCosine: null,
              efSearch: 1,
              triageModel: 't',
              distillModel: 'd',
              judgeModel: 'j',
            },
          },
        }}
      />,
    );
    expect(query('memory-views-tab-ops')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('keeps Facts selected on a fact and leads its content with a link back to Facts', async () => {
    const { host } = setup();
    await render(
      host,
      <OrganizationMemoryFactPage
        route={memoryRoute({ factId: 'fact-1' })}
        page={{
          kind: 'organization.memory.fact',
          data: {
            enabled: true,
            team: team(),
            detail: DETAIL,
            transcript: null,
          },
        }}
      />,
    );

    expect(query('memory-views-tab-facts')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    const back = query('memory-fact-back');
    expect(back?.textContent).toBe('← Facts');
    expect(back?.getAttribute('href')).toBe('/organization/org-1/memory');
    expect(query('page-header')?.contains(back)).toBe(false);
  });

  it('shows the lapsed panel instead of memory for a lapsed organization, like other paused tabs', async () => {
    const { host } = setup();
    await render(
      host,
      factsPage(
        [FACT],
        team('OWNER', {
          lapsed: {
            trialEndedAt: null,
            lapseReason: 'trial_ended',
            requiredPlanName: null,
          },
        }),
      ),
    );

    expect(query('team-lapsed-state')).not.toBeNull();
    expect(query('memory-view')).toBeNull();
    expect(query('memory-fact-fact-1')).toBeNull();
  });

  it('renders the not-enabled state inside the organization shell, without views', async () => {
    const { host } = setup();
    await render(
      host,
      <OrganizationMemoryFactsPage
        route={memoryRoute()}
        page={{
          kind: 'organization.memory.facts',
          data: { enabled: false, team: team() },
        }}
      />,
    );

    expect(query('page-header-title')?.tagName).toBe('H1');
    expect(query('memory-not-enabled')).not.toBeNull();
    expect(query('memory-views-tabs')).toBeNull();
  });
});

describe('memoryPoliciesHref', () => {
  it('links editors of a healthy organization to its Policies settings', () => {
    expect(memoryPoliciesHref(ORG_ID, team('OWNER'))).toBe(
      '/organization/org-1/settings?tab=policies',
    );
    expect(memoryPoliciesHref(ORG_ID, team('ADMIN'))).toBe(
      '/organization/org-1/settings?tab=policies',
    );
  });

  it('offers nothing to members, lapsed organizations, or pages without team data', () => {
    expect(memoryPoliciesHref(ORG_ID, team('MEMBER'))).toBeNull();
    expect(
      memoryPoliciesHref(
        ORG_ID,
        team('OWNER', {
          lapsed: {
            trialEndedAt: null,
            lapseReason: 'trial_ended',
            requiredPlanName: null,
          },
        }),
      ),
    ).toBeNull();
    expect(memoryPoliciesHref(ORG_ID, undefined)).toBeNull();
  });
});

describe('Facts empty state', () => {
  const NO_FACTS = {
    'organization.memory.facts': (): unknown => ({
      facts: [],
      nextCursor: null,
    }),
  };

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('waits for the superseded check before saying there is no memory', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const { host } = setup({
      'organization.memory.facts': (): Promise<unknown> =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    await render(host, factsPage([], team('ADMIN')));

    expect(query('memory-facts-empty')).toBeNull();
    await act(async () => {
      answer({ facts: [], nextCursor: null });
      await Promise.resolve();
    });
    expect(query('memory-facts-empty')).not.toBeNull();
  });

  it('keeps the filters when the superseded check fails', async () => {
    const { host } = setup();
    await render(host, factsPage([], team('ADMIN')));
    await settle();

    expect(query('memory-facts-empty')).toBeNull();
    expect(
      container.querySelector('[role="combobox"][aria-label="Fact liveness"]'),
    ).not.toBeNull();
  });

  it('explains where facts come from and links editors to Policies', async () => {
    const { host } = setup(NO_FACTS);
    await render(host, factsPage([], team('ADMIN')));
    await settle();

    const empty = query('memory-facts-empty');
    expect(empty?.querySelector('h3')?.textContent).toBe(
      'No organization memory yet',
    );
    expect(empty?.querySelector('p')?.textContent).toBe(
      "Facts appear here as agents learn from chats in this organization's projects. Choose who contributes in Policies.",
    );
    const action = query('memory-facts-empty-policies');
    expect(action?.textContent).toBe('Open Policies');
    expect(action?.getAttribute('href')).toBe(
      '/organization/org-1/settings?tab=policies',
    );
    // Nothing to search or filter yet.
    expect(container.querySelector('[aria-label="Facts tab mode"]')).toBeNull();
    expect(
      container.querySelector('input[aria-label="Search organization memory"]'),
    ).toBeNull();
  });

  it('gives members only the first sentence and no action', async () => {
    const { host } = setup(NO_FACTS);
    await render(host, factsPage([], team('MEMBER')));
    await settle();

    expect(query('memory-facts-empty')?.querySelector('p')?.textContent).toBe(
      "Facts appear here as agents learn from chats in this organization's projects.",
    );
    expect(query('memory-facts-empty-policies')).toBeNull();
  });

  it('keeps the filters when only superseded facts exist', async () => {
    const { host } = setup({
      'organization.memory.facts': (input) => ({
        facts:
          typeof input === 'object' &&
          input !== null &&
          'liveness' in input &&
          input.liveness === 'all'
            ? [FACT]
            : [],
        nextCursor: null,
      }),
    });
    await render(host, factsPage([], team('ADMIN')));
    await act(async () => {
      await Promise.resolve();
    });

    expect(query('memory-facts-empty')).toBeNull();
    expect(
      container.querySelector('[role="combobox"][aria-label="Fact liveness"]'),
    ).not.toBeNull();
  });

  it('keeps the filters and says nothing matched when a filter empties the list', async () => {
    const { host } = setup({
      'organization.memory.facts': () => ({ facts: [], nextCursor: null }),
    });
    await render(host, factsPage([FACT], team()));

    await chooseSettingsOption(
      settingsSelectTrigger(container, '[aria-label="Fact liveness"]'),
      'superseded',
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(query('memory-facts-empty')).toBeNull();
    expect(container.textContent).toContain('No matching memory facts.');
    expect(
      container.querySelector('[role="combobox"][aria-label="Fact liveness"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Facts tab mode"]'),
    ).not.toBeNull();
  });
});
