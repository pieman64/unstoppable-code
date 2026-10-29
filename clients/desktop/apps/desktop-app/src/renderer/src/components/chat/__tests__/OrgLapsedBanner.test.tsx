/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyOrgBillingState } from '@canopy/protocol/canopy-server';
import type {
  AiCreditsScopeRequest,
  CanopyCloudAccountPublicState,
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { OrgLapsedBanner } from '../OrgLapsedBanner';

const mockOpenSettingsPathOrWeb = jest.fn<'settings' | 'web', [string]>();
jest.mock('@/lib/navigation/settings-destinations', () => ({
  openSettingsPathOrWeb: (path: string): 'settings' | 'web' =>
    mockOpenSettingsPathOrWeb(path),
}));

function native(
  overrides: Partial<NativeAiCreditsAvailability> = {},
): NativeAiCreditsAvailability {
  return {
    personalEligible: false,
    inOrg: true,
    orgCreditPoolCovered: false,
    orgSpendable: false,
    pricingUrl: 'https://cloud.example.com/pricing',
    // The chat is owned by the lapsed org unless a case says otherwise
    // (CAN-3463: only the owner org's lapse can cost this turn anything).
    ownerOrganization: { id: 'org-lapsed', name: 'Acme' },
    ...overrides,
  };
}

function account(
  orgBillingStates: CanopyOrgBillingState[],
  role?: 'OWNER' | 'ADMIN' | 'MEMBER',
): CanopyCloudAccountPublicState {
  return {
    ...(role
      ? {
          organizations: [
            {
              id: 'org-lapsed',
              name: 'Acme',
              role,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }
      : {}),
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth',
    capabilities: [],
    storageAvailable: true,
    orgBillingStates,
    account: {
      id: 'acct_1',
      name: 'Test User',
      email: 'test@example.com',
      role: 'DEVELOPER',
    },
  };
}

const LAPSED: CanopyOrgBillingState = {
  organizationId: 'org-lapsed',
  organizationName: 'Acme',
  teamsEntitled: false,
  trialEndedAt: '2026-05-01T00:00:00.000Z',
};

const HEALTHY: CanopyOrgBillingState = {
  organizationId: 'org-healthy',
  organizationName: 'Globex',
  teamsEntitled: true,
};

async function flushAsyncEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('OrgLapsedBanner (CAN-2311)', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const loadCanopyCloudAccount = jest.fn<
    Promise<CanopyCloudAccountPublicState | null>,
    []
  >();
  const loadNativeAiCreditsAvailability = jest.fn<
    Promise<NativeAiCreditsAvailability>,
    [AiCreditsScopeRequest?]
  >();

  const onVisibleChange = jest.fn<void, [boolean]>();

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    loadCanopyCloudAccount.mockReset();
    loadNativeAiCreditsAvailability.mockReset();
    onVisibleChange.mockReset();
    loadCanopyCloudAccount.mockResolvedValue(account([]));
    loadNativeAiCreditsAvailability.mockResolvedValue(native());

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { loadCanopyCloudAccount, loadNativeAiCreditsAvailability },
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  async function render(
    provider: 'claude' | 'codex' = 'claude',
    extra: { nativeAuth?: boolean; availabilityLoading?: boolean } = {},
  ): Promise<void> {
    await act(async () => {
      root.render(
        <OrgLapsedBanner
          provider={provider}
          {...extra}
          onVisibleChange={onVisibleChange}
        />,
      );
      await flushAsyncEffects();
    });
  }

  function banner(): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      '[data-testid="chat-input-org-lapsed-banner"]',
    );
  }

  /** Broadcast the same account-changed event the sign-in / refresh paths fire. */
  async function accountChanged(): Promise<void> {
    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      await flushAsyncEffects();
    });
  }

  function dismiss(): void {
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-org-lapsed-dismiss"]',
    );
    act(() => {
      button?.click();
    });
  }

  it('names the lapsed org and points at the org admin', async () => {
    loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
    await render();

    expect(banner()).not.toBeNull();
    expect(banner()?.textContent).toContain('Acme has no active plan');
    expect(banner()?.textContent).toContain(
      'contact your org admin to restore your team.',
    );
  });

  describe('Open billing', () => {
    function openBilling(): HTMLButtonElement | null {
      return container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-input-org-lapsed-open-billing"]',
      );
    }

    beforeEach(() => {
      mockOpenSettingsPathOrWeb.mockReset().mockReturnValue('settings');
    });

    it('lets the OWNER open the organization billing', async () => {
      loadCanopyCloudAccount.mockResolvedValue(account([LAPSED], 'OWNER'));
      await render();
      expect(banner()?.textContent).toContain(
        'open billing to restore your team.',
      );
      expect(
        container.querySelector(
          '[data-testid="chat-input-org-lapsed-contact-admin"]',
        ),
      ).toBeNull();
      act(() => openBilling()?.click());
      expect(mockOpenSettingsPathOrWeb).toHaveBeenCalledWith(
        '/organization/org-lapsed/settings?tab=billing',
      );
    });

    // Only an OWNER can choose a plan; an ADMIN's billing view is read-only,
    // so offering it the button would promise a fix it cannot make.
    it.each(['ADMIN', 'MEMBER'] as const)(
      'points an %s at the org admin instead',
      async (role) => {
        loadCanopyCloudAccount.mockResolvedValue(account([LAPSED], role));
        await render();
        expect(banner()).not.toBeNull();
        expect(openBilling()).toBeNull();
        expect(banner()?.textContent).toContain(
          'contact your org admin to restore your team.',
        );
      },
    );

    it('drops the button once the lapse clears', async () => {
      loadCanopyCloudAccount.mockResolvedValue(account([LAPSED], 'OWNER'));
      await render();
      expect(openBilling()).not.toBeNull();
      loadCanopyCloudAccount.mockResolvedValue(account([HEALTHY], 'OWNER'));
      await accountChanged();
      expect(banner()).toBeNull();
      loadCanopyCloudAccount.mockResolvedValue(account([LAPSED], 'MEMBER'));
      await accountChanged();
      expect(banner()).not.toBeNull();
      expect(openBilling()).toBeNull();
    });
  });

  it('states the billing fact once (CAN-2590)', async () => {
    // The opener already says the org has no active plan. The continuation
    // used to restate it ("Its billing is on hold, so ..."), so the banner
    // spent two consecutive sentences on the same fact before reaching the
    // consequence the reader is actually being told about.
    loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
    await render();

    const text = banner()?.textContent ?? '';
    expect(text).not.toContain('on hold');
    expect(text).toContain(
      'Its paused credit pool is not paying for this chat;',
    );
    expect(text.match(/no active plan/g)).toHaveLength(1);
  });

  it('names only the org that owns the chat when several have lapsed (CAN-3463)', async () => {
    loadCanopyCloudAccount.mockResolvedValue(
      account([
        LAPSED,
        {
          organizationId: 'org-lapsed-plural',
          organizationName: 'Initech',
          teamsEntitled: false,
        },
      ]),
    );
    await render();

    expect(banner()?.textContent).toContain('Acme has no active plan');
    expect(banner()?.textContent).not.toContain('Initech');
  });

  it('stays silent when the lapsed org does not own the chat (CAN-3463)', async () => {
    loadCanopyCloudAccount.mockResolvedValue(account([LAPSED, HEALTHY]));
    loadNativeAiCreditsAvailability.mockResolvedValue(
      native({ ownerOrganization: { id: 'org-healthy', name: 'Globex' } }),
    );
    await render();

    expect(banner()).toBeNull();
  });

  it('stays silent for Personal work, which no org pool funds (CAN-3463)', async () => {
    loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
    loadNativeAiCreditsAvailability.mockResolvedValue(
      native({ ownerOrganization: undefined }),
    );
    await render();

    expect(banner()).toBeNull();
  });

  it('asks about the owner of its chat target (CAN-3463)', async () => {
    loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
    await act(async () => {
      root.render(
        <OrgLapsedBanner
          provider="claude"
          target={{ projectId: 'proj-a', worktreeId: 'wt-a', chatId: 'chat-a' }}
        />,
      );
      await flushAsyncEffects();
    });

    expect(loadNativeAiCreditsAvailability).toHaveBeenLastCalledWith({
      kind: 'work',
      projectId: 'proj-a',
      worktreeId: 'wt-a',
      chatId: 'chat-a',
    });
  });

  it('claims only what its own visibility rule proves', async () => {
    // The banner is suppressed whenever the user can still pay for the turn
    // (personal balance, or a second healthy org), so it may only name the
    // consequence that suppression rule actually implies: the org credit pool
    // stopped paying. A lapse ALSO pauses shared runs and org memory, but those
    // stay paused for the covered user who never sees this banner, so naming
    // them here would be a claim the visibility rule cannot back. Those
    // surfaces refuse at their own point of use instead (share targets stop
    // being offered, Remote Control shows its own on-hold CTA).
    loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
    await render();

    const text = banner()?.textContent ?? '';
    expect(text).toContain('credit pool');
    expect(text).not.toContain('shared runs');
    expect(text).not.toContain('org memory');
  });

  it('offers no purchase CTA — restoring a lapsed org is a subscription action', async () => {
    loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
    await render();

    expect(
      container.querySelector(
        '[data-testid="chat-input-no-billing-source-get-credits"]',
      ),
    ).toBeNull();
  });

  it('stays silent when a healthy org still covers the user (per-org, not global)', async () => {
    loadCanopyCloudAccount.mockResolvedValue(account([LAPSED, HEALTHY]));
    loadNativeAiCreditsAvailability.mockResolvedValue(
      native({ orgSpendable: true }),
    );
    await render();

    expect(banner()).toBeNull();
  });

  it('stays silent when a personal balance covers the turn anyway', async () => {
    loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
    loadNativeAiCreditsAvailability.mockResolvedValue(
      native({ personalEligible: true }),
    );
    await render();

    expect(banner()).toBeNull();
  });

  it('stays silent when nothing has lapsed', async () => {
    loadCanopyCloudAccount.mockResolvedValue(account([HEALTHY]));
    await render();

    expect(banner()).toBeNull();
  });

  it('stays silent when the account read fails — no lapse asserted on a bad read', async () => {
    loadCanopyCloudAccount.mockRejectedValue(new Error('offline'));
    await render();

    expect(banner()).toBeNull();
  });

  it('does not render for a non-billable provider', async () => {
    loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
    await act(async () => {
      root.render(<OrgLapsedBanner provider="ollama" />);
      await flushAsyncEffects();
    });

    expect(banner()).toBeNull();
    expect(loadCanopyCloudAccount).not.toHaveBeenCalled();
  });

  it('can be dismissed', async () => {
    loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
    await render();

    expect(
      container.querySelector('[data-testid="chat-input-org-lapsed-dismiss"]'),
    ).not.toBeNull();
    dismiss();

    expect(banner()).toBeNull();
  });

  // CAN-2311 review round 3. A lapse zeroes the org credit pool, so a member of
  // a lapsed org with no personal balance ALSO trips `NoBillingSourceBanner`'s
  // "nothing can pay for this turn" condition. Both banners describe the same
  // dead end, but with different next actions ("Get AI Credits" vs "contact
  // your org admin"), so the composer sequences them: this banner — the one
  // that names the cause — speaks first and reports when it is doing so.
  describe('reports its visibility so the generic banner can stand down', () => {
    it('claims the composer while it is naming a lapse', async () => {
      loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
      await render();

      expect(banner()).not.toBeNull();
      expect(onVisibleChange).toHaveBeenLastCalledWith(true);
    });

    it('releases the composer on dismissal, so the user is never left with nothing', async () => {
      loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
      await render();
      expect(onVisibleChange).toHaveBeenLastCalledWith(true);

      dismiss();

      expect(banner()).toBeNull();
      expect(onVisibleChange).toHaveBeenLastCalledWith(false);
    });

    it('never claims the composer when there is no lapse to explain', async () => {
      loadCanopyCloudAccount.mockResolvedValue(account([HEALTHY]));
      await render();

      expect(banner()).toBeNull();
      expect(onVisibleChange).not.toHaveBeenCalledWith(true);
    });

    it('releases the composer once the org is restored', async () => {
      loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
      await render();
      expect(onVisibleChange).toHaveBeenLastCalledWith(true);

      loadCanopyCloudAccount.mockResolvedValue(account([HEALTHY]));
      await accountChanged();

      expect(onVisibleChange).toHaveBeenLastCalledWith(false);
    });
  });

  describe('account refresh (mid-session changes)', () => {
    it('surfaces an org that lapses mid-session, without a remount', async () => {
      loadCanopyCloudAccount.mockResolvedValue(account([HEALTHY]));
      await render();
      expect(banner()).toBeNull();

      loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
      await accountChanged();

      expect(banner()?.textContent).toContain('Acme has no active plan');
    });

    it('stops asserting a lapse once the org is restored', async () => {
      loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
      await render();
      expect(banner()).not.toBeNull();

      loadCanopyCloudAccount.mockResolvedValue(account([HEALTHY]));
      await accountChanged();

      expect(banner()).toBeNull();
    });

    it('fails quiet when a refresh read fails — never keeps asserting a stale lapse', async () => {
      loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
      await render();
      expect(banner()).not.toBeNull();

      loadCanopyCloudAccount.mockRejectedValue(new Error('offline'));
      await accountChanged();

      expect(banner()).toBeNull();
    });

    it('ignores a slow read that resolves after a newer refresh started', async () => {
      loadCanopyCloudAccount.mockResolvedValue(account([HEALTHY]));
      await render();

      // Refresh #1 hangs, then refresh #2 starts and completes with the
      // authoritative (restored) snapshot. #1 must not overwrite it when it
      // finally lands.
      const slow = deferred<CanopyCloudAccountPublicState | null>();
      loadCanopyCloudAccount.mockReturnValue(slow.promise);
      await accountChanged();

      loadCanopyCloudAccount.mockResolvedValue(account([HEALTHY]));
      await accountChanged();

      await act(async () => {
        slow.resolve(account([LAPSED]));
        await flushAsyncEffects();
      });

      expect(banner()).toBeNull();
    });

    it('keeps a dismissal for the same lapse across refreshes', async () => {
      loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
      await render();
      dismiss();
      expect(banner()).toBeNull();

      await accountChanged();

      expect(banner()).toBeNull();
    });

    it('re-raises when a DIFFERENT org lapses after a dismissal', async () => {
      loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
      await render();
      dismiss();
      expect(banner()).toBeNull();

      loadCanopyCloudAccount.mockResolvedValue(
        account([
          { ...HEALTHY, teamsEntitled: false },
          { ...LAPSED, teamsEntitled: true },
        ]),
      );
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ ownerOrganization: { id: 'org-healthy', name: 'Globex' } }),
      );
      await accountChanged();

      expect(banner()?.textContent).toContain('Globex has no active plan');
    });
  });

  // Restraint 2 in the component header ("Only when it COSTS them"). A lapse
  // that is not actually blocking anything must not be announced, and the copy
  // ("its credit pool is paused and is not paying for this chat") would be a
  // false statement — permanently, since `dismissedKey` is component state and
  // re-raises on every mount.
  describe('does not claim a cost the user is not paying', () => {
    it('stays hidden for a natively-authed user', async () => {
      loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
      await render('claude', { nativeAuth: true });

      expect(banner()).toBeNull();
      expect(onVisibleChange).toHaveBeenLastCalledWith(false);
    });

    it('stays hidden while the availability read is still inconclusive', async () => {
      loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
      // `useProviderAvailability` reports `nativeAuth: false, loading: true` on
      // a FAILED auth probe specifically so callers do not read it as a
      // confirmed logout. Without this term a transient probe failure re-raises
      // the same false claim `nativeAuth` removes.
      await render('claude', { nativeAuth: false, availabilityLoading: true });

      expect(banner()).toBeNull();
      expect(onVisibleChange).toHaveBeenLastCalledWith(false);
    });

    it('still shows once the read resolves with no native auth', async () => {
      loadCanopyCloudAccount.mockResolvedValue(account([LAPSED]));
      await render('claude', { nativeAuth: false, availabilityLoading: false });

      expect(banner()).not.toBeNull();
      expect(onVisibleChange).toHaveBeenLastCalledWith(true);
    });
  });
});
