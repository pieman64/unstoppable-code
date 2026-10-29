/**
 * @jest-environment jsdom
 */
import type { PreferencesData } from '@canopy/desktop-shared/types';
import type * as NavigationModeStoreModule from '../navigationModeStore';
import { makeTestPreferences } from '../../test-utils/preferences';

type SyncListener = (preferences: PreferencesData) => void;

const loadPreferencesMock = jest.fn<Promise<PreferencesData>, []>();
const savePreferencesMock = jest.fn<Promise<PreferencesData>, [unknown]>();
let syncListeners: SyncListener[] = [];

function prefs(navigationMode: 'code' | 'work'): PreferencesData {
  return makeTestPreferences({ navigationMode });
}

function broadcast(preferences: PreferencesData): void {
  for (const listener of syncListeners) listener(preferences);
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('navigationModeStore', () => {
  beforeEach(() => {
    jest.resetModules();
    loadPreferencesMock.mockReset();
    savePreferencesMock.mockReset();
    savePreferencesMock.mockResolvedValue(prefs('code'));
    syncListeners = [];
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: loadPreferencesMock,
        savePreferences: savePreferencesMock,
        onPreferencesSynced: (listener: SyncListener): (() => void) => {
          syncListeners.push(listener);
          return (): void => {
            syncListeners = syncListeners.filter((l) => l !== listener);
          };
        },
      },
    });
  });

  async function loadStore(): Promise<typeof NavigationModeStoreModule> {
    return import('../navigationModeStore');
  }

  it('hydrates from the startup snapshot without an IPC read', async () => {
    const { useNavigationModeStore } = await loadStore();
    await useNavigationModeStore.getState().hydrate(prefs('work'));
    expect(useNavigationModeStore.getState().mode).toBe('work');
    expect(useNavigationModeStore.getState().hydrated).toBe(true);
    expect(loadPreferencesMock).not.toHaveBeenCalled();
  });

  it('treats a preferences broadcast as an invalidation and reads canonical state', async () => {
    const { useNavigationModeStore } = await loadStore();
    await useNavigationModeStore.getState().hydrate(prefs('code'));
    loadPreferencesMock.mockResolvedValueOnce(prefs('work'));

    // The broadcast snapshot itself is stale (`code`); the canonical read
    // wins.
    broadcast(prefs('code'));
    await flush();

    expect(loadPreferencesMock).toHaveBeenCalledTimes(1);
    expect(useNavigationModeStore.getState().mode).toBe('work');
  });

  it('ignores an out-of-order canonical read that resolves after a newer one', async () => {
    const { useNavigationModeStore } = await loadStore();
    await useNavigationModeStore.getState().hydrate(prefs('code'));

    const first: { resolve?: (value: PreferencesData) => void } = {};
    loadPreferencesMock.mockImplementationOnce(
      () =>
        new Promise<PreferencesData>((resolve) => {
          first.resolve = resolve;
        }),
    );
    loadPreferencesMock.mockResolvedValueOnce(prefs('work'));

    broadcast(prefs('code'));
    broadcast(prefs('work'));
    await flush();
    expect(useNavigationModeStore.getState().mode).toBe('work');

    // The first (older) read finally resolves with a stale value.
    if (!first.resolve) throw new Error('first read never started');
    first.resolve(prefs('code'));
    await flush();
    expect(useNavigationModeStore.getState().mode).toBe('work');
  });

  it('never lets an in-flight read overwrite an explicit setMode', async () => {
    const { useNavigationModeStore } = await loadStore();
    await useNavigationModeStore.getState().hydrate(prefs('code'));

    const read: { resolve?: (value: PreferencesData) => void } = {};
    loadPreferencesMock.mockImplementationOnce(
      () =>
        new Promise<PreferencesData>((resolve) => {
          read.resolve = resolve;
        }),
    );
    broadcast(prefs('code'));

    await useNavigationModeStore.getState().setMode('work');
    expect(savePreferencesMock).toHaveBeenCalledWith({
      navigationMode: 'work',
    });
    expect(useNavigationModeStore.getState().mode).toBe('work');

    if (!read.resolve) throw new Error('read never started');
    read.resolve(prefs('code'));
    await flush();
    expect(useNavigationModeStore.getState().mode).toBe('work');
  });

  it('does not let a stale failed save roll back a newer selection', async () => {
    const { useNavigationModeStore } = await loadStore();
    await useNavigationModeStore.getState().hydrate(prefs('code'));
    loadPreferencesMock.mockResolvedValue(prefs('code'));

    const firstSave: { reject?: (error: Error) => void } = {};
    savePreferencesMock.mockImplementationOnce(
      () =>
        new Promise<PreferencesData>((_resolve, reject) => {
          firstSave.reject = reject;
        }),
    );
    savePreferencesMock.mockResolvedValueOnce(prefs('code'));

    const older = useNavigationModeStore.getState().setMode('work');
    await useNavigationModeStore.getState().setMode('code');
    expect(useNavigationModeStore.getState().mode).toBe('code');

    if (!firstSave.reject) throw new Error('first save never started');
    firstSave.reject(new Error('stale failure'));
    await expect(older).rejects.toThrow('stale failure');
    await flush();
    // The stale rollback would have restored `code` → `work`; instead the
    // newer, persisted selection stands.
    expect(useNavigationModeStore.getState().mode).toBe('code');
  });

  it('rolls overlapping failures back to the last confirmed mode, not an earlier optimistic one', async () => {
    const { useNavigationModeStore } = await loadStore();
    await useNavigationModeStore.getState().hydrate(prefs('code'));
    loadPreferencesMock.mockResolvedValue(prefs('code'));

    const first: { reject?: (error: Error) => void } = {};
    const second: { reject?: (error: Error) => void } = {};
    savePreferencesMock
      .mockImplementationOnce(
        () =>
          new Promise<PreferencesData>((_resolve, reject) => {
            first.reject = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<PreferencesData>((_resolve, reject) => {
            second.reject = reject;
          }),
      );

    // code → work → code, neither save persists.
    const older = useNavigationModeStore.getState().setMode('work');
    const newer = useNavigationModeStore.getState().setMode('code');
    if (!first.reject || !second.reject) throw new Error('saves never started');
    first.reject(new Error('first failed'));
    await expect(older).rejects.toThrow('first failed');
    await flush();
    second.reject(new Error('second failed'));
    await expect(newer).rejects.toThrow('second failed');
    await flush();

    // The naive rollback would restore the optimistic `work`; the store
    // returns to the last confirmed `code` instead.
    expect(useNavigationModeStore.getState().mode).toBe('code');
  });

  it('restores the previous mode and rethrows when the save fails', async () => {
    const { useNavigationModeStore } = await loadStore();
    await useNavigationModeStore.getState().hydrate(prefs('code'));
    savePreferencesMock.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      useNavigationModeStore.getState().setMode('work'),
    ).rejects.toThrow('disk full');
    expect(useNavigationModeStore.getState().mode).toBe('code');
  });
});
