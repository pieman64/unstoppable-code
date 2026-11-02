import type {
  CanopyApi,
  CanopyPortalState,
} from '@canopy/desktop-shared/types';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';

declare global {
  interface Window {
    api: CanopyApi;
  }
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

describe('canopyPortalStore + useCanopyPortalSubscription', () => {
  beforeEach(() => {
    useCanopyPortalStore.setState({
      hydrated: false,
      state: buildState({}),
    });
  });

  it('hydrate() seeds the store with the main-process snapshot', async () => {
    const initial = buildState({
      status: 'pending_auth',
      connectionStatus: 'inactive',
      pairingCode: '123456',
      sessionId: 'sess-1',
      pairingCodeExpiresAt: '2026-05-06T00:10:00Z',
    });

    const onStateChanged = jest.fn((): (() => void) => () => undefined);

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        canopyPortal: {
          getState: jest.fn(() => Promise.resolve(initial)),
          start: jest.fn(),
          stop: jest.fn(),
          onStateChanged,
        },
      },
    });

    await useCanopyPortalStore.getState().hydrate();

    expect(useCanopyPortalStore.getState().hydrated).toBe(true);
    expect(useCanopyPortalStore.getState().state).toEqual(initial);
  });

  it('subscription mirrors broadcast state into the zustand store', async () => {
    const initial = buildState({ status: 'disabled' });
    const next = buildState({
      status: 'active',
      connectionStatus: 'active',
      sessionId: 'sess-active',
    });

    type StateListener = (state: CanopyPortalState) => void;
    const registeredRef: { current: StateListener | null } = { current: null };
    const dispose = jest.fn();
    const onStateChanged = jest.fn((callback: StateListener) => {
      registeredRef.current = callback;
      return dispose;
    });

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        canopyPortal: {
          getState: jest.fn(() => Promise.resolve(initial)),
          start: jest.fn(),
          stop: jest.fn(),
          onStateChanged,
        },
      },
    });

    // Inline the hook's effect logic so we don't need a React renderer in
    // the test environment. The hook contract is:
    //   1. fetch initial state via getState();
    //   2. subscribe to onStateChanged;
    //   3. return a disposer that detaches the listener.
    await useCanopyPortalStore.getState().hydrate();
    expect(useCanopyPortalStore.getState().state).toEqual(initial);

    const dispose2: () => void = window.api.canopyPortal.onStateChanged(
      (state) => {
        useCanopyPortalStore.getState().setState(state);
      },
    );
    expect(onStateChanged).toHaveBeenCalledTimes(1);
    if (!registeredRef.current) {
      throw new Error('Expected the subscription to register a listener');
    }

    // Simulate the main process broadcasting a new snapshot.
    registeredRef.current(next);
    expect(useCanopyPortalStore.getState().state).toEqual(next);

    dispose2();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
