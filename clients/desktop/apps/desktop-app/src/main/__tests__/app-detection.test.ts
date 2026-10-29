import type * as ChildProcessModule from 'node:child_process';
import { execFile, type ExecFileException } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import type * as OsModule from 'node:os';
import type { DetectedApp } from '@canopy/desktop-shared/types';

jest.mock('node:child_process', () => {
  const actual: typeof ChildProcessModule =
    jest.requireActual('node:child_process');
  return { ...actual, execFile: jest.fn() };
});

jest.mock('node:fs/promises', () => ({
  access: jest.fn(),
  mkdtemp: jest.fn(),
  readFile: jest.fn(),
  rm: jest.fn(),
}));

jest.mock('electron', () => ({
  app: {
    getFileIcon: jest.fn(),
  },
  nativeImage: {
    createFromPath: jest.fn(),
  },
}));

jest.mock('node:os', () => {
  const actual: typeof OsModule = jest.requireActual('node:os');
  return {
    ...actual,
    homedir: jest.fn(() => '/Users/test'),
  };
});

jest.mock('@canopy/desktop-shared/node/lib/path-lookup', () => ({
  findExecutableOnPath: jest.fn(),
}));

const mockedExecFile = jest.mocked(execFile);
const mockedAccess = jest.mocked(access);
const mockedMkdtemp = jest.mocked(mkdtemp);
const mockedReadFile = jest.mocked(readFile);
const mockedRm = jest.mocked(rm);
const pathLookupMock = jest.requireMock<{
  findExecutableOnPath: jest.MockedFunction<(name: string) => string | null>;
}>('@canopy/desktop-shared/node/lib/path-lookup');
const mockedFindExecutableOnPath = pathLookupMock.findExecutableOnPath;

interface AppDetectionModule {
  detectInstalledApps: () => Promise<DetectedApp[]>;
  getAppName: (appId: string) => string | undefined;
  getDetectedAppLaunchSpec: (
    appId: string,
    cwd: string,
  ) => Promise<{ command: string; args: string[] } | undefined>;
}

interface ResizeOptions {
  width: number;
  height: number;
  quality: 'good' | 'better' | 'best';
}

interface MockNativeImage {
  isEmpty: () => boolean;
  resize: (options: ResizeOptions) => MockNativeImage;
  toPNG: () => Buffer;
}

type ExecFileCallback = (
  error: ExecFileException | null,
  result?: { stdout: string; stderr: string },
) => void;

interface MockElectronModule {
  app: {
    getFileIcon: jest.MockedFunction<
      (
        path: string,
        options: { size: 'small' | 'normal' | 'large' },
      ) => Promise<MockNativeImage>
    >;
  };
  nativeImage: {
    createFromPath: jest.MockedFunction<(path: string) => MockNativeImage>;
  };
}

const mockedElectron: MockElectronModule = jest.requireMock('electron');
const mockedGetFileIcon = mockedElectron.app.getFileIcon;
const mockedCreateFromPath = mockedElectron.nativeImage.createFromPath;
const ORIGINAL_WINDOWS_ENV = {
  SystemRoot: process.env.SystemRoot,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  ProgramFiles: process.env.ProgramFiles,
  'ProgramFiles(x86)': process.env['ProgramFiles(x86)'],
};

function createMissingPathError(): Error {
  const error = new Error('ENOENT');
  Reflect.set(error, 'code', 'ENOENT');
  return error;
}

function normalizePathForTest(value: string): string {
  return value.replace(/\\/g, '/');
}

function isExecFileCallback(value: unknown): value is ExecFileCallback {
  return typeof value === 'function';
}

function createNativeImage(
  pngData: Buffer,
  empty = false,
): { source: MockNativeImage; resized: MockNativeImage } {
  const resizedToPng = jest.fn<Buffer, []>(() => pngData);
  const resized: MockNativeImage = {
    isEmpty: (): boolean => empty,
    resize: (): MockNativeImage => resized,
    toPNG: resizedToPng,
  };
  const sourceResize = jest.fn<MockNativeImage, [ResizeOptions]>(() => resized);
  const source: MockNativeImage = {
    isEmpty: (): boolean => empty,
    resize: sourceResize,
    toPNG: jest.fn<Buffer, []>(() => pngData),
  };

  return { source, resized };
}

async function loadAppDetectionModule(): Promise<AppDetectionModule> {
  let moduleValue: AppDetectionModule | undefined;

  await jest.isolateModulesAsync(async (): Promise<void> => {
    moduleValue = await import('../lib/app-detection');
  });

  if (!moduleValue) {
    throw new Error('Failed to load app-detection module');
  }

  return moduleValue;
}

function mockInstalledCursorApp(): void {
  mockedAccess.mockImplementation((pathArg) => {
    const path = normalizePathForTest(String(pathArg));
    if (
      path === '/Applications/Cursor.app' ||
      path === '/Applications/Cursor.app/Contents/Resources/Cursor.icns' ||
      path === '/tmp/canopy-icon-123/icon.png'
    ) {
      return Promise.resolve(undefined);
    }

    return Promise.reject(createMissingPathError());
  });
}

function mockExecFileForCursorIcon(): void {
  mockedExecFile.mockImplementation(((
    file: string,
    args: string[],
    callbackOrOptions?: unknown,
    maybeCallback?: ExecFileCallback,
  ) => {
    const callback = isExecFileCallback(callbackOrOptions)
      ? callbackOrOptions
      : maybeCallback;
    if (!callback) {
      throw new Error('Missing execFile callback');
    }

    const key = normalizePathForTest(`${file} ${args.join(' ')}`);
    if (
      key ===
      '/usr/bin/defaults read /Applications/Cursor.app/Contents/Info.plist CFBundleIconFile'
    ) {
      callback(null, { stdout: 'Cursor\n', stderr: '' });
      return;
    }

    if (
      key ===
      '/usr/bin/sips -s format png -Z 64 /Applications/Cursor.app/Contents/Resources/Cursor.icns --out /tmp/canopy-icon-123/icon.png'
    ) {
      callback(null, { stdout: '', stderr: '' });
      return;
    }

    callback(new Error(`Unexpected execFile call: ${key}`), {
      stdout: '',
      stderr: '',
    });
  }) as typeof execFile);
}

beforeEach((): void => {
  jest.clearAllMocks();
  process.env.SystemRoot = 'C:\\Windows';
  process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
  process.env.ProgramFiles = 'C:\\Program Files';
  process.env['ProgramFiles(x86)'] = 'C:\\Program Files (x86)';
  mockedMkdtemp.mockResolvedValue('/tmp/canopy-icon-123');
  mockedReadFile.mockRejectedValue(createMissingPathError());
  mockedRm.mockResolvedValue(undefined);
  mockedFindExecutableOnPath.mockReturnValue(null);
});

afterEach((): void => {
  for (const [name, value] of Object.entries(ORIGINAL_WINDOWS_ENV)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

function withPlatform<T>(
  platform: NodeJS.Platform,
  callback: () => Promise<T>,
): Promise<T> {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });

  return callback().finally(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });
}

describe('detectInstalledApps', () => {
  it('re-encodes detected app icons to sanitized PNG data URLs', async (): Promise<void> => {
    await withPlatform('darwin', async () => {
      mockInstalledCursorApp();
      mockExecFileForCursorIcon();
      const pngData = Buffer.from('png-data');
      const { source, resized } = createNativeImage(pngData);
      mockedCreateFromPath.mockReturnValue(source);

      const { detectInstalledApps, getAppName } =
        await loadAppDetectionModule();
      const result = await detectInstalledApps();

      expect(result).toEqual([
        {
          id: 'cursor',
          name: 'Cursor',
          category: 'editor',
          icon: `data:image/png;base64,${pngData.toString('base64')}`,
        },
      ]);
      expect(getAppName('cursor')).toBe('Cursor');
      expect(
        normalizePathForTest(String(mockedCreateFromPath.mock.calls[0]?.[0])),
      ).toBe('/tmp/canopy-icon-123/icon.png');
      expect(source.resize).toHaveBeenCalledWith({
        width: 64,
        height: 64,
        quality: 'best',
      });
      expect(resized.toPNG).toHaveBeenCalled();
      expect(mockedRm).toHaveBeenCalledWith(
        '/tmp/canopy-icon-123',
        expect.objectContaining({
          recursive: true,
          force: true,
        }),
      );
    });
  });

  it('coalesces concurrent detection requests', async (): Promise<void> => {
    await withPlatform('darwin', async () => {
      mockInstalledCursorApp();
      mockExecFileForCursorIcon();
      const { source } = createNativeImage(Buffer.from('png-data'));
      mockedCreateFromPath.mockReturnValue(source);

      const { detectInstalledApps } = await loadAppDetectionModule();
      const [first, second] = await Promise.all([
        detectInstalledApps(),
        detectInstalledApps(),
      ]);

      expect(second).toBe(first);
      expect(mockedExecFile).toHaveBeenCalledTimes(2);
      expect(mockedCreateFromPath).toHaveBeenCalledTimes(1);
    });
  });

  it('falls back to an empty icon when icon decoding fails', async (): Promise<void> => {
    await withPlatform('darwin', async () => {
      mockInstalledCursorApp();
      mockExecFileForCursorIcon();
      const { source } = createNativeImage(Buffer.from('png-data'), true);
      mockedCreateFromPath.mockReturnValue(source);

      const { detectInstalledApps } = await loadAppDetectionModule();
      const result = await detectInstalledApps();

      expect(result).toEqual([
        {
          id: 'cursor',
          name: 'Cursor',
          category: 'editor',
          icon: '',
        },
      ]);
    });
  });

  it('uses Electron file icons for detected Windows apps', async (): Promise<void> => {
    await withPlatform('win32', async () => {
      const explorerPath = `${process.env.SystemRoot ?? 'C:\\Windows'}\\explorer.exe`;
      mockedAccess.mockImplementation((pathArg) =>
        String(pathArg) === explorerPath
          ? Promise.resolve(undefined)
          : Promise.reject(createMissingPathError()),
      );
      const pngData = Buffer.from('windows-shell-icon');
      const { source, resized } = createNativeImage(pngData);
      mockedGetFileIcon.mockResolvedValue(source);

      const { detectInstalledApps } = await loadAppDetectionModule();
      const result = await detectInstalledApps();

      expect(result).toEqual([
        {
          id: 'file-explorer',
          name: 'File Explorer',
          category: 'file-manager',
          icon: `data:image/png;base64,${pngData.toString('base64')}`,
        },
      ]);
      expect(mockedGetFileIcon).toHaveBeenCalledWith(explorerPath, {
        size: 'normal',
      });
      expect(source.resize).toHaveBeenCalledWith({
        width: 64,
        height: 64,
        quality: 'best',
      });
      expect(resized.toPNG).toHaveBeenCalled();
      expect(mockedCreateFromPath).not.toHaveBeenCalled();
    });
  });

  it('falls back to direct executable icon loading when Electron returns an empty Windows file icon', async (): Promise<void> => {
    await withPlatform('win32', async () => {
      const explorerPath = `${process.env.SystemRoot ?? 'C:\\Windows'}\\explorer.exe`;
      mockedAccess.mockImplementation((pathArg) =>
        String(pathArg) === explorerPath
          ? Promise.resolve(undefined)
          : Promise.reject(createMissingPathError()),
      );
      const { source: emptyShellIcon } = createNativeImage(
        Buffer.alloc(0),
        true,
      );
      mockedGetFileIcon.mockResolvedValue(emptyShellIcon);
      const pngData = Buffer.from('windows-exe-icon');
      const { source } = createNativeImage(pngData);
      mockedCreateFromPath.mockReturnValue(source);

      const { detectInstalledApps } = await loadAppDetectionModule();
      const result = await detectInstalledApps();

      expect(result).toEqual([
        {
          id: 'file-explorer',
          name: 'File Explorer',
          category: 'file-manager',
          icon: `data:image/png;base64,${pngData.toString('base64')}`,
        },
      ]);
      expect(mockedCreateFromPath).toHaveBeenCalledWith(explorerPath);
    });
  });

  it('adds visible Windows Terminal profiles from settings.json', async (): Promise<void> => {
    await withPlatform('win32', async () => {
      const wtPath = `${process.env.LOCALAPPDATA ?? ''}\\Microsoft\\WindowsApps\\wt.exe`;
      mockedAccess.mockImplementation((pathArg) =>
        String(pathArg) === wtPath
          ? Promise.resolve(undefined)
          : Promise.reject(createMissingPathError()),
      );
      mockedReadFile.mockResolvedValue(`{
        "defaultProfile": "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}",
        // JSONC comments are allowed by Windows Terminal settings.
        "profiles": {
          "list": [
            { "name": "PowerShell", "guid": "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}", "commandline": "%SystemRoot%\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" },
            { "name": "Command Prompt", "icon": "CommandPrompt.png", },
            { "name": "Developer Command Prompt for VS 18", "source": "Windows.Terminal.VisualStudio" },
            { "name": "Azure Cloud Shell", "source": "Windows.Terminal.Azure" },
            { "name": "Git Bash", "commandline": "C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe", "icon": "\\ue756" },
            { "name": "Hidden", "hidden": true }
          ],
        },
      }`);
      const terminalPngData = Buffer.from('windows-terminal-icon');
      const powershellPngData = Buffer.from('powershell-icon');
      const profilePngData = Buffer.from('profile-icon');
      const { source: terminalIcon } = createNativeImage(terminalPngData);
      const { source: powershellIcon } = createNativeImage(powershellPngData);
      const { source: profileIcon } = createNativeImage(profilePngData);
      mockedGetFileIcon.mockImplementation((pathArg) =>
        String(pathArg).includes('powershell.exe')
          ? Promise.resolve(powershellIcon)
          : Promise.resolve(terminalIcon),
      );
      mockedCreateFromPath.mockImplementation((pathArg) =>
        String(pathArg).includes('CommandPrompt.png')
          ? profileIcon
          : createNativeImage(Buffer.alloc(0), true).source,
      );

      const { detectInstalledApps } = await loadAppDetectionModule();
      const result = await detectInstalledApps();

      expect(result.map((app) => app.name)).toEqual([
        'Windows Terminal',
        'Windows Terminal: PowerShell',
        'Windows Terminal: Command Prompt',
        'Windows Terminal: Developer Command Prompt for VS 18',
        'Windows Terminal: Azure Cloud Shell',
        'Windows Terminal: Git Bash',
      ]);
      expect(result.map((app) => app.id)).toEqual([
        'windows-terminal',
        'windows-terminal-profile:UG93ZXJTaGVsbA',
        'windows-terminal-profile:Q29tbWFuZCBQcm9tcHQ',
        'windows-terminal-profile:RGV2ZWxvcGVyIENvbW1hbmQgUHJvbXB0IGZvciBWUyAxOA',
        'windows-terminal-profile:QXp1cmUgQ2xvdWQgU2hlbGw',
        'windows-terminal-profile:R2l0IEJhc2g',
      ]);
      expect(result[0]?.icon).toBe(
        `data:image/png;base64,${powershellPngData.toString('base64')}`,
      );
      expect(result[1]?.icon).toBe(
        `data:image/png;base64,${powershellPngData.toString('base64')}`,
      );
      expect(result[2]?.icon).toBe(
        `data:image/png;base64,${profilePngData.toString('base64')}`,
      );
      expect(result[3]?.icon).toContain('data:image/svg+xml');
      expect(result[4]?.icon).toContain('data:image/svg+xml');
      expect(result[5]?.icon).toContain('data:image/svg+xml');
      expect(
        normalizePathForTest(String(mockedCreateFromPath.mock.calls[0]?.[0])),
      ).toContain('/LocalState/CommandPrompt.png');
    });
  });

  it('wraps Windows command shims for app launch specs', async (): Promise<void> => {
    await withPlatform('win32', async () => {
      mockedAccess.mockRejectedValue(createMissingPathError());
      mockedFindExecutableOnPath.mockImplementation((name) =>
        name === 'code.cmd' ? 'C:\\Users\\test\\bin\\code.cmd' : null,
      );

      const { getDetectedAppLaunchSpec } = await loadAppDetectionModule();
      const result = await getDetectedAppLaunchSpec(
        'vscode',
        'C:\\work tree\\repo',
      );

      expect(result?.command).toMatch(/cmd(?:\.exe)?$/i);
      expect(result?.args).toEqual([
        '/d',
        '/s',
        '/c',
        'C:\\Users\\test\\bin\\code.cmd "C:\\work tree\\repo"',
      ]);
    });
  });

  it('leaves Windows exe app launch specs direct', async (): Promise<void> => {
    await withPlatform('win32', async () => {
      mockedAccess.mockRejectedValue(createMissingPathError());
      mockedFindExecutableOnPath.mockImplementation((name) =>
        name === 'code.exe' ? 'C:\\Users\\test\\bin\\Code.exe' : null,
      );

      const { getDetectedAppLaunchSpec } = await loadAppDetectionModule();
      const result = await getDetectedAppLaunchSpec('vscode', 'C:\\repo');

      expect(result).toMatchObject({
        command: 'C:\\Users\\test\\bin\\Code.exe',
        args: ['C:\\repo'],
      });
    });
  });

  it('launches PowerShell directly with the worktree as process cwd', async (): Promise<void> => {
    await withPlatform('win32', async () => {
      mockedAccess.mockRejectedValue(createMissingPathError());
      mockedFindExecutableOnPath.mockImplementation((name) =>
        name === 'pwsh.exe'
          ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
          : null,
      );

      const { getDetectedAppLaunchSpec } = await loadAppDetectionModule();
      const result = await getDetectedAppLaunchSpec(
        'powershell',
        "C:\\work tree\\repo's",
      );

      expect(result).toMatchObject({
        command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"',
        args: ['-NoLogo', '-NoExit'],
        cwd: "C:\\work tree\\repo's",
        shell: true,
      });
    });
  });

  it('launches Windows Terminal profiles into the selected worktree', async (): Promise<void> => {
    await withPlatform('win32', async () => {
      const wtPath = `${process.env.LOCALAPPDATA ?? ''}\\Microsoft\\WindowsApps\\wt.exe`;
      mockedAccess.mockImplementation((pathArg) =>
        String(pathArg) === wtPath
          ? Promise.resolve(undefined)
          : Promise.reject(createMissingPathError()),
      );

      const { getDetectedAppLaunchSpec } = await loadAppDetectionModule();
      const result = await getDetectedAppLaunchSpec(
        'windows-terminal-profile:Q29tbWFuZCBQcm9tcHQ',
        'C:\\repo',
      );

      expect(result).toMatchObject({
        id: 'windows-terminal-profile:Q29tbWFuZCBQcm9tcHQ',
        name: 'Windows Terminal: Command Prompt',
        command: wtPath,
        args: [
          'new-tab',
          '--profile',
          'Command Prompt',
          '--startingDirectory',
          'C:\\repo',
        ],
      });
    });
  });
});
