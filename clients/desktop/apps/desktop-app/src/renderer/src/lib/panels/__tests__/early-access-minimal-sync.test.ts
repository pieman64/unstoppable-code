/** @jest-environment jsdom */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import type { WorkspaceLayoutMode } from '@canopy/desktop-shared/types';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';
import {
  useWorkspaceLayoutModeStore,
  type WorkspaceLayoutModeEntry,
} from '@/stores/workspaceLayoutModeStore';
import {
  ensureEarlyAccessMinimalSync,
  resetEarlyAccessMinimalSyncForTest,
} from '../early-access-minimal-sync';

const pending = new Set<string>();
const setMode = jest.fn<Promise<boolean>, [string, WorkspaceLayoutMode]>();

jest.mock('../workspace-layout-mode-actions', () => ({
  setWorkspacePanelLayoutMode: (
    worktreeKey: string,
    mode: WorkspaceLayoutMode,
  ): Promise<boolean> => setMode(worktreeKey, mode),
  isWorkspaceLayoutModeTransitionPending: (worktreeKey: string): boolean =>
    pending.has(worktreeKey),
}));

const refreshLiveMinimal = jest.fn<void, [string]>();

jest.mock('../persistence-bridge', () => ({
  refreshLiveMinimalLayout: (worktreeKey: string): void =>
    refreshLiveMinimal(worktreeKey),
}));

function ready(mode: WorkspaceLayoutMode): WorkspaceLayoutModeEntry {
  return { mode, status: 'ready', requestId: 1 };
}

const OPEN_WORKTREES: Record<string, WorkspaceLayoutModeEntry> = {
  'p/advanced': ready('advanced'),
  'p/minimal': ready('minimal'),
  'p/loading': { mode: 'advanced', status: 'loading', requestId: 1 },
};

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

beforeEach(() => {
  pending.clear();
  setMode.mockReset().mockResolvedValue(true);
  refreshLiveMinimal.mockReset();
  // No preferences bridge: the store hydrates as off and the test drives it.
  Object.defineProperty(window, 'api', { configurable: true, value: {} });
  ensureEarlyAccessMinimalSync();
  useWorkspaceLayoutModeStore.setState({ entries: { ...OPEN_WORKTREES } });
});

afterEach(() => {
  resetEarlyAccessMinimalSyncForTest();
  resetExperimentalFeaturesStoreForTest();
  useWorkspaceLayoutModeStore.setState({ entries: {} });
});

it('changes no mode and re-shapes nothing when early access turns on', async () => {
  setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
  await settle();

  expect(setMode).not.toHaveBeenCalled();
  expect(refreshLiveMinimal).not.toHaveBeenCalled();
  expect(useWorkspaceLayoutModeStore.getState().entries).toEqual(
    OPEN_WORKTREES,
  );
});

it('changes no mode when early access turns off', async () => {
  setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
  await settle();

  setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
  await settle();

  expect(setMode).not.toHaveBeenCalled();
  expect(useWorkspaceLayoutModeStore.getState().entries).toEqual(
    OPEN_WORKTREES,
  );
  // Open worktrees get back what Minimal holds without early access; the
  // refresh itself leaves Advanced layouts alone. A loading worktree builds
  // its layout from the new value on its own.
  expect(refreshLiveMinimal.mock.calls.map(([key]) => key).sort()).toEqual([
    'p/advanced',
    'p/minimal',
  ]);
});

it('skips a worktree that is switching modes when early access turns off', async () => {
  setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
  await settle();
  pending.add('p/minimal');

  setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
  await settle();

  expect(refreshLiveMinimal).not.toHaveBeenCalledWith('p/minimal');
});

it('does nothing before the saved value has loaded', async () => {
  setTestEarlyAccessFeatures({ enabled: true, hydrated: false });
  setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
  await settle();

  expect(refreshLiveMinimal).not.toHaveBeenCalled();
});
