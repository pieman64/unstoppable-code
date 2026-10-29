let mockIsE2eBuild = false;
jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => mockIsE2eBuild,
}));

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchAtLoginStatus } from '@canopy/desktop-shared/types';
import {
  createE2eLoginItemRegistrar,
  getLaunchAtLoginService,
  initializeLaunchAtLoginService,
  LaunchAtLoginService,
  resetLaunchAtLoginServiceForTests,
  type LaunchAtLoginServiceOptions,
  type LoginItemRegistrar,
  type LoginItemSnapshot,
  type LoginItemWrite,
} from '../lifecycle/launch-at-login';

interface FakeRegistrar extends LoginItemRegistrar {
  state: LoginItemSnapshot;
  writes: LoginItemWrite[];
  /** Drop writes on the floor, the way an OS that refused would. */
  refuse: boolean;
  /** macOS 13+: a new registration waits for the user in System Settings. */
  requireApproval: boolean;
}

function fakeRegistrar(
  initial: Partial<LoginItemSnapshot> = {},
): FakeRegistrar {
  const fake: FakeRegistrar = {
    state: { openAtLogin: false, ...initial },
    writes: [],
    refuse: false,
    requireApproval: false,
    getLoginItemSettings: (): LoginItemSnapshot => ({ ...fake.state }),
    setLoginItemSettings: (settings): void => {
      fake.writes.push({ ...settings });
      if (fake.refuse) return;
      fake.state = {
        ...fake.state,
        openAtLogin: settings.openAtLogin,
        ...(fake.state.status !== undefined
          ? {
              status: settings.openAtLogin
                ? fake.requireApproval
                  ? 'requires-approval'
                  : 'enabled'
                : 'not-registered',
            }
          : {}),
        ...(fake.state.executableWillLaunchAtLogin !== undefined
          ? {
              executableWillLaunchAtLogin:
                settings.openAtLogin && settings.enabled !== false,
            }
          : {}),
      };
    },
  };
  return fake;
}

function createService(
  overrides: Partial<LaunchAtLoginServiceOptions> & {
    registrar: LoginItemRegistrar;
  },
): {
  service: LaunchAtLoginService;
  pushes: LaunchAtLoginStatus[];
  opened: string[];
} {
  const pushes: LaunchAtLoginStatus[] = [];
  const opened: string[] = [];
  const service = new LaunchAtLoginService({
    platform: 'darwin',
    isPackaged: true,
    openExternal: (url): Promise<void> => {
      opened.push(url);
      return Promise.resolve();
    },
    onStatusChanged: (status): void => {
      pushes.push(status);
    },
    ...overrides,
  });
  return { service, pushes, opened };
}

describe('LaunchAtLoginService status', () => {
  it('reports enabled when macOS says the main app service is enabled', async () => {
    const { service } = createService({
      registrar: fakeRegistrar({ openAtLogin: true, status: 'enabled' }),
    });
    await expect(service.getStatus()).resolves.toEqual({
      platform: 'darwin',
      supported: true,
      enabled: true,
      pendingApproval: false,
    });
  });

  it('reports off for a registration macOS can no longer find', async () => {
    // The bundle moved after it was registered: the OS still has a record,
    // but it will not open anything at sign-in.
    const { service } = createService({
      registrar: fakeRegistrar({ openAtLogin: true, status: 'not-found' }),
    });
    await expect(service.getStatus()).resolves.toMatchObject({
      enabled: false,
      pendingApproval: false,
    });
  });

  it('reports a registration waiting for the user as pending approval', async () => {
    const { service } = createService({
      registrar: fakeRegistrar({
        openAtLogin: true,
        status: 'requires-approval',
      }),
    });
    await expect(service.getStatus()).resolves.toMatchObject({
      enabled: false,
      pendingApproval: true,
    });
  });

  it('falls back to openAtLogin when macOS reports no status', async () => {
    const { service } = createService({
      registrar: fakeRegistrar({ openAtLogin: true }),
    });
    await expect(service.getStatus()).resolves.toMatchObject({
      enabled: true,
    });
  });

  it('honors the Windows Startup apps switch over the run key', async () => {
    // Task Manager → Startup apps → Disable leaves the run key in place.
    const { service } = createService({
      platform: 'win32',
      registrar: fakeRegistrar({
        openAtLogin: true,
        executableWillLaunchAtLogin: false,
      }),
    });
    await expect(service.getStatus()).resolves.toEqual({
      platform: 'win32',
      supported: true,
      enabled: false,
      pendingApproval: false,
    });
  });

  it('never reports pending approval on Windows', async () => {
    const { service } = createService({
      platform: 'win32',
      registrar: fakeRegistrar({
        openAtLogin: true,
        status: 'requires-approval',
        executableWillLaunchAtLogin: true,
      }),
    });
    await expect(service.getStatus()).resolves.toMatchObject({
      enabled: true,
      pendingApproval: false,
    });
  });

  it('is unsupported on Linux without asking the OS', async () => {
    const registrar = fakeRegistrar();
    const read = jest.spyOn(registrar, 'getLoginItemSettings');
    const { service } = createService({ platform: 'linux', registrar });
    await expect(service.getStatus()).resolves.toEqual({
      platform: 'linux',
      supported: false,
      unsupportedReason: 'platform',
      enabled: false,
      pendingApproval: false,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('is unsupported in an unpackaged build without asking the OS', async () => {
    const registrar = fakeRegistrar({ openAtLogin: true, status: 'enabled' });
    const read = jest.spyOn(registrar, 'getLoginItemSettings');
    const { service } = createService({ isPackaged: false, registrar });
    await expect(service.getStatus()).resolves.toEqual({
      platform: 'darwin',
      supported: false,
      unsupportedReason: 'development-build',
      enabled: false,
      pendingApproval: false,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('lets a host override stand in for the process platform and packaging', async () => {
    const { service } = createService({
      platform: 'darwin',
      isPackaged: false,
      resolveHost: () =>
        Promise.resolve({ platform: 'win32', isPackaged: true }),
      registrar: fakeRegistrar({
        openAtLogin: true,
        executableWillLaunchAtLogin: true,
      }),
    });
    await expect(service.getStatus()).resolves.toEqual({
      platform: 'win32',
      supported: true,
      enabled: true,
      pendingApproval: false,
    });
  });
});

describe('LaunchAtLoginService.setEnabled', () => {
  it('registers the main app on macOS and reads the result back', async () => {
    const registrar = fakeRegistrar({
      openAtLogin: false,
      status: 'not-registered',
    });
    const { service, pushes } = createService({ registrar });
    const result = await service.setEnabled(true);
    expect(registrar.writes).toEqual([{ openAtLogin: true }]);
    expect(result).toEqual({
      ok: true,
      status: {
        platform: 'darwin',
        supported: true,
        enabled: true,
        pendingApproval: false,
      },
    });
    expect(pushes).toEqual([result.status]);
  });

  it('re-registers a registration macOS lost after the app moved', async () => {
    const registrar = fakeRegistrar({ openAtLogin: true, status: 'not-found' });
    const { service } = createService({ registrar });
    const result = await service.setEnabled(true);
    expect(registrar.writes).toEqual([{ openAtLogin: true }]);
    expect(result.ok).toBe(true);
    expect(result.status.enabled).toBe(true);
  });

  it('accepts a turn-on that now waits for approval in System Settings', async () => {
    const registrar = fakeRegistrar({
      openAtLogin: false,
      status: 'not-registered',
    });
    registrar.requireApproval = true;
    const { service } = createService({ registrar });
    const result = await service.setEnabled(true);
    expect(result).toEqual({
      ok: true,
      status: {
        platform: 'darwin',
        supported: true,
        enabled: false,
        pendingApproval: true,
      },
    });
  });

  it('turns off a registration that was still waiting for approval', async () => {
    const registrar = fakeRegistrar({
      openAtLogin: true,
      status: 'requires-approval',
    });
    const { service } = createService({ registrar });
    const result = await service.setEnabled(false);
    expect(registrar.writes).toEqual([{ openAtLogin: false }]);
    expect(result).toMatchObject({
      ok: true,
      status: { enabled: false, pendingApproval: false },
    });
  });

  it('reports refused when macOS keeps a pending registration after turning it off', async () => {
    const registrar = fakeRegistrar({
      openAtLogin: true,
      status: 'requires-approval',
    });
    registrar.refuse = true;
    const { service, pushes } = createService({ registrar });
    const result = await service.setEnabled(false);
    expect(result).toEqual({
      ok: false,
      reason: 'refused',
      status: {
        platform: 'darwin',
        supported: true,
        enabled: false,
        pendingApproval: true,
      },
    });
    expect(pushes).toEqual([result.status]);
  });

  it('reports refused when the read-back does not match the request', async () => {
    const registrar = fakeRegistrar({
      openAtLogin: false,
      status: 'not-registered',
    });
    registrar.refuse = true;
    const { service, pushes } = createService({ registrar });
    const result = await service.setEnabled(true);
    expect(result).toEqual({
      ok: false,
      reason: 'refused',
      status: {
        platform: 'darwin',
        supported: true,
        enabled: false,
        pendingApproval: false,
      },
    });
    // Every surface still hears the honest read-back.
    expect(pushes).toEqual([result.status]);
  });

  it('reports refused when the OS call throws', async () => {
    const registrar = fakeRegistrar({
      openAtLogin: false,
      status: 'not-registered',
    });
    registrar.setLoginItemSettings = (): void => {
      throw new Error('SMAppService register failed');
    };
    const { service } = createService({ registrar });
    await expect(service.setEnabled(true)).resolves.toMatchObject({
      ok: false,
      reason: 'refused',
      status: { enabled: false },
    });
  });

  it('writes the Startup apps switch together with the run key on Windows', async () => {
    const registrar = fakeRegistrar({
      openAtLogin: true,
      executableWillLaunchAtLogin: false,
    });
    const { service } = createService({ platform: 'win32', registrar });
    const result = await service.setEnabled(true);
    expect(registrar.writes).toEqual([{ openAtLogin: true, enabled: true }]);
    expect(result).toMatchObject({ ok: true, status: { enabled: true } });

    await service.setEnabled(false);
    expect(registrar.writes[1]).toEqual({ openAtLogin: false, enabled: false });
  });

  it('reports refused on Windows when the Startup apps switch stays off', async () => {
    const registrar = fakeRegistrar({
      openAtLogin: false,
      executableWillLaunchAtLogin: false,
    });
    registrar.setLoginItemSettings = (settings): void => {
      registrar.writes.push({ ...settings });
      // The run key lands, but a policy keeps the entry disabled.
      registrar.state = {
        openAtLogin: true,
        executableWillLaunchAtLogin: false,
      };
    };
    const { service } = createService({ platform: 'win32', registrar });
    await expect(service.setEnabled(true)).resolves.toMatchObject({
      ok: false,
      reason: 'refused',
      status: { enabled: false },
    });
  });

  it('never writes to the OS when unsupported', async () => {
    const registrar = fakeRegistrar();
    const { service } = createService({ isPackaged: false, registrar });
    await expect(service.setEnabled(true)).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported',
      status: { supported: false, unsupportedReason: 'development-build' },
    });
    expect(registrar.writes).toEqual([]);
  });

  it('runs overlapping sets one after another', async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const registrar = fakeRegistrar({
      openAtLogin: false,
      status: 'not-registered',
    });
    const write = registrar.setLoginItemSettings.bind(registrar);
    registrar.setLoginItemSettings = async (settings): Promise<void> => {
      order.push(`start:${String(settings.openAtLogin)}`);
      if (settings.openAtLogin) await firstWrite;
      await write(settings);
      order.push(`end:${String(settings.openAtLogin)}`);
    };
    const { service } = createService({ registrar });
    const on = service.setEnabled(true);
    const off = service.setEnabled(false);
    await Promise.resolve();
    releaseFirst();
    const [onResult, offResult] = await Promise.all([on, off]);
    expect(order).toEqual([
      'start:true',
      'end:true',
      'start:false',
      'end:false',
    ]);
    expect(onResult.status.enabled).toBe(true);
    expect(offResult.status.enabled).toBe(false);
  });

  it('keeps serving sets after one of them fails', async () => {
    const registrar = fakeRegistrar({
      openAtLogin: false,
      status: 'not-registered',
    });
    const read = registrar.getLoginItemSettings.bind(registrar);
    let failNextRead = true;
    registrar.getLoginItemSettings = (): LoginItemSnapshot => {
      if (failNextRead) {
        failNextRead = false;
        throw new Error('status query failed');
      }
      return read();
    };
    const { service } = createService({ registrar });
    await expect(service.setEnabled(true)).rejects.toThrow(
      'status query failed',
    );
    await expect(service.setEnabled(true)).resolves.toMatchObject({
      ok: true,
    });
  });
});

describe('LaunchAtLoginService.openSystemSettings', () => {
  it('opens Login Items on macOS', async () => {
    const { service, opened } = createService({ registrar: fakeRegistrar() });
    await service.openSystemSettings();
    expect(opened).toEqual([
      'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
    ]);
  });

  it('opens Startup apps on Windows', async () => {
    const { service, opened } = createService({
      platform: 'win32',
      registrar: fakeRegistrar(),
    });
    await service.openSystemSettings();
    expect(opened).toEqual(['ms-settings:startupapps']);
  });

  it('follows the host override, so the Windows pane is reachable from the E2E fake', async () => {
    const { service, opened } = createService({
      platform: 'darwin',
      resolveHost: () =>
        Promise.resolve({ platform: 'win32', isPackaged: true }),
      registrar: fakeRegistrar(),
    });
    await service.openSystemSettings();
    expect(opened).toEqual(['ms-settings:startupapps']);
  });

  it('does nothing on Linux', async () => {
    const { service, opened } = createService({
      platform: 'linux',
      registrar: fakeRegistrar(),
    });
    await service.openSystemSettings();
    expect(opened).toEqual([]);
  });

  it('swallows a deep link the OS refuses to open', async () => {
    const { service } = createService({
      registrar: fakeRegistrar(),
      openExternal: (): Promise<void> =>
        Promise.reject(new Error('no handler')),
    });
    await expect(service.openSystemSettings()).resolves.toBeUndefined();
  });
});

describe('createE2eLoginItemRegistrar', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'launch-at-login-e2e-'));
    file = join(dir, 'state.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function readState(): Promise<Record<string, unknown>> {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {};
  }

  it('starts unregistered on the host platform when the file is missing', async () => {
    const fake = createE2eLoginItemRegistrar(file, 'darwin');
    await expect(fake.resolveHost()).resolves.toEqual({
      platform: 'darwin',
      isPackaged: true,
    });
    await expect(fake.registrar.getLoginItemSettings()).resolves.toEqual({
      openAtLogin: false,
      status: 'not-registered',
    });
  });

  it('impersonates the platform the file names', async () => {
    await writeFile(
      file,
      JSON.stringify({
        platform: 'win32',
        openAtLogin: true,
        executableWillLaunchAtLogin: false,
      }),
    );
    const fake = createE2eLoginItemRegistrar(file, 'darwin');
    await expect(fake.resolveHost()).resolves.toEqual({
      platform: 'win32',
      isPackaged: true,
    });
    await expect(fake.registrar.getLoginItemSettings()).resolves.toEqual({
      openAtLogin: true,
      executableWillLaunchAtLogin: false,
    });
  });

  it('persists a macOS write so it survives a relaunch', async () => {
    await writeFile(
      file,
      JSON.stringify({
        platform: 'darwin',
        openAtLogin: false,
        status: 'not-registered',
      }),
    );
    const fake = createE2eLoginItemRegistrar(file, 'darwin');
    await fake.registrar.setLoginItemSettings({ openAtLogin: true });
    await expect(readState()).resolves.toMatchObject({
      platform: 'darwin',
      openAtLogin: true,
      status: 'enabled',
    });
    const relaunched = createE2eLoginItemRegistrar(file, 'darwin');
    await expect(relaunched.registrar.getLoginItemSettings()).resolves.toEqual({
      openAtLogin: true,
      status: 'enabled',
    });
  });

  it('persists a Windows write to both the run key and the switch', async () => {
    await writeFile(
      file,
      JSON.stringify({
        platform: 'win32',
        openAtLogin: true,
        executableWillLaunchAtLogin: false,
      }),
    );
    const fake = createE2eLoginItemRegistrar(file, 'darwin');
    await fake.registrar.setLoginItemSettings({
      openAtLogin: true,
      enabled: true,
    });
    await expect(readState()).resolves.toMatchObject({
      platform: 'win32',
      openAtLogin: true,
      executableWillLaunchAtLogin: true,
    });
  });

  it('ignores writes while refuseWrites is set', async () => {
    await writeFile(
      file,
      JSON.stringify({
        platform: 'darwin',
        openAtLogin: false,
        status: 'not-registered',
        refuseWrites: true,
      }),
    );
    const fake = createE2eLoginItemRegistrar(file, 'darwin');
    await fake.registrar.setLoginItemSettings({ openAtLogin: true });
    await expect(readState()).resolves.toMatchObject({
      openAtLogin: false,
      status: 'not-registered',
      refuseWrites: true,
    });
  });
});

describe('initializeLaunchAtLoginService', () => {
  const originalStateFile = process.env.CANOPY_E2E_LAUNCH_AT_LOGIN_STATE;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'launch-at-login-init-'));
    resetLaunchAtLoginServiceForTests();
  });

  afterEach(async () => {
    mockIsE2eBuild = false;
    if (originalStateFile === undefined) {
      delete process.env.CANOPY_E2E_LAUNCH_AT_LOGIN_STATE;
    } else {
      process.env.CANOPY_E2E_LAUNCH_AT_LOGIN_STATE = originalStateFile;
    }
    resetLaunchAtLoginServiceForTests();
    await rm(dir, { recursive: true, force: true });
  });

  function init(electronRegistrar: LoginItemRegistrar): void {
    initializeLaunchAtLoginService({
      electronRegistrar,
      platform: 'darwin',
      isPackaged: false,
      openExternal: (): Promise<void> => Promise.resolve(),
    });
  }

  it('drives the real OS seam outside the E2E build', async () => {
    process.env.CANOPY_E2E_LAUNCH_AT_LOGIN_STATE = join(dir, 'state.json');
    const electronRegistrar = fakeRegistrar({
      openAtLogin: true,
      status: 'enabled',
    });
    initializeLaunchAtLoginService({
      electronRegistrar,
      platform: 'darwin',
      isPackaged: true,
      openExternal: (): Promise<void> => Promise.resolve(),
    });
    await expect(getLaunchAtLoginService().getStatus()).resolves.toMatchObject({
      supported: true,
      enabled: true,
    });
  });

  it('keeps an unpackaged E2E build unsupported without a state file', async () => {
    mockIsE2eBuild = true;
    delete process.env.CANOPY_E2E_LAUNCH_AT_LOGIN_STATE;
    init(fakeRegistrar());
    await expect(getLaunchAtLoginService().getStatus()).resolves.toMatchObject({
      supported: false,
      unsupportedReason: 'development-build',
    });
  });

  it('swaps in the file-backed fake when the E2E state file is named', async () => {
    mockIsE2eBuild = true;
    const file = join(dir, 'state.json');
    await writeFile(
      file,
      JSON.stringify({ platform: 'win32', openAtLogin: true }),
    );
    process.env.CANOPY_E2E_LAUNCH_AT_LOGIN_STATE = file;
    const electronRegistrar = fakeRegistrar();
    init(electronRegistrar);
    await expect(getLaunchAtLoginService().getStatus()).resolves.toEqual({
      platform: 'win32',
      supported: true,
      enabled: true,
      pendingApproval: false,
    });
    await getLaunchAtLoginService().setEnabled(false);
    expect(electronRegistrar.writes).toEqual([]);
  });

  it('returns the live instance on a second call', () => {
    init(fakeRegistrar());
    const first = getLaunchAtLoginService();
    init(fakeRegistrar());
    expect(getLaunchAtLoginService()).toBe(first);
  });
});
