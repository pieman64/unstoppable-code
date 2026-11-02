/**
 * @jest-environment jsdom
 *
 * CAN-2349 §3 — the modal's ACCOUNT-STATE branch selection.
 *
 * `ModelPicker.test.tsx` covers "a recoverable row opens the modal", but it
 * never stubs `window.api`, so every modal it renders lands on the inconclusive
 * branch. These tests exercise the settled branches directly, which is the only
 * way the contact-admin / lapsed split is observable at all.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement, StrictMode, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ModelRecoveryModal,
  type GuestFallbackOutcome,
} from '../ModelRecoveryModal';
import {
  CONTACT_ORG_ADMIN_COPY,
  CONTACT_ORG_ADMIN_LAPSED_COPY,
} from '@/lib/openBillingPage';
import {
  invalidateSharedAiCreditsRead,
  readSharedAiCreditsAvailability,
  resetSettingsCloseRereadForTests,
} from '@/lib/openBillingPage';
import {
  useCloudConnectGateStore,
  type CloudConnectGateContext,
} from '@/stores/cloudConnectGateStore';
import type {
  ChatModel,
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
// Namespace import so the hydration flag can be forced for the CAN-3026
// unhydrated-registry case; the modal calls it through this same binding.
import * as registryTypes from '@canopy/desktop-shared/types';
import {
  getModelDisplayName,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import { guestModelGateTitle, guestModelGateToast } from '@/lib/guest-cta-copy';
import { brandText } from '@/lib/brand';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  resolveModelRowGate,
  type ModelRecovery,
  type ModelRowGateInput,
} from '@/lib/modelPickerRowGate';
import type { UnlockModelsResult } from '@/lib/openBillingPage';
import { resetModelLibraryAccessForTests } from '@/lib/modelLibraryAccess';
import {
  beginModelUnlockIntent,
  clearModelUnlockIntent,
  resetModelUnlockIntentForTests,
  useModelUnlockIntentStore,
} from '@/lib/modelUnlockIntent';
import type * as HostedSettingsAvailabilityModule from '@/components/settings/hosted/hosted-settings-availability';
import type { SettingsRoute } from '@canopy/protocol/settings';
import { BILLING_TOP_UP_MIN_USD } from '@canopy/protocol/billing';
import { useNavigationStore } from '@/stores/navigationStore';

const mockHostedSettingsOpenable = jest.fn<boolean, []>();
jest.mock('@/components/settings/hosted/hosted-settings-availability', () => ({
  ...jest.requireActual<typeof HostedSettingsAvailabilityModule>(
    '@/components/settings/hosted/hosted-settings-availability',
  ),
  hostedSettingsOpenable: (): boolean => mockHostedSettingsOpenable(),
  useHostedSettingsAvailable: (): boolean => mockHostedSettingsOpenable(),
}));

jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: ({ onClose }: { onClose: () => void }): ReactElement => (
    <button data-testid="auth-login-modal-stub" onClick={onClose}>
      Close provider sign-in
    </button>
  ),
}));

const mockTrackCreditsRecoveryView = jest.fn();
const mockTrackCreditsRecoveryClick = jest.fn();
jest.mock('@/lib/creditsRecoveryTelemetry', () => ({
  trackCreditsRecoveryView: (...args: unknown[]): void => {
    mockTrackCreditsRecoveryView(...args);
  },
  trackCreditsRecoveryClick: (...args: unknown[]): void => {
    mockTrackCreditsRecoveryClick(...args);
  },
}));

let root: Root | null = null;

const loadNativeAiCreditsAvailability = jest.fn<
  Promise<NativeAiCreditsAvailability | null>,
  []
>();
const loadCanopyCloudAccount = jest.fn();
const getClaudeAuthStatus = jest.fn();
const getCodexAuthStatus = jest.fn();
/**
 * The two ways a billing page can actually reach the user's browser.
 *
 * Asserting on BOTH matters: `openBillingPage` falls back to the
 * unauthenticated `pricingUrl` via `browser.openExternal` when the
 * authenticated portal declines, so watching only one of them would let the
 * regression through by the other door.
 */
const openAuthenticatedPortalPage = jest.fn();
const saveCloudDailyCreditDrip = jest.fn();
const loadCloudDailyCreditDrip = jest.fn();
const openExternal = jest.fn();

const MODEL: ChatModel = 'sonnet';
/** No gateway route: AI Credits can never pay for it. */
const NATIVE_ONLY_MODEL = 'gpt-5.3-codex-spark';

const uncovered = {
  personalEligible: false,
  orgSpendable: false,
  inOrg: true,
  orgCreditPoolCovered: false,
  inconclusive: false,
  pricingUrl: 'https://example.test/pricing',
};

/** A real, signed-in (non-guest) account. */
function account(
  orgBillingStates: {
    organizationId: string;
    organizationName: string;
    teamsEntitled: boolean;
  }[],
): unknown {
  return {
    hasApiKey: true,
    account: { id: 'acct_1' },
    authMode: 'account',
    credentialSource: 'account',
    orgBillingStates,
  };
}

async function render(
  onCommit: () => void = jest.fn(),
  recovery: ModelRecovery = { kind: 'needs-credits' },
): Promise<void> {
  root = createRoot(document.body);
  await act(async () => {
    root?.render(
      createElement(ModelRecoveryModal, {
        pending: { model: MODEL, recovery },
        onCommit,
        onCancel: jest.fn(),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

function text(testId: string): string | null {
  return (
    document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null
  );
}

/** The dialog's own close (X) button, the only dismiss it offers. */
function closeButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    '[data-testid="model-recovery-modal"] button[aria-label="Close"]',
  );
}

/** The recovery dialog's visible heading. */
function heading(): string | null {
  return (
    document.querySelector('[data-testid="model-recovery-modal"] h2')
      ?.textContent ?? null
  );
}

/**
 * Seeds the POPULATED gateway route registry this file assumes.
 *
 * Extracted so a spec that deliberately empties the registry (the CAN-3026
 * cold-registry case) can put it back — `initAiGatewayModels` is the only
 * writer and atomically replaces MODULE state shared with every other spec
 * here, so leaving it empty would silently change later assertions.
 */
function restoreGatewayRoutes(): void {
  // Native registry init no longer feeds the gateway route table:
  // `initAiGatewayModels` is the only writer, and it atomically replaces both
  // the API-only rows and ALL routes.
  initAiGatewayModels(
    [],
    [
      {
        modelId: MODEL,
        gatewayId: 'anthropic/claude-sonnet',
        family: 'sonnet',
        recommendedHarness: 'claude',
        gatewayOnly: false,
        contextWindow: 1_000_000,
        supportsPromptCaching: true,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'standard',
      },
    ],
  );
}

beforeAll(() => {
  // A POPULATED gateway registry. The production guard deliberately fails open
  // on an EMPTY one (the model catalog simply has not loaded yet), so routes
  // must exist here or the native-only assertions below would prove nothing.
  // Seeded once for the file because the registry is module state.
  initClaudeModels([{ id: MODEL, label: 'Sonnet' }]);
  initCodexModels([
    // Native-only on purpose: no gateway ROUTE below, so AI Credits cannot
    // route it.
    { id: NATIVE_ONLY_MODEL, label: 'Codex Spark' },
  ]);
  restoreGatewayRoutes();
});

beforeEach(() => {
  jest.clearAllMocks();
  // The shared availability read retains its answer for the current episode,
  // so it must be reset between tests or one case's account state becomes the
  // next case's.
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
      saveCloudDailyCreditDrip,
      loadCloudDailyCreditDrip,
      browser: { openExternal },
    },
  });
  useCloudConnectGateStore.setState({ pending: null });
  // Web branch by default, so every pre-CAN-4691 case keeps its meaning.
  mockHostedSettingsOpenable.mockReset().mockReturnValue(false);
});

afterEach(() => {
  resetSettingsCloseRereadForTests();
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
});

describe('ModelRecoveryModal source harness copy', () => {
  it.each<{
    name: string;
    input: Partial<ModelRowGateInput>;
    source: string;
  }>([
    {
      name: 'legacy Ollama repaired onto Codex',
      input: { lockedProvider: 'ollama', lockedHarness: 'claude' },
      source: 'the Codex harness',
    },
    {
      name: 'modern Ollama captured on Codex',
      input: { lockedProvider: 'ollama', lockedHarness: 'codex' },
      source: 'the Codex harness',
    },
    {
      name: 'explicit harness differing from the model provider',
      input: {
        lockedProvider: 'claude',
        lockedHarness: 'opencode',
        executionHarnessExplicitlyChosen: true,
      },
      source: 'the OpenCode harness',
    },
    {
      name: 'Ollama without a captured harness',
      input: { lockedProvider: 'ollama', lockedHarness: undefined },
      source: 'Ollama',
    },
  ])('names the source accurately for $name', async ({ input, source }) => {
    const gate = resolveModelRowGate({
      model: MODEL,
      provider: 'claude',
      currentModel: undefined,
      gatingEnabled: true,
      availability: undefined,
      billingValue: undefined,
      lockedProvider: undefined,
      lockedHarness: undefined,
      lockedProviderBehavior: 'continue',
      lockedProviderReason: undefined,
      canStartNewChat: true,
      modelPolicy: new Set<string>(),
      staleAgent: false,
      ...input,
    });
    expect(gate.kind).toBe('recoverable');
    if (gate.kind !== 'recoverable') throw new Error('Expected recovery');
    expect(gate.recovery.kind).toBe('needs-new-chat');
    await render(jest.fn(), gate.recovery);
    expect(text('model-recovery-new-chat-body')).toBe(
      `This chat uses ${source} and can't switch to the Claude harness. Starting a new chat leaves this one unchanged.`,
    );
    expect(document.body.textContent).not.toContain('Ollama harness');
    expect(document.body.textContent).not.toContain('summary');
  });
});

describe('ModelRecoveryModal account branches', () => {
  it('does NOT auto-commit from an answer retained before it mounted', async () => {
    // Door 3 of the retention bounds. An earlier surface (a banner CTA's seed
    // read) concluded COVERED and the episode retained it. Credits were then
    // spent to zero somewhere that emitted no local event. Without the mount
    // read being `{ fresh: true }`, this modal opens on that retained answer
    // and immediately commits a model whose credits are gone.
    loadNativeAiCreditsAvailability.mockResolvedValueOnce({
      ...uncovered,
      personalEligible: true,
      inOrg: false,
    });
    await readSharedAiCreditsAvailability();

    loadNativeAiCreditsAvailability.mockResolvedValue(uncovered);
    loadCanopyCloudAccount.mockResolvedValue(account([]));

    const onCommit = jest.fn();
    await render(onCommit);

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits immediately when the initial account read finds coverage', async () => {
    const onCommit = jest.fn();
    const onAccountChanged = jest.fn();
    window.addEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      onAccountChanged,
    );
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      personalEligible: true,
      inOrg: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));

    await render(onCommit);

    expect(onCommit).toHaveBeenCalledWith(MODEL);
    expect(onAccountChanged).toHaveBeenCalledTimes(1);
    window.removeEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      onAccountChanged,
    );
  });

  it('shows the lapsed contact-admin copy for a member of a lapsed org', async () => {
    // A lapsed org is zeroed upstream, so `orgCreditPoolCovered` is false and
    // `showContactAdmin` cannot fire. The ONLY thing that distinguishes this
    // user from an ordinary self-serve one is the lapsed org name, which the
    // modal has to read off the account snapshot and hand to
    // `resolveAiCreditsCoverage` — the helper never discovers it on its own.
    // Only the org that OWNS the chat can pay for it (CAN-3463).
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      ownerOrganization: { id: 'org_1', name: 'Acme' },
    });
    loadCanopyCloudAccount.mockResolvedValue(
      account([
        {
          organizationId: 'org_1',
          organizationName: 'Acme',
          teamsEntitled: false,
        },
      ]),
    );

    await render();

    expect(text('model-recovery-contact-admin')).toContain(
      CONTACT_ORG_ADMIN_LAPSED_COPY,
    );
    // A user who cannot self-serve is never shown a purchase CTA.
    expect(
      document.querySelector('[data-testid="model-recovery-get-credits"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="model-recovery-try-again"]'),
    ).not.toBeNull();
  });

  it('shows the generic contact-admin copy for an org pool with no headroom', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      orgCreditPoolCovered: true,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));

    await render();

    const body = text('model-recovery-contact-admin');
    expect(body).toContain(CONTACT_ORG_ADMIN_COPY);
    expect(body).not.toContain(CONTACT_ORG_ADMIN_LAPSED_COPY);
  });

  it('names the org that owns the chat when its pool cannot cover (CAN-3463)', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      orgCreditPoolCovered: true,
      ownerOrganization: { id: 'org_b', name: 'Beta' },
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));

    await render();

    expect(text('model-recovery-contact-admin-org')).toContain(
      "Beta's AI Credits balance can't cover this model right now.",
    );
  });

  it('ignores a lapsed org that does not own the chat (CAN-3463)', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      ownerOrganization: { id: 'org_b', name: 'Beta' },
    });
    loadCanopyCloudAccount.mockResolvedValue(
      account([
        {
          organizationId: 'org_1',
          organizationName: 'Acme',
          teamsEntitled: false,
        },
      ]),
    );

    await render();

    expect(
      document.querySelector('[data-testid="model-recovery-contact-admin"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="model-recovery-get-credits"]'),
    ).not.toBeNull();
  });

  it('reads coverage for the chat it is recovering (CAN-3463)', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(uncovered);
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    root = createRoot(document.body);
    await act(async () => {
      root?.render(
        createElement(ModelRecoveryModal, {
          pending: { model: MODEL, recovery: { kind: 'needs-credits' } },
          onCommit: jest.fn(),
          onCancel: jest.fn(),
          aiCreditsScope: {
            kind: 'work',
            projectId: 'proj-b',
            worktreeId: 'wt-b',
            chatId: 'chat-b',
          },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadNativeAiCreditsAvailability).toHaveBeenCalledWith({
      kind: 'work',
      projectId: 'proj-b',
      worktreeId: 'wt-b',
      chatId: 'chat-b',
    });
  });

  it('commits when Try again finds newly available org headroom', async () => {
    const onCommit = jest.fn();
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      orgCreditPoolCovered: true,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    await render(onCommit);

    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      orgSpendable: true,
      orgCreditPoolCovered: true,
    });
    await act(async () => {
      document
        .querySelector('[data-testid="model-recovery-try-again"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onCommit).toHaveBeenCalledWith(MODEL);
  });

  it('shows the self-serve purchase branch when no org explains the gap', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      inOrg: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));

    await render();

    expect(
      document.querySelector('[data-testid="model-recovery-purchase"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="model-recovery-get-credits"]'),
    ).not.toBeNull();
    // Case B never offers provider sign-in — a gateway-only model can never
    // bill to a Claude/Codex subscription.
    expect(
      document.querySelector('[data-testid="model-recovery-sign-in"]'),
    ).toBeNull();
  });

  it('uses free-credits sign-in framing for a guest account', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      inOrg: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(null);

    await render();

    expect(text('model-recovery-guest')).toContain('Sign in to your');
    expect(text('model-recovery-guest')).not.toContain('free AI Credits');
    expect(
      document.querySelector('[data-testid="model-recovery-get-credits"]'),
    ).not.toBeNull();
  });

  it('offers no purchase CTA on an inconclusive read', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      inconclusive: true,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));

    await render();

    expect(
      document.querySelector('[data-testid="model-recovery-inconclusive"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="model-recovery-get-credits"]'),
    ).toBeNull();
  });

  it('snapshots provider auth before login and commits only after a settled transition', async () => {
    const onCommit = jest.fn();
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      inOrg: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    getClaudeAuthStatus
      .mockResolvedValueOnce({ authenticated: false, probeFailed: false })
      .mockResolvedValueOnce({ authenticated: true, probeFailed: false });
    await render(onCommit, {
      kind: 'needs-billing-source',
      provider: 'claude',
    });

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="model-recovery-sign-in"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="auth-login-modal-stub"]'),
    ).not.toBeNull();

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="auth-login-modal-stub"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getClaudeAuthStatus).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenCalledWith(MODEL);
  });

  it('keeps a retry usable when the host REFUSES the commit after sign-in', async () => {
    // A refused commit does NOT unmount this modal, so every path that latches
    // busy state before committing has to release it. `renderSignIn` is
    // `disabled={signInBusy}`, so leaving it set turned the one retry the
    // settled branch offers into a permanently disabled button.
    const onCommit = jest
      .fn()
      .mockReturnValueOnce({ ok: false, reason: 'This chat is locked.' })
      .mockReturnValueOnce(undefined);
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      inOrg: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    getClaudeAuthStatus.mockResolvedValue({
      authenticated: true,
      probeFailed: false,
    });
    await render(onCommit, {
      kind: 'needs-billing-source',
      provider: 'claude',
    });

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="model-recovery-sign-in"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    // The refusal renders its own branch, with the reason and a working retry.
    const blocked = document.querySelector(
      '[data-testid="model-recovery-commit-blocked"]',
    );
    expect(blocked?.textContent).toContain('This chat is locked.');
    const retry = document.querySelector<HTMLButtonElement>(
      '[data-testid="model-recovery-commit-retry"]',
    );
    expect(retry).not.toBeNull();
    expect(retry?.disabled).toBe(false);
    // Distinct from the account-re-read Try again, so a spec cannot assert one
    // and silently pass against the other.
    expect(
      document.querySelector('[data-testid="model-recovery-try-again"]'),
    ).toBeNull();

    // The lock clears; the same button commits.
    await act(async () => {
      retry?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it('acknowledges a retry that is refused AGAIN with the same reason', async () => {
    // A still-refused retry re-sets the SAME reason string, and React bails out
    // of a re-render on an unchanged value — so without the attempt counter the
    // press repaints nothing at all. `lockedProviderReason` is stable for the
    // whole duration of a streaming or queued turn, which makes every press
    // before it ends a literal no-op: the dead click this ticket removes,
    // inside the branch written to remove it.
    const onCommit = jest
      .fn()
      .mockReturnValue({ ok: false, reason: 'This chat is locked.' });
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      inOrg: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    getClaudeAuthStatus.mockResolvedValue({
      authenticated: true,
      probeFailed: false,
    });
    await render(onCommit, {
      kind: 'needs-billing-source',
      provider: 'claude',
    });

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="model-recovery-sign-in"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const hint = (): string | undefined =>
      document.querySelector('[data-testid="model-recovery-blocked-hint"]')
        ?.textContent ?? undefined;
    const first = hint();
    expect(first).toContain('is still waiting');

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="model-recovery-commit-retry"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The host was asked again AND the UI changed, so the press is visible.
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(hint()).not.toBe(first);
    expect(hint()).toContain('Still no luck');
  });

  it('does not strand the modal when the commit THROWS', async () => {
    // `onCommit` reaches `setModelAndWait` → `window.api.chat.changeModel`,
    // whose main handler awaits `updateQueuedHookChatModel`, `destroySession`
    // and `session.setModel` — any of which can reject. Every caller here
    // latches busy state BEFORE awaiting, so an escaping rejection would leave
    // Sign in permanently disabled (and, on other paths, the modal pinned on
    // "Checking your account…") plus an unhandled rejection. A throw is not a
    // refusal, but it strands the user identically, so it routes into the same
    // blocked branch that already offers a retry.
    const onCommit = jest
      .fn()
      .mockRejectedValueOnce(new Error('ipc exploded'))
      .mockReturnValueOnce(undefined);
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      inOrg: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    getClaudeAuthStatus.mockResolvedValue({
      authenticated: true,
      probeFailed: false,
    });
    await render(onCommit, {
      kind: 'needs-billing-source',
      provider: 'claude',
    });

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="model-recovery-sign-in"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    // Explained, not stranded.
    expect(
      document.querySelector('[data-testid="model-recovery-commit-blocked"]')
        ?.textContent,
    ).toContain('couldn’t switch models');
    const retry = document.querySelector<HTMLButtonElement>(
      '[data-testid="model-recovery-commit-retry"]',
    );
    expect(retry).not.toBeNull();
    expect(retry?.disabled).toBe(false);

    // And the retry still works — the throw must not have latched anything.
    await act(async () => {
      retry?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it('does not commit when provider login closes without authentication', async () => {
    const onCommit = jest.fn();
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      inOrg: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    getClaudeAuthStatus.mockResolvedValue({
      authenticated: false,
      probeFailed: false,
    });
    await render(onCommit, {
      kind: 'needs-billing-source',
      provider: 'claude',
    });

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="model-recovery-sign-in"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="auth-login-modal-stub"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getClaudeAuthStatus).toHaveBeenCalledTimes(2);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('shows Try again instead of asserting signed-out state after a failed provider reprobe', async () => {
    const onCommit = jest.fn();
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      inOrg: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    getClaudeAuthStatus
      .mockResolvedValueOnce({ authenticated: false, probeFailed: false })
      .mockResolvedValueOnce({ authenticated: false, probeFailed: true });
    await render(onCommit, {
      kind: 'needs-billing-source',
      provider: 'claude',
    });

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="model-recovery-sign-in"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="auth-login-modal-stub"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="model-recovery-inconclusive"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="model-recovery-try-again"]'),
    ).not.toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not re-read the account when the parent re-renders', async () => {
    // `ModelPicker` passes `onCommit` as an inline arrow, so its identity
    // changes on every parent render — and `ChatInput` re-renders on every
    // streamed chunk. Keying the account read on that closure turns an open
    // modal into a continuous re-probe: two IPC reads per render, one of which
    // fans out a spendable-credits network call per org.
    loadNativeAiCreditsAvailability.mockResolvedValue(uncovered);
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    root = createRoot(document.body);

    const renderWithFreshCallback = async (): Promise<void> => {
      await act(async () => {
        root?.render(
          createElement(ModelRecoveryModal, {
            pending: { model: MODEL, recovery: { kind: 'needs-credits' } },
            // A NEW closure every time, exactly like the real caller.
            onCommit: (): void => {},
            onCancel: (): void => {},
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    await renderWithFreshCallback();
    // Mount legitimately reads (the modal itself, plus the CTA seeding its
    // pricing URL). What must not grow is the count per re-render.
    const readsAfterMount = loadNativeAiCreditsAvailability.mock.calls.length;
    expect(readsAfterMount).toBeGreaterThan(0);

    await renderWithFreshCallback();
    await renderWithFreshCallback();
    await renderWithFreshCallback();

    expect(loadNativeAiCreditsAvailability.mock.calls.length).toBe(
      readsAfterMount,
    );
  });

  it('shows Check again feedback inside the plain-credits block host (CAN-5162)', async () => {
    jest.useFakeTimers();
    const requestConnect = useCloudConnectGateStore.getState().requestConnect;
    try {
      useCloudConnectGateStore.setState({
        requestConnect: (_context, proceed): void => proceed(),
      });
      loadNativeAiCreditsAvailability.mockResolvedValue(uncovered);
      loadCanopyCloudAccount.mockResolvedValue(account([]));
      root = createRoot(document.body);
      await act(async () => {
        root?.render(
          createElement(ModelRecoveryModal, {
            pending: {
              model: MODEL,
              recovery: { kind: 'needs-credits' },
              intent: 'enable-ai-credits',
            },
            onCommit: jest.fn(),
            onCancel: jest.fn(),
          }),
        );
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
      const primary = document.querySelector<HTMLButtonElement>(
        '[data-testid="model-recovery-get-credits"]',
      );
      if (!primary) throw new Error('missing credits button');
      await act(async () => {
        primary.click();
        for (let i = 0; i < 30; i += 1) await Promise.resolve();
      });
      const check = document.querySelector<HTMLButtonElement>(
        '[data-testid="model-recovery-get-credits-check-again"]',
      );
      if (!check) throw new Error('missing Check again');
      await act(async () => {
        check.click();
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
      expect(check.disabled).toBe(true);
      await act(async () => {
        jest.advanceTimersByTime(500);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
      expect(text('model-recovery-get-credits-check-feedback')).toContain(
        "No credits yet. If you've paid, they can take a minute to arrive.",
      );
      expect(
        document
          .querySelector(
            '[data-testid="model-recovery-get-credits-check-feedback-region"]',
          )
          ?.getAttribute('role'),
      ).toBe('status');
      expect(
        document.querySelector('[data-testid="model-recovery-unlock-waiting"]'),
      ).toBeNull();
    } finally {
      useCloudConnectGateStore.setState({ requestConnect });
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('describes a billing-mode switch without blaming the current model', async () => {
    // Case C escalation from the picker footer: `model` is the CURRENT model
    // and is usually an ordinary subscription-billable model. Telling the user
    // it "runs on AI Credits" is simply false — they are switching how the
    // chat is billed, not unlocking anything.
    loadNativeAiCreditsAvailability.mockResolvedValue(uncovered);
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    root = createRoot(document.body);
    await act(async () => {
      root?.render(
        createElement(ModelRecoveryModal, {
          pending: {
            model: MODEL,
            recovery: { kind: 'needs-credits' },
            intent: 'enable-ai-credits',
          },
          onCommit: jest.fn(),
          onCancel: jest.fn(),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(heading()).toBe('Bill this chat to AI Credits');
    const copy = text('model-recovery-purchase');
    expect(copy).toBe(
      "You're out of AI Credits, so this chat stays on your subscription for now.",
    );
    expect(text('model-recovery-get-credits')).toBe('Get AI Credits');
  });

  it('stays MOUNTED (hidden) while the shared cloud gate is up', async () => {
    // Unmounting here orphaned the `GetAiCreditsCta` that opened the gate:
    // `CloudConnectGate` resolves before it calls `proceed`, so the callback
    // ran with `mountedRef.current === false`, its post-connect coverage check
    // bailed, and it fell through to opening a billing page. The guest signed
    // in, got the free credits the copy promised, and was sent to a purchase
    // page anyway with the model never committed.
    loadNativeAiCreditsAvailability.mockResolvedValue(uncovered);
    loadCanopyCloudAccount.mockResolvedValue(null);
    await render();

    expect(
      document.querySelector('[data-testid="model-recovery-get-credits"]'),
    ).not.toBeNull();

    await act(async () => {
      useCloudConnectGateStore.setState({
        pending: { context: { title: 'Get AI Credits' }, proceed: () => {} },
      });
      await Promise.resolve();
    });

    // Signing in emits an identity change before the shared gate closes.
    // Keep the same CTA alive: its post-connect continuation and modal focus
    // belong to the sign-in the user explicitly started.
    const initiatingCta = document.querySelector(
      '[data-testid="model-recovery-get-credits"]',
    );
    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="model-recovery-get-credits"]'),
    ).toBe(initiatingCta);
    const overlay = document
      .querySelector('[data-testid="model-recovery-modal"]')
      ?.closest('div[class*="fixed"]');
    expect(overlay?.className).toContain('hidden');
  });

  it('opens NO billing page when the gate resolves after the CTA is gone', async () => {
    // The whole point of the recovery flow: a user who ends up covered must
    // never be handed a purchase page. `commitIfAlreadyCovered` used to answer
    // a bare `false` for BOTH "no credits" and "this CTA unmounted", so a
    // recovery that was cancelled — or that another path already committed and
    // tore down — still fell through to `beginBillingHandoff()` and opened a
    // browser tab attributable to nothing the user could still see.
    //
    // This drives the REAL composed path: the gate's `proceed` is the callback
    // `GetAiCreditsCta` actually registered, not a `() => {}` stub. Stubbing it
    // is what let this survive three review rounds.
    loadNativeAiCreditsAvailability.mockResolvedValue(uncovered);
    loadCanopyCloudAccount.mockResolvedValue(null);
    await render();

    const cta = document.querySelector(
      '[data-testid="model-recovery-get-credits"]',
    );
    expect(cta).not.toBeNull();

    await act(async () => {
      cta?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const proceed = useCloudConnectGateStore.getState().pending?.proceed;
    expect(typeof proceed).toBe('function');

    // Signed in during the gate, and the new account came with free credits —
    // exactly what the guest copy promised.
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      personalEligible: true,
      inOrg: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));

    // The user cancels (or another path commits) — the CTA leaves the tree
    // while the post-connect read is still in flight.
    await act(async () => {
      root?.unmount();
      root = null;
      proceed?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens NO billing page when the post-connect read is inconclusive', async () => {
    // A read that did not resolve is not evidence about the user's balance.
    // `commitIfAlreadyCovered` used to spell both a `null` read and an
    // `inconclusive: true` read as `'uncovered'` — the one value that opens a
    // billing page — so on a single gate close the modal could render "we
    // couldn't check your account just now" while a purchase tab opened anyway.
    // Both surfaces now read the SAME shared promise, so they cannot reach
    // opposite conclusions.
    loadNativeAiCreditsAvailability.mockResolvedValue(uncovered);
    loadCanopyCloudAccount.mockResolvedValue(null);
    await render();

    const cta = document.querySelector(
      '[data-testid="model-recovery-get-credits"]',
    );
    await act(async () => {
      cta?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const proceed = useCloudConnectGateStore.getState().pending?.proceed;
    expect(typeof proceed).toBe('function');

    // Signed in, but the credits read comes back inconclusive.
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      inconclusive: true,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));

    await act(async () => {
      // Close through `resolve()`, the way production does: the store opens a
      // new availability episode there, so a post-connect read cannot inherit
      // the pre-sign-in answer. Poking `pending` directly would skip that and
      // test a close that cannot happen.
      useCloudConnectGateStore.getState().resolve();
      proceed?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    // The user is told why, rather than left on a dead button.
    expect(
      document.querySelector('[data-testid="model-recovery-try-again"]'),
    ).not.toBeNull();
  });

  it('commits ONCE when the gate close and the CTA both find coverage', async () => {
    // Closing the gate wakes two independent commit paths — the modal's own
    // `refreshAccountRead` and the CTA's `proceedAfterConnect` — and both
    // re-read the same now-covered account. Without a shared latch a single
    // sign-in commits the model twice, and `ModelPicker` has already cleared
    // `recoveryModelChangeRef` by the time the second one lands, so it falls
    // back to the LIVE `onModelChange` and selects on whatever chat is active
    // by then.
    const onCommit = jest.fn();
    loadNativeAiCreditsAvailability.mockResolvedValue(uncovered);
    loadCanopyCloudAccount.mockResolvedValue(null);
    await render(onCommit);

    const cta = document.querySelector(
      '[data-testid="model-recovery-get-credits"]',
    );
    await act(async () => {
      cta?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const proceed = useCloudConnectGateStore.getState().pending?.proceed;
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      personalEligible: true,
      inOrg: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));

    // Close the gate — the modal re-reads — AND run the CTA's own callback.
    // Both observe coverage; the host here does NOT unmount on commit, so
    // nothing but the latch can keep this to a single call.
    await act(async () => {
      // Close through `resolve()`, the way production does: the store opens a
      // new availability episode there, so a post-connect read cannot inherit
      // the pre-sign-in answer. Poking `pending` directly would skip that and
      // test a close that cannot happen.
      useCloudConnectGateStore.getState().resolve();
      proceed?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(MODEL);
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('re-reads the account when the cloud gate closes', async () => {
    // The visible branch was chosen from a PRE-sign-in snapshot, so without a
    // re-read a guest who just signed in comes back to "Sign in to your
    // account…" — copy aimed at someone who is now signed in.
    loadNativeAiCreditsAvailability.mockResolvedValue(uncovered);
    loadCanopyCloudAccount.mockResolvedValue(null);
    await render();
    expect(
      document.querySelector('[data-testid="model-recovery-guest"]'),
    ).not.toBeNull();

    await act(async () => {
      useCloudConnectGateStore.setState({
        pending: { context: { title: 'Get AI Credits' }, proceed: () => {} },
      });
      await Promise.resolve();
    });

    // Signed in during the gate, still without credits.
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    await act(async () => {
      // Close through `resolve()`, the way production does: the store opens a
      // new availability episode there, so a post-connect read cannot inherit
      // the pre-sign-in answer. Poking `pending` directly would skip that and
      // test a close that cannot happen.
      useCloudConnectGateStore.getState().resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="model-recovery-guest"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="model-recovery-purchase"]'),
    ).not.toBeNull();
  });

  it('shows the native-only branch to a GUEST too', async () => {
    // The guest branch used to be checked first, so it offered
    // "new accounts start with free AI Credits" for a model those credits can
    // never route — and would have committed it on coverage.
    const onCommit = jest.fn();
    loadNativeAiCreditsAvailability.mockResolvedValue(uncovered);
    loadCanopyCloudAccount.mockResolvedValue(null);
    root = createRoot(document.body);
    await act(async () => {
      root?.render(
        createElement(ModelRecoveryModal, {
          pending: {
            model: NATIVE_ONLY_MODEL,
            recovery: { kind: 'needs-billing-source', provider: 'codex' },
          },
          onCommit,
          onCancel: jest.fn(),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="model-recovery-native-only"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="model-recovery-guest"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="model-recovery-get-credits"]'),
    ).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not commit a native-only model just because the account has credits', async () => {
    // `canSpendCredits` is ACCOUNT coverage — "can you pay for a gateway-routed
    // turn?" — and says nothing about whether this model has a gateway route.
    // Committing a native-only model here selects something with no way to run:
    // credits cannot route it and the provider login is still missing. Only
    // signing in clears that branch, so no purchase CTA either.
    const onCommit = jest.fn();
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      personalEligible: true,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    root = createRoot(document.body);
    await act(async () => {
      root?.render(
        createElement(ModelRecoveryModal, {
          pending: {
            model: NATIVE_ONLY_MODEL,
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
    expect(
      document.querySelector('[data-testid="model-recovery-native-only"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="model-recovery-get-credits"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="model-recovery-sign-in"]'),
    ).not.toBeNull();
  });

  it('still commits a gateway-routable model when the account has credits', async () => {
    // The complement: credits genuinely do unblock a routable model, so the
    // narrowing above must not suppress a legitimate recovery.
    const onCommit = jest.fn();
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      personalEligible: true,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    await render(onCommit, {
      kind: 'needs-billing-source',
      provider: 'claude',
    });

    expect(onCommit).toHaveBeenCalled();
  });

  it('keeps model-first copy for an ordinary row click', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(uncovered);
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    await render();

    expect(text('model-recovery-purchase')).toContain('runs on');
  });

  it('frames a subscription-billable model as a choice between credits and the subscription', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      inOrg: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    getClaudeAuthStatus.mockResolvedValue({
      authenticated: false,
      probeFailed: false,
    });

    await render(jest.fn(), {
      kind: 'needs-billing-source',
      provider: 'claude',
    });

    expect(heading()).toBe(`Choose how to use ${getModelDisplayName(MODEL)}`);
    expect(text('model-recovery-purchase')).toBe("You're out of AI Credits.");
    expect(text('model-recovery-get-credits')).toBe('Get AI Credits');
    expect(text('model-recovery-sign-in')).toBe('Use my Claude subscription');
    expect(text('model-recovery-cancel')).toBeNull();
  });
});

/**
 * CAN-3026 — the `needs-account` branch.
 *
 * The thing that makes this branch non-obvious: a guest is normally FUNDED
 * (daily drip, `DEFAULT_DAILY_DRIP_CAP_CREDITS`), so `canSpendCredits` is
 * routinely true for exactly the principal the gate exists to stop. Coverage
 * must not clear an account gate.
 */
describe('ModelRecoveryModal — guest account gate (CAN-3026)', () => {
  /** Funded guest: credits available, but no connected account. */
  function stubFundedGuest(): void {
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      personalEligible: true,
      inOrg: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(null);
  }

  it('holds the gate for a FUNDED guest instead of committing on coverage', async () => {
    stubFundedGuest();
    const onCommit = jest.fn();
    await render(onCommit, { kind: 'needs-account' });

    expect(text('model-recovery-needs-account')).toContain('needs a free');
    // The load-bearing assertion. Without the guard in `refreshAccountRead`,
    // the drip would silently buy the guest the expensive model the row gate
    // just refused.
    expect(onCommit).not.toHaveBeenCalled();
    // And it must not lead with a purchase for something money cannot buy.
    expect(
      document.querySelector('[data-testid="model-recovery-get-credits"]'),
    ).toBeNull();
  });

  it('opens the SHARED cloud gate and commits nothing synchronously', async () => {
    stubFundedGuest();
    let connectContext: CloudConnectGateContext | null = null;
    const requestConnect = jest.fn((context: CloudConnectGateContext): void => {
      connectContext = context;
    });
    const realRequestConnect =
      useCloudConnectGateStore.getState().requestConnect;
    useCloudConnectGateStore.setState({ requestConnect });
    const onCommit = jest.fn();
    await render(onCommit, { kind: 'needs-account' });

    act(() => {
      document
        .querySelector('[data-testid="model-recovery-account-sign-in"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(requestConnect).toHaveBeenCalledTimes(1);
    expect(connectContext).toMatchObject({
      guestBenefits: true,
      title: guestModelGateTitle(),
      toastMessage: guestModelGateToast(getModelDisplayName(MODEL)),
    });
    // The commit belongs to the post-gate coverage re-read.
    expect(onCommit).not.toHaveBeenCalled();

    useCloudConnectGateStore.setState({ requestConnect: realRequestConnect });
  });

  it('renders through an UNHYDRATED model registry, not the routes shell', async () => {
    // Pins `needsGatewayRoute === false` for this kind, at the only place it is
    // observable from outside the component.
    //
    // `needsGatewayRoute` is `recovery.kind === 'needs-billing-source'`, and
    // while it is true with an unhydrated registry the modal returns the
    // "Checking what this model can run on…" shell BEFORE reaching any other
    // branch. If `needs-account` were ever folded into that predicate, a guest
    // would sit on a spinner waiting for a routability answer this gate has no
    // use for — it needs an ACCOUNT, not a route.
    //
    // The readiness flag is registry-LIFECYCLE state (`hasHydratedModelRegistry`),
    // not a route count, so emptying the route table would not reproduce the
    // window: `initAiGatewayModels([], [])` still marks the registry hydrated.
    // Forcing the flag is the only way to tell the two predicates apart.
    const unhydrated = jest
      .spyOn(registryTypes, 'hasHydratedModelRegistry')
      .mockReturnValue(false);
    try {
      stubFundedGuest();
      const onCommit = jest.fn();
      await render(onCommit, { kind: 'needs-account' });

      expect(
        document.querySelector(
          '[data-testid="model-recovery-checking-routes"]',
        ),
      ).toBeNull();
      expect(text('model-recovery-needs-account')).toContain('needs a free');
      expect(onCommit).not.toHaveBeenCalled();
    } finally {
      unhydrated.mockRestore();
    }
  });

  it('falls through to the ordinary coverage path once the guest signs in', async () => {
    // Conditioning on the LIVE `read.guest`, not only the snapshotted recovery,
    // is what stops a user who just signed in from being asked to sign in
    // again. With a real account the guard lifts and coverage commits.
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      personalEligible: true,
      inOrg: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));

    const onCommit = jest.fn();
    await render(onCommit, { kind: 'needs-account' });

    expect(
      document.querySelector('[data-testid="model-recovery-needs-account"]'),
    ).toBeNull();
    expect(onCommit).toHaveBeenCalledWith(MODEL);
  });
});

/**
 * CAN-4703 — the guest gate names a free alternative and selects it in one
 * click, through the same guarded commit path as a recovered model.
 */
describe('ModelRecoveryModal — guest fallback (CAN-4703)', () => {
  const FALLBACK = {
    model: 'claude-haiku-5.5',
    gatewayId: 'anthropic/claude-haiku-5.5',
    label: 'Claude Haiku 5.5',
    access: 'now' as const,
  };

  function stubGuest(): void {
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      personalEligible: true,
      inOrg: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(null);
  }

  async function renderGate({
    onUseGuestFallback,
    onCommit = jest.fn(),
    access,
    withFallback = true,
    onCancel = jest.fn(),
  }: {
    onUseGuestFallback?: (
      fallback: NonNullable<
        React.ComponentProps<
          typeof ModelRecoveryModal
        >['pending']['guestFallback']
      >,
    ) => Promise<GuestFallbackOutcome>;
    onCommit?: () => void;
    access?: 'needs_sign_in' | 'needs_sign_in_then_purchase';
    withFallback?: boolean;
    onCancel?: () => void;
  }): Promise<void> {
    root = createRoot(document.body);
    await act(async () => {
      root?.render(
        createElement(ModelRecoveryModal, {
          pending: {
            model: MODEL,
            recovery: {
              kind: 'needs-account',
              ...(access === undefined ? {} : { access }),
            },
            ...(withFallback ? { guestFallback: FALLBACK } : {}),
          },
          onCommit,
          onCancel,
          ...(onUseGuestFallback === undefined ? {} : { onUseGuestFallback }),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function button(testId: string): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
  }

  function clickFallback(): void {
    act(() => {
      button('model-recovery-guest-fallback')?.click();
    });
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
  } {
    let resolve: (value: T) => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  beforeEach(stubGuest);

  it('names the free account and the alternative, in sign-in, fallback, dismiss order', async () => {
    await renderGate({ onUseGuestFallback: jest.fn() });
    const label = getModelDisplayName(MODEL);

    expect(document.body.textContent).toContain(`Sign in free to use ${label}`);
    expect(text('model-recovery-needs-account')).toBe(
      `${label} needs a free ${brandText.appName} account. As a guest you can use Claude Haiku 5.5 right now.`,
    );
    const actions = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="model-recovery-modal"] button[data-testid^="model-recovery-"]',
      ),
    ).map((element) => element.dataset.testid);
    expect(actions).toEqual([
      'model-recovery-account-sign-in',
      'model-recovery-guest-fallback',
      'model-recovery-cancel',
    ]);
    expect(text('model-recovery-account-sign-in')).toBe(
      `Sign in to use ${label}`,
    );
    expect(text('model-recovery-guest-fallback')).toBe(
      'Use Claude Haiku 5.5 (free)',
    );
    expect(text('model-recovery-cancel')).toBe('Not now');
    expect(document.activeElement).toBe(
      button('model-recovery-account-sign-in'),
    );
  });

  it.each([
    ['a snapshot without a host callback', { withFallback: true }],
    [
      'a callback without a snapshot',
      { withFallback: false, onUseGuestFallback: jest.fn() },
    ],
  ])('offers neither the sentence nor the button for %s', async (_, args) => {
    await renderGate(args);

    expect(button('model-recovery-guest-fallback')).toBeNull();
    expect(text('model-recovery-needs-account')).toContain(
      'Your guest work comes with you, nothing is lost.',
    );
    expect(text('model-recovery-needs-account')).not.toContain('right now');
  });

  it('keeps the purchase copy while offering the fallback', async () => {
    await renderGate({
      onUseGuestFallback: jest.fn(),
      access: 'needs_sign_in_then_purchase',
    });

    expect(text('model-recovery-needs-account')).toBe(
      `Using ${getModelDisplayName(MODEL)} requires a free ${brandText.appName} account and a purchase of AI Credits. As a guest you can use Claude Haiku 5.5 right now.`,
    );
    expect(text('model-recovery-guest-fallback')).toBe(
      'Use Claude Haiku 5.5 (free)',
    );
  });

  it('invokes only the fallback path, once, however often it is pressed', async () => {
    const pending = deferred<GuestFallbackOutcome>();
    const onUseGuestFallback = jest.fn(() => pending.promise);
    const onCommit = jest.fn();
    const onCancel = jest.fn();
    await renderGate({ onUseGuestFallback, onCommit, onCancel });

    clickFallback();
    clickFallback();
    expect(onUseGuestFallback).toHaveBeenCalledTimes(1);
    expect(onUseGuestFallback).toHaveBeenCalledWith(FALLBACK);
    expect(button('model-recovery-guest-fallback')?.disabled).toBe(true);
    // A competing sign-in would be a second outcome.
    expect(button('model-recovery-account-sign-in')?.disabled).toBe(true);
    expect(button('model-recovery-cancel')?.disabled).toBe(true);
    act(() => {
      button('model-recovery-cancel')?.click();
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onCancel).not.toHaveBeenCalled();
    expect(
      document.querySelector(
        '[data-testid="model-recovery-guest-fallback-spinner"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      pending.resolve({ kind: 'committed' });
      await pending.promise;
    });
    clickFallback();
    expect(onUseGuestFallback).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('shows a refusal inside the gate and lets the user retry', async () => {
    const onUseGuestFallback = jest
      .fn<
        Promise<GuestFallbackOutcome>,
        [
          NonNullable<
            React.ComponentProps<
              typeof ModelRecoveryModal
            >['pending']['guestFallback']
          >,
        ]
      >()
      .mockResolvedValueOnce({
        kind: 'blocked',
        reason: 'Claude Haiku 5.5 isn’t available right now.',
      })
      .mockResolvedValueOnce({ kind: 'committed' });
    const onCommit = jest.fn();
    await renderGate({ onUseGuestFallback, onCommit });

    clickFallback();
    await flush();

    expect(text('model-recovery-fallback-blocked')).toBe(
      'Claude Haiku 5.5 isn’t available right now.',
    );
    // Never the commit-blocked branch: its Try again commits the GATED model.
    expect(
      document.querySelector('[data-testid="model-recovery-commit-blocked"]'),
    ).toBeNull();
    expect(button('model-recovery-guest-fallback')?.disabled).toBe(false);
    expect(button('model-recovery-account-sign-in')?.disabled).toBe(false);

    clickFallback();
    await flush();
    expect(onUseGuestFallback).toHaveBeenCalledTimes(2);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('turns a rejected fallback into a retryable failure', async () => {
    const onUseGuestFallback = jest
      .fn<
        Promise<GuestFallbackOutcome>,
        [
          NonNullable<
            React.ComponentProps<
              typeof ModelRecoveryModal
            >['pending']['guestFallback']
          >,
        ]
      >()
      .mockRejectedValue(new Error('ipc down'));
    await renderGate({ onUseGuestFallback });

    clickFallback();
    await flush();

    expect(text('model-recovery-fallback-blocked')).toContain(
      'couldn’t switch models',
    );
    expect(button('model-recovery-guest-fallback')?.disabled).toBe(false);
  });

  it('does not latch a commit on a redirect', async () => {
    const onUseGuestFallback = jest
      .fn<
        Promise<GuestFallbackOutcome>,
        [
          NonNullable<
            React.ComponentProps<
              typeof ModelRecoveryModal
            >['pending']['guestFallback']
          >,
        ]
      >()
      .mockResolvedValue({ kind: 'redirected' });
    await renderGate({ onUseGuestFallback });

    clickFallback();
    await flush();
    expect(
      document.querySelector('[data-testid="model-recovery-fallback-blocked"]'),
    ).toBeNull();

    // A host that keeps this modal mounted must still be able to try again.
    clickFallback();
    await flush();
    expect(onUseGuestFallback).toHaveBeenCalledTimes(2);
  });

  it('ignores a completion that lands after the modal unmounted', async () => {
    const pending = deferred<GuestFallbackOutcome>();
    await renderGate({ onUseGuestFallback: () => pending.promise });

    clickFallback();
    act(() => {
      root?.unmount();
      root = null;
    });
    await act(async () => {
      pending.resolve({ kind: 'blocked', reason: 'late' });
      await pending.promise;
    });

    expect(document.body.textContent).not.toContain('late');
  });
});

/**
 * CAN-5211 — a guest who declined free daily credits can still reach the
 * guest model: the gate's secondary action turns daily credits on, re-reads
 * the balance, and selects it through the host's guarded path.
 */
describe('ModelRecoveryModal — daily-credits guest fallback (CAN-5211)', () => {
  const FALLBACK = {
    model: 'claude-haiku-5.5',
    gatewayId: 'anthropic/claude-haiku-5.5',
    label: 'Claude Haiku 5.5',
    access: 'daily-credits' as const,
  };
  const ACTION = 'Use Claude Haiku 5.5 with free daily AI Credits';

  /** A connected guest credential. */
  const guestAccount = {
    hasApiKey: true,
    account: { id: 'guest_1' },
    authMode: 'guest',
    credentialSource: 'guest',
    orgBillingStates: [],
  };
  const declined = {
    ...uncovered,
    inOrg: false,
    dailyDripEnabled: false,
  };
  const funded = {
    ...uncovered,
    inOrg: false,
    personalEligible: true,
    dailyDripEnabled: true,
  };
  const savedDrip = {
    enabled: true,
    decidedAt: '2026-10-27T19:00:00.000Z',
    capCredits: 10,
    balanceCredits: 10,
    granted: 10,
  };

  function button(testId: string): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 8; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
  } {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  async function renderGate({
    onUseGuestFallback,
    fallback = FALLBACK,
    access = 'needs_sign_in_then_purchase',
    strict = false,
  }: {
    onUseGuestFallback?: (
      fallback: typeof FALLBACK | { readonly access: 'now' },
    ) => Promise<GuestFallbackOutcome>;
    fallback?:
      | typeof FALLBACK
      | (Omit<typeof FALLBACK, 'access'> & { readonly access: 'now' });
    access?: 'needs_sign_in' | 'needs_sign_in_then_purchase';
    strict?: boolean;
  } = {}): Promise<void> {
    root = createRoot(document.body);
    act(() => {
      const gate = createElement(ModelRecoveryModal, {
        pending: {
          model: MODEL,
          recovery: { kind: 'needs-account', access },
          guestFallback: fallback,
        },
        onCommit: jest.fn(),
        onCancel: jest.fn(),
        ...(onUseGuestFallback === undefined ? {} : { onUseGuestFallback }),
      });
      root?.render(strict ? createElement(StrictMode, null, gate) : gate);
    });
    await settle();
  }

  function press(testId: string): void {
    act(() => {
      button(testId)?.click();
    });
  }

  beforeEach(() => {
    saveCloudDailyCreditDrip.mockReset();
    loadCloudDailyCreditDrip.mockReset();
    loadNativeAiCreditsAvailability.mockResolvedValue(declined);
    loadCanopyCloudAccount.mockResolvedValue(guestAccount);
    loadCloudDailyCreditDrip.mockImplementation(async () => ({
      available: true,
      resolved: true,
      preference: {
        enabled:
          (await loadNativeAiCreditsAvailability())?.dailyDripEnabled ?? false,
        decidedAt: '2026-10-27T19:00:00.000Z',
        capCredits: 10,
      },
    }));
  });

  it.each<
    [string, { available: boolean; resolved: boolean; capCredits?: number }]
  >([
    ['unavailable', { available: false, resolved: true }],
    ['unresolved', { available: true, resolved: false }],
    ['zero-cap', { available: true, resolved: true, capCredits: 0 }],
  ])(
    'hides activation for an authoritative %s preference',
    async (_, state) => {
      loadCloudDailyCreditDrip.mockResolvedValue({
        ...state,
        preference: {
          enabled: false,
          decidedAt: null,
          capCredits: state.capCredits ?? 10,
        },
      });
      await renderGate({ onUseGuestFallback: jest.fn() });
      expect(button('model-recovery-guest-fallback')).toBeNull();
      expect(text('model-recovery-needs-account')).not.toContain('As a guest');
    },
  );

  it('selects without enabling when the settled coverage already pays', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...funded,
      dailyDripEnabled: false,
    });
    const onUseGuestFallback = jest
      .fn()
      .mockResolvedValue({ kind: 'committed' });
    await renderGate({ onUseGuestFallback });
    press('model-recovery-guest-fallback');
    await settle();
    expect(saveCloudDailyCreditDrip).not.toHaveBeenCalled();
    expect(onUseGuestFallback).toHaveBeenCalledTimes(1);
  });

  it('settles the current attempt after StrictMode effect replay', async () => {
    await renderGate({ strict: true, onUseGuestFallback: jest.fn() });
    expect(text('model-recovery-guest-fallback')).toBe(ACTION);
    expect(text('model-recovery-checking')).toBeNull();
  });

  it('reconciles a same-account refresh during the save without a second click', async () => {
    const save = deferred<unknown>();
    saveCloudDailyCreditDrip.mockReturnValue(save.promise);
    const onUseGuestFallback = jest
      .fn()
      .mockResolvedValue({ kind: 'committed' });
    await renderGate({ onUseGuestFallback });
    press('model-recovery-guest-fallback');
    await settle();
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, {
          detail: { reason: 'same-account-refresh' },
        }),
      );
    });
    loadNativeAiCreditsAvailability.mockResolvedValue(funded);
    await act(async () => {
      save.resolve(savedDrip);
      await save.promise;
    });
    await settle();
    expect(saveCloudDailyCreditDrip).toHaveBeenCalledTimes(1);
    expect(onUseGuestFallback).toHaveBeenCalledTimes(1);
  });

  it('withholds activation until the authoritative preference settles', async () => {
    const preference = deferred<unknown>();
    loadCloudDailyCreditDrip.mockReturnValue(preference.promise);
    await renderGate({ onUseGuestFallback: jest.fn() });
    expect(text('model-recovery-checking')).toContain('Checking');
    expect(button('model-recovery-guest-fallback')).toBeNull();
    await act(async () => {
      preference.resolve({
        available: true,
        resolved: true,
        preference: { enabled: false, capCredits: 10, decidedAt: null },
      });
      await preference.promise;
    });
    await settle();
    expect(text('model-recovery-guest-fallback')).toBe(ACTION);
  });

  it('offers no activation after an eligibility read rejection or sign-in', async () => {
    loadCloudDailyCreditDrip.mockRejectedValue(new Error('offline'));
    await renderGate({ onUseGuestFallback: jest.fn() });
    expect(button('model-recovery-guest-fallback')).toBeNull();
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    await settle();
    expect(button('model-recovery-guest-fallback')).toBeNull();
    expect(saveCloudDailyCreditDrip).not.toHaveBeenCalled();
  });

  it('ignores an old save after an account change and keeps a new attempt busy', async () => {
    const oldSave = deferred<unknown>();
    const newSave = deferred<unknown>();
    saveCloudDailyCreditDrip
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValueOnce(newSave.promise);
    const onUseGuestFallback = jest
      .fn()
      .mockResolvedValue({ kind: 'committed' });
    await renderGate({ onUseGuestFallback });
    press('model-recovery-guest-fallback');
    await settle();
    act(() => {
      // Another surface may open sign-in while the enable request is pending.
      // Its account change must still retire the daily-credit continuation.
      useCloudConnectGateStore.setState({
        pending: { context: {}, proceed: (): void => {} },
      });
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    await settle();
    act(() => {
      useCloudConnectGateStore.setState({ pending: null });
    });
    await settle();
    press('model-recovery-guest-fallback');
    await settle();
    expect(saveCloudDailyCreditDrip).toHaveBeenCalledTimes(2);
    await act(async () => {
      oldSave.resolve(savedDrip);
      await oldSave.promise;
    });
    await settle();
    expect(onUseGuestFallback).not.toHaveBeenCalled();
    expect(button('model-recovery-guest-fallback')?.disabled).toBe(true);
    loadNativeAiCreditsAvailability.mockResolvedValue(funded);
    await act(async () => {
      newSave.resolve(savedDrip);
      await newSave.promise;
    });
    await settle();
    expect(onUseGuestFallback).toHaveBeenCalledTimes(1);
  });

  it('offers the guest model through free daily credits, below the purchase', async () => {
    await renderGate({ onUseGuestFallback: jest.fn() });

    expect(text('model-recovery-needs-account')).toBe(
      `Using ${getModelDisplayName(MODEL)} requires a free ${brandText.appName} account and a purchase of AI Credits. As a guest you can use Claude Haiku 5.5 with free daily AI Credits.`,
    );
    const actions = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="model-recovery-modal"] button[data-testid^="model-recovery-"]',
      ),
    ).map((element) => element.dataset.testid);
    expect(actions).toEqual([
      'model-recovery-account-sign-in',
      'model-recovery-guest-fallback',
      'model-recovery-cancel',
    ]);
    expect(text('model-recovery-account-sign-in')).toBe('Get AI Credits');
    expect(text('model-recovery-guest-fallback')).toBe(ACTION);
    expect(
      button('model-recovery-guest-fallback')?.dataset.fallbackAccess,
    ).toBe('daily-credits');
    expect(document.activeElement).toBe(
      button('model-recovery-account-sign-in'),
    );
  });

  it.each<[string, () => void, boolean]>([
    [
      'a guest with no cloud credential',
      (): void => {
        loadCanopyCloudAccount.mockResolvedValue(null);
      },
      true,
    ],
    [
      'daily credits already on and spent',
      (): void => {
        loadNativeAiCreditsAvailability.mockResolvedValue({
          ...declined,
          dailyDripEnabled: true,
        });
      },
      true,
    ],
    [
      'an older server that omits the preference',
      (): void => {
        loadNativeAiCreditsAvailability.mockResolvedValue({
          ...uncovered,
          inOrg: false,
        });
      },
      true,
    ],
    [
      'an inconclusive read',
      (): void => {
        loadNativeAiCreditsAvailability.mockResolvedValue({
          ...declined,
          inconclusive: true,
        });
      },
      false,
    ],
  ])('offers no alternative for %s', async (_case, arrange, gateShown) => {
    arrange();
    const onUseGuestFallback = jest.fn();
    await renderGate({ onUseGuestFallback });

    expect(button('model-recovery-guest-fallback')).toBeNull();
    if (gateShown) {
      expect(text('model-recovery-needs-account')).not.toContain('As a guest');
      expect(button('model-recovery-account-sign-in')).not.toBeNull();
    }
    expect(saveCloudDailyCreditDrip).not.toHaveBeenCalled();
  });

  it('offers no alternative without a host callback', async () => {
    await renderGate();

    expect(button('model-recovery-guest-fallback')).toBeNull();
    expect(text('model-recovery-needs-account')).not.toContain('As a guest');
  });

  it('turns daily credits on once, then selects the guest model once', async () => {
    const save = deferred<unknown>();
    saveCloudDailyCreditDrip.mockReturnValue(save.promise);
    const onUseGuestFallback = jest.fn(
      (): Promise<GuestFallbackOutcome> =>
        Promise.resolve({ kind: 'committed' }),
    );
    await renderGate({ onUseGuestFallback });

    press('model-recovery-guest-fallback');
    press('model-recovery-guest-fallback');
    await settle();
    expect(saveCloudDailyCreditDrip).toHaveBeenCalledTimes(1);
    expect(saveCloudDailyCreditDrip).toHaveBeenCalledWith({ enabled: true });
    expect(button('model-recovery-guest-fallback')?.disabled).toBe(true);
    expect(button('model-recovery-account-sign-in')?.disabled).toBe(true);
    expect(button('model-recovery-cancel')?.disabled).toBe(true);
    expect(onUseGuestFallback).not.toHaveBeenCalled();

    loadNativeAiCreditsAvailability.mockResolvedValue(funded);
    await act(async () => {
      save.resolve(savedDrip);
      await save.promise;
    });
    await settle();
    press('model-recovery-guest-fallback');
    await settle();

    expect(saveCloudDailyCreditDrip).toHaveBeenCalledTimes(1);
    expect(onUseGuestFallback).toHaveBeenCalledTimes(1);
    expect(onUseGuestFallback).toHaveBeenCalledWith(FALLBACK);
  });

  it('never saves for a fallback usable right now', async () => {
    const onUseGuestFallback = jest.fn(
      (): Promise<GuestFallbackOutcome> =>
        Promise.resolve({ kind: 'committed' }),
    );
    await renderGate({
      onUseGuestFallback,
      fallback: { ...FALLBACK, access: 'now' },
    });

    expect(text('model-recovery-guest-fallback')).toBe(
      'Use Claude Haiku 5.5 (free)',
    );
    press('model-recovery-guest-fallback');
    await settle();

    expect(saveCloudDailyCreditDrip).not.toHaveBeenCalled();
    expect(onUseGuestFallback).toHaveBeenCalledTimes(1);
  });

  it('keeps a retryable error when the save fails', async () => {
    saveCloudDailyCreditDrip.mockRejectedValueOnce(new Error('offline'));
    const onUseGuestFallback = jest.fn(
      (): Promise<GuestFallbackOutcome> =>
        Promise.resolve({ kind: 'committed' }),
    );
    await renderGate({ onUseGuestFallback });

    press('model-recovery-guest-fallback');
    await settle();

    expect(text('model-recovery-fallback-blocked')).toBe(
      "Couldn't turn on free daily AI Credits. Try again.",
    );
    expect(text('model-recovery-guest-fallback')).toBe(ACTION);
    expect(button('model-recovery-guest-fallback')?.disabled).toBe(false);
    expect(onUseGuestFallback).not.toHaveBeenCalled();

    saveCloudDailyCreditDrip.mockImplementationOnce(() => {
      loadNativeAiCreditsAvailability.mockResolvedValue(funded);
      return Promise.resolve(savedDrip);
    });
    press('model-recovery-guest-fallback');
    await settle();

    expect(saveCloudDailyCreditDrip).toHaveBeenCalledTimes(2);
    expect(onUseGuestFallback).toHaveBeenCalledTimes(1);
  });

  it('reads the preference before treating a rejected save as failed', async () => {
    // The write landed, but its answer did not.
    saveCloudDailyCreditDrip.mockImplementationOnce(() => {
      loadNativeAiCreditsAvailability.mockResolvedValue(funded);
      return Promise.reject(new Error('timeout'));
    });
    const onUseGuestFallback = jest.fn(
      (): Promise<GuestFallbackOutcome> =>
        Promise.resolve({ kind: 'committed' }),
    );
    await renderGate({ onUseGuestFallback });

    press('model-recovery-guest-fallback');
    await settle();

    expect(saveCloudDailyCreditDrip).toHaveBeenCalledTimes(1);
    expect(onUseGuestFallback).toHaveBeenCalledTimes(1);
  });

  it('does not write again after an unconfirmed save until a read settles it', async () => {
    saveCloudDailyCreditDrip.mockImplementationOnce(() => {
      loadNativeAiCreditsAvailability.mockResolvedValue(null);
      loadCloudDailyCreditDrip.mockResolvedValue({
        available: true,
        resolved: false,
      });
      return Promise.reject(new Error('timeout'));
    });
    const onUseGuestFallback = jest.fn();
    await renderGate({ onUseGuestFallback });

    press('model-recovery-guest-fallback');
    await settle();
    expect(text('model-recovery-fallback-blocked')).toBe(
      "Couldn't confirm whether free daily AI Credits are on. Check again.",
    );

    // Still unreadable: the retry reads, and does not write.
    press('model-recovery-guest-fallback-recheck');
    await settle();
    expect(saveCloudDailyCreditDrip).toHaveBeenCalledTimes(1);

    // The read now proves the first write landed.
    loadNativeAiCreditsAvailability.mockResolvedValue(funded);
    loadCloudDailyCreditDrip.mockResolvedValue({
      available: true,
      resolved: true,
      preference: { enabled: true, capCredits: 10, decidedAt: null },
    });
    onUseGuestFallback.mockResolvedValue({ kind: 'committed' });
    press('model-recovery-guest-fallback-recheck');
    await settle();
    expect(saveCloudDailyCreditDrip).toHaveBeenCalledTimes(1);
    expect(onUseGuestFallback).toHaveBeenCalledTimes(1);
  });

  it('offers a check that never writes when the balance read fails after saving', async () => {
    saveCloudDailyCreditDrip.mockImplementation(() => {
      loadNativeAiCreditsAvailability.mockResolvedValue({
        ...funded,
        inconclusive: true,
      });
      return Promise.resolve(savedDrip);
    });
    const onUseGuestFallback = jest.fn(
      (): Promise<GuestFallbackOutcome> =>
        Promise.resolve({ kind: 'committed' }),
    );
    await renderGate({ onUseGuestFallback });

    press('model-recovery-guest-fallback');
    await settle();

    expect(text('model-recovery-fallback-blocked')).toBe(
      "Free daily AI Credits are on, but we couldn't check your balance. Try again.",
    );
    expect(button('model-recovery-guest-fallback')).toBeNull();
    expect(text('model-recovery-guest-fallback-recheck')).toBe('Check again');
    expect(onUseGuestFallback).not.toHaveBeenCalled();

    loadNativeAiCreditsAvailability.mockResolvedValue(funded);
    press('model-recovery-guest-fallback-recheck');
    await settle();

    expect(saveCloudDailyCreditDrip).toHaveBeenCalledTimes(1);
    expect(onUseGuestFallback).toHaveBeenCalledTimes(1);
  });

  it('says so, and selects nothing, when saving left no spendable credits', async () => {
    saveCloudDailyCreditDrip.mockImplementation(() => {
      loadNativeAiCreditsAvailability.mockResolvedValue({
        ...declined,
        dailyDripEnabled: true,
      });
      return Promise.resolve({ ...savedDrip, balanceCredits: 0, granted: 0 });
    });
    const onUseGuestFallback = jest.fn();
    await renderGate({ onUseGuestFallback });

    press('model-recovery-guest-fallback');
    await settle();

    expect(text('model-recovery-fallback-status')).toBe(
      'Free daily AI Credits are on, but no credits are available right now.',
    );
    expect(
      document
        .querySelector('[data-testid="model-recovery-fallback-status"]')
        ?.getAttribute('role'),
    ).toBe('status');
    expect(button('model-recovery-guest-fallback')).toBeNull();
    expect(button('model-recovery-guest-fallback-recheck')).toBeNull();
    expect(text('model-recovery-needs-account')).not.toContain('As a guest');
    expect(document.body.textContent).not.toContain('tomorrow');
    expect(button('model-recovery-account-sign-in')?.disabled).toBe(false);
    expect(onUseGuestFallback).not.toHaveBeenCalled();
    expect(saveCloudDailyCreditDrip).toHaveBeenCalledTimes(1);
  });

  it('shows a refusal after saving, and its retry only re-checks', async () => {
    saveCloudDailyCreditDrip.mockImplementation(() => {
      loadNativeAiCreditsAvailability.mockResolvedValue(funded);
      return Promise.resolve(savedDrip);
    });
    const onUseGuestFallback = jest
      .fn<
        Promise<GuestFallbackOutcome>,
        [typeof FALLBACK | { readonly access: 'now' }]
      >()
      .mockResolvedValueOnce({
        kind: 'blocked',
        reason: 'Stop the current turn, then switch.',
      })
      .mockResolvedValueOnce({ kind: 'committed' });
    await renderGate({ onUseGuestFallback });

    press('model-recovery-guest-fallback');
    await settle();

    expect(text('model-recovery-fallback-blocked')).toBe(
      'Stop the current turn, then switch.',
    );
    expect(button('model-recovery-guest-fallback')).toBeNull();
    press('model-recovery-guest-fallback-recheck');
    await settle();

    expect(saveCloudDailyCreditDrip).toHaveBeenCalledTimes(1);
    expect(onUseGuestFallback).toHaveBeenCalledTimes(2);
  });

  it('hands a redirect to the host without an error or a second save', async () => {
    saveCloudDailyCreditDrip.mockImplementation(() => {
      loadNativeAiCreditsAvailability.mockResolvedValue(funded);
      return Promise.resolve(savedDrip);
    });
    const onUseGuestFallback = jest.fn(
      (): Promise<GuestFallbackOutcome> =>
        Promise.resolve({ kind: 'redirected' }),
    );
    await renderGate({ onUseGuestFallback });

    press('model-recovery-guest-fallback');
    await settle();

    expect(onUseGuestFallback).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-testid="model-recovery-fallback-blocked"]'),
    ).toBeNull();
    expect(saveCloudDailyCreditDrip).toHaveBeenCalledTimes(1);
  });

  it('replaces stale controls with checking throughout a deferred redirect', async () => {
    // The picker keys by attempt; exercise the modal's own recovery identity
    // too, with a fresh read deliberately held after the host redirects.
    const refreshed = deferred<typeof funded>();
    const onCommit = jest.fn();
    saveCloudDailyCreditDrip.mockImplementation(() => {
      loadNativeAiCreditsAvailability.mockResolvedValue(funded);
      return Promise.resolve(savedDrip);
    });
    const onUseGuestFallback = jest.fn((): Promise<GuestFallbackOutcome> => {
      loadNativeAiCreditsAvailability.mockReturnValue(refreshed.promise);
      invalidateSharedAiCreditsRead();
      root?.render(
        createElement(ModelRecoveryModal, {
          pending: {
            model: FALLBACK.model,
            recovery: { kind: 'needs-billing-source', provider: 'claude' },
          },
          onCommit,
          onCancel: jest.fn(),
        }),
      );
      return Promise.resolve({ kind: 'redirected' });
    });
    // Give Haiku a real native route for the redirected coverage commit.
    initClaudeModels([
      { id: MODEL, label: 'Sonnet' },
      { id: FALLBACK.model, label: FALLBACK.label },
    ]);
    initAiGatewayModels(
      [],
      [
        {
          family: 'claude',
          modelId: FALLBACK.model,
          gatewayId: FALLBACK.gatewayId,
          gatewayOnly: false,
          recommendedHarness: 'claude',
          contextWindow: 100000,
          supportsPromptCaching: true,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
    );
    try {
      await renderGate({ onUseGuestFallback });
      press('model-recovery-guest-fallback');
      await settle();
      expect(text('model-recovery-checking')).toContain('Checking');
      expect(button('model-recovery-guest-fallback')).toBeNull();
      expect(button('model-recovery-daily-drip')).toBeNull();
      expect(onCommit).not.toHaveBeenCalled();
      await act(async () => {
        refreshed.resolve(funded);
        await refreshed.promise;
      });
      await settle();
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith(FALLBACK.model);
      expect(saveCloudDailyCreditDrip).toHaveBeenCalledTimes(1);
    } finally {
      restoreGatewayRoutes();
    }
  });

  it('ignores a deferred save when the originating scope changes', async () => {
    const save = deferred<unknown>();
    saveCloudDailyCreditDrip.mockReturnValue(save.promise);
    const oldSelection = jest.fn();
    await renderGate({ onUseGuestFallback: oldSelection });
    press('model-recovery-guest-fallback');
    await settle();
    const nextRead = deferred<typeof declined>();
    loadNativeAiCreditsAvailability.mockReturnValue(nextRead.promise);
    const newSelection = jest.fn();
    act(() => {
      root?.render(
        createElement(ModelRecoveryModal, {
          pending: {
            model: MODEL,
            recovery: { kind: 'needs-account' },
            guestFallback: FALLBACK,
          },
          aiCreditsScope: {
            kind: 'work',
            projectId: 'another-project',
            chatId: 'another-chat',
          },
          onUseGuestFallback: newSelection,
          onCommit: jest.fn(),
          onCancel: jest.fn(),
        }),
      );
    });
    expect(text('model-recovery-checking')).toContain('Checking');
    expect(button('model-recovery-guest-fallback')).toBeNull();
    await act(async () => {
      save.resolve(savedDrip);
      nextRead.resolve(declined);
      await nextRead.promise;
    });
    await settle();
    expect(oldSelection).not.toHaveBeenCalled();
    expect(newSelection).not.toHaveBeenCalled();
    // The completed old save invalidates shared caches. Re-check the new
    // scope if that invalidation fenced its first pending balance read.
    press('model-recovery-try-again');
    await settle();
    expect(button('model-recovery-guest-fallback')?.disabled).toBe(false);
  });

  it('selects nothing when the modal closes during the save', async () => {
    const save = deferred<unknown>();
    saveCloudDailyCreditDrip.mockReturnValue(save.promise);
    const onUseGuestFallback = jest.fn();
    await renderGate({ onUseGuestFallback });

    press('model-recovery-guest-fallback');
    act(() => {
      root?.unmount();
      root = null;
    });
    loadNativeAiCreditsAvailability.mockResolvedValue(funded);
    await act(async () => {
      save.resolve(savedDrip);
      await save.promise;
    });
    await settle();

    expect(onUseGuestFallback).not.toHaveBeenCalled();
  });
});

/**
 * CAN-4028 — the purchase that unlocks advanced models.
 *
 * The non-obvious part mirrors the guest gate above: a signed-in non-payer is
 * normally FUNDED by the daily free credits, so `canSpendCredits` is true for
 * exactly the account this lock exists for. Coverage must not clear it.
 */
describe('ModelRecoveryModal — purchase unlock (CAN-4028)', () => {
  const ACCOUNT_KEY = 'account:acct_1';
  const loadCanopyCloudEntitlements = jest.fn();
  const funded = { ...uncovered, personalEligible: true, inOrg: false };

  function serverSays(access: string, status = 'reported'): void {
    loadCanopyCloudEntitlements.mockResolvedValue({
      resolved: true,
      modelLibrary: { status, access },
      modelLibraryAccountKey: ACCOUNT_KEY,
      workModelLibrary: { status, access },
      modelLibraryOwnerKey: 'personal',
    });
  }

  function query(testId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 12; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  async function click(testId: string): Promise<void> {
    act(() => {
      query(testId)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
  }

  async function renderUnlock(
    recovery: ModelRecovery,
    props: {
      onCommit?: jest.Mock;
      onUnlockPurchase?: (
        onResumed?: (result: UnlockModelsResult) => void,
      ) => Promise<UnlockModelsResult>;
      model?: ChatModel;
    } = {},
  ): Promise<void> {
    root = createRoot(document.body);
    act(() => {
      root?.render(
        createElement(ModelRecoveryModal, {
          pending: { model: props.model ?? MODEL, recovery },
          onCommit: props.onCommit ?? jest.fn(),
          onCancel: jest.fn(),
          ...(props.onUnlockPurchase
            ? { onUnlockPurchase: props.onUnlockPurchase }
            : {}),
        }),
      );
    });
    await settle();
  }

  /** The fixture model's display label, written out rather than derived. */
  const MODEL_LABEL = 'Sonnet';
  const PURCHASE_BODY = `Free daily credits don't unlock advanced models. Purchase some AI Credits (minimum $${BILLING_TOP_UP_MIN_USD}) to unlock Sonnet, Opus, Fable and more. We'll switch to your selected model once the purchase is complete.`;

  /** Stand in for the host having opened checkout and begun following it. */
  function hostOpensCheckout(requestId = 'req-1'): jest.Mock {
    return jest.fn((): Promise<UnlockModelsResult> => {
      beginModelUnlockIntent({
        requestId,
        accountId: ACCOUNT_KEY,
        owner: 'personal',
        chatId: null,
        modelId: MODEL,
        startedAt: Date.now(),
      });
      return Promise.resolve({ outcome: 'opened', requestId });
    });
  }

  beforeEach(() => {
    resetModelLibraryAccessForTests();
    resetModelUnlockIntentForTests();
    serverSays('needs_purchase');
    loadNativeAiCreditsAvailability.mockResolvedValue(funded);
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    Object.assign(window.api, { loadCanopyCloudEntitlements });
  });

  it.each([true, false])(
    'routes a real purchase activation through strict payment handoff (ok=%s)',
    async (ok) => {
      const paymentHandoff = jest
        .fn()
        .mockResolvedValue(
          ok
            ? { ok: true, requestId: '11111111-1111-4111-8111-111111111111' }
            : { ok: false, reason: 'unavailable' },
        );
      Object.assign(window.api, {
        accountOrganizationSettings: { paymentHandoff },
      });
      const onCommit = jest.fn();
      await renderUnlock({ kind: 'needs-purchase' }, { onCommit });
      await click('model-recovery-unlock-purchase');
      expect(paymentHandoff).toHaveBeenCalledWith({
        accountId: 'acct_1',
        owner: { kind: 'personal' },
        intent: {
          kind: 'top-up',
          reason: 'unlock_models',
          source: 'desktop',
          modelId: MODEL,
        },
      });
      expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
      if (ok) {
        expect(query('model-recovery-unlock-waiting')).not.toBeNull();
        expect(useModelUnlockIntentStore.getState().intent?.requestId).toBe(
          '11111111-1111-4111-8111-111111111111',
        );
      } else {
        expect(query('model-recovery-unlock-waiting')).toBeNull();
        expect(text('model-recovery-unlock-failed')).toContain(
          'couldn’t open your browser',
        );
        expect(query('model-recovery-unlock-purchase')).not.toBeNull();
        expect(useModelUnlockIntentStore.getState().intent).toBeNull();
      }
      expect(onCommit).not.toHaveBeenCalled();
    },
  );

  it('asks for the purchase with the shared copy and never commits on coverage', async () => {
    const onCommit = jest.fn();
    await renderUnlock({ kind: 'needs-purchase' }, { onCommit });

    // Named for the model being unlocked, which the user just clicked.
    expect(heading()).toBe(`Unlock ${MODEL_LABEL}`);
    expect(text('model-recovery-unlock')).toBe(PURCHASE_BODY);
    expect(text('model-recovery-unlock-purchase')).toBe('Get AI Credits');
    expect(text('model-recovery-cancel')).toBeNull();
    // Funded by daily credits, and still not committed.
    expect(onCommit).not.toHaveBeenCalled();
    // Nor offered the credits flow, which would call spendable credits a fix.
    expect(query('model-recovery-get-credits')).toBeNull();
    expect(query('model-recovery-turn-on-daily-credits')).toBeNull();
  });

  it('holds the lock when the access re-read fails', async () => {
    // A blip is not evidence the lock lifted.
    loadCanopyCloudEntitlements.mockRejectedValue(new Error('offline'));
    const onCommit = jest.fn();
    await renderUnlock({ kind: 'needs-purchase' }, { onCommit });

    expect(query('model-recovery-unlock')).not.toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits through the ordinary path when the account turns out to be unlocked', async () => {
    serverSays('unlocked');
    const onCommit = jest.fn();
    await renderUnlock({ kind: 'needs-purchase' }, { onCommit });

    expect(query('model-recovery-unlock')).toBeNull();
    expect(onCommit).toHaveBeenCalledWith(MODEL);
  });

  it('says to finish in the browser once checkout opens, and offers a re-check', async () => {
    const onUnlockPurchase = hostOpensCheckout();
    const onCommit = jest.fn();
    await renderUnlock(
      { kind: 'needs-purchase' },
      { onCommit, onUnlockPurchase },
    );
    await click('model-recovery-unlock-purchase');

    expect(onUnlockPurchase).toHaveBeenCalledTimes(1);
    expect(text('model-recovery-unlock-waiting')).toBe(
      "Finish checkout in your browser. Closing this dialog won't cancel your purchase. We'll switch to Sonnet in the chat where you started the purchase once the payment goes through.",
    );
    expect(text('model-recovery-unlock-check-now')).toBe('Check again');
    expect(text('model-recovery-cancel')).toBeNull();
    // Opening checkout is not a commit.
    expect(onCommit).not.toHaveBeenCalled();

    const announced = jest.fn();
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, announced);
    try {
      serverSays('unlocked');
      await click('model-recovery-unlock-check-now');
      expect(useModelUnlockIntentStore.getState().phase).toBe('unlocked');
      expect(announced).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, announced);
    }
  });

  it('offers Check now and an explicit new purchase after the poll times out, without calling it a failure', async () => {
    const onUnlockPurchase = hostOpensCheckout();
    await renderUnlock({ kind: 'needs-purchase' }, { onUnlockPurchase });
    await click('model-recovery-unlock-purchase');

    act(() => {
      useModelUnlockIntentStore.setState({ phase: 'timed-out' });
    });

    expect(text('model-recovery-modal')).toContain(
      'Automatic payment checks have stopped',
    );
    const copy = text('model-recovery-unlock-timed-out') ?? '';
    expect(copy).toContain(
      "Your purchase may still be in progress. Check again once it's complete.",
    );
    expect(copy).toContain(
      "Starting a new purchase won't cancel the previous one.",
    );
    expect(copy.toLowerCase()).not.toContain('fail');
    expect(text('model-recovery-unlock-check-now')).toBe('Check again');
    expect(text('model-recovery-unlock-new-purchase')).toBe(
      'Start a new purchase',
    );
    expect(text('model-recovery-cancel')).toBeNull();

    onUnlockPurchase.mockImplementationOnce((): Promise<UnlockModelsResult> => {
      beginModelUnlockIntent({
        requestId: 'req-2',
        accountId: ACCOUNT_KEY,
        owner: 'personal',
        chatId: null,
        modelId: MODEL,
        startedAt: Date.now(),
      });
      return Promise.resolve({ outcome: 'opened', requestId: 'req-2' });
    });
    await click('model-recovery-unlock-new-purchase');
    expect(onUnlockPurchase).toHaveBeenCalledTimes(2);
    expect(useModelUnlockIntentStore.getState().intent?.requestId).toBe(
      'req-2',
    );
    expect(query('model-recovery-unlock-waiting')).not.toBeNull();
    expect(query('model-recovery-unlock-new-purchase')).toBeNull();
  });

  it('offers "Use {model}" only when the confirmed unlock could not be applied', async () => {
    const onUnlockPurchase = hostOpensCheckout();
    await renderUnlock({ kind: 'needs-purchase' }, { onUnlockPurchase });
    await click('model-recovery-unlock-purchase');
    const useModel = `Use ${getModelDisplayName(MODEL)}`;
    expect(text('model-recovery-modal')).not.toContain(useModel);

    act(() => {
      useModelUnlockIntentStore.setState({ phase: 'unlocked' });
    });
    // Confirmed with nothing left to apply: no second action is demanded.
    expect(text('model-recovery-unlock-confirmed')).toBe(
      'Advanced models are unlocked.',
    );
    expect(text('model-recovery-modal')).not.toContain(useModel);

    act(() => {
      useModelUnlockIntentStore.setState({ phase: 'apply-failed' });
    });
    expect(text('model-recovery-unlock-apply-failed')).toContain(
      'Advanced models are unlocked.',
    );
    expect(text('model-recovery-unlock-use-model')).toBe(useModel);
  });

  it('does not narrate another attempt’s progress as its own', async () => {
    const onUnlockPurchase = hostOpensCheckout('req-1');
    await renderUnlock({ kind: 'needs-purchase' }, { onUnlockPurchase });
    await click('model-recovery-unlock-purchase');

    // A newer purchase elsewhere replaces the pending intent and completes.
    act(() => {
      beginModelUnlockIntent({
        requestId: 'req-other',
        accountId: ACCOUNT_KEY,
        owner: 'personal',
        chatId: 'another-chat',
        modelId: 'another-model',
        startedAt: Date.now(),
      });
      useModelUnlockIntentStore.setState({ phase: 'apply-failed' });
    });
    expect(query('model-recovery-unlock-use-model')).toBeNull();
    expect(query('model-recovery-unlock-waiting')).not.toBeNull();
  });

  it('shows the contact-admin copy for work the user cannot fund', async () => {
    await renderUnlock(
      { kind: 'needs-purchase' },
      {
        onUnlockPurchase: jest
          .fn()
          .mockResolvedValue({ outcome: 'contact-admin' }),
      },
    );
    await click('model-recovery-unlock-purchase');

    expect(text('model-recovery-unlock-contact-admin')).toBe(
      CONTACT_ORG_ADMIN_COPY,
    );
    expect(query('model-recovery-unlock-purchase')).toBeNull();
  });

  it('keeps the purchase button when no browser page opened', async () => {
    await renderUnlock(
      { kind: 'needs-purchase' },
      { onUnlockPurchase: jest.fn().mockResolvedValue({ outcome: 'failed' }) },
    );
    await click('model-recovery-unlock-purchase');

    expect(query('model-recovery-unlock-failed')).not.toBeNull();
    expect(query('model-recovery-unlock-waiting')).toBeNull();
    expect(
      query('model-recovery-unlock-purchase')?.hasAttribute('disabled'),
    ).toBe(false);
  });

  it('keeps the named title through every purchase state', async () => {
    const onUnlockPurchase = jest
      .fn()
      .mockResolvedValueOnce({ outcome: 'failed' })
      .mockImplementation(hostOpensCheckout());
    await renderUnlock({ kind: 'needs-purchase' }, { onUnlockPurchase });
    const title = `Unlock ${MODEL_LABEL}`;
    expect(heading()).toBe(title);

    await click('model-recovery-unlock-purchase');
    expect(query('model-recovery-unlock-failed')).not.toBeNull();
    expect(heading()).toBe(title);

    await click('model-recovery-unlock-purchase');
    expect(query('model-recovery-unlock-waiting')).not.toBeNull();
    expect(heading()).toBe(title);

    for (const [phase, testId] of [
      ['timed-out', 'model-recovery-unlock-timed-out'],
      ['applying', 'model-recovery-unlock-confirmed'],
      ['unlocked', 'model-recovery-unlock-confirmed'],
      ['apply-failed', 'model-recovery-unlock-apply-failed'],
    ] as const) {
      act(() => {
        useModelUnlockIntentStore.setState({ phase });
      });
      expect(query(testId)).not.toBeNull();
      expect(heading()).toBe(title);
    }
  });

  it('keeps the named title on the contact-admin state', async () => {
    await renderUnlock(
      { kind: 'needs-purchase' },
      {
        onUnlockPurchase: jest
          .fn()
          .mockResolvedValue({ outcome: 'contact-admin' }),
      },
    );
    await click('model-recovery-unlock-purchase');

    expect(query('model-recovery-unlock-contact-admin')).not.toBeNull();
    expect(heading()).toBe(`Unlock ${MODEL_LABEL}`);
  });

  describe('resuming a pending purchase (CAN-5030)', () => {
    function pendingIntent(
      requestId: string,
      overrides: { chatId?: string | null; modelId?: string | null } = {},
    ): void {
      beginModelUnlockIntent({
        requestId,
        accountId: ACCOUNT_KEY,
        owner: 'personal',
        chatId: overrides.chatId === undefined ? 'chat-a' : overrides.chatId,
        modelId: overrides.modelId === undefined ? MODEL : overrides.modelId,
        startedAt: Date.now(),
      });
    }

    it('resumes a waiting purchase instead of offering another', async () => {
      pendingIntent('req-1');
      const onUnlockPurchase = hostOpensCheckout('req-2');
      await renderUnlock({ kind: 'needs-purchase' }, { onUnlockPurchase });

      expect(query('model-recovery-unlock-purchase')).toBeNull();
      expect(text('model-recovery-unlock-waiting')).toContain(
        "Closing this dialog won't cancel your purchase. We'll switch to Sonnet",
      );
      expect(text('model-recovery-unlock-check-now')).toBe('Check again');
      expect(query('model-recovery-unlock-new-purchase')).toBeNull();
      expect(onUnlockPurchase).not.toHaveBeenCalled();
      expect(useModelUnlockIntentStore.getState().intent?.requestId).toBe(
        'req-1',
      );
    });

    it('narrates the original model when opened from a different row', async () => {
      pendingIntent('req-1', { chatId: 'other-chat' });
      const onUnlockPurchase = hostOpensCheckout('req-2');
      await renderUnlock(
        { kind: 'needs-purchase' },
        { onUnlockPurchase, model: NATIVE_ONLY_MODEL },
      );

      const copy = text('model-recovery-unlock-waiting') ?? '';
      expect(copy).toContain(
        "We'll switch to Sonnet in the chat where you started the purchase",
      );
      expect(copy).not.toContain('Codex Spark');
      expect(heading()).toBe(`Unlock ${MODEL_LABEL}`);
      expect(onUnlockPurchase).not.toHaveBeenCalled();
      // The original bindings are untouched.
      expect(useModelUnlockIntentStore.getState().intent).toMatchObject({
        requestId: 'req-1',
        chatId: 'other-chat',
        modelId: MODEL,
      });
    });

    it.each([null, 'not-a-registered-model'])(
      'uses the generic unlock for a %s model',
      async (modelId) => {
        pendingIntent('req-1', { modelId });
        await renderUnlock({ kind: 'needs-purchase' });

        const copy = text('model-recovery-unlock-waiting') ?? '';
        expect(copy).toContain(
          "We'll unlock advanced models once the payment goes through.",
        );
        expect(copy).not.toContain('not-a-registered-model');
        expect(heading()).toBe('Unlock advanced models');
      },
    );

    it('resumes a timed-out purchase with an explicit new purchase', async () => {
      pendingIntent('req-1');
      act(() => {
        useModelUnlockIntentStore.setState({ phase: 'timed-out' });
      });
      const onUnlockPurchase = hostOpensCheckout('req-2');
      await renderUnlock({ kind: 'needs-purchase' }, { onUnlockPurchase });

      expect(query('model-recovery-unlock-purchase')).toBeNull();
      expect(query('model-recovery-unlock-timed-out')).not.toBeNull();
      expect(heading()).toBe(`Unlock ${MODEL_LABEL}`);
      expect(text('model-recovery-unlock-timed-out')).toContain(
        'Automatic payment checks have stopped',
      );
      expect(text('model-recovery-unlock-new-purchase')).toBe(
        'Start a new purchase',
      );
      expect(onUnlockPurchase).not.toHaveBeenCalled();
    });

    it('adopts a purchase that starts while the modal is open', async () => {
      const onUnlockPurchase = hostOpensCheckout('req-2');
      await renderUnlock({ kind: 'needs-purchase' }, { onUnlockPurchase });
      expect(query('model-recovery-unlock-purchase')).not.toBeNull();

      act(() => pendingIntent('req-1'));

      expect(query('model-recovery-unlock-purchase')).toBeNull();
      expect(query('model-recovery-unlock-waiting')).not.toBeNull();
    });

    it('adopts a replacement purchase rather than a stale or fresh one', async () => {
      pendingIntent('req-1');
      await renderUnlock({ kind: 'needs-purchase' });

      act(() => pendingIntent('req-3', { modelId: null }));

      expect(query('model-recovery-unlock-purchase')).toBeNull();
      expect(text('model-recovery-unlock-waiting')).toContain(
        "We'll unlock advanced models",
      );
    });

    it('returns to the ordinary purchase once the adopted purchase is cleared', async () => {
      pendingIntent('req-1');
      await renderUnlock({ kind: 'needs-purchase' });
      expect(query('model-recovery-unlock-waiting')).not.toBeNull();

      act(() => clearModelUnlockIntent('req-1'));
      await settle();

      expect(query('model-recovery-unlock-waiting')).toBeNull();
      expect(text('model-recovery-unlock-purchase')).toBe('Get AI Credits');
    });

    it('keeps an adopted purchase through its confirmation', async () => {
      pendingIntent('req-1');
      await renderUnlock({ kind: 'needs-purchase' });

      act(() => {
        useModelUnlockIntentStore.setState({ phase: 'applying' });
      });
      expect(text('model-recovery-unlock-confirmed')).toBe(
        'Advanced models are unlocked.',
      );
      act(() => {
        useModelUnlockIntentStore.setState({ phase: 'apply-failed' });
      });
      expect(text('model-recovery-unlock-use-model')).toBe('Use Sonnet');
      expect(query('model-recovery-unlock-purchase')).toBeNull();
    });

    it('never opens checkout from a stale purchase button', async () => {
      const onUnlockPurchase = hostOpensCheckout('req-2');
      await renderUnlock({ kind: 'needs-purchase' }, { onUnlockPurchase });
      const button = query('model-recovery-unlock-purchase');
      expect(button).not.toBeNull();

      // The purchase starts elsewhere and the click lands before a repaint.
      act(() => {
        pendingIntent('req-1');
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await settle();

      expect(onUnlockPurchase).not.toHaveBeenCalled();
      expect(query('model-recovery-unlock-waiting')).not.toBeNull();
    });

    it('never starts a new purchase from a stale timed-out button', async () => {
      pendingIntent('req-1');
      act(() => {
        useModelUnlockIntentStore.setState({ phase: 'timed-out' });
      });
      const onUnlockPurchase = hostOpensCheckout('req-2');
      await renderUnlock({ kind: 'needs-purchase' }, { onUnlockPurchase });
      const button = query('model-recovery-unlock-new-purchase');

      // A newer purchase replaces the timed-out one before the click lands.
      act(() => {
        pendingIntent('req-3');
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await settle();

      expect(onUnlockPurchase).not.toHaveBeenCalled();
      expect(useModelUnlockIntentStore.getState().intent?.requestId).toBe(
        'req-3',
      );
      expect(query('model-recovery-unlock-waiting')).not.toBeNull();
    });

    it('keeps following the earlier purchase when a new one fails to open', async () => {
      pendingIntent('req-1');
      act(() => {
        useModelUnlockIntentStore.setState({ phase: 'timed-out' });
      });
      const onUnlockPurchase = jest
        .fn()
        .mockResolvedValue({ outcome: 'failed' });
      await renderUnlock({ kind: 'needs-purchase' }, { onUnlockPurchase });

      await click('model-recovery-unlock-new-purchase');

      expect(onUnlockPurchase).toHaveBeenCalledTimes(1);
      expect(text('model-recovery-unlock-failed')).toContain(
        'couldn’t open your browser',
      );
      expect(query('model-recovery-unlock-timed-out')).not.toBeNull();
      expect(useModelUnlockIntentStore.getState()).toMatchObject({
        phase: 'timed-out',
        intent: { requestId: 'req-1' },
      });
      expect(
        query('model-recovery-unlock-new-purchase')?.hasAttribute('disabled'),
      ).toBe(false);
    });

    it('disables Start a new purchase while it opens', async () => {
      pendingIntent('req-1');
      act(() => {
        useModelUnlockIntentStore.setState({ phase: 'timed-out' });
      });
      let finish: ((result: UnlockModelsResult) => void) | undefined;
      const onUnlockPurchase = jest.fn(
        () =>
          new Promise<UnlockModelsResult>((resolve) => {
            finish = resolve;
          }),
      );
      await renderUnlock({ kind: 'needs-purchase' }, { onUnlockPurchase });

      await click('model-recovery-unlock-new-purchase');
      await click('model-recovery-unlock-new-purchase');

      expect(onUnlockPurchase).toHaveBeenCalledTimes(1);
      expect(
        query('model-recovery-unlock-new-purchase')?.hasAttribute('disabled'),
      ).toBe(true);
      expect(
        query('model-recovery-unlock-new-purchase-spinner'),
      ).not.toBeNull();
      act(() => finish?.({ outcome: 'failed' }));
      await settle();
    });

    it.each(['applying', 'unlocked', 'apply-failed'] as const)(
      'keeps the original %s request when a replacement checkout fails',
      async (phase) => {
        pendingIntent('req-1');
        act(() => useModelUnlockIntentStore.setState({ phase: 'timed-out' }));
        let finish: ((result: UnlockModelsResult) => void) | undefined;
        const onUnlockPurchase = jest.fn(
          () =>
            new Promise<UnlockModelsResult>((resolve) => {
              finish = resolve;
            }),
        );
        await renderUnlock({ kind: 'needs-purchase' }, { onUnlockPurchase });
        await click('model-recovery-unlock-new-purchase');

        act(() => useModelUnlockIntentStore.setState({ phase }));
        expect(query('model-recovery-unlock-purchase')).toBeNull();
        act(() => finish?.({ outcome: 'failed' }));
        await settle();

        expect(onUnlockPurchase).toHaveBeenCalledTimes(1);
        expect(query('model-recovery-unlock-purchase')).toBeNull();
        expect(
          query(
            phase === 'apply-failed'
              ? 'model-recovery-unlock-use-model'
              : 'model-recovery-unlock-confirmed',
          ),
        ).not.toBeNull();
        expect(useModelUnlockIntentStore.getState()).toMatchObject({
          phase,
          intent: { requestId: 'req-1' },
        });
      },
    );

    it('keeps an untracked purchase on the waiting copy without Check now', async () => {
      // An organization-owned checkout opens, but cannot be followed.
      const onUnlockPurchase = jest
        .fn()
        .mockResolvedValue({ outcome: 'opened' });
      await renderUnlock({ kind: 'needs-purchase' }, { onUnlockPurchase });
      await click('model-recovery-unlock-purchase');

      expect(text('model-recovery-unlock-waiting')).toBe(
        "Finish checkout in your browser. Closing this dialog won't cancel your purchase. We'll unlock advanced models once the payment goes through.",
      );
      expect(query('model-recovery-unlock-check-now')).toBeNull();
      expect(text('model-recovery-cancel')).toBeNull();
    });
  });

  describe('guest who will also need a purchase', () => {
    function stubFundedGuest(): void {
      loadCanopyCloudAccount.mockResolvedValue(null);
    }

    it('says so up front with the shared guest copy', async () => {
      stubFundedGuest();
      const onCommit = jest.fn();
      await renderUnlock(
        { kind: 'needs-account', access: 'needs_sign_in_then_purchase' },
        { onCommit },
      );

      // The guest gate keeps its generic title.
      expect(heading()).toBe('Unlock advanced models');
      expect(text('model-recovery-needs-account')).toMatch(
        /^Using .+ requires an? .+ account and a purchase of AI Credits\.$/,
      );
      expect(text('model-recovery-account-sign-in')).toBe('Get AI Credits');
      // The signed-in purchase branch is not shown to a guest, who cannot buy.
      expect(query('model-recovery-unlock-purchase')).toBeNull();
      expect(onCommit).not.toHaveBeenCalled();
    });

    it('signs in through the unlock action, then opens checkout without a second ask', async () => {
      stubFundedGuest();
      const onCommit = jest.fn();
      let resume: ((result: UnlockModelsResult) => void) | undefined;
      const onUnlockPurchase = jest.fn(
        (onResumed?: (result: UnlockModelsResult) => void) => {
          resume = onResumed;
          act(() => {
            useCloudConnectGateStore.setState({
              pending: { context: {}, proceed: (): void => {} },
            });
          });
          return Promise.resolve<UnlockModelsResult>({ outcome: 'sign-in' });
        },
      );
      await renderUnlock(
        { kind: 'needs-account', access: 'needs_sign_in_then_purchase' },
        { onCommit, onUnlockPurchase },
      );

      await click('model-recovery-account-sign-in');
      expect(onUnlockPurchase).toHaveBeenCalledTimes(1);

      // Signed in; the unlock action opens checkout straight away.
      loadCanopyCloudAccount.mockResolvedValue(account([]));
      invalidateSharedAiCreditsRead();
      beginModelUnlockIntent({
        requestId: 'req-1',
        accountId: ACCOUNT_KEY,
        owner: 'personal',
        chatId: null,
        modelId: MODEL,
        startedAt: Date.now(),
      });
      act(() => {
        resume?.({ outcome: 'opened', requestId: 'req-1' });
        useCloudConnectGateStore.setState({ pending: null });
      });
      await settle();

      expect(query('model-recovery-unlock-purchase')).toBeNull();
      expect(text('model-recovery-unlock-waiting')).toBe(
        "Finish checkout in your browser. Closing this dialog won't cancel your purchase. We'll switch to Sonnet in the chat where you started the purchase once the payment goes through.",
      );
      expect(onCommit).not.toHaveBeenCalled();
    });

    it('advances straight to the purchase after sign-in, without committing', async () => {
      stubFundedGuest();
      const onCommit = jest.fn();
      await renderUnlock(
        { kind: 'needs-account', access: 'needs_sign_in_then_purchase' },
        { onCommit },
      );

      // The shared gate opens, the guest signs in, and the gate closes.
      act(() => {
        useCloudConnectGateStore.setState({
          pending: { context: {}, proceed: (): void => {} },
        });
      });
      loadCanopyCloudAccount.mockResolvedValue(account([]));
      invalidateSharedAiCreditsRead();
      act(() => {
        useCloudConnectGateStore.setState({ pending: null });
      });
      await settle();

      expect(query('model-recovery-needs-account')).toBeNull();
      expect(heading()).toBe(`Unlock ${MODEL_LABEL}`);
      expect(text('model-recovery-unlock')).toBe(PURCHASE_BODY);
      // Funded by the new account's daily credits, and still not committed.
      expect(onCommit).not.toHaveBeenCalled();
    });

    it('applies the pending model after sign-in when the account is already unlocked', async () => {
      stubFundedGuest();
      const onCommit = jest.fn();
      await renderUnlock(
        { kind: 'needs-account', access: 'needs_sign_in_then_purchase' },
        { onCommit },
      );

      act(() => {
        useCloudConnectGateStore.setState({
          pending: { context: {}, proceed: (): void => {} },
        });
      });
      // Signing in joined an account that already qualifies.
      loadCanopyCloudAccount.mockResolvedValue(account([]));
      serverSays('unlocked');
      invalidateSharedAiCreditsRead();
      act(() => {
        useCloudConnectGateStore.setState({ pending: null });
      });
      await settle();

      expect(query('model-recovery-unlock')).toBeNull();
      expect(onCommit).toHaveBeenCalledWith(MODEL);
    });
  });
});

describe('ModelRecoveryModal daily free credits (needs-credits)', () => {
  /** A connected guest credential. */
  function guestAccount(): unknown {
    return {
      hasApiKey: true,
      account: { id: 'guest_1' },
      authMode: 'guest',
      credentialSource: 'guest',
      orgBillingStates: [],
    };
  }

  const optedOut = {
    ...uncovered,
    inOrg: false,
    dailyDripEnabled: false,
  };

  /** The authoritative preference read, opted out, with this cap. */
  function dripState(
    capCredits: number | undefined,
    overrides: { available?: boolean; resolved?: boolean } = {},
  ): unknown {
    return {
      available: true,
      resolved: true,
      ...overrides,
      preference: { enabled: false, decidedAt: null, capCredits },
    };
  }

  const COST_GUEST = 'no card or account needed.';
  const COST_ACCOUNT = 'no card needed.';

  beforeEach(() => {
    // Earlier blocks leave their preference implementation behind.
    loadCloudDailyCreditDrip.mockReset().mockResolvedValue(null);
  });

  function savedDrip(granted: number): unknown {
    return {
      enabled: true,
      decidedAt: '2026-10-06T19:00:00.000Z',
      capCredits: 10,
      balanceCredits: granted,
      granted,
    };
  }

  function query(testId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  it.each([
    ['undefined (older server)', undefined],
    ['true', true],
  ])(
    'leaves the modal unchanged when dailyDripEnabled is %s',
    async (_label, dailyDripEnabled) => {
      loadNativeAiCreditsAvailability.mockResolvedValue({
        ...uncovered,
        inOrg: false,
        ...(dailyDripEnabled === undefined ? {} : { dailyDripEnabled }),
      });
      loadCanopyCloudAccount.mockResolvedValue(account([]));

      await render();

      expect(query('model-recovery-turn-on-daily-credits')).toBeNull();
      expect(query('model-recovery-purchase')).not.toBeNull();
      // CAN-5214 — only the opted-out offer reads the daily cap.
      expect(loadCloudDailyCreditDrip).not.toHaveBeenCalled();
    },
  );

  // CAN-5214 — the offer states the amount, recurrence and terms before opt-in.
  it.each<[string, ModelRecovery]>([
    ['needs-credits', { kind: 'needs-credits' }],
    [
      'needs-billing-source',
      { kind: 'needs-billing-source', provider: 'claude' },
    ],
  ])(
    "names a guest's daily amount and terms without saving (%s)",
    async (_label, recovery) => {
      loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
      loadCanopyCloudAccount.mockResolvedValue(guestAccount());
      loadCloudDailyCreditDrip.mockResolvedValue(dripState(25));
      getClaudeAuthStatus.mockResolvedValue({
        authenticated: false,
        probeFailed: false,
      });

      await render(jest.fn(), recovery);
      await settle();

      expect(heading()).toBe(`Choose how to use ${getModelDisplayName(MODEL)}`);
      expect(text('model-recovery-daily-credits-body')).toBe(
        "You're out of AI Credits.",
      );
      expect(text('model-recovery-daily-credits-offer')).toBe(
        `Get 25 free every day, ${COST_GUEST}`,
      );
      expect(text('model-recovery-turn-on-daily-credits')).toBe(
        'Turn on free daily AI Credits',
      );
      expect(saveCloudDailyCreditDrip).not.toHaveBeenCalled();
    },
  );

  it('offers a signed-in account its own amount and subscription by name', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    loadCloudDailyCreditDrip.mockResolvedValue(dripState(1250));
    getClaudeAuthStatus.mockResolvedValue({
      authenticated: false,
      probeFailed: false,
    });

    await render(jest.fn(), {
      kind: 'needs-billing-source',
      provider: 'claude',
    });
    await settle();

    expect(text('model-recovery-daily-credits-offer')).toBe(
      `Get 1,250 free every day, ${COST_ACCOUNT}`,
    );
    expect(text('model-recovery-sign-in')).toBe('Use my Claude subscription');
    act(() => query('model-recovery-sign-in')?.click());
    await settle();
    expect(query('auth-login-modal-stub')).not.toBeNull();
  });

  it.each<[string, () => Promise<unknown>]>([
    [
      'the read rejects',
      (): Promise<unknown> => Promise.reject(new Error('offline')),
    ],
    ['the read is missing', (): Promise<unknown> => Promise.resolve(null)],
    [
      'the route is unavailable',
      (): Promise<unknown> =>
        Promise.resolve(dripState(25, { available: false })),
    ],
    [
      'the preference is unresolved',
      (): Promise<unknown> =>
        Promise.resolve(dripState(25, { resolved: false })),
    ],
    [
      'the cap is missing',
      (): Promise<unknown> => Promise.resolve(dripState(undefined)),
    ],
    [
      'the cap is infinite',
      (): Promise<unknown> =>
        Promise.resolve(dripState(Number.POSITIVE_INFINITY)),
    ],
    ['the cap is zero', (): Promise<unknown> => Promise.resolve(dripState(0))],
    [
      'the cap is negative',
      (): Promise<unknown> => Promise.resolve(dripState(-5)),
    ],
    [
      'the cap is not finite',
      (): Promise<unknown> => Promise.resolve(dripState(Number.NaN)),
    ],
  ])(
    'keeps the offer usable without an amount when %s',
    async (_label, read) => {
      loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
      loadCanopyCloudAccount.mockResolvedValue(guestAccount());
      loadCloudDailyCreditDrip.mockImplementation(read);

      await render();
      await settle();

      expect(text('model-recovery-daily-credits-offer')).toBe(
        `Get free AI Credits every day, ${COST_GUEST}`,
      );
      expect(
        query('model-recovery-turn-on-daily-credits')?.hasAttribute('disabled'),
      ).toBe(false);
    },
  );

  it('does not read a cap for a native-only provider recovery', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    getCodexAuthStatus.mockResolvedValue({
      authenticated: false,
      probeFailed: false,
    });
    root = createRoot(document.body);
    await act(async () => {
      root?.render(
        createElement(ModelRecoveryModal, {
          pending: {
            model: NATIVE_ONLY_MODEL,
            recovery: { kind: 'needs-billing-source', provider: 'codex' },
          },
          onCommit: jest.fn(),
          onCancel: jest.fn(),
        }),
      );
      await Promise.resolve();
    });
    await settle();

    expect(query('model-recovery-native-only')).not.toBeNull();
    expect(text('model-recovery-sign-in')).toBe('Sign in to Codex');
    expect(loadCloudDailyCreditDrip).not.toHaveBeenCalled();
  });

  it('clears the previous cap while a post-sign-in preference read waits', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
    loadCanopyCloudAccount.mockResolvedValue(guestAccount());
    loadCloudDailyCreditDrip.mockResolvedValue(dripState(25));
    await render();
    await settle();
    expect(text('model-recovery-daily-credits-offer')).toContain('25 free');

    act(() =>
      useCloudConnectGateStore.setState({
        pending: { context: {}, proceed: (): void => {} },
      }),
    );
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    let resolveCap: (value: unknown) => void = () => undefined;
    loadCloudDailyCreditDrip.mockReturnValue(
      new Promise((resolve) => {
        resolveCap = resolve;
      }),
    );
    invalidateSharedAiCreditsRead();
    act(() => useCloudConnectGateStore.setState({ pending: null }));
    await settle();

    expect(text('model-recovery-daily-credits-offer')).toBe(
      `Get free AI Credits every day, ${COST_ACCOUNT}`,
    );
    await act(async () => {
      resolveCap(dripState(10));
      await Promise.resolve();
    });
    expect(text('model-recovery-daily-credits-offer')).toBe(
      `Get 10 free every day, ${COST_ACCOUNT}`,
    );
  });

  it.each([
    ['grouped', 1250, '1,250'],
    ['fractional', 2.5, '2.5'],
    ['small', 0.004, '0.004'],
  ] as const)(
    'preserves a %s cap in the rendered offer',
    async (_kind, cap, formatted) => {
      loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
      loadCanopyCloudAccount.mockResolvedValue(account([]));
      loadCloudDailyCreditDrip.mockResolvedValue(dripState(cap));
      await render();
      await settle();
      expect(text('model-recovery-daily-credits-offer')).toBe(
        `Get ${formatted} free every day, ${COST_ACCOUNT}`,
      );
    },
  );

  it('shows the offer while the cap is still loading, then names it', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
    loadCanopyCloudAccount.mockResolvedValue(guestAccount());
    let resolveCap: (value: unknown) => void = () => undefined;
    loadCloudDailyCreditDrip.mockReturnValue(
      new Promise((resolve) => {
        resolveCap = resolve;
      }),
    );

    await render();
    await settle();

    expect(text('model-recovery-daily-credits-offer')).toBe(
      `Get free AI Credits every day, ${COST_GUEST}`,
    );
    expect(
      query('model-recovery-turn-on-daily-credits')?.hasAttribute('disabled'),
    ).toBe(false);

    await act(async () => {
      resolveCap(dripState(25));
      await Promise.resolve();
    });

    expect(text('model-recovery-daily-credits-offer')).toBe(
      `Get 25 free every day, ${COST_GUEST}`,
    );
  });

  it('keeps the saved state when a late cap read lands after the save', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    saveCloudDailyCreditDrip.mockResolvedValue(savedDrip(0));
    let resolveCap: (value: unknown) => void = () => undefined;
    loadCloudDailyCreditDrip.mockReturnValue(
      new Promise((resolve) => {
        resolveCap = resolve;
      }),
    );

    await render();
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...optedOut,
      dailyDripEnabled: true,
    });
    act(() => query('model-recovery-turn-on-daily-credits')?.click());
    await settle();
    await act(async () => {
      resolveCap(dripState(25));
      await Promise.resolve();
    });

    expect(query('model-recovery-turn-on-daily-credits')).toBeNull();
    expect(text('model-recovery-daily-credits-saved')).toBe(
      'Your free daily AI Credits start tomorrow.',
    );
  });

  it.each(['account', 'model', 'intent'] as const)(
    'ignores a delayed cap after the %s changes',
    async (changed) => {
      loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
      loadCanopyCloudAccount.mockResolvedValue(guestAccount());
      let resolveOld: (value: unknown) => void = () => undefined;
      loadCloudDailyCreditDrip.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
      );
      await render();
      await settle();
      loadCloudDailyCreditDrip.mockResolvedValue(dripState(10));
      if (changed === 'account') {
        loadCanopyCloudAccount.mockResolvedValue(account([]));
        act(() => {
          window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        });
      } else {
        await act(async () => {
          root?.render(
            createElement(ModelRecoveryModal, {
              pending: {
                model: changed === 'model' ? 'haiku' : MODEL,
                recovery: { kind: 'needs-credits' },
                ...(changed === 'intent'
                  ? { intent: 'enable-ai-credits' as const }
                  : {}),
              },
              onCommit: jest.fn(),
              onCancel: jest.fn(),
            }),
          );
          await Promise.resolve();
        });
      }
      await settle();
      await act(async () => {
        resolveOld(dripState(25));
        await Promise.resolve();
      });
      const offer = text('model-recovery-daily-credits-offer');
      expect(offer).toContain('Get 10 free every day,');
      expect(offer).not.toContain('25 free');
      expect(offer).toContain(
        changed === 'account' ? COST_ACCOUNT : COST_GUEST,
      );
    },
  );

  it('drops a cap read that lands after the modal closed', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
    loadCanopyCloudAccount.mockResolvedValue(guestAccount());
    let resolveCap: (value: unknown) => void = () => undefined;
    loadCloudDailyCreditDrip.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCap = resolve;
      }),
    );

    await render();
    await settle();
    act(() => {
      root?.unmount();
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    loadCloudDailyCreditDrip.mockResolvedValue(dripState(10));
    await render();
    await act(async () => {
      resolveCap(dripState(25));
      await Promise.resolve();
    });
    await settle();

    expect(text('model-recovery-daily-credits-offer')).toBe(
      `Get 10 free every day, ${COST_ACCOUNT}`,
    );
  });

  it('leads with Turn on and keeps Buy secondary for a signed-in user', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
    loadCanopyCloudAccount.mockResolvedValue(account([]));

    await render();

    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="model-recovery-modal"] button[data-testid]',
      ),
    ).map((node) => node.dataset.testid);
    const turnOnIndex = buttons.indexOf('model-recovery-turn-on-daily-credits');
    const buyIndex = buttons.indexOf('model-recovery-get-credits');
    expect(turnOnIndex).toBeGreaterThanOrEqual(0);
    expect(buyIndex).toBeGreaterThan(turnOnIndex);
  });

  it('keeps provider sign-in alongside Turn on for a subscription-billable model', async () => {
    // Case A: the model can bill to the user's Claude subscription OR to AI
    // Credits. Opting out of the drip must not take the sign-in exit away.
    loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    getClaudeAuthStatus.mockResolvedValue({
      authenticated: false,
      probeFailed: false,
    });

    await render(jest.fn(), {
      kind: 'needs-billing-source',
      provider: 'claude',
    });

    expect(query('model-recovery-turn-on-daily-credits')).not.toBeNull();
    expect(text('model-recovery-sign-in')).toBe('Use my Claude subscription');
  });

  it('sets every action in the same type as the sign-in beside it', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    getClaudeAuthStatus.mockResolvedValue({
      authenticated: false,
      probeFailed: false,
    });

    await render(jest.fn(), {
      kind: 'needs-billing-source',
      provider: 'claude',
    });

    /** Text size, weight, and height: what makes buttons read alike. */
    const type = (testId: string): string[] =>
      Array.from(query(testId)?.classList ?? []).filter((name) =>
        /^(text-(xs|s|sm|base)|font-|py-)/.test(name),
      );
    const signIn = type('model-recovery-sign-in');
    expect(signIn).not.toEqual([]);
    expect(type('model-recovery-turn-on-daily-credits')).toEqual(signIn);
    expect(query('model-recovery-cancel')).toBeNull();
  });

  it('describes a billing-mode switch without blaming the current model', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    loadCloudDailyCreditDrip.mockResolvedValue(dripState(25));
    root = createRoot(document.body);
    await act(async () => {
      root?.render(
        createElement(ModelRecoveryModal, {
          pending: {
            model: MODEL,
            recovery: { kind: 'needs-credits' },
            intent: 'enable-ai-credits',
          },
          onCommit: jest.fn(),
          onCancel: jest.fn(),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await settle();

    expect(query('model-recovery-turn-on-daily-credits')).not.toBeNull();
    expect(heading()).toBe('Bill this chat to AI Credits');
    expect(text('model-recovery-daily-credits-body')).toBe(
      "You're out of AI Credits, so this chat stays on your subscription for now.",
    );
    expect(text('model-recovery-daily-credits-offer')).toBe(
      `Get 25 free every day, ${COST_ACCOUNT}`,
    );
  });

  it('describes the opt-in on its button beside Get AI Credits', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    loadCloudDailyCreditDrip.mockResolvedValue(dripState(25));

    await render();
    await settle();

    const turnOn = query('model-recovery-turn-on-daily-credits');
    const hint = query('model-recovery-daily-credits-offer');
    expect(hint?.id).toBeTruthy();
    expect(turnOn?.getAttribute('aria-describedby')).toBe(hint?.id);
    // The hint continues the body in one run of text, so the actions stack
    // with no text between them.
    expect(hint?.parentElement?.textContent).toBe(
      "You're out of AI Credits. Get 25 free every day, no card needed.",
    );
    const actions = turnOn?.parentElement;
    const buttonText = Array.from(actions?.querySelectorAll('button') ?? [])
      .map((button) => button.textContent ?? '')
      .join('');
    expect(actions?.textContent).toBe(buttonText);
    expect(text('model-recovery-get-credits')).toBe('Get AI Credits');
    expect(query('model-recovery-cancel')).toBeNull();
  });

  it('gives every action the same label type and only one accent primary', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    getClaudeAuthStatus.mockResolvedValue({
      authenticated: false,
      probeFailed: false,
    });

    await render(jest.fn(), {
      kind: 'needs-billing-source',
      provider: 'claude',
    });
    await settle();

    const actions = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="model-recovery-modal"] button[data-testid^="model-recovery-"]',
      ),
    );
    expect(actions.map((node) => node.dataset.testid)).toEqual([
      'model-recovery-turn-on-daily-credits',
      'model-recovery-get-credits',
      'model-recovery-sign-in',
    ]);
    for (const node of actions) {
      expect(node.classList.contains('text-s')).toBe(true);
      expect(node.classList.contains('font-medium')).toBe(true);
      expect(node.classList.contains('text-xs')).toBe(false);
    }
    expect(
      actions.filter((node) => node.classList.contains('bg-accent')),
    ).toEqual([actions[0]]);
  });

  it('offers no Buy to a guest', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
    loadCanopyCloudAccount.mockResolvedValue(guestAccount());

    await render();

    expect(query('model-recovery-turn-on-daily-credits')).not.toBeNull();
    expect(query('model-recovery-get-credits')).toBeNull();
  });

  it('turns the drip on, waits for the fresh balance, then commits the model', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
    loadCanopyCloudAccount.mockResolvedValue(guestAccount());
    saveCloudDailyCreditDrip.mockResolvedValue(savedDrip(10));
    const onCommit = jest.fn();

    await render(onCommit);
    expect(onCommit).not.toHaveBeenCalled();

    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...optedOut,
      personalEligible: true,
      dailyDripEnabled: true,
    });
    act(() => query('model-recovery-turn-on-daily-credits')?.click());
    expect(
      query('model-recovery-turn-on-daily-credits')?.hasAttribute('disabled'),
    ).toBe(true);
    await settle();

    expect(saveCloudDailyCreditDrip).toHaveBeenCalledTimes(1);
    expect(saveCloudDailyCreditDrip).toHaveBeenCalledWith({ enabled: true });
    expect(onCommit).toHaveBeenCalledWith(MODEL);
  });

  it('stays open with the refill message when the grant did not land', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    saveCloudDailyCreditDrip.mockResolvedValue(savedDrip(0));
    const onCommit = jest.fn();

    await render(onCommit);
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...optedOut,
      dailyDripEnabled: true,
    });
    act(() => query('model-recovery-turn-on-daily-credits')?.click());
    await settle();

    expect(onCommit).not.toHaveBeenCalled();
    expect(query('model-recovery-turn-on-daily-credits')).toBeNull();
    expect(heading()).toBe(`Choose how to use ${getModelDisplayName(MODEL)}`);
    expect(text('model-recovery-daily-credits-saved')).toBe(
      'Your free daily AI Credits start tomorrow.',
    );
    // Buy is the way forward now, so it takes the primary role.
    expect(text('model-recovery-get-credits')).toBe('Get AI Credits');
    expect(
      query('model-recovery-get-credits')?.classList.contains('bg-accent'),
    ).toBe(true);
  });

  it('keeps Turn on with an inline error when the save fails', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
    loadCanopyCloudAccount.mockResolvedValue(guestAccount());
    saveCloudDailyCreditDrip.mockRejectedValue(new Error('offline'));
    const onCommit = jest.fn();

    await render(onCommit);
    act(() => query('model-recovery-turn-on-daily-credits')?.click());
    await settle();

    expect(onCommit).not.toHaveBeenCalled();
    expect(text('model-recovery-daily-credits-error')).toBe(
      "Couldn't save. Try again.",
    );
    expect(
      query('model-recovery-turn-on-daily-credits')?.hasAttribute('disabled'),
    ).toBe(false);
  });
});

describe('ModelRecoveryModal — Get AI Credits destination (CAN-4691, CAN-5160)', () => {
  const realRequestConnect = useCloudConnectGateStore.getState().requestConnect;
  const realOpenAccountOrganizationSettings =
    useNavigationStore.getState().openAccountOrganizationSettings;
  const openAccountOrganizationSettings = jest.fn<
    void,
    [SettingsRoute, unknown?]
  >();

  beforeEach(() => {
    openAccountOrganizationSettings.mockReset();
    useNavigationStore.setState({ openAccountOrganizationSettings });
    // A signed-in account short-circuits the shared gate straight to
    // `proceed`, which is the purchase path these cases exercise.
    useCloudConnectGateStore.setState({
      requestConnect: (_context, proceed): void => proceed(),
    });
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      inOrg: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));
  });

  afterEach(() => {
    useCloudConnectGateStore.setState({ requestConnect: realRequestConnect });
    useNavigationStore.setState({
      openAccountOrganizationSettings: realOpenAccountOrganizationSettings,
    });
  });

  async function renderWithCancel(onCancel: () => void): Promise<void> {
    root = createRoot(document.body);
    await act(async () => {
      root?.render(
        createElement(ModelRecoveryModal, {
          pending: { model: MODEL, recovery: { kind: 'needs-credits' } },
          onCommit: jest.fn(),
          onCancel,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function clickGetCredits(): Promise<void> {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-testid="model-recovery-get-credits"]',
    );
    if (!button) throw new Error('Get AI Credits not rendered');
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
  }

  it('buys in the browser even when Settings could open, and stays open to Check again (CAN-5160)', async () => {
    // Settings would end the hand-off, so the composer could never confirm
    // the credits. The chat banners take the browser for the same reason.
    mockHostedSettingsOpenable.mockReturnValue(true);
    const onCancel = jest.fn();
    await renderWithCancel(onCancel);

    await clickGetCredits();

    expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
    expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(
      document.querySelector(
        '[data-testid="model-recovery-get-credits-check-again"]',
      ),
    ).not.toBeNull();
  });

  it('stays open on a browser hand-off so the user can Check again', async () => {
    const onCancel = jest.fn();
    await renderWithCancel(onCancel);

    await clickGetCredits();

    expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
    expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('ModelRecoveryModal credits recovery telemetry (CAN-4633)', () => {
  function query(testId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  it('records a model-select view and the drip opt-in click', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      inOrg: false,
      dailyDripEnabled: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    saveCloudDailyCreditDrip.mockReturnValue(new Promise(() => {}));

    await render();
    act(() => query('model-recovery-turn-on-daily-credits')?.click());

    expect(mockTrackCreditsRecoveryView).toHaveBeenCalledWith({
      surface: 'model_recovery',
      trigger: 'model_select',
      dedupeKey: MODEL,
    });
    expect(mockTrackCreditsRecoveryClick).toHaveBeenCalledWith({
      surface: 'model_recovery',
      action: 'drip_opt_in',
    });
  });

  it('records a billing-mode-switch view', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      inOrg: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    root = createRoot(document.body);
    await act(async () => {
      root?.render(
        createElement(ModelRecoveryModal, {
          pending: {
            model: MODEL,
            recovery: { kind: 'needs-credits' },
            intent: 'enable-ai-credits',
          },
          onCommit: jest.fn(),
          onCancel: jest.fn(),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(query('model-recovery-purchase')).not.toBeNull();
    expect(mockTrackCreditsRecoveryView).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'billing_mode_switch' }),
    );
  });

  it('records the purchase and dismiss clicks', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      inOrg: false,
    });
    loadCanopyCloudAccount.mockResolvedValue(account([]));

    await render();
    act(() => query('model-recovery-get-credits')?.click());
    act(() => closeButton()?.click());

    expect(mockTrackCreditsRecoveryClick.mock.calls).toEqual([
      [{ surface: 'model_recovery', action: 'credits_purchase' }],
      [{ surface: 'model_recovery', action: 'dismiss' }],
    ]);
  });

  it('records nothing for a recovery that is not about credits', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(uncovered);
    loadCanopyCloudAccount.mockResolvedValue(account([]));

    await render(jest.fn(), { kind: 'needs-purchase' });
    act(() => closeButton()?.click());

    expect(mockTrackCreditsRecoveryView).not.toHaveBeenCalled();
    expect(mockTrackCreditsRecoveryClick).not.toHaveBeenCalled();
  });
});
