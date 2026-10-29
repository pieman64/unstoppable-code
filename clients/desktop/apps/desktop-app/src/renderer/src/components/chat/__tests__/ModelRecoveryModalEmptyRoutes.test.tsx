/**
 * @jest-environment jsdom
 *
 * CAN-2349 — a HYDRATED registry that legitimately contains zero gateway
 * routes.
 *
 * Its own file because registry hydration is module state and Jest gives each
 * test file a fresh module registry. `ModelRecoveryModalRegistryReadiness.test.tsx`
 * needs the UNhydrated case (it never calls an init function); this file needs
 * the opposite, and the two cannot coexist in one module registry.
 *
 * The distinction under test is the one `hasGatewayModelRoutes()` cannot make:
 * it answers `false` both before the catalog loads AND for a loaded catalog
 * whose gateway routes were all filtered away by an org model policy. Keying
 * the routes-loading shell on the route count therefore waits forever in the
 * second case, for a route that can never arrive — so the user never reaches
 * the provider sign-in branch that would actually clear their gate.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ModelRecoveryModal } from '../ModelRecoveryModal';
import { invalidateSharedAiCreditsRead } from '@/lib/openBillingPage';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { initCodexModels } from '@canopy/desktop-shared/types';

jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: ({ onClose }: { onClose: () => void }): JSX.Element => (
    <button data-testid="auth-login-modal-stub" onClick={onClose}>
      Close provider sign-in
    </button>
  ),
}));

let root: Root | null = null;

const loadNativeAiCreditsAvailability = jest.fn();
const loadCanopyCloudAccount = jest.fn();
const getCodexAuthStatus = jest.fn();
const openAuthenticatedPortalPage = jest.fn();
const openExternal = jest.fn();

/** Credits ARE available on the account — the model just cannot use them. */
const covered = {
  personalEligible: true,
  orgSpendable: false,
  inOrg: false,
  orgCreditPoolCovered: false,
  inconclusive: false,
  pricingUrl: 'https://example.test/pricing',
};

function account(): unknown {
  return {
    hasApiKey: true,
    authMode: 'api_key',
    credentialSource: 'api_key',
    capabilities: [],
    account: {
      id: 'account-1',
      name: 'Real User',
      email: 'real@example.test',
      role: 'MEMBER',
    },
    organizations: [],
    teams: [],
    enforcedSettings: {},
    orgBillingStates: [],
    storageAvailable: true,
  };
}

beforeAll(() => {
  // HYDRATED, and deliberately route-free: one native-only entry, no `gateway`
  // block anywhere. This is what an org policy that blocks every
  // gateway-routable model leaves behind.
  initCodexModels([{ id: 'gpt-5.3-codex-spark', label: 'Codex Spark' }]);
});

beforeEach(() => {
  jest.clearAllMocks();
  invalidateSharedAiCreditsRead();
  openAuthenticatedPortalPage.mockResolvedValue(true);
  openExternal.mockResolvedValue(undefined);
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      loadNativeAiCreditsAvailability,
      loadCanopyCloudAccount,
      getCodexAuthStatus,
      openAuthenticatedPortalPage,
      browser: { openExternal },
    },
  });
  useCloudConnectGateStore.setState({ pending: null });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
});

it('reaches the native-only branch when the registry loaded with no routes', async () => {
  loadNativeAiCreditsAvailability.mockResolvedValue(covered);
  loadCanopyCloudAccount.mockResolvedValue(account());
  getCodexAuthStatus.mockResolvedValue({ authenticated: false });

  root = createRoot(document.body);
  await act(async () => {
    root?.render(
      createElement(ModelRecoveryModal, {
        pending: {
          model: 'gpt-5.3-codex-spark',
          recovery: { kind: 'needs-billing-source', provider: 'codex' },
        },
        onCommit: jest.fn(),
        onCancel: jest.fn(),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  // NOT parked on the loading shell: no further route can ever arrive, so
  // waiting would strand the user permanently.
  expect(
    document.querySelector('[data-testid="model-recovery-checking-routes"]'),
  ).toBeNull();
  // The honest branch: credits cannot route this model, so sign in instead.
  expect(
    document.querySelector('[data-testid="model-recovery-native-only"]'),
  ).not.toBeNull();
  expect(
    document.querySelector('[data-testid="model-recovery-sign-in"]'),
  ).not.toBeNull();
  // And never a purchase — buying credits cannot help a native-only model.
  expect(
    document.querySelector('[data-testid="model-recovery-purchase"]'),
  ).toBeNull();
});
