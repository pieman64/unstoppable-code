import type { EventEmitter } from 'node:events';
import { ChildProcess, execFile } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import {
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { access, stat, realpath, readdir, mkdtemp, rm } from 'node:fs/promises';
import type * as FsPromisesModule from 'node:fs/promises';
import type * as GitExecutableModule from '../lib/git-executable';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { dialog } from 'electron';
import {
  IPC_CHANNELS,
  type GitExecutableStatus,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';

const getLoginShellPathMock = jest.fn(() => process.env.PATH ?? '');
const prewarmLoginShellPathMock = jest.fn<
  Promise<void>,
  [options?: { force?: boolean }]
>(() => Promise.resolve());
const probeEnvMock = jest.fn(
  (): Record<string, string> => ({ PATH: '/probe/bin', HOME: '/probe/home' }),
);
jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getLinuxProbeEnv: (): Record<string, string> => probeEnvMock(),
  getLoginShellPath: (): string => getLoginShellPathMock(),
  prewarmLoginShellPath: (options?: { force?: boolean }): Promise<void> =>
    prewarmLoginShellPathMock(options),
}));

jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof ChildProcessModule>('node:child_process'),
  execFile: jest.fn(),
}));

jest.mock('node:fs/promises', () => ({
  access: jest.fn(),
  stat: jest.fn(),
  realpath: jest.fn(),
  readdir: jest.fn(),
  mkdtemp: jest.fn(),
  rm: jest.fn(),
}));

jest.mock('electron', () => ({
  dialog: {
    showOpenDialog: jest.fn(),
  },
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

let preferences: { gitExecutablePath: string };
const mockWritePreferencesFile = jest.fn(
  (patch: { gitExecutablePath?: string }) => {
    if (typeof patch.gitExecutablePath === 'string') {
      preferences.gitExecutablePath = patch.gitExecutablePath;
    }
    return Promise.resolve();
  },
);

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() => Promise.resolve(preferences)),
  writePreferencesFile: mockWritePreferencesFile,
}));

const mockedExecFile = jest.mocked(execFile);
const mockedStat = jest.mocked(stat);
const mockedDialog = jest.mocked(dialog);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const actualStat =
  jest.requireActual<typeof FsPromisesModule>('node:fs/promises').stat;

const originalPlatform = process.platform;
const originalEnv = { ...process.env };
const globalWithE2EFlag = globalThis as typeof globalThis & {
  __CANOPY_E2E__: boolean;
};
const originalE2E = globalWithE2EFlag.__CANOPY_E2E__;
type ExecCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

function mockFile(): void {
  mockedStat.mockImplementation(() => actualStat(__filename));
}

function childWithOutput(stdout = '', stderr = ''): ChildProcess {
  const child = new ChildProcess();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  process.nextTick(() => {
    if (stdout) child.stdout.emit('data', stdout);
    if (stderr) child.stderr.emit('data', stderr);
  });
  return child;
}

function completeExec(
  error: Error | null,
  stdout = '',
  stderr = '',
): EventEmitter {
  const child = childWithOutput(stdout, stderr);
  process.nextTick(() => {
    const calls = mockedExecFile.mock.calls as unknown[][];
    const lastCall = calls[calls.length - 1];
    const callback = lastCall?.find(
      (entry): entry is ExecCallback => typeof entry === 'function',
    );
    if (typeof callback === 'function') {
      callback(error, stdout, stderr);
    }
  });
  return child;
}

beforeEach(() => {
  jest.clearAllMocks();
  preferences = { gitExecutablePath: '' };
  process.env = { ...originalEnv };
  delete process.env.CANOPY_GIT_EXECUTABLE;
  globalWithE2EFlag.__CANOPY_E2E__ = originalE2E;
  setPlatform('win32');
  mockFile();
});

afterAll(() => {
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  });
  process.env = originalEnv;
  globalWithE2EFlag.__CANOPY_E2E__ = originalE2E;
});

describe('git executable detection', () => {
  it('uses and publishes a valid cached path', async () => {
    preferences.gitExecutablePath = 'C:\\Program Files\\Git\\cmd\\git.exe';
    mockedExecFile.mockImplementation((...call) => {
      const command = call[0];
      const callback = call.find((entry) => typeof entry === 'function') as
        | ExecCallback
        | undefined;
      if (command === preferences.gitExecutablePath && callback) {
        callback(null, 'git version 2.51.0.windows.1\n', '');
      } else if (command === 'where.exe' && callback) {
        callback(new Error('not found'), '', '');
      }
      return childWithOutput();
    });

    const { detectGitExecutable } = await import('../lib/git-executable');
    const status = await detectGitExecutable();

    expect(status).toMatchObject({
      ready: true,
      path: preferences.gitExecutablePath,
      version: 'git version 2.51.0.windows.1',
      source: 'cache',
    });
    expect(process.env.CANOPY_GIT_EXECUTABLE).toBe(
      preferences.gitExecutablePath,
    );
  });

  it('clears an invalid cached path and auto-detects from where.exe', async () => {
    preferences.gitExecutablePath = 'C:\\bad\\git.exe';
    const detectedPath = 'C:\\Program Files\\Git\\cmd\\git.exe';
    mockedExecFile.mockImplementation((...call) => {
      const command = call[0];
      const args = call[1] as string[] | undefined;
      const callback = call.find((entry) => typeof entry === 'function') as
        | ExecCallback
        | undefined;
      if (command === preferences.gitExecutablePath && callback) {
        callback(null, 'not git\n', '');
      } else if (
        command === 'where.exe' &&
        args?.[0] === 'winget' &&
        callback
      ) {
        callback(null, '', '');
      } else if (command === 'where.exe' && args?.[0] === 'git' && callback) {
        callback(null, `${detectedPath}\n`, '');
      } else if (command === detectedPath && callback) {
        callback(null, 'git version 2.51.0.windows.1\n', '');
      }
      return childWithOutput();
    });

    const { detectGitExecutable } = await import('../lib/git-executable');
    const status = await detectGitExecutable();

    expect(status).toMatchObject({
      ready: true,
      path: detectedPath,
      source: 'auto-detected',
    });
    expect(mockWritePreferencesFile).toHaveBeenCalledWith({
      gitExecutablePath: '',
    });
    expect(mockWritePreferencesFile).toHaveBeenLastCalledWith({
      gitExecutablePath: detectedPath,
    });
  });

  it('clears an invalid cached path during forced redetection', async () => {
    preferences.gitExecutablePath = 'C:\\bad\\git.exe';
    mockedExecFile.mockImplementation((...call) => {
      const command = call[0];
      const callback = call.find((entry) => typeof entry === 'function') as
        | ExecCallback
        | undefined;
      if (command === preferences.gitExecutablePath && callback) {
        callback(null, 'not git\n', '');
      } else if (command === 'where.exe' && callback) {
        callback(new Error('not found'), '', '');
      }
      return childWithOutput();
    });
    mockedStat.mockRejectedValue(new Error('missing'));

    const { detectGitExecutable } = await import('../lib/git-executable');
    const status = await detectGitExecutable({ force: true });

    expect(status.ready).toBe(false);
    expect(mockWritePreferencesFile).toHaveBeenCalledWith({
      gitExecutablePath: '',
    });
    expect(preferences.gitExecutablePath).toBe('');
  });

  it('keeps a valid cached path during forced redetection', async () => {
    preferences.gitExecutablePath = 'D:\\PortableGit\\cmd\\git.exe';
    mockedExecFile.mockImplementation((...call) => {
      const command = call[0];
      const args = call[1] as string[] | undefined;
      const callback = call.find((entry) => typeof entry === 'function') as
        | ExecCallback
        | undefined;
      if (command === preferences.gitExecutablePath && callback) {
        callback(null, 'git version 2.51.0.windows.1\n', '');
      } else if (
        command === 'where.exe' &&
        args?.[0] === 'winget' &&
        callback
      ) {
        callback(new Error('not found'), '', '');
      } else if (command === 'where.exe' && args?.[0] === 'git' && callback) {
        callback(new Error('not found'), '', '');
      }
      return childWithOutput() as never;
    });

    const { detectGitExecutable } = await import('../lib/git-executable');
    const status = await detectGitExecutable({ force: true });

    expect(status).toMatchObject({
      ready: true,
      path: preferences.gitExecutablePath,
      source: 'cache',
    });
    expect(process.env.CANOPY_GIT_EXECUTABLE).toBe(
      preferences.gitExecutablePath,
    );
  });

  it('auto-detects Git from common Windows install paths', async () => {
    process.env.ProgramFiles = 'C:\\Program Files';
    process.env['ProgramFiles(x86)'] = 'C:\\Program Files (x86)';
    process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
    const detectedPath = 'C:\\Program Files/Git/bin/git.exe';
    mockedStat.mockImplementation((candidate) => {
      if (candidate === detectedPath) {
        return Promise.resolve({ isFile: () => true } as never);
      }
      return Promise.reject(new Error('missing'));
    });
    mockedExecFile.mockImplementation((...call) => {
      const command = call[0];
      const args = call[1] as string[] | undefined;
      const callback = call.find((entry) => typeof entry === 'function') as
        | ExecCallback
        | undefined;
      if (command === 'where.exe' && args?.[0] === 'winget' && callback) {
        callback(new Error('not found'), '', '');
      } else if (command === 'where.exe' && args?.[0] === 'git' && callback) {
        callback(new Error('not found'), '', '');
      } else if (command === detectedPath && callback) {
        callback(null, 'git version 2.51.0.windows.1\n', '');
      }
      return childWithOutput() as never;
    });

    const { detectGitExecutable } = await import('../lib/git-executable');
    const status = await detectGitExecutable({ force: true });

    expect(status).toMatchObject({
      ready: true,
      path: detectedPath,
      source: 'auto-detected',
    });
    expect(mockWritePreferencesFile).toHaveBeenLastCalledWith({
      gitExecutablePath: detectedPath,
    });
  });

  it('auto-detects per-user Git under LocalAppData Programs', async () => {
    process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
    const detectedPath =
      'C:\\Users\\test\\AppData\\Local/Programs/Git/cmd/git.exe';
    mockedStat.mockImplementation((candidate) => {
      if (candidate === detectedPath) {
        return Promise.resolve({ isFile: () => true } as never);
      }
      return Promise.reject(new Error('missing'));
    });
    mockedExecFile.mockImplementation((...call) => {
      const command = call[0];
      const args = call[1] as string[] | undefined;
      const callback = call.find((entry) => typeof entry === 'function') as
        | ExecCallback
        | undefined;
      if (command === 'where.exe' && callback) {
        callback(new Error('not found'), '', '');
      } else if (
        command === detectedPath &&
        args?.[0] === '--version' &&
        callback
      ) {
        callback(null, 'git version 2.51.0.windows.1\n', '');
      }
      return childWithOutput() as never;
    });

    const { detectGitExecutable } = await import('../lib/git-executable');
    const status = await detectGitExecutable({ force: true });

    expect(status).toMatchObject({
      ready: true,
      path: detectedPath,
      source: 'auto-detected',
    });
  });

  it('reports winget unavailable when no Git is found', async () => {
    mockedExecFile.mockImplementation((...call) => {
      const command = call[0];
      const callback = call.find((entry) => typeof entry === 'function') as
        | ExecCallback
        | undefined;
      if (command === 'where.exe' && callback) {
        callback(new Error('not found'), '', '');
      }
      return childWithOutput() as never;
    });
    mockedStat.mockRejectedValue(new Error('missing'));

    const { detectGitExecutable } = await import('../lib/git-executable');
    const status = await detectGitExecutable({ force: true });

    expect(status).toMatchObject({
      required: true,
      ready: false,
      path: null,
      source: 'not-found',
      wingetAvailable: false,
    });
  });

  it('rejects non-git.exe browse selections on Windows', async () => {
    const { validateGitExecutable } = await import('../lib/git-executable');

    await expect(
      validateGitExecutable('C:\\Program Files\\Git\\cmd\\not-git.exe'),
    ).rejects.toThrow('git.exe');
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('installs with winget, captures bounded output, and verifies Git', async () => {
    const progress: unknown[] = [];
    const gitPath = 'C:\\Program Files\\Git\\cmd\\git.exe';
    mockedExecFile.mockImplementation((...call) => {
      const command = call[0];
      const args = call[1] as string[] | undefined;
      const callback = call.find((entry) => typeof entry === 'function') as
        | ExecCallback
        | undefined;
      if (command === 'where.exe' && args?.[0] === 'winget' && callback) {
        callback(null, 'C:\\Windows\\System32\\winget.exe\n', '');
      } else if (command === 'where.exe' && args?.[0] === 'git' && callback) {
        callback(null, `${gitPath}\n`, '');
      } else if (command === gitPath && callback) {
        callback(null, 'git version 2.51.0.windows.1\n', '');
      } else if (command === 'C:\\Windows\\System32\\winget.exe') {
        return completeExec(null, 'installed\n') as never;
      }
      return childWithOutput() as never;
    });

    const { installGitWithWinget } = await import('../lib/git-executable');
    const status = await installGitWithWinget((event) => progress.push(event));

    expect(mockedExecFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\winget.exe',
      expect.arrayContaining([
        'install',
        '--id',
        'Git.Git',
        '--silent',
        '--disable-interactivity',
        '--accept-package-agreements',
        '--accept-source-agreements',
      ]),
      expect.objectContaining({ windowsHide: true, timeout: 600000 }),
      expect.any(Function),
    );
    expect(status).toMatchObject({
      ready: true,
      path: gitPath,
      source: 'winget-install',
    });
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'starting' }),
        expect.objectContaining({ phase: 'running' }),
        expect.objectContaining({ phase: 'verifying' }),
        expect.objectContaining({ phase: 'success', path: gitPath }),
      ]),
    );
  });

  it('bounds winget failure output', async () => {
    const noisy = 'x'.repeat(20_000);
    const progress: Array<{ phase?: string; error?: string }> = [];
    mockedExecFile.mockImplementation((...call) => {
      const command = call[0];
      const args = call[1] as string[] | undefined;
      const callback = call.find((entry) => typeof entry === 'function') as
        | ExecCallback
        | undefined;
      if (command === 'where.exe' && args?.[0] === 'winget' && callback) {
        callback(null, 'C:\\Windows\\System32\\winget.exe\n', '');
      } else if (command === 'C:\\Windows\\System32\\winget.exe') {
        return completeExec(new Error('winget failed'), noisy) as never;
      }
      return childWithOutput() as never;
    });

    const { installGitWithWinget } = await import('../lib/git-executable');
    await expect(
      installGitWithWinget((event) => progress.push(event)),
    ).rejects.toThrow('winget failed');
    const failure = progress.find((event) => event.phase === 'failure');
    expect(failure?.error?.length).toBeLessThanOrEqual(
      'winget failed\n\n'.length + 8192,
    );
  });

  it('surfaces unsupported silent winget installs without allowing interaction', async () => {
    const output = 'Installer does not support silent installation.';
    const progress: Array<{ phase?: string; error?: string }> = [];
    mockedExecFile.mockImplementation((...call) => {
      const command = call[0];
      const args = call[1] as string[] | undefined;
      const callback = call.find((entry) => typeof entry === 'function') as
        | ExecCallback
        | undefined;
      if (command === 'where.exe' && args?.[0] === 'winget' && callback) {
        callback(null, 'C:\\Windows\\System32\\winget.exe\n', '');
      } else if (command === 'C:\\Windows\\System32\\winget.exe') {
        return completeExec(new Error('winget failed'), output) as never;
      }
      return childWithOutput() as never;
    });

    const { installGitWithWinget } = await import('../lib/git-executable');
    await expect(
      installGitWithWinget((event) => progress.push(event)),
    ).rejects.toThrow('cannot be installed silently');
    const failure = progress.find((event) => event.phase === 'failure');
    expect(failure?.error).toContain('Install Git manually, then recheck.');
    expect(mockedExecFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\winget.exe',
      expect.arrayContaining(['--silent', '--disable-interactivity']),
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });
});

describe('git executable IPC handlers', () => {
  function getHandler(channel: string): () => Promise<GitExecutableStatus> {
    const call = mockedRegisterIpcHandler.mock.calls.find(
      ([registeredChannel]) => registeredChannel === channel,
    );
    const handler = call?.[1];
    if (typeof handler !== 'function') {
      throw new Error(`No handler registered for ${channel}`);
    }
    return handler as () => Promise<GitExecutableStatus>;
  }

  beforeEach(() => {
    mockedRegisterIpcHandler.mockClear();
    mockedDialog.showOpenDialog.mockReset();
  });

  it('persists a valid native-picker Browse selection', async () => {
    const selected = 'C:\\Program Files\\Git\\cmd\\git.exe';
    mockedDialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [selected],
    });
    mockedExecFile.mockImplementation((...call) => {
      const command = call[0];
      const args = call[1] as string[] | undefined;
      const callback = call.find((entry) => typeof entry === 'function') as
        | ExecCallback
        | undefined;
      if (command === selected && callback) {
        callback(null, 'git version 2.51.0.windows.1\n', '');
      } else if (
        command === 'where.exe' &&
        args?.[0] === 'winget' &&
        callback
      ) {
        callback(new Error('not found'), '', '');
      }
      return childWithOutput() as never;
    });

    const { registerGitExecutableHandlers } =
      await import('../ipc/git-executable');
    registerGitExecutableHandlers(() => null);
    const status = await getHandler(IPC_CHANNELS.gitExecutableBrowse)();

    expect(status).toMatchObject({
      ready: true,
      path: selected,
      version: 'git version 2.51.0.windows.1',
      source: 'browse',
    });
    expect(mockWritePreferencesFile).toHaveBeenCalledWith({
      gitExecutablePath: selected,
    });
  });

  it('returns E2E effective Windows platform details for Browse selections', async () => {
    globalWithE2EFlag.__CANOPY_E2E__ = true;
    process.env.CANOPY_E2E_PLATFORM = 'win32';
    setPlatform('darwin');
    const selected = 'C:\\Program Files\\Git\\cmd\\git.exe';
    mockedDialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [selected],
    });
    mockedExecFile.mockImplementation((...call) => {
      const command = call[0];
      const args = call[1] as string[] | undefined;
      const callback = call.find((entry) => typeof entry === 'function') as
        | ExecCallback
        | undefined;
      if (command === selected && callback) {
        callback(null, 'git version 2.51.0.windows.1\n', '');
      } else if (
        command === 'where.exe' &&
        args?.[0] === 'winget' &&
        callback
      ) {
        callback(new Error('not found'), '', '');
      }
      return childWithOutput() as never;
    });

    const { registerGitExecutableHandlers } =
      await import('../ipc/git-executable');
    registerGitExecutableHandlers(() => null);
    const status = await getHandler(IPC_CHANNELS.gitExecutableBrowse)();

    expect(status).toMatchObject({
      platform: 'win32',
      required: true,
      ready: true,
      path: selected,
      source: 'browse',
    });
  });

  it('returns validation detail for an invalid native-picker Browse selection', async () => {
    mockedDialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['C:\\Windows\\System32\\notepad.exe'],
    });
    mockedExecFile.mockImplementation((...call) => {
      const command = call[0];
      const args = call[1] as string[] | undefined;
      const callback = call.find((entry) => typeof entry === 'function') as
        | ExecCallback
        | undefined;
      if (command === 'where.exe' && args?.[0] === 'winget' && callback) {
        callback(new Error('not found'), '', '');
      }
      return childWithOutput() as never;
    });

    const { registerGitExecutableHandlers } =
      await import('../ipc/git-executable');
    registerGitExecutableHandlers(() => null);
    const status = await getHandler(IPC_CHANNELS.gitExecutableBrowse)();

    expect(status).toMatchObject({
      ready: false,
      source: 'not-found',
    });
    expect(status.error).toEqual(expect.stringContaining('git.exe'));
    expect(mockWritePreferencesFile).not.toHaveBeenCalledWith({
      gitExecutablePath: 'C:\\Windows\\System32\\notepad.exe',
    });
  });
});

describe('spawn-time Git recovery', () => {
  it('routes every desktop main-process Git launch through spawn-time recovery', () => {
    const gitLaunchModules = [
      '../lib/archived-container-git.ts',
      '../lib/plan-share-repos.ts',
      '../lib/session-transfer.ts',
      '../lib/worktree-health.ts',
      '../services/diff-service.ts',
      '../services/pr-service.ts',
    ];

    for (const modulePath of gitLaunchModules) {
      const source = readFileSync(join(__dirname, modulePath), 'utf8');
      expect(source).not.toContain('getGitExecutableCommand(process.env)');
      expect(source).toContain('getResolvedGitExecutableForSpawn');
    }
  });

  it('keeps the fingerprint worker on pure inherited Git selection', () => {
    const source = readFileSync(
      join(__dirname, '../lib/code-graph-worktree-fingerprint-core.ts'),
      'utf8',
    );
    expect(source).toContain('getGitExecutableCommand(process.env)');
    expect(source).not.toContain('getResolvedGitExecutableForSpawn');
  });

  it('narrows spawn-time filesystem failures without type assertions', () => {
    const source = readFileSync(
      join(__dirname, '../lib/git-executable.ts'),
      'utf8',
    );
    expect(source).toContain('isErrnoException(error)');
    expect(source).not.toContain('error as NodeJS.ErrnoException');
  });

  it('keeps valid Windows overrides without launching another version probe', async () => {
    const valid = 'C:\\Git\\cmd\\git.exe';
    process.env.CANOPY_GIT_EXECUTABLE = valid;
    const { getResolvedGitExecutableForSpawn } =
      await import('../lib/git-executable');
    expect(await getResolvedGitExecutableForSpawn()).toBe(valid);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('resolves an executable from the supplied spawn environment', async () => {
    const valid = 'D:\\PortableGit\\cmd\\git.exe';
    const env = { ...process.env, CANOPY_GIT_EXECUTABLE: valid };
    mockedExecFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, 'git version 2.51.0.windows.1', '');
      return childWithOutput();
    });
    const { getResolvedGitExecutableForSpawn } =
      await import('../lib/git-executable');

    expect(await getResolvedGitExecutableForSpawn(env)).toBe(valid);
    expect(mockedExecFile).toHaveBeenCalledWith(
      valid,
      ['--version'],
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    );
  });

  it('replaces a disappeared published path with a validated PATH installation', async () => {
    const stale = 'D:\\Git\\cmd\\git.exe';
    const valid = 'C:\\Git\\cmd\\git.exe';
    preferences.gitExecutablePath = stale;
    process.env.CANOPY_GIT_EXECUTABLE = stale;
    mockedStat.mockImplementation((candidate) => {
      if (candidate === stale)
        return Promise.reject(
          Object.assign(new Error('missing'), { code: 'ENOENT' }),
        );
      return actualStat(__filename);
    });
    mockedExecFile.mockImplementation((command, args, _options, callback) => {
      if (command === 'where.exe')
        callback(null, args?.[0] === 'git' ? valid : '', '');
      else if (command === valid)
        callback(null, 'git version 2.50.0.windows.1', '');
      else callback(new Error('not found'), '', '');
      return childWithOutput();
    });
    const { getResolvedGitExecutableForSpawn } =
      await import('../lib/git-executable');
    expect(await getResolvedGitExecutableForSpawn()).toBe(valid);
    expect(preferences.gitExecutablePath).toBe(valid);
    expect(process.env.CANOPY_GIT_EXECUTABLE).toBe(valid);
  });

  it('clears an invalid inherited path even when there is no matching cached preference', async () => {
    process.env.CANOPY_GIT_EXECUTABLE = 'D:\\Git\\cmd\\git.exe';
    mockedStat.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    mockedExecFile.mockImplementation((_command, _args, _options, callback) => {
      callback(new Error('not found'), '', '');
      return childWithOutput();
    });
    const { getResolvedGitExecutableForSpawn } =
      await import('../lib/git-executable');
    await expect(
      Promise.resolve().then(() => getResolvedGitExecutableForSpawn()),
    ).rejects.toThrow(/Git/);
    expect(process.env.CANOPY_GIT_EXECUTABLE).toBeUndefined();
  });
});

describe('macOS Git discovery without developer-tool prompts', () => {
  const clt = '/Library/Developer/CommandLineTools/usr/bin/git';
  beforeEach(() => {
    setPlatform('darwin');
    process.env.PATH = '/usr/bin';
    getLoginShellPathMock.mockReset().mockReturnValue('/usr/bin');
    jest
      .mocked(realpath)
      .mockImplementation((path) => Promise.resolve(String(path)));
    jest.mocked(readdir).mockResolvedValue([]);
    jest.mocked(mkdtemp).mockResolvedValue('/tmp/git-probe-test');
    jest.mocked(rm).mockResolvedValue(undefined);
    mockedExecFile.mockImplementation((command, args, _options, callback) => {
      if (command === '/usr/bin/xcode-select') {
        callback?.(new Error('No active developer directory'), '', '');
      } else {
        callback?.(
          null,
          args?.[0] === '--version' ? 'git version 2.50.1' : '',
          '',
        );
      }
      return childWithOutput();
    });
  });

  it('requires Git and never executes the Apple shim when tools are absent', async () => {
    mockedStat.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    const { detectGitExecutable } = await import('../lib/git-executable');
    expect(await detectGitExecutable({ force: true })).toMatchObject({
      required: true,
      ready: false,
    });
    expect(
      mockedExecFile.mock.calls.every(
        ([file]) => file === '/usr/bin/xcode-select',
      ),
    ).toBe(true);
  });

  it.each([
    clt,
    '/opt/homebrew/bin/git',
    '/usr/local/bin/git',
    '/custom/bin/git',
  ])(
    'finds and explicitly saves usable Git at %s despite a broken selected Xcode',
    async (candidate) => {
      process.env.PATH = '/usr/bin:/custom/bin';
      getLoginShellPathMock.mockReturnValue('/usr/bin:/custom/bin');
      mockedStat.mockImplementation((path) =>
        String(path) === candidate
          ? actualStat(__filename)
          : Promise.reject(new Error('missing')),
      );
      const { detectGitExecutable } = await import('../lib/git-executable');
      expect(await detectGitExecutable({ force: true })).toMatchObject({
        ready: true,
        path: candidate,
        required: true,
      });
      expect(preferences.gitExecutablePath).toBe(candidate);
      expect(process.env.CANOPY_GIT_EXECUTABLE).toBe(candidate);
      expect(
        mockedExecFile.mock.calls.some(
          ([file, args]) =>
            file === candidate && Array.isArray(args) && args.includes('init'),
        ),
      ).toBe(true);
      expect(
        mockedExecFile.mock.calls.some(
          ([file]) => file === '/usr/bin/git' || file === '/usr/bin/xcrun',
        ),
      ).toBe(false);
    },
  );

  it('finds Git that is available only through the login-shell PATH', async () => {
    const candidate = '/login-shell/bin/git';
    getLoginShellPathMock.mockReturnValue('/login-shell/bin:/usr/bin');
    mockedStat.mockImplementation((path) =>
      String(path) === candidate
        ? actualStat(__filename)
        : Promise.reject(new Error('missing')),
    );

    const { detectGitExecutable } = await import('../lib/git-executable');

    expect(await detectGitExecutable({ force: true })).toMatchObject({
      ready: true,
      path: candidate,
    });
  });

  it('normalizes login-shell PATH entries exactly as path.join does', async () => {
    getLoginShellPathMock.mockReturnValue(
      '/custom/../opt/bin:/usr//local/bin:/usr/bin',
    );
    mockedStat.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );

    const { detectGitExecutable } = await import('../lib/git-executable');
    await detectGitExecutable({ force: true });

    expect(mockedStat.mock.calls.slice(0, 2).map(([file]) => file)).toEqual([
      '/opt/bin/git',
      '/usr/local/bin/git',
    ]);
  });

  it('does not enumerate application bundles during automatic discovery', async () => {
    mockedStat.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );

    const { detectGitExecutable } = await import('../lib/git-executable');
    await detectGitExecutable({ force: true });

    expect(readdir).not.toHaveBeenCalled();
  });

  it('rejects a symlink to the Apple shim before running it', async () => {
    jest.mocked(realpath).mockResolvedValue('/usr/bin/git');
    const { validateGitExecutable } = await import('../lib/git-executable');
    await expect(validateGitExecutable('/custom/bin/git')).rejects.toThrow(
      /shim/i,
    );
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('rechecks a published path before reusing it after symlink replacement', async () => {
    const candidate = '/custom/bin/git';
    mockedStat.mockImplementation((path) =>
      String(path) === candidate
        ? actualStat(__filename)
        : Promise.reject(
            Object.assign(new Error('missing'), { code: 'ENOENT' }),
          ),
    );
    jest.mocked(realpath).mockResolvedValue(candidate);
    const { getResolvedGitExecutableForSpawn, validateGitExecutable } =
      await import('../lib/git-executable');
    await validateGitExecutable(candidate);
    process.env.CANOPY_GIT_EXECUTABLE = candidate;
    jest.mocked(realpath).mockResolvedValue('/usr/bin/git');

    await expect(getResolvedGitExecutableForSpawn()).rejects.toThrow(/Git/);
    expect(
      mockedExecFile.mock.calls.some(([file]) => file === '/usr/bin/git'),
    ).toBe(false);
  });

  it('rejects an installation that prints a version but fails a repository smoke test', async () => {
    mockedExecFile.mockImplementation((_command, args, _options, callback) => {
      callback?.(
        args?.[0] === '--version' ? null : new Error('broken Git installation'),
        'git version 2.50.1',
        '',
      );
      return childWithOutput();
    });
    const { validateGitExecutable } = await import('../lib/git-executable');
    await expect(validateGitExecutable(clt)).rejects.toThrow(
      'broken Git installation',
    );
    expect(rm).toHaveBeenCalledWith('/tmp/git-probe-test', {
      recursive: true,
      force: true,
    });
  });

  it('recovers a missing saved installation and refuses bare Git fallback', async () => {
    preferences.gitExecutablePath = '/removed/git';
    process.env.CANOPY_GIT_EXECUTABLE = '/removed/git';
    mockedStat.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    const { getResolvedGitExecutableForSpawn } =
      await import('../lib/git-executable');
    await expect(getResolvedGitExecutableForSpawn()).rejects.toThrow();
    expect(process.env.CANOPY_GIT_EXECUTABLE).toBeUndefined();
  });
  it('requests the Apple installer only through the explicit install action', async () => {
    const { installGitWithXcode } = await import('../lib/git-executable');
    mockedExecFile.mockImplementation((_command, _args, _options, callback) => {
      callback?.(null, 'install requested', '');
      return childWithOutput();
    });
    await expect(installGitWithXcode()).resolves.toBeUndefined();
    expect(mockedExecFile).toHaveBeenCalledWith(
      '/usr/bin/xcode-select',
      ['--install'],
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    );
    expect(mockWritePreferencesFile).not.toHaveBeenCalled();
  });
});

describe('Linux x64 Git requirement', () => {
  const SYSTEM_GIT = '/usr/bin/git';
  const originalArch = process.arch;
  type FileState = 'executable' | 'not-executable' | 'directory' | 'unreadable';
  let files: Record<string, FileState>;
  let probes: Record<string, string | Error>;
  let loginPath: string;
  let events: string[];
  const mockedAccess = jest.mocked(access);

  function setArch(arch: string): void {
    Object.defineProperty(process, 'arch', {
      value: arch,
      configurable: true,
    });
  }

  function errno(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(code), { code });
  }

  function install(path: string, state: FileState = 'executable'): void {
    files[path] = state;
  }

  function probedFiles(): string[] {
    return mockedExecFile.mock.calls.map(([file]) => String(file));
  }

  beforeEach(async () => {
    setPlatform('linux');
    setArch('x64');
    files = {};
    probes = {};
    events = [];
    loginPath = '/usr/local/bin:/usr/bin:/bin';
    process.env.PATH = '/usr/bin:/bin';
    getLoginShellPathMock.mockReset().mockImplementation(() => {
      events.push('read-login-path');
      return loginPath;
    });
    prewarmLoginShellPathMock.mockReset().mockImplementation(() => {
      events.push('refresh-login-path');
      return Promise.resolve();
    });
    mockedStat.mockImplementation((candidate) => {
      const state = files[String(candidate)];
      if (state === undefined) return Promise.reject(errno('ENOENT'));
      if (state === 'unreadable') return Promise.reject(errno('EACCES'));
      return Promise.resolve({ isFile: () => state !== 'directory' } as never);
    });
    mockedAccess.mockImplementation((candidate) =>
      files[String(candidate)] === 'executable'
        ? Promise.resolve()
        : Promise.reject(errno('EACCES')),
    );
    mockedExecFile.mockImplementation((command, _args, _options, callback) => {
      const probe = probes[String(command)] ?? 'git version 2.43.0\n';
      if (probe instanceof Error) callback?.(probe, '', '');
      else callback?.(null, probe, '');
      return childWithOutput();
    });
    const { clearCachedGitExecutablePath } =
      await import('../lib/git-executable');
    await clearCachedGitExecutablePath();
    mockWritePreferencesFile.mockClear();
  });

  afterEach(() => {
    setArch(originalArch);
  });

  it('requires Git only on Linux x64', async () => {
    const { getGitExecutablePlatformStatus } =
      await import('../lib/git-executable');
    expect(getGitExecutablePlatformStatus()).toEqual({
      platform: 'linux',
      required: true,
    });
    setArch('arm64');
    expect(getGitExecutablePlatformStatus()).toEqual({
      platform: 'linux',
      required: false,
    });
  });

  it('reports not-ready with the real reason on a stock image without Git', async () => {
    const { detectGitExecutable } = await import('../lib/git-executable');
    const status = await detectGitExecutable();

    expect(status).toMatchObject({
      platform: 'linux',
      required: true,
      ready: false,
      path: null,
      version: null,
      source: 'not-found',
      wingetAvailable: false,
    });
    expect(status.error).toMatch(/Git was not found/);
    expect(status.error).toContain('login PATH');
    expect(status.error).toContain(SYSTEM_GIT);
    expect(status.error).toMatch(/Install Git/);
    expect(mockedExecFile).not.toHaveBeenCalled();
    expect(process.env.CANOPY_GIT_EXECUTABLE).toBeUndefined();
    expect(mockWritePreferencesFile).not.toHaveBeenCalled();
  });

  it('explains a Git that exists but cannot run instead of claiming it is missing', async () => {
    install(SYSTEM_GIT, 'not-executable');
    const { detectGitExecutable } = await import('../lib/git-executable');
    const status = await detectGitExecutable();

    expect(status.ready).toBe(false);
    expect(status.error).toContain(`${SYSTEM_GIT} is not executable`);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  describe('precedence', () => {
    it('prefers a valid explicit choice over the cache, login PATH, and system Git', async () => {
      const chosen = '/opt/git/bin/git';
      preferences.gitExecutablePath = chosen;
      install(chosen);
      install('/usr/local/bin/git');
      install(SYSTEM_GIT);
      const { detectGitExecutable } = await import('../lib/git-executable');

      expect(await detectGitExecutable()).toMatchObject({
        required: true,
        ready: true,
        path: chosen,
        version: 'git version 2.43.0',
        source: 'user-selected',
      });
      expect(probedFiles()).toEqual([chosen]);
      expect(prewarmLoginShellPathMock).not.toHaveBeenCalled();
      expect(process.env.CANOPY_GIT_EXECUTABLE).toBe(chosen);
      expect(mockWritePreferencesFile).not.toHaveBeenCalled();
    });

    it('treats an externally supplied override as an explicit choice', async () => {
      process.env.CANOPY_GIT_EXECUTABLE = '/opt/env/git';
      install('/opt/env/git');
      install(SYSTEM_GIT);
      const { detectGitExecutable } = await import('../lib/git-executable');

      expect(await detectGitExecutable()).toMatchObject({
        ready: true,
        path: '/opt/env/git',
        source: 'user-selected',
      });
      expect(probedFiles()).toEqual(['/opt/env/git']);
    });

    it('lets the saved choice outrank an inherited override', async () => {
      preferences.gitExecutablePath = '/opt/saved/git';
      process.env.CANOPY_GIT_EXECUTABLE = '/opt/env/git';
      install('/opt/saved/git');
      install('/opt/env/git');
      const { detectGitExecutable } = await import('../lib/git-executable');

      expect(await detectGitExecutable()).toMatchObject({
        path: '/opt/saved/git',
        source: 'user-selected',
      });
    });

    it('revalidates the cached path before refreshing the login PATH', async () => {
      loginPath = '/home/user/.local/bin:/usr/bin';
      install('/home/user/.local/bin/git');
      const { detectGitExecutable } = await import('../lib/git-executable');
      expect(await detectGitExecutable()).toMatchObject({
        path: '/home/user/.local/bin/git',
        source: 'login-path',
      });

      loginPath = '/preferred/bin:/home/user/.local/bin:/usr/bin';
      install('/preferred/bin/git');
      mockedExecFile.mockClear();
      prewarmLoginShellPathMock.mockClear();

      expect(await detectGitExecutable()).toMatchObject({
        ready: true,
        path: '/home/user/.local/bin/git',
        version: 'git version 2.43.0',
        source: 'cache',
      });
      expect(probedFiles()).toEqual(['/home/user/.local/bin/git']);
      expect(prewarmLoginShellPathMock).not.toHaveBeenCalled();
    });

    it('drops a cached path that disappeared and re-resolves from the login PATH', async () => {
      install('/usr/local/bin/git');
      const { detectGitExecutable } = await import('../lib/git-executable');
      await detectGitExecutable();
      delete files['/usr/local/bin/git'];
      install(SYSTEM_GIT);

      expect(await detectGitExecutable()).toMatchObject({
        ready: true,
        path: SYSTEM_GIT,
        source: 'login-path',
      });
      expect(process.env.CANOPY_GIT_EXECUTABLE).toBe(SYSTEM_GIT);
    });

    it('reports a cached Git that became unusable when nothing replaces it', async () => {
      loginPath = '/opt/cache/bin';
      install('/opt/cache/bin/git');
      const { detectGitExecutable } = await import('../lib/git-executable');
      await detectGitExecutable();

      loginPath = '/opt/empty/bin';
      files['/opt/cache/bin/git'] = 'not-executable';
      const status = await detectGitExecutable({ force: true });

      expect(status.ready).toBe(false);
      expect(status.error).toMatch(/found but cannot be used/);
      expect(status.error).toContain('/opt/cache/bin/git is not executable');
      expect(status.error).not.toMatch(/was not found/);
    });

    it('uses the refreshed login PATH in order before the system location', async () => {
      loginPath = 'relative/bin:/opt/first/bin:/opt/second/bin:/usr/bin';
      install('/opt/second/bin/git');
      install(SYSTEM_GIT);
      const { detectGitExecutable } = await import('../lib/git-executable');

      expect(await detectGitExecutable()).toMatchObject({
        path: '/opt/second/bin/git',
        source: 'login-path',
      });
      expect(probedFiles()).toEqual(['/opt/second/bin/git']);
    });

    it('falls back to the standard system location when the login PATH has no Git', async () => {
      loginPath = '/opt/empty/bin';
      install(SYSTEM_GIT);
      const { detectGitExecutable } = await import('../lib/git-executable');

      expect(await detectGitExecutable()).toMatchObject({
        required: true,
        ready: true,
        path: SYSTEM_GIT,
        version: 'git version 2.43.0',
        source: 'system',
      });
    });

    it('keeps discovery in memory so only an explicit choice is persisted', async () => {
      install(SYSTEM_GIT);
      const { detectGitExecutable } = await import('../lib/git-executable');
      await detectGitExecutable();

      expect(mockWritePreferencesFile).not.toHaveBeenCalled();
      expect(preferences.gitExecutablePath).toBe('');
      expect(process.env.CANOPY_GIT_EXECUTABLE).toBe(SYSTEM_GIT);
    });

    it('skips a broken discovered candidate and keeps looking', async () => {
      loginPath = '/opt/broken/bin:/usr/bin';
      install('/opt/broken/bin/git', 'not-executable');
      install(SYSTEM_GIT);
      const { detectGitExecutable } = await import('../lib/git-executable');

      expect(await detectGitExecutable()).toMatchObject({
        ready: true,
        path: SYSTEM_GIT,
      });
    });
  });

  describe('login PATH refresh', () => {
    it('refreshes before reading and only when discovery is reached', async () => {
      install(SYSTEM_GIT);
      const { detectGitExecutable } = await import('../lib/git-executable');
      await detectGitExecutable();

      expect(events).toEqual(['refresh-login-path', 'read-login-path']);
      expect(prewarmLoginShellPathMock).toHaveBeenCalledWith(undefined);
    });

    it('forces the refresh on an explicit recheck', async () => {
      install(SYSTEM_GIT);
      const { detectGitExecutable } = await import('../lib/git-executable');
      await detectGitExecutable({ force: true });

      expect(events).toEqual(['refresh-login-path', 'read-login-path']);
      expect(prewarmLoginShellPathMock).toHaveBeenCalledWith({ force: true });
    });

    it('recovers after Git is installed into a location only a refreshed PATH shows', async () => {
      loginPath = '/usr/local/bin';
      const { detectGitExecutable } = await import('../lib/git-executable');
      expect(await detectGitExecutable()).toMatchObject({ ready: false });

      install('/home/user/.local/bin/git');
      prewarmLoginShellPathMock.mockImplementation(() => {
        loginPath = '/home/user/.local/bin:/usr/local/bin';
        return Promise.resolve();
      });

      expect(await detectGitExecutable({ force: true })).toMatchObject({
        ready: true,
        path: '/home/user/.local/bin/git',
        source: 'login-path',
      });
    });

    it('recovers after Git is installed at the system location', async () => {
      loginPath = '/opt/empty/bin';
      const { detectGitExecutable } = await import('../lib/git-executable');
      expect(await detectGitExecutable()).toMatchObject({ ready: false });

      install(SYSTEM_GIT);
      expect(await detectGitExecutable({ force: true })).toMatchObject({
        ready: true,
        path: SYSTEM_GIT,
        source: 'system',
      });
    });

    it('does not let a forced recheck reuse an in-flight pre-install result', async () => {
      let release: () => void = () => undefined;
      prewarmLoginShellPathMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const { detectGitExecutable } = await import('../lib/git-executable');
      const stale = detectGitExecutable();
      await Promise.resolve();

      install(SYSTEM_GIT);
      const rechecked = await detectGitExecutable({ force: true });
      release();

      expect(rechecked).toMatchObject({ ready: true, path: SYSTEM_GIT });
      await stale;
    });

    it('shares one detection across concurrent unforced callers', async () => {
      install(SYSTEM_GIT);
      const { detectGitExecutable } = await import('../lib/git-executable');
      const [first, second] = await Promise.all([
        detectGitExecutable(),
        detectGitExecutable(),
      ]);

      expect(second).toBe(first);
      expect(prewarmLoginShellPathMock).toHaveBeenCalledTimes(1);
      expect(mockedExecFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('overlapping detections', () => {
    const flush = (): Promise<void> =>
      new Promise((resolve) => setImmediate(resolve));

    it.each(['saving', 'clearing'] as const)(
      'does not reuse an obsolete detection after %s the explicit choice',
      async (change) => {
        install('/old/git');
        install('/selected/git');
        loginPath = '/old';
        if (change === 'clearing') preferences.gitExecutablePath = '/old/git';
        let finishOldProbe: () => void = () => {
          throw new Error('Old Git probe did not start');
        };
        mockedExecFile.mockImplementation(
          (command, _args, _options, callback) => {
            if (command === '/old/git') {
              finishOldProbe = (): void =>
                callback?.(null, 'git version 2.43.0\n', '');
            } else {
              callback?.(null, 'git version 2.43.0\n', '');
            }
            return childWithOutput();
          },
        );
        const mod = await import('../lib/git-executable');
        const stale = mod.detectGitExecutable();
        await flush();
        expect(probedFiles()).toEqual(['/old/git']);

        loginPath = '/selected';
        if (change === 'saving') {
          const validated = await mod.validateGitExecutable('/selected/git');
          await mod.setCachedGitExecutablePath(validated.path);
        } else {
          await mod.clearCachedGitExecutablePath();
        }
        const spawn = mod.getResolvedGitExecutableForSpawn();
        await flush();
        finishOldProbe();
        await stale;

        expect(await spawn).toBe('/selected/git');
        expect(process.env.CANOPY_GIT_EXECUTABLE).toBe('/selected/git');
        expect(preferences.gitExecutablePath).toBe(
          change === 'saving' ? '/selected/git' : '',
        );
      },
    );

    async function overlap(
      releaseOrder: 'old-first' | 'new-first',
    ): Promise<typeof GitExecutableModule> {
      const releases: Array<() => void> = [];
      prewarmLoginShellPathMock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          }),
      );
      install('/old/bin/git');
      install('/new/bin/git');
      const mod = await import('../lib/git-executable');
      loginPath = '/old/bin';
      const stale = mod.detectGitExecutable();
      await flush();
      loginPath = '/new/bin';
      const latest = mod.detectGitExecutable({ force: true });
      await flush();
      expect(releases).toHaveLength(2);

      const settle = async (index: number, path: string): Promise<void> => {
        loginPath = path;
        releases[index]();
        await flush();
      };
      if (releaseOrder === 'old-first') {
        await settle(0, '/old/bin');
        await stale;
        await settle(1, '/new/bin');
        await latest;
      } else {
        await settle(1, '/new/bin');
        await latest;
        await settle(0, '/old/bin');
        await stale;
      }
      return mod;
    }

    it.each(['old-first', 'new-first'] as const)(
      'keeps the latest detection published when the older one finishes %s',
      async (order) => {
        const mod = await overlap(order);

        expect(process.env.CANOPY_GIT_EXECUTABLE).toBe('/new/bin/git');
        expect(await mod.getResolvedGitExecutableForSpawn()).toBe(
          '/new/bin/git',
        );
        prewarmLoginShellPathMock.mockImplementation(() => Promise.resolve());
        expect(await mod.detectGitExecutable()).toMatchObject({
          path: '/new/bin/git',
          source: 'cache',
        });
      },
    );

    it('lets a newer caller share the in-flight forced detection', async () => {
      const releases: Array<() => void> = [];
      prewarmLoginShellPathMock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          }),
      );
      install(SYSTEM_GIT);
      const { detectGitExecutable } = await import('../lib/git-executable');
      const stale = detectGitExecutable();
      await flush();
      const latest = detectGitExecutable({ force: true });
      await flush();
      releases[0]();
      await stale;

      const shared = detectGitExecutable();
      await flush();
      expect(releases).toHaveLength(2);
      releases[1]();
      expect(await shared).toBe(await latest);
    });
  });

  describe('explicit choice failure', () => {
    const chosen = '/opt/git/bin/git';
    const timeout = Object.assign(new Error('Command failed'), {
      killed: true,
      signal: 'SIGTERM',
    });
    const cases: Array<
      [string, FileState | undefined, string | Error | undefined, RegExp]
    > = [
      ['missing', undefined, undefined, /does not exist: \/opt\/git\/bin\/git/],
      ['a directory', 'directory', undefined, /is not a file/],
      ['not executable', 'not-executable', undefined, /is not executable/],
      ['unreadable', 'unreadable', undefined, /cannot be accessed.*EACCES/],
      [
        'a probe timeout',
        'executable',
        timeout,
        /did not respond within 5 seconds/,
      ],
      [
        'a probe that cannot run',
        'executable',
        errno('ENOEXEC'),
        /could not be run \(ENOEXEC\)/,
      ],
      [
        'a non-Git program',
        'executable',
        'GNU bash, version 5.2\n',
        /did not report a Git version/,
      ],
    ];

    it.each(cases)(
      'reports a broken saved choice (%s) and never falls back',
      async (_name, state, probe, reason) => {
        preferences.gitExecutablePath = chosen;
        if (state) install(chosen, state);
        if (probe !== undefined) probes[chosen] = probe;
        loginPath = '/usr/local/bin:/usr/bin';
        install('/usr/local/bin/git');
        install(SYSTEM_GIT);
        const { detectGitExecutable } = await import('../lib/git-executable');
        const status = await detectGitExecutable({ force: true });

        expect(status).toMatchObject({
          required: true,
          ready: false,
          path: null,
          version: null,
          source: 'not-found',
        });
        expect(status.error).toMatch(reason);
        expect(status.error).toContain(chosen);
        expect(probedFiles().every((file) => file === chosen)).toBe(true);
        expect(prewarmLoginShellPathMock).not.toHaveBeenCalled();
        expect(preferences.gitExecutablePath).toBe(chosen);
        expect(mockWritePreferencesFile).not.toHaveBeenCalled();
      },
    );

    it('reports a broken external override without discarding it', async () => {
      process.env.CANOPY_GIT_EXECUTABLE = '/opt/env/git';
      install(SYSTEM_GIT);
      const { detectGitExecutable } = await import('../lib/git-executable');

      const first = await detectGitExecutable();
      const second = await detectGitExecutable({ force: true });

      for (const status of [first, second]) {
        expect(status).toMatchObject({ ready: false, source: 'not-found' });
        expect(status.error).toContain('/opt/env/git');
      }
      expect(process.env.CANOPY_GIT_EXECUTABLE).toBe('/opt/env/git');
      expect(mockedExecFile).not.toHaveBeenCalled();
    });

    it('invalidates a discovered Git when a broken saved choice appears', async () => {
      install(SYSTEM_GIT);
      const { detectGitExecutable, getResolvedGitExecutableForSpawn } =
        await import('../lib/git-executable');
      expect(await detectGitExecutable()).toMatchObject({ ready: true });

      preferences.gitExecutablePath = chosen;
      expect(await detectGitExecutable()).toMatchObject({ ready: false });

      await expect(getResolvedGitExecutableForSpawn()).rejects.toThrow(
        /does not exist: \/opt\/git\/bin\/git/,
      );
      expect(process.env.CANOPY_GIT_EXECUTABLE).toBeUndefined();
      expect(preferences.gitExecutablePath).toBe(chosen);
    });

    it('invalidates a discovered Git when a broken override appears, keeping the override', async () => {
      install(SYSTEM_GIT);
      const { detectGitExecutable, getResolvedGitExecutableForSpawn } =
        await import('../lib/git-executable');
      await detectGitExecutable();

      process.env.CANOPY_GIT_EXECUTABLE = '/opt/env/git';
      expect(await detectGitExecutable()).toMatchObject({ ready: false });

      await expect(getResolvedGitExecutableForSpawn()).rejects.toThrow(
        /does not exist: \/opt\/env\/git/,
      );
      expect(process.env.CANOPY_GIT_EXECUTABLE).toBe('/opt/env/git');
    });

    it('recovers on recheck once the chosen Git is installed', async () => {
      preferences.gitExecutablePath = chosen;
      install(SYSTEM_GIT);
      const { detectGitExecutable } = await import('../lib/git-executable');
      expect(await detectGitExecutable()).toMatchObject({ ready: false });

      install(chosen);
      expect(await detectGitExecutable({ force: true })).toMatchObject({
        ready: true,
        path: chosen,
        source: 'user-selected',
      });
    });
  });

  describe('bounded validation', () => {
    it('probes the version with a bounded, execute-checked candidate', async () => {
      install(SYSTEM_GIT);
      const { detectGitExecutable } = await import('../lib/git-executable');
      await detectGitExecutable();

      expect(mockedAccess).toHaveBeenCalledWith(SYSTEM_GIT, constants.X_OK);
      expect(mockedExecFile).toHaveBeenCalledWith(
        SYSTEM_GIT,
        ['--version'],
        expect.objectContaining({ timeout: 5000, maxBuffer: 1024 * 1024 }),
        expect.any(Function),
      );
    });

    it('bounds the probe with SIGKILL and a sanitized environment', async () => {
      install(SYSTEM_GIT);
      const before = { ...process.env };
      const { detectGitExecutable } = await import('../lib/git-executable');
      await detectGitExecutable();

      expect(mockedExecFile).toHaveBeenCalledWith(
        SYSTEM_GIT,
        ['--version'],
        expect.objectContaining({
          timeout: 5000,
          maxBuffer: 1024 * 1024,
          killSignal: 'SIGKILL',
          env: { PATH: '/probe/bin', HOME: '/probe/home' },
        }),
        expect.any(Function),
      );
      expect(process.env).toEqual({
        ...before,
        CANOPY_GIT_EXECUTABLE: SYSTEM_GIT,
      });
    });

    it('keeps the default kill signal for Windows probes', async () => {
      setPlatform('win32');
      preferences.gitExecutablePath = 'C:\\Git\\cmd\\git.exe';
      mockedStat.mockImplementation(() => actualStat(__filename));
      mockedExecFile.mockImplementation((...call) => {
        const callback = call.find((entry) => typeof entry === 'function') as
          | ExecCallback
          | undefined;
        callback?.(null, 'git version 2.51.0.windows.1\n', '');
        return childWithOutput();
      });
      const { detectGitExecutable } = await import('../lib/git-executable');
      await detectGitExecutable();

      const probe = mockedExecFile.mock.calls.find(
        ([file]) => file === preferences.gitExecutablePath,
      );
      expect(probe?.[2]).not.toHaveProperty('killSignal');
      expect(probe?.[2]).not.toHaveProperty('env');
    });

    it('settles when a non-cooperative executable ignores SIGTERM', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'git-sigterm-'));
      const fixture = join(directory, 'git');
      writeFileSync(fixture, '#!/bin/sh\ntrap "" TERM\nexec /bin/sleep 30\n', {
        mode: 0o755,
      });
      install(fixture);
      preferences.gitExecutablePath = fixture;
      const realExecFile =
        jest.requireActual<typeof ChildProcessModule>(
          'node:child_process',
        ).execFile;
      // Core errors come from another realm; copy them so `instanceof` holds.
      mockedExecFile.mockImplementation(((
        file: string,
        args: string[],
        options: object,
        callback: ExecCallback,
      ) =>
        realExecFile(file, args, options, (error, stdout, stderr) =>
          callback(
            error &&
              Object.assign(new Error(error.message), {
                killed: error.killed,
                signal: error.signal,
                code: error.code,
              }),
            stdout,
            stderr,
          ),
        )) as never);
      try {
        const { detectGitExecutable } = await import('../lib/git-executable');
        const status = await detectGitExecutable();

        expect(status.ready).toBe(false);
        expect(status.error).toMatch(/did not respond within 5 seconds/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }, 20_000);

    it.each(['git version banana', 'git version', 'git version v2'])(
      'rejects a banner without a numeric Git version: %j',
      async (banner) => {
        install(SYSTEM_GIT);
        probes[SYSTEM_GIT] = `${banner}\n`;
        const { detectGitExecutable } = await import('../lib/git-executable');
        const status = await detectGitExecutable();

        expect(status.ready).toBe(false);
        expect(status.error).toMatch(/did not report a Git version/);
      },
    );

    it('does not run candidates that fail the file or execute checks', async () => {
      loginPath = '/a:/b:/c';
      install('/a/git', 'directory');
      install('/b/git', 'not-executable');
      install('/c/git', 'unreadable');
      const { detectGitExecutable } = await import('../lib/git-executable');
      const status = await detectGitExecutable();

      expect(status.ready).toBe(false);
      expect(mockedExecFile).not.toHaveBeenCalled();
    });

    it('requires an absolute explicit path', async () => {
      preferences.gitExecutablePath = 'git';
      install(SYSTEM_GIT);
      const { detectGitExecutable } = await import('../lib/git-executable');
      const status = await detectGitExecutable();

      expect(status.ready).toBe(false);
      expect(status.error).toMatch(/absolute/);
      expect(mockedExecFile).not.toHaveBeenCalled();
    });
  });

  describe('spawn-time resolution', () => {
    it.each(['process', 'copied'] as const)(
      'restarts when a new choice is saved during the %s environment access check',
      async (environment) => {
        preferences.gitExecutablePath = SYSTEM_GIT;
        install(SYSTEM_GIT);
        install('/opt/git/bin/git');
        const mod = await import('../lib/git-executable');
        await mod.detectGitExecutable();
        const env = environment === 'copied' ? { ...process.env } : process.env;
        let releaseAccess = (): void => {
          throw new Error('Old Git access check did not start');
        };
        const pendingAccess = new Promise<void>((resolve) => {
          releaseAccess = resolve;
        });
        const accessStarted = new Promise<void>((resolve) => {
          mockedAccess.mockImplementationOnce(() => {
            resolve();
            return pendingAccess;
          });
        });
        const spawn = mod.getResolvedGitExecutableForSpawn(env);
        await accessStarted;

        try {
          expect(mockedAccess).toHaveBeenLastCalledWith(
            SYSTEM_GIT,
            constants.X_OK,
          );
          const selected = await mod.validateGitExecutable('/opt/git/bin/git');
          await mod.setCachedGitExecutablePath(selected.path);
          expect(preferences.gitExecutablePath).toBe(selected.path);
          expect(process.env.CANOPY_GIT_EXECUTABLE).toBe(selected.path);
        } finally {
          releaseAccess();
        }

        expect(await spawn).toBe('/opt/git/bin/git');
        expect(process.env.CANOPY_GIT_EXECUTABLE).toBe('/opt/git/bin/git');
      },
    );

    it('reuses a validated published path with only file checks', async () => {
      install(SYSTEM_GIT);
      const { detectGitExecutable, getResolvedGitExecutableForSpawn } =
        await import('../lib/git-executable');
      await detectGitExecutable();
      mockedExecFile.mockClear();

      expect(await getResolvedGitExecutableForSpawn()).toBe(SYSTEM_GIT);
      expect(mockedExecFile).not.toHaveBeenCalled();
      expect(mockedAccess).toHaveBeenLastCalledWith(SYSTEM_GIT, constants.X_OK);
    });

    it('detects on first use instead of assuming a bare git', async () => {
      install('/usr/local/bin/git');
      const { getResolvedGitExecutableForSpawn } =
        await import('../lib/git-executable');

      expect(await getResolvedGitExecutableForSpawn()).toBe(
        '/usr/local/bin/git',
      );
      expect(process.env.CANOPY_GIT_EXECUTABLE).toBe('/usr/local/bin/git');
    });

    it('recovers when the published installation disappears', async () => {
      install('/usr/local/bin/git');
      const { getResolvedGitExecutableForSpawn } =
        await import('../lib/git-executable');
      await getResolvedGitExecutableForSpawn();
      delete files['/usr/local/bin/git'];
      install(SYSTEM_GIT);

      expect(await getResolvedGitExecutableForSpawn()).toBe(SYSTEM_GIT);
    });

    it('refuses to spawn with the reason when Git is not installed', async () => {
      const { getResolvedGitExecutableForSpawn } =
        await import('../lib/git-executable');

      await expect(getResolvedGitExecutableForSpawn()).rejects.toThrow(
        /Git was not found/,
      );
    });

    it('surfaces a broken explicit choice instead of spawning another Git', async () => {
      preferences.gitExecutablePath = '/opt/git/bin/git';
      install(SYSTEM_GIT);
      const { getResolvedGitExecutableForSpawn } =
        await import('../lib/git-executable');

      await expect(getResolvedGitExecutableForSpawn()).rejects.toThrow(
        /does not exist: \/opt\/git\/bin\/git/,
      );
      expect(probedFiles()).toEqual([]);
    });

    it('does not discard a published path over a permission error', async () => {
      install(SYSTEM_GIT);
      const { detectGitExecutable, getResolvedGitExecutableForSpawn } =
        await import('../lib/git-executable');
      await detectGitExecutable();
      files[SYSTEM_GIT] = 'unreadable';

      await expect(getResolvedGitExecutableForSpawn()).rejects.toThrow(
        /EACCES/,
      );
      expect(process.env.CANOPY_GIT_EXECUTABLE).toBe(SYSTEM_GIT);
    });

    it('consults a different saved choice before a still-valid published path', async () => {
      install(SYSTEM_GIT);
      const { detectGitExecutable, getResolvedGitExecutableForSpawn } =
        await import('../lib/git-executable');
      await detectGitExecutable();
      mockedExecFile.mockClear();

      preferences.gitExecutablePath = '/opt/git/bin/git';
      await expect(getResolvedGitExecutableForSpawn()).rejects.toThrow(
        /does not exist: \/opt\/git\/bin\/git/,
      );

      install('/opt/git/bin/git');
      expect(await getResolvedGitExecutableForSpawn()).toBe('/opt/git/bin/git');
      expect(process.env.CANOPY_GIT_EXECUTABLE).toBe('/opt/git/bin/git');
    });

    it('lets the saved choice outrank an old publication in a copied environment', async () => {
      install(SYSTEM_GIT);
      const { detectGitExecutable, getResolvedGitExecutableForSpawn } =
        await import('../lib/git-executable');
      await detectGitExecutable();
      const copied = { ...process.env };
      expect(copied.CANOPY_GIT_EXECUTABLE).toBe(SYSTEM_GIT);

      preferences.gitExecutablePath = '/opt/git/bin/git';
      await expect(getResolvedGitExecutableForSpawn(copied)).rejects.toThrow(
        /does not exist: \/opt\/git\/bin\/git/,
      );

      install('/opt/git/bin/git');
      expect(await getResolvedGitExecutableForSpawn(copied)).toBe(
        '/opt/git/bin/git',
      );
    });

    it('still probes a copied environment whose publication is the saved choice', async () => {
      preferences.gitExecutablePath = '/opt/git/bin/git';
      install('/opt/git/bin/git');
      const copied = {
        ...process.env,
        CANOPY_GIT_EXECUTABLE: '/opt/git/bin/git',
      };
      const { getResolvedGitExecutableForSpawn } =
        await import('../lib/git-executable');

      expect(await getResolvedGitExecutableForSpawn(copied)).toBe(
        '/opt/git/bin/git',
      );
      expect(probedFiles()).toEqual(['/opt/git/bin/git']);
    });

    it('validates an executable supplied through another environment', async () => {
      install('/opt/other/git');
      const env = { ...process.env, CANOPY_GIT_EXECUTABLE: '/opt/other/git' };
      const { getResolvedGitExecutableForSpawn } =
        await import('../lib/git-executable');

      expect(await getResolvedGitExecutableForSpawn(env)).toBe(
        '/opt/other/git',
      );
      expect(probedFiles()).toEqual(['/opt/other/git']);
    });
  });

  describe('native picker', () => {
    it('persists a valid Linux selection as the explicit choice', async () => {
      const selected = '/opt/git/bin/git';
      install(selected);
      mockedDialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: [selected],
      });
      const { registerGitExecutableHandlers } =
        await import('../ipc/git-executable');
      registerGitExecutableHandlers(() => null);
      const call = mockedRegisterIpcHandler.mock.calls.find(
        ([channel]) => channel === IPC_CHANNELS.gitExecutableBrowse,
      );
      const handler = call?.[1] as () => Promise<GitExecutableStatus>;

      expect(await handler()).toMatchObject({
        platform: 'linux',
        required: true,
        ready: true,
        path: selected,
        source: 'browse',
      });
      expect(preferences.gitExecutablePath).toBe(selected);
    });
  });

  describe('unsupported Linux architectures', () => {
    it('keeps Git optional and unprobed on arm64', async () => {
      setArch('arm64');
      install(SYSTEM_GIT);
      const { detectGitExecutable } = await import('../lib/git-executable');

      expect(await detectGitExecutable()).toMatchObject({
        required: false,
        ready: true,
        path: null,
        version: null,
        source: 'not-found',
      });
      expect(mockedExecFile).not.toHaveBeenCalled();
      expect(mockedStat).not.toHaveBeenCalled();
      expect(prewarmLoginShellPathMock).not.toHaveBeenCalled();
    });

    it('keeps bare git for spawns on arm64', async () => {
      setArch('arm64');
      const { getResolvedGitExecutableForSpawn } =
        await import('../lib/git-executable');

      expect(await getResolvedGitExecutableForSpawn()).toBe('git');
    });
  });
});
