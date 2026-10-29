import type {
  GlobalFocusShortcutStatus,
  GlobalFocusShortcutUpdateResponse,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import type * as PreferencesStoreModule from '../lib/preferences-store';

const mockReadPreferencesFile = jest.fn<Promise<PreferencesData>, []>();
const mockUpdatePreferencesFile = jest.fn<
  Promise<PreferencesData>,
  [(current: PreferencesData) => Partial<PreferencesData>]
>();
const mockBroadcastPreferencesSynced = jest.fn<void, [PreferencesData]>();
const mockRegisterIpcHandler = jest.fn<void, unknown[]>();
const mockApply = jest.fn<
  GlobalFocusShortcutUpdateResponse,
  [{ enabled: boolean; accelerator: string }]
>();
const mockGetStatus = jest.fn<GlobalFocusShortcutStatus, []>();
const mockGetActiveAccelerator = jest.fn<string | null, []>();

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<PreferencesData> =>
    mockReadPreferencesFile(),
  updatePreferencesFile: (
    updater: (current: PreferencesData) => Partial<PreferencesData>,
  ): Promise<PreferencesData> => mockUpdatePreferencesFile(updater),
}));
jest.mock('../lib/preferences-broadcast', () => ({
  broadcastPreferencesSynced: (normalized: PreferencesData): void =>
    mockBroadcastPreferencesSynced(normalized),
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (...args: unknown[]): void => {
    mockRegisterIpcHandler(...args);
  },
}));
interface ServiceMock {
  apply: typeof mockApply;
  getStatus: typeof mockGetStatus;
  getActiveAccelerator: typeof mockGetActiveAccelerator;
}
jest.mock('../lifecycle/global-focus-shortcut', () => ({
  getGlobalFocusShortcutService: (): ServiceMock => ({
    apply: mockApply,
    getStatus: mockGetStatus,
    getActiveAccelerator: mockGetActiveAccelerator,
  }),
  tryGetGlobalFocusShortcutService: (): ServiceMock => ({
    apply: mockApply,
    getStatus: mockGetStatus,
    getActiveAccelerator: mockGetActiveAccelerator,
  }),
}));

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  handleGetGlobalFocusShortcutStatus,
  handleUpdateGlobalFocusShortcut,
  registerGlobalFocusShortcutHandlers,
  syncGlobalFocusShortcutFromPreferences,
} from '../ipc/global-focus-shortcut';

const DEFAULT = 'CommandOrControl+Shift+O';
const OTHER = 'CommandOrControl+Shift+P';

function status(
  overrides: Partial<GlobalFocusShortcutStatus> = {},
): GlobalFocusShortcutStatus {
  return {
    enabled: false,
    accelerator: DEFAULT,
    registered: false,
    platform: 'darwin',
    ...overrides,
  };
}

// The real defaults (the store module itself is mocked above) so the fixture
// is a complete `PreferencesData` without a type assertion.
const { DEFAULT_PREFERENCES } = jest.requireActual<
  typeof PreferencesStoreModule
>('../lib/preferences-store');

function savedPreferences(
  overrides: Partial<PreferencesData> = {},
): PreferencesData {
  return {
    ...DEFAULT_PREFERENCES,
    globalFocusShortcutEnabled: false,
    globalFocusShortcut: DEFAULT,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReadPreferencesFile.mockResolvedValue(savedPreferences());
  mockUpdatePreferencesFile.mockImplementation((updater) => {
    const current = savedPreferences();
    return Promise.resolve({ ...current, ...updater(current) });
  });
  mockGetStatus.mockReturnValue(status());
  mockGetActiveAccelerator.mockReturnValue(null);
});

describe('handleGetGlobalFocusShortcutStatus', () => {
  it('returns the live service status', () => {
    const live = status({ enabled: true, registered: true });
    mockGetStatus.mockReturnValue(live);
    expect(handleGetGlobalFocusShortcutStatus()).toBe(live);
  });
});

describe('handleUpdateGlobalFocusShortcut', () => {
  it('persists and broadcasts once the OS accepted the new config', async () => {
    const applied = status({ enabled: true, registered: true });
    mockApply.mockReturnValue({ ok: true, status: applied });

    const result = await handleUpdateGlobalFocusShortcut({ enabled: true });

    expect(mockApply).toHaveBeenCalledWith({
      enabled: true,
      accelerator: DEFAULT,
    });
    expect(mockUpdatePreferencesFile).toHaveBeenCalledTimes(1);
    const updater = mockUpdatePreferencesFile.mock.calls[0]?.[0];
    expect(updater?.(savedPreferences())).toEqual({
      globalFocusShortcutEnabled: true,
      globalFocusShortcut: DEFAULT,
    });
    expect(mockBroadcastPreferencesSynced).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, status: applied });
  });

  it('keeps the saved config when the OS refuses the new chord', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      savedPreferences({ globalFocusShortcutEnabled: true }),
    );
    const restored = status({ enabled: true, registered: true });
    mockApply
      .mockReturnValueOnce({
        ok: false,
        reason: 'in-use',
        accelerator: OTHER,
        status: status({
          enabled: true,
          accelerator: OTHER,
          failure: 'in-use',
        }),
      })
      .mockReturnValueOnce({ ok: true, status: restored });

    const result = await handleUpdateGlobalFocusShortcut({
      accelerator: OTHER,
    });

    // Try the new chord, then re-apply the saved one so the reported status
    // matches what is actually persisted and registered.
    expect(mockApply.mock.calls).toEqual([
      [{ enabled: true, accelerator: OTHER }],
      [{ enabled: true, accelerator: DEFAULT }],
    ]);
    expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
    expect(mockBroadcastPreferencesSynced).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      reason: 'in-use',
      accelerator: OTHER,
      status: restored,
    });
  });

  it('persists the enable intent when the saved chord itself is refused', async () => {
    // Turning the toggle on with a chord another app holds has no prior
    // working binding to protect. Saving `enabled: true` keeps the user's
    // decision and leaves the status (and the checklist row) in the
    // recoverable "blocked" state instead of silently snapping back to off.
    const blocked = status({
      enabled: true,
      registered: false,
      failure: 'in-use',
    });
    mockApply.mockReturnValueOnce({
      ok: false,
      reason: 'in-use',
      accelerator: DEFAULT,
      status: blocked,
    });

    const result = await handleUpdateGlobalFocusShortcut({ enabled: true });

    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockUpdatePreferencesFile).toHaveBeenCalledTimes(1);
    const updater = mockUpdatePreferencesFile.mock.calls[0]?.[0];
    expect(updater?.(savedPreferences())).toEqual({
      globalFocusShortcutEnabled: true,
      globalFocusShortcut: DEFAULT,
    });
    expect(mockBroadcastPreferencesSynced).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      reason: 'in-use',
      accelerator: DEFAULT,
      status: blocked,
    });
  });

  it('restores the saved config when persisting the accepted chord fails', async () => {
    // Otherwise this process runs an unsaved chord while the next launch
    // re-applies the old one: live and persisted state diverge.
    mockApply.mockReturnValue({
      ok: true,
      status: status({ enabled: true, accelerator: OTHER, registered: true }),
    });
    mockUpdatePreferencesFile.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      handleUpdateGlobalFocusShortcut({ enabled: true, accelerator: OTHER }),
    ).rejects.toThrow('disk full');

    expect(mockApply.mock.calls).toEqual([
      [{ enabled: true, accelerator: OTHER }],
      [{ enabled: false, accelerator: DEFAULT }],
    ]);
  });

  it('resolves fields the request omits from the store state at write time', async () => {
    mockApply.mockReturnValue({
      ok: true,
      status: status({ enabled: false, accelerator: OTHER }),
    });

    await handleUpdateGlobalFocusShortcut({ accelerator: OTHER });

    const updater = mockUpdatePreferencesFile.mock.calls[0]?.[0];
    // A concurrent enable that landed between the read and this write must
    // survive: the updater reads `enabled` from `current`, not from the
    // earlier snapshot.
    expect(
      updater?.(savedPreferences({ globalFocusShortcutEnabled: true })),
    ).toEqual({ globalFocusShortcutEnabled: true, globalFocusShortcut: OTHER });
  });

  it('rolls back to the config on disk at refusal time, not the pre-read snapshot', async () => {
    // Update A (accepted, persisted) can land between this update's read and
    // its refusal; the rollback must restore A's chord, not the older one.
    const THIRD = 'CommandOrControl+Shift+K';
    mockReadPreferencesFile
      .mockResolvedValueOnce(
        savedPreferences({ globalFocusShortcutEnabled: true }),
      )
      .mockResolvedValueOnce(
        savedPreferences({
          globalFocusShortcutEnabled: true,
          globalFocusShortcut: OTHER,
        }),
      );
    mockApply
      .mockReturnValueOnce({
        ok: false,
        reason: 'in-use',
        accelerator: THIRD,
        status: status({
          enabled: true,
          accelerator: THIRD,
          failure: 'in-use',
        }),
      })
      .mockReturnValueOnce({
        ok: true,
        status: status({ enabled: true, accelerator: OTHER, registered: true }),
      });

    await handleUpdateGlobalFocusShortcut({ accelerator: THIRD });

    expect(mockApply).toHaveBeenLastCalledWith({
      enabled: true,
      accelerator: OTHER,
    });
  });

  it('refuses an explicitly supplied invalid chord even while the shortcut is off', async () => {
    // The disabled branch of the service substitutes the default for a chord
    // it cannot keep; persisting that under `ok: true` would silently replace
    // a good saved chord.
    mockReadPreferencesFile.mockResolvedValue(
      savedPreferences({ globalFocusShortcut: OTHER }),
    );

    const result = await handleUpdateGlobalFocusShortcut({
      accelerator: 'Control+C',
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'reserved',
      accelerator: 'Control+C',
    });
    expect(mockApply).not.toHaveBeenCalled();
    expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
  });

  it('rejects a malformed request before touching the OS', async () => {
    const malformed: unknown = { accelerator: 42 };
    await expect(handleUpdateGlobalFocusShortcut(malformed)).rejects.toThrow(
      /accelerator/,
    );
    expect(mockApply).not.toHaveBeenCalled();
  });
});

describe('registerGlobalFocusShortcutHandlers', () => {
  it('registers the status and update channels', () => {
    registerGlobalFocusShortcutHandlers();
    const channels = mockRegisterIpcHandler.mock.calls.map((call) => call[0]);
    expect(channels).toEqual([
      IPC_CHANNELS.globalFocusShortcutGetStatus,
      IPC_CHANNELS.globalFocusShortcutUpdate,
    ]);
  });
});

describe('syncGlobalFocusShortcutFromPreferences', () => {
  it('re-persists the chord the service kept when a generic save wrote a refused one', async () => {
    // The generic `savePreferences` path persists before it applies. When the
    // OS refuses the just-saved chord the service restores the previous
    // working one, and the file must follow so the next launch does not come
    // up blocked on a chord that never worked.
    mockApply.mockReturnValueOnce({
      ok: false,
      reason: 'in-use',
      accelerator: OTHER,
      status: status({ enabled: true, accelerator: OTHER, failure: 'in-use' }),
    });
    mockGetActiveAccelerator.mockReturnValue(DEFAULT);

    await syncGlobalFocusShortcutFromPreferences(
      savedPreferences({
        globalFocusShortcutEnabled: true,
        globalFocusShortcut: OTHER,
      }),
    );

    expect(mockApply).toHaveBeenCalledWith({
      enabled: true,
      accelerator: OTHER,
    });
    const updater = mockUpdatePreferencesFile.mock.calls[0]?.[0];
    expect(updater?.(savedPreferences())).toEqual({
      globalFocusShortcut: DEFAULT,
    });
    expect(mockBroadcastPreferencesSynced).toHaveBeenCalledTimes(1);
    // The service is told about the restored file value so its status
    // matches what is persisted.
    expect(mockApply).toHaveBeenLastCalledWith({
      enabled: true,
      accelerator: DEFAULT,
    });
  });

  it('does not touch the file when the saved config was accepted or nothing was registered before', async () => {
    mockApply.mockReturnValueOnce({
      ok: true,
      status: status({ enabled: true, registered: true }),
    });
    await syncGlobalFocusShortcutFromPreferences(
      savedPreferences({ globalFocusShortcutEnabled: true }),
    );
    expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();

    mockApply.mockReturnValueOnce({
      ok: false,
      reason: 'in-use',
      accelerator: DEFAULT,
      status: status({ enabled: true, failure: 'in-use' }),
    });
    mockGetActiveAccelerator.mockReturnValue(null);
    await syncGlobalFocusShortcutFromPreferences(
      savedPreferences({ globalFocusShortcutEnabled: true }),
    );
    expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
  });
});
