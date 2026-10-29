/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyApi,
  CanopyCloudAccountPublicState,
  CanopyCloudEntitlementsState,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { GUEST_SIGN_IN_CTA_LABEL } from '@/lib/guest-cta-copy';
import { useSubscriptionStatus } from '../useSubscriptionStatus';
import { organizationBillingPath } from '@canopy/protocol/billing';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;

  interface Window {
    api: CanopyApi;
  }
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/**
 * Explicitly typed deferred so a test can hold one refresh's IPC call in flight
 * while asserting on the frames committed during that window. A flicker only
 * exists while the request is unresolved, so the pending window *is* the test.
 */
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A frame is one committed render of the hook's public result. */
interface Frame {
  loading: boolean;
  visible: boolean;
  label: string | null;
  guestCta: boolean;
  freeAccess?: boolean;
  aiCredits?: boolean;
  billingAction?: string | null;
}

/** When set, frames also record the free-access projection of the result. */
let recordFreeAccess = false;

function Harness({ frames }: { frames: Frame[] }): JSX.Element {
  const result = useSubscriptionStatus();
  frames.push({
    loading: result.loading,
    visible: result.visible,
    label: result.status?.label ?? null,
    guestCta: result.guestCtaVisible,
    ...(recordFreeAccess
      ? {
          freeAccess: result.freeAccess,
          aiCredits: result.aiCreditsVisible,
          billingAction: result.billingAction?.label ?? null,
        }
      : {}),
  });
  return (
    // Wrapped because `onClick` erases the argument, so passing the handler
    // bare has React invoking it with a
    // synthetic mouse event as its options bag. The title assertion below is
    // meant to pin the no-arg default path, so the harness has to take it.
    <>
      <button
        data-testid="start-free-trial"
        onClick={(): void => result.startFreeTrial()}
      />
      {/* Second entry point, for the override path. A caller with its own pitch
          passes all three fields; without it nothing exercises the `??` sites
          in the hook. */}
      <button
        data-testid="start-free-trial-override"
        onClick={(): void =>
          result.startFreeTrial({
            title: 'Override title',
            description: 'Override description',
            toastMessage: 'Override toast',
          })
        }
      />
    </>
  );
}

function makeAccount(
  overrides: Partial<CanopyCloudAccountPublicState> = {},
): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    capabilities: [],
    storageAvailable: true,
    account: {
      id: 'acct_1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      role: 'DEVELOPER',
    },
    ...overrides,
  };
}

function guestAccount(): CanopyCloudAccountPublicState {
  return makeAccount({
    authMode: 'guest',
    credentialSource: 'guest',
    account: {
      id: 'guest_1',
      name: 'Guest',
      email: 'guest+1@guest.canopy.invalid',
      role: 'DEVELOPER',
    },
  });
}

function signedOutAccount(): CanopyCloudAccountPublicState {
  return makeAccount({
    hasApiKey: false,
    authMode: null,
    credentialSource: null,
    account: null,
  });
}

function resolvedEntitlements(
  displayName: string,
): CanopyCloudEntitlementsState {
  return {
    resolved: true,
    canDisableSharing: true,
    canRemoteControl: true,
    source: 'subscription',
    plan: { key: displayName.toLowerCase(), displayName },
    trial: null,
    billingManageableOrg: null,
    displayPlan: null,
  };
}

const UNRESOLVED_ENTITLEMENTS: CanopyCloudEntitlementsState = {
  resolved: false,
  canDisableSharing: false,
  canRemoteControl: false,
  source: 'none',
  plan: null,
  trial: null,
  billingManageableOrg: null,
  displayPlan: null,
};

/** Sign-out shape: resolved, but with no grant at all. */
const UNLINKED_ENTITLEMENTS: CanopyCloudEntitlementsState = {
  resolved: true,
  canDisableSharing: false,
  canRemoteControl: false,
  source: 'none',
  plan: null,
  trial: null,
  billingManageableOrg: null,
  displayPlan: null,
};

interface Queues {
  accounts: Array<
    CanopyCloudAccountPublicState | Promise<CanopyCloudAccountPublicState>
  >;
  entitlements: Array<
    CanopyCloudEntitlementsState | Promise<CanopyCloudEntitlementsState>
  >;
}

let loadAccount: jest.Mock;
let loadEntitlements: jest.Mock;

/**
 * Queue-backed bridges so call #1 and call #2 can differ — the whole point of a
 * background-refresh test. Once a queue drains, the last value repeats.
 */
function installWindowApi(queues: Queues): void {
  const accounts = [...queues.accounts];
  const entitlements = [...queues.entitlements];
  let lastAccount = accounts[accounts.length - 1] ?? makeAccount();
  let lastEntitlements =
    entitlements[entitlements.length - 1] ?? UNRESOLVED_ENTITLEMENTS;
  loadAccount = jest.fn().mockImplementation(() => {
    const next = accounts.shift();
    if (next !== undefined) lastAccount = next;
    return Promise.resolve(lastAccount);
  });
  loadEntitlements = jest.fn().mockImplementation(() => {
    const next = entitlements.shift();
    if (next !== undefined) lastEntitlements = next;
    return Promise.resolve(lastEntitlements);
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadCanopyCloudAccount: loadAccount,
      loadCanopyCloudEntitlements: loadEntitlements,
      getCanopyCloudBaseUrl: jest.fn().mockResolvedValue(null),
      openAuthenticatedPortalPage: jest.fn().mockResolvedValue(undefined),
      browser: { openExternal: jest.fn().mockResolvedValue(undefined) },
    },
  });
}

function setBillingFlag(enabled: boolean): void {
  const snapshot = getDefaultFeatureFlagSnapshot();
  snapshot.values['canopy-billing-enabled'] = enabled;
  useFeatureFlagsStore.setState({ snapshot });
}

/** Drain the microtask queue so chained `.then` handlers commit. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

interface Mounted {
  frames: Frame[];
  cleanup: () => void;
}

async function mount(): Promise<Mounted> {
  const frames: Frame[] = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<Harness frames={frames} />);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
  return {
    frames,
    cleanup: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function dispatchAccountChanged(): void {
  act(() => {
    window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
  });
}

describe('useSubscriptionStatus', () => {
  beforeEach(() => {
    setBillingFlag(true);
    useCloudConnectGateStore.setState({ pending: null });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'api');
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
  });

  it('never re-raises the skeleton during a background refresh', async () => {
    const pending = deferred<CanopyCloudEntitlementsState>();
    installWindowApi({
      accounts: [makeAccount()],
      entitlements: [resolvedEntitlements('Business'), pending.promise],
    });
    const { frames, cleanup } = await mount();
    expect(frames[frames.length - 1]).toEqual({
      loading: false,
      visible: true,
      label: 'Business',
      guestCta: false,
    });

    frames.length = 0;
    dispatchAccountChanged();
    await flush();

    // Every frame committed while the second entitlements read is still in
    // flight must keep showing the known plan.
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.loading).toBe(false);
      expect(frame.visible).toBe(true);
      expect(frame.label).toBe('Business');
    }

    pending.resolve(resolvedEntitlements('Business'));
    await flush();
    cleanup();
  });

  it('holds the last plan when a background refresh rejects', async () => {
    installWindowApi({
      accounts: [makeAccount()],
      entitlements: [
        resolvedEntitlements('Business'),
        Promise.reject(new Error('offline')),
      ],
    });
    const { frames, cleanup } = await mount();

    frames.length = 0;
    dispatchAccountChanged();
    await flush();

    for (const frame of frames) {
      expect(frame.loading).toBe(false);
      expect(frame.visible).toBe(true);
      expect(frame.label).toBe('Business');
    }
    cleanup();
  });

  it('holds the last plan when a background refresh is unresolved', async () => {
    installWindowApi({
      accounts: [makeAccount()],
      entitlements: [resolvedEntitlements('Business'), UNRESOLVED_ENTITLEMENTS],
    });
    const { frames, cleanup } = await mount();

    frames.length = 0;
    dispatchAccountChanged();
    await flush();

    for (const frame of frames) {
      expect(frame.loading).toBe(false);
      expect(frame.visible).toBe(true);
      expect(frame.label).toBe('Business');
    }
    cleanup();
  });

  it('never reports a signed-in user as signed out when the account re-read fails', async () => {
    installWindowApi({
      accounts: [makeAccount(), Promise.reject(new Error('bridge down'))],
      entitlements: [resolvedEntitlements('Business')],
    });
    const { frames, cleanup } = await mount();

    frames.length = 0;
    dispatchAccountChanged();
    await flush();

    for (const frame of frames) {
      expect(frame.guestCta).toBe(false);
      expect(frame.visible).toBe(true);
      expect(frame.label).toBe('Business');
    }
    cleanup();
  });

  // A degraded secure-store read does not reject — the main process collapses
  // `unavailable`/`error` to a null entry, which serializes as a fully-formed
  // *resolved* signed-out snapshot. It therefore lands on the `.then` path, so
  // the rejection guard above cannot catch it. These two cases are the dominant
  // real-world failure mode (a re-decrypt on an ambient re-probe past the 5s
  // account cache TTL), and without the `read` discriminator they blank the plan.
  it.each(['unavailable', 'error'] as const)(
    'never reports a signed-in user as signed out when the account re-read is degraded (%s)',
    async (read) => {
      installWindowApi({
        accounts: [makeAccount(), makeAccount({ ...signedOutAccount(), read })],
        entitlements: [resolvedEntitlements('Business')],
      });
      const { frames, cleanup } = await mount();

      frames.length = 0;
      dispatchAccountChanged();
      await flush();

      for (const frame of frames) {
        expect(frame.guestCta).toBe(false);
        expect(frame.visible).toBe(true);
        expect(frame.label).toBe('Business');
      }
      cleanup();
    },
  );

  it('still treats an explicit read:ok sign-out as authoritative', async () => {
    installWindowApi({
      accounts: [makeAccount(), { ...signedOutAccount(), read: 'ok' }],
      entitlements: [resolvedEntitlements('Business'), UNLINKED_ENTITLEMENTS],
    });
    const { frames, cleanup } = await mount();

    frames.length = 0;
    dispatchAccountChanged();
    await flush();

    const last = frames[frames.length - 1];
    expect(last.visible).toBe(false);
    expect(last.guestCta).toBe(true);
    cleanup();
  });

  it.each([
    // Neither path carries a subheading. The guest one never did — the credits
    // it used to state there ("already available") read as a reason NOT to sign
    // in, and the benefit rows below now make the same point as something
    // sign-in keeps giving you. The signed-out one lost its line because
    // "Sign in to get your free AI credits." sat directly under a title that
    // also opens "Sign in to get", promising something different.
    //
    // The success toast never mentions credits: the daily free AI Credits are
    // opt-in, so signing in alone does not make any credits ready to use.
    [
      'guest',
      guestAccount(),
      true,
      "You're all set. Your guest work is synced.",
    ],
    ['ordinary signed-out user', signedOutAccount(), false, "You're all set."],
  ])(
    'uses guest benefit copy only for a confirmed %s',
    async (_label, account, expected, expectedToast) => {
      installWindowApi({
        accounts: [account],
        entitlements: [UNLINKED_ENTITLEMENTS],
      });
      const { cleanup } = await mount();
      act(() => {
        document
          .querySelector<HTMLButtonElement>('[data-testid="start-free-trial"]')
          ?.click();
      });
      await flush();

      expect(
        useCloudConnectGateStore.getState().pending?.context.guestBenefits,
      ).toBe(expected);
      // Neither row carries one, so this is asserted inline rather than as a
      // table column that never varies. Still non-vacuous: a modal that never
      // opened yields `undefined`, which fails `toBeNull`.
      expect(
        useCloudConnectGateStore.getState().pending?.context.subtitle,
      ).toBeNull();
      expect(
        useCloudConnectGateStore.getState().pending?.context.toastMessage,
      ).toBe(expectedToast);
      // The modal title is the same shared constant the sidebar pill and the
      // account-menu row render, and this is the only durable assertion that
      // pins it — the capture spec covering that surface is evidence, not
      // regression coverage. Compared against the import rather than a literal
      // so a copy change stays a one-file edit.
      expect(useCloudConnectGateStore.getState().pending?.context.title).toBe(
        GUEST_SIGN_IN_CTA_LABEL,
      );
      cleanup();
    },
  );

  // The component-level test for this lives in `CanopyPortalModal.guestCta`,
  // but it asserts against a mocked `startFreeTrial`, so it cannot see the hook.
  // Deleting the `options?.x ??` prefixes here therefore left that suite — and
  // every other one — green while silently restoring the defect the override
  // exists to prevent: a guest who opened the gate from Remote Control pairing
  // getting a dialog titled for a different offer. This is the assertion that
  // fails on that mutation.
  it('lets a caller reframe the gate it opens', async () => {
    installWindowApi({
      accounts: [guestAccount()],
      entitlements: [UNLINKED_ENTITLEMENTS],
    });
    const { cleanup } = await mount();
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="start-free-trial-override"]',
        )
        ?.click();
    });
    await flush();

    const context = useCloudConnectGateStore.getState().pending?.context;
    expect(context?.title).toBe('Override title');
    expect(context?.description).toBe('Override description');
    expect(context?.toastMessage).toBe('Override toast');
    cleanup();
  });

  it('still shows the initial skeleton until the first entitlements read settles', async () => {
    const pending = deferred<CanopyCloudEntitlementsState>();
    installWindowApi({
      accounts: [makeAccount()],
      entitlements: [pending.promise],
    });
    const { frames, cleanup } = await mount();

    expect(frames[frames.length - 1].loading).toBe(true);
    expect(frames[frames.length - 1].visible).toBe(false);

    pending.resolve(resolvedEntitlements('Business'));
    await flush();
    expect(frames[frames.length - 1]).toEqual({
      loading: false,
      visible: true,
      label: 'Business',
      guestCta: false,
    });
    cleanup();
  });

  it('settles the loading latch when the first entitlements read rejects', async () => {
    installWindowApi({
      accounts: [makeAccount()],
      entitlements: [Promise.reject(new Error('offline'))],
    });
    const { frames, cleanup } = await mount();

    // No hung placeholder: the latch settles even though there is no plan.
    expect(frames[frames.length - 1].loading).toBe(false);
    expect(frames[frames.length - 1].visible).toBe(false);
    cleanup();
  });

  it('clears the plan on sign-out', async () => {
    installWindowApi({
      accounts: [makeAccount(), signedOutAccount()],
      entitlements: [resolvedEntitlements('Business'), UNLINKED_ENTITLEMENTS],
    });
    const { frames, cleanup } = await mount();
    expect(frames[frames.length - 1].visible).toBe(true);

    dispatchAccountChanged();
    await flush();

    const last = frames[frames.length - 1];
    expect(last.visible).toBe(false);
    expect(last.guestCta).toBe(true);
    cleanup();
  });

  it('applies a downgrade delivered by a background refresh', async () => {
    installWindowApi({
      accounts: [makeAccount()],
      entitlements: [
        resolvedEntitlements('Business'),
        resolvedEntitlements('Free'),
      ],
    });
    const { frames, cleanup } = await mount();
    expect(frames[frames.length - 1].label).toBe('Business');

    frames.length = 0;
    dispatchAccountChanged();
    await flush();

    // Hold-last-known-good is failure-only; a resolved read always wins.
    expect(frames[frames.length - 1].label).toBe('Free');
    for (const frame of frames) expect(frame.loading).toBe(false);
    cleanup();
  });

  it('re-raises the skeleton on an identity change without flashing the old plan', async () => {
    const pending = deferred<CanopyCloudEntitlementsState>();
    installWindowApi({
      accounts: [guestAccount(), makeAccount()],
      entitlements: [resolvedEntitlements('Free'), pending.promise],
    });
    const { frames, cleanup } = await mount();
    // A guest sees the CTA, never a plan.
    expect(frames[frames.length - 1].guestCta).toBe(true);

    frames.length = 0;
    dispatchAccountChanged();
    await flush();

    // The guest's resolved "Free" must not be presented as the new user's plan.
    for (const frame of frames) expect(frame.label).not.toBe('Free');
    expect(frames[frames.length - 1].loading).toBe(true);

    pending.resolve(resolvedEntitlements('Business'));
    await flush();
    expect(frames[frames.length - 1].label).toBe('Business');
    cleanup();
  });

  it.each([
    [
      'rejects',
      (): Promise<CanopyCloudEntitlementsState> =>
        Promise.reject(new Error('offline')),
    ],
    [
      'is unresolved',
      (): Promise<CanopyCloudEntitlementsState> =>
        Promise.resolve(UNRESOLVED_ENTITLEMENTS),
    ],
  ])(
    'settles an identity-change latch when the entitlements read %s before the account read',
    async (_description, makeInconclusiveEntitlements) => {
      const pendingAccount = deferred<CanopyCloudAccountPublicState>();
      installWindowApi({
        accounts: [guestAccount(), pendingAccount.promise],
        entitlements: [
          resolvedEntitlements('Free'),
          makeInconclusiveEntitlements(),
        ],
      });
      const { frames, cleanup } = await mount();

      frames.length = 0;
      dispatchAccountChanged();
      await flush();
      pendingAccount.resolve(makeAccount());
      await flush();

      // The inconclusive entitlements read already settled for the new
      // identity. Its account read landing second must discard the guest's
      // held plan without reopening the latch forever.
      expect(frames[frames.length - 1]).toEqual({
        loading: false,
        visible: false,
        label: null,
        guestCta: false,
      });
      cleanup();
    },
  );

  it('lets the last issued refresh win when two overlap', async () => {
    const slowFirst = deferred<CanopyCloudEntitlementsState>();
    installWindowApi({
      accounts: [makeAccount()],
      entitlements: [
        slowFirst.promise,
        resolvedEntitlements('Business'),
        resolvedEntitlements('Business'),
      ],
    });
    const { frames, cleanup } = await mount();

    dispatchAccountChanged();
    await flush();
    expect(frames[frames.length - 1].label).toBe('Business');

    // The stale first read lands last and must be discarded by the seq token.
    slowFirst.resolve(resolvedEntitlements('Enterprise'));
    await flush();
    expect(frames[frames.length - 1].label).toBe('Business');
    cleanup();
  });

  describe('free app access', () => {
    const freeAccessEntitlements: CanopyCloudEntitlementsState = {
      ...UNLINKED_ENTITLEMENTS,
      canDisableSharing: true,
      canRemoteControl: true,
      freeAccess: true,
    };

    beforeEach(() => {
      recordFreeAccess = true;
    });

    afterEach(() => {
      recordFreeAccess = false;
    });

    it('hides the plan and its action and offers AI Credits to a signed-in user', async () => {
      installWindowApi({
        accounts: [makeAccount()],
        entitlements: [freeAccessEntitlements],
      });
      const { frames, cleanup } = await mount();

      expect(frames[frames.length - 1]).toEqual({
        loading: false,
        visible: false,
        label: null,
        guestCta: false,
        freeAccess: true,
        aiCredits: true,
        billingAction: null,
      });
      // No committed frame may name a plan: a free-access account has none.
      expect(frames.every((frame) => frame.label === null)).toBe(true);
      cleanup();
    });

    it('keeps the guest sign-in CTA and offers no AI Credits row to a guest', async () => {
      installWindowApi({
        accounts: [guestAccount()],
        entitlements: [freeAccessEntitlements],
      });
      const { frames, cleanup } = await mount();

      expect(frames[frames.length - 1]).toMatchObject({
        visible: false,
        guestCta: true,
        freeAccess: true,
        aiCredits: false,
      });
      cleanup();
    });

    it('offers no AI Credits row while the billing flag is off', async () => {
      // The web gates `/account/billing` on the same flag, so the row would
      // open a page that is not there.
      setBillingFlag(false);
      installWindowApi({
        accounts: [makeAccount()],
        entitlements: [freeAccessEntitlements],
      });
      const { frames, cleanup } = await mount();

      expect(frames[frames.length - 1]).toMatchObject({
        visible: false,
        freeAccess: true,
        aiCredits: false,
        billingAction: null,
      });
      cleanup();
    });

    it('treats a server that omits the field as tier behavior', async () => {
      installWindowApi({
        accounts: [makeAccount()],
        entitlements: [resolvedEntitlements('Pro')],
      });
      const { frames, cleanup } = await mount();

      expect(frames[frames.length - 1]).toMatchObject({
        visible: true,
        label: 'Pro',
        freeAccess: false,
        aiCredits: false,
        billingAction: 'Manage plan',
      });
      cleanup();
    });

    it('follows the server through on, off, and on again', async () => {
      installWindowApi({
        accounts: [makeAccount()],
        entitlements: [
          freeAccessEntitlements,
          resolvedEntitlements('Pro'),
          freeAccessEntitlements,
        ],
      });
      const { frames, cleanup } = await mount();
      expect(frames[frames.length - 1]).toMatchObject({
        freeAccess: true,
        visible: false,
      });

      // An authoritative response without free access restores the plan.
      dispatchAccountChanged();
      await flush();
      expect(frames[frames.length - 1]).toMatchObject({
        freeAccess: false,
        aiCredits: false,
        visible: true,
        label: 'Pro',
      });

      dispatchAccountChanged();
      await flush();
      expect(frames[frames.length - 1]).toMatchObject({
        freeAccess: true,
        aiCredits: true,
        visible: false,
        label: null,
      });
      cleanup();
    });

    it('holds free access through an inconclusive refresh', async () => {
      installWindowApi({
        accounts: [makeAccount()],
        entitlements: [freeAccessEntitlements, UNRESOLVED_ENTITLEMENTS],
      });
      const { frames, cleanup } = await mount();

      dispatchAccountChanged();
      await flush();
      expect(frames[frames.length - 1]).toMatchObject({
        freeAccess: true,
        aiCredits: true,
        visible: false,
      });
      cleanup();
    });
  });
});

describe('useSubscriptionStatus billing action follows the selected org context (CAN-3463)', () => {
  const ORG_ID = '22222222-2222-4222-8222-222222222222';
  let latestAction: { label: string; path: string } | null = null;

  function ActionHarness(): JSX.Element {
    const result = useSubscriptionStatus();
    latestAction = result.billingAction;
    return <span />;
  }

  async function mountAction(): Promise<() => void> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(<ActionHarness />);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    return (): void => {
      act(() => root.unmount());
      container.remove();
    };
  }

  function selectOrg(role: 'OWNER' | 'ADMIN' | 'MEMBER'): void {
    useWorkspaceContextStore.setState((store) => ({
      state: {
        ...store.state,
        context: { kind: 'organization', organizationId: ORG_ID },
        organizations: [{ id: ORG_ID, name: 'Acme', role }],
      },
    }));
  }

  beforeEach(() => {
    setBillingFlag(true);
    latestAction = null;
    installWindowApi({
      accounts: [makeAccount()],
      entitlements: [resolvedEntitlements('Business')],
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'api');
    useWorkspaceContextStore.setState((store) => ({
      state: {
        ...store.state,
        context: { kind: 'personal' },
        organizations: [],
      },
    }));
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
  });

  it('offers an OWNER "Manage plan" on the selected org', async () => {
    selectOrg('OWNER');
    const cleanup = await mountAction();
    expect(latestAction).toEqual({
      label: 'Manage plan',
      path: organizationBillingPath(ORG_ID),
    });
    cleanup();
  });

  it('offers an ADMIN "View organization billing" on the selected org', async () => {
    selectOrg('ADMIN');
    const cleanup = await mountAction();
    expect(latestAction).toEqual({
      label: 'View organization billing',
      path: organizationBillingPath(ORG_ID),
    });
    cleanup();
  });

  it('leaves a MEMBER on the server pick', async () => {
    selectOrg('MEMBER');
    const cleanup = await mountAction();
    expect(latestAction?.path).not.toBe(organizationBillingPath(ORG_ID));
    cleanup();
  });
});
