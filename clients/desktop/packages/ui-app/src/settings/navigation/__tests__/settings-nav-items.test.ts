import { Lock, Shield } from '@canopy/ui-shared/icons/AppIcons';
import {
  ACCOUNT_NAV_ITEMS,
  accountNavItem,
  type AccountNavKey,
  matchAccountNavKey,
  visibleAccountNavItems,
} from '../account-nav-items';
import {
  LAPSED_LIVE_TABS,
  matchTeamNavTab,
  ORGANIZATION_SETTINGS_SUBTAB_ITEMS,
  organizationSettingsSubtabHref,
  organizationSettingsSubtabItem,
  resolveOrganizationSettingsSubtab,
  TEAM_NAV_ITEMS,
  teamNavItem,
  type TeamTab,
} from '../organization-nav-items';

const ORG = 'org-1';

describe('account nav items', () => {
  it('draws Security with the lock, not the shield Privacy keeps', () => {
    expect(accountNavItem('security').icon).toBe(Lock);
    expect(ACCOUNT_NAV_ITEMS.some((item) => item.icon === Shield)).toBe(false);
  });

  it('keeps the strip order, labels, and destinations', () => {
    expect(
      ACCOUNT_NAV_ITEMS.map((item) => [item.key, item.label, item.href]),
    ).toEqual([
      ['account', 'Account', '/account'],
      ['profile', 'Public profile', '/account/profile'],
      ['digests', 'Digests', '/account/digests'],
      ['notifications', 'Notifications', '/account/notifications'],
      ['integrations', 'Integrations', '/account/integrations'],
      ['externalAgents', 'External agents (MCP)', '/account/external-agents'],
      ['security', 'Security', '/account/security'],
      ['billing', 'Billing', '/account/billing'],
      ['appearance', 'Appearance', '/account/appearance'],
      ['labs', 'Labs', '/account/labs'],
    ]);
  });

  it('lists Labs only while web Labs lists an experiment', () => {
    const flags = {
      billingEnabled: false,
      digestsEnabled: false,
      integrationsEnabled: false,
    };
    expect(
      visibleAccountNavItems(flags).some((item) => item.key === 'labs'),
    ).toBe(false);
    expect(
      visibleAccountNavItems({ ...flags, labsEnabled: true }).at(-1)?.key,
    ).toBe('labs');
  });

  it('lists Appearance only where the host sets chat detail there (web)', () => {
    const flags = {
      billingEnabled: false,
      digestsEnabled: false,
      integrationsEnabled: false,
    };
    expect(
      visibleAccountNavItems(flags).some((item) => item.key === 'appearance'),
    ).toBe(false);
    expect(
      visibleAccountNavItems({ ...flags, appearanceEnabled: true }).at(-1)?.key,
    ).toBe('appearance');
  });

  it.each([
    [
      false,
      false,
      false,
      false,
      ['account', 'profile', 'notifications', 'security'],
    ],
    [
      true,
      true,
      true,
      true,
      [
        'account',
        'profile',
        'digests',
        'notifications',
        'integrations',
        'externalAgents',
        'security',
        'billing',
      ],
    ],
    [
      true,
      false,
      false,
      false,
      ['account', 'profile', 'notifications', 'security', 'billing'],
    ],
    [
      false,
      true,
      false,
      false,
      ['account', 'profile', 'digests', 'notifications', 'security'],
    ],
    [
      false,
      false,
      true,
      false,
      ['account', 'profile', 'notifications', 'integrations', 'security'],
    ],
    [
      false,
      false,
      false,
      true,
      ['account', 'profile', 'notifications', 'externalAgents', 'security'],
    ],
  ])(
    'gates billing=%s digests=%s integrations=%s external agents=%s',
    (
      billingEnabled,
      digestsEnabled,
      integrationsEnabled,
      externalAgentsEnabled,
      keys,
    ) => {
      expect(
        visibleAccountNavItems({
          billingEnabled,
          digestsEnabled,
          integrationsEnabled,
          externalAgentsEnabled,
        }).map((item) => item.key),
      ).toEqual(keys);
    },
  );

  it.each([
    ['/account', 'account'],
    ['/account/', 'account'],
    ['/account?tab=x', 'account'],
    ['/account/profile', 'profile'],
    ['/account/digests/d-1', 'digests'],
    ['/account/notifications', 'notifications'],
    ['/account/integrations', 'integrations'],
    ['/account/external-agents', 'externalAgents'],
    ['/account/external-agents/agent-1', 'externalAgents'],
    ['/account/external-agents/consent', 'externalAgents'],
    ['/account/security', 'security'],
    ['/account/labs', 'labs'],
    ['/account/appearance', 'appearance'],
    ['/account/billing/invoices/inv-1', 'billing'],
    ['/account/unknown', null],
    ['/accounting', null],
    ['/organization', null],
    [null, null],
  ])('matches %s to %s', (pathname, key) => {
    expect(matchAccountNavKey(pathname)).toBe(key);
  });
});

describe('team nav items', () => {
  it('keeps the rail order and labels', () => {
    expect(TEAM_NAV_ITEMS.map((item) => [item.key, item.label])).toEqual([
      ['feed', 'Timeline'],
      ['statistics', 'Statistics'],
      ['digests', 'Digests'],
      ['members', 'Members'],
      ['groups', 'Teams'],
      ['projects', 'Projects'],
      ['memory', 'Memory'],
      ['settings', 'Settings'],
    ]);
  });

  it('keeps members, teams, projects, and settings live while lapsed', () => {
    expect([...LAPSED_LIVE_TABS].sort()).toEqual([
      'groups',
      'members',
      'projects',
      'settings',
    ]);
    expect(
      TEAM_NAV_ITEMS.filter((item) => !LAPSED_LIVE_TABS.has(item.key)).map(
        (item) => item.key,
      ),
    ).toEqual(['feed', 'statistics', 'digests', 'memory']);
  });

  it('lists the Settings pages in rail order, each with its own link', () => {
    expect(
      ORGANIZATION_SETTINGS_SUBTAB_ITEMS.map((item) => [item.key, item.label]),
    ).toEqual([
      ['general', 'General'],
      ['policies', 'Policies'],
      ['integrations', 'Integrations'],
      ['usage', 'Usage'],
      ['billing', 'Billing'],
    ]);
    expect(organizationSettingsSubtabHref(ORG, 'general')).toBe(
      `/organization/${ORG}/settings`,
    );
    expect(organizationSettingsSubtabHref(ORG, 'billing')).toBe(
      `/organization/${ORG}/settings?tab=billing`,
    );
  });

  it('names Billing for AI credits under free access', () => {
    expect(organizationSettingsSubtabItem('billing').label).toBe('Billing');
    expect(organizationSettingsSubtabItem('billing', true).label).toBe(
      'AI Credits',
    );
    expect(organizationSettingsSubtabItem('usage', true).label).toBe('Usage');
  });

  it.each([
    ['policies', ['general', 'policies'], 'policies'],
    ['billing', ['general', 'usage'], 'general'],
    [null, ['usage'], 'usage'],
    [null, [], null],
  ] as const)(
    'resolves a request for %s among %j to %s',
    (requested, visible, expected) => {
      expect(resolveOrganizationSettingsSubtab(requested, visible)).toBe(
        expected,
      );
    },
  );

  it.each([
    [`/organization/${ORG}`, 'feed'],
    [`/organization/${ORG}/`, 'feed'],
    [`/organization/${ORG}/feed/item-1`, 'feed'],
    [`/organization/${ORG}/statistics`, 'statistics'],
    [`/organization/${ORG}/digests/d-1`, 'digests'],
    [`/organization/${ORG}/members/u-1/digests/d-1`, 'members'],
    [`/organization/${ORG}/teams`, 'groups'],
    [`/organization/${ORG}/projects`, 'projects'],
    [`/organization/${ORG}/memory/fact/f-1`, 'memory'],
    [`/organization/${ORG}/memory/graph`, 'memory'],
    [`/organization/${ORG}/settings?tab=billing`, 'settings'],
    [`/organization/${ORG}/billing/invoices/inv-1`, 'settings'],
    [`/organization/${ORG}/unknown`, null],
    ['/organization/other-org/members', null],
    ['/organization', null],
    ['/account', null],
  ])('matches %s to %s', (pathname, tab) => {
    expect(matchTeamNavTab(pathname, ORG)).toBe(tab);
  });
});

describe('settings page header copy', () => {
  const ACCOUNT_COPY: readonly (readonly [AccountNavKey, string, string])[] = [
    [
      'account',
      'Account',
      'Your name, photo and the email we use to reach you.',
    ],
    [
      'profile',
      'Public profile',
      'What visitors see when they open your profile.',
    ],
    ['digests', 'Digests', 'Summaries of the work you shipped.'],
    [
      'notifications',
      'Notifications',
      'Choose which emails and push alerts you get.',
    ],
    [
      'integrations',
      'Integrations',
      'Connect the accounts agents use to work for you, such as GitHub.',
    ],
    [
      'externalAgents',
      'External agents (MCP)',
      'Agents outside this app that you have allowed to act for you. Change what each one can do, pause it, or remove it.',
    ],
    [
      'security',
      'Security',
      'Manage how you sign in, two-factor authentication and API keys.',
    ],
    [
      'billing',
      'Billing',
      'Your plan, AI credits, payment method and past payments.',
    ],
    ['appearance', 'Appearance', 'How chats look while agents work.'],
    ['labs', 'Labs', 'Try features we are still working on.'],
  ];

  const TEAM_COPY: readonly (readonly [TeamTab, string, string])[] = [
    ['feed', 'Timeline', 'Recent work from everyone in this organization.'],
    [
      'statistics',
      'Statistics',
      'Usage, savings and impact across this organization.',
    ],
    ['digests', 'Digests', "Regular summaries of this organization's work."],
    ['members', 'Members', 'The people in this organization and their roles.'],
    ['groups', 'Teams', 'Groups of members inside this organization.'],
    [
      'projects',
      'Projects',
      'Projects in this organization and who can use them.',
    ],
    [
      'memory',
      'Memory',
      "Facts agents have learned from this organization's work.",
    ],
    [
      'settings',
      'Settings',
      'Control how this organization is set up, governed and billed.',
    ],
  ];

  it('covers every account and organization item', () => {
    expect(ACCOUNT_COPY.map(([key]) => key)).toEqual(
      ACCOUNT_NAV_ITEMS.map((item) => item.key),
    );
    expect(TEAM_COPY.map(([key]) => key)).toEqual(
      TEAM_NAV_ITEMS.map((item) => item.key),
    );
  });

  it.each(ACCOUNT_COPY)(
    'account %s is titled %s',
    (key, label, description) => {
      const item = accountNavItem(key);
      expect(item.key).toBe(key);
      expect(item.label).toBe(label);
      expect(item.description).toBe(description);
    },
  );

  it.each(TEAM_COPY)(
    'organization %s is titled %s',
    (key, label, description) => {
      const item = teamNavItem(key);
      expect(item.key).toBe(key);
      expect(item.label).toBe(label);
      expect(item.description).toBe(description);
    },
  );

  it('throws for an unknown key', () => {
    const unknownAccountKey: string = 'nope';
    const unknownTeamTab: string = 'nope';
    expect((): void => {
      Reflect.apply(accountNavItem, undefined, [unknownAccountKey]);
    }).toThrow('Unknown account nav item: nope');
    expect((): void => {
      Reflect.apply(teamNavItem, undefined, [unknownTeamTab]);
    }).toThrow('Unknown organization nav item: nope');
  });
});
