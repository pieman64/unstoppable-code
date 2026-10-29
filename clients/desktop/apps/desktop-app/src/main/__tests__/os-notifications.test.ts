import {
  IPC_CHANNELS,
  type OsNotificationShowRequest,
  type OsNotificationShowResponse,
} from '@canopy/desktop-shared/types';

interface MockWindow {
  isDestroyed: jest.MockedFunction<() => boolean>;
  isMinimized: jest.MockedFunction<() => boolean>;
  restore: jest.MockedFunction<() => void>;
  show: jest.MockedFunction<() => void>;
  focus: jest.MockedFunction<() => void>;
}

type RegisteredHandler = (
  event: { sender: unknown },
  request: OsNotificationShowRequest,
) => OsNotificationShowResponse;

const mockFromWebContents = jest.fn<MockWindow | null, [unknown]>();
const mockSendToWindow = jest.fn<
  boolean,
  [MockWindow | null, string, ...unknown[]]
>(() => true);
const mockRegisterIpcHandler = jest.fn<void, [string, RegisteredHandler]>();
const mockNotificationListeners = new Map<
  string,
  (...args: unknown[]) => void
>();
const mockNotificationShow = jest.fn();
const mockNotificationOptions: Record<string, unknown>[] = [];

afterEach(() => {
  // The mock has no OS lifecycle. Close any successfully delivered fixture
  // so its real ten-minute notification-retention timer does not outlive Jest.
  mockNotificationListeners.get('close')?.();
  mockNotificationListeners.clear();
});

class MockNotification {
  static isSupported = jest.fn(() => true);

  constructor(options: Record<string, unknown>) {
    mockNotificationOptions.push(options);
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    mockNotificationListeners.set(event, listener);
  }

  show(): void {
    mockNotificationShow();
  }
}

const mockOpenExternal = jest.fn<Promise<void>, [string]>(() =>
  Promise.resolve(),
);
const mockRequestRecompute = jest.fn<void, []>();
const mockBroadcastSynced = jest.fn<void, [unknown]>();

jest.mock('electron', () => ({
  BrowserWindow: { fromWebContents: mockFromWebContents },
  Notification: MockNotification,
  shell: {
    openExternal: (url: string): Promise<void> => mockOpenExternal(url),
  },
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: mockSendToWindow,
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: mockRegisterIpcHandler,
}));

jest.mock('../notifications/campaigns/scheduler', () => ({
  requestActivationRecompute: (): void => mockRequestRecompute(),
}));

jest.mock('../lib/preferences-broadcast', () => ({
  broadcastPreferencesSynced: (data: unknown): void =>
    mockBroadcastSynced(data),
}));

const mockReadPreferences = jest.fn<Promise<unknown>, []>();
const mockWritePreferences = jest.fn<Promise<unknown>, [unknown]>();

// `updatePreferencesFile` takes an updater and applies it to whatever is on
// disk inside a serialized queue. The fake mirrors that: it hands the updater
// the current preferences and records the PARTIAL it returns, which is what
// makes a lost-update regression visible here rather than only in production.
jest.mock('../lib/preferences-store', () => ({
  updatePreferencesFile: async (
    updater: (current: unknown) => unknown,
  ): Promise<unknown> => {
    const current = await mockReadPreferences();
    return mockWritePreferences(updater(current));
  },
}));

import {
  enableOsNotificationsWithProbe,
  openOsNotificationSettings,
  registerOsNotificationHandlers,
  showOsNotification,
} from '../ipc/os-notifications';

function makeWindow(): MockWindow {
  return {
    isDestroyed: jest.fn(() => false),
    isMinimized: jest.fn(() => false),
    restore: jest.fn(),
    show: jest.fn(),
    focus: jest.fn(),
  };
}

describe('OS notification routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotificationListeners.clear();
    mockNotificationOptions.length = 0;
  });

  it('returns clicks to the renderer window that requested the notification', () => {
    const mainWindow = makeWindow();
    const appAdvisorWindow = makeWindow();
    const sender = { id: 'app-advisor-renderer' };
    mockFromWebContents.mockReturnValue(appAdvisorWindow);
    registerOsNotificationHandlers(() => mainWindow as never);

    const handler = mockRegisterIpcHandler.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.osNotificationShow,
    )?.[1];
    if (typeof handler !== 'function') {
      throw new Error('OS notification handler was not registered');
    }
    expect(
      handler(
        { sender },
        { id: 'advisor-done', title: 'Done', body: 'The task finished.' },
      ),
    ).toEqual({ shown: true });

    mockNotificationListeners.get('click')?.();
    expect(mockFromWebContents).toHaveBeenCalledWith(sender);
    expect(appAdvisorWindow.show).toHaveBeenCalledTimes(1);
    expect(appAdvisorWindow.focus).toHaveBeenCalledTimes(1);
    expect(mainWindow.show).not.toHaveBeenCalled();
    expect(mockSendToWindow).toHaveBeenCalledWith(
      appAdvisorWindow,
      IPC_CHANNELS.osNotificationClicked,
      { id: 'advisor-done' },
    );

    mockNotificationListeners.get('close')?.();
  });

  it('opens the app-specific notification settings destination', async () => {
    await openOsNotificationSettings();
    expect(mockOpenExternal).toHaveBeenCalledWith(
      process.platform === 'darwin'
        ? 'x-apple.systempreferences:com.apple.preference.notifications?id=com.canopy.ui'
        : 'ms-settings:notifications',
    );
  });
});

describe('OS notification sounds (CAN-3946)', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform });
  }

  function show(
    request: Partial<OsNotificationShowRequest>,
  ): Record<string, unknown> {
    mockNotificationOptions.length = 0;
    const response = showOsNotification(
      { id: 'sound-test', title: 'Title', body: 'Body', ...request },
      () => null,
    );
    expect(response).toEqual({ shown: true });
    const [options] = mockNotificationOptions;
    if (!options) throw new Error('Notification was not constructed');
    return options;
  }

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('plays the chosen Windows sound through the toast audio element', () => {
    setPlatform('win32');
    const options = show({ sound: 'Mail' });
    expect(options.silent).toBe(false);
    expect(options.sound).toBeUndefined();
    expect(options.toastXml).toContain(
      '<audio src="ms-winsoundevent:Notification.Mail"/>',
    );
    expect(options.toastXml).toContain('<text>Title</text>');
    expect(options.toastXml).toContain('<text>Body</text>');
  });

  it('escapes the title and body in the Windows toast', () => {
    setPlatform('win32');
    const options = show({
      sound: 'SMS',
      title: 'Tom & <Jerry>',
      body: 'He said "hi" & \'bye\'',
    });
    expect(options.toastXml).toContain('<text>Tom &amp; &lt;Jerry&gt;</text>');
    expect(options.toastXml).toContain(
      '<text>He said &quot;hi&quot; &amp; &apos;bye&apos;</text>',
    );
  });

  it('drops characters XML forbids from the Windows toast', () => {
    setPlatform('win32');
    const options = show({
      sound: 'Mail',
      title: 'Build\u0000 done',
      body: '\u001b[32mok\u001b[0m \ud83d',
    });
    expect(options.toastXml).toContain('<text>Build done</text>');
    expect(options.toastXml).toContain('<text>[32mok[0m </text>');
  });

  it('keeps emoji and line breaks in the Windows toast', () => {
    setPlatform('win32');
    const options = show({ sound: 'Mail', body: 'Done \u{1F389}\nnext\tline' });
    expect(options.toastXml).toContain(
      '<text>Done \u{1F389}\nnext\tline</text>',
    );
  });

  it('uses the stock Windows toast when the sound is System', () => {
    setPlatform('win32');
    const options = show({});
    expect(options.silent).toBe(false);
    expect(options.toastXml).toBeUndefined();
    expect(options.sound).toBeUndefined();
  });

  it('keeps the Windows toast silent for None', () => {
    setPlatform('win32');
    const options = show({ silent: true, sound: 'Mail' });
    expect(options.silent).toBe(true);
    expect(options.toastXml).toBeUndefined();
  });

  it('ignores a macOS sound name saved on Windows', () => {
    setPlatform('win32');
    const options = show({ sound: 'Bottle' });
    expect(options.silent).toBe(false);
    expect(options.sound).toBeUndefined();
    expect(options.toastXml).toBeUndefined();
  });

  it('still passes the macOS sound name to the notification on macOS', () => {
    setPlatform('darwin');
    const options = show({ sound: 'Glass' });
    expect(options.sound).toBe('Glass');
    expect(options.toastXml).toBeUndefined();
  });

  it('leaves the sound option as before on Linux', () => {
    setPlatform('linux');
    const options = show({ sound: 'Glass' });
    expect(options.sound).toBe('Glass');
    expect(options.toastXml).toBeUndefined();
  });

  it('ignores a Windows sound name saved on macOS', () => {
    setPlatform('darwin');
    const options = show({ sound: 'Mail' });
    expect(options.sound).toBeUndefined();
    expect(options.toastXml).toBeUndefined();
  });

  it('still shows the notification on a host it does not recognize', () => {
    setPlatform('freebsd');
    const options = show({ sound: 'Glass' });
    expect(options.sound).toBe('Glass');
    expect(options.toastXml).toBeUndefined();
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('notification opt-in probe (CAN-2793)', () => {
  function preferences(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      osNotifications: { enabled: false, skipWhenFocused: true },
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotificationListeners.clear();
    mockReadPreferences.mockResolvedValue(preferences());
    mockWritePreferences.mockResolvedValue(undefined);
    MockNotification.isSupported.mockReturnValue(true);
  });

  /** Every preferences object the probe wrote, in order. */
  function writtenPreferences(): Record<string, unknown>[] {
    return mockWritePreferences.mock.calls
      .map(([data]) => data)
      .filter(isRecord);
  }

  /**
   * The probe reads and writes preferences before it posts, so the `failed`
   * listener does not exist for several microtask turns. Firing it early
   * silently did nothing and the probe then ran its full timeout and reported
   * success -- the test failed for a timing reason rather than a real one.
   */
  async function failedListener(): Promise<(...args: unknown[]) => void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const listener = mockNotificationListeners.get('failed');
      if (listener) return listener;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('notification never registered a failed listener');
  }

  it('turns the preference on and posts a notification to trigger the OS prompt', async () => {
    // Posting is not decoration: Electron has no permission API, so a real
    // post is the only thing that makes the OS ask.
    const result = await enableOsNotificationsWithProbe(() => null);

    const enabledWrite = writtenPreferences().find((data) => {
      const notifications = data['osNotifications'];
      return isRecord(notifications) && notifications['enabled'] === true;
    });
    expect(enabledWrite).toBeDefined();
    expect(mockNotificationShow).toHaveBeenCalled();
    expect(result).toEqual({ enabled: true, delivered: true });
  });

  it('reports an OS refusal instead of claiming success', async () => {
    const pending: Promise<unknown> = enableOsNotificationsWithProbe(
      () => null,
    );
    (await failedListener())({}, 'Error Domain=UNErrorDomain error 1');

    await expect(pending).resolves.toEqual({
      enabled: true,
      delivered: false,
      reason: 'os-denied',
    });
  });

  it('records the refusal durably so the blocked step survives a restart', async () => {
    const pending: Promise<unknown> = enableOsNotificationsWithProbe(
      () => null,
    );
    (await failedListener())({}, 'Error Domain=UNErrorDomain error 1');
    await pending;

    expect(
      writtenPreferences().some(
        (data) => typeof data['osNotificationsDeniedAt'] === 'string',
      ),
    ).toBe(true);
  });

  it('clears a previous refusal before probing, so the blocked row can recover', async () => {
    // The blocked row's only actions are "Open settings" and "Try again", and
    // Try again lands here. Without an up-front clear, a user who fixed the
    // permission and came back would stay blocked forever -- nothing else in
    // the app clears this marker.
    mockReadPreferences.mockResolvedValue(
      preferences({ osNotificationsDeniedAt: '2026-09-01T00:00:00.000Z' }),
    );

    await enableOsNotificationsWithProbe(() => null);

    // Explicit `undefined`, not an omitted key: the store merges a PARTIAL,
    // so omitting it would preserve the old value. An earlier version used
    // `delete` on a full snapshot, which the merge silently undid.
    expect(
      writtenPreferences().some(
        (data) =>
          'osNotificationsDeniedAt' in data &&
          data['osNotificationsDeniedAt'] === undefined,
      ),
    ).toBe(true);
  });

  it('re-arms the campaign scheduler', async () => {
    // `notifications-disabled` is EVENT_DRIVEN and never polled, and writing
    // the preference here bypasses applyPreferenceSideEffects -- so without
    // this a campaign already latched as suppressed stays dormant through the
    // very window this feature exists to hit.
    await enableOsNotificationsWithProbe(() => null);
    expect(mockRequestRecompute).toHaveBeenCalled();
  });

  it('records a refusal that arrives after the probe already answered', async () => {
    // Past the window the promise has settled, so routing the marker through
    // it dropped exactly the slow refusals this is meant to catch.
    const pending = enableOsNotificationsWithProbe(() => null);
    const failed = await failedListener();
    await pending;

    mockWritePreferences.mockClear();
    failed({}, 'Error Domain=UNErrorDomain error 1');
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      writtenPreferences().some(
        (data) => typeof data['osNotificationsDeniedAt'] === 'string',
      ),
    ).toBe(true);
  });

  it('tells the open window about a late refusal instead of waiting for focus', async () => {
    // updatePreferencesFile does not broadcast -- only the save IPC handler
    // does -- so without an explicit broadcast the marker is persisted and
    // the card stays stale until the next focus or remount.
    const pending = enableOsNotificationsWithProbe(() => null);
    const failed = await failedListener();
    await pending;

    // The write mock returns the merged result, because the renderer handler
    // dereferences `preferences.osNotifications.enabled` -- asserting only
    // that the broadcast fired would pass while handing it a payload that
    // would throw.
    mockWritePreferences.mockImplementation((partial: unknown) =>
      Promise.resolve({
        osNotifications: { enabled: true },
        ...(typeof partial === 'object' && partial !== null ? partial : {}),
      }),
    );
    mockBroadcastSynced.mockClear();
    failed({}, 'Error Domain=UNErrorDomain error 1');
    await new Promise((resolve) => setImmediate(resolve));

    const calls = mockBroadcastSynced.mock.calls;
    const payload: unknown = calls[calls.length - 1]?.[0];
    if (!isRecord(payload))
      throw new Error('broadcast payload was not an object');
    expect(typeof payload['osNotificationsDeniedAt']).toBe('string');
    expect(payload['osNotifications']).toEqual({ enabled: true });
  });

  it('does not blame the OS when notifications are unsupported', async () => {
    // 'unsupported' is not something a settings pane can fix, so it must not
    // route the user to one.
    MockNotification.isSupported.mockReturnValue(false);

    const result = await enableOsNotificationsWithProbe(() => null);

    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('unsupported');
    expect(
      writtenPreferences().some(
        (data) => typeof data['osNotificationsDeniedAt'] === 'string',
      ),
    ).toBe(false);
  });
});
