/**
 * @jest-environment jsdom
 */
import {
  MODEL_LIBRARY_ACCESS_VALUES,
  type ModelLibraryAccess,
} from '@canopy/protocol/models';
import type {
  AiCreditsScopeRequest,
  CanopyCloudEntitlementsState,
} from '@canopy/desktop-shared/types';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useWorkModelLibraryAccess } from '../../hooks/useModelLibraryAccess';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  ensureModelLibraryAccessSubscribed,
  refreshModelLibraryAccess,
  refreshWorkModelLibraryAccess,
  resetModelLibraryAccessForTests,
  resolveModelLibraryLock,
  useModelLibraryAccessStore,
} from '../modelLibraryAccess';

/**
 * CAN-4028 — the renderer's copy of personal model-library access. What these
 * cases protect: an answer is always bound to the account it describes, and
 * "the server did not say" never becomes a lock or an unlock by accident.
 */

const loadCanopyCloudEntitlements = jest.fn();
const loadCanopyCloudAccount = jest.fn();
const watchCanopyCloudModelLibrary = jest.fn();
const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

function serverSays(modelLibrary: unknown, accountKey: string | null): void {
  loadCanopyCloudEntitlements.mockResolvedValue({
    resolved: true,
    modelLibrary,
    modelLibraryAccountKey: accountKey,
  });
}

function account(id: string): unknown {
  return {
    hasApiKey: true,
    account: { id },
    authMode: 'oauth',
    credentialSource: 'oauth',
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  resetModelLibraryAccessForTests();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadCanopyCloudEntitlements,
      loadCanopyCloudAccount,
      watchCanopyCloudModelLibrary,
    },
  });
});

afterEach(() => {
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor);
  } else {
    Reflect.deleteProperty(window, 'api');
  }
});

describe('resolveModelLibraryLock', () => {
  it.each([...MODEL_LIBRARY_ACCESS_VALUES, undefined])(
    'keeps a guest locked when access is %s',
    (access) => {
      // The funded-guest rule: nothing the access value says widens a guest.
      expect(resolveModelLibraryLock(true, access)).toBe(
        access === 'needs_sign_in_then_purchase'
          ? 'needs_sign_in_then_purchase'
          : 'needs_sign_in',
      );
    },
  );

  it('locks a signed-in account only on an explicit needs_purchase', () => {
    expect(resolveModelLibraryLock(false, 'needs_purchase')).toBe(
      'needs_purchase',
    );
    expect(resolveModelLibraryLock(false, 'unlocked')).toBeUndefined();
    // Unknown, and guest-shaped values that have not caught up with a sign-in.
    expect(resolveModelLibraryLock(false, undefined)).toBeUndefined();
    expect(resolveModelLibraryLock(false, 'needs_sign_in')).toBeUndefined();
    expect(
      resolveModelLibraryLock(false, 'needs_sign_in_then_purchase'),
    ).toBeUndefined();
  });
});

describe('refreshModelLibraryAccess', () => {
  it('refreshes authoritative scoped access after invalidation and stops watching on unmount', async () => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    let changed: ((credentialsChanged?: boolean) => void) | undefined;
    const stop = jest.fn();
    watchCanopyCloudModelLibrary.mockImplementation(
      (
        _scope: AiCreditsScopeRequest | undefined,
        callback: () => void,
      ): (() => void) => {
        changed = callback;
        return stop;
      },
    );
    const scope = { kind: 'work', projectId: 'project-a' } as const;
    const response = (
      access: ModelLibraryAccess,
    ): Pick<
      CanopyCloudEntitlementsState,
      | 'modelLibraryAccountKey'
      | 'modelLibraryOwnerKey'
      | 'modelLibrary'
      | 'workModelLibrary'
    > => ({
      modelLibraryAccountKey: 'account:a',
      modelLibraryOwnerKey: 'org:org-1',
      modelLibrary: { status: 'reported', access: 'unlocked' },
      workModelLibrary: { status: 'reported', access },
    });
    loadCanopyCloudEntitlements.mockResolvedValue(response('unlocked'));
    let access: string | undefined;
    function Probe(): null {
      access = useWorkModelLibraryAccess(scope);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => {
        root.render(createElement(Probe));
        await settle();
      });
      await act(settle);
      expect(watchCanopyCloudModelLibrary).toHaveBeenCalledWith(
        scope,
        expect.any(Function),
      );
      loadCanopyCloudEntitlements.mockResolvedValue(response('needs_purchase'));
      await act(async () => {
        changed?.();
        await settle();
      });
      expect(access).toBe('needs_purchase');
      const watches = watchCanopyCloudModelLibrary.mock.calls.length;
      loadCanopyCloudAccount.mockResolvedValue(account('a'));
      await act(async () => {
        changed?.(true);
        await settle();
      });
      expect(watchCanopyCloudModelLibrary.mock.calls.length).toBeGreaterThan(
        watches,
      );
    } finally {
      await act(async () => {
        root.unmount();
        await settle();
      });
    }
    expect(stop).toHaveBeenCalled();
  });
  it('never uses personal access for an organization-scoped refresh', async () => {
    loadCanopyCloudEntitlements.mockResolvedValue({
      modelLibraryAccountKey: 'account:a',
      modelLibraryOwnerKey: 'org:org-1',
      modelLibrary: { status: 'reported', access: 'unlocked' },
      workModelLibrary: { status: 'reported', access: 'needs_purchase' },
    });
    const scope = { kind: 'work', projectId: 'project-a' } as const;
    await expect(refreshWorkModelLibraryAccess(scope)).resolves.toMatchObject({
      access: 'needs_purchase',
      ownerKey: 'org:org-1',
      authoritative: true,
    });
    expect(loadCanopyCloudEntitlements).toHaveBeenCalledWith(scope);
  });
  it('publishes an authoritative answer with its account', async () => {
    serverSays({ status: 'reported', access: 'needs_purchase' }, 'account:a');
    await expect(refreshModelLibraryAccess()).resolves.toEqual({
      accountKey: 'account:a',
      access: 'needs_purchase',
      authoritative: true,
    });
    expect(useModelLibraryAccessStore.getState()).toMatchObject({
      accountKey: 'account:a',
      access: 'needs_purchase',
    });
  });

  it('publishes a retained answer as usable but not authoritative', async () => {
    serverSays({ status: 'retained', access: 'unlocked' }, 'account:a');
    await expect(refreshModelLibraryAccess()).resolves.toEqual({
      accountKey: 'account:a',
      access: 'unlocked',
      authoritative: false,
    });
  });

  it('clears to unknown when an older server does not report the field', async () => {
    serverSays({ status: 'reported', access: 'needs_purchase' }, 'account:a');
    await refreshModelLibraryAccess();
    serverSays({ status: 'not-reported' }, 'account:a');
    await refreshModelLibraryAccess();
    expect(useModelLibraryAccessStore.getState().access).toBeUndefined();
  });

  it('keeps the same account’s value through an unknown read', async () => {
    serverSays({ status: 'reported', access: 'needs_purchase' }, 'account:a');
    await refreshModelLibraryAccess();
    serverSays({ status: 'unknown' }, 'account:a');
    await expect(refreshModelLibraryAccess()).resolves.toMatchObject({
      access: 'needs_purchase',
      authoritative: false,
    });
  });

  it('never carries one account’s value to another on an unknown read', async () => {
    serverSays({ status: 'reported', access: 'unlocked' }, 'account:a');
    await refreshModelLibraryAccess();
    serverSays({ status: 'unknown' }, 'account:b');
    await expect(refreshModelLibraryAccess()).resolves.toEqual({
      accountKey: 'account:b',
      access: undefined,
      authoritative: false,
    });
    expect(useModelLibraryAccessStore.getState()).toMatchObject({
      accountKey: 'account:b',
      access: undefined,
    });
  });

  it('resolves null, and changes nothing, on a failed read', async () => {
    serverSays({ status: 'reported', access: 'needs_purchase' }, 'account:a');
    await refreshModelLibraryAccess();
    loadCanopyCloudEntitlements.mockRejectedValue(new Error('offline'));
    await expect(refreshModelLibraryAccess()).resolves.toBeNull();
    expect(useModelLibraryAccessStore.getState().access).toBe('needs_purchase');
  });

  it('resolves null for a main process that predates the field', async () => {
    loadCanopyCloudEntitlements.mockResolvedValue({ resolved: true });
    await expect(refreshModelLibraryAccess()).resolves.toBeNull();
    expect(useModelLibraryAccessStore.getState().access).toBeUndefined();
  });

  it('shares one read between concurrent callers', async () => {
    serverSays({ status: 'reported', access: 'unlocked' }, 'account:a');
    await Promise.all([
      refreshModelLibraryAccess(),
      refreshModelLibraryAccess(),
      refreshModelLibraryAccess(),
    ]);
    expect(loadCanopyCloudEntitlements).toHaveBeenCalledTimes(1);
  });
});

describe('account changes', () => {
  it('drops the previous account’s value before the next read lands, and discards the stale one', async () => {
    loadCanopyCloudAccount.mockResolvedValue(account('a'));
    serverSays({ status: 'reported', access: 'unlocked' }, 'account:a');
    ensureModelLibraryAccessSubscribed();
    await refreshModelLibraryAccess();
    expect(useModelLibraryAccessStore.getState().access).toBe('unlocked');

    // A read for account A is still on the wire when account B signs in.
    let releaseStale: (value: unknown) => void = () => {};
    loadCanopyCloudEntitlements.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseStale = resolve;
        }),
    );
    const stale = refreshModelLibraryAccess();

    loadCanopyCloudAccount.mockResolvedValue(account('b'));
    let releaseFresh: (value: unknown) => void = () => {};
    loadCanopyCloudEntitlements.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFresh = resolve;
        }),
    );
    window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    await settle();

    // A's `unlocked` is gone before B's answer exists.
    expect(useModelLibraryAccessStore.getState()).toMatchObject({
      accountKey: 'account:b',
      access: undefined,
    });

    // A's late answer is discarded rather than written over B.
    releaseStale({
      resolved: true,
      modelLibrary: { status: 'reported', access: 'unlocked' },
      modelLibraryAccountKey: 'account:a',
    });
    await expect(stale).resolves.toBeNull();
    expect(useModelLibraryAccessStore.getState().access).toBeUndefined();

    releaseFresh({
      resolved: true,
      modelLibrary: { status: 'reported', access: 'needs_purchase' },
      modelLibraryAccountKey: 'account:b',
    });
    await settle();
    expect(useModelLibraryAccessStore.getState()).toMatchObject({
      accountKey: 'account:b',
      access: 'needs_purchase',
    });
  });

  it('keeps the value when the event fires for the same account', async () => {
    // The event also fires for a balance change, which is not a new account.
    loadCanopyCloudAccount.mockResolvedValue(account('a'));
    serverSays({ status: 'reported', access: 'needs_purchase' }, 'account:a');
    ensureModelLibraryAccessSubscribed();
    await refreshModelLibraryAccess();

    const seen: (string | undefined)[] = [];
    const unsubscribe = useModelLibraryAccessStore.subscribe((state) => {
      seen.push(state.access);
    });
    window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    await settle();
    unsubscribe();

    // Never flickered through unknown, so no row lost and regained its lock.
    expect(seen).toEqual([]);
    expect(useModelLibraryAccessStore.getState().access).toBe('needs_purchase');
  });
});
