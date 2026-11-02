import {
  LABS_EXPERIMENTS,
  type LabsExperimentsSnapshot,
} from '@canopy/desktop-shared/lib/labs-experiments';
import type { createDaemonFilesRoute } from '../daemon-files-route';

let mockSnapshot: LabsExperimentsSnapshot | null;
let mockOptions: Parameters<typeof createDaemonFilesRoute>[0];
let mockInitialEnabled: boolean;
const mockDispose = jest.fn();
const mockConnections = jest.fn();
const mockHostContext = jest.fn();
const mockDisposeConnections = jest.fn();
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
  getElectronDaemonCallerLifetime: jest.fn(),
  get getElectronDaemonConnections(): typeof mockConnections {
    return mockConnections;
  },
  get getElectronDaemonFilesContext(): typeof mockHostContext {
    return mockHostContext;
  },
  get disposeElectronDaemonConnections(): typeof mockDisposeConnections {
    return mockDisposeConnections;
  },
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
  // Files eligibility checks must not clone the entire Labs registry per read.
  expect(mockGetSnapshot).toHaveBeenCalledTimes(1);
  expect(mockSubscribe).toHaveBeenCalledTimes(1);
  expect(mockConnections).not.toHaveBeenCalled();
  expect(mockHostContext).not.toHaveBeenCalled();
  await disposeElectronDaemonFiles();
  expect(mockDispose).toHaveBeenCalledTimes(1);
  expect(mockDisposeConnections).toHaveBeenCalledTimes(1);
});
