import {
  MODEL_LIBRARY_ACCESS_VALUES,
  type Entitlements,
} from '@canopy/protocol';

const requestCanopyCloudJsonMock = jest.fn();
// Minimal stand-in matching the real `CanopyCloudClientError` shape the probe
// branches on (`.status`). Defined inline so the module's `instanceof` check
// resolves against the same class the test throws.
class MockCanopyCloudClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(status === undefined ? message : `HTTP ${status}: ${message}`);
    this.name = 'CanopyCloudClientError';
  }
}
jest.mock('../canopy-cloud/client', () => ({
  requestCanopyCloudJson: (...args: unknown[]): unknown =>
    requestCanopyCloudJsonMock(...args),
  CanopyCloudClientError: MockCanopyCloudClientError,
}));

// Per-org billing state (CAN-2311) is read off the persisted account snapshot,
// not the network, so the store is the seam these tests drive.
const loadCanopyCloudAccountMock = jest.fn();
const getCanopyCloudCredentialsMock = jest.fn();
const accountListeners: (() => void)[] = [];
const subscribeCanopyCloudAccountChangesMock = jest.fn(
  (listener: () => void): (() => void) => {
    accountListeners.push(listener);
    return jest.fn();
  },
);
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): unknown => loadCanopyCloudAccountMock(),
  getCanopyCloudCredentials: (): unknown => getCanopyCloudCredentialsMock(),
  subscribeCanopyCloudAccountChanges: (listener: () => void): (() => void) =>
    subscribeCanopyCloudAccountChangesMock(listener),
}));

import { probeEntitlementsSummary } from '../canopy-cloud/entitlements';
import {
  probeEntitlementsWithModelLibrary,
  readRetainedModelLibraryAccess,
  resetModelLibraryAccessForTests,
  subscribeModelLibraryAccess,
} from '../canopy-cloud/model-library-access';
import {
  isOrganizationTeamsLapsed,
  loadStoredOrgBillingStates,
  resolveLapsedOrganizationNames,
} from '../lib/org-billing-state';

describe('owner-scoped access invalidation', () => {
  it('shares one stream per credential and owner, and treats the signal only as invalidation', async () => {
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.test',
      apiKey: 'csk-test',
    });
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = jest.fn((_url, init): Promise<Response> => {
      if (init?.signal) signals.push(init.signal);
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controllers.push(controller);
            },
          }),
        ),
      );
    });
    const first = jest.fn();
    const second = jest.fn();
    const other = jest.fn();
    const stops: (() => void)[] = [];
    try {
      stops.push(
        await subscribeModelLibraryAccess(
          { kind: 'personal' },
          first,
          fetchImpl,
        ),
      );
      stops.push(
        await subscribeModelLibraryAccess(
          { kind: 'personal' },
          second,
          fetchImpl,
        ),
      );
      stops.push(
        await subscribeModelLibraryAccess(
          { kind: 'organization', organizationId: 'org-1' },
          other,
          fetchImpl,
        ),
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      controllers[0]?.enqueue(
        new TextEncoder().encode(
          'event: credit.pool\nid: 12\ndata: {"payload":{"modelLibraryAccessChanged":true}}\n\n',
        ),
      );
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      expect(other).not.toHaveBeenCalled();
      expect(readRetainedModelLibraryAccess('account:a')).toBeUndefined();
      stops[0]?.();
      expect(signals[0]?.aborted).toBe(false);
      stops[1]?.();
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
      accountListeners[1]?.();
      expect(signals[1]?.aborted).toBe(true);
      expect(other).toHaveBeenLastCalledWith(true);
    } finally {
      stops.forEach((stop) => stop());
      for (let i = 0; i < 12; i++) await Promise.resolve();
    }
  });
});

function entitlements(
  capabilities: Entitlements['capabilities'],
  overrides?: Partial<Entitlements>,
): Entitlements {
  return {
    plan: null,
    source: capabilities.length > 0 ? 'subscription' : 'none',
    trial: null,
    capabilities,
    coveringOrgs: [],
    billingManageableOrg: null,
    displayPlan: null,
    ...overrides,
  };
}

describe('probeEntitlementsSummary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requests and validates access for the selected work owner separately', async () => {
    const owner = { kind: 'organization', organizationId: 'org-7' } as const;
    requestCanopyCloudJsonMock.mockResolvedValue(
      entitlements([], {
        modelLibrary: 'unlocked',
        workModelLibrary: { owner, access: 'needs_purchase' },
      }),
    );
    const result = await probeEntitlementsSummary(owner);
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledWith(
      '/api/v1/entitlements',
      {
        headers: { 'x-canopy-work-owner': 'org:org-7' },
      },
    );
    expect(result).toMatchObject({
      modelLibrary: { status: 'reported', access: 'unlocked' },
      workModelLibrary: { status: 'reported', access: 'needs_purchase' },
    });
  });

  it('does not accept access reported for another organization', async () => {
    requestCanopyCloudJsonMock.mockResolvedValue(
      entitlements([], {
        workModelLibrary: {
          owner: { kind: 'organization', organizationId: 'org-8' },
          access: 'unlocked',
        },
      }),
    );
    await expect(
      probeEntitlementsSummary({
        kind: 'organization',
        organizationId: 'org-7',
      }),
    ).resolves.toMatchObject({ workModelLibrary: { status: 'invalid' } });
  });

  it('retains work access only for the same account and organization', async () => {
    resetModelLibraryAccessForTests();
    loadCanopyCloudAccountMock.mockResolvedValue({
      account: { id: 'account-1' },
    });
    const first = { kind: 'organization', organizationId: 'org-7' } as const;
    const second = { kind: 'organization', organizationId: 'org-8' } as const;
    requestCanopyCloudJsonMock.mockResolvedValue(
      entitlements([], {
        workModelLibrary: { owner: first, access: 'unlocked' },
      }),
    );
    await expect(
      probeEntitlementsWithModelLibrary(first),
    ).resolves.toMatchObject({
      workModelLibrary: { status: 'reported', access: 'unlocked' },
      ownerKey: 'org:org-7',
    });
    requestCanopyCloudJsonMock.mockRejectedValue(new Error('offline'));
    await expect(
      probeEntitlementsWithModelLibrary(first),
    ).resolves.toMatchObject({
      workModelLibrary: { status: 'retained', access: 'unlocked' },
    });
    await expect(
      probeEntitlementsWithModelLibrary(second),
    ).resolves.toMatchObject({
      workModelLibrary: { status: 'unknown' },
    });
    loadCanopyCloudAccountMock.mockResolvedValue({
      account: { id: 'account-2' },
    });
    await expect(
      probeEntitlementsWithModelLibrary(first),
    ).resolves.toMatchObject({
      workModelLibrary: { status: 'unknown' },
    });
  });

  it('projects plan / trial / manageable org / displayPlan alongside canDisableSharing', async () => {
    requestCanopyCloudJsonMock.mockResolvedValue(
      entitlements(['data_sync_control'], {
        source: 'subscription',
        plan: { key: 'individual', displayName: 'Pro' },
        trial: null,
        billingManageableOrg: { id: 'org-1', name: 'Acme' },
        // Personal Pro is the wallet-primary, but the pricier org Business plan
        // is the display plan — it must pass through untouched.
        displayPlan: {
          key: 'business',
          displayName: 'Business',
          source: 'org_seat',
        },
        billingPresentation: {
          plan: { key: 'individual', displayName: 'Pro' },
          owner: { type: 'user' },
          lifecycle: 'paid',
          trialEndsAt: null,
          action: 'manage',
        },
      }),
    );
    await expect(probeEntitlementsSummary()).resolves.toEqual({
      resolved: true,
      canDisableSharing: true,
      canRemoteControl: false,
      source: 'subscription',
      plan: { key: 'individual', displayName: 'Pro' },
      trial: null,
      billingManageableOrg: { id: 'org-1', name: 'Acme' },
      billingPresentation: {
        plan: { key: 'individual', displayName: 'Pro' },
        owner: { type: 'user' },
        lifecycle: 'paid',
        trialEndsAt: null,
        action: 'manage',
      },
      displayPlan: {
        key: 'business',
        displayName: 'Business',
        source: 'org_seat',
      },
      freeAccess: false,
      modelLibrary: { status: 'not-reported' },
    });
  });

  it('projects free access only when the server reports it', async () => {
    requestCanopyCloudJsonMock.mockResolvedValue(
      entitlements(['remote_control'], { freeAccess: true }),
    );
    await expect(probeEntitlementsSummary()).resolves.toMatchObject({
      resolved: true,
      freeAccess: true,
    });

    // Older servers omit the field; that is tier behavior, not free access.
    requestCanopyCloudJsonMock.mockResolvedValue(entitlements([]));
    await expect(probeEntitlementsSummary()).resolves.toMatchObject({
      resolved: true,
      freeAccess: false,
      modelLibrary: { status: 'not-reported' },
    });
  });

  it('normalizes a malformed billing presentation to null', async () => {
    requestCanopyCloudJsonMock.mockResolvedValue(
      entitlements([], {
        billingPresentation: {
          plan: { key: 'business', displayName: 'Business' },
          owner: { type: 'organization', id: '', name: 'Acme' },
          lifecycle: 'trial',
          trialEndsAt: null,
          action: 'subscribe',
        },
      }),
    );
    const result = await probeEntitlementsSummary();
    expect(result).toMatchObject({ resolved: true });
    if (result.resolved) {
      expect(result.billingPresentation).toBeNull();
    }
  });

  it('projects canRemoteControl=true when remote_control is granted', async () => {
    requestCanopyCloudJsonMock.mockResolvedValue(
      entitlements(['remote_control'], {
        source: 'subscription',
        plan: { key: 'individual', displayName: 'Pro' },
      }),
    );
    const result = await probeEntitlementsSummary();
    expect(result).toMatchObject({
      resolved: true,
      canDisableSharing: false,
      canRemoteControl: true,
    });
  });

  it('defaults billingManageableOrg / displayPlan to null when the server omits them', async () => {
    const raw = entitlements([]);
    // Simulate an older server payload without the append-only fields.
    delete (raw as Partial<Entitlements>).billingManageableOrg;
    delete (raw as Partial<Entitlements>).displayPlan;
    requestCanopyCloudJsonMock.mockResolvedValue(raw);
    const result = await probeEntitlementsSummary();
    expect(result).toEqual({
      resolved: true,
      canDisableSharing: false,
      canRemoteControl: false,
      source: 'none',
      plan: null,
      trial: null,
      billingManageableOrg: null,
      billingPresentation: null,
      displayPlan: null,
      freeAccess: false,
      modelLibrary: { status: 'not-reported' },
    });
  });

  it('treats a 404 as a resolved no-grant state', async () => {
    requestCanopyCloudJsonMock.mockRejectedValue(
      new MockCanopyCloudClientError('http-error', 'not found', 404),
    );
    await expect(probeEntitlementsSummary()).resolves.toEqual({
      resolved: true,
      canDisableSharing: false,
      canRemoteControl: false,
      source: 'none',
      plan: null,
      trial: null,
      billingManageableOrg: null,
      billingPresentation: null,
      displayPlan: null,
      freeAccess: false,
      modelLibrary: { status: 'not-reported' },
    });
  });

  it('returns unresolved on a transient failure', async () => {
    requestCanopyCloudJsonMock.mockRejectedValue(
      new MockCanopyCloudClientError('http-error', 'server error', 503),
    );
    await expect(probeEntitlementsSummary()).resolves.toEqual({
      resolved: false,
    });
  });
});

/**
 * CAN-4028 — personal model-library access rides on the entitlements response.
 * "The server did not say" and "the server said something unreadable" are
 * different answers with different consequences, so each is pinned.
 */
describe('probeEntitlementsSummary — model library access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(MODEL_LIBRARY_ACCESS_VALUES)('reports a valid %s', async (access) => {
    requestCanopyCloudJsonMock.mockResolvedValue(
      entitlements([], { modelLibrary: access }),
    );
    await expect(probeEntitlementsSummary()).resolves.toMatchObject({
      resolved: true,
      modelLibrary: { status: 'reported', access },
    });
  });

  it('reports a missing field as not-reported, not as invalid', async () => {
    // An older server. Callers fall back to the guest rules it enforces.
    requestCanopyCloudJsonMock.mockResolvedValue(entitlements([]));
    await expect(probeEntitlementsSummary()).resolves.toMatchObject({
      resolved: true,
      modelLibrary: { status: 'not-reported' },
    });
  });

  it.each([['a_future_value'], [null], [true], [{ access: 'unlocked' }]])(
    'reports an unreadable %p as invalid, never as unlocked or missing',
    async (value) => {
      requestCanopyCloudJsonMock.mockResolvedValue({
        ...entitlements([]),
        modelLibrary: value,
      });
      await expect(probeEntitlementsSummary()).resolves.toMatchObject({
        resolved: true,
        modelLibrary: { status: 'invalid' },
      });
    },
  );
});

describe('probeEntitlementsWithModelLibrary', () => {
  const account = (
    id: string,
    guest = false,
  ): { apiKey: string; account: { id: string }; authMode?: 'guest' } => ({
    apiKey: 'csk_test',
    account: { id },
    ...(guest ? { authMode: 'guest' } : {}),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resetModelLibraryAccessForTests();
    loadCanopyCloudAccountMock.mockResolvedValue(account('user-a'));
  });

  it('reports the server answer for the saved account', async () => {
    requestCanopyCloudJsonMock.mockResolvedValue(
      entitlements([], { modelLibrary: 'needs_purchase' }),
    );
    await expect(probeEntitlementsWithModelLibrary()).resolves.toMatchObject({
      modelLibrary: { status: 'reported', access: 'needs_purchase' },
      accountKey: 'account:user-a',
    });
  });

  it('retains the last valid answer for the same account through a transient failure', async () => {
    requestCanopyCloudJsonMock.mockResolvedValueOnce(
      entitlements([], { modelLibrary: 'needs_purchase' }),
    );
    await probeEntitlementsWithModelLibrary();

    requestCanopyCloudJsonMock.mockRejectedValueOnce(new Error('offline'));
    // `retained`, not `reported`: good enough to keep rendering, never proof
    // that anything changed.
    await expect(probeEntitlementsWithModelLibrary()).resolves.toMatchObject({
      probe: { resolved: false },
      modelLibrary: { status: 'retained', access: 'needs_purchase' },
    });
  });

  it('retains the last valid answer through an unreadable field', async () => {
    requestCanopyCloudJsonMock.mockResolvedValueOnce(
      entitlements([], { modelLibrary: 'unlocked' }),
    );
    await probeEntitlementsWithModelLibrary();

    requestCanopyCloudJsonMock.mockResolvedValueOnce({
      ...entitlements([]),
      modelLibrary: 'a_future_value',
    });
    await expect(probeEntitlementsWithModelLibrary()).resolves.toMatchObject({
      modelLibrary: { status: 'retained', access: 'unlocked' },
    });
  });

  it('is unknown on a failure with nothing retained', async () => {
    requestCanopyCloudJsonMock.mockRejectedValue(new Error('offline'));
    await expect(probeEntitlementsWithModelLibrary()).resolves.toMatchObject({
      modelLibrary: { status: 'unknown' },
    });
  });

  it('clears the retained answer when an older server stops reporting', async () => {
    requestCanopyCloudJsonMock.mockResolvedValueOnce(
      entitlements([], { modelLibrary: 'needs_purchase' }),
    );
    await probeEntitlementsWithModelLibrary();

    requestCanopyCloudJsonMock.mockResolvedValueOnce(entitlements([]));
    await expect(probeEntitlementsWithModelLibrary()).resolves.toMatchObject({
      modelLibrary: { status: 'not-reported' },
    });
    // A later blip must not resurrect the lock the server withdrew.
    requestCanopyCloudJsonMock.mockRejectedValueOnce(new Error('offline'));
    await expect(probeEntitlementsWithModelLibrary()).resolves.toMatchObject({
      modelLibrary: { status: 'unknown' },
    });
  });

  it('never reuses one account’s answer for another', async () => {
    requestCanopyCloudJsonMock.mockResolvedValueOnce(
      entitlements([], { modelLibrary: 'unlocked' }),
    );
    await probeEntitlementsWithModelLibrary();

    // A different account signs in, and its first read fails.
    loadCanopyCloudAccountMock.mockResolvedValue(account('user-b'));
    requestCanopyCloudJsonMock.mockRejectedValueOnce(new Error('offline'));
    await expect(probeEntitlementsWithModelLibrary()).resolves.toMatchObject({
      modelLibrary: { status: 'unknown' },
      accountKey: 'account:user-b',
    });
    expect(readRetainedModelLibraryAccess('account:user-a')).toBeUndefined();
    expect(readRetainedModelLibraryAccess('account:user-b')).toBeUndefined();
  });

  it('does not carry a guest’s answer across sign-in on the same user id', async () => {
    loadCanopyCloudAccountMock.mockResolvedValue(account('user-a', true));
    requestCanopyCloudJsonMock.mockResolvedValueOnce(
      entitlements([], { modelLibrary: 'needs_sign_in_then_purchase' }),
    );
    await expect(probeEntitlementsWithModelLibrary()).resolves.toMatchObject({
      accountKey: 'guest:user-a',
    });

    loadCanopyCloudAccountMock.mockResolvedValue(account('user-a'));
    requestCanopyCloudJsonMock.mockRejectedValueOnce(new Error('offline'));
    await expect(probeEntitlementsWithModelLibrary()).resolves.toMatchObject({
      modelLibrary: { status: 'unknown' },
      accountKey: 'account:user-a',
    });
  });

  it('discards a response that straddles an account switch', async () => {
    // Saved account at request start is A; by the time the response lands the
    // saved account is B. The response describes A and must not be reported
    // or retained for B.
    loadCanopyCloudAccountMock
      .mockResolvedValueOnce(account('user-a'))
      .mockResolvedValue(account('user-b'));
    requestCanopyCloudJsonMock.mockResolvedValueOnce(
      entitlements([], { modelLibrary: 'unlocked' }),
    );
    await expect(probeEntitlementsWithModelLibrary()).resolves.toMatchObject({
      modelLibrary: { status: 'unknown' },
      accountKey: 'account:user-b',
    });
    expect(readRetainedModelLibraryAccess('account:user-b')).toBeUndefined();
  });

  it('is unknown with no saved credential', async () => {
    loadCanopyCloudAccountMock.mockResolvedValue(null);
    requestCanopyCloudJsonMock.mockResolvedValue(
      entitlements([], { modelLibrary: 'unlocked' }),
    );
    await expect(probeEntitlementsWithModelLibrary()).resolves.toMatchObject({
      modelLibrary: { status: 'unknown' },
      accountKey: null,
    });
  });
});

describe('per-org billing state (CAN-2311)', () => {
  const MIXED_STATES = [
    {
      organizationId: 'org-lapsed',
      organizationName: 'Lapsed Co',
      teamsEntitled: false,
      trialEndedAt: '2026-02-02T00:00:00.000Z',
    },
    {
      organizationId: 'org-healthy',
      organizationName: 'Healthy Co',
      teamsEntitled: true,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    loadCanopyCloudAccountMock.mockResolvedValue({
      apiKey: 'csk_test',
      capabilities: [],
      orgBillingStates: MIXED_STATES,
    });
  });

  it('reports only the lapsed org as lapsed, leaving the healthy one usable', async () => {
    await expect(isOrganizationTeamsLapsed('org-lapsed')).resolves.toBe(true);
    await expect(isOrganizationTeamsLapsed('org-healthy')).resolves.toBe(false);
  });

  it('names the lapsed org for blocked copy', async () => {
    await expect(
      resolveLapsedOrganizationNames(['org-healthy', 'org-lapsed']),
    ).resolves.toEqual(['Lapsed Co']);
  });

  it('fails open when signed out, when the key is absent, and on a store failure', async () => {
    loadCanopyCloudAccountMock.mockResolvedValue(null);
    await expect(isOrganizationTeamsLapsed('org-lapsed')).resolves.toBe(false);

    loadCanopyCloudAccountMock.mockResolvedValue({
      apiKey: 'csk_test',
      capabilities: [],
    });
    await expect(isOrganizationTeamsLapsed('org-lapsed')).resolves.toBe(false);

    loadCanopyCloudAccountMock.mockRejectedValue(new Error('decrypt failed'));
    await expect(isOrganizationTeamsLapsed('org-lapsed')).resolves.toBe(false);
    await expect(loadStoredOrgBillingStates()).resolves.toEqual([]);
  });

  it('fails open for an org the snapshot has never heard of', async () => {
    await expect(isOrganizationTeamsLapsed('org-unknown')).resolves.toBe(false);
  });
});
