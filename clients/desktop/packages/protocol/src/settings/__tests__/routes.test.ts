import {
  accountSettingsNavKeyForRoute,
  organizationSettingsNavTabForRoute,
  parseSettingsRoute,
  parseSettingsRoutePath,
  settingsRouteSchema,
  settingsRouteToPath,
  type SettingsRoute,
} from '../routes';

/**
 * Every existing web settings URL shape (one per page.tsx under
 * `apps/web/src/app/(protected)/{account,organization}` plus the Settings
 * subtab query) and the route it maps to.
 */
const URL_FIXTURE: ReadonlyArray<readonly [string, SettingsRoute]> = [
  ['/account', { scope: 'account', page: 'account' }],
  ['/account/profile', { scope: 'account', page: 'profile' }],
  ['/account/digests', { scope: 'account', page: 'digests' }],
  [
    '/account/digests/dg_1',
    { scope: 'account', page: 'digests', digestId: 'dg_1' },
  ],
  ['/account/notifications', { scope: 'account', page: 'notifications' }],
  ['/account/integrations', { scope: 'account', page: 'integrations' }],
  ['/account/security', { scope: 'account', page: 'security' }],
  ['/account/labs', { scope: 'account', page: 'labs' }],
  ['/account/billing', { scope: 'account', page: 'billing' }],
  [
    '/account/billing/invoices/in_123',
    { scope: 'account', page: 'billing', invoiceId: 'in_123' },
  ],
  ['/organization', { scope: 'organizations' }],
  [
    '/organization/org_1',
    { scope: 'organization', organizationId: 'org_1', page: 'feed' },
  ],
  [
    '/organization/org_1/feed/item-9',
    {
      scope: 'organization',
      organizationId: 'org_1',
      page: 'feed',
      itemId: 'item-9',
    },
  ],
  [
    '/organization/org_1/statistics',
    { scope: 'organization', organizationId: 'org_1', page: 'statistics' },
  ],
  [
    '/organization/org_1/digests',
    { scope: 'organization', organizationId: 'org_1', page: 'digests' },
  ],
  [
    '/organization/org_1/digests/dg_2',
    {
      scope: 'organization',
      organizationId: 'org_1',
      page: 'digests',
      digestId: 'dg_2',
    },
  ],
  [
    '/organization/org_1/members',
    { scope: 'organization', organizationId: 'org_1', page: 'members' },
  ],
  [
    '/organization/org_1/members/user_7',
    {
      scope: 'organization',
      organizationId: 'org_1',
      page: 'members',
      userId: 'user_7',
    },
  ],
  [
    '/organization/org_1/members/user_7/digests/dg_3',
    {
      scope: 'organization',
      organizationId: 'org_1',
      page: 'members',
      userId: 'user_7',
      digestId: 'dg_3',
    },
  ],
  [
    '/organization/org_1/teams',
    { scope: 'organization', organizationId: 'org_1', page: 'groups' },
  ],
  [
    '/organization/org_1/projects',
    { scope: 'organization', organizationId: 'org_1', page: 'projects' },
  ],
  [
    '/organization/org_1/memory',
    { scope: 'organization', organizationId: 'org_1', page: 'memory' },
  ],
  [
    '/organization/org_1/memory/graph',
    {
      scope: 'organization',
      organizationId: 'org_1',
      page: 'memory',
      memoryView: 'graph',
    },
  ],
  [
    '/organization/org_1/memory/ops',
    {
      scope: 'organization',
      organizationId: 'org_1',
      page: 'memory',
      memoryView: 'ops',
    },
  ],
  [
    '/organization/org_1/memory/fact/fact_4',
    {
      scope: 'organization',
      organizationId: 'org_1',
      page: 'memory',
      factId: 'fact_4',
    },
  ],
  [
    '/organization/org_1/settings',
    { scope: 'organization', organizationId: 'org_1', page: 'settings' },
  ],
  ...(['general', 'policies', 'integrations', 'usage', 'billing'] as const).map(
    (subtab): readonly [string, SettingsRoute] => [
      `/organization/org_1/settings?tab=${subtab}`,
      {
        scope: 'organization',
        organizationId: 'org_1',
        page: 'settings',
        subtab,
      },
    ],
  ),
  [
    '/organization/org_1/billing/invoices/in_5',
    {
      scope: 'organization',
      organizationId: 'org_1',
      page: 'settings',
      subtab: 'billing',
      invoiceId: 'in_5',
    },
  ],
];

function split(url: string): [string, string] {
  const [pathname = '', search = ''] = url.split('?');
  return [pathname, search];
}

describe('settings routes', () => {
  it.each(URL_FIXTURE)('round-trips %s', (url, route) => {
    const [pathname, search] = split(url);
    expect(parseSettingsRoutePath(pathname, search)).toEqual(route);
    expect(settingsRouteToPath(route)).toBe(url);
  });

  it('matches organizationBillingPath for the billing subtab', () => {
    expect(
      parseSettingsRoutePath('/organization/org_1/settings', 'tab=billing'),
    ).toEqual({
      scope: 'organization',
      organizationId: 'org_1',
      page: 'settings',
      subtab: 'billing',
    });
  });

  it('falls back to the default subtab for an unknown tab', () => {
    expect(
      parseSettingsRoutePath('/organization/org_1/settings', 'tab=nope'),
    ).toEqual({
      scope: 'organization',
      organizationId: 'org_1',
      page: 'settings',
    });
  });

  it.each([
    '/',
    '/accounting',
    '/account/unknown',
    '/account/profile/extra',
    '/account/billing/invoices',
    '/organization/org_1/unknown',
    '/organization/org_1/members/u/other/d',
    '/organization/org_1/memory/fact',
    '/organization/org_1/billing',
    '/organization/..',
    '/organization/%E0%A4%A',
    '/admin',
  ])('rejects %s', (pathname) => {
    expect(parseSettingsRoutePath(pathname)).toBeNull();
  });

  it('rejects detail fields on the wrong page', () => {
    expect(
      parseSettingsRoute({ scope: 'account', page: 'account', digestId: 'd' }),
    ).toBeNull();
    expect(
      parseSettingsRoute({ scope: 'account', page: 'digests', invoiceId: 'i' }),
    ).toBeNull();
    expect(
      parseSettingsRoute({
        scope: 'organization',
        organizationId: 'o',
        page: 'feed',
        subtab: 'billing',
      }),
    ).toBeNull();
    expect(
      parseSettingsRoute({
        scope: 'organization',
        organizationId: 'o',
        page: 'statistics',
        userId: 'u',
      }),
    ).toBeNull();
    expect(
      parseSettingsRoute({
        scope: 'organization',
        organizationId: 'o',
        page: 'members',
        digestId: 'd',
      }),
    ).toBeNull();
    expect(
      parseSettingsRoute({
        scope: 'organization',
        organizationId: 'o',
        page: 'settings',
        subtab: 'general',
        invoiceId: 'i',
      }),
    ).toBeNull();
    expect(
      parseSettingsRoute({
        scope: 'organization',
        organizationId: 'o',
        page: 'memory',
        memoryView: 'graph',
        factId: 'f',
      }),
    ).toBeNull();
  });

  it('names the Timeline page when itemId is on the wrong page', () => {
    const result = settingsRouteSchema.safeParse({
      scope: 'organization',
      organizationId: 'o',
      page: 'statistics',
      itemId: 'item-9',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['itemId'],
        message: 'itemId is only valid on Timeline',
      }),
    ]);
  });

  it('rejects unknown fields and arbitrary destinations', () => {
    expect(
      parseSettingsRoute({ scope: 'account', page: 'account', url: '/x' }),
    ).toBeNull();
    expect(
      parseSettingsRoute({
        scope: 'organization',
        organizationId: 'https://evil.example',
        page: 'feed',
      }),
    ).toBeNull();
    expect(parseSettingsRoute({ scope: 'organizations', id: 'x' })).toBeNull();
  });

  it('derives rail keys from routes', () => {
    const invoice = parseSettingsRoutePath(
      '/organization/org_1/billing/invoices/in_5',
    );
    expect(organizationSettingsNavTabForRoute(invoice, 'org_1')).toBe(
      'settings',
    );
    expect(organizationSettingsNavTabForRoute(invoice, 'org_2')).toBeNull();
    expect(
      accountSettingsNavKeyForRoute(
        parseSettingsRoutePath('/account/digests/dg_1'),
      ),
    ).toBe('digests');
    expect(accountSettingsNavKeyForRoute(invoice)).toBeNull();
  });
});
