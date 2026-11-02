import type {
  RemoteControlApi,
  RemoteControlContext,
  RemoteControlState,
  RemoteDirectoryListing,
  RemotePathPickerRequest,
} from '@canopy/desktop-shared/types';
import {
  defaultRemoteControlState,
  useRemoteControlStore,
} from '@/stores/remoteControlStore';

export function makeRemoteState(
  overrides: Partial<RemoteControlState> = {},
): RemoteControlState {
  return {
    ...defaultRemoteControlState(),
    available: true,
    signedIn: true,
    relayStatus: 'connected',
    thisDevice: {
      deviceId: 'dev-local',
      name: 'Work laptop',
      platform: 'darwin',
    },
    ...overrides,
  };
}

export interface FakeRemoteControl {
  readonly api: RemoteControlApi;
  readonly mocks: {
    readonly getState: jest.Mock<
      Promise<RemoteControlState>,
      [{ discover?: boolean }?]
    >;
    readonly openMachine: jest.Mock<Promise<void>, [string | null]>;
    readonly setAllowIncoming: jest.Mock<
      Promise<RemoteControlState>,
      [boolean]
    >;
    readonly startPairing: jest.Mock<Promise<RemoteControlState>, [string]>;
    readonly cancelPairing: jest.Mock<Promise<RemoteControlState>, []>;
    readonly respondToPairing: jest.Mock<
      Promise<RemoteControlState>,
      [{ pairingId: string; approve: boolean }]
    >;
    readonly forgetDevice: jest.Mock<
      Promise<RemoteControlState>,
      [{ deviceId: string; role: 'host' | 'controller' }]
    >;
    readonly disconnectController: jest.Mock<
      Promise<RemoteControlState>,
      [string]
    >;
    readonly resolvePathPicker: jest.Mock<
      Promise<void>,
      [{ requestId: string; path: string | null }]
    >;
    readonly listDirectory: jest.Mock<
      Promise<RemoteDirectoryListing>,
      [{ path: string | null }]
    >;
  };
  /** Current state main would return. */
  current: RemoteControlState;
  /** Pushes a state snapshot to every `onStateChanged` listener. */
  emitState: (next: RemoteControlState) => void;
  emitPathPicker: (request: RemotePathPickerRequest) => void;
  stateListenerCount: () => number;
}

/**
 * An in-memory `window.api.remoteControl`: each action returns `current`,
 * which a test can replace to script main's answers.
 */
export function createFakeRemoteControl(
  context: RemoteControlContext = { mode: 'local' },
  initial: RemoteControlState = makeRemoteState(),
): FakeRemoteControl {
  const stateListeners = new Set<(state: RemoteControlState) => void>();
  const pickerListeners = new Set<(request: RemotePathPickerRequest) => void>();
  const fake: FakeRemoteControl = {
    current: initial,
    mocks: {
      getState: jest.fn(() => Promise.resolve(fake.current)),
      openMachine: jest.fn<Promise<void>, [string | null]>(() =>
        Promise.resolve(),
      ),
      setAllowIncoming: jest.fn((allow: boolean) => {
        fake.current = { ...fake.current, allowIncoming: allow };
        return Promise.resolve(fake.current);
      }),
      startPairing: jest.fn<Promise<RemoteControlState>, [string]>(() =>
        Promise.resolve(fake.current),
      ),
      cancelPairing: jest.fn<Promise<RemoteControlState>, []>(() =>
        Promise.resolve(fake.current),
      ),
      respondToPairing: jest.fn<
        Promise<RemoteControlState>,
        [{ pairingId: string; approve: boolean }]
      >(() => Promise.resolve(fake.current)),
      forgetDevice: jest.fn<
        Promise<RemoteControlState>,
        [{ deviceId: string; role: 'host' | 'controller' }]
      >(() => Promise.resolve(fake.current)),
      disconnectController: jest.fn<Promise<RemoteControlState>, [string]>(() =>
        Promise.resolve(fake.current),
      ),
      resolvePathPicker: jest.fn<
        Promise<void>,
        [{ requestId: string; path: string | null }]
      >(() => Promise.resolve()),
      listDirectory: jest.fn<
        Promise<RemoteDirectoryListing>,
        [{ path: string | null }]
      >(() =>
        Promise.resolve({ path: '/home/ada', parent: '/home', entries: [] }),
      ),
    },
    api: {
      getContext: () => context,
      getState: (request) => fake.mocks.getState(request),
      onStateChanged: (listener) => {
        stateListeners.add(listener);
        return (): void => {
          stateListeners.delete(listener);
        };
      },
      openMachine: (deviceId) => fake.mocks.openMachine(deviceId),
      setAllowIncoming: (allow) => fake.mocks.setAllowIncoming(allow),
      startPairing: (deviceId) => fake.mocks.startPairing(deviceId),
      cancelPairing: () => fake.mocks.cancelPairing(),
      respondToPairing: (request) => fake.mocks.respondToPairing(request),
      forgetDevice: (request) => fake.mocks.forgetDevice(request),
      disconnectController: (deviceId) =>
        fake.mocks.disconnectController(deviceId),
      onPathPickerRequest: (listener) => {
        pickerListeners.add(listener);
        return (): void => {
          pickerListeners.delete(listener);
        };
      },
      resolvePathPicker: (response) => fake.mocks.resolvePathPicker(response),
      listDirectory: (request) => fake.mocks.listDirectory(request),
    },
    emitState: (next) => {
      fake.current = next;
      stateListeners.forEach((listener) => listener(next));
    },
    emitPathPicker: (request) => {
      pickerListeners.forEach((listener) => listener(request));
    },
    stateListenerCount: () => stateListeners.size,
  };
  return fake;
}

/** Installs the fake as `window.api.remoteControl`. */
export function installRemoteControlApi(fake: FakeRemoteControl | null): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: fake ? { remoteControl: fake.api } : undefined,
  });
}

/** Seeds the store directly, as a hydrated snapshot would. */
export function seedRemoteControlStore(
  state: RemoteControlState,
  context: RemoteControlContext = { mode: 'local' },
): void {
  useRemoteControlStore.setState({
    hydrated: true,
    context,
    state,
    pairDialogOpen: false,
  });
}

export function resetRemoteControlStore(): void {
  useRemoteControlStore.setState({
    hydrated: false,
    context: { mode: 'local' },
    state: defaultRemoteControlState(),
    pairDialogOpen: false,
  });
}

/** Lets pending promise callbacks run. */
export async function flushPromises(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

export function byTestId<T extends HTMLElement = HTMLElement>(
  testId: string,
): T {
  const element = document.querySelector<T>(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`Element not found: ${testId}`);
  return element;
}

export function maybeByTestId(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}
