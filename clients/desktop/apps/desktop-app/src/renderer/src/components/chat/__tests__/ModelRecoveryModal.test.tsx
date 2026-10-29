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

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ModelRecoveryModal } from '../ModelRecoveryModal';
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
import type { ChatModel } from '@canopy/desktop-shared/types';
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
  resetModelUnlockIntentForTests,
  useModelUnlockIntentStore,
} from '@/lib/modelUnlockIntent';
import type * as HostedSettingsAvailabilityModule from '@/components/settings/hosted/hosted-settings-availability';
import type { SettingsRoute } from '@canopy/protocol/settings';
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

    const copy = text('model-recovery-purchase');
    expect(copy).toContain('bill this chat');
    expect(copy).not.toContain('runs on');
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

    // Still mounted — just not painted over the cloud modal.
    expect(
      document.querySelector('[data-testid="model-recovery-get-credits"]'),
    ).not.toBeNull();
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

    expect(text('model-recovery-needs-account')).toContain('hosted by');
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
      expect(text('model-recovery-needs-account')).toContain('hosted by');
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
      onUnlockPurchase?: () => Promise<UnlockModelsResult>;
    } = {},
  ): Promise<void> {
    root = createRoot(document.body);
    act(() => {
      root?.render(
        createElement(ModelRecoveryModal, {
          pending: { model: MODEL, recovery },
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

  it('asks for the purchase with the shared copy and never commits on coverage', async () => {
    const onCommit = jest.fn();
    await renderUnlock({ kind: 'needs-purchase' }, { onCommit });

    expect(text('model-recovery-modal')).toContain('Unlock advanced models');
    expect(text('model-recovery-unlock')).toBe(
      'Purchase AI Credits to unlock advanced models.',
    );
    expect(text('model-recovery-unlock-purchase')).toBe('Purchase AI Credits');
    expect(text('model-recovery-cancel')).toBe('Not now');
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
      "Finish in your browser. We'll check when your payment completes.",
    );
    expect(query('model-recovery-unlock-check-again')).not.toBeNull();
    expect(text('model-recovery-cancel')).toBe('Close');
    // Opening checkout is not a commit.
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('offers a re-check and a reopen after the poll times out, without calling it a failure', async () => {
    const onUnlockPurchase = hostOpensCheckout();
    await renderUnlock({ kind: 'needs-purchase' }, { onUnlockPurchase });
    await click('model-recovery-unlock-purchase');

    act(() => {
      useModelUnlockIntentStore.setState({ phase: 'timed-out' });
    });

    const copy = text('model-recovery-unlock-timed-out') ?? '';
    expect(copy).toContain('We stopped checking for your payment.');
    expect(copy.toLowerCase()).not.toContain('fail');
    expect(query('model-recovery-unlock-check-again')).not.toBeNull();

    await click('model-recovery-unlock-reopen');
    expect(onUnlockPurchase).toHaveBeenCalledTimes(2);
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

      expect(text('model-recovery-modal')).toContain('Unlock advanced models');
      expect(text('model-recovery-needs-account')).toBe(
        'Sign in, then purchase AI Credits.',
      );
      expect(text('model-recovery-account-sign-in')).toBe('Sign in');
      // No purchase is offered to a guest, who cannot buy.
      expect(query('model-recovery-unlock-purchase')).toBeNull();
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
      expect(text('model-recovery-unlock')).toBe(
        'Purchase AI Credits to unlock advanced models.',
      );
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
    },
  );

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
    expect(query('model-recovery-sign-in')).not.toBeNull();
    expect(text('model-recovery-daily-credits')).toContain('sign in to Claude');
  });

  it('describes a billing-mode switch without blaming the current model', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(optedOut);
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

    expect(query('model-recovery-turn-on-daily-credits')).not.toBeNull();
    const copy = text('model-recovery-daily-credits');
    expect(copy).toContain('bill this chat');
    expect(copy).not.toContain('runs on');
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
    expect(text('model-recovery-daily-credits-saved')).toBe(
      'Your free daily credits start tomorrow. You can also buy credits now.',
    );
    expect(query('model-recovery-get-credits')).not.toBeNull();
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

describe('ModelRecoveryModal — Get AI Credits in Settings (CAN-4691)', () => {
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

  it('closes itself when Billing opens inside Settings, so it does not cover the page', async () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    const onCancel = jest.fn();
    await renderWithCancel(onCancel);

    await clickGetCredits();

    expect(openAccountOrganizationSettings).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
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
