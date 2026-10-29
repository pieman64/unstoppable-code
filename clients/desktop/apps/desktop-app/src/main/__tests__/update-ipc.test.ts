jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../updater', () => ({
  checkForVersion: jest.fn(),
  checkForUpdates: jest.fn(),
  downloadUpdate: jest.fn(),
  installUpdate: jest.fn(),
  listTargetUpdateVersions: jest.fn(),
  scheduleUpdate: jest.fn(),
  cancelScheduledUpdate: jest.fn(),
  reportRendererBusyState: jest.fn(),
  getUpdateState: jest.fn(),
}));

const mockedAppGetVersion = jest.fn(() => '1.2.3');

jest.mock('electron', () => ({
  app: {
    getVersion: mockedAppGetVersion,
  },
}));

import { IPC_CHANNELS, type UpdateState } from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import { registerUpdateHandlers } from '../ipc/update';
import { isE2eBuild } from '../lib/e2e-gate';

jest.mock('../lib/e2e-gate', () => ({ isE2eBuild: jest.fn(() => false) }));
import {
  cancelScheduledUpdate,
  checkForVersion,
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  installUpdate,
  listTargetUpdateVersions,
  scheduleUpdate,
  reportRendererBusyState,
} from '../updater';

declare global {
  var __CANOPY_RELEASE_FLAVOR__: string | undefined;
  var __CANOPY_INTERNAL_RELEASE_INDICATOR__: string | undefined;
}

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedCheckForVersion = jest.mocked(checkForVersion);
const mockedCheckForUpdates = jest.mocked(checkForUpdates);
const mockedDownloadUpdate = jest.mocked(downloadUpdate);
const mockedInstallUpdate = jest.mocked(installUpdate);
const mockedListTargetUpdateVersions = jest.mocked(listTargetUpdateVersions);
const mockedInstallUpdateWhenIdle = jest.mocked(scheduleUpdate);
const mockedCancelInstallWhenIdle = jest.mocked(cancelScheduledUpdate);
const mockedReportRendererBusyState = jest.mocked(reportRendererBusyState);
const mockedGetUpdateState = jest.mocked(getUpdateState);

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );

  if (!call) {
    throw new Error(`No handler registered for ${channel}`);
  }

  return call[1] as HandlerFn;
}

describe('registerUpdateHandlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(isE2eBuild).mockReturnValue(false);
    delete process.env.CANOPY_E2E_APP_VERSION;
    globalThis.__CANOPY_RELEASE_FLAVOR__ = 'stable';
    globalThis.__CANOPY_INTERNAL_RELEASE_INDICATOR__ = '';
    mockedAppGetVersion.mockReturnValue('1.2.3');
    registerUpdateHandlers();
  });

  afterEach(() => {
    delete process.env.CANOPY_E2E_APP_VERSION;
  });

  it.each(['stable', 'rc', 'internal'])(
    'honors a trimmed version override only in an E2E %s build',
    async (flavor) => {
      globalThis.__CANOPY_RELEASE_FLAVOR__ = flavor;
      jest.mocked(isE2eBuild).mockReturnValue(true);
      process.env.CANOPY_E2E_APP_VERSION = '  99.0.0-rc.2  ';
      expect(await getHandler(IPC_CHANNELS.updateGetVersion)()).toBe(
        '99.0.0-rc.2',
      );
      expect(mockedAppGetVersion).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '', '   '])(
    'ignores an empty E2E override %p',
    async (value) => {
      jest.mocked(isE2eBuild).mockReturnValue(true);
      if (value !== undefined) process.env.CANOPY_E2E_APP_VERSION = value;
      expect(await getHandler(IPC_CHANNELS.updateGetVersion)()).toBe('1.2.3');
    },
  );

  it('ignores the runtime override in a production build', async () => {
    process.env.CANOPY_E2E_APP_VERSION = '99.0.0';
    expect(await getHandler(IPC_CHANNELS.updateGetVersion)()).toBe('1.2.3');
    globalThis.__CANOPY_RELEASE_FLAVOR__ = 'internal';
    globalThis.__CANOPY_INTERNAL_RELEASE_INDICATOR__ = 'internal-123';
    expect(await getHandler(IPC_CHANNELS.updateGetVersion)()).toBe(
      'internal-123',
    );
  });

  it('registers stable update IPC channels without targeted version handlers', () => {
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.updateCheck,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).not.toHaveBeenCalledWith(
      IPC_CHANNELS.updateCheckVersion,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).not.toHaveBeenCalledWith(
      IPC_CHANNELS.updateListVersions,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.updateDownload,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.updateInstall,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.updateSchedule,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.updateCancelScheduled,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.updateReportBusy,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.updateGetVersion,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.updateGetDependencyVersions,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.updateGetState,
      expect.any(Function),
    );
  });

  it('registers targeted version handlers for internal builds', async () => {
    mockedRegisterIpcHandler.mockClear();
    globalThis.__CANOPY_RELEASE_FLAVOR__ = 'internal';

    registerUpdateHandlers();

    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.updateCheckVersion,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.updateListVersions,
      expect.any(Function),
    );

    await getHandler(IPC_CHANNELS.updateCheckVersion)(
      {},
      { tag: 'internal-1' },
    );
    await getHandler(IPC_CHANNELS.updateListVersions)({}, { query: '124' });

    expect(mockedCheckForVersion).toHaveBeenCalledWith({ tag: 'internal-1' });
    expect(mockedListTargetUpdateVersions).toHaveBeenCalledWith({
      query: '124',
    });
  });

  it('delegates update actions to the updater service', async () => {
    await getHandler(IPC_CHANNELS.updateCheck)();
    await getHandler(IPC_CHANNELS.updateDownload)();
    await getHandler(IPC_CHANNELS.updateInstall)();
    await getHandler(IPC_CHANNELS.updateSchedule)();
    await getHandler(IPC_CHANNELS.updateCancelScheduled)();
    await getHandler(IPC_CHANNELS.updateReportBusy)({}, true);

    expect(mockedCheckForUpdates).toHaveBeenCalledTimes(1);
    expect(mockedDownloadUpdate).toHaveBeenCalledTimes(1);
    expect(mockedInstallUpdate).toHaveBeenCalledTimes(1);
    expect(mockedInstallUpdateWhenIdle).toHaveBeenCalledTimes(1);
    expect(mockedCancelInstallWhenIdle).toHaveBeenCalledTimes(1);
    expect(mockedReportRendererBusyState).toHaveBeenCalledWith(true);
  });

  it('returns the app version through IPC', async () => {
    const result = await getHandler(IPC_CHANNELS.updateGetVersion)();

    expect(result).toBe('1.2.3');
    expect(mockedAppGetVersion).toHaveBeenCalledTimes(1);
  });

  it('returns the internal release indicator through IPC for internal builds', async () => {
    globalThis.__CANOPY_RELEASE_FLAVOR__ = 'internal';
    globalThis.__CANOPY_INTERNAL_RELEASE_INDICATOR__ = 'internal-123';
    mockedAppGetVersion.mockReturnValue('9999.0.0-internal.123');

    const result = await getHandler(IPC_CHANNELS.updateGetVersion)();

    expect(result).toBe('internal-123');
    expect(mockedAppGetVersion).toHaveBeenCalledTimes(1);
  });

  it('returns build-time dependency versions', async () => {
    const result = await getHandler(IPC_CHANNELS.updateGetDependencyVersions)();

    expect(result).toEqual({
      claudeCli: '1.0.0',
      claudeSdk: '^0.1.0',
      codexCli: '2.0.0',
      ghCli: '3.0.0',
      rtkCli: '0.37.2',
      octokit: '^4.0.0',
    });
  });

  it('returns the current update snapshot', async () => {
    const snapshot: UpdateState = {
      phase: 'available',
      info: { version: '1.2.3', releaseNotes: null },
    };
    mockedGetUpdateState.mockReturnValue(snapshot);

    const result = await getHandler(IPC_CHANNELS.updateGetState)();

    expect(result).toEqual(snapshot);
  });

  it('preserves updater refusal through every installer IPC', async () => {
    const failure = new Error('Linux updates must be installed manually.');
    mockedDownloadUpdate.mockRejectedValueOnce(failure);
    mockedInstallUpdate.mockRejectedValueOnce(failure);
    mockedInstallUpdateWhenIdle.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(getHandler(IPC_CHANNELS.updateDownload)()).rejects.toThrow(
      failure,
    );
    await expect(getHandler(IPC_CHANNELS.updateInstall)()).rejects.toThrow(
      failure,
    );
    await expect(
      Promise.resolve().then(() => getHandler(IPC_CHANNELS.updateSchedule)()),
    ).rejects.toThrow(failure);
    expect(await getHandler(IPC_CHANNELS.updateGetVersion)()).toBe('1.2.3');
  });
});
