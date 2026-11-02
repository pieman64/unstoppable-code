/**
 * @jest-environment jsdom
 */
import type {
  AccountOrganizationSettingsApi,
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
import type * as HostedSettingsAvailabilityModule from '@/components/settings/hosted/hosted-settings-availability';
import {
  settingsRouteToPath,
  type SettingsRoute,
} from '@canopy/protocol/settings';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { readCanopyCloudAccountChangeReason } from '@/lib/canopyCloudAccountChange';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  getAiCreditsConnectContext,
  invalidateSharedAiCreditsRead,
  openBillingPage,
  readSharedAiCreditsAvailability,
  resetSettingsCloseRereadForTests,
  resolveAiCreditsCoverage,
  unlockModels,
  useGetAiCreditsAction,
} from '../openBillingPage';
import { organizationBillingPath } from '@canopy/protocol/billing';
import { resetModelLibraryAccessForTests } from '../modelLibraryAccess';
import {
  resetModelUnlockIntentForTests,
  useModelUnlockIntentStore,
} from '../modelUnlockIntent';
import {
  useCloudConnectGateStore,
  type CloudConnectGateContext,
} from '@/stores/cloudConnectGateStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useGitHubStore } from '@/stores/githubStore';
import { brandText } from '@/lib/brand';
import {
  invalidateAiCreditsAvailabilityCache,
  useAiCreditsAvailability,
} from '@/hooks/useAiCreditsAvailability';

const mockHostedSettingsOpenable = jest.fn<boolean, []>();
jest.mock('@/components/settings/hosted/hosted-settings-availability', () => ({
  ...jest.requireActual<typeof HostedSettingsAvailabilityModule>(
    '@/components/settings/hosted/hosted-settings-availability',
  ),
  hostedSettingsOpenable: (): boolean => mockHostedSettingsOpenable(),
  useHostedSettingsAvailable: (): boolean => mockHostedSettingsOpenable(),
}));

afterEach(() => {
  resetSettingsCloseRereadForTests();
});

beforeEach(() => {
  // Web branch by default, so every pre-CAN-4691 case keeps its meaning.
  mockHostedSettingsOpenable.mockReset().mockReturnValue(false);
});

const PRICING_URL = 'https://cloud.example.com/pricing';

function native(
  overrides: Partial<NativeAiCreditsAvailability> = {},
): NativeAiCreditsAvailability {
  return {
    personalEligible: false,
    inOrg: false,
    orgCreditPoolCovered: false,
    orgSpendable: false,
    pricingUrl: PRICING_URL,
    ...overrides,
  };
}

describe('readSharedAiCreditsAvailability', () => {
  beforeEach(() => {
    invalidateSharedAiCreditsRead();
  });

  it('coalesces concurrent readers onto ONE read', async () => {
    // The point of the helper: two surfaces waking on the same gate close must
    // not be able to reach opposite conclusions from two network reads that
    // disagree.
    const load = jest
      .fn()
      .mockResolvedValue(native({ personalEligible: true }));
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability: load },
    });

    const [a, b] = await Promise.all([
      readSharedAiCreditsAvailability(),
      readSharedAiCreditsAvailability(),
    ]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('gives a SEQUENTIAL later reader the same answer, not a second read', async () => {
    // The residual the coalescer alone did not close. `ModelRecoveryModal`
    // reads availability BEFORE account state; `GetAiCreditsCta`'s post-connect
    // read waits BEHIND a `loadCanopyCloudAccount()` hop. So the modal's read
    // routinely settles before the CTA even asks — and sharing only the
    // in-flight promise would let the CTA issue a second, network-backed read
    // that can disagree. A covered-then-uncovered pair is the dangerous one:
    // the recovery commits AND a billing page opens.
    const load = jest
      .fn()
      .mockResolvedValueOnce(native({ personalEligible: true }))
      // If the episode is ever asked twice, this disagreeing answer is what it
      // would get. The assertion below is that it is never requested.
      .mockResolvedValue(native({ personalEligible: false }));
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability: load },
    });

    // Reader 1 (the modal) reads and its answer fully settles...
    const first = await readSharedAiCreditsAvailability();
    // ...an IPC hop passes...
    await Promise.resolve();
    // ...and reader 2 (the CTA) only now asks.
    const second = await readSharedAiCreditsAvailability();

    expect(load).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second).toEqual(native({ personalEligible: true }));
  });

  it('re-reads for a caller that explicitly asks for a FRESH answer', async () => {
    // Retention must not defeat the reads whose entire job is to notice that
    // the answer just changed: Try again, Check again, and the post-purchase
    // focus probe. Without this, a user returning from checkout would be told
    // what we already believed before they paid.
    const load = jest
      .fn()
      .mockResolvedValueOnce(native({ personalEligible: false }))
      .mockResolvedValue(native({ personalEligible: true }));
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability: load },
    });

    const before = await readSharedAiCreditsAvailability();
    expect(before).toEqual(native({ personalEligible: false }));

    // They bought credits in the browser and came back.
    const after = await readSharedAiCreditsAvailability({ fresh: true });

    expect(load).toHaveBeenCalledTimes(2);
    expect(after).toEqual(native({ personalEligible: true }));

    // And the fresh answer becomes the episode's answer for everyone else.
    expect(await readSharedAiCreditsAvailability()).toEqual(
      native({ personalEligible: true }),
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does NOT let a read started before an account change be joined after it', async () => {
    // The stale-join hazard. `GetAiCreditsCta` seeds a read on mount, and this
    // read fans out per org over the network, so a read started while the user
    // was still a guest can still be in flight when they finish signing in. A
    // guest's answer is a plain uncovered result with no `inconclusive` marker,
    // so joining it post-connect would send a user who was just granted free
    // credits to a purchase page — with both readers agreeing, which is worse
    // than disagreeing.
    let releaseGuestRead: (
      value: NativeAiCreditsAvailability,
    ) => void = () => {};
    const guestRead = new Promise<NativeAiCreditsAvailability>((resolve) => {
      releaseGuestRead = resolve;
    });
    const load = jest
      .fn()
      .mockReturnValueOnce(guestRead)
      .mockResolvedValue(native({ personalEligible: true }));
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability: load },
    });

    // Seeded while still a guest, and still in flight.
    const seeded = readSharedAiCreditsAvailability();

    // The user signs in; the gate close bumps the epoch.
    invalidateSharedAiCreditsRead();

    // A post-connect reader must NOT inherit the guest read.
    const postConnect = readSharedAiCreditsAvailability();
    expect(load).toHaveBeenCalledTimes(2);

    releaseGuestRead(native({ personalEligible: false }));
    // The seeded read's OWN awaiter gets a non-answer rather than the guest
    // result: its episode ended while it was in flight, so what it describes is
    // no longer the account anyone is asking about. `null` is the honest
    // outcome — every caller treats it as *unknown*, never as "no credits".
    expect(await seeded).toBeNull();
    expect(await postConnect).toEqual(native({ personalEligible: true }));
  });

  it('stops retaining an answer once it ages out', async () => {
    // The backstop for everything nobody thought of. An episode ends on an
    // account change, a gate close, or an explicit fresh read — but a balance
    // can also change with no local event at all (an org admin grants headroom,
    // or credits are bought in the web app). Without a cap, a seed read taken
    // when a CTA mounted could pin that answer for the whole session. Two
    // review rounds of this change were lost to exactly this class of miss.
    const load = jest
      .fn()
      .mockResolvedValueOnce(native({ personalEligible: false }))
      .mockResolvedValue(native({ personalEligible: true }));
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability: load },
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      expect(await readSharedAiCreditsAvailability()).toEqual(
        native({ personalEligible: false }),
      );
      // Still inside the window: retained.
      nowSpy.mockReturnValue(1_000 + 59_000);
      expect(await readSharedAiCreditsAvailability()).toEqual(
        native({ personalEligible: false }),
      );
      expect(load).toHaveBeenCalledTimes(1);

      // Past it: the answer is too old to be trusted about money.
      nowSpy.mockReturnValue(1_000 + 61_000);
      expect(await readSharedAiCreditsAvailability()).toEqual(
        native({ personalEligible: true }),
      );
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('retracts an in-flight answer whose episode ended before it resolved', async () => {
    // Dropping the handle cannot reach a caller that is ALREADY awaiting the
    // promise. Credits can be exhausted by another chat while a recovery read
    // is in flight: without an epoch check at resolution, that read resolves
    // `covered` afterwards and its existing awaiter commits a model whose
    // credits are gone. A superseded answer must degrade to a non-answer —
    // `null`, which every caller already treats as *unknown* and never as
    // permission to commit or to charge.
    let release: (value: NativeAiCreditsAvailability) => void = () => {};
    const inFlight = new Promise<NativeAiCreditsAvailability>((resolve) => {
      release = resolve;
    });
    const load = jest.fn().mockReturnValue(inFlight);
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability: load },
    });

    // A recovery read starts and someone is already awaiting it.
    const awaited = readSharedAiCreditsAvailability();

    // Another chat spends the last credits; the exhaustion handler invalidates.
    invalidateSharedAiCreditsRead();

    // The original read now resolves — with the pre-exhaustion answer.
    release(native({ personalEligible: true }));

    expect(await awaited).toBeNull();
  });

  it('keeps one episode per owner scope, never sharing across chats (CAN-3463)', async () => {
    const load = jest
      .fn()
      .mockImplementation((scope?: { projectId?: string }) =>
        Promise.resolve(
          native({ orgSpendable: scope?.projectId === 'proj-a' }),
        ),
      );
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability: load },
    });

    const a = await readSharedAiCreditsAvailability({
      scope: { kind: 'work', projectId: 'proj-a' },
    });
    const b = await readSharedAiCreditsAvailability({
      scope: { kind: 'work', projectId: 'proj-b' },
    });

    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenNthCalledWith(1, {
      kind: 'work',
      projectId: 'proj-a',
    });
    expect(a?.orgSpendable).toBe(true);
    expect(b?.orgSpendable).toBe(false);

    // Same scope again joins its own retained answer.
    await readSharedAiCreditsAvailability({
      scope: { kind: 'work', projectId: 'proj-a' },
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('never rejects when the bridge is absent', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {},
    });
    await expect(readSharedAiCreditsAvailability()).resolves.toBeNull();
  });
});

describe('resolveAiCreditsCoverage', () => {
  it('offers nothing until the native availability read resolves', () => {
    expect(resolveAiCreditsCoverage(null)).toEqual({
      canSpendCredits: false,
      showContactAdmin: false,
      showPurchase: false,
      lapsedOrgNames: [],
    });
  });

  it('offers nothing when the native availability read is inconclusive', () => {
    expect(
      resolveAiCreditsCoverage(
        native({
          inconclusive: true,
          inOrg: true,
          orgCreditPoolCovered: true,
        }),
        ['Acme'],
      ),
    ).toEqual({
      canSpendCredits: false,
      showContactAdmin: false,
      showPurchase: false,
      lapsedOrgNames: [],
    });
  });

  it('reports spendable credits for a personal balance', () => {
    expect(
      resolveAiCreditsCoverage(native({ personalEligible: true })),
    ).toEqual({
      canSpendCredits: true,
      showContactAdmin: false,
      showPurchase: false,
      lapsedOrgNames: [],
    });
  });

  it('reports spendable credits for org headroom', () => {
    expect(resolveAiCreditsCoverage(native({ orgSpendable: true }))).toEqual({
      canSpendCredits: true,
      showContactAdmin: false,
      showPurchase: false,
      lapsedOrgNames: [],
    });
  });

  // CAN-2311: an org that loses `teams` stops funding its members immediately.
  it('surfaces the lapsed org when the user has no other way to pay', () => {
    // The lapse zeroes the org credit pool upstream, so this payload is what a
    // member of one lapsed org with no personal balance actually gets:
    // `orgCreditPoolCovered: false` → `showPurchase: true` ALONGSIDE the lapse.
    // Both are correct — a personal top-up would unblock the turn — so this
    // resolver reports both and the composer sequences the two banners rather
    // than offering two next actions at once (see `OrgLapsedBanner`'s
    // `onVisibleChange` and its wiring in `ChatInput`).
    expect(resolveAiCreditsCoverage(native({ inOrg: true }), ['Acme'])).toEqual(
      {
        canSpendCredits: false,
        showContactAdmin: false,
        showPurchase: true,
        lapsedOrgNames: ['Acme'],
      },
    );
  });

  it('stays silent about a lapsed org when a HEALTHY org still covers the user', () => {
    // The whole point of the per-org gate: one lapsed org must not degrade a
    // member's experience through their other, paid-up org.
    expect(
      resolveAiCreditsCoverage(native({ inOrg: true, orgSpendable: true }), [
        'Acme',
      ]),
    ).toEqual({
      canSpendCredits: true,
      showContactAdmin: false,
      showPurchase: false,
      lapsedOrgNames: [],
    });
  });

  it('stays silent about a lapsed org when a personal balance covers the turn', () => {
    expect(
      resolveAiCreditsCoverage(native({ personalEligible: true }), ['Acme']),
    ).toEqual({
      canSpendCredits: true,
      showContactAdmin: false,
      showPurchase: false,
      lapsedOrgNames: [],
    });
  });

  it('does not stack the quota admin message on top of the lapsed one', () => {
    // "Ask for more spend quota" is the wrong request for an org on hold.
    expect(
      resolveAiCreditsCoverage(
        native({ inOrg: true, orgCreditPoolCovered: true }),
        ['Acme'],
      ),
    ).toEqual({
      canSpendCredits: false,
      showContactAdmin: false,
      showPurchase: true,
      lapsedOrgNames: ['Acme'],
    });
  });

  it('sends an org member with pool coverage but no headroom to their admin, with no purchase CTA', () => {
    expect(
      resolveAiCreditsCoverage(
        native({ inOrg: true, orgCreditPoolCovered: true }),
      ),
    ).toEqual({
      canSpendCredits: false,
      showContactAdmin: true,
      showPurchase: false,
      lapsedOrgNames: [],
    });
  });

  it('offers the purchase CTA to an org member whose org has no credit pool', () => {
    expect(
      resolveAiCreditsCoverage(
        native({ inOrg: true, orgCreditPoolCovered: false }),
      ),
    ).toEqual({
      canSpendCredits: false,
      showContactAdmin: false,
      showPurchase: true,
      lapsedOrgNames: [],
    });
  });

  it('offers the purchase CTA to a fully uncovered account', () => {
    expect(resolveAiCreditsCoverage(native())).toEqual({
      canSpendCredits: false,
      showContactAdmin: false,
      showPurchase: true,
      lapsedOrgNames: [],
    });
  });
});

describe('openBillingPage', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const openExternal = jest.fn<Promise<void>, [{ url: string }]>();
  const openAuthenticatedPortalPage = jest.fn<Promise<boolean>, [string]>();
  const realOpenAccountOrganizationSettings =
    useNavigationStore.getState().openAccountOrganizationSettings;
  const openAccountOrganizationSettings = jest.fn<
    void,
    [SettingsRoute, unknown?]
  >();

  beforeEach(() => {
    openAccountOrganizationSettings.mockReset();
    useNavigationStore.setState({ openAccountOrganizationSettings });
    openExternal.mockReset();
    openAuthenticatedPortalPage.mockReset();
    openExternal.mockResolvedValue(undefined);
    // Main reports whether a page actually opened; "did not reject" is not
    // that answer (its fallback swallows every realistic failure).
    openAuthenticatedPortalPage.mockResolvedValue(true);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        openAuthenticatedPortalPage,
        browser: { openExternal },
      },
    });
  });

  afterEach(() => {
    useNavigationStore.setState({
      openAccountOrganizationSettings: realOpenAccountOrganizationSettings,
    });
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  function seedOwnerAndLiveOrgs(ownerOrgId: string, liveOrgId: string): void {
    useWorkspaceContextStore.setState((store) => ({
      state: {
        ...store.state,
        context: { kind: 'organization', organizationId: liveOrgId },
        organizations: [
          { id: ownerOrgId, name: 'Owner Org', role: 'OWNER' },
          { id: liveOrgId, name: 'Live Org', role: 'OWNER' },
        ],
      },
    }));
  }

  function resetOrgs(): void {
    useWorkspaceContextStore.setState((store) => ({
      state: {
        ...store.state,
        context: { kind: 'personal' },
        organizations: [],
      },
    }));
  }

  it('opens Settings → Billing in-app when hosted settings are openable, minting no auth link (CAN-4691)', async () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    await expect(openBillingPage(native())).resolves.toBe('settings');
    expect(openAccountOrganizationSettings).toHaveBeenCalledTimes(1);
    const [route] = openAccountOrganizationSettings.mock.calls[0];
    expect(settingsRouteToPath(route)).toBe('/account/billing');
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens the OWNER organization billing page in-app for an org-owned work scope (CAN-4691)', async () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    const ownerOrgId = '55555555-5555-4555-8555-555555555555';
    const liveOrgId = '66666666-6666-4666-8666-666666666666';
    seedOwnerAndLiveOrgs(ownerOrgId, liveOrgId);
    try {
      await expect(
        openBillingPage(
          native({
            ownerOrganization: { id: ownerOrgId, name: 'Owner Org' },
          }),
          { kind: 'work', projectId: 'project-a' },
        ),
      ).resolves.toBe('settings');
      expect(openAccountOrganizationSettings).toHaveBeenCalledTimes(1);
      const [route] = openAccountOrganizationSettings.mock.calls[0];
      // `parseSettingsRoutePath` keeps `?tab=billing` as `subtab`, so the
      // round trip is exact.
      expect(settingsRouteToPath(route)).toBe(
        organizationBillingPath(ownerOrgId),
      );
      expect(route).toMatchObject({
        scope: 'organization',
        organizationId: ownerOrgId,
      });
      expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    } finally {
      resetOrgs();
    }
  });

  it('falls back to the signed-in web page exactly once when hosted settings are not openable', async () => {
    await expect(openBillingPage(native())).resolves.toBe('web');
    expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
      '/account/billing',
    );
    expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('re-reads AI Credits for mounted surfaces once Settings closes after an in-app open (CAN-4691)', async () => {
    // A top-up from Settings → Billing still finishes in the browser, and the
    // banners behind Settings stay mounted with a conclusive answer that
    // nothing re-reads on a timer. Closing Settings must refresh them.
    mockHostedSettingsOpenable.mockReturnValue(true);
    invalidateAiCreditsAvailabilityCache();
    const loadNativeAiCreditsAvailability = jest
      .fn()
      .mockResolvedValue(native());
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        openAuthenticatedPortalPage,
        browser: { openExternal },
        loadNativeAiCreditsAvailability,
      },
    });
    function Consumer(): null {
      useAiCreditsAvailability();
      return null;
    }
    const reasons: string[] = [];
    const record = (event: Event): void => {
      reasons.push(readCanopyCloudAccountChangeReason(event));
    };
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, record);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(Consumer));
        await Promise.resolve();
      });
      expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(1);

      await expect(openBillingPage(native())).resolves.toBe('settings');
      act(() => {
        useNavigationStore.setState({ settingsOpen: true });
      });
      expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(1);

      await act(async () => {
        useNavigationStore.setState({ settingsOpen: false });
        await Promise.resolve();
      });
      expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(2);
      // Announced like the browser-return path, so account-scoped surfaces
      // (usage, org billing, model library) refresh too.
      expect(reasons).toEqual(['same-account-refresh']);

      // One-shot: a later Settings visit does not re-read again.
      await act(async () => {
        useNavigationStore.setState({ settingsOpen: true });
        useNavigationStore.setState({ settingsOpen: false });
        await Promise.resolve();
      });
      expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(2);
      expect(reasons).toEqual(['same-account-refresh']);
    } finally {
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, record);
      act(() => root.unmount());
      useNavigationStore.setState({ settingsOpen: false });
    }
  });

  it('never opens the pricing page when Settings opened in-app', async () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    openAuthenticatedPortalPage.mockRejectedValue(new Error('unreachable'));
    await expect(openBillingPage(native())).resolves.toBe('settings');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('hands off to the authenticated billing page', async () => {
    await expect(openBillingPage(native())).resolves.toBe('web');
    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
      '/account/billing',
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('sends an OWNER to the selected org billing page (CAN-3463)', async () => {
    const orgId = '55555555-5555-4555-8555-555555555555';
    useWorkspaceContextStore.setState((store) => ({
      state: {
        ...store.state,
        context: { kind: 'organization', organizationId: orgId },
        organizations: [{ id: orgId, name: 'Acme', role: 'OWNER' }],
      },
    }));
    try {
      await expect(openBillingPage(native())).resolves.toBe('web');
      expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
        organizationBillingPath(orgId),
      );
    } finally {
      useWorkspaceContextStore.setState((store) => ({
        state: {
          ...store.state,
          context: { kind: 'personal' },
          organizations: [],
        },
      }));
    }
  });

  it('uses the work owner instead of an unrelated live org context', async () => {
    const ownerOrgId = '55555555-5555-4555-8555-555555555555';
    const liveOrgId = '66666666-6666-4666-8666-666666666666';
    useWorkspaceContextStore.setState((store) => ({
      state: {
        ...store.state,
        context: { kind: 'organization', organizationId: liveOrgId },
        organizations: [
          { id: ownerOrgId, name: 'Owner Org', role: 'OWNER' },
          { id: liveOrgId, name: 'Live Org', role: 'OWNER' },
        ],
      },
    }));
    try {
      await expect(
        openBillingPage(
          native({
            ownerOrganization: { id: ownerOrgId, name: 'Owner Org' },
          }),
          { kind: 'work', projectId: 'project-a' },
        ),
      ).resolves.toBe('web');
      expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
        organizationBillingPath(ownerOrgId),
      );
    } finally {
      useWorkspaceContextStore.setState((store) => ({
        state: {
          ...store.state,
          context: { kind: 'personal' },
          organizations: [],
        },
      }));
    }
  });

  it('falls back to the unauthenticated pricing URL when the mint rejects', async () => {
    openAuthenticatedPortalPage.mockRejectedValue(new Error('mint failed'));
    await expect(openBillingPage(native())).resolves.toBe('web');
    expect(openExternal).toHaveBeenCalledWith({ url: PRICING_URL });
  });

  it('falls back when the handler is missing entirely (older build)', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { browser: { openExternal } },
    });
    await expect(openBillingPage(native())).resolves.toBe('web');
    expect(openExternal).toHaveBeenCalledWith({ url: PRICING_URL });
  });

  it('reports failure when the mint fails and no pricing URL is known', async () => {
    // The caller needs this answer: `GetAiCreditsCta` renders a "finish this in
    // your browser" state on a successful hand-off, and doing that when nothing
    // opened strands the user waiting on a page that never existed.
    openAuthenticatedPortalPage.mockRejectedValue(new Error('mint failed'));
    await expect(openBillingPage(null)).resolves.toBe('failed');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('falls back when main reports that nothing opened', async () => {
    // The regression this guards: main degrades flag-off / no-token / offline /
    // mint-rejected into a swallowed fallback, so a caller that trusted
    // non-rejection would believe a page opened when none did.
    openAuthenticatedPortalPage.mockResolvedValue(false);
    await expect(openBillingPage(native())).resolves.toBe('web');
    expect(openExternal).toHaveBeenCalledWith({ url: PRICING_URL });
  });

  it('reports failure when main reports nothing opened and there is no pricing URL', async () => {
    openAuthenticatedPortalPage.mockResolvedValue(false);
    await expect(openBillingPage(null)).resolves.toBe('failed');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('reports failure when the external open itself rejects', async () => {
    openAuthenticatedPortalPage.mockRejectedValue(new Error('mint failed'));
    openExternal.mockRejectedValue(new Error('no browser'));
    await expect(openBillingPage(native())).resolves.toBe('failed');
    expect(openExternal).toHaveBeenCalledWith({ url: PRICING_URL });
  });

  describe("the 'browser' destination (CAN-5159)", () => {
    function openedSearchParams(): URLSearchParams {
      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
      const [path] = openAuthenticatedPortalPage.mock.calls[0];
      return new URL(path, 'https://billing.invalid').searchParams;
    }

    it('opens the signed-in web page even when hosted settings are openable, and never re-reads on a Settings close', async () => {
      // A chat banner's "finish this in your browser" state only survives a
      // browser open; Settings → Billing would clear its hand-off.
      mockHostedSettingsOpenable.mockReturnValue(true);
      const reasons: string[] = [];
      const record = (event: Event): void => {
        reasons.push(readCanopyCloudAccountChangeReason(event));
      };
      window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, record);
      try {
        await expect(
          openBillingPage(native(), undefined, { destination: 'browser' }),
        ).resolves.toBe('web');
        expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
        expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
          '/account/billing',
        );
        expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
        expect(openExternal).not.toHaveBeenCalled();

        act(() => {
          useNavigationStore.setState({ settingsOpen: true });
        });
        act(() => {
          useNavigationStore.setState({ settingsOpen: false });
        });
        expect(reasons).toEqual([]);
      } finally {
        window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, record);
        useNavigationStore.setState({ settingsOpen: false });
      }
    });

    it('matches the default route when hosted settings are not openable', async () => {
      await expect(openBillingPage(native())).resolves.toBe('web');
      const defaultCalls = openAuthenticatedPortalPage.mock.calls.slice();
      openAuthenticatedPortalPage.mockClear();

      await expect(
        openBillingPage(native(), undefined, { destination: 'browser' }),
      ).resolves.toBe('web');
      expect(openAuthenticatedPortalPage.mock.calls).toEqual(defaultCalls);
      expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('appends the credits top-up intent to the personal billing path', async () => {
      mockHostedSettingsOpenable.mockReturnValue(true);
      await expect(
        openBillingPage(native(), undefined, {
          destination: 'browser',
          topUpSource: 'banner',
        }),
      ).resolves.toBe('web');
      const [path] = openAuthenticatedPortalPage.mock.calls[0];
      expect(new URL(path, 'https://billing.invalid').pathname).toBe(
        '/account/billing',
      );
      const params = openedSearchParams();
      expect(params.get('topUp')).toBe('1');
      expect(params.get('reason')).toBe('credits');
      expect(params.get('source')).toBe('banner');
      expect(params.has('chatId')).toBe(false);
    });

    it('keeps the organization owner path query when appending the intent', async () => {
      mockHostedSettingsOpenable.mockReturnValue(true);
      const ownerOrgId = '55555555-5555-4555-8555-555555555555';
      const liveOrgId = '66666666-6666-4666-8666-666666666666';
      seedOwnerAndLiveOrgs(ownerOrgId, liveOrgId);
      try {
        await expect(
          openBillingPage(
            native({
              ownerOrganization: { id: ownerOrgId, name: 'Owner Org' },
            }),
            { kind: 'work', projectId: 'project-a' },
            { destination: 'browser', topUpSource: 'banner' },
          ),
        ).resolves.toBe('web');
        const [path] = openAuthenticatedPortalPage.mock.calls[0];
        const opened = new URL(path, 'https://billing.invalid');
        const owner = new URL(
          organizationBillingPath(ownerOrgId),
          'https://billing.invalid',
        );
        expect(opened.pathname).toBe(owner.pathname);
        owner.searchParams.forEach((value, key) => {
          expect(opened.searchParams.get(key)).toBe(value);
        });
        const params = openedSearchParams();
        expect(params.get('topUp')).toBe('1');
        expect(params.get('reason')).toBe('credits');
        expect(params.get('source')).toBe('banner');
        expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
      } finally {
        resetOrgs();
      }
    });

    it('falls back to the plain pricing URL, without the intent, when the mint fails', async () => {
      mockHostedSettingsOpenable.mockReturnValue(true);
      openAuthenticatedPortalPage.mockRejectedValue(new Error('mint failed'));
      await expect(
        openBillingPage(native(), undefined, {
          destination: 'browser',
          topUpSource: 'banner',
        }),
      ).resolves.toBe('web');
      expect(openExternal).toHaveBeenCalledWith({ url: PRICING_URL });
      expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
    });

    it('reports failure when the mint fails and no pricing URL is known', async () => {
      mockHostedSettingsOpenable.mockReturnValue(true);
      openAuthenticatedPortalPage.mockResolvedValue(false);
      await expect(
        openBillingPage(null, undefined, {
          destination: 'browser',
          topUpSource: 'banner',
        }),
      ).resolves.toBe('failed');
      expect(openExternal).not.toHaveBeenCalled();
      expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
    });
  });
});

describe('getAiCreditsConnectContext (CAN-4691)', () => {
  it('names Settings when hosted settings are openable', () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    expect(getAiCreditsConnectContext()).toEqual({
      title: 'Get AI Credits',
      subtitle: `Connect your ${brandText.appName} account to add AI Credits.`,
      toastMessage:
        "You're connected. Opening Billing in Settings so you can add AI Credits.",
    });
  });

  it('names the web billing page otherwise', () => {
    mockHostedSettingsOpenable.mockReturnValue(false);
    expect(getAiCreditsConnectContext().toastMessage).toBe(
      "You're connected. Opening your billing page so you can add AI Credits.",
    );
  });

  it("names the web billing page for a 'browser' destination even when hosted settings are openable (CAN-5159)", () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    expect(
      getAiCreditsConnectContext({ destination: 'browser' }).toastMessage,
    ).toBe(
      "You're connected. Opening your billing page so you can add AI Credits.",
    );
  });
});

describe('useGetAiCreditsAction (CAN-4691)', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const openAuthenticatedPortalPage = jest.fn<Promise<boolean>, [string]>();
  const realRequestConnect = useCloudConnectGateStore.getState().requestConnect;
  const realOpenAccountOrganizationSettings =
    useNavigationStore.getState().openAccountOrganizationSettings;
  const openAccountOrganizationSettings = jest.fn<
    void,
    [SettingsRoute, unknown?]
  >();

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    openAuthenticatedPortalPage.mockReset().mockResolvedValue(true);
    openAccountOrganizationSettings.mockReset();
    useNavigationStore.setState({ openAccountOrganizationSettings });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        openAuthenticatedPortalPage,
        browser: { openExternal: jest.fn() },
      },
    });
  });

  afterEach(() => {
    useCloudConnectGateStore.setState({ requestConnect: realRequestConnect });
    useNavigationStore.setState({
      openAccountOrganizationSettings: realOpenAccountOrganizationSettings,
    });
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('runs the connect gate with the click-time context before opening billing', async () => {
    const requestConnect = jest.fn<
      void,
      [CloudConnectGateContext, () => unknown]
    >();
    useCloudConnectGateStore.setState({ requestConnect });
    // At hook creation hosted settings are off; the click flips them on.
    mockHostedSettingsOpenable.mockReturnValue(false);
    let action: ReturnType<typeof useGetAiCreditsAction> | undefined;
    function Probe(): null {
      action = useGetAiCreditsAction();
      return null;
    }
    const root = createRoot(document.createElement('div'));
    try {
      act(() => {
        root.render(createElement(Probe));
      });
      mockHostedSettingsOpenable.mockReturnValue(true);
      act(() => {
        action?.(native());
      });

      expect(requestConnect).toHaveBeenCalledTimes(1);
      const [context, proceed] = requestConnect.mock.calls[0];
      expect(context.toastMessage).toContain('Billing in Settings');
      // Gate first: nothing opens until the gate resumes the hand-off.
      expect(openAccountOrganizationSettings).not.toHaveBeenCalled();

      await act(async () => {
        await proceed();
      });
      expect(openAccountOrganizationSettings).toHaveBeenCalledTimes(1);
      expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});

/**
 * CAN-4028 — opening browser checkout for the purchase that unlocks advanced
 * models. Distinct from the credits hand-off above: it carries an already-open
 * top-up intent, refuses to sell a personal purchase for work it cannot
 * unlock, and remembers the attempt so the desktop can confirm it.
 */
describe('unlockModels', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const ORG_ID = '55555555-5555-4555-8555-555555555555';
  const ACCOUNT_KEY = 'account:acct_1';
  const openAuthenticatedPortalPage = jest.fn();
  const paymentHandoff = jest.fn<
    Promise<unknown>,
    Parameters<AccountOrganizationSettingsApi['paymentHandoff']>
  >();
  const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
  const loadNativeAiCreditsAvailability = jest.fn();
  const loadCanopyCloudAccount = jest.fn();
  const loadCanopyCloudEntitlements = jest.fn();
  const realRequestConnect = useCloudConnectGateStore.getState().requestConnect;

  function entitlementsWith(
    modelLibrary: unknown,
    accountKey: string | null = ACCOUNT_KEY,
  ): Record<string, unknown> {
    return {
      resolved: true,
      modelLibrary,
      modelLibraryAccountKey: accountKey,
      workModelLibrary: modelLibrary,
      modelLibraryOwnerKey: 'personal',
    };
  }

  function setOrganizationRole(role: 'OWNER' | 'ADMIN' | 'MEMBER'): void {
    useWorkspaceContextStore.setState((store) => ({
      state: {
        ...store.state,
        organizations: [{ id: ORG_ID, name: 'Acme', role }],
      },
    }));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    invalidateSharedAiCreditsRead();
    resetModelLibraryAccessForTests();
    resetModelUnlockIntentForTests();
    openAuthenticatedPortalPage.mockResolvedValue(true);
    paymentHandoff
      .mockReset()
      .mockResolvedValue({ ok: true, requestId: REQUEST_ID });
    loadNativeAiCreditsAvailability.mockResolvedValue(
      // Spendable daily credits: the state that must NOT read as solved.
      native({ personalEligible: true }),
    );
    loadCanopyCloudAccount.mockReset().mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct_1' },
      authMode: 'oauth',
      credentialSource: 'oauth',
    });
    loadCanopyCloudEntitlements
      .mockReset()
      .mockResolvedValue(
        entitlementsWith({ status: 'reported', access: 'needs_purchase' }),
      );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        openAuthenticatedPortalPage,
        accountOrganizationSettings: { paymentHandoff },
        loadNativeAiCreditsAvailability,
        loadCanopyCloudAccount,
        loadCanopyCloudEntitlements,
      },
    });
  });

  afterEach(() => {
    useCloudConnectGateStore.setState({ requestConnect: realRequestConnect });
    useWorkspaceContextStore.setState((store) => ({
      state: { ...store.state, organizations: [] },
    }));
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('opens personal billing with an already-open unlock top-up and remembers the attempt', async () => {
    const result = await unlockModels(undefined, {
      source: 'desktop',
      modelId: 'some-model',
      chatId: 'chat-1',
    });

    const requestId = REQUEST_ID;
    expect(paymentHandoff).toHaveBeenCalledWith({
      accountId: 'acct_1',
      owner: { kind: 'personal' },
      intent: {
        kind: 'top-up',
        reason: 'unlock_models',
        source: 'desktop',
        modelId: 'some-model',
        chatId: 'chat-1',
      },
    });
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'opened', requestId });
    const started = useModelUnlockIntentStore.getState();
    expect(started).toMatchObject({
      phase: 'waiting',
      intent: {
        requestId,
        accountId: ACCOUNT_KEY,
        owner: 'personal',
        chatId: 'chat-1',
        modelId: 'some-model',
      },
    });
    expect(typeof started.intent?.startedAt).toBe('number');
  });

  describe('starting balance (CAN-5160)', () => {
    const balance = (credits: number): unknown => ({
      connected: true,
      email: 'buyer@example.com',
      subscription: null,
      balance: {
        email: 'buyer@example.com',
        credits,
        eligible: credits > 0,
        source: 'canopy',
      },
      noUdAccount: false,
      error: null,
    });

    it('remembers the balance read before checkout opened', async () => {
      const loadCanopyCloudAiCredits = jest.fn().mockResolvedValue(balance(0));
      Object.assign(window.api, { loadCanopyCloudAiCredits });

      await unlockModels(
        { kind: 'work', projectId: 'p1', chatId: 'chat-1' },
        { source: 'desktop', chatId: 'chat-1' },
      );

      expect(loadCanopyCloudAiCredits.mock.invocationCallOrder[0]).toBeLessThan(
        paymentHandoff.mock.invocationCallOrder[0] ?? 0,
      );
      expect(
        useModelUnlockIntentStore.getState().intent?.startingBalance,
      ).toEqual({
        credits: 0,
        source: 'canopy',
        email: 'buyer@example.com',
        reportedGrant: false,
      });
    });

    it('claims no starting balance when the read finished after checkout opened', async () => {
      let answer: (value: unknown) => void = () => {};
      const loadCanopyCloudAiCredits = jest.fn().mockReturnValue(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );
      Object.assign(window.api, { loadCanopyCloudAiCredits });
      paymentHandoff.mockImplementation(async () => {
        answer(balance(0));
        await Promise.resolve();
        return { ok: true, requestId: REQUEST_ID };
      });

      await unlockModels(
        { kind: 'work', projectId: 'p1', chatId: 'chat-1' },
        { source: 'desktop', chatId: 'chat-1' },
      );

      expect(useModelUnlockIntentStore.getState().intent).not.toBeNull();
      expect(
        useModelUnlockIntentStore.getState().intent?.startingBalance,
      ).toBeUndefined();
    });
  });

  it('tells an organization member who cannot fund the owner to contact an admin', async () => {
    // The work is the organization's, so a personal purchase would not unlock
    // it. No browser, no pending intent.
    loadNativeAiCreditsAvailability.mockResolvedValue(
      native({ inOrg: true, ownerOrganization: { id: ORG_ID, name: 'Acme' } }),
    );
    setOrganizationRole('MEMBER');

    await expect(
      unlockModels(undefined, { source: 'desktop' }),
    ).resolves.toEqual({ outcome: 'contact-admin' });
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    expect(useModelUnlockIntentStore.getState().intent).toBeNull();
  });

  it('follows an organization OWNER checkout using organization access', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(
      native({ inOrg: true, ownerOrganization: { id: ORG_ID, name: 'Acme' } }),
    );
    setOrganizationRole('OWNER');
    loadCanopyCloudEntitlements.mockResolvedValue({
      ...entitlementsWith({ status: 'reported', access: 'needs_purchase' }),
      modelLibraryOwnerKey: `org:${ORG_ID}`,
    });

    await expect(
      unlockModels(undefined, { source: 'desktop' }),
    ).resolves.toMatchObject({ outcome: 'opened' });
    expect(paymentHandoff).toHaveBeenCalledWith({
      accountId: 'acct_1',
      owner: { kind: 'organization', organizationId: ORG_ID },
      intent: { kind: 'top-up', reason: 'unlock_models', source: 'desktop' },
    });
    expect(useModelUnlockIntentStore.getState().intent?.owner).toBe(
      `org:${ORG_ID}`,
    );
  });

  it('skips checkout when a fresh read says the account is already unlocked', async () => {
    loadCanopyCloudEntitlements.mockResolvedValue(
      entitlementsWith({ status: 'reported', access: 'unlocked' }),
    );
    await expect(
      unlockModels(undefined, { source: 'desktop', modelId: 'some-model' }),
    ).resolves.toEqual({ outcome: 'unlocked' });
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
  });

  it('does not skip checkout on a retained (non-authoritative) unlocked', async () => {
    loadCanopyCloudEntitlements.mockResolvedValue(
      entitlementsWith({ status: 'retained', access: 'unlocked' }),
    );
    await expect(
      unlockModels(undefined, { source: 'desktop' }),
    ).resolves.toMatchObject({ outcome: 'opened' });
  });

  it('reports failure and remembers nothing when no page opened', async () => {
    paymentHandoff.mockResolvedValue({ ok: false, reason: 'failed' });
    await expect(
      unlockModels(undefined, { source: 'desktop', modelId: 'some-model' }),
    ).resolves.toEqual({ outcome: 'failed' });
    expect(useModelUnlockIntentStore.getState().intent).toBeNull();

    paymentHandoff.mockRejectedValue(new Error('no bridge'));
    await expect(
      unlockModels(undefined, { source: 'desktop' }),
    ).resolves.toEqual({ outcome: 'failed' });
  });

  it('leaves ids that do not fit the link out of it, without failing the purchase', async () => {
    await expect(
      unlockModels(undefined, {
        source: 'desktop',
        modelId: 'has spaces',
        chatId: 'chat-1',
      }),
    ).resolves.toMatchObject({ outcome: 'opened' });
    expect(paymentHandoff.mock.calls[0][0].intent).not.toHaveProperty(
      'modelId',
    );
    // The pending intent keeps the real value.
    expect(useModelUnlockIntentStore.getState().intent?.modelId).toBe(
      'has spaces',
    );
  });

  it('sends a guest through the sign-in gate before any checkout', async () => {
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      account: { id: 'guest_1' },
      authMode: 'guest',
      credentialSource: 'guest',
    });
    const proceed: Array<() => void> = [];
    const requestConnect = jest.fn<void, [context: unknown, next: () => void]>(
      (...args): void => {
        proceed.push(args[1]);
      },
    );
    useCloudConnectGateStore.setState({ requestConnect });

    await expect(
      unlockModels(undefined, { source: 'desktop', modelId: 'some-model' }),
    ).resolves.toEqual({ outcome: 'sign-in' });
    expect(requestConnect).toHaveBeenCalledWith(
      {
        title: 'Unlock advanced models',
        subtitle: 'Sign in, then purchase AI Credits.',
      },
      expect.any(Function),
    );
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();

    // After sign-in the account is re-read. One that already qualifies is
    // never sent to checkout.
    loadCanopyCloudEntitlements.mockResolvedValue(
      entitlementsWith({ status: 'reported', access: 'unlocked' }),
    );
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct_1' },
      authMode: 'oauth',
    });
    expect(proceed).toHaveLength(1);
    proceed[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    expect(paymentHandoff).not.toHaveBeenCalled();
    expect(useModelUnlockIntentStore.getState().intent).toBeNull();
  });

  it('binds a successful guest continuation to the newly signed-in account and owner', async () => {
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      account: { id: 'guest' },
      authMode: 'guest',
    });
    const continuations: Array<() => void> = [];
    useCloudConnectGateStore.setState({
      requestConnect: (_context, proceed) => {
        continuations.push(proceed);
      },
    });
    const apply = jest.fn();
    await expect(
      unlockModels(undefined, {
        source: 'desktop',
        modelId: 'some-model',
        chatId: 'chat-1',
        apply,
      }),
    ).resolves.toEqual({ outcome: 'sign-in' });
    expect(paymentHandoff).not.toHaveBeenCalled();
    expect(useModelUnlockIntentStore.getState().intent).toBeNull();
    setOrganizationRole('OWNER');
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      account: { id: 'signed-in-2' },
    });
    loadNativeAiCreditsAvailability.mockResolvedValue(
      native({ ownerOrganization: { id: ORG_ID, name: 'Acme' } }),
    );
    loadCanopyCloudEntitlements.mockResolvedValue({
      ...entitlementsWith(
        { status: 'reported', access: 'needs_purchase' },
        'account:signed-in-2',
      ),
      modelLibraryOwnerKey: `org:${ORG_ID}`,
    });
    continuations[0]();
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(paymentHandoff).toHaveBeenCalledTimes(1);
    expect(paymentHandoff).toHaveBeenCalledWith({
      accountId: 'signed-in-2',
      owner: { kind: 'organization', organizationId: ORG_ID },
      intent: {
        kind: 'top-up',
        reason: 'unlock_models',
        source: 'desktop',
        modelId: 'some-model',
        chatId: 'chat-1',
      },
    });
    expect(useModelUnlockIntentStore.getState().intent).toMatchObject({
      requestId: REQUEST_ID,
      accountId: 'account:signed-in-2',
      owner: `org:${ORG_ID}`,
      modelId: 'some-model',
      chatId: 'chat-1',
    });
    expect(apply).not.toHaveBeenCalled();
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
  });

  it('cancelling guest sign-in never starts checkout or a pending intent', async () => {
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      account: { id: 'guest' },
      authMode: 'guest',
    });
    const requestConnect = jest.fn();
    useCloudConnectGateStore.setState({ requestConnect });
    await expect(
      unlockModels(undefined, { source: 'desktop' }),
    ).resolves.toEqual({ outcome: 'sign-in' });
    expect(requestConnect).toHaveBeenCalledTimes(1);
    // Cancellation does not invoke the saved continuation.
    await Promise.resolve();
    expect(paymentHandoff).not.toHaveBeenCalled();
    expect(useModelUnlockIntentStore.getState().intent).toBeNull();
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
  });
  it.each([
    { ok: false, reason: 'unavailable' },
    { ok: false, reason: 'forbidden' },
    { ok: false, reason: 'identity_changed' },
    { ok: false, reason: 'browser_failed' },
    true,
    null,
    { ok: true, requestId: 'bad id' },
    { ok: false, reason: 'failed', requestId: REQUEST_ID },
  ])(
    'fails closed on an invalid or unsuccessful handoff: %j',
    async (reply) => {
      paymentHandoff.mockResolvedValue(reply);
      const apply = jest.fn();
      await expect(
        unlockModels(undefined, { source: 'desktop', apply }),
      ).resolves.toEqual({ outcome: 'failed' });
      expect(useModelUnlockIntentStore.getState().intent).toBeNull();
      expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
    },
  );

  it('accepts old success without inventing correlation', async () => {
    paymentHandoff.mockResolvedValue({ ok: true });
    await expect(
      unlockModels(undefined, { source: 'desktop' }),
    ).resolves.toEqual({ outcome: 'opened' });
    expect(useModelUnlockIntentStore.getState().intent).toBeNull();
  });

  it.each([
    null,
    { hasApiKey: false, account: { id: 'acct_1' } },
    { hasApiKey: true },
  ])('requires a real account: %j', async (account) => {
    // Without a connected account there is nobody to bill, so the click asks
    // for a sign-in instead of opening checkout (CAN-4703).
    loadCanopyCloudAccount.mockResolvedValue(account);
    const requestConnect = jest.fn();
    useCloudConnectGateStore.setState({ requestConnect });
    await expect(
      unlockModels(undefined, { source: 'desktop' }),
    ).resolves.toEqual({ outcome: 'sign-in' });
    expect(requestConnect).toHaveBeenCalledTimes(1);
    expect(paymentHandoff).not.toHaveBeenCalled();
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
  });

  it('fails on unreadable credentials', async () => {
    loadCanopyCloudAccount.mockRejectedValue(new Error('unreadable'));
    await expect(
      unlockModels(undefined, { source: 'desktop' }),
    ).resolves.toEqual({ outcome: 'failed' });
    expect(paymentHandoff).not.toHaveBeenCalled();
  });

  it.each(['account:other', null])(
    'rejects a known model-library account mismatch: %s',
    async (key) => {
      loadCanopyCloudEntitlements.mockResolvedValue(
        entitlementsWith({ status: 'reported', access: 'unlocked' }, key),
      );
      await expect(
        unlockModels(undefined, { source: 'desktop' }),
      ).resolves.toEqual({ outcome: 'failed' });
      expect(paymentHandoff).not.toHaveBeenCalled();
    },
  );

  it('rejects a known owner mismatch', async () => {
    loadCanopyCloudEntitlements.mockResolvedValue({
      ...entitlementsWith({ status: 'reported', access: 'unlocked' }),
      modelLibraryOwnerKey: `org:${ORG_ID}`,
    });
    await expect(
      unlockModels(undefined, { source: 'desktop' }),
    ).resolves.toEqual({ outcome: 'failed' });
    expect(paymentHandoff).not.toHaveBeenCalled();
  });

  it('can open without an available library read, but cannot track it', async () => {
    loadCanopyCloudEntitlements.mockRejectedValue(new Error('unavailable'));
    await expect(
      unlockModels(undefined, { source: 'desktop' }),
    ).resolves.toEqual({ outcome: 'opened' });
    expect(paymentHandoff).toHaveBeenCalledTimes(1);
    expect(useModelUnlockIntentStore.getState().intent).toBeNull();
  });

  it('does not track a library response that carries no access answer', async () => {
    loadCanopyCloudEntitlements.mockResolvedValue(
      entitlementsWith({ status: 'unavailable' }),
    );
    await expect(
      unlockModels(undefined, { source: 'desktop' }),
    ).resolves.toEqual({ outcome: 'opened' });
    expect(paymentHandoff).toHaveBeenCalledTimes(1);
    expect(useModelUnlockIntentStore.getState().intent).toBeNull();
  });

  it('does not open or report already unlocked after an account event during the read', async () => {
    loadCanopyCloudEntitlements.mockImplementation(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      return Promise.resolve(
        entitlementsWith({ status: 'reported', access: 'unlocked' }),
      );
    });
    await expect(
      unlockModels(undefined, { source: 'desktop' }),
    ).resolves.toEqual({ outcome: 'failed' });
    expect(paymentHandoff).not.toHaveBeenCalled();
  });

  it('does not open after a navigation scope change', async () => {
    const previous = useWorkspaceContextStore.getState().state;
    loadCanopyCloudEntitlements.mockImplementation(() => {
      useWorkspaceContextStore.setState({
        state: {
          ...previous,
          context: { kind: 'organization', organizationId: ORG_ID },
        },
      });
      return Promise.resolve(
        entitlementsWith({ status: 'reported', access: 'needs_purchase' }),
      );
    });
    try {
      await expect(
        unlockModels(undefined, { source: 'desktop' }),
      ).resolves.toEqual({ outcome: 'failed' });
      expect(paymentHandoff).not.toHaveBeenCalled();
    } finally {
      useWorkspaceContextStore.setState({ state: previous });
    }
  });

  it.each(['owner', 'account', 'exception', 'epoch'])(
    'keeps opened success without tracking after post-open %s change',
    async (change) => {
      paymentHandoff.mockImplementation(() => {
        if (change === 'owner')
          loadNativeAiCreditsAvailability.mockResolvedValue(
            native({ ownerOrganization: { id: ORG_ID, name: 'Acme' } }),
          );
        if (change === 'account')
          loadCanopyCloudAccount.mockResolvedValue({
            hasApiKey: true,
            account: { id: 'other' },
          });
        if (change === 'exception')
          loadCanopyCloudAccount.mockRejectedValue(new Error('unreadable'));
        if (change === 'epoch')
          window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        return Promise.resolve({ ok: true, requestId: REQUEST_ID });
      });
      await expect(
        unlockModels(undefined, { source: 'desktop' }),
      ).resolves.toEqual({ outcome: 'opened' });
      expect(useModelUnlockIntentStore.getState().intent).toBeNull();
    },
  );

  it('does not replace an existing intent when a later attempt fails', async () => {
    await unlockModels(undefined, { source: 'desktop', modelId: 'first' });
    const previous = useModelUnlockIntentStore.getState().intent;
    paymentHandoff.mockResolvedValue({ ok: false, reason: 'failed' });
    await expect(
      unlockModels(undefined, { source: 'desktop', modelId: 'second' }),
    ).resolves.toEqual({ outcome: 'failed' });
    expect(useModelUnlockIntentStore.getState().intent).toBe(previous);
  });

  it('cannot replace a newer intent with an out-of-order opening', async () => {
    let completeFirst: (value: unknown) => void = () => {
      throw new Error('First handoff not started');
    };
    const firstReply = new Promise((resolve) => {
      completeFirst = resolve;
    });
    paymentHandoff.mockReturnValueOnce(firstReply);
    const first = unlockModels(undefined, {
      source: 'desktop',
      modelId: 'first',
    });
    for (let i = 0; i < 30 && paymentHandoff.mock.calls.length === 0; i++)
      await Promise.resolve();
    expect(paymentHandoff).toHaveBeenCalledTimes(1);
    await unlockModels(undefined, { source: 'desktop', modelId: 'second' });
    completeFirst({
      ok: true,
      requestId: '22222222-2222-4222-8222-222222222222',
    });
    await expect(first).resolves.toEqual({ outcome: 'opened' });
    expect(useModelUnlockIntentStore.getState().intent).toMatchObject({
      requestId: REQUEST_ID,
      modelId: 'second',
    });
  });

  it('reports a failed guest continuation once, without retrying checkout', async () => {
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      account: { id: 'guest' },
      authMode: 'guest',
    });
    const continuations: Array<() => void> = [];
    useCloudConnectGateStore.setState({
      requestConnect: (_context, proceed) => {
        continuations.push(proceed);
      },
    });
    const toast = jest
      .spyOn(useGitHubStore.getState(), 'addToast')
      .mockImplementation(() => undefined);
    await expect(
      unlockModels(undefined, { source: 'desktop' }),
    ).resolves.toEqual({ outcome: 'sign-in' });
    expect(paymentHandoff).not.toHaveBeenCalled();
    // Cancellation leaves the callback uncalled and opens nothing.
    expect(toast).not.toHaveBeenCalled();
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct_1' },
    });
    paymentHandoff.mockRejectedValue(new Error('unavailable'));
    continuations[0]();
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(paymentHandoff).toHaveBeenCalledTimes(1);
    expect(useModelUnlockIntentStore.getState().intent).toBeNull();
    toast.mockRestore();
  });

  it('leaves a failed guest continuation to a caller that narrates it', async () => {
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      account: { id: 'guest' },
      authMode: 'guest',
    });
    const continuations: Array<() => void> = [];
    useCloudConnectGateStore.setState({
      requestConnect: (_context, proceed) => {
        continuations.push(proceed);
      },
    });
    const toast = jest
      .spyOn(useGitHubStore.getState(), 'addToast')
      .mockImplementation(() => undefined);
    const onResumed = jest.fn();
    await unlockModels(undefined, { source: 'desktop', onResumed });
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct_1' },
    });
    paymentHandoff.mockRejectedValue(new Error('unavailable'));
    continuations[0]();
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(onResumed).toHaveBeenCalledWith({ outcome: 'failed' });
    expect(toast).not.toHaveBeenCalled();
    toast.mockRestore();
  });

  it('sends a visitor with no account through the sign-in gate too', async () => {
    // No credential cannot buy either: checkout would fail closed and strand
    // the visitor on a browser error instead of a sign-in.
    loadCanopyCloudAccount.mockResolvedValue(null);
    const requestConnect = jest.fn();
    useCloudConnectGateStore.setState({ requestConnect });

    await expect(
      unlockModels(undefined, { source: 'desktop', modelId: 'some-model' }),
    ).resolves.toEqual({ outcome: 'sign-in' });
    expect(requestConnect).toHaveBeenCalledTimes(1);
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
  });

  it('opens checkout straight after sign-in and reports it to the caller', async () => {
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      account: { id: 'guest_1' },
      authMode: 'guest',
      credentialSource: 'guest',
    });
    const proceed: Array<() => void> = [];
    const requestConnect = jest.fn((_context: unknown, next: () => void) => {
      proceed.push(next);
    });
    useCloudConnectGateStore.setState({ requestConnect });
    const onResumed = jest.fn();

    await unlockModels(undefined, {
      source: 'desktop',
      modelId: 'some-model',
      onResumed,
    });
    expect(onResumed).not.toHaveBeenCalled();

    // Signed in: a real account that still needs the purchase.
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct_1' },
      authMode: 'oauth',
      credentialSource: 'oauth',
    });
    proceed[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(paymentHandoff).toHaveBeenCalledTimes(1);
    expect(paymentHandoff.mock.calls[0]?.[0]).toMatchObject({
      accountId: 'acct_1',
      intent: { reason: 'unlock_models' },
    });
    expect(onResumed).toHaveBeenCalledWith({
      outcome: 'opened',
      requestId: REQUEST_ID,
    });
  });

  it('joins the post-sign-in availability read instead of superseding it', async () => {
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      account: { id: 'guest_1' },
      authMode: 'guest',
      credentialSource: 'guest',
    });
    const proceed: Array<() => void> = [];
    useCloudConnectGateStore.setState({
      requestConnect: jest.fn((_context: unknown, next: () => void) => {
        proceed.push(next);
      }),
    });
    await unlockModels(undefined, { source: 'desktop', modelId: 'some-model' });

    // The gate closes on sign-in: a new episode, and the recovery modal
    // re-reads in it before the resumed checkout runs.
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct_1' },
      authMode: 'oauth',
      credentialSource: 'oauth',
    });
    invalidateSharedAiCreditsRead();
    const modalRead = readSharedAiCreditsAvailability();
    proceed[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(paymentHandoff).toHaveBeenCalledTimes(1);
    // A fresh read here would retract the modal's answer to `null`, which it
    // shows as "we couldn't check your account" over an open checkout.
    await expect(modalRead).resolves.not.toBeNull();
    // The modal's read, joined by checkout, then the owner re-read that
    // follows the opened checkout. A superseding first read would add a third.
    expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(2);
  });
});
