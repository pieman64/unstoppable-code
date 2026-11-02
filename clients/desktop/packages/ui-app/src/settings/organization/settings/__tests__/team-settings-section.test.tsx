/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ComponentProps, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type { OrganizationSettingsSubtab } from '@canopy/protocol/settings';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import {
  createTestSettingsHost,
  TestSettingsHost,
} from '../../../__tests__/helpers/test-settings-host';
import {
  OrganizationSettingsSubtabSlotsProvider,
  type OrganizationSettingsSubtabSlots,
} from '../organization-settings-subtab-slots';

// The Billing page renders the billing area's section. Its own suites cover
// its contents; here it only has to mount on the right page and receive the
// free-access mode, so a stub records what it was handed.
const mockBillingProps = jest.fn();
jest.mock('../../../billing/team-billing-section', () => ({
  TeamBillingSection: (props: { freeAccess?: boolean }): JSX.Element => {
    mockBillingProps(props);
    return <section data-testid="team-billing-section" />;
  },
}));

const WEB_SUBTAB_SLOTS: OrganizationSettingsSubtabSlots = {
  // Web fills this with its External agents card; its own suite covers it.
  renderExternalAgentsPolicy: () => (
    <section data-testid="team-external-agents" />
  ),
};

/**
 * Every section loads its own config/pricing/entitlement on mount. Keep those
 * requests pending so the sections render their initial state without async
 * churn — this suite is about which sections mount, not their contents.
 */
const PENDING_CLIENT: AccountOrganizationSettingsClient = {
  read: () => new Promise<never>(() => {}),
  write: () => new Promise<never>(() => {}),
  subscribe: () => () => {},
};

import { TeamSettingsSection } from '../team-settings-section';

type LapsedInfo = ComponentProps<typeof TeamSettingsSection>['lapsed'];

const LAPSED: NonNullable<LapsedInfo> = {
  trialEndedAt: '2026-05-01T00:00:00.000Z',
  lapseReason: 'trial_ended',
  requiredPlanName: 'Business',
};

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

const ALL_SECTIONS = [
  'team-branding-settings-section',
  'team-danger-zone',
  'team-enforced-settings-section',
  'team-model-policy-section',
  'team-model-gateway-section',
  'team-memory-settings-section',
  'team-external-agents',
  'team-usage-settings-section',
  'team-subscription-pricing-section',
  'team-github-connection-section',
  'team-billing-section',
] as const;

describe('TeamSettingsSection', () => {
  let container: HTMLElement;
  let root: Root;
  const { host } = createTestSettingsHost({
    client: PENDING_CLIENT,
    pathname: '/organization/org-1/settings',
  });

  beforeEach(() => {
    mockBillingProps.mockClear();
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

  function render(
    subtab: OrganizationSettingsSubtab,
    overrides: {
      detail?: OrganizationDetail;
      freeAccess?: boolean;
      lapsed?: LapsedInfo;
      externalAgentsEnabled?: boolean;
      slots?: OrganizationSettingsSubtabSlots;
    } = {},
  ): void {
    act(() => {
      root.render(
        <TestSettingsHost host={host}>
          <OrganizationSettingsSubtabSlotsProvider
            slots={overrides.slots ?? WEB_SUBTAB_SLOTS}
          >
            <TeamSettingsSection
              subtab={subtab}
              detail={overrides.detail ?? buildDetail()}
              onDetailChange={() => {}}
              memoryEnabled
              freeAccess={overrides.freeAccess}
              lapsed={overrides.lapsed ?? null}
              onDeleted={() => {}}
              externalAgentsEnabled={overrides.externalAgentsEnabled}
            />
          </OrganizationSettingsSubtabSlotsProvider>
        </TestSettingsHost>,
      );
    });
  }

  function rendered(): string[] {
    return ALL_SECTIONS.filter(
      (testId) => container.querySelector(`[data-testid="${testId}"]`) !== null,
    );
  }

  it('draws no page switcher of its own: the settings rail lists the pages', () => {
    render('general');
    expect(
      container.querySelector('[data-testid="team-settings-tabs"]'),
    ).toBeNull();
  });

  it.each<[OrganizationSettingsSubtab, string[]]>([
    ['general', ['team-branding-settings-section', 'team-danger-zone']],
    [
      'policies',
      [
        'team-enforced-settings-section',
        'team-model-policy-section',
        'team-model-gateway-section',
        'team-memory-settings-section',
        'team-external-agents',
      ],
    ],
    [
      'usage',
      ['team-usage-settings-section', 'team-subscription-pricing-section'],
    ],
    ['integrations', ['team-github-connection-section']],
    ['billing', ['team-billing-section']],
  ])('shows an owner only the %s sections', (subtab, sections) => {
    render(subtab, { externalAgentsEnabled: true });
    expect(rendered()).toEqual(sections);
  });

  it('keeps only the outside-agents card on Policies for a lapsed owner', () => {
    render('policies', { lapsed: LAPSED, externalAgentsEnabled: true });
    expect(rendered()).toEqual(['team-external-agents']);
  });

  it('drops the statistics-visibility section from Usage while lapsed', () => {
    render('usage', { lapsed: LAPSED });
    expect(rendered()).toEqual(['team-subscription-pricing-section']);
  });

  it('shows a stats-viewing member only the pricing section on Usage', () => {
    render('usage', {
      detail: buildDetail({ viewerRole: 'MEMBER' }),
    });
    expect(rendered()).toEqual(['team-subscription-pricing-section']);
  });

  it('hands Billing the free-access mode', () => {
    render('billing', { freeAccess: true });
    expect(mockBillingProps).toHaveBeenCalledWith(
      expect.objectContaining({ freeAccess: true }),
    );
  });

  it('draws no outside-agents card without the host slot', () => {
    render('policies', { externalAgentsEnabled: true, slots: {} });
    expect(rendered()).not.toContain('team-external-agents');
  });
});
