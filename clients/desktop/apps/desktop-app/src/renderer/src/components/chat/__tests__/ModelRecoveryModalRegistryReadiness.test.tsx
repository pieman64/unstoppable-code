/**
 * @jest-environment jsdom
 *
 * CAN-2349 — the gateway registry is EMPTY here, on purpose.
 *
 * This file deliberately does NOT call `initClaudeModels`/`initCodexModels`.
 * The gateway registry is module state and Jest gives each test file its own
 * module registry, so leaving it unseeded reproduces the real initialization
 * window: the model-configuration broadcast has not arrived yet and every model
 * looks non-routable.
 *
 * That window is AMBIGUOUS — "not loaded yet" and "no routes exist" are
 * indistinguishable — so the modal's two consumers of "can credits run this
 * model?" fail in opposite directions, and only the commit path is asserted
 * here. `ModelRecoveryModal.test.tsx` covers the populated-registry behavior.
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
const getClaudeAuthStatus = jest.fn();
const getCodexAuthStatus = jest.fn();
const openAuthenticatedPortalPage = jest.fn();
const openExternal = jest.fn();

/** Credits are genuinely available on the ACCOUNT. */
const covered = {
  personalEligible: true,
  orgSpendable: false,
  inOrg: true,
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
      getClaudeAuthStatus,
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

it('does not auto-commit on credits while gateway routability is still unknown', async () => {
  // The failure this pins: with an empty registry every model looks
  // non-routable, and folding that into "credits can run it" let a
  // `needs-billing-source` model be committed the moment the account showed
  // coverage. Credits cannot route a model with no gateway route, and the
  // provider login is still missing, so the commit selects a model with no way
  // to run at all — silently, with the modal closing as if it had succeeded.
  //
  // The commit path therefore requires POSITIVE evidence of routability. The
  // purchase path keeps failing open (asserted in ModelRecoveryModal.test.tsx),
  // because offering a purchase that turns out to be unnecessary is recoverable
  // where a bad commit is not.
  const onCommit = jest.fn();
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
        onCommit,
        onCancel: jest.fn(),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(onCommit).not.toHaveBeenCalled();
});

it('shows the routes-loading shell instead of a branch whose button no-ops', async () => {
  // The visible consequence of the fail-open/fail-closed split above. With an
  // empty registry `creditsCanRunPendingModel` is true (fail OPEN, so the
  // purchase path survives), which used to render the self-serve branch for a
  // covered account — but `creditsProvenToRunPendingModel` is false (fail
  // CLOSED), so its button re-read instead of committing and repainted the
  // identical modal. A click that visibly does nothing is the dead end this
  // ticket exists to remove.
  //
  // The registry genuinely IS still loading, so the honest state is to say so
  // and let the real branch render once it arrives.
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
  });

  expect(
    document.querySelector('[data-testid="model-recovery-checking-routes"]'),
  ).not.toBeNull();
  // None of the branches that offer an action on unproven routability.
  expect(
    document.querySelector('[data-testid="model-recovery-purchase"]'),
  ).toBeNull();
  expect(
    document.querySelector('[data-testid="model-recovery-native-only"]'),
  ).toBeNull();
  expect(
    document.querySelector('[data-testid="model-recovery-try-again"]'),
  ).toBeNull();
  // Cancel stays reachable: a loading state must never trap the user.
  expect(
    document.querySelector('[data-testid="model-recovery-cancel"]'),
  ).not.toBeNull();
});
