/**
 * @jest-environment jsdom
 *
 * Frontend gate for the guest → Remote Control create-account flow: a
 * device-scoped guest resolves as a real cloud account (has an API key), so the
 * modal's `disabled` state would otherwise show a dead-end Enable button the
 * server rejects. When the credential is a guest, the modal must swap the Enable
 * button for a create-account CTA that routes through the shared free-trial gate
 * (`useSubscriptionStatus().startFreeTrial`). `useSubscriptionStatus` is mocked
 * so we control the handler directly.
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyApi,
  CanopyCloudAccountPublicState,
  CanopyPortalState,
} from '@canopy/desktop-shared/types';
import { CanopyPortalModal } from '@/components/portal/CanopyPortalModal';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import type { StartFreeTrialOptions } from '@/hooks/useSubscriptionStatus';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// Imported rather than hand-mirrored: a local copy cannot flag a change to the
// thing it copies, which is how this file's mock previously drifted to
// `() => void` and stopped catching the payload it was supposed to pin. The
// type-only import is erased at compile time, so it does not interact with the
// `jest.mock` factory below.
const startFreeTrial = jest.fn<void, [StartFreeTrialOptions?]>();

jest.mock('@/hooks/useSubscriptionStatus', () => ({
  useSubscriptionStatus: (): {
    visible: boolean;
    status: null;
    openBillingPage: () => void;
    openUpgradePage: () => void;
    guestCtaVisible: boolean;
    startFreeTrial: (options?: StartFreeTrialOptions) => void;
  } => ({
    // A guest is never a real signed-in user, so the billing pill is hidden.
    visible: false,
    status: null,
    openBillingPage: (): void => undefined,
    openUpgradePage: (): void => undefined,
    guestCtaVisible: true,
    startFreeTrial,
  }),
}));

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => undefined,
}));

function guestAccount(): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: 'guest',
    credentialSource: 'guest',
    capabilities: [],
    storageAvailable: true,
    account: {
      id: 'guest-1',
      name: 'Guest',
      email: 'guest+abc@guest.canopy.invalid',
      role: 'DEVELOPER',
    },
  };
}

function buildState(overrides: Partial<CanopyPortalState>): CanopyPortalState {
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
    ...overrides,
  };
}

function installApi(account: CanopyCloudAccountPublicState): void {
  const api: Partial<CanopyApi> = {
    loadCanopyCloudAccount: () => Promise.resolve(account),
    getCanopyCloudBaseUrl: () => Promise.resolve(null),
    canopyPortal: {
      getState: () => Promise.resolve(buildState({})),
      start: () => Promise.resolve({ state: buildState({}) }),
      stop: () => Promise.resolve({ state: buildState({}) }),
      regeneratePairingCode: () => Promise.resolve({ state: buildState({}) }),
      cancelPairingCode: () => Promise.resolve({ state: buildState({}) }),
      onStateChanged: (): (() => void) => () => undefined,
    },
  };
  Object.defineProperty(window, 'api', { configurable: true, value: api });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
  });
}

async function renderModal(account: CanopyCloudAccountPublicState): Promise<{
  query: (selector: string) => Element | null;
  cleanup: () => void;
}> {
  installApi(account);
  useCanopyPortalStore.setState({
    hydrated: true,
    state: buildState({ status: 'disabled' }),
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  function Harness(): JSX.Element {
    return (
      <CanopyPortalModal
        onClose={() => undefined}
        onOpenAccountSettings={() => undefined}
        onRequestSignIn={() => undefined}
      />
    );
  }
  act(() => {
    root.render(<Harness />);
  });
  await flush();
  return {
    query: (selector: string): Element | null =>
      document.body.querySelector(selector),
    cleanup: (): void => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('CanopyPortalModal — guest create-account CTA', () => {
  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    startFreeTrial.mockClear();
  });

  it('shows the guest CTA (not Enable) when the credential is a guest', async () => {
    const { query, cleanup } = await renderModal(guestAccount());
    try {
      expect(query('[data-testid="canopy-portal-guest-cta"]')).not.toBeNull();
      expect(query('[data-testid="canopy-portal-enable"]')).toBeNull();
      expect(query('[data-testid="canopy-portal-upgrade-cta"]')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('renders the CTA at primary weight, matching the modal Enable/Sign in buttons', async () => {
    // Sign-up is the whole point of this state, so the one action in it cannot
    // read as an aside. `ACCOUNT_BUTTON_PRIMARY` is only "primary" within the
    // account-settings tiles — a bordered `bg-secondary` fill, which next to the
    // modal's accent-filled buttons looks like a secondary control.
    const { query, cleanup } = await renderModal(guestAccount());
    try {
      const button = query('[data-testid="canopy-portal-guest-cta-button"]');
      expect(button?.className).toContain('bg-accent');
      expect(button?.className).toContain('fg-emphasis');
      expect(button?.className).not.toContain('bg-secondary');
    } finally {
      cleanup();
    }
  });

  it('clicking the CTA starts the free-trial sign-in flow', async () => {
    const { query, cleanup } = await renderModal(guestAccount());
    try {
      const button = query('[data-testid="canopy-portal-guest-cta-button"]');
      expect(button).not.toBeNull();
      act(() => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(startFreeTrial).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  // The shared handler's default title names a specific offer, so this CTA has
  // to override it. Without the override a guest who clicked to unlock pairing
  // gets a dialog headed by an unrelated product — the exact defect this
  // asserts against. Call count alone did not catch it: wiring the handler
  // straight through (`onCreateAccount={subscription.startFreeTrial}`)
  // reintroduces the bug and still calls it exactly once.
  //
  // Matched on the Remote Control label rather than the literals so the copy
  // stays editable in one place, while the subject the dialog opens on stays
  // pinned.
  it('opens the gate on Remote Control rather than the default offer', async () => {
    const { query, cleanup } = await renderModal(guestAccount());
    try {
      act(() => {
        query('[data-testid="canopy-portal-guest-cta-button"]')?.dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        );
      });
      const options = startFreeTrial.mock.calls[0]?.[0];
      expect(options?.title).toContain(REMOTE_CONTROL_LABEL);
      expect(options?.description).toContain(REMOTE_CONTROL_LABEL);
      // The confirmation is on the same principle as the dialog: dropping this
      // override restores a success toast about AI credits after a Remote
      // Control sign-in.
      expect(options?.toastMessage).toContain(REMOTE_CONTROL_LABEL);
    } finally {
      cleanup();
    }
  });
});
