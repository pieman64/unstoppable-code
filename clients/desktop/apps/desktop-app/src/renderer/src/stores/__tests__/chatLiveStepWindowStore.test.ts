/**
 * @jest-environment jsdom
 */
import type {
  PreferencesData,
  PreferencesLoadResult,
} from '@canopy/desktop-shared/types';
import type * as ChatLiveStepWindowStoreModule from '../chatLiveStepWindowStore';
import { makeTestPreferences } from '../../test-utils/preferences';

type SyncListener = (preferences: PreferencesData) => void;

const loadPreferencesMock = jest.fn<Promise<PreferencesData>, []>();
const savePreferencesMock = jest.fn<
  Promise<PreferencesData>,
  [Partial<PreferencesData>]
>();
let syncListeners: SyncListener[] = [];

function prefs(chatLiveStepWindowEnabled: boolean): PreferencesData {
  return makeTestPreferences({ chatLiveStepWindowEnabled });
}

function broadcast(preferences: PreferencesData): void {
  for (const listener of syncListeners) listener(preferences);
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('chatLiveStepWindowStore', () => {
  beforeEach(() => {
    jest.resetModules();
    loadPreferencesMock.mockReset();
    savePreferencesMock.mockReset();
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

  async function loadStore(): Promise<typeof ChatLiveStepWindowStoreModule> {
    return import('../chatLiveStepWindowStore');
  }

  it('reads off until the saved preference loads', async () => {
    loadPreferencesMock.mockResolvedValue(prefs(true));
    const { useChatLiveStepWindowStore, ensureChatLiveStepWindowSubscription } =
      await loadStore();
    expect(useChatLiveStepWindowStore.getState()).toMatchObject({
      enabled: false,
      hydrated: false,
    });
    ensureChatLiveStepWindowSubscription();
    ensureChatLiveStepWindowSubscription();
    await flush();
    expect(loadPreferencesMock).toHaveBeenCalledTimes(1);
    expect(syncListeners).toHaveLength(1);
    expect(useChatLiveStepWindowStore.getState()).toMatchObject({
      enabled: true,
      hydrated: true,
    });
  });

  it('stays off when the preference cannot be read', async () => {
    loadPreferencesMock.mockRejectedValue(new Error('read failed'));
    const { useChatLiveStepWindowStore, ensureChatLiveStepWindowSubscription } =
      await loadStore();
    ensureChatLiveStepWindowSubscription();
    await flush();
    expect(useChatLiveStepWindowStore.getState()).toMatchObject({
      enabled: false,
      hydrated: true,
    });
  });

  it('follows a change saved in another window', async () => {
    loadPreferencesMock.mockResolvedValueOnce(prefs(false));
    const { useChatLiveStepWindowStore, ensureChatLiveStepWindowSubscription } =
      await loadStore();
    ensureChatLiveStepWindowSubscription();
    await flush();
    expect(useChatLiveStepWindowStore.getState().enabled).toBe(false);

    // The broadcast is only a signal; the canonical read decides.
    loadPreferencesMock.mockResolvedValueOnce(prefs(true));
    broadcast(prefs(false));
    await flush();
    expect(useChatLiveStepWindowStore.getState().enabled).toBe(true);

    loadPreferencesMock.mockResolvedValueOnce(prefs(false));
    broadcast(prefs(false));
    await flush();
    expect(useChatLiveStepWindowStore.getState().enabled).toBe(false);
  });

  it('applies a change at once and keeps what main saved', async () => {
    loadPreferencesMock.mockResolvedValue(prefs(false));
    const { useChatLiveStepWindowStore, ensureChatLiveStepWindowSubscription } =
      await loadStore();
    ensureChatLiveStepWindowSubscription();
    await flush();
    let resolveSave: (value: PreferencesData) => void = () => undefined;
    savePreferencesMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    const saving = useChatLiveStepWindowStore.getState().setEnabled(true);
    expect(useChatLiveStepWindowStore.getState().enabled).toBe(true);
    expect(savePreferencesMock).toHaveBeenCalledWith({
      chatLiveStepWindowEnabled: true,
    });
    resolveSave(prefs(true));
    await saving;
    expect(useChatLiveStepWindowStore.getState().enabled).toBe(true);
  });

  it('rolls back and rejects when the save fails', async () => {
    loadPreferencesMock.mockResolvedValue(prefs(false));
    const { useChatLiveStepWindowStore, ensureChatLiveStepWindowSubscription } =
      await loadStore();
    ensureChatLiveStepWindowSubscription();
    await flush();
    savePreferencesMock.mockRejectedValueOnce(new Error('disk full'));
    await expect(
      useChatLiveStepWindowStore.getState().setEnabled(true),
    ).rejects.toThrow('disk full');
    expect(useChatLiveStepWindowStore.getState().enabled).toBe(false);
  });

  it('does not let an older failed save undo a newer choice', async () => {
    loadPreferencesMock.mockResolvedValue(prefs(false));
    const { useChatLiveStepWindowStore, ensureChatLiveStepWindowSubscription } =
      await loadStore();
    ensureChatLiveStepWindowSubscription();
    await flush();
    let rejectFirst: (error: Error) => void = () => undefined;
    savePreferencesMock
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
      )
      .mockResolvedValueOnce(prefs(false));
    const first = useChatLiveStepWindowStore.getState().setEnabled(true);
    const second = useChatLiveStepWindowStore.getState().setEnabled(false);
    await second;
    // The canonical read that follows a stale failure agrees with main.
    loadPreferencesMock.mockResolvedValue(prefs(false));
    rejectFirst(new Error('late failure'));
    await expect(first).rejects.toThrow('late failure');
    await flush();
    expect(useChatLiveStepWindowStore.getState().enabled).toBe(false);
  });

  it('keeps a pending choice when another sync reads before it commits', async () => {
    loadPreferencesMock.mockResolvedValueOnce(prefs(false));
    const { useChatLiveStepWindowStore, ensureChatLiveStepWindowSubscription } =
      await loadStore();
    ensureChatLiveStepWindowSubscription();
    await flush();
    let resolveSave: (value: PreferencesData) => void = () => undefined;
    savePreferencesMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    const saving = useChatLiveStepWindowStore.getState().setEnabled(true);
    // Another window saves an unrelated preference; main has not committed
    // this save yet, so the read it triggers still says off.
    loadPreferencesMock.mockResolvedValueOnce(prefs(false));
    broadcast(prefs(false));
    await flush();
    expect(useChatLiveStepWindowStore.getState().enabled).toBe(true);
    resolveSave(prefs(true));
    await saving;
    expect(useChatLiveStepWindowStore.getState().enabled).toBe(true);
    // The save's own broadcast reads the committed value.
    loadPreferencesMock.mockResolvedValueOnce(prefs(true));
    broadcast(prefs(true));
    await flush();
    expect(useChatLiveStepWindowStore.getState().enabled).toBe(true);
  });

  it('ignores a read that started before a save and lands after it', async () => {
    let resolveLoad: (value: PreferencesData) => void = () => undefined;
    loadPreferencesMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const { useChatLiveStepWindowStore, ensureChatLiveStepWindowSubscription } =
      await loadStore();
    ensureChatLiveStepWindowSubscription();
    await flush();
    savePreferencesMock.mockResolvedValueOnce(prefs(true));
    await useChatLiveStepWindowStore.getState().setEnabled(true);
    resolveLoad(prefs(false));
    await flush();
    expect(useChatLiveStepWindowStore.getState()).toMatchObject({
      enabled: true,
      hydrated: true,
    });
  });

  it('follows a load main recovered from an unreadable file', async () => {
    // `__error` marks a recovered read: main backed the file up and now
    // serves these values, so they are what the next save builds on.
    const recovered: PreferencesLoadResult = {
      ...prefs(false),
      __error: {
        timestamp: '2026-10-15T00:00:00.000Z',
        reason: 'parse',
        message: 'Unexpected token',
        filePath: '/tmp/preferences.json',
      },
    };
    loadPreferencesMock.mockResolvedValueOnce(recovered);
    const { useChatLiveStepWindowStore, ensureChatLiveStepWindowSubscription } =
      await loadStore();
    ensureChatLiveStepWindowSubscription();
    await flush();
    expect(useChatLiveStepWindowStore.getState()).toMatchObject({
      enabled: false,
      hydrated: true,
    });
  });
});
