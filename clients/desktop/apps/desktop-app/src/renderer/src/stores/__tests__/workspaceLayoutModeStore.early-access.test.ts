/** @jest-environment jsdom */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import type { PreferencesData } from '@canopy/desktop-shared/types';
import type { LabsExperimentsSnapshot } from '@canopy/desktop-shared/lib/labs-experiments';
import { makeTestLabsSnapshot } from '@/test-utils/labsExperiments';
import { makeTestPreferences } from '@/test-utils/preferences';
import {
  resetExperimentalFeaturesStoreForTest,
  useExperimentalFeaturesStore,
} from '../experimentalFeaturesStore';
import { resetLabsExperimentsStoreForTest } from '../labsExperimentsStore';
import { useWorkspaceLayoutModeStore } from '../workspaceLayoutModeStore';

const loadWorktreeMode = jest.fn();
const saveWorktreeMode = jest.fn();
const savePreferences = jest.fn<
  Promise<PreferencesData>,
  [Partial<PreferencesData>]
>();

beforeEach(() => {
  useWorkspaceLayoutModeStore.setState({ entries: {} });
  loadWorktreeMode.mockReset().mockResolvedValue({ mode: 'advanced' });
  saveWorktreeMode.mockReset().mockResolvedValue(undefined);
  savePreferences.mockReset();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      panelLayout: { loadWorktreeMode, saveWorktreeMode },
      loadPreferences: (): Promise<PreferencesData> =>
        Promise.resolve(makeTestPreferences()),
      savePreferences,
    },
  });
  setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
});

afterEach(() => {
  resetExperimentalFeaturesStoreForTest();
  resetLabsExperimentsStoreForTest();
});

describe('layout mode under early access', () => {
  it.each(['advanced', 'minimal'] as const)(
    'opens a worktree in its own %s mode',
    async (own) => {
      loadWorktreeMode.mockResolvedValue({ mode: own });

      await expect(
        useWorkspaceLayoutModeStore.getState().load('project/tree'),
      ).resolves.toBe(own);

      // Opening never writes a mode: early access picks none for a worktree.
      expect(saveWorktreeMode).not.toHaveBeenCalled();
      expect(savePreferences).not.toHaveBeenCalled();
    },
  );

  it('waits for the early-access setting before loading a mode', async () => {
    setTestEarlyAccessFeatures({ enabled: false, hydrated: false });
    let resolveSnapshot: (snapshot: LabsExperimentsSnapshot) => void = () =>
      undefined;
    Object.assign(window.api, {
      experiments: {
        getSnapshot: (): Promise<LabsExperimentsSnapshot> =>
          new Promise((resolve) => {
            resolveSnapshot = resolve;
          }),
        setChoice: jest.fn(),
        onSnapshotChanged: (): (() => void) => (): void => undefined,
      },
    });
    loadWorktreeMode.mockResolvedValue({ mode: 'minimal' });

    const loading = useWorkspaceLayoutModeStore.getState().load('project/tree');
    await Promise.resolve();
    await Promise.resolve();
    expect(loadWorktreeMode).not.toHaveBeenCalled();
    expect(
      useWorkspaceLayoutModeStore.getState().entries['project/tree']?.status,
    ).toBe('loading');

    resolveSnapshot(makeTestLabsSnapshot({ earlyAccess: true }));
    await expect(loading).resolves.toBe('minimal');
    expect(useExperimentalFeaturesStore.getState().enabled).toBe(true);
  });

  it('saves a mode change to that worktree alone', async () => {
    await useWorkspaceLayoutModeStore.getState().load('project/tree');
    await useWorkspaceLayoutModeStore.getState().load('project/other');

    await useWorkspaceLayoutModeStore
      .getState()
      .save('project/tree', 'minimal');

    expect(saveWorktreeMode).toHaveBeenCalledTimes(1);
    expect(saveWorktreeMode).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'tree',
      mode: 'minimal',
    });
    expect(savePreferences).not.toHaveBeenCalled();
    const { entries } = useWorkspaceLayoutModeStore.getState();
    expect(entries['project/tree']?.mode).toBe('minimal');
    expect(entries['project/other']?.mode).toBe('advanced');
  });

  it('keeps the worktree mode when its save fails', async () => {
    await useWorkspaceLayoutModeStore.getState().load('project/tree');
    saveWorktreeMode.mockRejectedValue(new Error('disk'));

    await expect(
      useWorkspaceLayoutModeStore.getState().save('project/tree', 'minimal'),
    ).rejects.toThrow('disk');

    expect(
      useWorkspaceLayoutModeStore.getState().entries['project/tree']?.mode,
    ).toBe('advanced');
  });
});
