/**
 * @jest-environment jsdom
 */
// CAN-3926: with free app access the Remote Control paywall never renders.
// The server grants `remote_control` (and mints `portal-v1`) for every
// signed-in account, reports no plan or trial, and keeps every org entitled,
// so a former trial user and a member of a once-lapsed org both get Enable.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCloudAccountPublicState,
  CanopyCloudEntitlementsState,
  CanopyPortalState,
} from '@canopy/desktop-shared/types';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { CanopyPortalModal } from '@/components/portal/CanopyPortalModal';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

const loadCanopyCloudAccount = jest.fn<
  Promise<CanopyCloudAccountPublicState>,
  []
>();
const loadCanopyCloudEntitlements = jest.fn<
  Promise<CanopyCloudEntitlementsState>,
  []
>();

Object.defineProperty(window, 'api', {
  configurable: true,
  value: {
    loadCanopyCloudAccount,
    loadCanopyCloudEntitlements,
    getCanopyCloudBaseUrl: jest.fn().mockResolvedValue(null),
    openAuthenticatedPortalPage: jest.fn().mockResolvedValue(true),
    browser: { openExternal: jest.fn().mockResolvedValue(undefined) },
    canopyPortal: {
      getState: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
      onStateChanged: (): (() => void) => () => undefined,
    },
  },
});

function signedInAccount(
  overrides: Partial<CanopyCloudAccountPublicState> = {},
): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    capabilities: [],
    storageAvailable: true,
    account: {
      id: 'acct-1',
      name: 'Alice',
      email: 'alice@example.com',
      role: 'DEVELOPER',
    },
    ...overrides,
  };
}

function guestAccount(): CanopyCloudAccountPublicState {
  return {
    ...signedInAccount(),
    authMode: 'guest',
    credentialSource: 'guest',
    account: {
      id: 'guest-1',
      name: 'Guest',
      email: 'guest+1@guest.canopy.invalid',
      role: 'DEVELOPER',
    },
  };
}

/** The org this account belongs to was reported lapsed under tier billing. */
const LAPSED_ORG = {
  organizationId: 'org-1',
  organizationName: 'Acme',
  teamsEntitled: false,
  trialEndedAt: '2026-09-01T00:00:00.000Z',
};

function entitlements(
  overrides: Partial<CanopyCloudEntitlementsState> = {},
): CanopyCloudEntitlementsState {
  return {
    resolved: true,
    canDisableSharing: false,
    canRemoteControl: false,
    source: 'none',
    plan: null,
    trial: null,
    billingManageableOrg: null,
    displayPlan: null,
    billingPresentation: null,
    ...overrides,
  };
}

/** What the server returns for any account while free access is on. */
const FREE_ACCESS_ENTITLEMENTS = entitlements({
  canDisableSharing: true,
  canRemoteControl: true,
  freeAccess: true,
});

function disabledPortal(): CanopyPortalState {
  return {
    status: 'disabled',
    connectionStatus: 'inactive',
    sessionId: null,
    pairingCode: null,
    pairingCodeExpiresAt: null,
    activatedAt: null,
    lastSeenAt: null,
    lastErrorAt: null,
    error: null,
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('CanopyPortalModal under free access', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    const snapshot = getDefaultFeatureFlagSnapshot();
    snapshot.values['canopy-billing-enabled'] = true;
    useFeatureFlagsStore.setState({ snapshot });
    useCanopyPortalStore.setState({ hydrated: true, state: disabledPortal() });
    useCloudConnectGateStore.setState({ pending: null });
    loadCanopyCloudAccount.mockReset();
    loadCanopyCloudEntitlements.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    container.remove();
  });

  async function renderModal(): Promise<void> {
    await act(async () => {
      root.render(
        <CanopyPortalModal
          onClose={() => undefined}
          onOpenAccountSettings={() => undefined}
          onRequestSignIn={() => undefined}
        />,
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });
  }

  function byTestId(id: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }

  it('shows the paywall to a free-plan account without free access', async () => {
    // Control for the cases below: the same account and lapsed org, but tier
    // billing, so the harness really can reach the paywall.
    loadCanopyCloudAccount.mockResolvedValue(
      signedInAccount({ orgBillingStates: [LAPSED_ORG] }),
    );
    loadCanopyCloudEntitlements.mockResolvedValue(
      entitlements({
        trial: { active: false, endsAt: '2026-09-01T00:00:00.000Z' },
      }),
    );
    await renderModal();

    expect(byTestId('canopy-portal-upgrade-cta')).not.toBeNull();
    expect(byTestId('canopy-portal-upgrade-cta-lapsed-copy')).not.toBeNull();
  });

  it('offers Enable to a former trial user whose account carries portal-v1', async () => {
    loadCanopyCloudAccount.mockResolvedValue(
      signedInAccount({ capabilities: ['portal-v1'] }),
    );
    loadCanopyCloudEntitlements.mockResolvedValue(FREE_ACCESS_ENTITLEMENTS);
    await renderModal();

    expect(byTestId('canopy-portal-disabled')).not.toBeNull();
    expect(byTestId('canopy-portal-upgrade-cta')).toBeNull();
    expect(document.body.textContent).not.toContain('paid plan');
    expect(document.body.textContent).not.toContain('Upgrade to unlock');
  });

  it('keeps the paywall closed even when a stale account lacks portal-v1 and names a lapsed org', async () => {
    loadCanopyCloudAccount.mockResolvedValue(
      signedInAccount({ orgBillingStates: [LAPSED_ORG] }),
    );
    loadCanopyCloudEntitlements.mockResolvedValue(FREE_ACCESS_ENTITLEMENTS);
    await renderModal();

    expect(byTestId('canopy-portal-disabled')).not.toBeNull();
    expect(byTestId('canopy-portal-upgrade-cta')).toBeNull();
    expect(byTestId('canopy-portal-upgrade-cta-lapsed-copy')).toBeNull();
    expect(document.body.textContent).not.toContain('Get ');
  });

  it('asks a guest to sign in rather than start a trial', async () => {
    loadCanopyCloudAccount.mockResolvedValue(guestAccount());
    loadCanopyCloudEntitlements.mockResolvedValue(FREE_ACCESS_ENTITLEMENTS);
    await renderModal();

    expect(byTestId('canopy-portal-guest-cta-button')?.textContent).toBe(
      'Sign in',
    );
    expect(byTestId('canopy-portal-guest-cta')?.textContent).not.toContain(
      'trial',
    );
  });

  it('keeps the trial label for a guest without free access', async () => {
    loadCanopyCloudAccount.mockResolvedValue(guestAccount());
    loadCanopyCloudEntitlements.mockResolvedValue(entitlements());
    await renderModal();

    expect(byTestId('canopy-portal-guest-cta-button')?.textContent).toBe(
      'Start free trial',
    );
  });
});
