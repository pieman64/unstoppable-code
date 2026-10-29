import {
  ACCOUNT_PAGE_DATA_KINDS,
  accountPageDataKindForRoute,
  accountPageDataSchema,
  parseAccountPageData,
  type AccountPageDataKind,
} from '../page-data-account';
import { settingsPageDataSchema } from '../page-data';
import type { SettingsRoute } from '../routes';

const ISO = '2026-10-01T12:00:00.000Z';

const DIGEST_ROW = {
  externalId: 'dg_1',
  cadence: 'WEEKLY',
  periodStart: ISO,
  periodEnd: ISO,
  headline: null,
  variant: 'FULL',
  status: 'READY',
  billedCredits: 3,
  createdAt: ISO,
};

/** One realistic DTO per kind, shaped like the route loader's props. */
const FIXTURES: Record<AccountPageDataKind, { kind: string; data: unknown }> = {
  'account.account': {
    kind: 'account.account',
    data: {
      initialName: 'Ada',
      initialImage: null,
      role: 'USER',
      email: 'ada@example.com',
    },
  },
  'account.profile': {
    kind: 'account.profile',
    data: {
      initialSettings: null,
      displayName: 'Ada',
      avatarUrl: 'https://cdn.example/a.png',
    },
  },
  'account.digests': {
    kind: 'account.digests',
    data: {
      digests: [DIGEST_ROW],
      billing: {
        status: 'ok',
        billing: {
          spendable: true,
          balanceCredits: 12,
          fundingKey: 12,
          fundingLabel: null,
        },
      },
    },
  },
  'account.digest': {
    kind: 'account.digest',
    data: {
      digest: {
        externalId: 'dg_1',
        subjectType: 'USER',
        cadence: 'WEEKLY',
        periodStart: ISO,
        periodEnd: ISO,
        headline: 'Week',
        executiveSummaryMarkdown: null,
        bodyMarkdown: '# Body',
        metrics: null,
        variant: 'FULL',
        sharingEnabled: false,
        shareSlug: 's',
        sharePath: '/share/digests/s',
      },
      audiences: [
        {
          organizationId: 'org_1',
          organizationName: 'Acme',
          featured: false,
          lapsed: false,
        },
      ],
      neighbors: { olderDigestId: 'dg_0', newerDigestId: null },
    },
  },
  'account.notifications': { kind: 'account.notifications', data: {} },
  'account.labs': { kind: 'account.labs', data: {} },
  'account.integrations': {
    kind: 'account.integrations',
    data: { userId: 'user_1' },
  },
  'account.security': {
    kind: 'account.security',
    data: { brandDisplayName: 'Canopy', emailPasswordAuthEnabled: true },
  },
  'account.billing': {
    kind: 'account.billing',
    data: {
      orgs: [{ id: 'org_1', name: 'Acme', canManageBilling: true }],
      orgCovered: false,
      chrome: {
        planDisplayName: 'Individual',
        trial: null,
        hasPaymentMethod: true,
        planKey: 'individual',
        source: 'subscription',
      },
      freeAccess: false,
    },
  },
  'account.invoice': {
    kind: 'account.invoice',
    data: {
      invoice: {
        id: '2026-10-01',
        number: 'INV-20261001',
        issuedAt: ISO,
        periodStart: ISO,
        periodEnd: ISO,
        currency: 'usd',
        status: 'PAID',
        isCurrent: false,
        billTo: { kind: 'user', name: 'Ada', email: 'ada@example.com' },
        lineItems: [
          {
            id: 'ch_1',
            kind: 'SUBSCRIPTION',
            status: 'SUCCEEDED',
            description: null,
            quantity: 1,
            unitPriceUsd: 20,
            amountUsd: 20,
            amountRefundedUsd: 0,
            servicePeriodStart: ISO,
            servicePeriodEnd: ISO,
            chargedAt: ISO,
            cardBrand: 'visa',
            cardLast4: '4242',
          },
        ],
        subtotalUsd: 20,
        taxUsd: 0,
        totalUsd: 20,
        amountPaidUsd: 20,
        amountRefundedUsd: 0,
        credits: {
          usageGroups: [],
          totalUsedCredits: 0,
          addedGroups: [],
          totalAddedCredits: 0,
        },
      },
    },
  },
};

const MALFORMED: Record<AccountPageDataKind, unknown> = {
  'account.account': { kind: 'account.account', data: { initialName: 'Ada' } },
  'account.profile': {
    kind: 'account.profile',
    data: {
      initialSettings: { enabled: 'yes' },
      displayName: 'Ada',
      avatarUrl: null,
    },
  },
  'account.digests': {
    kind: 'account.digests',
    data: { digests: [DIGEST_ROW], billing: { status: 'maybe' } },
  },
  'account.digest': {
    kind: 'account.digest',
    data: { digest: { externalId: 'dg_1' }, audiences: [], neighbors: {} },
  },
  'account.notifications': { kind: 'account.notifications', data: null },
  'account.labs': { kind: 'account.labs', data: null },
  'account.integrations': {
    kind: 'account.integrations',
    data: { userId: '' },
  },
  'account.security': {
    kind: 'account.security',
    data: { brandDisplayName: 'Canopy' },
  },
  'account.billing': {
    kind: 'account.billing',
    data: {
      orgs: [{ id: 'org_1' }],
      orgCovered: false,
      chrome: null,
      freeAccess: false,
    },
  },
  'account.invoice': {
    kind: 'account.invoice',
    data: { invoice: { id: '2026-10-01', billTo: { kind: 'team' } } },
  },
};

describe('account page data', () => {
  it.each(ACCOUNT_PAGE_DATA_KINDS)('%s accepts the loader DTO', (kind) => {
    const fixture = FIXTURES[kind];
    expect(accountPageDataSchema.safeParse(fixture).success).toBe(true);
    // Every account DTO is also a valid generic `settings.pageData` result.
    expect(settingsPageDataSchema.safeParse(fixture).success).toBe(true);
    expect(parseAccountPageData(fixture)?.kind).toBe(kind);
  });

  it.each(ACCOUNT_PAGE_DATA_KINDS)('%s rejects malformed data', (kind) => {
    expect(accountPageDataSchema.safeParse(MALFORMED[kind]).success).toBe(
      false,
    );
    expect(parseAccountPageData(MALFORMED[kind])).toBeNull();
  });

  it('tolerates additive fields', () => {
    const fixture = FIXTURES['account.security'];
    expect(
      accountPageDataSchema.safeParse({
        ...fixture,
        extra: true,
        data: {
          brandDisplayName: 'Canopy',
          emailPasswordAuthEnabled: false,
          more: 1,
        },
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(
      accountPageDataSchema.safeParse({ kind: 'organization.feed', data: {} })
        .success,
    ).toBe(false);
  });

  it('maps every account route to its kind', () => {
    const cases: ReadonlyArray<
      readonly [SettingsRoute, AccountPageDataKind | null]
    > = [
      [{ scope: 'account', page: 'account' }, 'account.account'],
      [{ scope: 'account', page: 'profile' }, 'account.profile'],
      [{ scope: 'account', page: 'digests' }, 'account.digests'],
      [
        { scope: 'account', page: 'digests', digestId: 'dg_1' },
        'account.digest',
      ],
      [{ scope: 'account', page: 'notifications' }, 'account.notifications'],
      [{ scope: 'account', page: 'integrations' }, 'account.integrations'],
      [{ scope: 'account', page: 'security' }, 'account.security'],
      [{ scope: 'account', page: 'billing' }, 'account.billing'],
      [
        { scope: 'account', page: 'billing', invoiceId: '2026-10-01' },
        'account.invoice',
      ],
      [{ scope: 'organizations' }, null],
      [{ scope: 'organization', organizationId: 'org_1', page: 'feed' }, null],
    ];
    for (const [route, kind] of cases)
      expect(accountPageDataKindForRoute(route)).toBe(kind);
  });
});
