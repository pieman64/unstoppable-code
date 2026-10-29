/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyApi,
  CanopyCloudAccountPublicState,
  CanopyCloudAiCreditsState,
} from '@canopy/desktop-shared/types';
import type { SubscriptionStatus } from '@canopy/desktop-shared/lib/subscription-status';
import { AiCreditsUsageCard } from '../AiCreditsUsageCard';
import {
  expectReplayBlocksOnlyValue,
  outermostReplayBlock,
} from '@/test-utils/replay';
import {
  invalidateAiCreditsUsageCache,
  refreshAiCreditsUsage,
} from '@/hooks/useAiCreditsUsage';
import { brandText } from '@/lib/brand';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';

const mockOpenSettingsPathOrWeb = jest.fn<'settings' | 'web', [string]>();
jest.mock('@/lib/navigation/settings-destinations', () => ({
  openSettingsPathOrWeb: (path: string): 'settings' | 'web' =>
    mockOpenSettingsPathOrWeb(path),
}));

// The card now reads the native plan from useSubscriptionStatus (not the UD
// subscription on the credits state); mock it so each test controls the plan.
let mockStatus: SubscriptionStatus | null = null;
let mockPlanLoading = false;
let mockFreeAccess = false;
jest.mock('@/hooks/useSubscriptionStatus', () => ({
  useSubscriptionStatus: (): {
    status: SubscriptionStatus | null;
    loading: boolean;
    freeAccess: boolean;
  } => ({
    status: mockStatus,
    loading: mockPlanLoading,
    freeAccess: mockFreeAccess,
  }),
}));

const PAID_STATUS: SubscriptionStatus = {
  kind: 'paid',
  label: 'Pro',
  tone: 'positive',
};

// Legacy org-seat fallback: servers that omit `displayPlan` project to
// `kind: 'org'` with a NEUTRAL tone even though the plan is active. The pill
// must key off `kind`, not `tone`, or these users lose the active chip.
const ORG_SEAT_LEGACY_STATUS: SubscriptionStatus = {
  kind: 'org',
  label: 'Team',
  tone: 'neutral',
};

// A RESOLVED free plan. Distinct from `status === null`, which means
// entitlements have not resolved (loading / failed / billing flag off) and must
// not be rendered as a "Free" claim.
const FREE_STATUS: SubscriptionStatus = {
  kind: 'free',
  label: 'Free',
  tone: 'neutral',
};

// Native balance present → card renders. subscription/noUdAccount fields remain
// on the type but are no longer read by the card.
const FUNDED_STATE: CanopyCloudAiCreditsState = {
  connected: true,
  email: 'alice@example.com',
  subscription: null,
  balance: { email: 'alice@example.com', credits: 1234, eligible: true },
  noUdAccount: false,
  error: null,
};

const ZERO_BALANCE_STATE: CanopyCloudAiCreditsState = {
  ...FUNDED_STATE,
  balance: { email: 'alice@example.com', credits: 0, eligible: true },
};

/** Personal wallet empty, org pool covering — see `resolveAiCreditsFundingSource`. */
const ORG_FUNDED_STATE: CanopyCloudAiCreditsState = {
  ...FUNDED_STATE,
  balance: {
    email: 'alice@example.com',
    credits: 0,
    eligible: false,
    orgPool: { orgId: 'org_1', orgName: 'Acme' },
  },
};

const NO_BALANCE_STATE: CanopyCloudAiCreditsState = {
  ...FUNDED_STATE,
  balance: null,
};

const ERROR_STATE: CanopyCloudAiCreditsState = {
  ...FUNDED_STATE,
  error: 'transient failure',
};

const GUEST_STATE: CanopyCloudAiCreditsState = {
  ...FUNDED_STATE,
  email: 'guest+32bce771-85a6-4535-b0c3-15eab9be71e1@guest.canopy.invalid',
};

// Real signed-in account whose balance payload carries no email. The auth word
// must come from the credential, not from the presence of `email`.
const NO_EMAIL_STATE: CanopyCloudAiCreditsState = {
  ...FUNDED_STATE,
  email: null,
};

const GUEST_ACCOUNT: CanopyCloudAccountPublicState = {
  hasApiKey: false,
  authMode: 'guest',
  credentialSource: 'guest',
  capabilities: [],
  storageAvailable: true,
  account: {
    id: 'guest-1',
    name: 'Guest',
    email: 'guest+32bce771-85a6-4535-b0c3-15eab9be71e1@guest.canopy.invalid',
    role: 'DEVELOPER',
  },
};

describe('AiCreditsUsageCard', () => {
  let container: HTMLElement;
  let root: Root;
  const loadCanopyCloudAiCredits = jest.fn();
  const loadPreferences = jest.fn();
  const loadCanopyCloudAccount = jest.fn();

  const NON_GUEST_ACCOUNT: CanopyCloudAccountPublicState = {
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    capabilities: [],
    storageAvailable: true,
    account: {
      id: 'user-1',
      name: 'Alice',
      email: 'alice@example.com',
      role: 'DEVELOPER',
    },
  };

  beforeEach(() => {
    mockStatus = PAID_STATUS;
    mockPlanLoading = false;
    mockFreeAccess = false;
    // Drop the module-level cache so each test reads its own mock state.
    invalidateAiCreditsUsageCache();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    loadCanopyCloudAiCredits.mockResolvedValue(FUNDED_STATE);
    loadPreferences.mockResolvedValue({ aiCreditsRoutingMode: 'on' });
    loadCanopyCloudAccount.mockResolvedValue(NON_GUEST_ACCOUNT);
    Object.assign(window, {
      api: {
        loadCanopyCloudAiCredits,
        loadPreferences,
        loadCanopyCloudAccount,
      } as Partial<CanopyApi> as CanopyApi,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
    invalidateAiCreditsUsageCache();
    useWorkspaceContextStore.setState(
      useWorkspaceContextStore.getInitialState(),
      true,
    );
  });

  async function render(frameless = false): Promise<void> {
    act(() => {
      root.render(<AiCreditsUsageCard frameless={frameless} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function findByTestId(id: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${id}"]`);
  }

  it('renders the native plan chip and balance when funded', async () => {
    await render();
    expect(findByTestId('usage-card-ai-credits')).not.toBeNull();
    expect(findByTestId('usage-card-ai-credits-plan-chip')?.textContent).toBe(
      'Pro',
    );
    expect(
      findByTestId('usage-card-ai-credits-balance')?.textContent,
    ).toContain('1,234 credits');
  });

  it('shows a grey Free chip for a resolved free plan', async () => {
    mockStatus = FREE_STATUS;
    await render();
    const chip = findByTestId('usage-card-ai-credits-plan-chip');
    expect(chip?.textContent).toBe('Free');
    // muted (grey) variant, not the green success palette.
    expect(chip?.className).not.toContain('success');
  });

  it('keeps the active chip for a legacy org-seat plan with a neutral tone', async () => {
    // Regression guard: keying the chip off `tone` instead of `kind` would
    // render this active org subscription as grey (older servers omit
    // `displayPlan`, so `computeSubscriptionStatus` returns a neutral tone).
    mockStatus = ORG_SEAT_LEGACY_STATUS;
    await render();
    const chip = findByTestId('usage-card-ai-credits-plan-chip');
    expect(chip?.textContent).toBe('Team');
    expect(chip?.className).toContain('success');
  });

  it('renders no plan chip until entitlements resolve', async () => {
    // `status === null` covers both a request still in flight and one that
    // failed. Neither justifies claiming "Free" — a paying user would other-
    // wise see a grey Free pill flash on load, or permanently when offline.
    mockStatus = null;
    await render();
    expect(findByTestId('usage-card-ai-credits')).not.toBeNull();
    expect(findByTestId('usage-card-ai-credits-plan-chip')).toBeNull();
  });

  it('omits the plan chip under free access, even with a plan still known', async () => {
    // Free access names no plan. The chip must not depend on the hook having
    // already cleared `status`: a held Pro status alongside `freeAccess` (for
    // example while a refresh is settling) still renders no chip.
    mockFreeAccess = true;
    mockStatus = PAID_STATUS;
    await render();
    expect(findByTestId('usage-card-ai-credits')).not.toBeNull();
    expect(findByTestId('usage-card-ai-credits-plan-chip')).toBeNull();
    expect(container.textContent).not.toContain('Pro');
    // The balance still renders: credits stay purchasable and usable.
    expect(
      findByTestId('usage-card-ai-credits-balance')?.textContent,
    ).toContain('1,234 credits');
  });

  it('omits the Free chip under free access', async () => {
    mockFreeAccess = true;
    mockStatus = FREE_STATUS;
    await render();
    expect(findByTestId('usage-card-ai-credits-plan-chip')).toBeNull();
    expect(container.textContent).not.toContain('Free');
  });

  it('does not gate the plan chip on the hook loading flag', async () => {
    // Regression guard: the card must read `status` only. Re-introducing a
    // `loading` gate would blank the pill on every account-changed refresh
    // (the hook keeps the previous entitlements, so the plan stays known) and
    // would also mis-handle a failed request, where `loading` goes false.
    // This fails if someone re-adds that gate.
    mockStatus = PAID_STATUS;
    mockPlanLoading = true;
    await render();
    expect(findByTestId('usage-card-ai-credits-plan-chip')?.textContent).toBe(
      'Pro',
    );
  });

  it('names the heading for screen readers even though the logo is aria-hidden', async () => {
    await render();
    expect(container.querySelector('h2')?.getAttribute('aria-label')).toBe(
      `${brandText.appName} AI Credits`,
    );
  });

  it('shows the native cloud-account email', async () => {
    await render();
    expect(
      findByTestId('usage-card-ai-credits-account')?.textContent,
    ).toContain('alice@example.com');
  });

  it('emphasizes the email like the provider cards do', async () => {
    await render();
    const row = findByTestId('usage-card-ai-credits-account');
    expect(row?.textContent).toContain('Account: ');
    const emphasized = row?.querySelector('span');
    expect(emphasized?.textContent).toBe('alice@example.com');
    expect(emphasized?.className).toContain('font-medium');
    expect(emphasized?.className).toContain('fg-primary');
  });

  it('blocks only the account email from session replay', async () => {
    await render();
    const row = findByTestId('usage-card-ai-credits-account');
    expect(row?.textContent).toBe('Account: alice@example.com');
    expect(outermostReplayBlock(row)).toBeNull();
    expectReplayBlocksOnlyValue(container, 'alice@example.com');
  });

  it('drops the "Account:" prefix when frameless, matching the provider row', async () => {
    await render(true);
    const row = findByTestId('usage-card-ai-credits-account');
    expect(row?.textContent).toBe('alice@example.com');
    expect(row?.querySelector('span')?.className).toContain('font-medium');
  });

  it('uses the brand app name as the card title (no "Unstoppable Domains")', async () => {
    await render();
    expect(container.querySelector('h2')?.textContent).toContain(
      brandText.appName,
    );
    expect(container.textContent).not.toContain('Unstoppable Domains');
  });

  it('renders the auth word as plain text next to the plan pill', async () => {
    await render();
    expect(container.textContent).toContain('authenticated');
  });

  it('still reads authenticated when the balance payload has no email', async () => {
    // The auth word is driven by the credential, so a real signed-in account
    // with no email on the payload must not be labelled a guest.
    loadCanopyCloudAiCredits.mockResolvedValue(NO_EMAIL_STATE);
    await render();
    expect(container.textContent).toContain('authenticated');
    expect(container.textContent).not.toContain('guest');
    // No email → no "Account:" line, but the card still renders.
    expect(findByTestId('usage-card-ai-credits-account')).toBeNull();
  });

  it('still renders for a native-billed user with 0 credits', async () => {
    loadCanopyCloudAiCredits.mockResolvedValue(ZERO_BALANCE_STATE);
    await render();
    expect(findByTestId('usage-card-ai-credits')).not.toBeNull();
    expect(
      findByTestId('usage-card-ai-credits-balance')?.textContent,
    ).toContain('0 credits');
  });

  it('names the covering org and keeps the personal zero as a secondary line', async () => {
    // The Usage page is an itemized detail view, so it shows both facts. The
    // headline names the payer; the zero stays, labelled as the personal wallet
    // it actually describes, instead of masquerading as the session balance.
    loadCanopyCloudAiCredits.mockResolvedValue(ORG_FUNDED_STATE);
    await render();
    expect(findByTestId('usage-card-ai-credits-balance')?.textContent).toBe(
      'Covered by Acme',
    );
    expect(
      findByTestId('usage-card-ai-credits-personal-balance')?.textContent,
    ).toBe('Personal balance: 0 credits');
    // Not painted red: an org-covered session is healthy, not exhausted.
    expect(findByTestId('usage-card-ai-credits-balance')?.className).not.toBe(
      'fg-destructive',
    );
  });

  it('shows no coverage line for a user with no org pool', async () => {
    loadCanopyCloudAiCredits.mockResolvedValue(ZERO_BALANCE_STATE);
    await render();
    expect(findByTestId('usage-card-ai-credits-personal-balance')).toBeNull();
    expect(
      findByTestId('usage-card-ai-credits-balance')?.textContent,
    ).toContain('0 credits');
  });

  it('does not render a guest synthetic email as the account (CAN-936)', async () => {
    loadCanopyCloudAiCredits.mockResolvedValue(GUEST_STATE);
    loadCanopyCloudAccount.mockResolvedValue(GUEST_ACCOUNT);
    await render();
    expect(findByTestId('usage-card-ai-credits')).not.toBeNull();
    expect(findByTestId('usage-card-ai-credits-account')).toBeNull();
    expect(container.textContent).not.toContain('guest.canopy.invalid');
    // The auth word still reflects the credential for the true-guest path.
    expect(container.textContent).toContain('guest');
  });

  describe('Manage', () => {
    const ACME = '11111111-1111-4111-8111-111111111111';

    function seedContext(role: 'OWNER' | 'ADMIN' | 'MEMBER' | null): void {
      useWorkspaceContextStore.setState({
        state: {
          context:
            role === null
              ? { kind: 'personal' }
              : { kind: 'organization', organizationId: ACME },
          revision: 1,
          organizations:
            role === null ? [] : [{ id: ACME, name: 'Acme', role }],
        },
        hydrated: true,
      });
    }

    function setBillingEnabled(enabled: boolean): void {
      useFeatureFlagsStore.setState({
        snapshot: {
          ...getDefaultFeatureFlagSnapshot(),
          values: {
            ...getDefaultFeatureFlagSnapshot().values,
            [CLIENT_FEATURE_FLAGS.canopyBillingEnabled.key]: enabled,
          },
        },
      });
    }

    beforeEach(() => {
      setBillingEnabled(true);
    });

    afterEach(() => {
      useFeatureFlagsStore.setState(
        useFeatureFlagsStore.getInitialState(),
        true,
      );
    });

    it("opens the selected organization's billing for its OWNER", async () => {
      seedContext('OWNER');
      await render();
      act(() => findByTestId('usage-card-ai-credits-manage')?.click());
      expect(mockOpenSettingsPathOrWeb).toHaveBeenCalledWith(
        `/organization/${ACME}/settings?tab=billing`,
      );
    });

    it.each(['ADMIN', 'MEMBER', null] as const)(
      'opens account billing for %p',
      async (role) => {
        seedContext(role);
        await render();
        act(() => findByTestId('usage-card-ai-credits-manage')?.click());
        expect(mockOpenSettingsPathOrWeb).toHaveBeenCalledWith(
          '/account/billing',
        );
      },
    );

    it('is hidden until the selected context is known', async () => {
      await render();
      expect(findByTestId('usage-card-ai-credits')).not.toBeNull();
      expect(findByTestId('usage-card-ai-credits-manage')).toBeNull();
    });

    it('is hidden when billing is off', async () => {
      seedContext('OWNER');
      setBillingEnabled(false);
      await render();
      expect(findByTestId('usage-card-ai-credits')).not.toBeNull();
      expect(findByTestId('usage-card-ai-credits-manage')).toBeNull();
    });

    it('is hidden for a guest', async () => {
      seedContext(null);
      loadCanopyCloudAiCredits.mockResolvedValue(GUEST_STATE);
      loadCanopyCloudAccount.mockResolvedValue(GUEST_ACCOUNT);
      await render();
      expect(findByTestId('usage-card-ai-credits')).not.toBeNull();
      expect(findByTestId('usage-card-ai-credits-manage')).toBeNull();
    });
  });

  it('renders nothing when there is no native balance', async () => {
    loadCanopyCloudAiCredits.mockResolvedValue(NO_BALANCE_STATE);
    await render();
    expect(findByTestId('usage-card-ai-credits')).toBeNull();
  });

  it('shows a friendly error notice with retry instead of vanishing on a transient error', async () => {
    loadCanopyCloudAiCredits.mockResolvedValue({
      ...ERROR_STATE,
      balance: null,
    });
    await render();

    expect(findByTestId('usage-card-ai-credits')).not.toBeNull();
    const notice = findByTestId('usage-card-ai-credits-error');
    expect(notice).not.toBeNull();
    // The raw transport message stays out of the headline.
    expect(notice?.textContent).not.toContain('transient failure');

    const initialLoads = loadCanopyCloudAiCredits.mock.calls.length;
    const retry = findByTestId('usage-card-ai-credits-error-retry');
    expect(retry).not.toBeNull();
    await act(async () => {
      retry?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadCanopyCloudAiCredits.mock.calls.length).toBeGreaterThan(
      initialLoads,
    );
  });

  it("keeps the same account's last-known balance after a failed refresh", async () => {
    await render();

    expect(
      findByTestId('usage-card-ai-credits-balance')?.textContent,
    ).toContain('1,234 credits');

    loadCanopyCloudAiCredits.mockResolvedValue({
      ...ERROR_STATE,
      balance: null,
    });
    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh AI Credits usage"]',
    );
    await act(async () => {
      refresh?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findByTestId('usage-card-ai-credits-error')).not.toBeNull();
    expect(
      findByTestId('usage-card-ai-credits-balance')?.textContent,
    ).toContain('1,234 credits');
  });

  it("keeps the same account's org funding attribution after a failed refresh", async () => {
    loadCanopyCloudAiCredits.mockResolvedValue(ORG_FUNDED_STATE);
    await render();

    expect(findByTestId('usage-card-ai-credits-balance')?.textContent).toBe(
      'Covered by Acme',
    );

    loadCanopyCloudAiCredits.mockResolvedValue({
      ...ORG_FUNDED_STATE,
      balance: null,
      error: 'transient failure',
    });
    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh AI Credits usage"]',
    );
    await act(async () => {
      refresh?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findByTestId('usage-card-ai-credits-error')).not.toBeNull();
    expect(findByTestId('usage-card-ai-credits-balance')?.textContent).toBe(
      'Covered by Acme',
    );
    expect(
      findByTestId('usage-card-ai-credits-personal-balance')?.textContent,
    ).toBe('Personal balance: 0 credits');
    expect(container.textContent).not.toContain('Remaining: 0 credits');
  });

  it('does not carry a balance across accounts after a failed refresh', async () => {
    await render();

    loadCanopyCloudAiCredits.mockResolvedValue({
      ...ERROR_STATE,
      email: 'bob@example.com',
      balance: null,
    });
    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh AI Credits usage"]',
    );
    await act(async () => {
      refresh?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findByTestId('usage-card-ai-credits-error')).not.toBeNull();
    expect(findByTestId('usage-card-ai-credits-balance')).toBeNull();
  });

  it('renders nothing on an error when no cloud account is connected', async () => {
    loadCanopyCloudAiCredits.mockResolvedValue({
      ...ERROR_STATE,
      connected: false,
      balance: null,
    });
    await render();
    expect(findByTestId('usage-card-ai-credits')).toBeNull();
  });

  it('refreshAiCreditsUsage re-reads a fresh cache without blanking the card', async () => {
    await render();
    const loadsBefore = loadCanopyCloudAiCredits.mock.calls.length;
    loadCanopyCloudAiCredits.mockResolvedValue({
      ...FUNDED_STATE,
      balance: { ...FUNDED_STATE.balance, credits: 999 },
    });

    act(() => refreshAiCreditsUsage());

    // The last balance stays on screen while the re-read runs.
    expect(
      findByTestId('usage-card-ai-credits-balance')?.textContent,
    ).toContain('1,234 credits');
    expect(loadCanopyCloudAiCredits.mock.calls.length).toBe(loadsBefore + 1);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      findByTestId('usage-card-ai-credits-balance')?.textContent,
    ).toContain('999 credits');
  });

  it('refreshAiCreditsUsage reuses a read that is already in flight', () => {
    act(() => {
      root.render(<AiCreditsUsageCard />);
    });
    const loadsBefore = loadCanopyCloudAiCredits.mock.calls.length;
    expect(loadsBefore).toBeGreaterThan(0);

    act(() => refreshAiCreditsUsage());

    expect(loadCanopyCloudAiCredits.mock.calls.length).toBe(loadsBefore);
  });
});
