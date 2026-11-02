import type {
  SettingsBootstrap,
  SettingsOrganizationBootstrap,
} from '@canopy/protocol/settings';
import { settingsNavModelFromBootstrap } from '../settings-nav-bootstrap';

const ORG = 'org-1';

function organization(
  overrides: Partial<SettingsOrganizationBootstrap> = {},
): SettingsOrganizationBootstrap {
  return {
    id: ORG,
    name: 'Acme',
    viewerRole: 'OWNER',
    isPersonal: false,
    visibleTabs: ['feed', 'members', 'settings'],
    disabledTabs: [],
    billingNeedsAttention: false,
    billingEnabled: true,
    memoryEnabled: false,
    digestsEnabled: false,
    projectsEnabled: false,
    canViewUsageStats: true,
    freeAccess: false,
    lapse: null,
    ...overrides,
  };
}

function bootstrap(org: SettingsOrganizationBootstrap): SettingsBootstrap {
  return {
    version: 1,
    viewer: { id: 'acct-1', email: 'viewer@example.test', name: 'Viewer' },
    account: {
      billingEnabled: true,
      digestsEnabled: false,
      integrationsEnabled: false,
      freeAccess: false,
    },
    organizations: [
      { id: ORG, name: 'Acme', role: 'OWNER', isPersonal: false },
    ],
    organization: org,
  };
}

const LAPSE = {
  trialEndedAt: '2026-06-01T00:00:00.000Z',
  lapseReason: 'trial_ended',
  requiredPlanName: 'Business',
};

function subtabs(org: SettingsOrganizationBootstrap): readonly string[] {
  return (
    settingsNavModelFromBootstrap(bootstrap(org), ORG).organization
      ?.settingsSubtabs ?? []
  );
}

describe('settingsNavModelFromBootstrap', () => {
  it('lists every Settings page for a healthy owner', () => {
    expect(subtabs(organization())).toEqual([
      'general',
      'policies',
      'integrations',
      'usage',
      'billing',
    ]);
  });

  it('keeps Integrations for a lapsed organization with GitHub connected, so it can be disconnected', () => {
    expect(
      subtabs(organization({ lapse: LAPSE, githubConnected: true })),
    ).toContain('integrations');
  });

  it('drops Integrations for a lapsed organization without a GitHub connection', () => {
    expect(
      subtabs(organization({ lapse: LAPSE, githubConnected: false })),
    ).not.toContain('integrations');
  });

  it('keeps Integrations for a lapsed organization when an older server does not say', () => {
    expect(subtabs(organization({ lapse: LAPSE }))).toContain('integrations');
  });
});
