/**
 * @jest-environment jsdom
 *
 * CAN-4445: the Remote Control paywall's lapsed-org button deep-links into the
 * organization's billing page. With hosted settings openable in this window it
 * lands on Settings → Billing in-app, keeping the `?plan=` intent; otherwise it
 * opens the web, signed in. `useSubscriptionStatus` is mocked with its billing
 * path wired to the real in-app-or-web helper, which is what the hook does
 * (see `useSubscriptionStatus.settingsLinks.test.tsx`).
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyApi,
  CanopyCloudAccountPublicState,
  CanopyPortalState,
} from '@canopy/desktop-shared/types';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { CanopyPortalModal } from '@/components/portal/CanopyPortalModal';
import { openSettingsPathOrWeb } from '@/lib/navigation/settings-destinations';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const LAPSED_ORG = '22222222-2222-4222-8222-222222222222';

let mockHostedSettingsClient: unknown = null;
jest.mock('@/client/hosted-settings-client-registry', () => ({
  registeredHostedSettingsClient: (): unknown => mockHostedSettingsClient,
}));

jest.mock('@/hooks/useSubscriptionStatus', () => ({
  useSubscriptionStatus: (): unknown => ({
    visible: true,
    status: {
      billingPresentation: {
        plan: { key: 'business', displayName: 'Business' },
        owner: { type: 'organization', id: LAPSED_ORG, name: 'Acme' },
        action: 'subscribe',
      },
    },
    openBillingPage: (): void => undefined,
    openUpgradePage: (): void => undefined,
    openBillingAction: (): void => undefined,
    billingManageableOrg: { id: LAPSED_ORG, name: 'Acme' },
    openBillingPath: (path: string): void => {
      openSettingsPathOrWeb(path);
    },
    guestCtaVisible: false,
    startFreeTrial: (): void => undefined,
  }),
}));

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => undefined,
}));

const openAuthenticatedPortalPage = jest.fn();

function account(): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    capabilities: [],
    storageAvailable: true,
    orgBillingStates: [
      {
        organizationId: LAPSED_ORG,
        organizationName: 'Acme',
        teamsEntitled: false,
      },
    ],
    account: {
      id: 'acct-1',
      name: 'Alice',
      email: 'alice@example.com',
      role: 'DEVELOPER',
    },
  };
}

function disabledPortal(): CanopyPortalState {
  return {
    status: 'disabled',
    connectionStatus: 'inactive',
    sessionId: null,
    pairingCode: null,
    pairingCodeExpiresAt: null,
    machineName: null,
    hostCode: null,
    activatedAt: null,
    lastSeenAt: null,
    lastErrorAt: null,
    error: null,
  };
}

describe('CanopyPortalModal lapsed-org billing (CAN-4445)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    openAuthenticatedPortalPage.mockReset().mockResolvedValue(true);
    const api: Partial<CanopyApi> = {
      loadCanopyCloudAccount: () => Promise.resolve(account()),
      getCanopyCloudBaseUrl: () => Promise.resolve(null),
      openAuthenticatedPortalPage,
      canopyPortal: {
        getState: () => Promise.resolve(disabledPortal()),
        start: () => Promise.resolve({ state: disabledPortal() }),
        stop: () => Promise.resolve({ state: disabledPortal() }),
        regeneratePairingCode: () =>
          Promise.resolve({ state: disabledPortal() }),
        cancelPairingCode: () => Promise.resolve({ state: disabledPortal() }),
        onStateChanged: (): (() => void) => () => undefined,
      },
    };
    Object.defineProperty(window, 'api', { configurable: true, value: api });
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
    useCanopyPortalStore.setState({ hydrated: true, state: disabledPortal() });
    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'personal' },
        revision: 1,
        organizations: [{ id: LAPSED_ORG, name: 'Acme', role: 'OWNER' }],
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    mockHostedSettingsClient = null;
    useNavigationStore.getState().closeSettings();
    Reflect.deleteProperty(window, 'api');
  });

  async function renderAndClickUpgrade(): Promise<void> {
    function Harness(): JSX.Element {
      return (
        <CanopyPortalModal
          onClose={() => undefined}
          onOpenAccountSettings={() => undefined}
          onRequestSignIn={() => undefined}
        />
      );
    }
    act(() => root.render(<Harness />));
    await act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    const button = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="canopy-portal-upgrade-cta-button"]',
    );
    expect(button?.textContent).toBe('Get Business');
    act(() => button?.click());
  }

  it('opens the organization billing inside Settings with the plan intent', async () => {
    mockHostedSettingsClient = {};
    await renderAndClickUpgrade();
    const navigation = useNavigationStore.getState();
    expect(navigation.settingsOpen).toBe(true);
    expect(navigation.settingsHostedLocation?.route).toEqual({
      scope: 'organization',
      organizationId: LAPSED_ORG,
      page: 'settings',
      subtab: 'billing',
    });
    expect(navigation.settingsHostedLocation?.search).toContain(
      'plan=business',
    );
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
  });

  it('opens the organization billing on the web without hosted settings', async () => {
    await renderAndClickUpgrade();
    expect(useNavigationStore.getState().settingsOpen).toBe(false);
    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
      `/organization/${LAPSED_ORG}/settings?tab=billing&plan=business`,
    );
  });
});
