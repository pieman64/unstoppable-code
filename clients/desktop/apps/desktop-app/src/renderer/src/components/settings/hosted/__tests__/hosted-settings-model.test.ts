import type {
  SettingsBootstrap,
  SettingsOrganizationBootstrap,
} from '@canopy/protocol/settings';
import { buildSettingsNavGroups } from '@canopy/ui-app/settings/navigation';
import { hostedSettingsLocation } from '../hosted-settings-location';
import {
  hostedSettingsNavFallback,
  hostedSettingsNavModel,
  hostedSettingsRedirect,
  parsePersistedSettingsNavModel,
  persistedSettingsNavModelFrom,
  selectHostedSettingsRow,
  SIGNED_OUT_SETTINGS_NAV_MODEL,
  type SettingsNavFlagSnapshot,
} from '../hosted-settings-model';

const OWNER_ORG = 'a0000000-0000-4000-8000-000000000002';
const OTHER_ORG = 'a0000000-0000-4000-8000-000000000003';
const STRANGER_ORG = 'a0000000-0000-4000-8000-000000000009';

function organizationBootstrap(
  overrides: Partial<SettingsOrganizationBootstrap> = {},
): SettingsOrganizationBootstrap {
  return {
    id: OWNER_ORG,
    name: 'Northwind Labs',
    viewerRole: 'OWNER',
    isPersonal: false,
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
    billingEnabled: true,
    memoryEnabled: true,
    digestsEnabled: true,
    projectsEnabled: true,
    canViewUsageStats: true,
    freeAccess: false,
    lapse: null,
    ...overrides,
  };
}

function bootstrap(
  organization: SettingsOrganizationBootstrap | null = null,
): SettingsBootstrap {
  return {
    version: 1,
    viewer: { id: 'viewer-1', email: 'viewer@example.test', name: 'Viewer' },
    account: {
      billingEnabled: true,
      digestsEnabled: true,
      integrationsEnabled: true,
      freeAccess: true,
    },
    organizations: [
      {
        id: OWNER_ORG,
        name: 'Northwind Labs',
        role: 'OWNER',
        isPersonal: false,
      },
      { id: OTHER_ORG, name: 'Fabrikam', role: 'MEMBER', isPersonal: false },
    ],
    organization,
  };
}

function groupIds(model: ReturnType<typeof hostedSettingsNavModel>): string[] {
  return buildSettingsNavGroups(model).map((group) => group.id);
}

describe('hostedSettingsNavModel', () => {
  it('shows the account rows before a bootstrap is known', () => {
    const model = hostedSettingsNavModel(null, OWNER_ORG);
    expect(model).toBe(SIGNED_OUT_SETTINGS_NAV_MODEL);
    expect(groupIds(model)).toEqual(['account']);
  });

  it('shows the organization scope only for the browsed organization', () => {
    const data = bootstrap(organizationBootstrap());
    expect(groupIds(hostedSettingsNavModel(data, OWNER_ORG))).toEqual([
      'organization',
      'organization-activity',
    ]);
    // Not browsing (account pages, the list, a fresh Settings open): the
    // account scope, even though the bootstrap was loaded for the
    // organization.
    expect(groupIds(hostedSettingsNavModel(data, null))).toEqual(['account']);
    expect(groupIds(hostedSettingsNavModel(data, OTHER_ORG))).toEqual([
      'account',
    ]);
  });

  it('carries the memberships, the viewer and the Settings pages for the scope picker', () => {
    const model = hostedSettingsNavModel(
      bootstrap(organizationBootstrap()),
      OWNER_ORG,
    );
    expect(model.organizations?.map((organization) => organization.id)).toEqual(
      [OWNER_ORG, OTHER_ORG],
    );
    expect(model.viewer?.email).toBe('viewer@example.test');
    expect(model.organization?.viewerRole).toBe('OWNER');
    // The bootstrap does not say whether GitHub is connected; a healthy
    // owner still gets Integrations.
    expect(model.organization?.settingsSubtabs).toEqual([
      'general',
      'policies',
      'integrations',
      'usage',
      'billing',
    ]);
  });

  it('always lists Integrations, which carries the device GitHub and Linear rows', () => {
    expect(hostedSettingsNavModel(null, null).account.integrationsEnabled).toBe(
      true,
    );
    const disabled = bootstrap();
    const data: SettingsBootstrap = {
      ...disabled,
      account: { ...disabled.account, integrationsEnabled: false },
    };
    const model = hostedSettingsNavModel(data, null);
    expect(model.account.integrationsEnabled).toBe(true);
    // The other account flags still come from the bootstrap.
    expect(model.account.billingEnabled).toBe(true);
    expect(model.account.freeAccess).toBe(true);
    expect(
      buildSettingsNavGroups(model)[0]?.rows.map((row) => row.key),
    ).toContain('account-integrations');
    expect(
      buildSettingsNavGroups(hostedSettingsNavModel(null, null))[0]?.rows.map(
        (row) => row.key,
      ),
    ).toContain('account-integrations');
  });

  it('names Billing "AI Credits" under free access without changing its key', () => {
    const groups = buildSettingsNavGroups(
      hostedSettingsNavModel(bootstrap(), null),
    );
    const billing = groups[0]?.rows.find(
      (row) => row.key === 'account-billing',
    );
    expect(billing?.label).toBe('AI Credits');
  });
});

describe('selectHostedSettingsRow', () => {
  const groups = buildSettingsNavGroups(
    hostedSettingsNavModel(bootstrap(organizationBootstrap()), OWNER_ORG),
  );

  it('selects one row for a route, including detail routes', () => {
    const accountGroups = buildSettingsNavGroups(
      hostedSettingsNavModel(bootstrap(), null),
    );
    expect(
      selectHostedSettingsRow(
        accountGroups,
        { scope: 'account', page: 'billing', invoiceId: 'in_1' },
        null,
      ),
    ).toBe('account-billing');
    // Account rows are not on the rail while an organization is browsed.
    expect(
      selectHostedSettingsRow(
        groups,
        { scope: 'account', page: 'billing' },
        OWNER_ORG,
      ),
    ).toBeNull();
    // The list is reached from the scope picker, not a rail row.
    expect(
      selectHostedSettingsRow(groups, { scope: 'organizations' }, OWNER_ORG),
    ).toBeNull();
    expect(
      selectHostedSettingsRow(
        groups,
        {
          scope: 'organization',
          organizationId: OWNER_ORG,
          page: 'members',
          userId: 'user-1',
        },
        OWNER_ORG,
      ),
    ).toBe('organization-members');
    expect(
      selectHostedSettingsRow(
        groups,
        {
          scope: 'organization',
          organizationId: OWNER_ORG,
          page: 'settings',
          subtab: 'billing',
          invoiceId: 'in_2',
        },
        OWNER_ORG,
      ),
    ).toBe('organization-settings-billing');
  });

  it('selects nothing for a local destination or another organization', () => {
    expect(selectHostedSettingsRow(groups, null, OWNER_ORG)).toBeNull();
    expect(
      selectHostedSettingsRow(
        groups,
        {
          scope: 'organization',
          organizationId: OTHER_ORG,
          page: 'feed',
        },
        OWNER_ORG,
      ),
    ).toBeNull();
  });
});

describe('hostedSettingsRedirect', () => {
  it('leaves account pages and the Organizations list alone', () => {
    expect(
      hostedSettingsRedirect(
        hostedSettingsLocation({ scope: 'account', page: 'account' }),
        bootstrap(),
      ),
    ).toBeNull();
    expect(
      hostedSettingsRedirect(
        hostedSettingsLocation({ scope: 'organizations' }),
        bootstrap(),
      ),
    ).toBeNull();
  });

  it('sends an organization outside the membership to the list with the notice', () => {
    expect(
      hostedSettingsRedirect(
        hostedSettingsLocation({
          scope: 'organization',
          organizationId: STRANGER_ORG,
          page: 'feed',
        }),
        bootstrap(null),
      ),
    ).toEqual({
      route: { scope: 'organizations' },
      search: '',
      hash: '',
      notice: 'access-lost',
    });
  });

  it('opens the Personal organization, which the membership list leaves out', () => {
    const PERSONAL_ORG = 'a0000000-0000-4000-8000-000000000004';
    expect(
      hostedSettingsRedirect(
        hostedSettingsLocation({
          scope: 'organization',
          organizationId: PERSONAL_ORG,
          page: 'statistics',
        }),
        bootstrap(
          organizationBootstrap({
            id: PERSONAL_ORG,
            name: 'Personal',
            isPersonal: true,
          }),
        ),
      ),
    ).toBeNull();
  });

  it('still redirects a Personal bootstrap for another organization', () => {
    expect(
      hostedSettingsRedirect(
        hostedSettingsLocation({
          scope: 'organization',
          organizationId: STRANGER_ORG,
          page: 'feed',
        }),
        bootstrap(
          organizationBootstrap({
            id: 'a0000000-0000-4000-8000-000000000004',
            isPersonal: true,
          }),
        ),
      )?.notice,
    ).toBe('access-lost');
  });

  it('keeps a tab the destination offers', () => {
    expect(
      hostedSettingsRedirect(
        hostedSettingsLocation({
          scope: 'organization',
          organizationId: OWNER_ORG,
          page: 'statistics',
        }),
        bootstrap(organizationBootstrap()),
      ),
    ).toBeNull();
  });

  it('opens Feed when the destination hides the current tab', () => {
    const redirect = hostedSettingsRedirect(
      hostedSettingsLocation({
        scope: 'organization',
        organizationId: OTHER_ORG,
        page: 'statistics',
      }),
      bootstrap(
        organizationBootstrap({
          id: OTHER_ORG,
          viewerRole: 'MEMBER',
          visibleTabs: ['feed', 'digests', 'members', 'groups', 'projects'],
        }),
      ),
    );
    expect(redirect?.route).toEqual({
      scope: 'organization',
      organizationId: OTHER_ORG,
      page: 'feed',
    });
  });

  it('keeps a disabled (lapsed) tab: its page shows the lapsed state', () => {
    expect(
      hostedSettingsRedirect(
        hostedSettingsLocation({
          scope: 'organization',
          organizationId: OWNER_ORG,
          page: 'feed',
        }),
        bootstrap(
          organizationBootstrap({ disabledTabs: ['feed', 'statistics'] }),
        ),
      ),
    ).toBeNull();
  });
});

const FLAGS_OFF: SettingsNavFlagSnapshot = {
  billingEnabled: false,
  digestsEnabled: false,
  freeAccess: false,
};

function rowKeys(model: ReturnType<typeof hostedSettingsNavModel>): string[] {
  return buildSettingsNavGroups(model).flatMap((group) =>
    group.rows.map((row) => row.key),
  );
}

describe('persisted rail entry', () => {
  it('keeps booleans and tab ids only, and drops unknown tab ids', () => {
    const raw = JSON.stringify({
      accountId: 'viewer-1',
      account: {
        billingEnabled: true,
        digestsEnabled: true,
        freeAccess: false,
        email: 'viewer@example.test',
      },
      organizations: {
        [OWNER_ORG]: {
          visibleTabs: ['feed', 'retired-tab', 'members', 7],
          disabledTabs: ['members', 'unknown'],
          billingNeedsAttention: true,
          name: 'Northwind Labs',
        },
        [OTHER_ORG]: { visibleTabs: 'feed' },
      },
    });
    expect(parsePersistedSettingsNavModel(raw, 'viewer-1')).toEqual({
      accountId: 'viewer-1',
      account: {
        billingEnabled: true,
        digestsEnabled: true,
        freeAccess: false,
      },
      organizations: {
        [OWNER_ORG]: {
          visibleTabs: ['feed', 'members'],
          disabledTabs: ['members'],
          billingNeedsAttention: true,
        },
      },
    });
  });

  it('ignores unparseable, malformed and other-account entries', () => {
    const valid = {
      accountId: 'viewer-1',
      account: { billingEnabled: true, digestsEnabled: true, freeAccess: true },
      organizations: {},
    };
    expect(parsePersistedSettingsNavModel(null, 'viewer-1')).toBeNull();
    expect(parsePersistedSettingsNavModel('{not json', 'viewer-1')).toBeNull();
    expect(parsePersistedSettingsNavModel('[]', 'viewer-1')).toBeNull();
    expect(
      parsePersistedSettingsNavModel(
        JSON.stringify({ ...valid, account: { billingEnabled: 'yes' } }),
        'viewer-1',
      ),
    ).toBeNull();
    expect(
      parsePersistedSettingsNavModel(JSON.stringify(valid), 'viewer-2'),
    ).toBeNull();
    expect(
      parsePersistedSettingsNavModel(JSON.stringify(valid), 'viewer-1'),
    ).toEqual(valid);
  });

  it('records the arriving bootstrap and drops organizations it no longer lists', () => {
    const previous = parsePersistedSettingsNavModel(
      JSON.stringify({
        accountId: 'viewer-1',
        account: {
          billingEnabled: false,
          digestsEnabled: false,
          freeAccess: false,
        },
        organizations: {
          [OTHER_ORG]: {
            visibleTabs: ['feed'],
            disabledTabs: [],
            billingNeedsAttention: false,
          },
          [STRANGER_ORG]: {
            visibleTabs: ['feed'],
            disabledTabs: [],
            billingNeedsAttention: false,
          },
        },
      }),
      'viewer-1',
    );
    const entry = persistedSettingsNavModelFrom(
      'viewer-1',
      bootstrap(
        organizationBootstrap({
          visibleTabs: ['feed', 'settings'],
          disabledTabs: ['feed'],
          billingNeedsAttention: true,
        }),
      ),
      previous,
    );
    expect(entry).toEqual({
      accountId: 'viewer-1',
      account: { billingEnabled: true, digestsEnabled: true, freeAccess: true },
      organizations: {
        [OTHER_ORG]: {
          visibleTabs: ['feed'],
          disabledTabs: [],
          billingNeedsAttention: false,
        },
        [OWNER_ORG]: {
          visibleTabs: ['feed', 'settings'],
          disabledTabs: ['feed'],
          billingNeedsAttention: true,
          settingsSubtabs: [
            'general',
            'policies',
            'integrations',
            'usage',
            'billing',
          ],
        },
      },
    });
    // No names or other account data are written.
    expect(JSON.stringify(entry)).not.toContain('Northwind');
    expect(JSON.stringify(entry)).not.toContain('viewer@example.test');
  });
});

describe('hostedSettingsNavFallback', () => {
  const persisted = persistedSettingsNavModelFrom(
    'viewer-1',
    bootstrap(
      organizationBootstrap({ visibleTabs: ['feed', 'members', 'settings'] }),
    ),
    null,
  );

  it('draws the persisted rows before a bootstrap is known', () => {
    const fallback = hostedSettingsNavFallback({
      persisted,
      flags: FLAGS_OFF,
      browsedOrganizationId: null,
      organizationName: null,
    });
    const model = hostedSettingsNavModel(null, null, fallback);
    expect(model).toBe(fallback);
    // The persisted account flags win over the flag snapshot.
    expect(rowKeys(model)).toEqual(
      rowKeys(hostedSettingsNavModel(bootstrap(), null)),
    );
  });

  it('draws the flag snapshot when nothing is persisted', () => {
    const model = hostedSettingsNavModel(
      null,
      null,
      hostedSettingsNavFallback({
        persisted: null,
        flags: { billingEnabled: true, digestsEnabled: true, freeAccess: true },
        browsedOrganizationId: OWNER_ORG,
        organizationName: null,
      }),
    );
    expect(rowKeys(model)).toEqual(
      rowKeys(hostedSettingsNavModel(bootstrap(), null)),
    );
    expect(model.organization).toBeNull();
  });

  it('draws the browsed organization from the entry until its bootstrap lands', () => {
    const fallback = hostedSettingsNavFallback({
      persisted,
      flags: FLAGS_OFF,
      browsedOrganizationId: OWNER_ORG,
      organizationName: 'Northwind Labs',
    });
    // Only the account bootstrap is known: the group comes from the entry.
    const early = hostedSettingsNavModel(bootstrap(), OWNER_ORG, fallback);
    expect(early.organization).toMatchObject({
      id: OWNER_ORG,
      name: 'Northwind Labs',
      visibleTabs: ['feed', 'members', 'settings'],
    });
    const ready = hostedSettingsNavModel(
      bootstrap(
        organizationBootstrap({ visibleTabs: ['feed', 'members', 'settings'] }),
      ),
      OWNER_ORG,
      fallback,
    );
    expect(rowKeys(early)).toEqual(rowKeys(ready));
  });

  it('keeps the group label line while the name is unknown', () => {
    const fallback = hostedSettingsNavFallback({
      persisted,
      flags: FLAGS_OFF,
      browsedOrganizationId: OWNER_ORG,
      organizationName: null,
    });
    expect(fallback.organization?.name).toBe('\u00a0');
  });

  it('never draws an organization the entry does not know', () => {
    const fallback = hostedSettingsNavFallback({
      persisted,
      flags: FLAGS_OFF,
      browsedOrganizationId: OTHER_ORG,
      organizationName: 'Fabrikam',
    });
    expect(fallback.organization).toBeNull();
    expect(
      hostedSettingsNavModel(bootstrap(), OTHER_ORG, fallback).organization,
    ).toBeNull();
  });
});
