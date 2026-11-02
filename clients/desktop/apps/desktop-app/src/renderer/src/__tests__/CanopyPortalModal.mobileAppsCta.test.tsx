/**
 * @jest-environment jsdom
 *
 * Who sees the Remote Control modal's mobile install CTA.
 *
 * The modal's guest state already carries a create-account CTA, and the store
 * badges under it were a second, competing call to action for an account that
 * cannot pair a phone until it signs up. So the badges now require a signed-in
 * non-guest account, and the mobile app is named in the modal subtitle instead
 * — every visitor still learns the phone app exists, without a guest being
 * handed two CTAs at once.
 *
 * `@/lib/brand` is mocked to declare store listings: the default `canopy` brand
 * declares none, so without it every assertion here would pass vacuously.
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
import { makeTestPreferences } from '@/test-utils/preferences';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

jest.mock('@/lib/brand', () => ({
  brandText: { appName: 'Canopy' },
  getBrandMobileApps: (): {
    appStoreUrl: string;
    playStoreUrl: string;
  } => ({
    appStoreUrl: 'https://apps.apple.com/app/id1',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=x',
  }),
}));

jest.mock('@/hooks/useSubscriptionStatus', () => ({
  useSubscriptionStatus: (): {
    visible: boolean;
    status: null;
    openBillingPage: () => void;
    openUpgradePage: () => void;
    guestCtaVisible: boolean;
    startFreeTrial: () => void;
  } => ({
    visible: false,
    status: null,
    openBillingPage: (): void => undefined,
    openUpgradePage: (): void => undefined,
    guestCtaVisible: true,
    startFreeTrial: (): void => undefined,
  }),
}));

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => undefined,
}));

const MOBILE_CTA = '[data-testid="remote-control-mobile-apps-cta"]';

function baseAccount(
  overrides: Partial<CanopyCloudAccountPublicState> = {},
): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: 'api_key',
    credentialSource: 'manual',
    capabilities: [],
    storageAvailable: true,
    account: {
      id: 'user-1',
      name: 'Dev',
      email: 'dev@example.com',
      role: 'DEVELOPER',
    },
    ...overrides,
  };
}

function guestAccount(): CanopyCloudAccountPublicState {
  return baseAccount({
    authMode: 'guest',
    credentialSource: 'guest',
    account: {
      id: 'guest-1',
      name: 'Guest',
      email: 'guest+abc@guest.canopy.invalid',
      role: 'DEVELOPER',
    },
  });
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

function installApi(account: CanopyCloudAccountPublicState | null): void {
  const api: Partial<CanopyApi> = {
    loadCanopyCloudAccount: () =>
      Promise.resolve(
        account ??
          baseAccount({
            hasApiKey: false,
            authMode: null,
            credentialSource: null,
            account: undefined,
          }),
      ),
    getCanopyCloudBaseUrl: () => Promise.resolve(null),
    loadPreferences: () => Promise.resolve(makeTestPreferences()),
    loadCanopyCloudMobileActivation: () =>
      Promise.resolve({ hasMobileActivation: false, resolved: true }),
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
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
  });
}

async function renderModal(
  account: CanopyCloudAccountPublicState | null,
): Promise<{
  query: (selector: string) => Element | null;
  text: () => string;
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
    text: (): string => document.body.textContent ?? '',
    cleanup: (): void => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('CanopyPortalModal — mobile install CTA audience', () => {
  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('hides the store badges for a guest, leaving the create-account CTA alone', async () => {
    const { query, cleanup } = await renderModal(guestAccount());
    try {
      expect(query('[data-testid="canopy-portal-guest-cta"]')).not.toBeNull();
      expect(query(MOBILE_CTA)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('hides the store badges when no cloud account is connected', async () => {
    const { query, cleanup } = await renderModal(null);
    try {
      expect(query('[data-testid="canopy-portal-no-account"]')).not.toBeNull();
      expect(query(MOBILE_CTA)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('shows the store badges for a signed-in, non-guest account', async () => {
    const { query, cleanup } = await renderModal(baseAccount());
    try {
      expect(query('[data-testid="canopy-portal-guest-cta"]')).toBeNull();
      expect(query(MOBILE_CTA)).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('names the mobile app in the subtitle even for a guest', async () => {
    const { text, cleanup } = await renderModal(guestAccount());
    try {
      expect(text()).toContain('mobile app');
    } finally {
      cleanup();
    }
  });
});
