/**
 * @jest-environment jsdom
 */
import type {
  PreferencesData,
  PreferencesLoadResult,
} from '@canopy/desktop-shared/types';
import type { ChatDetail } from '@canopy/protocol/chat-detail';
import type * as ChatDetailStoreModule from '../chatDetailStore';
import { makeTestPreferences } from '../../test-utils/preferences';

type SyncListener = (preferences: PreferencesData) => void;

const loadPreferencesMock = jest.fn<Promise<PreferencesData>, []>();
const savePreferencesMock = jest.fn<
  Promise<PreferencesData>,
  [Partial<PreferencesData>]
>();
let syncListeners: SyncListener[] = [];

function prefs(chatDetail: ChatDetail): PreferencesData {
  return makeTestPreferences({ chatDetail });
}

function broadcast(preferences: PreferencesData): void {
  for (const listener of syncListeners) listener(preferences);
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('chatDetailStore', () => {
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

  async function loadStore(): Promise<typeof ChatDetailStoreModule> {
    return import('../chatDetailStore');
  }

  it('reads the default until the saved preference loads', async () => {
    loadPreferencesMock.mockResolvedValue(prefs('compact'));
    const { useChatDetailStore, ensureChatDetailSubscription } =
      await loadStore();
    expect(useChatDetailStore.getState()).toMatchObject({
      detail: 'recent',
      hydrated: false,
    });
    ensureChatDetailSubscription();
    ensureChatDetailSubscription();
    await flush();
    expect(loadPreferencesMock).toHaveBeenCalledTimes(1);
    expect(syncListeners).toHaveLength(1);
    expect(useChatDetailStore.getState()).toMatchObject({
      detail: 'compact',
      hydrated: true,
    });
  });

  it('keeps the default when the preference cannot be read', async () => {
    loadPreferencesMock.mockRejectedValue(new Error('read failed'));
    const { useChatDetailStore, ensureChatDetailSubscription } =
      await loadStore();
    ensureChatDetailSubscription();
    await flush();
    expect(useChatDetailStore.getState()).toMatchObject({
      detail: 'recent',
      hydrated: true,
    });
  });

  it('follows a change saved in another window', async () => {
    loadPreferencesMock.mockResolvedValueOnce(prefs('detailed'));
    const { useChatDetailStore, ensureChatDetailSubscription } =
      await loadStore();
    ensureChatDetailSubscription();
    await flush();
    expect(useChatDetailStore.getState().detail).toBe('detailed');

    // The broadcast is only a signal; the canonical read decides.
    loadPreferencesMock.mockResolvedValueOnce(prefs('compact'));
    broadcast(prefs('detailed'));
    await flush();
    expect(useChatDetailStore.getState().detail).toBe('compact');

    loadPreferencesMock.mockResolvedValueOnce(prefs('detailed'));
    broadcast(prefs('detailed'));
    await flush();
    expect(useChatDetailStore.getState().detail).toBe('detailed');
  });

  it('applies a change at once and keeps what main saved', async () => {
    loadPreferencesMock.mockResolvedValue(prefs('detailed'));
    const { useChatDetailStore, ensureChatDetailSubscription } =
      await loadStore();
    ensureChatDetailSubscription();
    await flush();
    let resolveSave: (value: PreferencesData) => void = () => undefined;
    savePreferencesMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    const saving = useChatDetailStore.getState().setDetail('compact');
    expect(useChatDetailStore.getState().detail).toBe('compact');
    expect(savePreferencesMock).toHaveBeenCalledWith({
      chatDetail: 'compact',
    });
    resolveSave(prefs('compact'));
    await saving;
    expect(useChatDetailStore.getState().detail).toBe('compact');
  });

  it('rolls back and rejects when the save fails', async () => {
    loadPreferencesMock.mockResolvedValue(prefs('detailed'));
    const { useChatDetailStore, ensureChatDetailSubscription } =
      await loadStore();
    ensureChatDetailSubscription();
    await flush();
    savePreferencesMock.mockRejectedValueOnce(new Error('disk full'));
    await expect(
      useChatDetailStore.getState().setDetail('compact'),
    ).rejects.toThrow('disk full');
    expect(useChatDetailStore.getState().detail).toBe('detailed');
  });

  it('does not let an older failed save undo a newer choice', async () => {
    loadPreferencesMock.mockResolvedValue(prefs('detailed'));
    const { useChatDetailStore, ensureChatDetailSubscription } =
      await loadStore();
    ensureChatDetailSubscription();
    await flush();
    let rejectFirst: (error: Error) => void = () => undefined;
    savePreferencesMock
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
      )
      .mockResolvedValueOnce(prefs('detailed'));
    const first = useChatDetailStore.getState().setDetail('compact');
    const second = useChatDetailStore.getState().setDetail('detailed');
    await second;
    // The canonical read that follows a stale failure agrees with main.
    loadPreferencesMock.mockResolvedValue(prefs('detailed'));
    rejectFirst(new Error('late failure'));
    await expect(first).rejects.toThrow('late failure');
    await flush();
    expect(useChatDetailStore.getState().detail).toBe('detailed');
  });

  it('keeps a pending choice when another sync reads before it commits', async () => {
    loadPreferencesMock.mockResolvedValueOnce(prefs('detailed'));
    const { useChatDetailStore, ensureChatDetailSubscription } =
      await loadStore();
    ensureChatDetailSubscription();
    await flush();
    let resolveSave: (value: PreferencesData) => void = () => undefined;
    savePreferencesMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    const saving = useChatDetailStore.getState().setDetail('compact');
    // Another window saves an unrelated preference; main has not committed
    // this save yet, so the read it triggers still says off.
    loadPreferencesMock.mockResolvedValueOnce(prefs('detailed'));
    broadcast(prefs('detailed'));
    await flush();
    expect(useChatDetailStore.getState().detail).toBe('compact');
    resolveSave(prefs('compact'));
    await saving;
    expect(useChatDetailStore.getState().detail).toBe('compact');
    // The save's own broadcast reads the committed value.
    loadPreferencesMock.mockResolvedValueOnce(prefs('compact'));
    broadcast(prefs('compact'));
    await flush();
    expect(useChatDetailStore.getState().detail).toBe('compact');
  });

  it('ignores a read that started before a save and lands after it', async () => {
    let resolveLoad: (value: PreferencesData) => void = () => undefined;
    loadPreferencesMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const { useChatDetailStore, ensureChatDetailSubscription } =
      await loadStore();
    ensureChatDetailSubscription();
    await flush();
    savePreferencesMock.mockResolvedValueOnce(prefs('compact'));
    await useChatDetailStore.getState().setDetail('compact');
    resolveLoad(prefs('detailed'));
    await flush();
    expect(useChatDetailStore.getState()).toMatchObject({
      detail: 'compact',
      hydrated: true,
    });
  });

  it('follows a load main recovered from an unreadable file', async () => {
    // `__error` marks a recovered read: main backed the file up and now
    // serves these values, so they are what the next save builds on.
    const recovered: PreferencesLoadResult = {
      ...prefs('detailed'),
      __error: {
        timestamp: '2026-10-15T00:00:00.000Z',
        reason: 'parse',
        message: 'Unexpected token',
        filePath: '/tmp/preferences.json',
      },
    };
    loadPreferencesMock.mockResolvedValueOnce(recovered);
    const { useChatDetailStore, ensureChatDetailSubscription } =
      await loadStore();
    ensureChatDetailSubscription();
    await flush();
    expect(useChatDetailStore.getState()).toMatchObject({
      detail: 'detailed',
      hydrated: true,
    });
  });
});

describe('chatDetail preference without a saved level', () => {
  it('reads the default when an older save has no level', async () => {
    jest.resetModules();
    const legacy = makeTestPreferences();
    delete legacy.chatDetail;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: jest.fn().mockResolvedValue(legacy),
        savePreferences: jest.fn(),
        onPreferencesSynced: (): (() => void) => () => undefined,
      },
    });
    const { useChatDetailStore, ensureChatDetailSubscription } =
      await import('../chatDetailStore');
    ensureChatDetailSubscription();
    await flush();
    expect(useChatDetailStore.getState().detail).toBe('recent');
  });
});
