import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import { registerOpenInHandlers } from '../ipc/open-in';
import {
  detectInstalledApps,
  getDetectedAppLaunchSpec,
  refreshDetectedApps,
} from '../lib/app-detection';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  'platform',
);

jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof ChildProcessModule>('node:child_process'),
  spawn: jest.fn(),
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../lib/app-detection', () => ({
  detectInstalledApps: jest.fn(),
  getDetectedAppLaunchSpec: jest.fn(),
  refreshDetectedApps: jest.fn(),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));

jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
}));

jest.mock('../lib/paths', () => ({
  getWorkspaceWorktreeRepoDir: jest.fn(),
}));

jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));

class MockChildProcess extends EventEmitter {
  unref = jest.fn();
}

const mockedSpawn = jest.mocked(spawn);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedDetectInstalledApps = jest.mocked(detectInstalledApps);
const mockedGetDetectedAppLaunchSpec = jest.mocked(getDetectedAppLaunchSpec);
const mockedRefreshDetectedApps = jest.mocked(refreshDetectedApps);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
}

function getHandler(channel: string): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(([c]) => c === channel);
  if (!call) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return call[1] as HandlerFn;
}

describe('open-in IPC handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setPlatform('win32');
    mockedResolveWorktreeCwd.mockReturnValue('C:\\repo');
    mockedDetectInstalledApps.mockResolvedValue([
      {
        id: 'powershell',
        name: 'PowerShell',
        category: 'terminal',
        icon: '',
      },
    ]);
    mockedGetDetectedAppLaunchSpec.mockResolvedValue({
      id: 'powershell',
      name: 'PowerShell',
      command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"',
      args: ['-NoLogo', '-NoExit'],
      cwd: 'C:\\repo',
      shell: true,
    });
    mockedRefreshDetectedApps.mockResolvedValue([]);
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  it('launches Open In apps visibly and resolves after spawn on Windows', async () => {
    const child = new MockChildProcess();
    mockedSpawn.mockReturnValue(child as never);
    registerOpenInHandlers();

    const promise = getHandler(IPC_CHANNELS.worktreeOpenIn)(undefined, {
      projectId: 'project',
      worktreeId: 'worktree',
      appId: 'powershell',
    });
    await flush();

    expect(mockedSpawn).toHaveBeenCalledWith(
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"',
      ['-NoLogo', '-NoExit'],
      {
        cwd: 'C:\\repo',
        detached: true,
        shell: true,
        stdio: 'ignore',
        windowsHide: false,
      },
    );

    child.emit('spawn');
    await expect(promise).resolves.toBeUndefined();
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('rejects Open In for the read-only shared-container recipient scope', async () => {
    registerOpenInHandlers();

    await expect(
      getHandler(IPC_CHANNELS.worktreeOpenIn)(undefined, {
        projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        worktreeId: 'container',
        appId: 'powershell',
      }),
    ).rejects.toThrow('Shared-container recipient workspaces are read-only');

    expect(mockedResolveWorktreeCwd).not.toHaveBeenCalled();
    expect(mockedDetectInstalledApps).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });
});
