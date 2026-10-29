jest.mock('node:child_process', () => {
  const actual: Record<string, unknown> =
    jest.requireActual('node:child_process');
  return { ...actual, execFile: jest.fn() };
});

jest.mock('node:fs/promises', () => ({
  lstat: jest.fn(),
  mkdir: jest.fn(),
  readlink: jest.fn(),
  symlink: jest.fn(),
  unlink: jest.fn(),
}));

jest.mock('@canopy/core-platform', () => {
  const actual: {
    hostPlatformOperatingSystem: typeof hostPlatformOperatingSystem;
    PlatformServicesError: typeof PlatformServicesError;
  } = jest.requireActual('@canopy/core-platform');
  return {
    ...actual,
    hostPlatformOperatingSystem: jest.fn(actual.hostPlatformOperatingSystem),
  };
});

jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyRuntimeMode: jest.fn(() => 'prod'),
}));

jest.mock('../pipelines/config-paths', () => ({
  getBundledCanopyCliPath: jest.fn(
    () => '/Applications/Canopy.app/Contents/Resources/cli/canopy',
  ),
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

import {
  ChildProcess,
  execFile,
  type ExecFileException,
  type ExecFileOptions,
} from 'node:child_process';
import { lstat, mkdir, readlink, symlink, unlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getCanopyRuntimeMode } from '@canopy/desktop-shared/canopy-paths';
import {
  hostPlatformOperatingSystem,
  PlatformServicesError,
} from '@canopy/core-platform';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { getBundledCanopyCliPath } from '../pipelines/config-paths';
import { registerIpcHandler } from '../ipc/register';
import {
  addWindowsPathEntry,
  getCliPathStatus,
  installCliToPath,
  registerCliHandlers,
  removeWindowsPathEntry,
  splitWindowsPathEntries,
  uninstallCliFromPath,
  windowsPathContainsEntry,
} from '../ipc/cli';

const actualCorePlatform: {
  hostPlatformOperatingSystem: typeof hostPlatformOperatingSystem;
  PlatformServicesError: typeof PlatformServicesError;
} = jest.requireActual('@canopy/core-platform');
const mockedHostPlatformOperatingSystem = jest.mocked(
  hostPlatformOperatingSystem,
);
const mockedExecFile = jest.mocked(execFile);
const mockedLstat = jest.mocked(lstat);
const mockedMkdir = jest.mocked(mkdir);
const mockedReadlink = jest.mocked(readlink);
const mockedSymlink = jest.mocked(symlink);
const mockedUnlink = jest.mocked(unlink);
const mockedGetCanopyRuntimeMode = jest.mocked(getCanopyRuntimeMode);
const mockedGetBundledCanopyCliPath = jest.mocked(getBundledCanopyCliPath);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);

type ExecFileCallback = (
  error: ExecFileException | null,
  result?: { stdout: string; stderr: string },
) => void;

type ExecFileNodeCallback = (
  error: ExecFileException | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

type ActualFsPromises = {
  lstat: typeof lstat;
  mkdtemp: (prefix: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  symlink: (target: string, path: string) => Promise<void>;
  rm: (
    path: string,
    options: { recursive?: boolean; force?: boolean },
  ) => Promise<void>;
};

type HandlerFn = () => Promise<unknown>;

const actualFsPromises: ActualFsPromises =
  jest.requireActual('node:fs/promises');

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  'platform',
);

let getStatusHandler: HandlerFn;
let installHandler: HandlerFn;
let uninstallHandler: HandlerFn;
const tempDirs: string[] = [];

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value,
  });
}

function createMissingPathError(): Error {
  const error = new Error('ENOENT');
  Reflect.set(error, 'code', 'ENOENT');
  return error;
}

function createPermissionError(code: 'EACCES' | 'EPERM'): Error {
  const error = new Error(code);
  Reflect.set(error, 'code', code);
  return error;
}

function createMissingRegistryValueError(): ExecFileException {
  const error = new Error(
    'ERROR: The system was unable to find the specified registry key or value.',
  ) as ExecFileException;
  Reflect.set(error, 'code', 1);
  return error;
}

function createGenericRegistryExitOneError(): ExecFileException {
  const error = new Error('ERROR: Access is denied.') as ExecFileException;
  Reflect.set(error, 'code', 1);
  return error;
}

async function createStats(
  isSymbolicLinkValue: boolean,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  const tempDir = await actualFsPromises.mkdtemp(
    path.join(os.tmpdir(), 'canopy-cli-ipc-'),
  );
  const targetPath = path.join(tempDir, 'canopy');

  tempDirs.push(tempDir);
  await actualFsPromises.writeFile(targetPath, 'test');

  if (!isSymbolicLinkValue) {
    return actualFsPromises.lstat(targetPath);
  }

  const symlinkPath = path.join(tempDir, 'canopy-link');
  await actualFsPromises.symlink(targetPath, symlinkPath);

  return actualFsPromises.lstat(symlinkPath);
}

function mockExecFileResult(error: ExecFileException | null): void {
  mockExecFileOutput(error, '');
}

function mockExecFileOutput(
  error: ExecFileException | null,
  stdout = '',
): void {
  mockedExecFile.mockImplementation(function mockExecFile(
    _file: string,
    _args: readonly string[] | null | undefined,
    optionsOrCallback?:
      | ExecFileOptions
      | ExecFileCallback
      | ExecFileNodeCallback
      | null,
    cb?: ExecFileCallback | ExecFileNodeCallback | null,
  ): ChildProcess {
    if (typeof cb === 'function') {
      Reflect.apply(cb, undefined, [error, { stdout, stderr: '' }, '']);
      return new ChildProcess();
    }

    if (typeof optionsOrCallback === 'function') {
      Reflect.apply(optionsOrCallback, undefined, [
        error,
        { stdout, stderr: '' },
      ]);
    }

    return new ChildProcess();
  });
}

function getRegisteredHandler(channel: string): HandlerFn {
  const entry = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );

  if (!entry) {
    throw new Error(`Expected IPC handler for ${channel}`);
  }

  const [, handler] = entry;

  return async (): Promise<unknown> =>
    Promise.resolve(Reflect.apply(handler, undefined, []));
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry: unknown): entry is string => typeof entry === 'string')
  );
}

function getPrivilegedAppleScript(): string {
  const invocation = mockedExecFile.mock.calls.find(
    ([filePath]) => filePath === '/usr/bin/osascript',
  );

  if (!invocation) {
    throw new Error('Expected osascript invocation');
  }

  const [, args] = invocation;
  if (!isStringArray(args)) {
    throw new Error('Expected osascript arguments');
  }

  const appleScript = args[1];
  if (typeof appleScript !== 'string') {
    throw new Error('Expected AppleScript payload');
  }

  return appleScript;
}

function decodePrivilegedCommand(appleScript: string): string {
  const encodedCommandMatch = appleScript.match(/[A-Za-z0-9+/=]{20,}/);

  if (!encodedCommandMatch) {
    throw new Error('Expected base64-encoded privileged command');
  }

  return Buffer.from(encodedCommandMatch[0], 'base64').toString('utf8');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedHostPlatformOperatingSystem
    .mockReset()
    .mockImplementation(actualCorePlatform.hostPlatformOperatingSystem);
  setPlatform('darwin');
  mockedGetCanopyRuntimeMode.mockReturnValue('prod');
  mockedGetBundledCanopyCliPath.mockReturnValue(
    '/Applications/Canopy.app/Contents/Resources/cli/canopy',
  );
  mockedMkdir.mockResolvedValue(undefined);
  mockedSymlink.mockResolvedValue(undefined);
  mockedUnlink.mockResolvedValue(undefined);
  mockExecFileResult(null);

  registerCliHandlers();

  getStatusHandler = getRegisteredHandler(IPC_CHANNELS.cliGetStatus);
  installHandler = getRegisteredHandler(IPC_CHANNELS.cliInstallToPath);
  uninstallHandler = getRegisteredHandler(IPC_CHANNELS.cliUninstallFromPath);
});

afterAll(() => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
});

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) =>
        actualFsPromises.rm(tempDir, { recursive: true, force: true }),
      ),
  );
});

describe('registerCliHandlers', () => {
  it('registers all CLI IPC handlers', () => {
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.cliGetStatus,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.cliInstallToPath,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.cliUninstallFromPath,
      expect.any(Function),
    );
  });
});

describe('getCliPathStatus', () => {
  it('uses the host platform service independently of the ambient process OS for every operation', async () => {
    mockedLstat.mockRejectedValue(createMissingPathError());
    const environment = jest.replaceProperty(process, 'env', {
      ...process.env,
      PATH: '',
      Path: 'C:\\Tools',
    });
    try {
      setPlatform('darwin');
      mockedHostPlatformOperatingSystem.mockReturnValue('win32');
      mockExecFileOutput(null, 'Path    REG_EXPAND_SZ    C:\\Tools\r\n');
      mockedGetBundledCanopyCliPath.mockReturnValue(
        'C:\\Canopy\\cli\\canopy.exe',
      );

      expect(await getCliPathStatus()).toMatchObject({
        state: 'missing',
        managedPathEntry: 'C:\\Canopy\\cli',
      });
      expect(await installCliToPath()).toEqual({ success: true, error: null });
      expect(mockedExecFile).toHaveBeenCalledWith(
        'reg',
        expect.arrayContaining(['add', 'HKCU\\Environment']),
        { windowsHide: true },
        expect.any(Function),
      );
      mockExecFileOutput(null, 'Path    REG_EXPAND_SZ    C:\\Canopy\\cli\r\n');
      expect(await uninstallCliFromPath()).toEqual({
        success: true,
        error: null,
      });
      expect(mockedLstat).not.toHaveBeenCalled();
      expect(mockedSymlink).not.toHaveBeenCalled();
      expect(mockedUnlink).not.toHaveBeenCalled();
    } finally {
      environment.restore();
    }
  });

  it('propagates platform-service failures other than unsupported_platform', async () => {
    mockedLstat.mockRejectedValue(createMissingPathError());
    const error = new PlatformServicesError(
      'endpoint_semantics_mismatch',
      'unexpected platform service failure',
    );
    mockedHostPlatformOperatingSystem.mockImplementation(() => {
      throw error;
    });
    await expect(getCliPathStatus()).rejects.toBe(error);
    await expect(installCliToPath()).rejects.toBe(error);
    await expect(uninstallCliFromPath()).rejects.toBe(error);
  });

  it('preserves dev results before unsupported host rejection', async () => {
    setPlatform('freebsd');
    mockedGetCanopyRuntimeMode.mockReturnValue('dev');
    expect(await getCliPathStatus()).toMatchObject({
      state: 'unsupported',
      reason: 'dev',
      symlinkPath: null,
      bundledCliPath: null,
    });
    expect(await installCliToPath()).toEqual({
      success: false,
      error: 'CLI PATH installation is unavailable in development mode.',
    });
    expect(await uninstallCliFromPath()).toEqual({
      success: false,
      error: 'CLI PATH installation is unavailable in development mode.',
    });
  });

  it('returns unsupported in development mode without probing the filesystem', async () => {
    mockedGetCanopyRuntimeMode.mockReturnValue('dev');

    const result = await getCliPathStatus();

    expect(result).toEqual({
      state: 'unsupported',
      reason: 'dev',
      symlinkPath: '/usr/local/bin/canopy',
      symlinkTarget: null,
      bundledCliPath: '/Applications/Canopy.app/Contents/Resources/cli/canopy',
    });
    expect(mockedLstat).not.toHaveBeenCalled();
  });

  it('returns unsupported on unsupported platforms without probing the filesystem', async () => {
    setPlatform('freebsd');

    const result = await getCliPathStatus();

    expect(result.state).toBe('unsupported');
    expect(result.reason).toBe('unsupported-platform');
    expect(mockedLstat).not.toHaveBeenCalled();
  });

  it('reports the per-user Linux launcher even when its directory is absent from PATH', async () => {
    setPlatform('linux');
    mockedLstat.mockRejectedValue(createMissingPathError());
    const environment = jest.replaceProperty(process, 'env', {
      ...process.env,
      XDG_DATA_HOME: '',
      XDG_BIN_HOME: '',
      PATH: '/usr/bin:/bin',
    });
    try {
      const result = await getCliPathStatus();
      expect(result.state).toBe('missing');
      expect(result.managedPathEntry).toBe(
        path.join(os.homedir(), '.local', 'bin'),
      );
      expect(result.symlinkPath).toBe(
        path.join(os.homedir(), '.local', 'bin', 'canopy'),
      );
    } finally {
      environment.restore();
    }
  });

  it('returns installed when the Windows managed PATH entry exists', async () => {
    setPlatform('win32');
    mockedGetBundledCanopyCliPath.mockReturnValue(
      'C:\\Program Files\\Canopy\\resources\\cli\\canopy.exe',
    );
    mockExecFileOutput(
      null,
      'Path    REG_EXPAND_SZ    C:\\Tools;C:\\Program Files\\Canopy\\resources\\cli\r\n',
    );

    const result = await getCliPathStatus();

    expect(result).toEqual({
      state: 'installed',
      symlinkPath: null,
      symlinkTarget: null,
      bundledCliPath: 'C:\\Program Files\\Canopy\\resources\\cli\\canopy.exe',
      managedPathEntry: 'C:\\Program Files\\Canopy\\resources\\cli',
    });
  });

  it('treats a missing Windows user PATH registry value as an empty PATH', async () => {
    setPlatform('win32');
    mockedGetBundledCanopyCliPath.mockReturnValue(
      'C:\\Program Files\\Canopy\\resources\\cli\\canopy.exe',
    );
    mockExecFileResult(createMissingRegistryValueError());

    const result = await getCliPathStatus();

    expect(result).toEqual({
      state: 'missing',
      symlinkPath: null,
      symlinkTarget: null,
      bundledCliPath: 'C:\\Program Files\\Canopy\\resources\\cli\\canopy.exe',
      managedPathEntry: 'C:\\Program Files\\Canopy\\resources\\cli',
    });
  });

  it('does not treat every reg.exe exit-code-1 failure as missing PATH', async () => {
    setPlatform('win32');
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    mockedGetBundledCanopyCliPath.mockReturnValue(
      'C:\\Program Files\\Canopy\\resources\\cli\\canopy.exe',
    );
    mockExecFileResult(createGenericRegistryExitOneError());

    try {
      await expect(getCliPathStatus()).rejects.toThrow(
        'ERROR: Access is denied.',
      );
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  it('returns missing when no CLI symlink exists', async () => {
    mockedLstat.mockRejectedValue(createMissingPathError());

    const result = await getCliPathStatus();

    expect(result).toEqual({
      state: 'missing',
      symlinkPath: '/usr/local/bin/canopy',
      symlinkTarget: null,
      bundledCliPath: '/Applications/Canopy.app/Contents/Resources/cli/canopy',
    });
  });

  it('returns regular-file when the path is occupied by a non-symlink', async () => {
    mockedLstat.mockResolvedValue(await createStats(false));

    const result = await getCliPathStatus();

    expect(result.state).toBe('regular-file');
    expect(result.symlinkTarget).toBeNull();
  });

  it('returns correct-symlink when the bundled CLI is already installed', async () => {
    mockedLstat.mockResolvedValue(await createStats(true));
    mockedReadlink.mockResolvedValue(
      '/Applications/Canopy.app/Contents/Resources/cli/canopy',
    );

    const result = await getCliPathStatus();

    expect(result.state).toBe('correct-symlink');
  });

  it('returns foreign-symlink when another target is installed', async () => {
    mockedLstat.mockResolvedValue(await createStats(true));
    mockedReadlink.mockResolvedValue('/usr/local/opt/canopy/bin/canopy');

    const result = await getCliPathStatus();

    expect(result.state).toBe('foreign-symlink');
    expect(result.symlinkTarget).toBe('/usr/local/opt/canopy/bin/canopy');
  });

  it('exposes the status handler through IPC', async () => {
    mockedLstat.mockRejectedValue(createMissingPathError());

    const result = await getStatusHandler();

    expect(result).toEqual({
      state: 'missing',
      symlinkPath: '/usr/local/bin/canopy',
      symlinkTarget: null,
      bundledCliPath: '/Applications/Canopy.app/Contents/Resources/cli/canopy',
    });
  });
});

describe('installCliToPath', () => {
  it('installs the CLI symlink directly when writable', async () => {
    mockedLstat.mockRejectedValue(createMissingPathError());

    const result = await installCliToPath();

    expect(result).toEqual({ success: true, error: null });
    expect(mockedMkdir).toHaveBeenCalledWith('/usr/local/bin', {
      recursive: true,
    });
    expect(mockedSymlink).toHaveBeenCalledWith(
      '/Applications/Canopy.app/Contents/Resources/cli/canopy',
      '/usr/local/bin/canopy',
    );
  });

  it('returns success without changing anything when already installed', async () => {
    mockedLstat.mockResolvedValue(await createStats(true));
    mockedReadlink.mockResolvedValue(
      '/Applications/Canopy.app/Contents/Resources/cli/canopy',
    );

    const result = await installCliToPath();

    expect(result).toEqual({ success: true, error: null });
    expect(mockedMkdir).not.toHaveBeenCalled();
    expect(mockedSymlink).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a foreign symlink', async () => {
    mockedLstat.mockResolvedValue(await createStats(true));
    mockedReadlink.mockResolvedValue('/opt/homebrew/bin/canopy');

    const result = await installCliToPath();

    expect(result.success).toBe(false);
    expect(result.error).toContain('/usr/local/bin/canopy');
    expect(mockedSymlink).not.toHaveBeenCalled();
  });

  it('falls back to osascript on permission errors', async () => {
    mockedLstat.mockRejectedValue(createMissingPathError());
    mockedSymlink.mockRejectedValue(createPermissionError('EACCES'));

    const result = await installCliToPath();
    const appleScript = getPrivilegedAppleScript();
    const privilegedCommand = decodePrivilegedCommand(appleScript);

    expect(result).toEqual({ success: true, error: null });
    expect(mockedExecFile).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      ['-e', appleScript],
      { windowsHide: false },
      expect.any(Function),
    );
    expect(appleScript).toContain('/usr/bin/base64 -D | /bin/bash');
    expect(privilegedCommand).toContain('/usr/local/bin/canopy');
    expect(privilegedCommand).toContain(
      '/Applications/Canopy.app/Contents/Resources/cli/canopy',
    );
    expect(privilegedCommand).toContain('\n');
    expect(privilegedCommand).toContain(
      'if [ -L "/usr/local/bin/canopy" ]; then',
    );
  });

  it('returns unsupported errors in development mode', async () => {
    mockedGetCanopyRuntimeMode.mockReturnValue('dev');

    const result = await installHandler();

    expect(result).toEqual({
      success: false,
      error: 'CLI PATH installation is unavailable in development mode.',
    });
  });

  it('adds the packaged CLI directory to the Windows user PATH', async () => {
    setPlatform('win32');
    const originalPath = process.env.PATH;
    const originalWindowsPath = process.env.Path;
    process.env.PATH = '';
    process.env.Path = 'C:\\Windows\\System32;C:\\Tools';
    mockedGetBundledCanopyCliPath.mockReturnValue(
      'C:\\Program Files\\Canopy\\resources\\cli\\canopy.exe',
    );
    mockExecFileOutput(null, 'Path    REG_EXPAND_SZ    C:\\Tools\r\n');

    try {
      const result = await installCliToPath();

      expect(result).toEqual({ success: true, error: null });
      expect(mockedExecFile).toHaveBeenCalledWith(
        'reg',
        expect.arrayContaining([
          'add',
          'HKCU\\Environment',
          '/v',
          'Path',
          '/d',
          'C:\\Tools;C:\\Program Files\\Canopy\\resources\\cli',
        ]),
        { windowsHide: true },
        expect.any(Function),
      );
      expect(process.env.Path).toBe(
        'C:\\Windows\\System32;C:\\Tools;C:\\Program Files\\Canopy\\resources\\cli',
      );
      expect(process.env.PATH).toBe(
        'C:\\Windows\\System32;C:\\Tools;C:\\Program Files\\Canopy\\resources\\cli',
      );
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalWindowsPath === undefined) {
        delete process.env.Path;
      } else {
        process.env.Path = originalWindowsPath;
      }
    }
  });

  it('preserves raw expandable Windows PATH entries through PowerShell', async () => {
    setPlatform('win32');
    const originalPath = process.env.PATH;
    const originalWindowsPath = process.env.Path;
    const tempDir = await actualFsPromises.mkdtemp(
      path.join(os.tmpdir(), 'canopy-cli-pwsh-'),
    );
    tempDirs.push(tempDir);
    const powershellPath = path.join(tempDir, 'pwsh.exe');
    await actualFsPromises.writeFile(powershellPath, '');
    process.env.PATH = tempDir;
    process.env.Path = 'C:\\Windows\\System32;C:\\Tools';
    mockedGetBundledCanopyCliPath.mockReturnValue(
      'C:\\Program Files\\Canopy\\resources\\cli\\canopy.exe',
    );
    mockedExecFile.mockImplementation(function mockExecFile(
      _file: string,
      _args: readonly string[] | null | undefined,
      optionsOrCallback?:
        | ExecFileOptions
        | ExecFileCallback
        | ExecFileNodeCallback
        | null,
      cb?: ExecFileCallback | ExecFileNodeCallback | null,
    ): ChildProcess {
      const callback =
        typeof cb === 'function'
          ? cb
          : typeof optionsOrCallback === 'function'
            ? optionsOrCallback
            : null;
      const command = isStringArray(_args)
        ? (_args[_args.length - 1] ?? '')
        : '';
      const stdout =
        typeof command === 'string' && command.includes('GetValue')
          ? 'C:\\Tools;%USERPROFILE%\\bin\r\n'
          : '';

      if (callback) {
        Reflect.apply(callback, undefined, [null, { stdout, stderr: '' }]);
      }

      return new ChildProcess();
    });

    try {
      const result = await installCliToPath();
      const commands = mockedExecFile.mock.calls
        .map(([, args]) =>
          isStringArray(args) ? (args[args.length - 1] ?? null) : null,
        )
        .filter((command): command is string => typeof command === 'string');

      expect(result).toEqual({ success: true, error: null });
      expect(commands).toContain(
        "$environment = Get-Item -LiteralPath HKCU:\\Environment; $environment.GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
      );
      expect(commands).toContain(
        "Set-ItemProperty -LiteralPath HKCU:\\Environment -Name 'Path' -Value 'C:\\Tools;%USERPROFILE%\\bin;C:\\Program Files\\Canopy\\resources\\cli' -Type ExpandString",
      );
      expect(
        commands.some((command) => command.includes('SendMessageTimeout')),
      ).toBe(true);
      expect(process.env.Path).toBe(
        'C:\\Windows\\System32;C:\\Tools;C:\\Program Files\\Canopy\\resources\\cli',
      );
      expect(process.env.PATH).toBe(
        'C:\\Windows\\System32;C:\\Tools;C:\\Program Files\\Canopy\\resources\\cli',
      );
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalWindowsPath === undefined) {
        delete process.env.Path;
      } else {
        process.env.Path = originalWindowsPath;
      }
    }
  });
});

describe('uninstallCliFromPath', () => {
  it('removes the managed symlink', async () => {
    mockedLstat.mockResolvedValue(await createStats(true));
    mockedReadlink.mockResolvedValue(
      '/Applications/Canopy.app/Contents/Resources/cli/canopy',
    );

    const result = await uninstallCliFromPath();

    expect(result).toEqual({ success: true, error: null });
    expect(mockedUnlink).toHaveBeenCalledWith('/usr/local/bin/canopy');
  });

  it('returns success when the symlink is already missing', async () => {
    mockedLstat.mockRejectedValue(createMissingPathError());

    const result = await uninstallCliFromPath();

    expect(result).toEqual({ success: true, error: null });
    expect(mockedUnlink).not.toHaveBeenCalled();
  });

  it('refuses to remove a foreign entry', async () => {
    mockedLstat.mockResolvedValue(await createStats(true));
    mockedReadlink.mockResolvedValue('/opt/homebrew/bin/canopy');

    const result = await uninstallCliFromPath();

    expect(result.success).toBe(false);
    expect(result.error).toContain('not managed by Canopy');
    expect(mockedUnlink).not.toHaveBeenCalled();
  });

  it('falls back to osascript on permission errors', async () => {
    mockedLstat.mockResolvedValue(await createStats(true));
    mockedReadlink.mockResolvedValue(
      '/Applications/Canopy.app/Contents/Resources/cli/canopy',
    );
    mockedUnlink.mockRejectedValue(createPermissionError('EPERM'));

    const result = await uninstallCliFromPath();
    const privilegedCommand = decodePrivilegedCommand(
      getPrivilegedAppleScript(),
    );

    expect(result).toEqual({ success: true, error: null });
    expect(privilegedCommand).toContain('/usr/local/bin/canopy');
    expect(privilegedCommand).toContain('\n');
  });

  it('returns unsupported errors on unsupported platforms', async () => {
    setPlatform('freebsd');

    const result = await uninstallHandler();

    expect(result).toEqual({
      success: false,
      error:
        'CLI PATH installation is only available on macOS, Windows, and Linux.',
    });
  });
});

describe('Windows PATH helpers', () => {
  it('splits, adds, detects, and removes entries case-insensitively', () => {
    const existing = 'C:\\Tools;C:\\Users\\me\\bin\\';
    const entry = 'c:\\users\\me\\bin';

    expect(splitWindowsPathEntries(existing)).toEqual([
      'C:\\Tools',
      'C:\\Users\\me\\bin\\',
    ]);
    expect(windowsPathContainsEntry(existing, entry)).toBe(true);
    expect(addWindowsPathEntry(existing, entry)).toBe(existing);
    expect(addWindowsPathEntry(existing, 'C:\\Canopy')).toBe(
      'C:\\Tools;C:\\Users\\me\\bin\\;C:\\Canopy',
    );
    expect(removeWindowsPathEntry(existing, entry)).toBe('C:\\Tools');
  });
});
