import {
  LABS_EXPERIMENTS,
  type LabsExperimentsSnapshot,
} from '@canopy/desktop-shared/lib/labs-experiments';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type { createDaemonFilesRoute } from '../daemon-files-route';
import {
  createElectronDaemonHealth,
  type ElectronDaemonHealth,
} from '../electron-daemon-health';

let mockSnapshot: LabsExperimentsSnapshot | null;
let mockOptions: Parameters<typeof createDaemonFilesRoute>[0];
let mockInitialEnabled: boolean;
const mockDispose = jest.fn();
const mockConnections = jest.fn();
const mockHostContext = jest.fn();
const mockDisposeConnections = jest.fn();
const mockCallerLifetime = jest.fn();
let mockHealth: ElectronDaemonHealth = createElectronDaemonHealth({
  warn: jest.fn(),
  info: jest.fn(),
});
const mockDisposeLifetimes = jest.fn();
let mockFlip = false;
let mockHandoffPending = false;
jest.mock('../../lib/w5-flip-gate', (): object => ({
  isW5DaemonFlipCompiled: (): boolean => mockFlip,
}));
const mockSubscribe = jest.fn<
  () => void,
  [(snapshot: LabsExperimentsSnapshot) => void]
>();
const mockGetSnapshot = jest.fn((): LabsExperimentsSnapshot => {
  if (!mockSnapshot) throw new Error('Snapshot not installed');
  return structuredClone(mockSnapshot);
});
let mockLegacyEnabled = false;
jest.mock('../../feature-flags', (): object => ({
  getFeatureFlagService: (): object => ({
    isEnabled: (): boolean => mockLegacyEnabled,
    onSnapshotChanged: jest.fn(),
  }),
}));
jest.mock('../../services/labs-experiments-runtime', (): object => ({
  getLabsExperimentsService: () => ({
    getSnapshot: mockGetSnapshot,
    onSnapshotChanged: mockSubscribe,
  }),
}));
jest.mock('../daemon-files-route', (): object => ({
  createDaemonFilesRoute: (options: typeof mockOptions): object => {
    mockOptions = options;
    mockInitialEnabled = options.isFlagEnabled();
    return { dispose: mockDispose };
  },
}));
jest.mock('../electron-daemon-access', (): object => ({
  get getElectronDaemonCallerLifetime(): typeof mockCallerLifetime {
    return mockCallerLifetime;
  },
  get getElectronDaemonConnections(): typeof mockConnections {
    return mockConnections;
  },
  get getElectronDaemonFilesContext(): typeof mockHostContext {
    return mockHostContext;
  },
  get disposeElectronDaemonConnections(): typeof mockDisposeConnections {
    return mockDisposeConnections;
  },
  get disposeElectronDaemonCallerLifetimes(): typeof mockDisposeLifetimes {
    return mockDisposeLifetimes;
  },
  isElectronW5HandoffPending: (): boolean => mockHandoffPending,
  setElectronDaemonFilesConsumerEnabled: (enabled: boolean): void =>
    mockHealth.setConsumerEnabled('files_reads', enabled),
}));
jest.mock('../electron-daemon-health', (): object => ({
  ...jest.requireActual<object>('../electron-daemon-health'),
  getElectronDaemonHealth: (): ElectronDaemonHealth => mockHealth,
}));
jest.mock('../../lib/resolve-worktree', (): object => ({
  resolveWorktreeTargetIds: jest.fn(),
}));
jest.mock('../../lib/workspace-registry', (): object => ({
  getWorkspaceType: jest.fn(),
}));

import {
  disposeElectronDaemonFiles,
  getDesktopDaemonFilesRoute,
  retryDesktopDaemonFilesConnection,
} from '../electron-daemon-files-access';

const FILES = LABS_EXPERIMENTS.find(
  (entry) => entry.id === 'daemon-files-reads',
);

function snapshot(
  ready: boolean,
  enabled: boolean,
  choicesReady = true,
): LabsExperimentsSnapshot {
  if (!FILES) throw new Error('Files experiment not registered');
  return {
    generation: 1,
    revision: 1,
    scope: 'local',
    ready,
    choicesReady,
    earlyAccessEnabled: false,
    updatedAt: new Date().toISOString(),
    experiments: [
      {
        ...FILES,
        pages: [...FILES.pages],
        sidebarKeys: [...FILES.sidebarKeys],
        availability: 'on',
        choice: null,
        listed: ready,
        enabled,
      },
    ],
  };
}

it('projects authoritative pushes before notifying the lazy route and disposes it at quit', async () => {
  mockSnapshot = snapshot(false, true);
  const route = getDesktopDaemonFilesRoute();
  expect(mockInitialEnabled).toBe(false);
  expect(getDesktopDaemonFilesRoute()).toBe(route);
  // The health record follows the same projection (CAN-5541).
  const health: boolean[] = [];
  const setConsumerEnabled = jest
    .spyOn(mockHealth, 'setConsumerEnabled')
    .mockImplementation((_consumer, enabled) => void health.push(enabled));
  const observed: boolean[] = [];
  const listener = jest.fn(() => observed.push(mockOptions.isFlagEnabled()));
  const unsubscribe = jest.fn();
  mockSubscribe.mockReturnValue(unsubscribe);
  expect(mockOptions.onFlagChanged(listener)).toBe(unsubscribe);
  const publish = (next: LabsExperimentsSnapshot): void => {
    mockSnapshot = next;
    const subscriber = mockSubscribe.mock.calls[0]?.[0];
    if (!subscriber) throw new Error('Route did not subscribe to Labs');
    subscriber(next);
  };
  expect(mockOptions.isFlagEnabled()).toBe(false);
  publish(snapshot(true, true, false));
  expect(mockOptions.isFlagEnabled()).toBe(true);
  mockLegacyEnabled = true;
  publish(snapshot(true, false));
  expect(mockOptions.isFlagEnabled()).toBe(false);
  publish({ ...snapshot(true, true), experiments: [] });
  expect(mockOptions.isFlagEnabled()).toBe(false);
  publish(snapshot(true, true));
  expect(mockOptions.isFlagEnabled()).toBe(true);
  publish(snapshot(false, true));
  expect(mockOptions.isFlagEnabled()).toBe(false);
  expect(observed).toEqual([true, false, false, true, false]);
  expect(health).toEqual([true, false, false, true, false]);
  expect(
    setConsumerEnabled.mock.calls.every(([id]) => id === 'files_reads'),
  ).toBe(true);
  setConsumerEnabled.mockRestore();
  // The route's fallbacks and latch are the shared record's, as Files reads.
  mockHealth.setConsumerEnabled('files_reads', true);
  expect(mockOptions.reachability?.isLatched()).toBe(false);
  mockOptions.reachability?.noteFallback('start_failed');
  expect(mockHealth.getStatus()).toMatchObject({
    state: 'unavailable',
    reason: 'start_failed',
  });
  expect(mockOptions.reachability?.isLatched()).toBe(true);
  mockHealth.setConsumerEnabled('files_reads', false);
  expect(mockOptions.reachability?.isLatched()).toBe(false);
  // Files eligibility checks must not clone the entire Labs registry per read.
  expect(mockGetSnapshot).toHaveBeenCalledTimes(1);
  expect(mockSubscribe).toHaveBeenCalledTimes(1);
  expect(mockConnections).not.toHaveBeenCalled();
  expect(mockHostContext).not.toHaveBeenCalled();
  await disposeElectronDaemonFiles();
  expect(mockDispose).toHaveBeenCalledTimes(1);
  expect(mockDisposeConnections).toHaveBeenCalledTimes(1);
});

// CAN-5543: the flip handoff is a restart window (q-13), never a typed failure.
it('reads in-process with nothing shown while the W5 flip handoff is pending', () => {
  mockSnapshot = snapshot(true, true);
  getDesktopDaemonFilesRoute();
  mockHealth.setConsumerEnabled('files_reads', true);
  expect(mockOptions.reachability?.isLatched()).toBe(false);
  mockHandoffPending = true;
  try {
    expect(mockOptions.reachability?.isLatched()).toBe(true);
    expect(mockHealth.getStatus()).toMatchObject({ state: 'ok' });
    expect(mockHealth.isLatched()).toBe(false);
  } finally {
    mockHandoffPending = false;
  }
  expect(mockOptions.reachability?.isLatched()).toBe(false);
  mockHealth.setConsumerEnabled('files_reads', false);
});

describe('Try again for the background service notice (CAN-5541)', () => {
  const sender = {
    id: 7,
    isDestroyed: (): boolean => false,
    on: jest.fn(),
    removeListener: jest.fn(),
  };
  const local: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'electron-web-contents:7',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: ['worker.filesystem.read'],
  };
  const documentOwner = new AbortController().signal;
  const ownerFor = jest.fn(() => documentOwner);
  const get = jest.fn();
  beforeEach(() => {
    mockHealth = createElectronDaemonHealth({
      warn: jest.fn(),
      info: jest.fn(),
    });
    mockHealth.setConsumerEnabled('files_reads', true);
    mockHealth.observe({ kind: 'unreachable', reason: 'start_failed' });
    get.mockReset();
    ownerFor.mockClear();
    mockConnections.mockReset().mockReturnValue({ get });
    mockCallerLifetime.mockReset().mockReturnValue({ ownerFor });
    mockHostContext.mockReset().mockResolvedValue({
      authorityId: 'authority-9',
      canonicalDataRoot: '/data',
    });
  });

  it("uses exactly the Files reads' caller and document owner, past the reuse window", async () => {
    get.mockResolvedValue({ lease: { state: 'active' } });
    await expect(
      retryDesktopDaemonFilesConnection(sender, local),
    ).resolves.toMatchObject({ state: 'ok', retry: 'idle' });
    // The route's `{ ...context.caller, authorityId: host.authorityId }`, so
    // the retry and the next read share one session.
    expect(get).toHaveBeenCalledWith(
      { ...local, authorityId: 'authority-9' },
      documentOwner,
      { reprobe: true },
    );
    expect(ownerFor).toHaveBeenCalledWith(sender);
  });

  it('a reused session that is still reconnecting does not clear the notice', async () => {
    get.mockResolvedValue({ lease: { state: 'reconnecting' } });
    await expect(
      retryDesktopDaemonFilesConnection(sender, local),
    ).resolves.toMatchObject({ state: 'unavailable', retry: 'failed' });
  });

  it('reports a failed attempt and stays unavailable', async () => {
    get.mockRejectedValue(new Error('Core launch failed.'));
    await expect(
      retryDesktopDaemonFilesConnection(sender, local),
    ).resolves.toMatchObject({ state: 'unavailable', retry: 'failed' });
  });

  it.each([
    [
      'a remote-control bridge',
      { ...local, clientInstanceId: 'remote-bridge:7' },
    ],
    [
      'another window',
      { ...local, clientInstanceId: 'electron-web-contents:8' },
    ],
  ])('refuses %s caller without contact', async (_name, caller) => {
    await expect(
      retryDesktopDaemonFilesConnection(sender, caller),
    ).resolves.toMatchObject({ state: 'unavailable', retry: 'idle' });
    expect(mockHostContext).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('does nothing while Files reads are off', async () => {
    mockHealth.setConsumerEnabled('files_reads', false);
    await retryDesktopDaemonFilesConnection(sender, local);
    expect(mockHostContext).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});

it("keeps a flip build's daemon sessions for the W5 store past the Files route", async () => {
  mockSnapshot = snapshot(true, true);
  getDesktopDaemonFilesRoute();
  mockDispose.mockClear();
  mockDisposeConnections.mockClear();
  mockFlip = true;
  try {
    await disposeElectronDaemonFiles();
  } finally {
    mockFlip = false;
  }
  expect(mockDispose).toHaveBeenCalledTimes(1);
  expect(mockDisposeLifetimes).toHaveBeenCalledTimes(1);
  // The W5 slot at quit disposes them (disposeW5FlipHandoff).
  expect(mockDisposeConnections).not.toHaveBeenCalled();
});
