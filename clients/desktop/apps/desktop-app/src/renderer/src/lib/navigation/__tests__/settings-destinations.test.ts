/** @jest-environment jsdom */
import type * as HostedSettingsAvailabilityModule from '@/components/settings/hosted/hosted-settings-availability';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { settingsRouteToPath } from '@canopy/protocol/settings';
import type { SettingsRoute } from '@canopy/protocol/settings';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  SETTINGS_DEEP_LINK_FLAG_WAIT_MS,
  cancelPendingSettingsDeepLink,
  openAccountOrganizationPage,
  openCloudAccountSettings,
  openIntegrationSettings,
  openNotificationSettings,
  openPersonalCatalogSettings,
  openSettingsDeepLink,
  openSettingsPathInApp,
  openSettingsPathOrWeb,
  openSettingsPathOrWebReported,
  settingsPathOpensInApp,
  useSettingsLocationLabel,
} from '../settings-destinations';

const mockHostedSettingsOpenable = jest.fn<boolean, []>();
const mockOpenAuthenticatedCloudPage = jest.fn<void, [string]>();
const mockOpenAuthenticatedCloudPageReported = jest.fn<
  Promise<boolean>,
  [string]
>();

jest.mock('@/components/settings/hosted/hosted-settings-availability', () => ({
  ...jest.requireActual<typeof HostedSettingsAvailabilityModule>(
    '@/components/settings/hosted/hosted-settings-availability',
  ),
  hostedSettingsOpenable: (): boolean => mockHostedSettingsOpenable(),
  useHostedSettingsAvailable: (): boolean => mockHostedSettingsOpenable(),
}));

jest.mock('@/lib/openAuthenticatedCloudPage', () => ({
  openAuthenticatedCloudPage: (path: string): void =>
    mockOpenAuthenticatedCloudPage(path),
  openAuthenticatedCloudPageReported: (path: string): Promise<boolean> =>
    mockOpenAuthenticatedCloudPageReported(path),
}));

const openSettings = jest.fn();
const openAccountOrganizationSettings = jest.fn<
  void,
  [SettingsRoute, unknown?]
>();

beforeEach(() => {
  mockHostedSettingsOpenable.mockReset();
  openSettings.mockReset();
  openAccountOrganizationSettings.mockReset();
  mockOpenAuthenticatedCloudPage.mockReset();
  mockOpenAuthenticatedCloudPageReported.mockReset();
  useNavigationStore.setState({
    openSettings,
    openAccountOrganizationSettings,
  });
});

const DESTINATIONS = [
  {
    name: 'openCloudAccountSettings',
    open: openCloudAccountSettings,
    page: 'account',
    section: 'account',
  },
  {
    name: 'openIntegrationSettings',
    open: openIntegrationSettings,
    page: 'integrations',
    section: 'account',
  },
  {
    name: 'openNotificationSettings',
    open: openNotificationSettings,
    page: 'notifications',
    section: 'notifications',
  },
  {
    name: 'openPersonalCatalogSettings',
    open: openPersonalCatalogSettings,
    page: 'profile',
    section: 'privacy',
  },
] as const;

describe.each(DESTINATIONS)('$name', ({ open, page, section }) => {
  it('opens the hosted account page when hosted settings are openable', () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    open();
    expect(openAccountOrganizationSettings).toHaveBeenCalledWith({
      scope: 'account',
      page,
    });
    expect(openSettings).not.toHaveBeenCalled();
  });

  it('passes scrollTo to the hosted page', () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    open({ scrollTo: 'target-id' });
    expect(openAccountOrganizationSettings).toHaveBeenCalledWith(
      { scope: 'account', page },
      { scrollTo: 'target-id' },
    );
  });

  it('falls back to the local section otherwise', () => {
    mockHostedSettingsOpenable.mockReturnValue(false);
    open();
    expect(openSettings).toHaveBeenCalledWith(section);
    expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
  });

  it('passes scrollTo to the local section', () => {
    mockHostedSettingsOpenable.mockReturnValue(false);
    open({ scrollTo: 'target-id' });
    expect(openSettings).toHaveBeenCalledWith(section, {
      scrollTo: 'target-id',
    });
  });

  it('reads availability at call time', () => {
    mockHostedSettingsOpenable.mockReturnValue(false);
    open();
    mockHostedSettingsOpenable.mockReturnValue(true);
    open();
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(openAccountOrganizationSettings).toHaveBeenCalledTimes(1);
  });
});

describe('useSettingsLocationLabel', () => {
  const label = (kind: 'account' | 'integrations'): string => {
    let value = '';
    function Probe(): null {
      value = useSettingsLocationLabel(kind);
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    return value;
  };

  it('names the hosted pages when hosted settings are available', () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    expect(label('account')).toBe('Settings → Account');
    expect(label('integrations')).toBe('Settings → Integrations');
  });

  it('names local Accounts for both kinds otherwise', () => {
    mockHostedSettingsOpenable.mockReturnValue(false);
    expect(label('account')).toBe('Settings → Accounts');
    expect(label('integrations')).toBe('Settings → Accounts');
  });
});

const ORG = 'org_ext_1';

describe('openSettingsPathInApp', () => {
  it('opens a settings path in-app, keeping query and fragment', () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    expect(
      openSettingsPathInApp(`/organization/${ORG}/settings?tab=usage#top`),
    ).toBe(true);
    expect(openAccountOrganizationSettings).toHaveBeenCalledWith(
      {
        scope: 'organization',
        organizationId: ORG,
        page: 'settings',
        subtab: 'usage',
      },
      { search: 'tab=usage', hash: 'top' },
    );
    expect(mockOpenAuthenticatedCloudPage).not.toHaveBeenCalled();
  });

  it('returns false without the web when hosted settings are not openable', () => {
    mockHostedSettingsOpenable.mockReturnValue(false);
    expect(openSettingsPathInApp('/account/billing')).toBe(false);
    expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
    expect(mockOpenAuthenticatedCloudPage).not.toHaveBeenCalled();
  });

  it.each(['/pricing', '/account/not-a-page'])(
    'returns false without the web for %s, which is not a settings page',
    (path) => {
      mockHostedSettingsOpenable.mockReturnValue(true);
      expect(openSettingsPathInApp(path)).toBe(false);
      expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
      expect(mockOpenAuthenticatedCloudPage).not.toHaveBeenCalled();
    },
  );

  it('returns false without the web when the in-app open throws', () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    openAccountOrganizationSettings.mockImplementation(() => {
      throw new Error('navigation unavailable');
    });
    expect(openSettingsPathInApp('/organization')).toBe(false);
    expect(mockOpenAuthenticatedCloudPage).not.toHaveBeenCalled();
  });
});

describe('settingsPathOpensInApp', () => {
  it('reports a settings path as openable without opening it', () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    expect(settingsPathOpensInApp('/account/billing?tab=x#y')).toBe(true);
    expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
    expect(mockOpenAuthenticatedCloudPage).not.toHaveBeenCalled();
  });

  it('returns false when hosted settings are not openable', () => {
    mockHostedSettingsOpenable.mockReturnValue(false);
    expect(settingsPathOpensInApp('/account/billing')).toBe(false);
  });

  it.each(['/pricing', '/account/not-a-page'])(
    'returns false for %s, which is not a settings page',
    (path) => {
      mockHostedSettingsOpenable.mockReturnValue(true);
      expect(settingsPathOpensInApp(path)).toBe(false);
    },
  );

  it('returns false when the availability check throws', () => {
    mockHostedSettingsOpenable.mockImplementation(() => {
      throw new Error('store unavailable');
    });
    expect(settingsPathOpensInApp('/account/billing')).toBe(false);
  });
});

describe('openSettingsPathOrWeb', () => {
  it('opens a settings path in-app, keeping query and fragment', () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    expect(openSettingsPathOrWeb('/account/billing?plan=pro#credits')).toBe(
      'settings',
    );
    expect(openAccountOrganizationSettings).toHaveBeenCalledWith(
      { scope: 'account', page: 'billing' },
      { search: 'plan=pro', hash: 'credits' },
    );
    expect(mockOpenAuthenticatedCloudPage).not.toHaveBeenCalled();
  });

  it('opens the web when hosted settings are not openable', () => {
    mockHostedSettingsOpenable.mockReturnValue(false);
    expect(openSettingsPathOrWeb(`/organization/${ORG}/members`)).toBe('web');
    expect(mockOpenAuthenticatedCloudPage).toHaveBeenCalledWith(
      `/organization/${ORG}/members`,
    );
    expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
  });

  it('opens a non-settings path on the web even when hosted is openable', () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    expect(openSettingsPathOrWeb('/pricing')).toBe('web');
    expect(mockOpenAuthenticatedCloudPage).toHaveBeenCalledTimes(1);
    expect(mockOpenAuthenticatedCloudPage).toHaveBeenCalledWith('/pricing');
    expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
  });

  it('opens a settings path the hosted parser rejects on the web once', () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    expect(openSettingsPathOrWeb('/account/not-a-page')).toBe('web');
    expect(mockOpenAuthenticatedCloudPage).toHaveBeenCalledTimes(1);
    expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
  });

  it('opens the web when the in-app open throws', () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    openAccountOrganizationSettings.mockImplementation(() => {
      throw new Error('navigation unavailable');
    });
    expect(openSettingsPathOrWeb('/organization')).toBe('web');
    expect(mockOpenAuthenticatedCloudPage).toHaveBeenCalledWith(
      '/organization',
    );
  });
});

describe('openAccountOrganizationPage', () => {
  it('opens the route in-app without re-parsing it', () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    const route: SettingsRoute = {
      scope: 'organization',
      organizationId: ORG,
      page: 'memory',
      factId: 'fact_1',
    };
    expect(openAccountOrganizationPage(route)).toBe('settings');
    expect(openAccountOrganizationSettings).toHaveBeenCalledWith(route);
    expect(mockOpenAuthenticatedCloudPage).not.toHaveBeenCalled();
  });

  it('opens the route path on the web otherwise', () => {
    mockHostedSettingsOpenable.mockReturnValue(false);
    expect(openAccountOrganizationPage({ scope: 'organizations' })).toBe('web');
    expect(mockOpenAuthenticatedCloudPage).toHaveBeenCalledWith(
      settingsRouteToPath({ scope: 'organizations' }),
    );
    expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
  });

  it('opens the route path on the web when the in-app open throws', () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    openAccountOrganizationSettings.mockImplementation(() => {
      throw new Error('navigation unavailable');
    });
    expect(openAccountOrganizationPage({ scope: 'organizations' })).toBe('web');
    expect(mockOpenAuthenticatedCloudPage).toHaveBeenCalledWith(
      settingsRouteToPath({ scope: 'organizations' }),
    );
  });
});

describe('openSettingsDeepLink', () => {
  it('opens the hosted Organizations list for the invite lander link (CAN-5111)', () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    openSettingsDeepLink('organizations');
    expect(openAccountOrganizationSettings).toHaveBeenCalledWith({
      scope: 'organizations',
    });
    expect(openSettings).not.toHaveBeenCalled();
    expect(mockOpenAuthenticatedCloudPage).not.toHaveBeenCalled();
  });

  it('opens the signed-in web Organizations list without hosted settings', () => {
    mockHostedSettingsOpenable.mockReturnValue(false);
    openSettingsDeepLink('organizations');
    expect(mockOpenAuthenticatedCloudPage).toHaveBeenCalledWith(
      settingsRouteToPath({ scope: 'organizations' }),
    );
    expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'keeps Privacy on the local section (hosted=%s)',
    (hosted) => {
      mockHostedSettingsOpenable.mockReturnValue(hosted);
      openSettingsDeepLink('privacy');
      expect(openSettings).toHaveBeenCalledWith('privacy');
      expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
      expect(mockOpenAuthenticatedCloudPage).not.toHaveBeenCalled();
    },
  );

  describe('while a configured LaunchDarkly has not answered yet', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      useFeatureFlagsStore.setState({
        snapshot: getDefaultFeatureFlagSnapshot('initializing'),
      });
    });

    afterEach(() => {
      cancelPendingSettingsDeepLink();
      useFeatureFlagsStore.setState({
        snapshot: getDefaultFeatureFlagSnapshot(),
      });
      jest.useRealTimers();
    });

    it('waits for the first answer instead of bouncing a cold-start link to the web', () => {
      mockHostedSettingsOpenable.mockReturnValue(false);
      openSettingsDeepLink('organizations');
      expect(mockOpenAuthenticatedCloudPage).not.toHaveBeenCalled();
      expect(openAccountOrganizationSettings).not.toHaveBeenCalled();

      mockHostedSettingsOpenable.mockReturnValue(true);
      useFeatureFlagsStore.setState({
        snapshot: getDefaultFeatureFlagSnapshot('ready'),
      });
      expect(openAccountOrganizationSettings).toHaveBeenCalledTimes(1);
      expect(openAccountOrganizationSettings).toHaveBeenCalledWith({
        scope: 'organizations',
      });
      jest.advanceTimersByTime(60_000);
      expect(openAccountOrganizationSettings).toHaveBeenCalledTimes(1);
      expect(mockOpenAuthenticatedCloudPage).not.toHaveBeenCalled();
    });

    it('opens the web once when the answer turns hosted settings off', () => {
      mockHostedSettingsOpenable.mockReturnValue(false);
      openSettingsDeepLink('organizations');
      useFeatureFlagsStore.setState({
        snapshot: getDefaultFeatureFlagSnapshot('error'),
      });
      jest.advanceTimersByTime(60_000);
      expect(mockOpenAuthenticatedCloudPage).toHaveBeenCalledTimes(1);
      expect(mockOpenAuthenticatedCloudPage).toHaveBeenCalledWith(
        settingsRouteToPath({ scope: 'organizations' }),
      );
      expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
    });

    it('stops waiting after the bound and opens wherever is available then', () => {
      mockHostedSettingsOpenable.mockReturnValue(false);
      openSettingsDeepLink('organizations');
      jest.advanceTimersByTime(SETTINGS_DEEP_LINK_FLAG_WAIT_MS - 1);
      expect(mockOpenAuthenticatedCloudPage).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(mockOpenAuthenticatedCloudPage).toHaveBeenCalledTimes(1);
    });

    it('lets a newer settings link replace a waiting one', () => {
      mockHostedSettingsOpenable.mockReturnValue(false);
      openSettingsDeepLink('organizations');
      openSettingsDeepLink('privacy');
      expect(openSettings).toHaveBeenCalledWith('privacy');
      useFeatureFlagsStore.setState({
        snapshot: getDefaultFeatureFlagSnapshot('ready'),
      });
      jest.advanceTimersByTime(60_000);
      expect(mockOpenAuthenticatedCloudPage).not.toHaveBeenCalled();
      expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
    });

    it('opens at once when hosted settings are already openable', () => {
      mockHostedSettingsOpenable.mockReturnValue(true);
      openSettingsDeepLink('organizations');
      expect(openAccountOrganizationSettings).toHaveBeenCalledTimes(1);
    });
  });
});

describe('openSettingsPathOrWebReported', () => {
  it('resolves settings without minting a web link', async () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    await expect(openSettingsPathOrWebReported('/organization')).resolves.toBe(
      'settings',
    );
    expect(mockOpenAuthenticatedCloudPageReported).not.toHaveBeenCalled();
  });

  it('resolves web when the signed-in hand-off opens', async () => {
    mockHostedSettingsOpenable.mockReturnValue(false);
    mockOpenAuthenticatedCloudPageReported.mockResolvedValue(true);
    await expect(openSettingsPathOrWebReported('/organization')).resolves.toBe(
      'web',
    );
    expect(mockOpenAuthenticatedCloudPageReported).toHaveBeenCalledWith(
      '/organization',
    );
  });

  it('resolves failed when the signed-in hand-off does not open', async () => {
    mockHostedSettingsOpenable.mockReturnValue(false);
    mockOpenAuthenticatedCloudPageReported.mockResolvedValue(false);
    await expect(openSettingsPathOrWebReported('/organization')).resolves.toBe(
      'failed',
    );
  });

  it('falls back to the web, never rejecting, when the in-app open throws', async () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    openAccountOrganizationSettings.mockImplementation(() => {
      throw new Error('navigation unavailable');
    });
    mockOpenAuthenticatedCloudPageReported.mockResolvedValue(true);
    await expect(openSettingsPathOrWebReported('/organization')).resolves.toBe(
      'web',
    );
    expect(mockOpenAuthenticatedCloudPageReported).toHaveBeenCalledWith(
      '/organization',
    );
  });

  it('falls to the web for a non-settings path with hosted openable', async () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    mockOpenAuthenticatedCloudPageReported.mockResolvedValue(true);
    await expect(openSettingsPathOrWebReported('/pricing')).resolves.toBe(
      'web',
    );
    expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
  });
});

describe('route and path forms land on the same route', () => {
  const ROUTES: readonly SettingsRoute[] = [
    { scope: 'organizations' },
    { scope: 'organization', organizationId: ORG, page: 'feed' },
    { scope: 'organization', organizationId: ORG, page: 'statistics' },
    { scope: 'organization', organizationId: ORG, page: 'members' },
    {
      scope: 'organization',
      organizationId: ORG,
      page: 'settings',
      subtab: 'policies',
    },
    {
      scope: 'organization',
      organizationId: ORG,
      page: 'memory',
      factId: 'fact_1',
    },
  ];

  it.each(ROUTES.map((route) => [settingsRouteToPath(route), route]))(
    '%s',
    (_path, route) => {
      mockHostedSettingsOpenable.mockReturnValue(true);
      openAccountOrganizationPage(route);
      openSettingsPathOrWeb(settingsRouteToPath(route));
      expect(openAccountOrganizationSettings).toHaveBeenCalledTimes(2);
      const [[direct], [parsed]] = openAccountOrganizationSettings.mock.calls;
      expect(parsed).toEqual(direct);
      expect(mockOpenAuthenticatedCloudPage).not.toHaveBeenCalled();
    },
  );
});
