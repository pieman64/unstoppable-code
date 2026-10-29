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
import { GetAiCreditsCta } from '../GetAiCreditsCta';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import {
  invalidateSharedAiCreditsRead,
  resetSettingsCloseRereadForTests,
} from '@/lib/openBillingPage';
import type { AiCreditsScopeRequest } from '@canopy/desktop-shared/types';
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

const realOpenAccountOrganizationSettings =
  useNavigationStore.getState().openAccountOrganizationSettings;
const openAccountOrganizationSettings = jest.fn<
  void,
  [SettingsRoute, unknown?]
>();

let root: Root | null = null;

const loadNativeAiCreditsAvailability = jest.fn();
const loadCanopyCloudAccount = jest.fn();
const openAuthenticatedPortalPage = jest.fn();
const openExternal = jest.fn();

function stubApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      loadNativeAiCreditsAvailability,
      loadCanopyCloudAccount,
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

async function renderCta(
  onCovered: () => void,
  onNeedsRecovery?: () => void,
  aiCreditsScope?: AiCreditsScopeRequest,
  onOpenedInApp?: () => void,
): Promise<void> {
  root ??= createRoot(document.body);
  await act(async () => {
    root?.render(
      createElement(GetAiCreditsCta, {
        label: 'Get AI Credits',
        onCovered,
        ...(onNeedsRecovery ? { onNeedsRecovery } : {}),
        ...(aiCreditsScope ? { aiCreditsScope } : {}),
        ...(onOpenedInApp ? { onOpenedInApp } : {}),
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
  document.body.innerHTML = '';
  useNavigationStore.setState({
    openAccountOrganizationSettings: realOpenAccountOrganizationSettings,
  });
});

describe('GetAiCreditsCta', () => {
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

    // Still uncovered — Check again must NOT commit.
    await act(async () => {
      document
        .querySelector('[data-testid="get-ai-credits-cta-check-again"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
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
