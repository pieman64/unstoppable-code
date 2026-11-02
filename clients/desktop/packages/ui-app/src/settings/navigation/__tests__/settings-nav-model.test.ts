import type {
  OrganizationSettingsNavModel,
  SettingsNavModel,
} from '@canopy/protocol/settings';
import {
  buildSettingsNavGroups,
  selectSettingsNavRow,
  settingsNavLogicalRowKey,
} from '../settings-nav-model';

const ORG = 'org-1';

const ACCOUNT: SettingsNavModel['account'] = {
  billingEnabled: true,
  digestsEnabled: false,
  integrationsEnabled: true,
};

function organization(
  overrides: Partial<OrganizationSettingsNavModel> = {},
): OrganizationSettingsNavModel {
  return {
    id: ORG,
    name: 'Northwind Labs',
    visibleTabs: [
      'feed',
      'statistics',
      'digests',
      'members',
      'groups',
      'projects',
      'memory',
      'settings',
    ],
    disabledTabs: [],
    billingNeedsAttention: false,
    viewerRole: 'OWNER',
    settingsSubtabs: [
      'general',
      'policies',
      'integrations',
      'usage',
      'billing',
    ],
    ...overrides,
  };
}

function model(
  org: OrganizationSettingsNavModel | null,
  account: SettingsNavModel['account'] = ACCOUNT,
): SettingsNavModel {
  return { account, adminVisible: false, organization: org };
}

function rowKeys(
  groups: ReturnType<typeof buildSettingsNavGroups>,
): string[][] {
  return groups.map((group) => group.rows.map((row) => row.key));
}

describe('buildSettingsNavGroups', () => {
  it('shows only the account rows in the account scope, with no heading', () => {
    const groups = buildSettingsNavGroups(model(null));
    expect(groups.map((group) => [group.id, group.label])).toEqual([
      ['account', null],
    ]);
    expect(groups[0]?.ariaLabel).toBe('Account');
    expect(rowKeys(groups)[0]).toEqual([
      'account-account',
      'account-profile',
      'account-notifications',
      'account-integrations',
      'account-security',
      'account-billing',
    ]);
  });

  it('splits the organization Settings pages into rail rows around its pages', () => {
    const groups = buildSettingsNavGroups(model(organization()));
    expect(groups.map((group) => [group.id, group.label])).toEqual([
      ['organization', null],
      ['organization-activity', 'Activity'],
    ]);
    expect(groups[0]?.ariaLabel).toBe('Northwind Labs');
    expect(rowKeys(groups)).toEqual([
      [
        'organization-settings-general',
        'organization-members',
        'organization-groups',
        'organization-projects',
        'organization-memory',
        'organization-settings-policies',
        'organization-settings-integrations',
        'organization-settings-usage',
        'organization-settings-billing',
      ],
      ['organization-feed', 'organization-statistics', 'organization-digests'],
    ]);
    expect(groups[0]?.rows[5]?.href).toBe(
      `/organization/${ORG}/settings?tab=policies`,
    );
    expect(groups[0]?.rows[0]?.href).toBe(`/organization/${ORG}/settings`);
  });

  it('lists only the Settings pages the viewer gets', () => {
    const groups = buildSettingsNavGroups(
      model(
        organization({
          viewerRole: 'MEMBER',
          visibleTabs: ['feed', 'members', 'groups', 'settings'],
          settingsSubtabs: ['usage'],
        }),
      ),
    );
    expect(rowKeys(groups)).toEqual([
      [
        'organization-members',
        'organization-groups',
        'organization-settings-usage',
      ],
      ['organization-feed'],
    ]);
  });

  it('keeps one Settings row while the pages are unknown', () => {
    const groups = buildSettingsNavGroups(
      model(
        organization({
          settingsSubtabs: undefined,
          billingNeedsAttention: true,
        }),
      ),
    );
    const settings = groups[0]?.rows.at(-1);
    expect(settings?.key).toBe('organization-settings');
    expect(settings?.attention).toBe(true);
  });

  it('marks Billing for attention and names it for AI credits under free access', () => {
    const groups = buildSettingsNavGroups(
      model(organization({ billingNeedsAttention: true }), {
        ...ACCOUNT,
        freeAccess: true,
      }),
    );
    const billing = groups[0]?.rows.find(
      (row) => row.key === 'organization-settings-billing',
    );
    expect(billing?.attention).toBe(true);
    expect(billing?.label).toBe('AI Credits');
    expect(
      groups[0]?.rows.filter((row) => row.attention).map((row) => row.key),
    ).toEqual(['organization-settings-billing']);
  });

  it('greys out the lapsed pages and keeps Settings and Members live', () => {
    const groups = buildSettingsNavGroups(
      model(
        organization({
          disabledTabs: ['feed', 'statistics', 'digests', 'memory'],
        }),
      ),
    );
    const disabled = groups
      .flatMap((group) => group.rows)
      .filter((row) => row.disabled)
      .map((row) => row.key);
    expect(disabled).toEqual([
      'organization-memory',
      'organization-feed',
      'organization-statistics',
      'organization-digests',
    ]);
  });

  it('gives the Personal organization its activity rows only, unlabeled', () => {
    const groups = buildSettingsNavGroups(
      model(
        organization({
          isPersonal: true,
          visibleTabs: ['feed', 'statistics'],
          settingsSubtabs: [],
        }),
      ),
    );
    expect(groups.map((group) => [group.id, group.label])).toEqual([
      ['organization-activity', null],
    ]);
  });
});

describe('selectSettingsNavRow', () => {
  const groups = buildSettingsNavGroups(model(organization()));

  it.each([
    [`/organization/${ORG}/settings`, 'organization-settings-general'],
    [
      `/organization/${ORG}/settings?tab=policies`,
      'organization-settings-policies',
    ],
    [
      `/organization/${ORG}/billing/invoices/inv-1`,
      'organization-settings-billing',
    ],
    [`/organization/${ORG}/members/u-1`, 'organization-members'],
    [`/organization/${ORG}/feed/item-1`, 'organization-feed'],
    ['/organization/other/settings', null],
    ['/organization', null],
  ])('selects %s as %s', (pathname, key) => {
    expect(selectSettingsNavRow(groups, pathname, ORG)).toBe(key);
  });

  it('selects the first Settings page the viewer gets for a hidden one', () => {
    const memberGroups = buildSettingsNavGroups(
      model(organization({ settingsSubtabs: ['usage'] })),
    );
    expect(
      selectSettingsNavRow(memberGroups, `/organization/${ORG}/settings`, ORG),
    ).toBe('organization-settings-usage');
  });

  it('selects the single Settings row while the pages are unknown', () => {
    const unknown = buildSettingsNavGroups(
      model(organization({ settingsSubtabs: undefined })),
    );
    expect(
      selectSettingsNavRow(
        unknown,
        `/organization/${ORG}/settings?tab=usage`,
        ORG,
      ),
    ).toBe('organization-settings');
  });

  it('selects account rows by path', () => {
    const accountGroups = buildSettingsNavGroups(model(null));
    expect(
      selectSettingsNavRow(accountGroups, '/account/billing/invoices/x', null),
    ).toBe('account-billing');
    expect(settingsNavLogicalRowKey('/account/nope', null)).toBeNull();
  });
});
