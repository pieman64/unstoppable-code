import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getEnhancedEnv,
  getLoginShellPath,
  prewarmLoginShellPath,
} from '@canopy/desktop-shared/pipelines/config-paths';
import {
  APP_LAUNCH_NO_LONGER_AVAILABLE_MESSAGE,
  IPC_CHANNELS,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import { registerOpenInHandlers } from '../ipc/open-in';
import {
  detectInstalledApps,
  getDetectedAppLaunchSpec,
} from '../lib/app-detection';
import type * as AppDetectionModule from '../lib/app-detection';

jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): 'linux' => 'linux',
}));
jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof ChildProcessModule>('node:child_process'),
  spawn: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getEnhancedEnv: jest.fn(),
  getLoginShellPath: jest.fn(),
  prewarmLoginShellPath: jest.fn(),
}));
jest.mock('electron', () => ({
  app: { getFileIcon: jest.fn() },
  nativeImage: { createFromBuffer: jest.fn(), createFromPath: jest.fn() },
}));
jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../lib/app-detection', () => ({
  detectInstalledApps: jest.fn(),
  getDetectedAppLaunchSpec: jest.fn(),
  refreshDetectedApps: jest.fn(),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (): string => '/repo with spaces',
}));
jest.mock('../lib/validation', () => ({ validateId: jest.fn() }));
jest.mock('../lib/read-only-scope', () => ({ assertWritableScope: jest.fn() }));
jest.mock('../lib/paths', () => ({ getWorkspaceWorktreeRepoDir: jest.fn() }));
jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));

class Child extends EventEmitter {
  unref = jest.fn();
}
const spec = {
  id: 'linux:code.desktop',
  name: 'Editor',
  command: '/usr/bin/code',
  args: ['/repo with spaces'],
  cwd: '/repo with spaces',
};

async function launch(): Promise<unknown> {
  registerOpenInHandlers();
  const handler = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.worktreeOpenIn,
    )?.[1];
  if (!handler) throw new Error('Missing handler');
  return await handler(undefined as never, {
    projectId: 'project',
    worktreeId: 'worktree',
    appId: spec.id,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getLoginShellPath).mockReturnValue('/login/bin:/usr/bin:/bin');
  jest.mocked(prewarmLoginShellPath).mockResolvedValue();
  jest.mocked(getEnhancedEnv).mockReturnValue({
    PATH: '/bundled/bin:/login/bin:/usr/bin:/bin',
    DISPLAY: ':37',
  });
  jest
    .mocked(detectInstalledApps)
    .mockResolvedValue([
      { id: spec.id, name: spec.name, icon: '', category: 'editor' },
    ]);
  jest.mocked(getDetectedAppLaunchSpec).mockResolvedValue(spec);
});

test('detaches external GUI process, ignores stdio and unreferences only after spawn', async () => {
  const child = new Child();
  jest.mocked(spawn).mockReturnValue(child as never);
  const result = launch();
  await new Promise(setImmediate);
  expect(spawn).toHaveBeenCalledWith(spec.command, spec.args, {
    cwd: spec.cwd,
    detached: true,
    shell: false,
    stdio: 'ignore',
    windowsHide: false,
    env: { PATH: '/login/bin:/usr/bin:/bin', DISPLAY: ':37' },
  });
  expect(getEnhancedEnv).toHaveBeenCalledWith({
    includeCanopySecrets: false,
    environment: false,
  });
  expect(child.unref).not.toHaveBeenCalled();
  child.emit('spawn');
  await expect(result).resolves.toBeUndefined();
  expect(child.unref).toHaveBeenCalledTimes(1);
  expect(() => child.emit('error', new Error('late error'))).not.toThrow();
});

const testPosix =
  jest
    .requireActual<{
      hostOperatingSystem: () => 'darwin' | 'linux' | 'win32' | null;
    }>('@canopy/core-platform/host-platform')
    .hostOperatingSystem() === 'win32'
    ? test.skip
    : test;

testPosix(
  'discovers a login-PATH-only env-shebang script and supplies that PATH to its child',
  async () => {
    const originalEnv = { ...process.env };
    const root = await mkdtemp(join(tmpdir(), 'linux-open-in-env-'));
    try {
      const bin = join(root, 'login bin with spaces');
      const user = join(root, 'user');
      const applications = join(user, 'applications');
      await mkdir(bin);
      await mkdir(applications, { recursive: true });
      const script = join(bin, 'code');
      await writeFile(script, '#!/usr/bin/env node\n', { mode: 0o700 });
      await writeFile(
        join(applications, 'code.desktop'),
        '[Desktop Entry]\nType=Application\nName=Editor\nCategories=TextEditor;\nTryExec=code\nExec=code %F\n',
      );
      process.env.PATH = '/usr/bin:/bin';
      process.env.XDG_DATA_HOME = user;
      process.env.XDG_DATA_DIRS = join(root, 'system');
      const loginPath = `${bin}:/usr/bin:/bin`;
      jest.mocked(getLoginShellPath).mockReturnValue(loginPath);
      const actualDetection = jest.requireActual<typeof AppDetectionModule>(
        '../lib/app-detection',
      );
      expect(await actualDetection.refreshDetectedApps()).toEqual([
        { id: spec.id, name: 'Editor', category: 'editor', icon: '' },
      ]);
      jest
        .mocked(detectInstalledApps)
        .mockImplementation(actualDetection.detectInstalledApps);
      jest
        .mocked(getDetectedAppLaunchSpec)
        .mockImplementation(actualDetection.getDetectedAppLaunchSpec);
      const child = new Child();
      jest.mocked(spawn).mockImplementation(() => {
        queueMicrotask(() => child.emit('spawn'));
        return child as never;
      });
      await launch();
      expect(process.env.PATH).toBe('/usr/bin:/bin');
      expect(spawn).toHaveBeenCalledWith(
        script,
        ['/repo with spaces'],
        expect.objectContaining({
          env: { DISPLAY: ':37', PATH: loginPath },
          shell: false,
          cwd: '/repo with spaces',
        }),
      );
      expect(getEnhancedEnv).toHaveBeenCalledWith({
        includeCanopySecrets: false,
        environment: false,
      });
      expect(child.unref).toHaveBeenCalledTimes(1);
    } finally {
      process.env = originalEnv;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('handles asynchronous spawn failure and synchronous spawn throw', async () => {
  const child = new Child();
  jest.mocked(spawn).mockReturnValue(child as never);
  const result = launch();
  const rejected = expect(result).rejects.toThrow('ENOENT');
  await new Promise(setImmediate);
  child.emit('error', new Error('ENOENT'));
  await rejected;
  expect(child.unref).not.toHaveBeenCalled();
  jest.mocked(spawn).mockImplementation(() => {
    throw new Error('sync spawn');
  });
  await expect(launch()).rejects.toThrow('sync spawn');
});

test.each([
  { ...spec, args: ['--no-sandbox'] },
  { ...spec, args: ['--no-sandbox=true'] },
  { ...spec, shell: true },
])('refuses unsafe Linux launch specs %#', async (unsafe) => {
  jest.mocked(getDetectedAppLaunchSpec).mockResolvedValue(unsafe);
  await expect(launch()).rejects.toThrow(
    APP_LAUNCH_NO_LONGER_AVAILABLE_MESSAGE,
  );
  expect(spawn).not.toHaveBeenCalled();
});

test('uses shared stale-application recovery message when entry disappears', async () => {
  jest.mocked(getDetectedAppLaunchSpec).mockResolvedValue(undefined);
  await expect(launch()).rejects.toThrow(
    APP_LAUNCH_NO_LONGER_AVAILABLE_MESSAGE,
  );
  expect(spawn).not.toHaveBeenCalled();
});
