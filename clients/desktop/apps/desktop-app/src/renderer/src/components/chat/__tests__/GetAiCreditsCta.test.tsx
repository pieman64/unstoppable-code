/**
 * @jest-environment jsdom
 *
 * CAN-2349 §3. The purchase chain is covered ONCE, here — cases A, B and C then
 * assert only their own `onCovered` (model committed vs. toggle flipped), which
 * is the only thing that differs between them.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  GetAiCreditsCta,
  type GetAiCreditsHandoffState,
  type GetAiCreditsCtaProps,
} from '../GetAiCreditsCta';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import * as openBillingPageModule from '@/lib/openBillingPage';
import {
  invalidateSharedAiCreditsRead,
  resetSettingsCloseRereadForTests,
} from '@/lib/openBillingPage';
import type { AiCreditsScopeRequest } from '@canopy/desktop-shared/types';
import type * as HostedSettingsAvailabilityModule from '@/components/settings/hosted/hosted-settings-availability';
import type { SettingsRoute } from '@canopy/protocol/settings';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useModelUnlockReturn } from '@/hooks/useModelUnlockReturn';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  resetAiCreditsArrivalForTests,
  useAiCreditsArrivalStore,
  type AiCreditsArrivalOrigin,
} from '@/lib/aiCreditsArrivalConfirmation';
import {
  resetAiCreditsHandoffsForTests,
  reconcileAiCreditsHandoffAccount,
  suspendAiCreditsHandoffAccount,
  useAiCreditsHandoffStore,
} from '@/stores/aiCreditsHandoffStore';

const mockHostedSettingsOpenable = jest.fn<boolean, []>();
jest.mock('@/components/settings/hosted/hosted-settings-availability', () => ({
  ...jest.requireActual<typeof HostedSettingsAvailabilityModule>(
    '@/components/settings/hosted/hosted-settings-availability',
  ),
  hostedSettingsOpenable: (): boolean => mockHostedSettingsOpenable(),
  useHostedSettingsAvailable: (): boolean => mockHostedSettingsOpenable(),
}));

const realOpenAccountOrganizationSettings =
  useNavigationStore.getState().openAccountOrganizationSettings;
const openAccountOrganizationSettings = jest.fn<
  void,
  [SettingsRoute, unknown?]
>();

let root: Root | null = null;

const loadNativeAiCreditsAvailability = jest.fn();
const loadCanopyCloudAccount = jest.fn();
const loadCanopyCloudAiCredits = jest.fn();
const openAuthenticatedPortalPage = jest.fn();
const openExternal = jest.fn();
const realRequestConnect = useCloudConnectGateStore.getState().requestConnect;

function stubApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      loadNativeAiCreditsAvailability,
      loadCanopyCloudAccount,
      loadCanopyCloudAiCredits,
      openAuthenticatedPortalPage,
      browser: { openExternal },
    },
  });
}

const uncovered = {
  personalEligible: false,
  orgSpendable: false,
  inOrg: false,
  orgCreditPoolCovered: false,
  inconclusive: false,
  pricingUrl: 'https://example.test/pricing',
};
const covered = { ...uncovered, personalEligible: true };

function cta(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(
    '[data-testid="get-ai-credits-cta"]',
  );
  if (!el) throw new Error('cta not found');
  return el;
}

/** The path the Nth signed-in portal open asked for. */
function openedPortalPath(index: number): string {
  const calls: readonly (readonly unknown[])[] =
    openAuthenticatedPortalPage.mock.calls;
  return String(calls[index]?.[0]);
}

async function renderCta(
  onCovered: () => void,
  onNeedsRecovery?: () => void,
  aiCreditsScope?: AiCreditsScopeRequest,
  onOpenedInApp?: () => void,
  confirmArrival?: AiCreditsArrivalOrigin,
  billingDestination?: GetAiCreditsCtaProps['billingDestination'],
): Promise<void> {
  root ??= createRoot(document.body);
  await act(async () => {
    root?.render(
      createElement(GetAiCreditsCta, {
        label: 'Get AI Credits',
        onCovered,
        ...(confirmArrival ? { confirmArrival } : {}),
        ...(onNeedsRecovery ? { onNeedsRecovery } : {}),
        ...(aiCreditsScope ? { aiCreditsScope } : {}),
        ...(onOpenedInApp ? { onOpenedInApp } : {}),
        ...(billingDestination ? { billingDestination } : {}),
      }),
    );
    await Promise.resolve();
  });
}

/**
 * Settle a click. The in-app path awaits more than the web path (the
 * hosted-settings route resolution), so loop a bounded number of microtasks
 * rather than hard-coding the exact count.
 */
async function clickAndSettle(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  loadCanopyCloudAccount.mockReset();
  resetAiCreditsArrivalForTests();
  loadCanopyCloudAiCredits.mockResolvedValue({
    connected: true,
    noUdAccount: false,
    error: null,
    balance: null,
  });
  // Web branch by default, so every pre-CAN-4691 case keeps its meaning.
  mockHostedSettingsOpenable.mockReset().mockReturnValue(false);
  openAccountOrganizationSettings.mockReset();
  useNavigationStore.setState({ openAccountOrganizationSettings });
  // Explicit reset of the module-level shared read, rather than relying on
  // every seeded read settling inside its own `act()`. Without it this file is
  // order-dependent: one suite's retained answer becomes the next one's.
  invalidateSharedAiCreditsRead();
  stubApi();
  loadNativeAiCreditsAvailability.mockResolvedValue(uncovered);
  loadCanopyCloudAccount.mockResolvedValue({
    hasApiKey: true,
    account: { id: 'acct_1' },
    authMode: 'account',
    credentialSource: 'account',
  });
  // Main resolves `true` when a page actually opened (see
  // `CanopyApi.openAuthenticatedPortalPage`).
  openAuthenticatedPortalPage.mockResolvedValue(true);
  // Short-circuit the shared cloud gate: `requestConnect` runs `proceed`
  // immediately when a real account is already connected, which is the
  // signed-in path this suite exercises.
  useCloudConnectGateStore.setState({
    pending: null,
    requestConnect: (_context, proceed): void => proceed(),
  });
});

afterEach(() => {
  resetSettingsCloseRereadForTests();
  act(() => {
    root?.unmount();
  });
  root = null;
  resetAiCreditsArrivalForTests();
  document.body.innerHTML = '';
  useNavigationStore.setState({
    openAccountOrganizationSettings: realOpenAccountOrganizationSettings,
  });
});

// The retained checkout outlives a render (CAN-5534); never leak it across cases.
beforeEach(() => {
  resetAiCreditsHandoffsForTests();
});
afterEach(() => {
  resetAiCreditsHandoffsForTests();
});

describe('GetAiCreditsCta', () => {
  describe('arrival hand-off boundaries (CAN-5160)', () => {
    const scope = {
      kind: 'work',
      projectId: 'project',
      chatId: 'chat',
    } as const;
    async function returnCovered(automatic = false): Promise<void> {
      loadNativeAiCreditsAvailability.mockResolvedValue(covered);
      await act(async () => {
        if (automatic) window.dispatchEvent(new Event('focus'));
        else
          document
            .querySelector<HTMLButtonElement>(
              '[data-testid="get-ai-credits-cta-check-again"]',
            )
            ?.click();
        for (let i = 0; i < 30; i++) await Promise.resolve();
      });
    }

    it('records an automatic covered return once and does not reopen billing', async () => {
      const onCovered = jest.fn();
      await renderCta(onCovered, undefined, scope, undefined, 'usage-limit');
      await clickAndSettle(cta());
      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
      await returnCovered(true);
      const arrival = useAiCreditsArrivalStore.getState().arrival;
      expect(arrival?.chatId).toBe('chat');
      await returnCovered(true);
      expect(useAiCreditsArrivalStore.getState().arrival).toBe(arrival);
      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
      expect(onCovered).toHaveBeenCalledTimes(1);
    });

    it('records the origin its host names', async () => {
      await renderCta(
        jest.fn(),
        undefined,
        scope,
        undefined,
        'no-billing-source',
      );
      await clickAndSettle(cta());
      await returnCovered();
      expect(useAiCreditsArrivalStore.getState().arrival?.origin).toBe(
        'no-billing-source',
      );
    });

    it('leaves other CTA hosts opted out', async () => {
      await renderCta(jest.fn(), undefined, scope);
      await clickAndSettle(cta());
      await returnCovered();
      expect(loadCanopyCloudAiCredits).not.toHaveBeenCalled();
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
    });

    it('cancels on a scope change before return', async () => {
      await renderCta(jest.fn(), undefined, scope, undefined, 'usage-limit');
      await clickAndSettle(cta());
      await renderCta(
        jest.fn(),
        undefined,
        { ...scope, chatId: 'other' },
        undefined,
        'usage-limit',
      );
      await returnCovered();
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
    });

    it('cancels an in-app Settings hand-off', async () => {
      mockHostedSettingsOpenable.mockReturnValue(true);
      await renderCta(jest.fn(), undefined, scope, undefined, 'usage-limit');
      await clickAndSettle(cta());
      await returnCovered();
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
    });

    it('keeps a browser hand-off and records the arrival while hosted settings are openable (CAN-5159)', async () => {
      mockHostedSettingsOpenable.mockReturnValue(true);
      const onOpenedInApp = jest.fn();
      await renderCta(
        jest.fn(),
        undefined,
        scope,
        onOpenedInApp,
        'usage-limit',
        'browser',
      );
      await clickAndSettle(cta());

      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
      const opened = new URL(openedPortalPath(0), 'https://billing.invalid');
      expect(opened.pathname).toBe('/account/billing');
      expect(opened.searchParams.get('topUp')).toBe('1');
      expect(opened.searchParams.get('reason')).toBe('credits');
      expect(opened.searchParams.get('source')).toBe('banner');
      expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
      expect(onOpenedInApp).not.toHaveBeenCalled();
      expect(
        document.querySelector(
          '[data-testid="get-ai-credits-cta-check-again"]',
        ),
      ).not.toBeNull();

      await returnCovered();
      expect(useAiCreditsArrivalStore.getState().arrival?.chatId).toBe('chat');
    });

    it('cancels a failed external open', async () => {
      openAuthenticatedPortalPage.mockResolvedValue(false);
      openExternal.mockRejectedValueOnce(new Error('browser unavailable'));
      await renderCta(jest.fn(), undefined, scope, undefined, 'usage-limit');
      await clickAndSettle(cta());
      await returnCovered();
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
    });

    it('does not let a never-settling baseline block covered return', async () => {
      loadCanopyCloudAiCredits.mockReturnValueOnce(new Promise(() => {}));
      const onCovered = jest.fn();
      await renderCta(onCovered, undefined, scope, undefined, 'usage-limit');
      await clickAndSettle(cta());
      await returnCovered();
      expect(onCovered).toHaveBeenCalledTimes(1);
      expect(useAiCreditsArrivalStore.getState().arrival?.chatId).toBe('chat');
    });

    it('cancels a covered hand-off on unmount while its identity is unresolved', async () => {
      let resolveIdentity: (value: {
        account: { id: string };
      }) => void = () => {};
      await renderCta(jest.fn(), undefined, scope, undefined, 'usage-limit');
      loadCanopyCloudAccount.mockReturnValue(
        new Promise((resolve) => {
          resolveIdentity = resolve;
        }),
      );
      await clickAndSettle(cta());
      await returnCovered();
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
      act(() => root?.unmount());
      root = null;
      await act(async () => {
        resolveIdentity({ account: { id: 'acct_1' } });
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
    });
  });

  it('drops its instance-level availability when the work-owner scope changes', async () => {
    const onCovered = jest.fn();
    const ownerA = {
      kind: 'work',
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      chatId: 'chat-a',
    } as const;
    const ownerB = {
      kind: 'work',
      projectId: 'project-b',
      worktreeId: 'worktree-b',
      chatId: 'chat-b',
    } as const;

    await renderCta(onCovered, undefined, ownerA);
    await renderCta(onCovered, undefined, ownerB);

    expect(loadNativeAiCreditsAvailability).toHaveBeenLastCalledWith(ownerB);
  });

  it('SAYS SO when the post-connect read fails in a banner host', async () => {
    // The banner hosts (`NoBillingSourceBanner`, `AiCreditsUsageLimitBanner`)
    // mount this CTA WITHOUT `onNeedsRecovery`, so there is no recovery modal
    // to explain an inconclusive read. Before this, a post-connect `'unknown'`
    // just cleared `busy` and returned: the spinner stopped, no page opened,
    // nothing was said. During an availability outage every click looked like a
    // broken button.
    let proceed: (() => void) | undefined;
    useCloudConnectGateStore.setState({
      pending: null,
      requestConnect: (_context, next): void => {
        proceed = next;
      },
    });
    await renderCta(jest.fn());

    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    // The post-connect read cannot resolve.
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      inconclusive: true,
    });

    await act(async () => {
      proceed?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Not a purchase, and not silence either.
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="get-ai-credits-cta-read-failed"]'),
    ).not.toBeNull();
    expect(
      cta().querySelector('[data-testid="get-ai-credits-cta-spinner"]'),
    ).toBeNull();
  });

  it('keeps its spinner visible while the cloud account check is in flight', async () => {
    let proceed: (() => void) | undefined;
    useCloudConnectGateStore.setState({
      pending: null,
      requestConnect: (_context, next): void => {
        proceed = next;
      },
    });
    await renderCta(jest.fn());

    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(proceed).toBeDefined();
    expect(
      cta().querySelector('[data-testid="get-ai-credits-cta-spinner"]'),
    ).not.toBeNull();
  });

  it('escalates contact-admin coverage instead of opening billing', async () => {
    const onNeedsRecovery = jest.fn();
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      inOrg: true,
      orgCreditPoolCovered: true,
    });
    await renderCta(jest.fn(), onNeedsRecovery);

    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onNeedsRecovery).toHaveBeenCalledTimes(1);
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
  });

  it('escalates an inconclusive read instead of opening billing', async () => {
    const onNeedsRecovery = jest.fn();
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      inconclusive: true,
    });
    await renderCta(jest.fn(), onNeedsRecovery);

    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onNeedsRecovery).toHaveBeenCalledTimes(1);
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
  });

  it('escalates a guest account instead of presenting purchase-first', async () => {
    const onNeedsRecovery = jest.fn();
    loadCanopyCloudAccount.mockResolvedValue(null);
    await renderCta(jest.fn(), onNeedsRecovery);

    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onNeedsRecovery).toHaveBeenCalledTimes(1);
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
  });
  it('hands off to billing and switches to the Check again state', async () => {
    await renderCta(jest.fn());

    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
      '/account/billing',
    );
    // The hand-off is a distinct state, not a silent no-op: the user has left
    // for the browser and needs to be told we are waiting for them.
    expect(
      document.querySelector('[data-testid="get-ai-credits-cta-handoff"]'),
    ).not.toBeNull();
  });

  it('automatically re-probes and commits when the app regains focus', async () => {
    const onCovered = jest.fn();
    await renderCta(onCovered);

    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    loadNativeAiCreditsAvailability.mockResolvedValue(covered);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onCovered).toHaveBeenCalledTimes(1);
  });

  it('commits via onCovered only when credits actually appear', async () => {
    const onCovered = jest.fn();
    await renderCta(onCovered);

    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onCovered).not.toHaveBeenCalled();

    // Still uncovered — Check again must NOT commit. It holds its busy state
    // for the CAN-5162 minimum, so wait that out before pressing again.
    jest.useFakeTimers({ now: Date.now() });
    try {
      await act(async () => {
        document
          .querySelector('[data-testid="get-ai-credits-cta-check-again"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(500);
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      });
    } finally {
      jest.useRealTimers();
    }
    expect(onCovered).not.toHaveBeenCalled();

    // Credits landed.
    loadNativeAiCreditsAvailability.mockResolvedValue(covered);
    await act(async () => {
      document
        .querySelector('[data-testid="get-ai-credits-cta-check-again"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onCovered).toHaveBeenCalledTimes(1);
  });

  it('does not arm the one-shot latch when the host REFUSES the coverage', async () => {
    // `onCovered` returning `false` means the host saw the coverage but could
    // not act on it — `ModelRecoveryModal` returns it when the pending row went
    // provider-locked mid-recovery. Arming `coveredRef` there would make every
    // later press a silent no-op, because the latch is only reset by
    // `beginBillingHandoff`, which a covered-account retry never reaches. That
    // is the dead click CAN-2349 exists to remove.
    const onCovered = jest.fn().mockReturnValue(false);
    loadNativeAiCreditsAvailability.mockResolvedValue(covered);
    await renderCta(onCovered);

    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onCovered).toHaveBeenCalledTimes(1);

    // The lock clears and the user presses again — the host must be asked a
    // SECOND time rather than silently short-circuited by the latch.
    onCovered.mockReturnValue(undefined);
    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onCovered).toHaveBeenCalledTimes(2);

    // Now that it committed, the latch DOES arm — no double commit.
    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onCovered).toHaveBeenCalledTimes(2);
  });

  it('does not commit on an inconclusive read', async () => {
    // §7: a failed read is not evidence about the balance. Success is
    // `canSpendCredits === true` and nothing else — inferring coverage from
    // three false flags is the failure mode that keeps every test green while
    // real users lose their CTA.
    const onCovered = jest.fn();
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...covered,
      inconclusive: true,
    });
    await renderCta(onCovered);
    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector('[data-testid="get-ai-credits-cta-check-again"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onCovered).not.toHaveBeenCalled();
  });

  it('bypasses the shared throttle for Check again', async () => {
    // A user who returns within the 60s automatic-probe window and presses the
    // button themselves must get a real read, not a silent no-op.
    const onCovered = jest.fn();
    await renderCta(onCovered);
    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const callsBefore = loadNativeAiCreditsAvailability.mock.calls.length;
    loadNativeAiCreditsAvailability.mockResolvedValue(covered);
    await act(async () => {
      document
        .querySelector('[data-testid="get-ai-credits-cta-check-again"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(loadNativeAiCreditsAvailability.mock.calls.length).toBeGreaterThan(
      callsBefore,
    );
    expect(onCovered).toHaveBeenCalled();
  });

  it('commits instead of opening billing when connecting itself yields credits', async () => {
    // Signing in IS a way to get credits — a new account starts with free
    // ones, which is exactly what the guest copy promises. Sending a
    // now-covered user to a BILLING page contradicts the offer they just
    // accepted and parks them on "Check again" until they alt-tab back.
    const onCovered = jest.fn();
    loadCanopyCloudAccount.mockResolvedValue(null);
    let proceed: (() => void) | undefined;
    useCloudConnectGateStore.setState({
      pending: null,
      requestConnect: (_context, next): void => {
        proceed = next;
      },
    });
    await renderCta(onCovered);

    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The connect succeeds and the new account arrives WITH free credits.
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct_new' },
      authMode: 'account',
      credentialSource: 'account',
    });
    loadNativeAiCreditsAvailability.mockResolvedValue(covered);

    await act(async () => {
      proceed?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onCovered).toHaveBeenCalledTimes(1);
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="get-ai-credits-cta-handoff"]'),
    ).toBeNull();
  });

  it('still hands off to billing when connecting does not yield credits', async () => {
    const onCovered = jest.fn();
    let proceed: (() => void) | undefined;
    useCloudConnectGateStore.setState({
      pending: null,
      requestConnect: (_context, next): void => {
        proceed = next;
      },
    });
    await renderCta(onCovered);

    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      proceed?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onCovered).not.toHaveBeenCalled();
    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
      '/account/billing',
    );
  });

  it('treats "main reports nothing opened" as a failed hand-off', async () => {
    // The bridge resolves `false` when no page opened. Trusting non-rejection
    // instead would make this branch unreachable in production, because main
    // degrades every realistic failure into a fallback that swallows its error.
    openAuthenticatedPortalPage.mockResolvedValue(false);
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      pricingUrl: undefined,
    });
    await renderCta(jest.fn());

    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="get-ai-credits-cta-handoff"]'),
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-testid="get-ai-credits-cta-handoff-failed"]',
      ),
    ).not.toBeNull();
  });

  it('commits ONCE when focus and visibilitychange both fire on return', async () => {
    // Returning from a browser commonly fires both. The shared probe dedupes
    // the IPC read, but each awaiting caller resumes with the same covered
    // result — so without a per-instance guard `onCovered` runs twice, which
    // means the model is committed twice / the billing toggle flips twice /
    // quota recovery runs twice.
    const onCovered = jest.fn();
    await renderCta(onCovered);

    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    loadNativeAiCreditsAvailability.mockResolvedValue(covered);

    // The reprobe throttle is MODULE-level and shared across tests in this
    // file, so step past its 60s window; otherwise the automatic (unforced)
    // probe short-circuits and this asserts nothing.
    const realNow = Date.now();
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(realNow + 10 * 60_000);
    try {
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(onCovered).toHaveBeenCalledTimes(1);
  });

  it('waits for the availability read before handing off to billing', async () => {
    // The button is enabled the moment it renders, before the seed read
    // resolves. A click in that window used to reach `openBillingPage(null)`,
    // whose unauthenticated fallback has no pricing URL — so when the
    // authenticated hand-off rejects (offline / no token / mint failure),
    // NOTHING opened while the UI still claimed the browser had it.
    let resolveRead: ((value: unknown) => void) | undefined;
    loadNativeAiCreditsAvailability.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    openAuthenticatedPortalPage.mockRejectedValue(new Error('mint failed'));
    await renderCta(jest.fn());

    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    // Still waiting on the read — nothing has been opened yet.
    expect(openExternal).not.toHaveBeenCalled();

    await act(async () => {
      resolveRead?.(uncovered);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(openExternal).toHaveBeenCalledWith({
      url: 'https://example.test/pricing',
    });
    expect(
      document.querySelector('[data-testid="get-ai-credits-cta-handoff"]'),
    ).not.toBeNull();
  });

  it('keeps the button and says so when nothing could be opened', async () => {
    openAuthenticatedPortalPage.mockRejectedValue(new Error('mint failed'));
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      pricingUrl: undefined,
    });
    await renderCta(jest.fn());

    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // No page opened, so the hand-off state would be a lie.
    expect(
      document.querySelector('[data-testid="get-ai-credits-cta-handoff"]'),
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-testid="get-ai-credits-cta-handoff-failed"]',
      ),
    ).not.toBeNull();
    // And the button is live again rather than latched behind a dead spinner.
    expect(cta().disabled).toBe(false);
  });

  it('re-arms the hand-off after a covered cycle', async () => {
    // `handoffStartedRef` is a one-shot latch. If it is never reset, a second
    // purchase from a surviving instance spins forever and never opens billing.
    const onCovered = jest.fn();
    await renderCta(onCovered);

    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    loadNativeAiCreditsAvailability.mockResolvedValue(covered);
    await act(async () => {
      document
        .querySelector('[data-testid="get-ai-credits-cta-check-again"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onCovered).toHaveBeenCalledTimes(1);

    // Coverage lapsed again; the primary button is back.
    loadNativeAiCreditsAvailability.mockResolvedValue(uncovered);
    const callsBefore = openAuthenticatedPortalPage.mock.calls.length;
    await act(async () => {
      cta().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(openAuthenticatedPortalPage.mock.calls.length).toBeGreaterThan(
      callsBefore,
    );
  });
});

describe('in-app Settings → Billing (CAN-4691)', () => {
  function handoff(): Element | null {
    return document.querySelector('[data-testid="get-ai-credits-cta-handoff"]');
  }
  function handoffFailed(): Element | null {
    return document.querySelector(
      '[data-testid="get-ai-credits-cta-handoff-failed"]',
    );
  }

  it('opens Billing inside Settings, mints no auth link, and does NOT enter the browser hand-off state', async () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    const onOpenedInApp = jest.fn();
    await renderCta(jest.fn(), undefined, undefined, onOpenedInApp);

    await clickAndSettle(cta());

    expect(openAccountOrganizationSettings).toHaveBeenCalledTimes(1);
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(handoff()).toBeNull();
    expect(handoffFailed()).toBeNull();
    expect(cta().disabled).toBe(false);
    expect(onOpenedInApp).toHaveBeenCalledTimes(1);
  });

  it('does not probe coverage on window focus after an in-app open', async () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    await renderCta(jest.fn());
    await clickAndSettle(cta());
    expect(openAccountOrganizationSettings).toHaveBeenCalledTimes(1);

    const reads = loadNativeAiCreditsAvailability.mock.calls.length;
    // The reprobe throttle is MODULE-level and earlier tests in this file
    // (including one that steps 10 minutes ahead) leave it warm, so step well
    // past its window; otherwise an armed listener would short-circuit too and
    // this would assert nothing.
    const realNow = Date.now();
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(realNow + 60 * 60_000);
    try {
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(loadNativeAiCreditsAvailability.mock.calls.length).toBe(reads);
  });

  it('can be clicked again after an in-app open (the one-shot latch is released)', async () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    await renderCta(jest.fn());

    await clickAndSettle(cta());
    await clickAndSettle(cta());

    expect(openAccountOrganizationSettings).toHaveBeenCalledTimes(2);
  });

  it('still hands off to the browser and shows Check again when hosted settings are not openable', async () => {
    const onOpenedInApp = jest.fn();
    await renderCta(jest.fn(), undefined, undefined, onOpenedInApp);

    await clickAndSettle(cta());

    expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
    expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
    expect(handoff()).not.toBeNull();
    expect(onOpenedInApp).not.toHaveBeenCalled();
  });

  it('reports "couldn\'t open" when neither Settings, the web page nor pricing opened', async () => {
    openAuthenticatedPortalPage.mockResolvedValue(false);
    loadNativeAiCreditsAvailability.mockResolvedValue({
      ...uncovered,
      pricingUrl: undefined,
    });
    const onOpenedInApp = jest.fn();
    await renderCta(jest.fn(), undefined, undefined, onOpenedInApp);

    await clickAndSettle(cta());

    expect(handoffFailed()).not.toBeNull();
    expect(handoff()).toBeNull();
    expect(onOpenedInApp).not.toHaveBeenCalled();
  });
});

describe('Check again feedback and Reopen billing (CAN-5162)', () => {
  const UNCOVERED_COPY =
    "No credits yet. If you've paid, they can take a minute to arrive.";
  const FAILED_COPY = "Couldn't check your balance. Try again in a moment.";

  interface Deferred<T> {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
    readonly reject: (reason: unknown) => void;
  }
  function deferred<T>(): Deferred<T> {
    let resolve: (value: T) => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const ownerA: AiCreditsScopeRequest = {
    kind: 'work',
    projectId: 'project-a',
    chatId: 'chat-a',
  };
  const ownerB: AiCreditsScopeRequest = {
    kind: 'work',
    projectId: 'project-b',
    chatId: 'chat-b',
  };

  function query(testId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }
  function checkAgain(): HTMLButtonElement {
    const el = query('get-ai-credits-cta-check-again');
    if (!(el instanceof HTMLButtonElement)) throw new Error('no Check again');
    return el;
  }
  function feedback(): HTMLElement | null {
    return query('get-ai-credits-cta-check-feedback');
  }
  function reopen(): HTMLButtonElement | null {
    const el = query('get-ai-credits-cta-check-feedback-reopen-billing');
    return el instanceof HTMLButtonElement ? el : null;
  }
  function handedOff(): boolean {
    return query('get-ai-credits-cta-handoff') !== null;
  }

  async function click(target: HTMLElement): Promise<void> {
    await act(async () => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
  }
  async function advance(ms: number): Promise<void> {
    await act(async () => {
      jest.advanceTimersByTime(ms);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
  }
  /**
   * Step past the module-level 60s automatic-probe throttle. The skew only
   * grows, so a probe stamped by an earlier test can never throttle this one.
   */
  let throttleSkew = 0;
  let testStartedAt = 0;
  function pastThrottle(): void {
    throttleSkew += 60 * 60_000;
    jest.setSystemTime(testStartedAt + throttleSkew);
  }

  async function render(
    props: Partial<GetAiCreditsCtaProps> = {},
  ): Promise<void> {
    root ??= createRoot(document.body);
    await act(async () => {
      root?.render(
        createElement(GetAiCreditsCta, {
          label: 'Get AI Credits',
          onCovered: jest.fn(),
          ...props,
        }),
      );
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
  }

  async function renderHandedOff(
    props: Partial<GetAiCreditsCtaProps> = {},
  ): Promise<void> {
    await render(props);
    await click(cta());
    expect(handedOff()).toBe(true);
  }

  /** Forced Check again that lands on a conclusive uncovered read. */
  async function checkUncovered(): Promise<void> {
    loadNativeAiCreditsAvailability.mockResolvedValueOnce(uncovered);
    await click(checkAgain());
    await advance(500);
    expect(feedback()?.textContent).toContain(UNCOVERED_COPY);
  }

  beforeEach(() => {
    testStartedAt = Date.now();
    jest.useFakeTimers({ now: testStartedAt });
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('shows the uncovered result with Reopen billing after the 500 ms minimum', async () => {
    const onCovered = jest.fn();
    await renderHandedOff({ onCovered });

    loadNativeAiCreditsAvailability.mockResolvedValueOnce(uncovered);
    await click(checkAgain());
    // The read already answered, but the check stays visibly busy.
    expect(checkAgain().disabled).toBe(true);
    expect(checkAgain().getAttribute('aria-busy')).toBe('true');
    expect(checkAgain().textContent).toContain('Check again');
    expect(query('get-ai-credits-cta-spinner')).not.toBeNull();
    expect(feedback()).toBeNull();

    await advance(499);
    expect(checkAgain().disabled).toBe(true);
    expect(feedback()).toBeNull();

    await advance(1);
    expect(checkAgain().disabled).toBe(false);
    expect(checkAgain().getAttribute('aria-busy')).toBe('false');
    expect(feedback()?.textContent).toContain(UNCOVERED_COPY);
    expect(feedback()?.getAttribute('data-feedback-kind')).toBe('uncovered');
    expect(reopen()?.textContent).toBe('Reopen billing');
    expect(onCovered).not.toHaveBeenCalled();
    // Block layout: one stable polite region, and the feedback is inside it.
    const region = query('get-ai-credits-cta-check-feedback-region');
    expect(region?.getAttribute('role')).toBe('status');
    expect(region?.contains(feedback())).toBe(true);
  });

  it.each([
    [
      'a rejected read',
      (): void => {
        loadNativeAiCreditsAvailability.mockRejectedValueOnce(
          new Error('down'),
        );
      },
    ],
    [
      'a null read',
      (): void => {
        loadNativeAiCreditsAvailability.mockResolvedValueOnce(null);
      },
    ],
    [
      'an inconclusive read',
      (): void => {
        loadNativeAiCreditsAvailability.mockResolvedValueOnce({
          ...covered,
          inconclusive: true,
        });
      },
    ],
  ])(
    'reports %s as a failed check, without Reopen billing or a commit',
    async (_name, arrange) => {
      const onCovered = jest.fn();
      await renderHandedOff({ onCovered });

      arrange();
      await click(checkAgain());
      expect(feedback()).toBeNull();
      await advance(500);

      expect(feedback()?.textContent).toContain(FAILED_COPY);
      expect(feedback()?.getAttribute('data-feedback-kind')).toBe(
        'check-failed',
      );
      expect(reopen()).toBeNull();
      expect(checkAgain().disabled).toBe(false);
      expect(handedOff()).toBe(true);
      expect(onCovered).not.toHaveBeenCalled();
    },
  );

  it('commits a covered result immediately, once, and clears feedback', async () => {
    const onCovered = jest.fn();
    await renderHandedOff({ onCovered });
    await checkUncovered();

    loadNativeAiCreditsAvailability.mockResolvedValue(covered);
    await click(checkAgain());

    // No minimum hold for a covered read.
    expect(onCovered).toHaveBeenCalledTimes(1);
    expect(handedOff()).toBe(false);
    expect(feedback()).toBeNull();
    await advance(1_000);
    expect(onCovered).toHaveBeenCalledTimes(1);
  });

  it('clears the previous result while a repeated check is pending, then shows it again', async () => {
    await renderHandedOff();
    await checkUncovered();

    loadNativeAiCreditsAvailability.mockResolvedValueOnce(uncovered);
    await click(checkAgain());
    expect(feedback()).toBeNull();
    await advance(500);
    expect(feedback()?.textContent).toContain(UNCOVERED_COPY);

    loadNativeAiCreditsAvailability.mockResolvedValueOnce(null);
    await click(checkAgain());
    await advance(500);
    expect(feedback()?.textContent).toContain(FAILED_COPY);
    loadNativeAiCreditsAvailability.mockResolvedValueOnce(null);
    await click(checkAgain());
    expect(feedback()).toBeNull();
    await advance(500);
    expect(feedback()?.textContent).toContain(FAILED_COPY);
  });

  it('clears a failed verdict for a retry and announces the same failure again', async () => {
    await renderHandedOff();
    const region = query('get-ai-credits-cta-check-feedback-region');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      loadNativeAiCreditsAvailability.mockRejectedValueOnce(
        new Error('offline'),
      );
      await click(checkAgain());
      expect(feedback()).toBeNull();
      expect(query('get-ai-credits-cta-check-feedback-region')).toBe(region);
      await advance(499);
      expect(checkAgain().disabled).toBe(true);
      expect(checkAgain().getAttribute('aria-busy')).toBe('true');
      await advance(1);
      expect(feedback()?.textContent).toBe(FAILED_COPY);
      expect(checkAgain().disabled).toBe(false);
    }
  });

  it('adds no fixed delay after a slow read', async () => {
    await renderHandedOff();
    const read = deferred<typeof uncovered>();
    loadNativeAiCreditsAvailability.mockReturnValueOnce(read.promise);
    await click(checkAgain());

    await advance(800);
    expect(checkAgain().disabled).toBe(true);
    expect(checkAgain().getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      read.resolve(uncovered);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
    expect(feedback()?.textContent).toContain(UNCOVERED_COPY);
    expect(checkAgain().disabled).toBe(false);
  });

  it('starts one read for repeated Check again clicks', async () => {
    await renderHandedOff();
    const reads = loadNativeAiCreditsAvailability.mock.calls.length;
    const read = deferred<typeof uncovered>();
    loadNativeAiCreditsAvailability.mockReturnValueOnce(read.promise);

    await click(checkAgain());
    await click(checkAgain());
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    expect(loadNativeAiCreditsAvailability.mock.calls.length).toBe(reads + 1);

    await act(async () => {
      read.resolve(uncovered);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
    await advance(500);
    expect(feedback()?.textContent).toContain(UNCOVERED_COPY);
  });

  describe('automatic focus and visibility checks', () => {
    it('keep the previous feedback when throttled', async () => {
      await renderHandedOff();
      await checkUncovered();
      const reads = loadNativeAiCreditsAvailability.mock.calls.length;

      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });

      expect(loadNativeAiCreditsAvailability.mock.calls.length).toBe(reads);
      expect(feedback()?.textContent).toContain(UNCOVERED_COPY);
    });

    it.each([
      ['failed', null],
      ['inconclusive', { ...covered, inconclusive: true }],
    ])('stay silent on a %s read', async (_name, result) => {
      await renderHandedOff();
      await checkUncovered();

      pastThrottle();
      loadNativeAiCreditsAvailability.mockResolvedValueOnce(result);
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });

      expect(feedback()?.textContent).toContain(UNCOVERED_COPY);
      expect(checkAgain().disabled).toBe(false);
    });

    it('show a conclusive uncovered read without the minimum hold', async () => {
      await renderHandedOff();
      pastThrottle();
      loadNativeAiCreditsAvailability.mockResolvedValueOnce(uncovered);
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });

      expect(feedback()?.textContent).toContain(UNCOVERED_COPY);
      expect(checkAgain().disabled).toBe(false);
    });

    it('commit a covered read immediately and clear feedback', async () => {
      const onCovered = jest.fn();
      await renderHandedOff({ onCovered });
      await checkUncovered();

      pastThrottle();
      loadNativeAiCreditsAvailability.mockResolvedValue(covered);
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });

      expect(onCovered).toHaveBeenCalledTimes(1);
      expect(feedback()).toBeNull();
      expect(handedOff()).toBe(false);
    });
  });

  describe('Reopen billing', () => {
    it('opens billing once, clears feedback and stays handed off on a web open', async () => {
      const onCovered = jest.fn();
      await renderHandedOff({ onCovered });
      await checkUncovered();
      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);

      const open = deferred<boolean>();
      openAuthenticatedPortalPage.mockReturnValueOnce(open.promise);
      const button = reopen();
      if (!button) throw new Error('no Reopen billing');
      await click(button);
      // Pending: the feedback stays, every conflicting control is inert.
      expect(reopen()?.disabled).toBe(true);
      expect(reopen()?.getAttribute('aria-busy')).toBe('true');
      expect(checkAgain().disabled).toBe(true);
      await click(button);
      const reads = loadNativeAiCreditsAvailability.mock.calls.length;
      pastThrottle();
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      });
      expect(loadNativeAiCreditsAvailability.mock.calls.length).toBe(reads);

      await act(async () => {
        open.resolve(true);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(2);
      expect(feedback()).toBeNull();
      expect(handedOff()).toBe(true);
      expect(checkAgain().disabled).toBe(false);

      // Listeners survive the reopen: the return from the browser still commits.
      pastThrottle();
      loadNativeAiCreditsAvailability.mockResolvedValue(covered);
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
      expect(onCovered).toHaveBeenCalledTimes(1);
    });

    it('releases the hand-off and calls onOpenedInApp last on an in-app open', async () => {
      const onOpenedInApp = jest.fn();
      await renderHandedOff({ onOpenedInApp });
      await checkUncovered();

      mockHostedSettingsOpenable.mockReturnValue(true);
      const button = reopen();
      if (!button) throw new Error('no Reopen billing');
      await click(button);

      expect(openAccountOrganizationSettings).toHaveBeenCalledTimes(1);
      expect(onOpenedInApp).toHaveBeenCalledTimes(1);
      expect(handedOff()).toBe(false);
      expect(feedback()).toBeNull();
      // The latch is released: the primary action works again.
      expect(cta().disabled).toBe(false);
      await click(cta());
      expect(openAccountOrganizationSettings).toHaveBeenCalledTimes(2);
    });

    it('reopens the browser top-up for a browser host while hosted settings are openable (CAN-5159)', async () => {
      const onOpenedInApp = jest.fn();
      await renderHandedOff({ onOpenedInApp, billingDestination: 'browser' });
      await checkUncovered();

      mockHostedSettingsOpenable.mockReturnValue(true);
      const button = reopen();
      if (!button) throw new Error('no Reopen billing');
      await click(button);

      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(2);
      const reopened = new URL(openedPortalPath(1), 'https://billing.invalid');
      expect(reopened.searchParams.get('topUp')).toBe('1');
      expect(reopened.searchParams.get('source')).toBe('banner');
      expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
      expect(onOpenedInApp).not.toHaveBeenCalled();
      expect(handedOff()).toBe(true);
    });

    it('shows the billing-open failure with an enabled primary action when nothing opened', async () => {
      await renderHandedOff();
      await checkUncovered();

      openAuthenticatedPortalPage.mockResolvedValueOnce(false);
      openExternal.mockRejectedValueOnce(new Error('no browser'));
      const button = reopen();
      if (!button) throw new Error('no Reopen billing');
      await click(button);

      expect(handedOff()).toBe(false);
      expect(feedback()).toBeNull();
      expect(query('get-ai-credits-cta-handoff-failed')).not.toBeNull();
      expect(cta().disabled).toBe(false);

      // A later attempt goes through.
      await click(cta());
      expect(handedOff()).toBe(true);
    });

    it('treats a thrown hand-off as a failed open and releases its guards', async () => {
      await renderHandedOff();
      await checkUncovered();

      jest
        .spyOn(openBillingPageModule, 'openBillingPage')
        .mockRejectedValueOnce(new Error('boom'));
      const button = reopen();
      if (!button) throw new Error('no Reopen billing');
      await click(button);

      expect(handedOff()).toBe(false);
      expect(query('get-ai-credits-cta-handoff-failed')).not.toBeNull();
      expect(cta().disabled).toBe(false);
      await click(cta());
      expect(handedOff()).toBe(true);
      expect(feedback()).toBeNull();
    });

    it('returns keyboard focus to Check again when the action disappears', async () => {
      await renderHandedOff();
      await checkUncovered();
      const button = reopen();
      if (!button) throw new Error('no Reopen billing');
      button.focus();
      expect(document.activeElement).toBe(button);

      await click(button);

      expect(reopen()).toBeNull();
      expect(document.activeElement).toBe(checkAgain());
    });
  });

  describe('stale work', () => {
    it.each(['scope change', 'change away and back', 'unmount'])(
      'ignores a connect continuation retained before %s',
      async (invalidation) => {
        const onCovered = jest.fn();
        const account = deferred<{
          hasApiKey: boolean;
          account: { id: string };
          authMode: 'account';
          credentialSource: 'account';
        }>();
        useCloudConnectGateStore.setState({
          requestConnect: realRequestConnect,
        });
        await render({ onCovered, aiCreditsScope: ownerA });
        loadCanopyCloudAccount.mockReturnValueOnce(account.promise);
        await click(cta());

        if (invalidation === 'unmount') {
          act(() => root?.unmount());
          root = null;
        } else {
          await render({ onCovered, aiCreditsScope: ownerB });
          if (invalidation === 'change away and back') {
            await render({ onCovered, aiCreditsScope: ownerA });
          }
        }
        const readsBeforeResume =
          loadNativeAiCreditsAvailability.mock.calls.length;
        await act(async () => {
          account.resolve({
            hasApiKey: true,
            account: { id: 'acct_1' },
            authMode: 'account',
            credentialSource: 'account',
          });
          for (let i = 0; i < 30; i += 1) await Promise.resolve();
        });

        expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
        expect(onCovered).not.toHaveBeenCalled();
        expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(
          readsBeforeResume,
        );
        if (invalidation !== 'unmount') {
          expect(cta().disabled).toBe(false);
          await click(cta());
          expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
        }
      },
    );

    it('ignores a read that settles after the scope changed away and back', async () => {
      const onCovered = jest.fn();
      await renderHandedOff({ onCovered, aiCreditsScope: ownerA });
      const read = deferred<typeof covered>();
      loadNativeAiCreditsAvailability.mockReturnValueOnce(read.promise);
      await click(checkAgain());

      await render({ onCovered, aiCreditsScope: ownerB });
      await render({ onCovered, aiCreditsScope: ownerA });
      await click(cta());
      expect(handedOff()).toBe(true);

      await act(async () => {
        read.resolve(covered);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
      expect(onCovered).not.toHaveBeenCalled();
      expect(handedOff()).toBe(true);
      // The stale completion did not hold or release the new instance's guard.
      expect(checkAgain().disabled).toBe(false);
      await checkUncovered();
    });

    it.each([false, true])(
      'does not open an old hand-off after scope changes away and back (preflight: %s)',
      async (preflight) => {
        await render({
          aiCreditsScope: ownerA,
          ...(preflight ? { onNeedsRecovery: jest.fn() } : {}),
        });
        const read = deferred<typeof uncovered>();
        loadNativeAiCreditsAvailability.mockReturnValueOnce(read.promise);
        await click(cta());
        await render({ aiCreditsScope: ownerB });
        await render({ aiCreditsScope: ownerA });
        await act(async () => {
          read.resolve(uncovered);
          for (let i = 0; i < 30; i += 1) await Promise.resolve();
        });
        expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
        expect(handedOff()).toBe(false);
        expect(cta().disabled).toBe(false);
      },
    );

    it('does not release a newer covered commit when an old host callback refuses', async () => {
      const oldCommit = deferred<boolean>();
      const newCommit = deferred<boolean>();
      const onCovered = jest
        .fn()
        .mockReturnValueOnce(oldCommit.promise)
        .mockReturnValueOnce(newCommit.promise);
      await renderHandedOff({ onCovered, aiCreditsScope: ownerA });
      loadNativeAiCreditsAvailability.mockResolvedValue(covered);
      await click(checkAgain());
      expect(onCovered).toHaveBeenCalledTimes(1);
      await render({ onCovered, aiCreditsScope: ownerB });
      await click(cta());
      expect(onCovered).toHaveBeenCalledTimes(2);
      await act(async () => {
        oldCommit.resolve(false);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
      await click(cta());
      expect(onCovered).toHaveBeenCalledTimes(2);
      await act(async () => {
        newCommit.resolve(true);
        await Promise.resolve();
      });
    });

    it('does not release a later hand-off commit in the same scope', async () => {
      const oldCommit = deferred<boolean>();
      const newCommit = deferred<boolean>();
      const onCovered = jest
        .fn()
        .mockReturnValueOnce(oldCommit.promise)
        .mockReturnValueOnce(newCommit.promise);
      await renderHandedOff({ onCovered });
      loadNativeAiCreditsAvailability.mockResolvedValue(covered);
      await click(checkAgain());
      loadNativeAiCreditsAvailability.mockResolvedValue(uncovered);
      await click(cta());
      expect(handedOff()).toBe(true);
      loadNativeAiCreditsAvailability.mockResolvedValue(covered);
      await click(checkAgain());
      expect(onCovered).toHaveBeenCalledTimes(2);
      await act(async () => {
        oldCommit.resolve(false);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
      await click(cta());
      expect(onCovered).toHaveBeenCalledTimes(2);
      await act(async () => {
        newCommit.resolve(true);
        await Promise.resolve();
      });
    });

    it('keeps a newer check busy when a stale minimum hold is cancelled', async () => {
      await renderHandedOff({ aiCreditsScope: ownerA });
      await click(checkAgain());
      await render({ aiCreditsScope: ownerB });
      await click(cta());
      const read = deferred<typeof uncovered>();
      loadNativeAiCreditsAvailability.mockReturnValueOnce(read.promise);
      await click(checkAgain());
      await advance(500);
      expect(checkAgain().disabled).toBe(true);
      expect(checkAgain().getAttribute('aria-busy')).toBe('true');
      expect(feedback()).toBeNull();
      await act(async () => {
        read.resolve(uncovered);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
      expect(checkAgain().disabled).toBe(false);
      expect(feedback()?.textContent).toContain(UNCOVERED_COPY);
    });

    it('does not commit a read that resolves after unmount', async () => {
      const onCovered = jest.fn();
      await renderHandedOff({ onCovered });
      const read = deferred<typeof covered>();
      loadNativeAiCreditsAvailability.mockReturnValueOnce(read.promise);
      await click(checkAgain());
      act(() => root?.unmount());
      root = null;
      await act(async () => {
        read.resolve(covered);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
      expect(onCovered).not.toHaveBeenCalled();
      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
    });

    it('does not call the settings host after a pending reopen is unmounted', async () => {
      const onOpenedInApp = jest.fn();
      await renderHandedOff({ onOpenedInApp });
      await checkUncovered();
      const open = deferred<openBillingPageModule.BillingPageOpenResult>();
      jest
        .spyOn(openBillingPageModule, 'openBillingPage')
        .mockReturnValueOnce(open.promise);
      const button = reopen();
      if (!button) throw new Error('no Reopen billing');
      await click(button);
      act(() => root?.unmount());
      root = null;
      await act(async () => {
        open.resolve('settings');
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
      expect(onOpenedInApp).not.toHaveBeenCalled();
    });

    it('does not navigate when a reopen is invalidated before its availability resolves', async () => {
      await renderHandedOff({ aiCreditsScope: ownerA });
      await checkUncovered();
      const button = reopen();
      if (!button) throw new Error('no Reopen billing');
      act(() => {
        button.click();
        root?.render(
          createElement(GetAiCreditsCta, {
            label: 'Get AI Credits',
            onCovered: jest.fn(),
            aiCreditsScope: ownerB,
          }),
        );
      });
      await act(async () => {
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
      expect(cta().disabled).toBe(false);
    });

    it('ignores a minimum-hold timer that outlives its scope', async () => {
      await renderHandedOff({ aiCreditsScope: ownerA });
      loadNativeAiCreditsAvailability.mockResolvedValueOnce(uncovered);
      await click(checkAgain());

      await render({ aiCreditsScope: ownerB });
      await click(cta());
      await advance(500);

      expect(feedback()).toBeNull();
      expect(checkAgain().disabled).toBe(false);
    });

    it('does not act on a reopen that settles after the scope changed', async () => {
      await renderHandedOff({ aiCreditsScope: ownerA });
      await checkUncovered();
      const open = deferred<boolean>();
      openAuthenticatedPortalPage.mockReturnValueOnce(open.promise);
      const button = reopen();
      if (!button) throw new Error('no Reopen billing');
      await click(button);

      await render({ aiCreditsScope: ownerB });
      expect(cta().disabled).toBe(false);
      await act(async () => {
        open.resolve(false);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });

      expect(query('get-ai-credits-cta-handoff-failed')).toBeNull();
      expect(handedOff()).toBe(false);
    });

    it('settles quietly when unmounted during the minimum hold', async () => {
      await renderHandedOff();
      loadNativeAiCreditsAvailability.mockResolvedValueOnce(uncovered);
      await click(checkAgain());
      const timersWhileHeld = jest.getTimerCount();

      act(() => {
        root?.unmount();
      });
      root = null;
      // The minimum-hold timer is cancelled with the CTA.
      expect(jest.getTimerCount()).toBe(timersWhileHeld - 1);
      await advance(500);
    });
  });

  describe('compact hosts', () => {
    it('reports the hand-off without calling the host during whole-tree unmount', async () => {
      const reports: (GetAiCreditsHandoffState | null)[] = [];
      const onHandoffChange = jest.fn(
        (next: GetAiCreditsHandoffState | null): void => {
          reports.push(next);
        },
      );
      await renderHandedOff({
        handoffLayout: 'compact',
        onHandoffChange,
      });
      // Waiting: the host explains it and may reopen billing already.
      expect(reports.at(-1)?.feedback).toBeNull();
      expect(typeof reports.at(-1)?.onReopenBilling).toBe('function');
      // The host's copy explains Check again, so it carries no tooltip.
      expect(checkAgain().hasAttribute('title')).toBe(false);
      expect(checkAgain().getAttribute('aria-label')).toBeNull();

      loadNativeAiCreditsAvailability.mockResolvedValueOnce(uncovered);
      await click(checkAgain());
      expect(checkAgain().getAttribute('aria-busy')).toBe('true');
      await advance(500);

      expect(feedback()).toBeNull();
      expect(query('get-ai-credits-cta-check-feedback-region')).toBeNull();
      const latest = reports.at(-1);
      expect(latest?.feedback).toBe('uncovered');
      expect(latest?.reopenPending).toBe(false);
      expect(typeof latest?.onReopenBilling).toBe('function');

      // A host re-render alone does not call back.
      const calls = onHandoffChange.mock.calls.length;
      await render({ handoffLayout: 'compact', onHandoffChange });
      expect(onHandoffChange.mock.calls.length).toBe(calls);

      act(() => {
        root?.unmount();
      });
      root = null;
      expect(onHandoffChange.mock.calls.length).toBe(calls);
    });

    it('leaves Reopen billing out after a failed check', async () => {
      const reports: (GetAiCreditsHandoffState | null)[] = [];
      await renderHandedOff({
        handoffLayout: 'compact',
        onHandoffChange: (next): void => {
          reports.push(next);
        },
      });
      loadNativeAiCreditsAvailability.mockRejectedValueOnce(new Error('down'));
      await click(checkAgain());
      await advance(500);

      expect(reports.at(-1)?.feedback).toBe('check-failed');
      expect(reports.at(-1)?.onReopenBilling).toBeUndefined();
    });
  });

  describe('retained hand-off (CAN-5534)', () => {
    const CHAT_A = { projectId: 'project', worktreeId: 'wt', chatId: 'chat-a' };
    const CHAT_B = { ...CHAT_A, chatId: 'chat-b' };

    function scopeOf(target: typeof CHAT_A): AiCreditsScopeRequest {
      return { kind: 'work', ...target };
    }

    function retainedCta(
      target: typeof CHAT_A,
      dataTestId: string,
      extra: Partial<GetAiCreditsCtaProps> = {},
    ): ReturnType<typeof createElement> {
      return createElement(GetAiCreditsCta, {
        key: dataTestId,
        label: 'Get AI Credits',
        onCovered: jest.fn(),
        aiCreditsScope: scopeOf(target),
        billingDestination: 'browser',
        confirmArrival: 'no-billing-source',
        handoffLayout: 'compact',
        persistHandoffFor: target,
        dataTestId,
        ...extra,
      });
    }

    async function show(
      ...elements: ReturnType<typeof createElement>[]
    ): Promise<void> {
      root ??= createRoot(document.body);
      await act(async () => {
        root?.render(elements);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
    }

    function byTestId(testId: string): HTMLButtonElement | null {
      return document.querySelector<HTMLButtonElement>(
        `[data-testid="${testId}"]`,
      );
    }

    function records(): number {
      return Object.keys(useAiCreditsHandoffStore.getState().records).length;
    }

    function AccountRoot(): null {
      useModelUnlockReturn();
      return null;
    }

    it('rejects a different buyer in the store read after the browser opens', async () => {
      openAuthenticatedPortalPage.mockImplementationOnce(
        (): Promise<boolean> => {
          loadCanopyCloudAccount.mockResolvedValue({
            account: { id: 'acct_2' },
          });
          return Promise.resolve(true);
        },
      );
      await show(retainedCta(CHAT_A, 'cta'));
      await clickAndSettle(byTestId('cta') ?? cta());
      expect(records()).toBe(0);
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
    });

    it('retains the buyer identified before opening when the store identity read fails', async () => {
      openAuthenticatedPortalPage.mockImplementationOnce(
        (): Promise<boolean> => {
          loadCanopyCloudAccount.mockRejectedValue(new Error('offline'));
          return Promise.resolve(true);
        },
      );
      await show(retainedCta(CHAT_A, 'cta'));
      await clickAndSettle(byTestId('cta') ?? cta());
      expect(records()).toBe(1);
      expect(
        Object.values(useAiCreditsHandoffStore.getState().records)[0]
          ?.identityUnverified,
      ).toBe(true);
      loadCanopyCloudAccount.mockResolvedValue({ account: { id: 'acct_1' } });
      await show(
        createElement(AccountRoot, { key: 'account-root' }),
        retainedCta(CHAT_A, 'cta'),
      );
      loadNativeAiCreditsAvailability.mockResolvedValue(covered);
      await clickAndSettle(byTestId('cta-check-again') ?? cta());
      await act(async () => {
        for (let i = 0; i < 30; i++) await Promise.resolve();
      });
      expect(records()).toBe(0);
      expect(useAiCreditsArrivalStore.getState().arrival?.chatId).toBe(
        'chat-a',
      );
      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
    });

    it('keeps the winning arrival when a sibling clicks during the browser open', async () => {
      const opening = deferred<boolean>();
      openAuthenticatedPortalPage.mockReturnValueOnce(opening.promise);
      await show(retainedCta(CHAT_A, 'cta-a'), retainedCta(CHAT_B, 'cta-b'));
      await clickAndSettle(byTestId('cta-a') ?? cta());
      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
      await clickAndSettle(byTestId('cta-b') ?? cta());
      await act(async () => {
        opening.resolve(true);
        for (let i = 0; i < 30; i++) await Promise.resolve();
      });
      loadNativeAiCreditsAvailability.mockResolvedValue(covered);
      await clickAndSettle(byTestId('cta-b-check-again') ?? cta());
      expect(records()).toBe(0);
      expect(useAiCreditsArrivalStore.getState().arrival?.chatId).toBe(
        'chat-a',
      );
      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
    });

    it.each(['check', 'remount'])(
      'recovers an unreadable account on %s without another account-change event',
      async (trigger) => {
        const accountRoot = createElement(AccountRoot, { key: 'account-root' });
        await show(accountRoot, retainedCta(CHAT_A, 'cta'));
        await clickAndSettle(byTestId('cta') ?? cta());
        loadCanopyCloudAccount.mockRejectedValue(new Error('offline'));
        await act(async () => {
          window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
          for (let i = 0; i < 30; i++) await Promise.resolve();
        });
        expect(
          Object.values(useAiCreditsHandoffStore.getState().records)[0]
            ?.identityUnverified,
        ).toBe(true);
        loadCanopyCloudAccount.mockResolvedValue({ account: { id: 'acct_1' } });
        loadNativeAiCreditsAvailability.mockResolvedValue(covered);
        if (trigger === 'check') {
          await clickAndSettle(byTestId('cta-check-again') ?? cta());
        } else {
          await show(accountRoot);
          await show(accountRoot, retainedCta(CHAT_A, 'cta'));
        }
        await act(async () => {
          for (let i = 0; i < 30; i++) await Promise.resolve();
        });
        expect(records()).toBe(0);
        expect(useAiCreditsArrivalStore.getState().arrival?.chatId).toBe(
          'chat-a',
        );
        expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
      },
    );

    it.each([CHAT_A, CHAT_B])(
      'opens one checkout and completes once for mounted CTAs targeting $chatId',
      async (secondTarget) => {
        const onCoveredA = jest.fn();
        const onCoveredB = jest.fn();
        await show(
          retainedCta(CHAT_A, 'cta-a', { onCovered: onCoveredA }),
          retainedCta(secondTarget, 'cta-b', { onCovered: onCoveredB }),
        );
        await act(async () => {
          byTestId('cta-a')?.click();
          byTestId('cta-b')?.click();
          for (let i = 0; i < 30; i += 1) await Promise.resolve();
        });
        expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
        expect(byTestId('cta-a-check-again')).not.toBeNull();
        expect(byTestId('cta-b-check-again')).not.toBeNull();

        // Whichever click won the open owns the arrival; the other CTA finds
        // the credits.
        const [record] = Object.values(
          useAiCreditsHandoffStore.getState().records,
        );
        const originChat = record?.originChatKey?.split('/')[2];
        expect(originChat).toBeDefined();
        const sibling = originChat === 'chat-a' ? 'cta-b' : 'cta-a';
        loadNativeAiCreditsAvailability.mockResolvedValue(covered);
        await act(async () => {
          byTestId(`${sibling}-check-again`)?.click();
          for (let i = 0; i < 30; i += 1) await Promise.resolve();
        });
        expect(records()).toBe(0);
        expect(
          (sibling === 'cta-a' ? onCoveredA : onCoveredB).mock.calls,
        ).toHaveLength(1);
        expect(useAiCreditsArrivalStore.getState().arrival?.chatId).toBe(
          originChat,
        );
        expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      { ...CHAT_A, projectId: 'other-project' },
      { ...CHAT_A, worktreeId: 'other-worktree' },
    ])(
      'restores its purchase after visiting an isolated scope $projectId/$worktreeId',
      async (other) => {
        await show(retainedCta(CHAT_A, 'cta'));
        await clickAndSettle(byTestId('cta') ?? cta());
        await show(retainedCta(other, 'cta'));
        expect(byTestId('cta')).not.toBeNull();
        expect(records()).toBe(1);
        await show(retainedCta(CHAT_A, 'cta'));
        expect(byTestId('cta-check-again')).not.toBeNull();
        expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
      },
    );

    it('restores its purchase after leaving and returning to the navigation context', async () => {
      const original = useWorkspaceContextStore.getState().state;
      try {
        await show(retainedCta(CHAT_A, 'cta'));
        await clickAndSettle(byTestId('cta') ?? cta());
        await act(async () => {
          useWorkspaceContextStore.setState({
            state: {
              ...original,
              context: {
                kind: 'organization',
                organizationId: '11111111-1111-4111-8111-111111111111',
              },
            },
          });
          for (let i = 0; i < 30; i++) await Promise.resolve();
        });
        expect(byTestId('cta')).not.toBeNull();
        expect(records()).toBe(1);
        await act(async () => {
          useWorkspaceContextStore.setState({ state: original });
          for (let i = 0; i < 30; i++) await Promise.resolve();
        });
        expect(byTestId('cta-check-again')).not.toBeNull();
        expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
      } finally {
        act(() => {
          useWorkspaceContextStore.setState({ state: original });
        });
      }
    });

    it('survives an unmount and finds credits on remount without Check again', async () => {
      await show(retainedCta(CHAT_A, 'cta-a'));
      await clickAndSettle(byTestId('cta-a') ?? cta());
      await show();
      expect(records()).toBe(1);

      loadNativeAiCreditsAvailability.mockResolvedValue(covered);
      await show(retainedCta(CHAT_A, 'cta-a'));
      await act(async () => {
        for (let i = 0; i < 30; i += 1) await Promise.resolve();
      });
      expect(records()).toBe(0);
      expect(useAiCreditsArrivalStore.getState().arrival?.chatId).toBe(
        'chat-a',
      );
    });

    it('preserves the explicit failed-check feedback through an uncovered background return', async () => {
      await show(retainedCta(CHAT_A, 'cta-a'));
      await clickAndSettle(byTestId('cta-a') ?? cta());
      loadNativeAiCreditsAvailability.mockResolvedValueOnce(null);
      await clickAndSettle(byTestId('cta-a-check-again') ?? cta());
      await advance(500);
      const pendingFeedback = (): string | null | undefined =>
        Object.values(useAiCreditsHandoffStore.getState().records)[0]?.feedback;
      expect(pendingFeedback()).toBe('check-failed');
      await advance(61_000);
      loadNativeAiCreditsAvailability.mockResolvedValue(uncovered);
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        for (let i = 0; i < 30; i++) await Promise.resolve();
      });
      expect(pendingFeedback()).toBe('check-failed');
    });

    it('keeps the hand-off when Reopen billing fails or opens Settings', async () => {
      const reports: (GetAiCreditsHandoffState | null)[] = [];
      await show(
        retainedCta(CHAT_A, 'cta-a', {
          onHandoffChange: (state) => reports.push(state),
        }),
      );
      await clickAndSettle(byTestId('cta-a') ?? cta());
      const spy = jest
        .spyOn(openBillingPageModule, 'openBillingPage')
        .mockResolvedValueOnce('failed')
        .mockResolvedValueOnce('settings');
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await act(async () => {
            reports.at(-1)?.onReopenBilling?.();
            for (let i = 0; i < 30; i += 1) await Promise.resolve();
          });
          expect(records()).toBe(1);
          expect(byTestId('cta-a-check-again')).not.toBeNull();
          // The retry is released.
          expect(reports.at(-1)?.reopenPending).toBe(false);
        }
      } finally {
        spy.mockRestore();
      }
    });

    it('rechecks after identity verification even when an older check is still pending', async () => {
      const onCovered = jest.fn();
      await show(retainedCta(CHAT_A, 'cta', { onCovered }));
      await clickAndSettle(byTestId('cta') ?? cta());
      const old = deferred<typeof uncovered>();
      loadNativeAiCreditsAvailability.mockReturnValueOnce(old.promise);
      await clickAndSettle(byTestId('cta-check-again') ?? cta());
      act(() => {
        suspendAiCreditsHandoffAccount();
      });
      loadNativeAiCreditsAvailability.mockResolvedValue(covered);
      await act(async () => {
        reconcileAiCreditsHandoffAccount({
          kind: 'account',
          key: 'account:acct_1',
        });
        for (let i = 0; i < 30; i++) await Promise.resolve();
      });
      expect(records()).toBe(0);
      expect(onCovered).toHaveBeenCalledTimes(1);
      await act(async () => {
        old.resolve(uncovered);
        for (let i = 0; i < 30; i++) await Promise.resolve();
      });
      expect(records()).toBe(0);
      expect(onCovered).toHaveBeenCalledTimes(1);
    });

    it('does not open checkout after the account changes during the initial coverage read', async () => {
      await show(retainedCta(CHAT_A, 'cta'));
      const read = deferred<typeof uncovered>();
      loadNativeAiCreditsAvailability.mockReturnValueOnce(read.promise);
      await clickAndSettle(byTestId('cta') ?? cta());
      await act(async () => {
        suspendAiCreditsHandoffAccount();
        read.resolve(uncovered);
        for (let i = 0; i < 30; i++) await Promise.resolve();
      });
      expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
      expect(records()).toBe(0);
      expect(byTestId('cta')?.disabled).toBe(false);
    });

    it('attaches nothing when the first open settles after the chat changed', async () => {
      let finishOpen: (opened: boolean) => void = () => {};
      openAuthenticatedPortalPage.mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          finishOpen = resolve;
        }),
      );
      await show(retainedCta(CHAT_A, 'cta'));
      await clickAndSettle(byTestId('cta') ?? cta());
      await show(retainedCta({ ...CHAT_A, worktreeId: 'other' }, 'cta'));
      await act(async () => {
        finishOpen(true);
        for (let i = 0; i < 30; i += 1) await Promise.resolve();
      });
      expect(records()).toBe(0);
      expect(byTestId('cta')).not.toBeNull();
    });
  });
});
