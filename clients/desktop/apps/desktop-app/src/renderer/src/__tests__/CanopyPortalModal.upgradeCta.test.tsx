/**
 * @jest-environment jsdom
 *
 * Frontend gate for the Remote Control paid-plan work: when billing is on and a
 * signed-in user's plan does not include Remote Control, the modal's `disabled`
 * state must swap the Enable button for an upgrade CTA. The authoritative gate
 * is the account `portal-v1` capability (fail-open under billing-off), NOT the
 * `remote_control` entitlement bit — the billing-off entitlements mirror never
 * emits it. `useSubscriptionStatus` is mocked so we control `visible`
 * (billing-on + signed-in) and the upgrade/management handlers directly.
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyApi,
  CanopyCloudAccountPublicState,
  CanopyPortalState,
} from '@canopy/desktop-shared/types';
import type {
  WorkspaceContext,
  WorkspaceContextOrganization,
} from '@canopy/protocol/workspace-context';
import { CanopyPortalModal } from '@/components/portal/CanopyPortalModal';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const openBillingPage = jest.fn();
const openUpgradePage = jest.fn();
const openBillingAction = jest.fn();
const openBillingPath = jest.fn();
let subscriptionVisible = false;
// The two signals the lapsed-org branch reads (CAN-2590): which org this user
// can manage billing for, and the wallet-wide billing presentation.
let billingManageableOrg: { id: string; name: string } | null = null;
// Whole presentation, not just a display name: the modal may only name the plan
// when this object's `owner` IS the manageable lapsed org, so a fixture that
// carried the name alone could not tell a correct pairing from a crossed one.
// Real catalog keys throughout — `business` is the org tier the org billing page
// actually sells, `individual` is Pro (a USER-scoped key that page cannot sell).
let billingPresentation: MockedBillingPresentation | null = null;

type MockedBillingPresentation = {
  plan: { key: string; displayName: string };
  owner: { type: 'user' } | { type: 'organization'; id: string; name: string };
  // What the server says THIS reader can do at that owner's billing page.
  // Only `subscribe` means "this plan is on offer to you": the server sets
  // `manage` for an owner whose org already holds a live paid subscription,
  // and `view` for a non-owner ADMIN, who reaches the owner/admin branch
  // (`billingManageableOrg` is OWNER+ADMIN) but lands on a read-only page.
  action: 'subscribe' | 'manage' | 'view';
};

interface MockedSubscription {
  visible: boolean;
  status: { billingPresentation: MockedBillingPresentation | null } | null;
  openBillingPage: () => void;
  openUpgradePage: () => void;
  openBillingAction: () => void;
  billingManageableOrg: { id: string; name: string } | null;
  openBillingPath: (path: string) => void;
  guestCtaVisible: boolean;
  startFreeTrial: () => void;
}

jest.mock('@/hooks/useSubscriptionStatus', () => ({
  useSubscriptionStatus: (): MockedSubscription => ({
    visible: subscriptionVisible,
    status: billingPresentation ? { billingPresentation } : null,
    openBillingPage,
    openUpgradePage,
    openBillingAction,
    billingManageableOrg,
    openBillingPath,
    guestCtaVisible: false,
    startFreeTrial: (): void => undefined,
  }),
}));

// The reporter writes into a store on mount; it is irrelevant to this test.
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => undefined,
}));

let orgBillingStates: CanopyCloudAccountPublicState['orgBillingStates'];

function account(capabilities: string[]): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    capabilities,
    storageAvailable: true,
    ...(orgBillingStates ? { orgBillingStates } : {}),
    account: {
      id: 'acct-1',
      name: 'Alice',
      email: 'alice@example.com',
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

function installApi(capabilities: string[]): void {
  const api: Partial<CanopyApi> = {
    loadCanopyCloudAccount: () => Promise.resolve(account(capabilities)),
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
  // The modal chains `loadCanopyCloudAccount().then().catch().finally()`, so
  // drain several microtask ticks inside act() to settle the account load.
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
  });
}

async function renderModal(capabilities: string[]): Promise<{
  // `DialogModal` renders through a portal into `document.body`, so queries
  // must target the document, not the mount container.
  query: (selector: string) => Element | null;
  cleanup: () => void;
}> {
  installApi(capabilities);
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

describe('CanopyPortalModal — Remote Control upgrade CTA', () => {
  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    openBillingPage.mockClear();
    openUpgradePage.mockClear();
    openBillingAction.mockClear();
    openBillingPath.mockClear();
    subscriptionVisible = false;
    billingManageableOrg = null;
    billingPresentation = null;
    orgBillingStates = undefined;
    setWorkspaceContext({ kind: 'personal' }, []);
  });

  // The membership list and selected navigation context the modal reads to
  // find the lapsed org among every org the reader manages (CAN-3465).
  function setWorkspaceContext(
    context: WorkspaceContext,
    organizations: readonly WorkspaceContextOrganization[],
  ): void {
    useWorkspaceContextStore.setState({
      state: { context, revision: 1, organizations },
    });
  }

  it('shows the upgrade CTA (not Enable) when billing is on and the account lacks portal-v1', async () => {
    subscriptionVisible = true;
    const { query, cleanup } = await renderModal([]);
    try {
      expect(query('[data-testid="canopy-portal-upgrade-cta"]')).not.toBeNull();
      expect(query('[data-testid="canopy-portal-enable"]')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('clicking the CTA opens the shortest eligible subscription destination', async () => {
    subscriptionVisible = true;
    const { query, cleanup } = await renderModal([]);
    try {
      const button = query('[data-testid="canopy-portal-upgrade-cta-button"]');
      expect(button).not.toBeNull();
      act(() => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(openBillingAction).toHaveBeenCalledTimes(1);
      expect(openUpgradePage).not.toHaveBeenCalled();
      expect(openBillingPage).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('shows Enable (no CTA) when the account already holds portal-v1', async () => {
    subscriptionVisible = true;
    const { query, cleanup } = await renderModal(['portal-v1']);
    try {
      expect(query('[data-testid="canopy-portal-upgrade-cta"]')).toBeNull();
      expect(query('[data-testid="canopy-portal-enable"]')).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  // CAN-2590: the paywall's action depends on who the reader is. The match
  // itself is `resolveManageableLapsedOrg`; these pin that the modal feeds it
  // the right signals and hands the branch down to the CTA.
  describe('lapsed organization', () => {
    const LAPSED = {
      organizationId: 'org-lapsed',
      organizationName: 'Unstoppable Domains',
      teamsEntitled: false,
    };
    const HEALTHY = {
      organizationId: 'org-healthy',
      organizationName: 'Globex',
      teamsEntitled: true,
    };

    function lapsedCopy(query: (selector: string) => Element | null): string {
      return (
        query('[data-testid="canopy-portal-upgrade-cta-lapsed-copy"]')
          ?.textContent ?? ''
      );
    }

    it('gives an admin of the lapsed org the plan-named action', async () => {
      subscriptionVisible = true;
      orgBillingStates = [LAPSED, HEALTHY];
      billingManageableOrg = { id: 'org-lapsed', name: 'Unstoppable Domains' };
      // The presentation describes THIS org, so its plan is the one the linked
      // billing page can actually sell and the panel may name it.
      billingPresentation = {
        plan: { key: 'business', displayName: 'Business' },
        owner: {
          type: 'organization',
          id: 'org-lapsed',
          name: 'Unstoppable Domains',
        },
        action: 'subscribe',
      };
      const { query, cleanup } = await renderModal([]);
      try {
        expect(lapsedCopy(query)).toBe(
          'This feature requires Business, and Unstoppable Domains has no active plan to cover it. Upgrade to unlock.',
        );
        const button = query(
          '[data-testid="canopy-portal-upgrade-cta-button"]',
        );
        expect(button?.textContent).toBe('Get Business');
        act(() => {
          button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        // Deep-linked into the lapsed org's own billing page with the plan
        // intent, not the generic account upgrade path.
        expect(openBillingPath).toHaveBeenCalledWith(
          '/organization/org-lapsed/settings?tab=billing&plan=business',
        );
        expect(openBillingAction).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    // CAN-2590 regression. `billingPresentation` is a wallet-wide winner ranked
    // across the caller's own subscription and every org they administer, so for
    // an admin of a lapsed org it commonly resolves to the PERSONAL entry tier —
    // a lapsed org is not a presentation candidate while it is billing-inactive.
    // Naming that plan beside the org's id told the reader "This feature requires
    // Pro" over a `Get Pro` button pointing at an org billing page that only
    // sells the entry ORG tier and silently ignores a user-scoped `?plan=` key.
    // The plan name and the intent must both drop out when the owner does not
    // match, which is the fallback this ticket's plan prescribed for exactly this
    // case.
    it('never names a plan the linked org page cannot sell (personal owner)', async () => {
      subscriptionVisible = true;
      orgBillingStates = [LAPSED, HEALTHY];
      billingManageableOrg = { id: 'org-lapsed', name: 'Unstoppable Domains' };
      billingPresentation = {
        // Pro's real catalog key. User-scoped, so the org page cannot sell it.
        plan: { key: 'individual', displayName: 'Pro' },
        owner: { type: 'user' },
        action: 'subscribe',
      };
      const { query, cleanup } = await renderModal([]);
      try {
        const copy = lapsedCopy(query);
        expect(copy).toBe(
          'This feature requires a paid plan, and Unstoppable Domains has no active plan to cover it.',
        );
        expect(copy).not.toContain('Pro');
        const button = query(
          '[data-testid="canopy-portal-upgrade-cta-button"]',
        );
        // Still the admin branch — the destination is right, only the plan
        // claim was wrong — so the button stays and stays generic.
        expect(button?.textContent).toBe('Upgrade to unlock');
        act(() => {
          button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(openBillingPath).toHaveBeenCalledWith(
          '/organization/org-lapsed/settings?tab=billing',
        );
        expect(openBillingAction).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    // CAN-2590 round 2. Owner matching alone is not enough: `action` says
    // whether the plan is on OFFER to this reader at that page. `manage` means
    // the org already holds a live paid subscription, so naming its plan tells
    // an owner to buy the tier they are already paying for — reachable because
    // `teamsEntitled` tracks the `teams` capability, not billing liveness.
    it('never names a plan the org is already paying for (action: manage)', async () => {
      subscriptionVisible = true;
      orgBillingStates = [LAPSED, HEALTHY];
      billingManageableOrg = { id: 'org-lapsed', name: 'Unstoppable Domains' };
      billingPresentation = {
        plan: { key: 'business', displayName: 'Business' },
        owner: {
          type: 'organization',
          id: 'org-lapsed',
          name: 'Unstoppable Domains',
        },
        action: 'manage',
      };
      const { query, cleanup } = await renderModal([]);
      try {
        const copy = lapsedCopy(query);
        expect(copy).not.toContain('Business');
        expect(copy).toContain('This feature requires a paid plan,');
        const button = query(
          '[data-testid="canopy-portal-upgrade-cta-button"]',
        );
        expect(button?.textContent).toBe('Upgrade to unlock');
        act(() => {
          button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(openBillingPath).toHaveBeenCalledWith(
          '/organization/org-lapsed/settings?tab=billing',
        );
      } finally {
        cleanup();
      }
    });

    // A non-owner ADMIN reaches `resolveManageableLapsedOrg` (`billingManageableOrg`
    // is OWNER+ADMIN via `canEditOrg`) but every billing CTA on the org page is
    // OWNER-gated, which the server reports as `action: 'view'`. Such a reader
    // must NOT be sent there: `subscribe/page.tsx` filters to OWNER for exactly
    // this reason ("routing an ADMIN there is a guaranteed dead end"). They are
    // diverted to the everyone-else branch, keeping the personal upgrade route
    // they had before this feature existed.
    it('sends a reader who can only view that page to their own billing action (action: view)', async () => {
      subscriptionVisible = true;
      orgBillingStates = [LAPSED, HEALTHY];
      billingManageableOrg = { id: 'org-lapsed', name: 'Unstoppable Domains' };
      billingPresentation = {
        plan: { key: 'business', displayName: 'Business' },
        owner: {
          type: 'organization',
          id: 'org-lapsed',
          name: 'Unstoppable Domains',
        },
        action: 'view',
      };
      const { query, cleanup } = await renderModal([]);
      try {
        const copy = lapsedCopy(query);
        expect(copy).not.toContain('Business');
        // Points at the OWNER, the only role that can actually buy here — not
        // at "an admin", which for this reader is themselves.
        expect(copy).toContain('Ask an organization owner to renew');
        const button = query(
          '[data-testid="canopy-portal-upgrade-cta-button"]',
        );
        expect(button?.textContent).toBe('Upgrade to unlock');
        act(() => {
          button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        // The DESTINATION is the assertion that matters, and it must be an
        // explicit personal one. `openBillingAction` would NOT do: for this
        // presentation shape the real hook resolves it back to
        // `organizationBillingPath(owner.id)` — the very read-only page this
        // diversion exists to avoid — so asserting it here would pin the branch
        // while the user still landed on the wrong page.
        expect(openUpgradePage).toHaveBeenCalledTimes(1);
        expect(openBillingAction).not.toHaveBeenCalled();
        expect(openBillingPath).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    // The mirror of the case above: an OWNER on a paid plan also gets no plan
    // named (`action: 'manage'`), but they CAN act at the org page, so they keep
    // the org destination rather than being diverted.
    it('keeps the org destination for an owner who can still act there (action: manage)', async () => {
      subscriptionVisible = true;
      orgBillingStates = [LAPSED, HEALTHY];
      billingManageableOrg = { id: 'org-lapsed', name: 'Unstoppable Domains' };
      billingPresentation = {
        plan: { key: 'business', displayName: 'Business' },
        owner: {
          type: 'organization',
          id: 'org-lapsed',
          name: 'Unstoppable Domains',
        },
        action: 'manage',
      };
      const { query, cleanup } = await renderModal([]);
      try {
        const button = query(
          '[data-testid="canopy-portal-upgrade-cta-button"]',
        );
        act(() => {
          button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(openBillingPath).toHaveBeenCalledWith(
          '/organization/org-lapsed/settings?tab=billing',
        );
        expect(openBillingAction).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('never names a plan belonging to a DIFFERENT org', async () => {
      // Admin of both a lapsed org and a healthy, pricier one: the presentation
      // winner is the healthy org, whose tier says nothing about what the lapsed
      // org needs.
      subscriptionVisible = true;
      orgBillingStates = [LAPSED, HEALTHY];
      billingManageableOrg = { id: 'org-lapsed', name: 'Unstoppable Domains' };
      billingPresentation = {
        plan: { key: 'enterprise', displayName: 'Enterprise' },
        owner: { type: 'organization', id: 'org-healthy', name: 'Globex' },
        action: 'subscribe',
      };
      const { query, cleanup } = await renderModal([]);
      try {
        const copy = lapsedCopy(query);
        expect(copy).not.toContain('Enterprise');
        expect(copy).toContain('This feature requires a paid plan,');
        const button = query(
          '[data-testid="canopy-portal-upgrade-cta-button"]',
        );
        expect(button?.textContent).toBe('Upgrade to unlock');
        act(() => {
          button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(openBillingPath).toHaveBeenCalledWith(
          '/organization/org-lapsed/settings?tab=billing',
        );
      } finally {
        cleanup();
      }
    });

    it('gives a member of the lapsed org an admin to ask, and keeps their own upgrade route', async () => {
      subscriptionVisible = true;
      orgBillingStates = [LAPSED];
      billingManageableOrg = null;
      billingPresentation = {
        plan: { key: 'individual', displayName: 'Pro' },
        owner: { type: 'user' },
        action: 'subscribe',
      };
      const { query, cleanup } = await renderModal([]);
      try {
        expect(lapsedCopy(query)).toBe(
          'This feature requires a paid plan, and Unstoppable Domains has no active plan to cover it. Ask an organization owner to renew, or upgrade your own plan.',
        );
        // The button is the reader's OWN upgrade route, not the org's renewal
        // button, so it survives this branch and falls back to the hook's
        // resolved billing action.
        const button = query(
          '[data-testid="canopy-portal-upgrade-cta-button"]',
        );
        expect(button?.textContent).toBe('Upgrade to unlock');
        act(() => {
          button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(openBillingAction).toHaveBeenCalledTimes(1);
        expect(openBillingPath).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('treats an admin of a DIFFERENT, healthy org as a member here', async () => {
      // They administer something, but not the org the copy names, so they
      // cannot fix the lapse being reported.
      subscriptionVisible = true;
      orgBillingStates = [LAPSED, HEALTHY];
      billingManageableOrg = { id: 'org-healthy', name: 'Globex' };
      billingPresentation = {
        plan: { key: 'business', displayName: 'Business' },
        owner: { type: 'organization', id: 'org-healthy', name: 'Globex' },
        action: 'subscribe',
      };
      const { query, cleanup } = await renderModal([]);
      try {
        const copy = lapsedCopy(query);
        expect(copy).toContain('Ask an organization owner to renew');
        // Globex's tier says nothing about what Acme needs.
        expect(copy).not.toContain('Business');
        expect(
          query('[data-testid="canopy-portal-upgrade-cta-button"]')
            ?.textContent,
        ).toBe('Upgrade to unlock');
      } finally {
        cleanup();
      }
    });

    // CAN-3465. The server no longer picks one org for a user who manages
    // several (`billingManageableOrg` is null), so the modal finds the lapsed
    // org from the membership list instead of a most-active tiebreak.
    describe('reader who manages several organizations', () => {
      const SECOND_LAPSED = {
        organizationId: 'org-lapsed-2',
        organizationName: 'Acme',
        teamsEntitled: false,
      };
      const OWNS_LAPSED: WorkspaceContextOrganization = {
        id: 'org-lapsed',
        name: 'Unstoppable Domains',
        role: 'OWNER',
      };
      const OWNS_SECOND_LAPSED: WorkspaceContextOrganization = {
        id: 'org-lapsed-2',
        name: 'Acme',
        role: 'OWNER',
      };
      const OWNS_HEALTHY: WorkspaceContextOrganization = {
        id: 'org-healthy',
        name: 'Globex',
        role: 'OWNER',
      };

      function clickUpgrade(query: (selector: string) => Element | null): void {
        const button = query(
          '[data-testid="canopy-portal-upgrade-cta-button"]',
        );
        act(() => {
          button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
      }

      it('opens the one lapsed org among them, from the Personal context', async () => {
        subscriptionVisible = true;
        orgBillingStates = [LAPSED, HEALTHY];
        billingManageableOrg = null;
        setWorkspaceContext({ kind: 'personal' }, [OWNS_HEALTHY, OWNS_LAPSED]);
        const { query, cleanup } = await renderModal([]);
        try {
          expect(lapsedCopy(query)).toBe(
            'This feature requires a paid plan, and Unstoppable Domains has no active plan to cover it.',
          );
          clickUpgrade(query);
          expect(openBillingPath).toHaveBeenCalledWith(
            '/organization/org-lapsed/settings?tab=billing',
          );
          expect(openBillingAction).not.toHaveBeenCalled();
        } finally {
          cleanup();
        }
      });

      it('opens the selected organization when several of them have lapsed', async () => {
        subscriptionVisible = true;
        orgBillingStates = [LAPSED, SECOND_LAPSED];
        billingManageableOrg = null;
        setWorkspaceContext(
          { kind: 'organization', organizationId: 'org-lapsed-2' },
          [OWNS_LAPSED, OWNS_SECOND_LAPSED],
        );
        const { query, cleanup } = await renderModal([]);
        try {
          clickUpgrade(query);
          expect(openBillingPath).toHaveBeenCalledWith(
            '/organization/org-lapsed-2/settings?tab=billing',
          );
          expect(openBillingAction).not.toHaveBeenCalled();
        } finally {
          cleanup();
        }
      });

      it('opens no organization when several have lapsed and none is selected', async () => {
        // Nothing says which org the reader means, so none is guessed: they
        // keep their own billing action, exactly like the everyone-else branch.
        subscriptionVisible = true;
        orgBillingStates = [LAPSED, SECOND_LAPSED];
        billingManageableOrg = null;
        setWorkspaceContext({ kind: 'personal' }, [
          OWNS_LAPSED,
          OWNS_SECOND_LAPSED,
        ]);
        const { query, cleanup } = await renderModal([]);
        try {
          expect(lapsedCopy(query)).toContain(
            'Ask an organization owner to renew',
          );
          clickUpgrade(query);
          expect(openBillingAction).toHaveBeenCalledTimes(1);
          expect(openBillingPath).not.toHaveBeenCalled();
        } finally {
          cleanup();
        }
      });
    });

    it('keeps the default upsell when no org has lapsed', async () => {
      subscriptionVisible = true;
      orgBillingStates = [HEALTHY];
      billingManageableOrg = { id: 'org-healthy', name: 'Globex' };
      const { query, cleanup } = await renderModal([]);
      try {
        expect(
          query('[data-testid="canopy-portal-upgrade-cta-lapsed-copy"]'),
        ).toBeNull();
        expect(
          query('[data-testid="canopy-portal-upgrade-cta-button"]')
            ?.textContent,
        ).toBe('Upgrade to unlock');
      } finally {
        cleanup();
      }
    });
  });

  it('shows Enable (no CTA) when billing is off, even without portal-v1 (fail open)', async () => {
    subscriptionVisible = false;
    const { query, cleanup } = await renderModal([]);
    try {
      expect(query('[data-testid="canopy-portal-upgrade-cta"]')).toBeNull();
      expect(query('[data-testid="canopy-portal-enable"]')).not.toBeNull();
    } finally {
      cleanup();
    }
  });
});
