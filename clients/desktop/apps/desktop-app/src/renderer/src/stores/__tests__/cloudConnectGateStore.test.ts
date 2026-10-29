import type {
  CanopyApi,
  CanopyCloudAccountPublicState,
} from '@canopy/desktop-shared/types';
import {
  isConnectedNonGuest,
  useCloudConnectGateStore,
} from '@/stores/cloudConnectGateStore';

declare global {
  interface Window {
    api: CanopyApi;
  }
}

function account(
  overrides: Partial<CanopyCloudAccountPublicState>,
): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: null,
    credentialSource: null,
    capabilities: [],
    storageAvailable: true,
    account: {
      id: 'acct-1',
      name: 'Alice',
      email: 'alice@example.com',
      role: 'ADMIN',
    },
    ...overrides,
  };
}

function setApi(
  loadCanopyCloudAccount: () => Promise<CanopyCloudAccountPublicState | null>,
): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: { loadCanopyCloudAccount } },
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('isConnectedNonGuest', () => {
  it('is true for a real connected account', () => {
    expect(
      isConnectedNonGuest(account({ credentialSource: 'oauth_desktop' })),
    ).toBe(true);
  });

  it('is false for a guest credential even when it looks connected', () => {
    expect(isConnectedNonGuest(account({ credentialSource: 'guest' }))).toBe(
      false,
    );
  });

  it('is false when there is no account', () => {
    expect(isConnectedNonGuest(null)).toBe(false);
    expect(
      isConnectedNonGuest(account({ hasApiKey: false, account: undefined })),
    ).toBe(false);
  });
});

describe('useCloudConnectGateStore.requestConnect', () => {
  beforeEach(() => {
    useCloudConnectGateStore.setState({ pending: null });
  });

  it('runs proceed immediately without a modal for a real account', async () => {
    setApi(() =>
      Promise.resolve(account({ credentialSource: 'oauth_desktop' })),
    );
    const proceed = jest.fn();
    useCloudConnectGateStore.getState().requestConnect({}, proceed);
    await flush();
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(useCloudConnectGateStore.getState().pending).toBeNull();
  });

  it('opens the modal (pending set) for a guest and does not proceed yet', async () => {
    setApi(() => Promise.resolve(account({ credentialSource: 'guest' })));
    const proceed = jest.fn();
    useCloudConnectGateStore
      .getState()
      .requestConnect({ toastMessage: "You're all set." }, proceed);
    await flush();
    expect(proceed).not.toHaveBeenCalled();
    expect(
      useCloudConnectGateStore.getState().pending?.context.toastMessage,
    ).toBe("You're all set.");
    expect(
      useCloudConnectGateStore.getState().pending?.context.guestBenefits,
    ).toBe(true);
  });

  it('clears stale guest copy when the authoritative account is not a guest', async () => {
    setApi(() =>
      Promise.resolve(
        account({
          hasApiKey: false,
          account: undefined,
          credentialSource: null,
        }),
      ),
    );
    const proceed = jest.fn();
    useCloudConnectGateStore
      .getState()
      .requestConnect({ guestBenefits: true }, proceed);

    await flush();

    expect(proceed).not.toHaveBeenCalled();
    expect(
      useCloudConnectGateStore.getState().pending?.context.guestBenefits,
    ).toBe(false);
  });

  it('opens the modal when the account load fails', async () => {
    setApi(() => Promise.reject(new Error('offline')));
    const proceed = jest.fn();
    useCloudConnectGateStore
      .getState()
      .requestConnect({ guestBenefits: true }, proceed);
    await flush();
    expect(proceed).not.toHaveBeenCalled();
    expect(
      useCloudConnectGateStore.getState().pending?.context.guestBenefits,
    ).toBe(false);
  });
});
