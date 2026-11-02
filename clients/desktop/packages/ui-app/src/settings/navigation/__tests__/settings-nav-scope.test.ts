import type { SettingsNavModel } from '@canopy/protocol/settings';
import {
  accountScopeHref,
  currentSettingsNavScope,
  organizationScopeHref,
  settingsNavScopeOrganizations,
} from '../settings-nav-scope';

const ACCOUNT: SettingsNavModel['account'] = {
  billingEnabled: true,
  digestsEnabled: false,
  integrationsEnabled: true,
};

const OWNER = { id: 'org-1', role: 'OWNER' } as const;
const MEMBER = { id: 'org-2', role: 'MEMBER' } as const;

describe('accountScopeHref', () => {
  it.each([
    ['/organization/org-1/settings?tab=billing', '/account/billing'],
    ['/organization/org-1/settings?tab=integrations', '/account/integrations'],
    ['/organization/org-1/settings?tab=policies', '/account'],
    ['/organization/org-1/members', '/account'],
    ['/organization', '/account'],
    ['', '/account'],
  ])('lands %s on %s', (currentPath, href) => {
    expect(accountScopeHref(currentPath, ACCOUNT)).toBe(href);
  });

  it('opens Account when the account does not show the page', () => {
    expect(
      accountScopeHref('/organization/org-1/settings?tab=billing', {
        ...ACCOUNT,
        billingEnabled: false,
      }),
    ).toBe('/account');
  });
});

describe('organizationScopeHref', () => {
  it.each([
    ['/account/billing', '/organization/org-1/settings?tab=billing'],
    ['/account/integrations', '/organization/org-1/settings?tab=integrations'],
    ['/account/security', '/organization/org-1/settings'],
    ['/organization/org-9/members', '/organization/org-1/members'],
    ['/organization/org-9/teams', '/organization/org-1/teams'],
    [
      '/organization/org-9/settings?tab=usage',
      '/organization/org-1/settings?tab=usage',
    ],
    ['/organization/org-9/statistics', '/organization/org-1/settings'],
  ])('lands an owner coming from %s on %s', (currentPath, href) => {
    expect(organizationScopeHref(currentPath, OWNER)).toBe(href);
  });

  it.each([
    ['/account/billing', '/organization/org-2/members'],
    ['/organization/org-9/settings?tab=billing', '/organization/org-2/members'],
    [
      '/organization/org-9/settings?tab=usage',
      '/organization/org-2/settings?tab=usage',
    ],
    ['/organization/org-9/teams', '/organization/org-2/teams'],
  ])('lands a member coming from %s on %s', (currentPath, href) => {
    expect(organizationScopeHref(currentPath, MEMBER)).toBe(href);
  });
});

describe('scope model', () => {
  const model: SettingsNavModel = {
    account: ACCOUNT,
    adminVisible: false,
    organization: null,
    organizations: [
      {
        id: 'org-1',
        name: 'Acme',
        logoUrl: null,
        role: 'OWNER',
        isPersonal: false,
      },
      {
        id: 'personal',
        name: 'Personal',
        logoUrl: null,
        role: 'OWNER',
        isPersonal: true,
      },
    ],
  };

  it('is the account outside an organization', () => {
    expect(currentSettingsNavScope(model)).toEqual({ kind: 'account' });
  });

  it('leaves the Personal organization out of the menu', () => {
    expect(
      settingsNavScopeOrganizations(model).map(
        (organization) => organization.id,
      ),
    ).toEqual(['org-1']);
  });

  it('names a browsed organization from its membership until the rail model has its role', () => {
    const browsing: SettingsNavModel = {
      ...model,
      organization: {
        id: 'org-1',
        name: 'Acme',
        visibleTabs: ['feed'],
        disabledTabs: [],
        billingNeedsAttention: false,
      },
    };
    expect(currentSettingsNavScope(browsing)).toEqual({
      kind: 'organization',
      organizationId: 'org-1',
      name: 'Acme',
      logoUrl: null,
      role: 'OWNER',
      isPersonal: false,
    });
  });

  it('lists the browsed organization before the memberships arrive', () => {
    const early: SettingsNavModel = {
      account: ACCOUNT,
      adminVisible: false,
      organization: {
        id: 'org-3',
        name: 'Globex',
        visibleTabs: ['feed'],
        disabledTabs: [],
        billingNeedsAttention: false,
        viewerRole: 'ADMIN',
      },
    };
    expect(settingsNavScopeOrganizations(early)).toEqual([
      {
        id: 'org-3',
        name: 'Globex',
        logoUrl: null,
        role: 'ADMIN',
        isPersonal: false,
      },
    ]);
  });
});
