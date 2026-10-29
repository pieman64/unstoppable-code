/** @jest-environment jsdom */
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import {
  openAccountOrganizationPage,
  openSettingsPathInApp,
  openSettingsPathOrWeb,
  openSettingsPathOrWebReported,
} from '../settings-destinations';

// The web fallbacks against the real availability check: hosted settings
// registered in a local window open in-app; a remote-control window, which
// has the bridge but cannot reach main's settings channels, opens the web.

const ORG = '44444444-4444-4444-8444-444444444444';
const MEMBERS_PATH = `/organization/${ORG}/members`;

let mockHostedSettingsClient: unknown = null;
jest.mock('@/client/hosted-settings-client-registry', () => ({
  registeredHostedSettingsClient: (): unknown => mockHostedSettingsClient,
}));

const mockOpenAuthenticatedCloudPage = jest.fn<void, [string]>();
const mockOpenAuthenticatedCloudPageReported = jest.fn<
  Promise<boolean>,
  [string]
>();
jest.mock('@/lib/openAuthenticatedCloudPage', () => ({
  openAuthenticatedCloudPage: (path: string): void =>
    mockOpenAuthenticatedCloudPage(path),
  openAuthenticatedCloudPageReported: (path: string): Promise<boolean> =>
    mockOpenAuthenticatedCloudPageReported(path),
}));

beforeEach(() => {
  mockHostedSettingsClient = {};
  mockOpenAuthenticatedCloudPage.mockReset();
  mockOpenAuthenticatedCloudPageReported.mockReset().mockResolvedValue(true);
  useFeatureFlagsStore.setState({ snapshot: getDefaultFeatureFlagSnapshot() });
  useRemoteControlStore.setState({ context: { mode: 'local' } });
});

afterEach(() => {
  mockHostedSettingsClient = null;
  useRemoteControlStore.setState({ context: { mode: 'local' } });
  useNavigationStore.getState().closeSettings();
});

function enterRemoteControlWindow(): void {
  useRemoteControlStore.setState({
    context: {
      mode: 'remote',
      deviceId: 'dev-b',
      name: 'Studio',
      platform: 'linux',
    },
  });
}

describe('settings destinations against real availability', () => {
  it('opens inside Settings in a local window with hosted settings registered', () => {
    expect(openSettingsPathOrWeb(MEMBERS_PATH)).toBe('settings');
    expect(useNavigationStore.getState().settingsHostedLocation?.route).toEqual(
      { scope: 'organization', organizationId: ORG, page: 'members' },
    );
    expect(mockOpenAuthenticatedCloudPage).not.toHaveBeenCalled();
  });

  it('opens every helper on the web in a remote-control window', async () => {
    enterRemoteControlWindow();
    expect(openSettingsPathOrWeb(MEMBERS_PATH)).toBe('web');
    expect(
      openAccountOrganizationPage({
        scope: 'organization',
        organizationId: ORG,
        page: 'members',
      }),
    ).toBe('web');
    await expect(openSettingsPathOrWebReported(MEMBERS_PATH)).resolves.toBe(
      'web',
    );
    expect(mockOpenAuthenticatedCloudPage).toHaveBeenCalledTimes(2);
    expect(mockOpenAuthenticatedCloudPage).toHaveBeenCalledWith(MEMBERS_PATH);
    expect(mockOpenAuthenticatedCloudPageReported).toHaveBeenCalledWith(
      MEMBERS_PATH,
    );
    expect(useNavigationStore.getState().settingsOpen).toBe(false);
  });

  it('opens the web without a registered hosted settings client', () => {
    mockHostedSettingsClient = null;
    expect(openSettingsPathOrWeb(MEMBERS_PATH)).toBe('web');
    expect(useNavigationStore.getState().settingsOpen).toBe(false);
  });
});

// The in-app half used for chat links (CAN-4692). Declining must not open the
// web: the caller keeps the link's ordinary routing instead.
describe('openSettingsPathInApp against real availability', () => {
  it('opens inside Settings in a local window with hosted settings registered', () => {
    expect(openSettingsPathInApp(`${MEMBERS_PATH}?q=ada#invite`)).toBe(true);
    expect(useNavigationStore.getState().settingsHostedLocation).toEqual(
      expect.objectContaining({
        route: { scope: 'organization', organizationId: ORG, page: 'members' },
        search: 'q=ada',
        hash: 'invite',
      }),
    );
    expect(mockOpenAuthenticatedCloudPage).not.toHaveBeenCalled();
  });

  it('declines in a remote-control window', () => {
    enterRemoteControlWindow();
    expect(openSettingsPathInApp(MEMBERS_PATH)).toBe(false);
    expect(useNavigationStore.getState().settingsOpen).toBe(false);
    expect(mockOpenAuthenticatedCloudPage).not.toHaveBeenCalled();
  });

  it('declines with the hosted settings flag off', () => {
    const snapshot = getDefaultFeatureFlagSnapshot();
    useFeatureFlagsStore.setState({
      snapshot: {
        ...snapshot,
        values: {
          ...snapshot.values,
          [CLIENT_FEATURE_FLAGS.canopyDesktopHostedSettings.key]: false,
        },
      },
    });
    expect(openSettingsPathInApp(MEMBERS_PATH)).toBe(false);
    expect(useNavigationStore.getState().settingsOpen).toBe(false);
    expect(mockOpenAuthenticatedCloudPage).not.toHaveBeenCalled();
  });

  it('declines without a registered hosted settings client', () => {
    mockHostedSettingsClient = null;
    expect(openSettingsPathInApp(MEMBERS_PATH)).toBe(false);
    expect(useNavigationStore.getState().settingsOpen).toBe(false);
  });

  // Openability does not read the cloud account: signed out, the link still
  // opens inside Settings and the hosted page shows its own sign-in state.
});
