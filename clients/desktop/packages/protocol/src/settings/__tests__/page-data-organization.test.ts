import {
  ORGANIZATION_PAGE_DATA_KINDS,
  organizationPageDataKindForRoute,
  parseOrganizationPageData,
  type OrganizationPageDataKind,
} from '../page-data-organization';
import { parseSettingsRoutePath, type SettingsRoute } from '../routes';

const ORG = '7b0c1f0e-4c1a-4d55-9b52-1d3c5e9f0a11';
const USER = '2d6f8a90-1b2c-4d3e-8f40-5a6b7c8d9e0f';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const ROUTE_KINDS: ReadonlyArray<readonly [string, OrganizationPageDataKind]> =
  [
    ['/organization', 'organization.list'],
    [`/organization/${ORG}`, 'organization.feed'],
    [`/organization/${ORG}/feed/item-1`, 'organization.feedItem'],
    [`/organization/${ORG}/statistics`, 'organization.statistics'],
    [`/organization/${ORG}/digests`, 'organization.digests'],
    [`/organization/${ORG}/digests/${OTHER}`, 'organization.digest'],
    [`/organization/${ORG}/members`, 'organization.members'],
    [`/organization/${ORG}/members/${USER}`, 'organization.member'],
    [
      `/organization/${ORG}/members/${USER}/digests/${OTHER}`,
      'organization.memberDigest',
    ],
    [`/organization/${ORG}/teams`, 'organization.groups'],
    [`/organization/${ORG}/projects`, 'organization.projects'],
    [`/organization/${ORG}/memory`, 'organization.memory.facts'],
    [`/organization/${ORG}/memory/graph`, 'organization.memory.graph'],
    [`/organization/${ORG}/memory/ops`, 'organization.memory.ops'],
    [`/organization/${ORG}/memory/fact/${OTHER}`, 'organization.memory.fact'],
    [`/organization/${ORG}/settings`, 'organization.settings'],
    [`/organization/${ORG}/settings?tab=policies`, 'organization.settings'],
    [`/organization/${ORG}/billing/invoices/inv-1`, 'organization.invoice'],
  ];

function routeFor(url: string): SettingsRoute {
  const [pathname = '', search = ''] = url.split('?');
  const route = parseSettingsRoutePath(pathname, search);
  if (route === null) throw new Error(`unparsed fixture ${url}`);
  return route;
}

const detail = {
  id: ORG,
  name: 'Acme',
  viewerRole: 'ADMIN',
  members: [
    {
      id: USER,
      name: 'Sam',
      email: 'sam@example.com',
      image: null,
      role: 'ADMIN',
      subTeamIds: [],
    },
  ],
  subTeams: [],
  usageStatsMinRole: 'ADMIN',
  canViewUsageStats: true,
  logoUrl: null,
  githubConnection: { connected: true, accountLogin: 'acme' },
};

const teamPage = {
  detail,
  organizations: [
    {
      id: ORG,
      name: 'Acme',
      role: 'ADMIN',
      memberCount: 1,
      subTeamCount: 0,
      logoUrl: null,
    },
  ],
  viewerEmail: 'sam@example.com',
  billingEnabled: true,
  memoryEnabled: true,
  digestsEnabled: true,
  projectsEnabled: true,
  billingNeedsAttention: false,
  freeAccess: false,
  lapsed: null,
  mobileBrowser: false,
};

const lapsed = {
  trialEndedAt: '2026-10-01T00:00:00.000Z',
  lapseReason: 'trial_ended',
  requiredPlanName: 'Business',
};

const archiveItem = {
  externalId: OTHER,
  cadence: 'WEEKLY',
  periodStart: '2026-10-06T00:00:00.000Z',
  periodEnd: '2026-10-13T00:00:00.000Z',
  headline: 'A busy week',
  variant: 'FULL',
  status: 'READY',
  billedCredits: null,
  createdAt: '2026-10-13T01:00:00.000Z',
};

const report = {
  externalId: OTHER,
  subjectType: 'ORGANIZATION',
  cadence: 'WEEKLY',
  periodStart: '2026-10-06T00:00:00.000Z',
  periodEnd: '2026-10-13T00:00:00.000Z',
  headline: 'A busy week',
  executiveSummaryMarkdown: 'Summary',
  bodyMarkdown: 'Body',
  metrics: {},
  variant: 'FULL',
};

describe('organizationPageDataKindForRoute', () => {
  it.each(ROUTE_KINDS)('%s loads %s', (url, kind) => {
    expect(organizationPageDataKindForRoute(routeFor(url))).toBe(kind);
  });

  it('covers every declared kind and leaves account routes alone', () => {
    expect(new Set(ROUTE_KINDS.map(([, kind]) => kind))).toEqual(
      new Set(ORGANIZATION_PAGE_DATA_KINDS),
    );
    expect(
      organizationPageDataKindForRoute({ scope: 'account', page: 'billing' }),
    ).toBeNull();
  });
});

describe('organizationPageDataSchema', () => {
  it('accepts the TeamPage projection for every tab that uses it', () => {
    for (const kind of [
      'organization.feed',
      'organization.statistics',
      'organization.members',
      'organization.groups',
      'organization.projects',
      'organization.settings',
    ] as const) {
      expect(parseOrganizationPageData({ kind, data: teamPage })?.kind).toBe(
        kind,
      );
      expect(
        parseOrganizationPageData({ kind, data: { ...teamPage, lapsed } }),
      ).not.toBeNull();
    }
    expect(
      parseOrganizationPageData({
        kind: 'organization.feedItem',
        data: { ...teamPage, highlightItemId: 'item-1' },
      }),
    ).not.toBeNull();
  });

  it('rejects malformed TeamPage data', () => {
    expect(
      parseOrganizationPageData({
        kind: 'organization.feed',
        data: { ...teamPage, detail: undefined },
      }),
    ).toBeNull();
    expect(
      parseOrganizationPageData({
        kind: 'organization.feed',
        data: { ...teamPage, lapsed: { ...lapsed, lapseReason: 'bored' } },
      }),
    ).toBeNull();
    expect(
      parseOrganizationPageData({
        kind: 'organization.feedItem',
        data: teamPage,
      }),
    ).toBeNull();
    expect(
      parseOrganizationPageData({
        kind: 'organization.unknown',
        data: teamPage,
      }),
    ).toBeNull();
  });

  it('carries the org digest archive as a DTO instead of rendered content', () => {
    expect(
      parseOrganizationPageData({
        kind: 'organization.digests',
        data: {
          ...teamPage,
          archive: {
            digests: [archiveItem],
            request: {
              status: 'ok',
              credits: {
                spendable: true,
                balanceCredits: 120,
                fundingKey: 120,
                fundingLabel: null,
              },
            },
          },
        },
      }),
    ).not.toBeNull();
    expect(
      parseOrganizationPageData({
        kind: 'organization.digests',
        data: { ...teamPage, lapsed, archive: null },
      }),
    ).not.toBeNull();
    expect(
      parseOrganizationPageData({
        kind: 'organization.digests',
        data: {
          ...teamPage,
          archive: {
            digests: [{ ...archiveItem, status: 'LOST' }],
            request: null,
          },
        },
      }),
    ).toBeNull();
  });

  it('keeps an org digest detail either lapsed or readable, never both', () => {
    const base = {
      organization: { id: ORG, name: 'Acme', viewerRole: 'OWNER' },
      canEdit: true,
    };
    const readable = {
      ...base,
      lapsed: null,
      report: {
        digest: {
          ...report,
          sharingEnabled: false,
          sharePath: '/share/digests/x',
        },
        neighbors: { olderId: null, newerId: OTHER },
        share: { sharePath: '/share/digests/x', sharingEnabled: false },
      },
    };
    expect(
      parseOrganizationPageData({
        kind: 'organization.digest',
        data: readable,
      }),
    ).not.toBeNull();
    expect(
      parseOrganizationPageData({
        kind: 'organization.digest',
        data: { ...base, lapsed, report: null },
      }),
    ).not.toBeNull();
    expect(
      parseOrganizationPageData({
        kind: 'organization.digest',
        data: { ...readable, lapsed },
      }),
    ).toBeNull();
  });

  it('validates member profile and member digest data', () => {
    const member = {
      org: { id: ORG, name: 'Acme' },
      member: {
        id: USER,
        name: 'Sam',
        email: 'sam@example.com',
        image: null,
        role: 'MEMBER',
        memberSinceIso: '2026-01-01T00:00:00.000Z',
      },
      viewerCanViewStats: true,
      editContext: { mode: 'org-member', orgId: ORG, userId: USER },
      orgLapsed: false,
      orgTrialEndedAt: null,
      orgLapseReason: null,
      requiredPlanName: null,
      viewerCanEditOrg: true,
      showDigestsTab: true,
      isOwnProfile: false,
      mobileBrowser: false,
    };
    expect(
      parseOrganizationPageData({ kind: 'organization.member', data: member }),
    ).not.toBeNull();
    expect(
      parseOrganizationPageData({
        kind: 'organization.member',
        data: { ...member, editContext: { mode: 'admin' } },
      }),
    ).toBeNull();
    expect(
      parseOrganizationPageData({
        kind: 'organization.memberDigest',
        data: {
          org: { id: ORG, name: 'Acme' },
          member: { id: USER, name: 'Sam' },
          digest: report,
          neighbors: { olderId: null, newerId: null },
        },
      }),
    ).not.toBeNull();
  });

  it('validates memory pages with their not-enabled state', () => {
    expect(
      parseOrganizationPageData({
        kind: 'organization.memory.graph',
        data: { enabled: false },
      }),
    ).not.toBeNull();
    expect(
      parseOrganizationPageData({
        kind: 'organization.memory.facts',
        data: { enabled: true, initialFacts: [], initialNextCursor: null },
      }),
    ).not.toBeNull();
    expect(
      parseOrganizationPageData({
        kind: 'organization.memory.facts',
        data: { enabled: true },
      }),
    ).toBeNull();
    expect(
      parseOrganizationPageData({
        kind: 'organization.memory.ops',
        data: {
          enabled: true,
          jobs: [],
          counts: { PENDING: 0, RUNNING: 0, DONE: 3, FAILED: 0, DEAD: 0 },
          searchEntries: [],
          config: {
            embedderId: 'e',
            rerankerId: 'r',
            tauRerank: 0.4,
            tauCosine: null,
            efSearch: 64,
            triageModel: 't',
            distillModel: 'd',
            judgeModel: 'j',
          },
        },
      }),
    ).not.toBeNull();
  });

  it('accepts an optional team header on memory pages and validates it', () => {
    expect(
      parseOrganizationPageData({
        kind: 'organization.memory.graph',
        data: { enabled: false, team: teamPage },
      }),
    ).not.toBeNull();
    expect(
      parseOrganizationPageData({
        kind: 'organization.memory.facts',
        data: {
          enabled: true,
          team: teamPage,
          initialFacts: [],
          initialNextCursor: null,
        },
      }),
    ).not.toBeNull();
    expect(
      parseOrganizationPageData({
        kind: 'organization.memory.graph',
        data: { enabled: true, team: { detail } },
      }),
    ).toBeNull();
    expect(
      parseOrganizationPageData({
        kind: 'organization.memory.graph',
        data: { enabled: false, team: { detail } },
      }),
    ).toBeNull();
  });

  it('validates the invoice detail and the organizations list', () => {
    const invoice = {
      id: 'inv-1',
      number: 'CAN-0001',
      issuedAt: '2026-10-01T00:00:00.000Z',
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-10-01T00:00:00.000Z',
      currency: 'usd',
      status: 'PAID',
      isCurrent: false,
      billTo: { name: 'Acme' },
      lineItems: [],
      subtotalUsd: 10,
      taxUsd: 0,
      totalUsd: 10,
      amountPaidUsd: 10,
      amountRefundedUsd: 0,
      credits: {},
    };
    expect(
      parseOrganizationPageData({
        kind: 'organization.invoice',
        data: { invoice },
      }),
    ).not.toBeNull();
    expect(
      parseOrganizationPageData({
        kind: 'organization.invoice',
        data: { invoice: { ...invoice, totalUsd: '10' } },
      }),
    ).toBeNull();
    expect(
      parseOrganizationPageData({ kind: 'organization.list', data: {} }),
    ).not.toBeNull();
  });
});
