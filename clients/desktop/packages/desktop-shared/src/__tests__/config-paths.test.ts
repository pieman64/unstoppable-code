import type * as Fs from 'node:fs';
import type * as ChildProcess from 'node:child_process';
import * as path from 'node:path';
import {
  constants,
  existsSync,
  realpathSync,
  readFileSync,
  type PathLike,
} from 'node:fs';
import { findExecutableOnPath } from '../node/lib/path-lookup';
import type * as ConfigPathsModule from '../pipelines/config-paths';

jest.mock('node:fs', () => ({
  constants: jest.requireActual<typeof Fs>('node:fs').constants,
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  realpathSync: jest.fn((input: PathLike) => input.toString()),
}));

jest.mock('../node/lib/path-lookup', () => ({
  findExecutableOnPath: jest.fn(),
}));

jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof ChildProcess>('node:child_process'),
  // Keep real spawnSync layout proof; never run host startup profiles when
  // these suites simulate a different platform's login-shell resolver.
  execFile: jest.fn(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      queueMicrotask(() =>
        callback(new Error('fixture: login probe unavailable'), '', ''),
      );
      return { unref: jest.fn() };
    },
  ),
}));

describe('shared config paths', () => {
  const originalProcess = process;
  const originalProcessDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'process',
  );
  const loadedConfigs: Array<typeof ConfigPathsModule> = [];
  const mockedExistsSync = jest.mocked(existsSync);
  const mockedFindExecutableOnPath = jest.mocked(findExecutableOnPath);
  const mockedRealpathSync = jest.mocked(realpathSync);

  interface ProcessOverrides {
    platform?: NodeJS.Platform;
    arch?: string;
    execPath?: string;
    resourcesPath?: string | undefined;
    env?: Record<string, string | undefined>;
  }

  function getBaseEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...originalProcess.env };

    delete env.CANOPY_ENV;
    delete env.CANOPY_ENABLE_LINUX_ARM64_DEVELOPMENT;
    delete env.CANOPY_CLAUDE_BINARY_PATH;
    delete env.CANOPY_CODEX_BINARY_PATH;
    delete env.CANOPY_GH_BINARY_PATH;
    delete env.CANOPY_OLLAMA_BINARY_PATH;
    delete env.CANOPY_RTK_BINARY_PATH;
    delete env.CANOPY_RG_BINARY_PATH;
    delete env.CANOPY_DICTATE_BINARY_PATH;
    delete env.CANOPY_BUNDLED_RESOURCES_DIR;
    delete env.CANOPY_DATA_DIR;
    delete env.CANOPY_ENV_ENHANCED;
    delete env.CLAUDE_CODE_EXECUTABLE;
    delete env.CODEX_EXECUTABLE;
    delete env.GH_EXECUTABLE;
    delete env.OLLAMA_EXECUTABLE;
    delete env.RTK_EXECUTABLE;
    delete env.RG_EXECUTABLE;
    delete env.DICTATE_EXECUTABLE;
    delete env.NODE_ENV;

    return env;
  }

  function setProcessState(overrides: ProcessOverrides): void {
    const nextProcess: Record<string, unknown> = {};
    Object.setPrototypeOf(nextProcess, originalProcess);
    const env = getBaseEnv();

    if (overrides.env) {
      for (const [key, value] of Object.entries(overrides.env)) {
        if (value === undefined) {
          delete env[key];
        } else {
          env[key] = value;
        }
      }
    }

    Object.defineProperty(nextProcess, 'env', {
      configurable: true,
      value: env,
    });

    if (overrides.platform !== undefined) {
      Object.defineProperty(nextProcess, 'platform', {
        configurable: true,
        value: overrides.platform,
      });
    }
    if (overrides.arch !== undefined) {
      Object.defineProperty(nextProcess, 'arch', {
        configurable: true,
        value: overrides.arch,
      });
    }
    if (overrides.execPath !== undefined) {
      Object.defineProperty(nextProcess, 'execPath', {
        configurable: true,
        value: overrides.execPath,
      });
    }
    if (Object.prototype.hasOwnProperty.call(overrides, 'resourcesPath')) {
      Object.defineProperty(nextProcess, 'resourcesPath', {
        configurable: true,
        value: overrides.resourcesPath,
      });
    }

    Object.defineProperty(globalThis, 'process', {
      configurable: true,
      value: nextProcess,
    });
  }

  function setCliDevelopmentIdentity(marker: unknown): void {
    Object.defineProperty(
      globalThis,
      '__CANOPY_CLI_LINUX_ARM64_DEVELOPMENT__',
      {
        configurable: true,
        value: marker,
      },
    );
  }

  function loadConfigPaths(): typeof ConfigPathsModule {
    let configPathsModule: typeof ConfigPathsModule | undefined;

    jest.isolateModules((): void => {
      jest.doMock('node:fs', () => ({
        constants,
        existsSync,
        realpathSync,
        readFileSync,
      }));
      jest.doMock('../node/lib/path-lookup', () => ({
        findExecutableOnPath,
      }));
      configPathsModule = jest.requireActual<typeof ConfigPathsModule>(
        '../pipelines/config-paths',
      );
    });

    if (!configPathsModule) {
      throw new Error('Failed to load config-paths module');
    }

    loadedConfigs.push(configPathsModule);
    return configPathsModule;
  }

  it.each<NodeJS.Platform>(['darwin', 'win32', 'linux'])(
    'recognizes bundled commands without rewriting paths on %s',
    (platform) => {
      setProcessState({ platform, arch: 'x64' });
      const config = loadConfigPaths();
      expect(config.getBundledBinaryMember('gh')).toBe('gh');
      expect(config.getBundledBinaryMember('gh.exe')).toBe(
        platform === 'win32' ? 'gh' : undefined,
      );
      expect(config.getBundledBinaryMember('/custom/gh')).toBeUndefined();
      expect(
        config.getBundledBinaryMember('C:\\custom\\gh.exe'),
      ).toBeUndefined();
      expect(config.getBundledBinaryMember('not-bundled')).toBeUndefined();
    },
  );

  it.each([undefined, '', '0', 'true', '1'])(
    'resolves native ARM64 tools independently of development opt-in %s',
    (value) => {
      setProcessState({
        platform: 'linux',
        arch: 'arm64',
        resourcesPath: undefined,
        env: {
          NODE_ENV: 'development',
          CANOPY_ENABLE_LINUX_ARM64_DEVELOPMENT: value,
        },
      });
      mockedExistsSync.mockReturnValue(true);
      const config = loadConfigPaths();
      expect(config.getBundledBinDir()).toBe(
        path.resolve(process.cwd(), '.cache/bin/linux-arm64'),
      );
      for (const member of config.BUNDLED_BINARY_MEMBERS) {
        expect(config.resolveBundledBinary(member).status).toBe('bundled');
      }
    },
  );

  it('reports missing native ARM64 tools without falling back to host installations', () => {
    setProcessState({
      platform: 'linux',
      arch: 'arm64',
      resourcesPath: undefined,
      env: {
        NODE_ENV: 'development',
        CANOPY_ENABLE_LINUX_ARM64_DEVELOPMENT: '1',
      },
    });
    mockedExistsSync.mockReturnValue(false);
    mockedFindExecutableOnPath.mockReturnValue('/usr/local/bin/host-provider');
    const config = loadConfigPaths();
    for (const member of config.BUNDLED_BINARY_MEMBERS) {
      expect(config.resolveBundledBinary(member)).toEqual({
        member,
        status: 'missing',
        path: path.resolve(process.cwd(), '.cache/bin/linux-arm64', member),
      });
    }
    expect(mockedFindExecutableOnPath).not.toHaveBeenCalled();
  });

  it('resolves packaged native ARM64 tools without development metadata or flags', () => {
    setProcessState({
      platform: 'linux',
      arch: 'arm64',
      resourcesPath: '/opt/app/resources',
      env: {
        NODE_ENV: 'production',
      },
    });
    expect(loadConfigPaths().getBundledBinDir()).toBe('/opt/app/resources/bin');
  });

  it.each([true, false, 'true', undefined])(
    'resolves native ARM64 regardless of historical development identity (%s)',
    (marker) => {
      setProcessState({
        platform: 'linux',
        arch: 'arm64',
        resourcesPath: '/opt/app/resources',
        env: { NODE_ENV: 'production' },
      });
      jest
        .mocked(readFileSync)
        .mockReturnValue(
          JSON.stringify({ canopyLinuxArm64Development: marker }),
        );
      mockedExistsSync.mockReturnValue(true);
      const config = loadConfigPaths();
      expect(config.getBundledBinDir()).toBe('/opt/app/resources/bin');
      expect(readFileSync).not.toHaveBeenCalled();
      for (const member of config.BUNDLED_BINARY_MEMBERS)
        expect(config.resolveBundledBinary(member).status).toBe('bundled');
    },
  );

  it('resolves native ARM64 without reading missing or malformed package metadata', () => {
    setProcessState({
      platform: 'linux',
      arch: 'arm64',
      resourcesPath: '/opt/app/resources',
      env: {
        NODE_ENV: 'production',
        CANOPY_ENABLE_LINUX_ARM64_DEVELOPMENT: '1',
      },
    });
    for (const malformed of ['{', 'null', '[]', 'true']) {
      jest.mocked(readFileSync).mockReturnValue(malformed);
      expect(loadConfigPaths().getBundledBinDir()).toBe(
        '/opt/app/resources/bin',
      );
    }
    jest.mocked(readFileSync).mockImplementation(() => {
      throw new Error('missing metadata');
    });
    expect(loadConfigPaths().getBundledBinDir()).toBe('/opt/app/resources/bin');
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('resolves opted-in standalone ARM64 CLI siblings without choosing an unrelated parent bin directory', () => {
    setProcessState({
      platform: 'linux',
      arch: 'arm64',
      resourcesPath: undefined,
      execPath: '/home/dev/cli/canopy',
      env: {
        NODE_ENV: 'production',
        CANOPY_ENABLE_LINUX_ARM64_DEVELOPMENT: '1',
      },
    });
    mockedExistsSync.mockReturnValue(true);
    expect(loadConfigPaths().getBundledBinDir()).toBe('/home/dev/cli');
  });

  it.each([true, false, 'true', undefined])(
    'resolves native ARM64 CLI independently of historical build identity (%s)',
    (marker) => {
      setCliDevelopmentIdentity(marker);
      setProcessState({
        platform: 'linux',
        arch: 'arm64',
        resourcesPath: undefined,
        execPath: '/opt/Canopy/resources/cli/canopy',
        env: { NODE_ENV: 'production', PATH: '/usr/local/bin' },
      });
      mockedExistsSync.mockReturnValue(true);
      const config = loadConfigPaths();
      expect(process.env.CANOPY_ENABLE_LINUX_ARM64_DEVELOPMENT).toBeUndefined();
      expect(config.resolveBundledBinary('claude')).toEqual({
        member: 'claude',
        status: 'bundled',
        path: '/opt/Canopy/resources/bin/claude',
      });
      expect(readFileSync).not.toHaveBeenCalled();
      expect(mockedFindExecutableOnPath).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['/opt/Canopy/resources/cli/canopy', '/opt/Canopy/resources/bin'],
    ['/home/dev/canopy-cli/canopy', '/home/dev/canopy-cli'],
    ['/usr/bin/canopy', '/opt/Canopy/resources/bin'],
  ])(
    'keeps missing development-built CLI tools bundled at %s',
    (execPath, binDir) => {
      setCliDevelopmentIdentity(true);
      setProcessState({
        platform: 'linux',
        arch: 'arm64',
        resourcesPath: undefined,
        execPath,
        env: { NODE_ENV: 'production', PATH: '/usr/local/bin' },
      });
      mockedRealpathSync.mockImplementation((input: PathLike): string =>
        input.toString() === '/usr/bin/canopy'
          ? '/opt/Canopy/resources/cli/canopy'
          : input.toString(),
      );
      mockedExistsSync.mockImplementation(
        (input: PathLike): boolean =>
          input.toString() !== path.join(binDir, 'claude'),
      );
      mockedFindExecutableOnPath.mockReturnValue('/usr/local/bin/claude');
      const config = loadConfigPaths();
      expect(config.getBundledBinDir()).toBe(binDir);
      expect(config.resolveBundledBinary('claude')).toEqual({
        member: 'claude',
        status: 'missing',
        path: path.join(binDir, 'claude'),
      });
      expect(mockedFindExecutableOnPath).not.toHaveBeenCalled();
    },
  );

  it('resolves an unmarked native ARM64 Electron package independently of CLI identity', () => {
    setCliDevelopmentIdentity(true);
    setProcessState({
      platform: 'linux',
      arch: 'arm64',
      resourcesPath: '/opt/Canopy/resources',
      env: { NODE_ENV: 'production' },
    });
    jest.mocked(readFileSync).mockReturnValue('{}');
    mockedExistsSync.mockReturnValue(true);
    expect(loadConfigPaths().resolveBundledBinary('claude')).toEqual({
      member: 'claude',
      status: 'bundled',
      path: '/opt/Canopy/resources/bin/claude',
    });
  });

  it('preserves explicit overrides in the development-built ARM64 CLI', () => {
    setCliDevelopmentIdentity(true);
    setProcessState({
      platform: 'linux',
      arch: 'arm64',
      resourcesPath: undefined,
      execPath: '/opt/Canopy/resources/cli/canopy',
      env: {
        NODE_ENV: 'production',
        CLAUDE_CODE_EXECUTABLE: ' /custom/claude ',
      },
    });
    mockedExistsSync.mockReturnValue(false);
    expect(loadConfigPaths().resolveBundledBinary('claude')).toEqual({
      member: 'claude',
      status: 'override',
      path: '/custom/claude',
    });
  });

  afterEach(async () => {
    for (const config of loadedConfigs) config.resetLoginShellPathCache();
    await new Promise<void>((resolve) => setImmediate(resolve));
    loadedConfigs.length = 0;
    Reflect.deleteProperty(
      globalThis,
      '__CANOPY_CLI_LINUX_ARM64_DEVELOPMENT__',
    );
    if (originalProcessDescriptor) {
      Object.defineProperty(globalThis, 'process', originalProcessDescriptor);
    } else {
      Object.defineProperty(globalThis, 'process', {
        configurable: true,
        value: originalProcess,
      });
    }
    mockedExistsSync.mockReset();
    jest.mocked(readFileSync).mockReset();
    mockedFindExecutableOnPath.mockReset();
    mockedRealpathSync.mockReset();
    mockedRealpathSync.mockImplementation((input: PathLike) =>
      input.toString(),
    );
    jest.resetModules();
  });

  it('resolves the staged Claude binary in dev runtime on macOS', () => {
    setProcessState({
      env: { CANOPY_ENV: 'development' },
      platform: 'darwin',
      arch: 'arm64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledClaudeBinaryPath()).toBe(
      path.resolve(process.cwd(), '.cache', 'bin', 'darwin-arm64', 'claude'),
    );
  });

  it('resolves a missing staged Claude binary to an absolute PATH entry', () => {
    setProcessState({
      env: {
        CANOPY_ENV: 'development',
        PATH: 'C:\\Tools\\Claude;C:\\Windows',
      },
      platform: 'win32',
      arch: 'x64',
    });
    mockedExistsSync.mockReturnValue(false);
    mockedFindExecutableOnPath.mockReturnValue('C:\\Tools\\Claude\\claude.exe');

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledClaudeBinaryPath()).toBe(
      'C:\\Tools\\Claude\\claude.exe',
    );
    expect(mockedFindExecutableOnPath).toHaveBeenCalledWith(
      'claude.exe',
      'C:\\Tools\\Claude;C:\\Windows',
    );
  });

  it('prefers CANOPY_CLAUDE_BINARY_PATH in builtin action subprocesses', () => {
    setProcessState({
      env: {
        CANOPY_CLAUDE_BINARY_PATH: '/tmp/canopy/bin/claude',
        CANOPY_ENV: 'development',
      },
      platform: 'darwin',
      arch: 'arm64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledClaudeBinaryPath()).toBe(
      '/tmp/canopy/bin/claude',
    );
    expect(configPaths.getBundledBinDir()).toBe('/tmp/canopy/bin');
    expect(mockedFindExecutableOnPath).not.toHaveBeenCalled();
  });

  it('resolves the bundled Electron resource path in packaged runtime', () => {
    setProcessState({
      platform: 'darwin',
      arch: 'x64',
      resourcesPath: '/Applications/Canopy.app/Contents/Resources',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledClaudeBinaryPath()).toBe(
      path.join('/Applications/Canopy.app/Contents/Resources', 'bin', 'claude'),
    );
  });

  it('resolves a sibling Claude binary for SEA CLI on macOS', () => {
    setProcessState({
      env: { CANOPY_ENV: 'production' },
      platform: 'darwin',
      arch: 'x64',
      resourcesPath: undefined,
      execPath: '/tmp/dist/canopy',
    });
    mockedExistsSync.mockReturnValue(false);

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledClaudeBinaryPath()).toBe(
      path.join('/tmp/dist', 'claude'),
    );
  });

  it('falls back to CLAUDE_CODE_EXECUTABLE on non-macOS', () => {
    setProcessState({
      env: { CLAUDE_CODE_EXECUTABLE: '/usr/local/bin/claude-custom' },
      platform: 'linux',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledClaudeBinaryPath()).toBe(
      '/usr/local/bin/claude-custom',
    );
  });

  it('resolves the staged rg binary in dev runtime on macOS', () => {
    setProcessState({
      env: { CANOPY_ENV: 'development' },
      platform: 'darwin',
      arch: 'arm64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledRgBinaryPath()).toBe(
      path.resolve(process.cwd(), '.cache', 'bin', 'darwin-arm64', 'rg'),
    );
  });

  it('prefers CANOPY_RG_BINARY_PATH in builtin action subprocesses', () => {
    setProcessState({
      env: {
        CANOPY_RG_BINARY_PATH: '/tmp/canopy/bin/rg',
        CANOPY_ENV: 'development',
      },
      platform: 'darwin',
      arch: 'arm64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledRgBinaryPath()).toBe('/tmp/canopy/bin/rg');
    expect(configPaths.getBundledBinDir()).toBe('/tmp/canopy/bin');
  });

  it('prefers CANOPY_CODEX_BINARY_PATH in builtin action subprocesses', () => {
    setProcessState({
      env: {
        CANOPY_CODEX_BINARY_PATH: '/tmp/canopy/bin/codex',
        CANOPY_ENV: 'development',
      },
      platform: 'darwin',
      arch: 'arm64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledCodexBinaryPath()).toBe(
      '/tmp/canopy/bin/codex',
    );
    expect(configPaths.getBundledBinDir()).toBe('/tmp/canopy/bin');
  });

  it('resolves the staged GitHub CLI binary in dev runtime on macOS', () => {
    setProcessState({
      env: { CANOPY_ENV: 'development' },
      platform: 'darwin',
      arch: 'arm64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledGhBinaryPath()).toBe(
      path.resolve(process.cwd(), '.cache', 'bin', 'darwin-arm64', 'gh'),
    );
  });

  it('prefers CANOPY_GH_BINARY_PATH in subprocesses', () => {
    setProcessState({
      env: {
        CANOPY_GH_BINARY_PATH: '/tmp/canopy/bin/gh',
        CANOPY_ENV: 'development',
      },
      platform: 'darwin',
      arch: 'arm64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledGhBinaryPath()).toBe('/tmp/canopy/bin/gh');
    expect(configPaths.getBundledBinDir()).toBe('/tmp/canopy/bin');
  });

  it('resolves the bundled Electron resource rg path in packaged runtime', () => {
    setProcessState({
      platform: 'darwin',
      arch: 'x64',
      resourcesPath: '/Applications/Canopy.app/Contents/Resources',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledRgBinaryPath()).toBe(
      path.join('/Applications/Canopy.app/Contents/Resources', 'bin', 'rg'),
    );
  });

  it('resolves a sibling rg binary for SEA CLI on macOS', () => {
    setProcessState({
      env: { CANOPY_ENV: 'production' },
      platform: 'darwin',
      arch: 'x64',
      resourcesPath: undefined,
      execPath: '/tmp/dist/canopy',
    });
    mockedExistsSync.mockReturnValue(false);

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledRgBinaryPath()).toBe(
      path.join('/tmp/dist', 'rg'),
    );
  });

  it('resolves the staged bundled bin directory in dev runtime on Windows', () => {
    setProcessState({
      env: { CANOPY_ENV: 'development' },
      platform: 'win32',
      arch: 'x64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledBinDir()).toBe(
      path.resolve(process.cwd(), '.cache', 'bin', 'win32-x64'),
    );
  });

  it('resolves the staged bundled bin directory in dev runtime on Linux x64', () => {
    setProcessState({
      env: { CANOPY_ENV: 'development' },
      platform: 'linux',
      arch: 'x64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledBinDir()).toBe(
      path.resolve(process.cwd(), '.cache', 'bin', 'linux-x64'),
    );
  });

  it('resolves packaged Linux x64 binaries under resources/bin', () => {
    setProcessState({
      platform: 'linux',
      arch: 'x64',
      resourcesPath: '/opt/canopy/resources',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledBinDir()).toBe('/opt/canopy/resources/bin');
    expect(configPaths.getBundledClaudeBinaryPath()).toBe(
      '/opt/canopy/resources/bin/claude',
    );
    expect(configPaths.getBundledCodexBinaryPath()).toBe(
      '/opt/canopy/resources/bin/codex',
    );
    expect(configPaths.getBundledGhBinaryPath()).toBe(
      '/opt/canopy/resources/bin/gh',
    );
    expect(configPaths.getBundledRgBinaryPath()).toBe(
      '/opt/canopy/resources/bin/rg',
    );
    expect(configPaths.getBundledRtkBinaryPath()).toBe(
      '/opt/canopy/resources/bin/rtk',
    );
  });

  it('selects staged tools for native Linux ARM64 development', () => {
    setProcessState({
      env: { CANOPY_ENV: 'development' },
      platform: 'linux',
      arch: 'arm64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledBinDir()).toBe(
      path.resolve(process.cwd(), '.cache/bin/linux-arm64'),
    );
  });

  it('resolves the bundled Electron bin directory on Windows', () => {
    setProcessState({
      platform: 'win32',
      arch: 'x64',
      resourcesPath: 'C:\\Program Files\\Canopy\\resources',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledBinDir()).toBe(
      path.join('C:\\Program Files\\Canopy\\resources', 'bin'),
    );
  });

  it('resolves the staged Codex executable in dev runtime on Windows', () => {
    setProcessState({
      env: { CANOPY_ENV: 'development' },
      platform: 'win32',
      arch: 'x64',
    });
    const stagedCodexPath = path.resolve(
      process.cwd(),
      '.cache',
      'bin',
      'win32-x64',
      'codex.exe',
    );
    mockedExistsSync.mockImplementation(
      (candidatePath: PathLike): boolean =>
        candidatePath.toString() === stagedCodexPath,
    );

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledCodexBinaryPath()).toBe(stagedCodexPath);
  });

  it('falls back to Codex on PATH when the staged dev executable is missing', () => {
    setProcessState({
      env: { CANOPY_ENV: 'development' },
      platform: 'win32',
      arch: 'x64',
    });
    mockedExistsSync.mockReturnValue(false);
    mockedFindExecutableOnPath.mockReturnValue(
      path.join('C:\\', 'Tools', 'codex.exe'),
    );

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledCodexBinaryPath()).toBe(
      path.join('C:\\', 'Tools', 'codex.exe'),
    );
    expect(mockedFindExecutableOnPath).toHaveBeenCalledWith(
      'codex.exe',
      process.env.PATH,
    );
  });

  it('keeps the expected packaged Codex path when the executable is missing', () => {
    setProcessState({
      platform: 'win32',
      arch: 'x64',
      resourcesPath: 'C:\\Program Files\\Canopy\\resources',
    });
    mockedExistsSync.mockReturnValue(false);

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledCodexBinaryPath()).toBe(
      path.join('C:\\Program Files\\Canopy\\resources', 'bin', 'codex.exe'),
    );
    expect(mockedFindExecutableOnPath).not.toHaveBeenCalled();
  });

  it('does not expose canopy-dictate on Windows by default', () => {
    setProcessState({
      env: { CANOPY_ENV: 'development' },
      platform: 'win32',
      arch: 'x64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledDictateBinaryPath()).toBe('');
  });

  it('resolves the staged Canopy CLI executable in dev runtime on Windows', () => {
    setProcessState({
      env: { CANOPY_ENV: 'development' },
      platform: 'win32',
      arch: 'x64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledCanopyCliPath()).toBe(
      path.resolve(process.cwd(), 'dist', 'cli', 'canopy.exe'),
    );
  });

  it('prefers RG_EXECUTABLE when set', () => {
    setProcessState({
      env: {
        RG_EXECUTABLE: ' /usr/local/bin/rg-custom ',
        CANOPY_ENV: 'development',
      },
      platform: 'darwin',
      arch: 'arm64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledRgBinaryPath()).toBe(
      '/usr/local/bin/rg-custom',
    );
  });

  it('resolves the staged rg binary on Linux x64', () => {
    setProcessState({
      env: { CANOPY_ENV: 'development' },
      platform: 'linux',
      arch: 'x64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledRgBinaryPath()).toBe(
      path.resolve(process.cwd(), '.cache', 'bin', 'linux-x64', 'rg'),
    );
  });

  it('resolves packaged rg on Linux ARM64 without an override', () => {
    setProcessState({
      platform: 'linux',
      arch: 'arm64',
      resourcesPath: '/opt/app/resources',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledRgBinaryPath()).toBe(
      '/opt/app/resources/bin/rg',
    );
  });

  it('resolves the staged RTK binary in dev runtime on macOS', () => {
    setProcessState({
      env: { CANOPY_ENV: 'development' },
      platform: 'darwin',
      arch: 'arm64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledRtkBinaryPath()).toBe(
      path.resolve(process.cwd(), '.cache', 'bin', 'darwin-arm64', 'rtk'),
    );
  });

  it('resolves the bundled Electron resource RTK path in packaged runtime', () => {
    setProcessState({
      platform: 'darwin',
      arch: 'x64',
      resourcesPath: '/Applications/Canopy.app/Contents/Resources',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledRtkBinaryPath()).toBe(
      path.join('/Applications/Canopy.app/Contents/Resources', 'bin', 'rtk'),
    );
  });

  it('resolves a sibling RTK binary for SEA CLI on macOS', () => {
    setProcessState({
      env: { CANOPY_ENV: 'production' },
      platform: 'darwin',
      arch: 'x64',
      resourcesPath: undefined,
      execPath: '/tmp/dist/canopy',
    });
    mockedExistsSync.mockReturnValue(false);

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledRtkBinaryPath()).toBe(
      path.join('/tmp/dist', 'rtk'),
    );
  });

  it('resolves the staged RTK binary on Linux x64', () => {
    setProcessState({
      env: { CANOPY_ENV: 'development' },
      platform: 'linux',
      arch: 'x64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledRtkBinaryPath()).toBe(
      path.resolve(process.cwd(), '.cache', 'bin', 'linux-x64', 'rtk'),
    );
  });

  it('honors RTK_EXECUTABLE on Linux ARM64 and otherwise uses the bundle', () => {
    setProcessState({
      env: { RTK_EXECUTABLE: '/usr/local/bin/rtk-custom' },
      platform: 'linux',
      arch: 'arm64',
    });

    let configPaths = loadConfigPaths();
    expect(configPaths.getBundledRtkBinaryPath()).toBe(
      '/usr/local/bin/rtk-custom',
    );

    setProcessState({
      platform: 'linux',
      arch: 'arm64',
      resourcesPath: '/opt/app/resources',
    });
    configPaths = loadConfigPaths();
    expect(configPaths.getBundledRtkBinaryPath()).toBe(
      '/opt/app/resources/bin/rtk',
    );
  });

  it('prefers CANOPY_RTK_BINARY_PATH over RTK_EXECUTABLE on both macOS and non-macOS', () => {
    setProcessState({
      env: {
        CANOPY_RTK_BINARY_PATH: '/tmp/canopy/bin/rtk',
        RTK_EXECUTABLE: '/usr/local/bin/rtk-custom',
        CANOPY_ENV: 'development',
      },
      platform: 'darwin',
      arch: 'arm64',
    });

    let configPaths = loadConfigPaths();
    expect(configPaths.getBundledRtkBinaryPath()).toBe('/tmp/canopy/bin/rtk');
    expect(configPaths.getBundledBinDir()).toBe('/tmp/canopy/bin');

    setProcessState({
      env: {
        CANOPY_RTK_BINARY_PATH: '/tmp/canopy/bin/rtk',
        RTK_EXECUTABLE: '/usr/local/bin/rtk-custom',
      },
      platform: 'linux',
    });

    configPaths = loadConfigPaths();
    expect(configPaths.getBundledRtkBinaryPath()).toBe('/tmp/canopy/bin/rtk');
    expect(configPaths.getBundledBinDir()).toBe('/tmp/canopy/bin');
  });

  it('prefers RTK_EXECUTABLE over the bundled path on macOS when no Canopy override is set', () => {
    setProcessState({
      env: {
        RTK_EXECUTABLE: ' /usr/local/bin/rtk-custom ',
        CANOPY_ENV: 'development',
      },
      platform: 'darwin',
      arch: 'arm64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledRtkBinaryPath()).toBe(
      '/usr/local/bin/rtk-custom',
    );
  });

  it('returns the managed RTK env under the Canopy data dir', () => {
    setProcessState({
      env: { CANOPY_DATA_DIR: '/tmp/canopy-data' },
      platform: 'darwin',
      arch: 'arm64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getRtkManagedEnv()).toEqual({
      RTK_TELEMETRY_DISABLED: '1',
      RTK_DB_PATH: path.join('/tmp/canopy-data', 'rtk', 'history.db'),
      RTK_TEE_DIR: path.join('/tmp/canopy-data', 'rtk', 'tee'),
    });
  });

  it('derives the bundled bin directory from CANOPY_RTK_BINARY_PATH alone', () => {
    setProcessState({
      env: {
        CANOPY_RTK_BINARY_PATH: '/tmp/canopy/bin/rtk',
      },
      platform: 'darwin',
      arch: 'arm64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledBinDir()).toBe('/tmp/canopy/bin');
  });

  it('resolves the staged Canopy CLI in dev runtime on macOS', () => {
    setProcessState({
      env: { CANOPY_ENV: 'development' },
      platform: 'darwin',
      arch: 'arm64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledCanopyCliPath()).toBe(
      path.resolve(process.cwd(), 'dist', 'cli', 'canopy'),
    );
  });

  it('uses an absolute Node executable for the dev MCP launcher', () => {
    setProcessState({
      env: {
        CANOPY_ENV: 'development',
        NODE: '/opt/node/bin/node',
      },
      platform: 'darwin',
      arch: 'arm64',
    });
    mockedExistsSync.mockImplementation(
      (candidatePath: PathLike): boolean =>
        candidatePath.toString() === '/opt/node/bin/node',
    );

    const configPaths = loadConfigPaths();

    expect(configPaths.getCanopyCliDevLaunchArgs()).toEqual({
      command: '/opt/node/bin/node',
      cwd: process.cwd(),
      args: [
        path.resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        '--tsconfig',
        path.resolve(process.cwd(), 'tsconfig.json'),
        path.resolve(process.cwd(), 'apps', 'desktop-cli', 'src', 'index.ts'),
      ],
    });
  });

  it('keeps fallback dev launcher module resolution independent of child cwd', () => {
    setProcessState({
      env: { CANOPY_ENV: 'development' },
      platform: 'darwin',
      arch: 'arm64',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getCanopyCliDevLaunchArgs()).toEqual({
      command: path.resolve(process.cwd(), 'node_modules', '.bin', 'tsx'),
      cwd: process.cwd(),
      args: [
        '--tsconfig',
        path.resolve(process.cwd(), 'tsconfig.json'),
        path.resolve(process.cwd(), 'apps', 'desktop-cli', 'src', 'index.ts'),
      ],
    });
  });

  it('resolves the packaged Canopy CLI path in Electron builds', () => {
    setProcessState({
      platform: 'darwin',
      arch: 'x64',
      resourcesPath: '/Applications/Canopy.app/Contents/Resources',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledCanopyCliPath()).toBe(
      path.join('/Applications/Canopy.app/Contents/Resources', 'cli', 'canopy'),
    );
  });

  it('prefers extracted embedded resources for bundled pipeline assets', () => {
    setProcessState({
      env: {
        CANOPY_ENV: 'production',
        CANOPY_BUNDLED_RESOURCES_DIR: '/tmp/canopy-embedded',
      },
      platform: 'darwin',
      arch: 'x64',
      resourcesPath: '/Applications/Canopy.app/Contents/Resources',
      execPath: '/tmp/dist/canopy',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledPipelinesDir()).toBe(
      '/tmp/canopy-embedded/pipelines',
    );
    expect(configPaths.getBundledActionsDir()).toBe(
      '/tmp/canopy-embedded/actions',
    );
    expect(configPaths.getBundledSkillsDir()).toBe(
      '/tmp/canopy-embedded/skills',
    );
    expect(configPaths.getBundledPluginsDir()).toBe(
      '/tmp/canopy-embedded/plugins',
    );
  });

  it('resolves bundled plugin manifests in dev runtime', () => {
    setProcessState({
      env: { CANOPY_ENV: 'development' },
      platform: 'darwin',
      arch: 'arm64',
    });
    mockedExistsSync.mockImplementation((candidatePath: PathLike): boolean =>
      candidatePath
        .toString()
        .endsWith(
          path.join('.cache', 'brand', 'canopy', 'resources', 'plugins'),
        ),
    );

    const configPaths = loadConfigPaths();
    const pluginsDir = path.resolve(
      process.cwd(),
      '.cache',
      'brand',
      'canopy',
      'resources',
      'plugins',
    );

    expect(configPaths.getBundledPluginsDir()).toBe(pluginsDir);
    expect(configPaths.getBundledClaudePluginMarketplaceManifestPath()).toBe(
      path.join(pluginsDir, '.claude-plugin', 'marketplace.json'),
    );
    expect(configPaths.getBundledCodexPluginMarketplaceManifestPath()).toBe(
      path.join(pluginsDir, '.agents', 'plugins', 'marketplace.json'),
    );
  });

  it('keeps dev runtime resources ahead of embedded resource overrides', () => {
    setProcessState({
      env: {
        CANOPY_ENV: 'development',
        CANOPY_BUNDLED_RESOURCES_DIR: '/tmp/canopy-embedded',
      },
      platform: 'darwin',
      arch: 'arm64',
    });
    mockedExistsSync.mockImplementation((candidatePath: PathLike): boolean =>
      candidatePath
        .toString()
        .endsWith(
          path.join('.cache', 'brand', 'canopy', 'resources', 'skills'),
        ),
    );

    const configPaths = loadConfigPaths();
    const resourcesDir = path.resolve(
      process.cwd(),
      '.cache',
      'brand',
      'canopy',
      'resources',
    );

    expect(configPaths.getBundledSkillsDir()).toBe(
      path.join(resourcesDir, 'skills'),
    );
  });

  it('resolves bundled plugins under packaged Electron resources', () => {
    setProcessState({
      platform: 'darwin',
      arch: 'x64',
      resourcesPath: '/Applications/Canopy.app/Contents/Resources',
    });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledPluginsDir()).toBe(
      '/Applications/Canopy.app/Contents/Resources/plugins',
    );
  });

  it('returns the parent Resources directory for in-app CLI symlink resources', () => {
    setProcessState({
      env: { CANOPY_ENV: 'production' },
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: undefined,
      execPath: '/Applications/Canopy.app/Contents/Resources/cli/canopy',
    });
    mockedExistsSync.mockImplementation(
      (candidatePath: PathLike): boolean =>
        candidatePath.toString() ===
        '/Applications/Canopy.app/Contents/Resources/pipelines',
    );

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledPipelinesDir()).toBe(
      '/Applications/Canopy.app/Contents/Resources/pipelines',
    );
    expect(configPaths.getBundledActionsDir()).toBe(
      '/Applications/Canopy.app/Contents/Resources/actions',
    );
    expect(configPaths.getBundledSkillsDir()).toBe(
      '/Applications/Canopy.app/Contents/Resources/skills',
    );
  });

  it('returns process.execPath for non-Electron packaged CLI paths on non-macOS', () => {
    setProcessState({ platform: 'linux', execPath: '/tmp/canopy' });

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledCanopyCliPath()).toBe('/tmp/canopy');
  });

  it('falls back to the project resources dir under Jest without a packaged layout', () => {
    setProcessState({
      env: { CANOPY_ENV: 'production', JEST_WORKER_ID: '1' },
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: undefined,
      execPath: '/tmp/dist/canopy',
    });
    const workspaceResourcesDir = path.resolve(
      process.cwd(),
      'packages',
      'desktop-shared',
      'resources',
    );
    mockedExistsSync.mockImplementation(
      (candidatePath: PathLike): boolean =>
        candidatePath.toString() ===
        path.join(workspaceResourcesDir, 'pipelines'),
    );

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledCodeGraphDir()).toBe(
      path.join(workspaceResourcesDir, 'code-graph'),
    );
    expect(configPaths.getBundledPipelinesDir()).toBe(
      path.join(workspaceResourcesDir, 'pipelines'),
    );
  });

  it('does not fall back to the project resources dir outside Jest', () => {
    setProcessState({
      env: { CANOPY_ENV: 'production', JEST_WORKER_ID: undefined },
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: undefined,
      execPath: '/tmp/dist/canopy',
    });
    const workspaceResourcesDir = path.resolve(
      process.cwd(),
      'packages',
      'desktop-shared',
      'resources',
    );
    // The workspace resources dir "exists", but without JEST_WORKER_ID the
    // fallback must not engage — a manually run SEA CLI in a repo checkout
    // must not silently pick up the source tree.
    mockedExistsSync.mockImplementation(
      (candidatePath: PathLike): boolean =>
        candidatePath.toString() ===
        path.join(workspaceResourcesDir, 'pipelines'),
    );

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledCodeGraphDir()).toBe(
      path.join('/tmp/dist', 'resources', 'code-graph'),
    );
    expect(configPaths.getBundledPipelinesDir()).toBe(
      path.join('/tmp/dist', 'resources', 'pipelines'),
    );
  });

  it('resolves the staged sibling resources/code-graph dir for the standalone SEA CLI, bypassing the embedded-resources override', () => {
    setProcessState({
      env: {
        CANOPY_ENV: 'production',
        // Simulates apps/desktop-cli/src/index.ts's initEmbeddedResources()
        // having already pointed BUNDLED_RESOURCES_DIR at the extracted
        // actions/pipelines cache, which never contains a code-graph dir.
        CANOPY_BUNDLED_RESOURCES_DIR: '/tmp/embedded-resources-abc123',
      },
      platform: 'darwin',
      arch: 'x64',
      resourcesPath: undefined,
      execPath: '/tmp/dist/cli/canopy',
    });
    mockedExistsSync.mockImplementation(
      (candidatePath: PathLike): boolean =>
        candidatePath.toString() === '/tmp/dist/cli/resources/code-graph',
    );

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledCodeGraphDir()).toBe(
      '/tmp/dist/cli/resources/code-graph',
    );
    // The override still governs every other bundled resource dir.
    expect(configPaths.getBundledPipelinesDir()).toBe(
      '/tmp/embedded-resources-abc123/pipelines',
    );
  });

  it('falls through to the general resolution when no staged code-graph dir exists next to the CLI binary', () => {
    setProcessState({
      env: {
        CANOPY_ENV: 'production',
        CANOPY_BUNDLED_RESOURCES_DIR: '/tmp/embedded-resources-abc123',
      },
      platform: 'darwin',
      arch: 'x64',
      resourcesPath: undefined,
      execPath: '/tmp/dist/cli/canopy',
    });
    mockedExistsSync.mockReturnValue(false);

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledCodeGraphDir()).toBe(
      '/tmp/embedded-resources-abc123/code-graph',
    );
  });

  it('returns a sibling bin directory for standalone SEA CLI builds', () => {
    setProcessState({
      env: { CANOPY_ENV: 'production' },
      platform: 'darwin',
      arch: 'x64',
      resourcesPath: undefined,
      execPath: '/tmp/dist/canopy',
    });
    mockedExistsSync.mockReturnValue(false);

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledBinDir()).toBe('/tmp/dist');
  });

  it('returns ../bin for in-app CLI symlinks that resolve into Resources/cli', () => {
    setProcessState({
      env: { CANOPY_ENV: 'production' },
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: undefined,
      execPath: '/Applications/Canopy.app/Contents/Resources/cli/canopy',
    });
    mockedExistsSync.mockImplementation(
      (candidatePath: PathLike): boolean =>
        candidatePath.toString() ===
        '/Applications/Canopy.app/Contents/Resources/bin',
    );

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledBinDir()).toBe(
      '/Applications/Canopy.app/Contents/Resources/bin',
    );
  });

  it('keeps the macOS development host fallback for a missing staged provider', () => {
    setProcessState({
      env: { CANOPY_ENV: 'development' },
      platform: 'darwin',
      arch: 'arm64',
    });
    mockedExistsSync.mockReturnValue(false);
    mockedFindExecutableOnPath.mockImplementation(
      (name: string): string => `/opt/homebrew/bin/${name}`,
    );

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledClaudeBinaryPath()).toBe(
      '/opt/homebrew/bin/claude',
    );
    expect(mockedFindExecutableOnPath).toHaveBeenCalledWith(
      'claude',
      expect.any(String),
    );
    expect(configPaths.resolveBundledBinary('claude')).toEqual({
      member: 'claude',
      status: 'host-fallback',
      path: '/opt/homebrew/bin/claude',
    });
    expect(configPaths.resolveBundledBinary('codex-code-mode-host')).toEqual({
      member: 'codex-code-mode-host',
      status: 'host-fallback',
      path: '/opt/homebrew/bin/codex-code-mode-host',
    });
    expect(
      configPaths.listMissingBundledBinaries().map(({ member }) => member),
    ).toEqual(['gh', 'rg', 'rtk']);
  });

  it('keeps the macOS standalone CLI ../bin rule when that directory exists', () => {
    setProcessState({
      env: { CANOPY_ENV: 'production' },
      platform: 'darwin',
      arch: 'x64',
      resourcesPath: undefined,
      execPath: '/tmp/dist/canopy',
    });
    mockedExistsSync.mockImplementation(
      (candidatePath: PathLike): boolean =>
        candidatePath.toString() === '/tmp/bin',
    );

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledBinDir()).toBe('/tmp/bin');
    expect(configPaths.getBundledGhBinaryPath()).toBe('/tmp/bin/gh');
  });

  it('resolves the Windows code-mode host beside the staged Codex executable', () => {
    setProcessState({
      env: { CANOPY_ENV: 'development' },
      platform: 'win32',
      arch: 'x64',
    });
    mockedExistsSync.mockReturnValue(true);

    const configPaths = loadConfigPaths();

    expect(configPaths.getBundledCodexCodeModeHostPath()).toBe(
      path.resolve(
        process.cwd(),
        '.cache',
        'bin',
        'win32-x64',
        'codex-code-mode-host.exe',
      ),
    );
  });

  describe('Linux x64 bundled binary layouts', () => {
    const promisedMembers = [
      'claude',
      'codex',
      'codex-code-mode-host',
      'gh',
      'rg',
      'rtk',
    ] as const;
    type PromisedMember = (typeof promisedMembers)[number];

    function getResolvedPaths(
      configPaths: typeof ConfigPathsModule,
    ): Record<PromisedMember, string> {
      return {
        claude: configPaths.getBundledClaudeBinaryPath(),
        codex: configPaths.getBundledCodexBinaryPath(),
        'codex-code-mode-host': configPaths.getBundledCodexCodeModeHostPath(),
        gh: configPaths.getBundledGhBinaryPath(),
        rg: configPaths.getBundledRgBinaryPath(),
        rtk: configPaths.getBundledRtkBinaryPath(),
      };
    }

    function getPathsUnder(binDir: string): Record<PromisedMember, string> {
      return {
        claude: path.join(binDir, 'claude'),
        codex: path.join(binDir, 'codex'),
        'codex-code-mode-host': path.join(binDir, 'codex-code-mode-host'),
        gh: path.join(binDir, 'gh'),
        rg: path.join(binDir, 'rg'),
        rtk: path.join(binDir, 'rtk'),
      };
    }

    function expectEveryMemberBundledUnder(
      configPaths: typeof ConfigPathsModule,
      binDir: string,
    ): void {
      expect(configPaths.getBundledBinDir()).toBe(binDir);
      expect(getResolvedPaths(configPaths)).toEqual(getPathsUnder(binDir));
      expect(configPaths.BUNDLED_BINARY_MEMBERS).toEqual(promisedMembers);
      expect(
        promisedMembers.map((member) =>
          configPaths.resolveBundledBinary(member),
        ),
      ).toEqual(
        promisedMembers.map((member) => ({
          member,
          status: 'bundled',
          path: path.join(binDir, member),
        })),
      );
      expect(configPaths.listMissingBundledBinaries()).toEqual([]);
    }

    function existsUnder(...directories: string[]): (p: PathLike) => boolean {
      return (candidatePath: PathLike): boolean =>
        directories.some(
          (directory) =>
            candidatePath.toString() === directory ||
            candidatePath.toString().startsWith(`${directory}/`),
        );
    }

    it('resolves every promised member from the development cache', () => {
      setProcessState({
        env: { CANOPY_ENV: 'development' },
        platform: 'linux',
        arch: 'x64',
      });
      mockedExistsSync.mockReturnValue(true);

      const configPaths = loadConfigPaths();

      expectEveryMemberBundledUnder(
        configPaths,
        path.resolve(process.cwd(), '.cache', 'bin', 'linux-x64'),
      );
      expect(mockedFindExecutableOnPath).not.toHaveBeenCalled();
    });

    it('resolves every promised member from packaged resources with an empty PATH', () => {
      setProcessState({
        env: { PATH: '' },
        platform: 'linux',
        arch: 'x64',
        resourcesPath: '/opt/Canopy/resources',
        execPath: '/opt/Canopy/canopy',
      });
      mockedExistsSync.mockImplementation(
        existsUnder('/opt/Canopy/resources/bin'),
      );

      const configPaths = loadConfigPaths();

      expectEveryMemberBundledUnder(configPaths, '/opt/Canopy/resources/bin');
      expect(configPaths.getEnhancedEnv().PATH).toBe(
        '/opt/Canopy/resources/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      );
    });

    it.each([
      ['without a neighboring bin directory', false],
      ['next to an unrelated ../bin directory', true],
    ])(
      'resolves standalone CLI siblings %s',
      (_layout: string, parentBinExists: boolean) => {
        setProcessState({
          env: { CANOPY_ENV: 'production' },
          platform: 'linux',
          arch: 'x64',
          resourcesPath: undefined,
          execPath: '/home/u/canopy-cli/canopy',
        });
        const existsInCliDir = existsUnder('/home/u/canopy-cli');
        const existsInParentBin = existsUnder('/home/u/bin');
        mockedExistsSync.mockImplementation(
          (candidatePath: PathLike): boolean =>
            existsInCliDir(candidatePath) ||
            (parentBinExists && existsInParentBin(candidatePath)),
        );

        const configPaths = loadConfigPaths();

        expectEveryMemberBundledUnder(configPaths, '/home/u/canopy-cli');
      },
    );

    it('keeps dist/cli binaries beside the executable when dist/bin exists', () => {
      setProcessState({
        env: { CANOPY_ENV: 'production' },
        platform: 'linux',
        arch: 'x64',
        resourcesPath: undefined,
        execPath: '/tmp/dist/cli/canopy',
      });
      const existsInCliDir = existsUnder('/tmp/dist/cli');
      const existsInParentBin = existsUnder('/tmp/dist/bin');
      mockedExistsSync.mockImplementation(
        (candidatePath: PathLike): boolean =>
          existsInCliDir(candidatePath) || existsInParentBin(candidatePath),
      );

      const configPaths = loadConfigPaths();

      expectEveryMemberBundledUnder(configPaths, '/tmp/dist/cli');
    });

    it('resolves the in-app CLI under resources/cli to resources/bin', () => {
      setProcessState({
        env: { CANOPY_ENV: 'production' },
        platform: 'linux',
        arch: 'x64',
        resourcesPath: undefined,
        execPath: '/opt/Canopy/resources/cli/canopy',
      });
      mockedExistsSync.mockImplementation(
        existsUnder('/opt/Canopy/resources/bin'),
      );

      const configPaths = loadConfigPaths();

      expectEveryMemberBundledUnder(configPaths, '/opt/Canopy/resources/bin');
    });

    it('follows a symlinked CLI through realpath to resources/bin', () => {
      setProcessState({
        env: { CANOPY_ENV: 'production' },
        platform: 'linux',
        arch: 'x64',
        resourcesPath: undefined,
        execPath: '/usr/bin/canopy',
      });
      mockedRealpathSync.mockImplementation((input: PathLike): string =>
        input.toString() === '/usr/bin/canopy'
          ? '/opt/Canopy/resources/cli/canopy'
          : input.toString(),
      );
      mockedExistsSync.mockImplementation(
        existsUnder('/opt/Canopy/resources/bin', '/usr/bin'),
      );

      const configPaths = loadConfigPaths();

      expectEveryMemberBundledUnder(configPaths, '/opt/Canopy/resources/bin');
    });

    it.each([
      [
        'claude',
        'CLAUDE_CODE_EXECUTABLE',
        'CANOPY_CLAUDE_BINARY_PATH',
        'getBundledClaudeBinaryPath',
      ],
      [
        'codex',
        'CODEX_EXECUTABLE',
        'CANOPY_CODEX_BINARY_PATH',
        'getBundledCodexBinaryPath',
      ],
      [
        'gh',
        'GH_EXECUTABLE',
        'CANOPY_GH_BINARY_PATH',
        'getBundledGhBinaryPath',
      ],
      [
        'rg',
        'RG_EXECUTABLE',
        'CANOPY_RG_BINARY_PATH',
        'getBundledRgBinaryPath',
      ],
      [
        'rtk',
        'RTK_EXECUTABLE',
        'CANOPY_RTK_BINARY_PATH',
        'getBundledRtkBinaryPath',
      ],
    ] as const)(
      'keeps explicit %s overrides without requiring a staged file',
      (member, executableEnv, pipelineEnv, getter) => {
        setProcessState({
          env: { [executableEnv]: ` /opt/tools/${member} ` },
          platform: 'linux',
          arch: 'x64',
          resourcesPath: '/opt/Canopy/resources',
        });
        mockedExistsSync.mockReturnValue(false);

        let configPaths = loadConfigPaths();
        expect(configPaths[getter]()).toBe(`/opt/tools/${member}`);
        expect(configPaths.resolveBundledBinary(member)).toEqual({
          member,
          status: 'override',
          path: `/opt/tools/${member}`,
        });
        expect(
          configPaths.listMissingBundledBinaries().map((entry) => entry.member),
        ).not.toContain(member);

        setProcessState({
          env: {
            [executableEnv]: `/opt/tools/${member}`,
            [pipelineEnv]: `/tmp/pipeline/bin/${member}`,
          },
          platform: 'linux',
          arch: 'x64',
          resourcesPath: '/opt/Canopy/resources',
        });
        configPaths = loadConfigPaths();
        expect(configPaths[getter]()).toBe(`/tmp/pipeline/bin/${member}`);
        expect(configPaths.resolveBundledBinary(member).status).toBe(
          'override',
        );
      },
    );

    it('moves the code-mode host next to an overridden Codex executable', () => {
      setProcessState({
        env: { CODEX_EXECUTABLE: ' /opt/codex/bin/codex ' },
        platform: 'linux',
        arch: 'x64',
        resourcesPath: '/opt/Canopy/resources',
      });
      mockedExistsSync.mockReturnValue(true);

      let configPaths = loadConfigPaths();
      expect(configPaths.getBundledCodexCodeModeHostPath()).toBe(
        '/opt/codex/bin/codex-code-mode-host',
      );
      expect(configPaths.resolveBundledBinary('codex-code-mode-host')).toEqual({
        member: 'codex-code-mode-host',
        status: 'override',
        path: '/opt/codex/bin/codex-code-mode-host',
      });
      expect(configPaths.getBundledClaudeBinaryPath()).toBe(
        '/opt/Canopy/resources/bin/claude',
      );

      setProcessState({
        env: { CANOPY_CODEX_BINARY_PATH: '/tmp/pipeline/bin/codex' },
        platform: 'linux',
        arch: 'x64',
        resourcesPath: '/opt/Canopy/resources',
      });
      configPaths = loadConfigPaths();
      expect(configPaths.getBundledCodexCodeModeHostPath()).toBe(
        '/tmp/pipeline/bin/codex-code-mode-host',
      );
    });

    it('reports missing staged providers in development instead of a host install', () => {
      setProcessState({
        env: {
          CANOPY_ENV: 'development',
          PATH: '/home/u/.local/bin:/usr/bin',
        },
        platform: 'linux',
        arch: 'x64',
      });
      const binDir = path.resolve(process.cwd(), '.cache', 'bin', 'linux-x64');
      const absentPaths = new Set([
        path.join(binDir, 'claude'),
        path.join(binDir, 'codex'),
      ]);
      mockedExistsSync.mockImplementation(
        (candidatePath: PathLike): boolean =>
          !absentPaths.has(candidatePath.toString()),
      );
      mockedFindExecutableOnPath.mockImplementation(
        (name: string): string => `/home/u/.local/bin/${name}`,
      );

      const configPaths = loadConfigPaths();

      expect(configPaths.getBundledClaudeBinaryPath()).toBe(
        path.join(binDir, 'claude'),
      );
      expect(configPaths.getBundledCodexBinaryPath()).toBe(
        path.join(binDir, 'codex'),
      );
      expect(configPaths.resolveBundledBinary('claude')).toEqual({
        member: 'claude',
        status: 'missing',
        path: path.join(binDir, 'claude'),
      });
      expect(configPaths.listMissingBundledBinaries()).toEqual([
        {
          member: 'claude',
          status: 'missing',
          path: path.join(binDir, 'claude'),
        },
        {
          member: 'codex',
          status: 'missing',
          path: path.join(binDir, 'codex'),
        },
      ]);
      expect(mockedFindExecutableOnPath).not.toHaveBeenCalled();
    });

    it('reports a missing packaged member at its expected bundled path', () => {
      setProcessState({
        env: { PATH: '/usr/bin' },
        platform: 'linux',
        arch: 'x64',
        resourcesPath: '/opt/Canopy/resources',
      });
      mockedExistsSync.mockImplementation(
        (candidatePath: PathLike): boolean =>
          candidatePath.toString() !== '/opt/Canopy/resources/bin/gh',
      );
      mockedFindExecutableOnPath.mockReturnValue('/usr/bin/gh');

      const configPaths = loadConfigPaths();

      expect(configPaths.getBundledGhBinaryPath()).toBe(
        '/opt/Canopy/resources/bin/gh',
      );
      expect(configPaths.resolveBundledBinary('gh')).toEqual({
        member: 'gh',
        status: 'missing',
        path: '/opt/Canopy/resources/bin/gh',
      });
      expect(configPaths.listMissingBundledBinaries()).toEqual([
        {
          member: 'gh',
          status: 'missing',
          path: '/opt/Canopy/resources/bin/gh',
        },
      ]);
    });

    it('lists exactly the promised members that are absent', () => {
      setProcessState({
        platform: 'linux',
        arch: 'x64',
        resourcesPath: '/opt/Canopy/resources',
      });
      const absentPaths = new Set([
        '/opt/Canopy/resources/bin/codex-code-mode-host',
        '/opt/Canopy/resources/bin/rtk',
      ]);
      mockedExistsSync.mockImplementation(
        (candidatePath: PathLike): boolean =>
          !absentPaths.has(candidatePath.toString()),
      );

      const configPaths = loadConfigPaths();

      expect(configPaths.listMissingBundledBinaries()).toEqual([
        {
          member: 'codex-code-mode-host',
          status: 'missing',
          path: '/opt/Canopy/resources/bin/codex-code-mode-host',
        },
        {
          member: 'rtk',
          status: 'missing',
          path: '/opt/Canopy/resources/bin/rtk',
        },
      ]);
    });

    it('keeps absent native ARM64 tools bundled instead of using host commands', () => {
      setProcessState({
        env: { CANOPY_ENV: 'development' },
        platform: 'linux',
        arch: 'arm64',
      });
      mockedExistsSync.mockReturnValue(false);

      const configPaths = loadConfigPaths();

      const binDir = path.resolve(process.cwd(), '.cache/bin/linux-arm64');
      expect(configPaths.getBundledBinDir()).toBe(binDir);
      expect(getResolvedPaths(configPaths)).toEqual(
        Object.fromEntries(
          promisedMembers.map((member) => [member, path.join(binDir, member)]),
        ),
      );
      expect(
        promisedMembers.map(
          (member) => configPaths.resolveBundledBinary(member).status,
        ),
      ).toEqual(promisedMembers.map(() => 'missing'));
      expect(configPaths.listMissingBundledBinaries()).toEqual(
        promisedMembers.map((member) => ({
          member,
          status: 'missing',
          path: path.join(binDir, member),
        })),
      );
      expect(mockedFindExecutableOnPath).not.toHaveBeenCalled();
    });
  });

  describe('getEnhancedEnv user-environment handshake', () => {
    it('stamps the marker but injects no vars when no injector is registered', () => {
      setProcessState({ platform: 'linux' });
      const configPaths = loadConfigPaths();

      const env = configPaths.getEnhancedEnv();
      expect(env.FOO).toBeUndefined();
      // The "source" process always stamps the marker so descendants know
      // injection responsibility is already taken; injector absence simply
      // means no user vars are merged in.
      expect(env.CANOPY_ENV_ENHANCED).toBe('1');
    });

    it('injects user vars and stamps the marker when an injector is registered', () => {
      setProcessState({ platform: 'linux' });
      const configPaths = loadConfigPaths();
      configPaths.registerUserEnvironmentInjector(() => ({
        FOO: 'bar',
        TOKEN: 'sekret',
      }));

      const env = configPaths.getEnhancedEnv();
      expect(env.FOO).toBe('bar');
      expect(env.TOKEN).toBe('sekret');
      expect(env.CANOPY_ENV_ENHANCED).toBe('1');

      configPaths.registerUserEnvironmentInjector(null);
    });

    it('short-circuits when the marker is already set and no local injector is registered', () => {
      setProcessState({
        platform: 'linux',
        env: { CANOPY_ENV_ENHANCED: '1', INHERITED_FROM_PARENT: 'yes' },
      });
      const configPaths = loadConfigPaths();

      const env = configPaths.getEnhancedEnv();
      expect(env.INHERITED_FROM_PARENT).toBe('yes');
      expect(env.CANOPY_ENV_ENHANCED).toBe('1');
    });

    it('uses local injectors even when the marker was inherited from a parent process', () => {
      setProcessState({
        platform: 'linux',
        env: { CANOPY_ENV_ENHANCED: '1', INHERITED_FROM_PARENT: 'yes' },
      });
      const configPaths = loadConfigPaths();

      const injector = jest.fn(() => ({ FROM_INJECTOR: 'fresh-local-value' }));
      configPaths.registerUserEnvironmentInjector(injector);

      const env = configPaths.getEnhancedEnv();
      expect(injector).toHaveBeenCalledTimes(1);
      expect(env.INHERITED_FROM_PARENT).toBe('yes');
      expect(env.FROM_INJECTOR).toBe('fresh-local-value');
      expect(env.CANOPY_ENV_ENHANCED).toBe('1');

      configPaths.registerUserEnvironmentInjector(null);
    });

    it('preserves source-process opt-outs for user variables and managed secrets', () => {
      setProcessState({ platform: 'linux' });
      const configPaths = loadConfigPaths();
      configPaths.registerUserEnvironmentInjector(() => ({
        USER_VARIABLE: 'enabled',
      }));
      configPaths.registerSecretsEnvInjector(() => ({
        GH_TOKEN: 'managed-token',
      }));

      const fullyEnhanced = configPaths.getEnhancedEnv();
      expect(fullyEnhanced.USER_VARIABLE).toBe('enabled');
      expect(fullyEnhanced.GH_TOKEN).toBe('managed-token');

      const restricted = configPaths.getEnhancedEnv({
        environment: false,
        includeCanopySecrets: false,
      });
      expect(restricted.USER_VARIABLE).toBeUndefined();
      expect(restricted.GH_TOKEN).toBeUndefined();
      expect(restricted.CANOPY_ENV_ENHANCED).toBe('1');

      configPaths.registerUserEnvironmentInjector(null);
      configPaths.registerSecretsEnvInjector(null);
    });

    it('swallows injector errors and falls back to no user vars', () => {
      setProcessState({ platform: 'linux' });
      const configPaths = loadConfigPaths();
      configPaths.registerUserEnvironmentInjector(() => {
        throw new Error('boom');
      });

      const env = configPaths.getEnhancedEnv();
      expect(env.CANOPY_ENV_ENHANCED).toBe('1');
      expect(env.FOO).toBeUndefined();

      configPaths.registerUserEnvironmentInjector(null);
    });

    it.each([
      ['source', {}],
      ['descendant', { CANOPY_ENV_ENHANCED: '1' }],
    ])(
      'withholds the host crash reporter pipe on the %s path',
      (_path, inherited) => {
        const pipe = '\\\\.\\pipe\\crashpad_20696_VTJHFDPAIGVHITVG';
        setProcessState({
          platform: 'win32',
          env: { ...inherited, CHROME_CRASHPAD_PIPE_NAME: pipe },
        });
        const configPaths = loadConfigPaths();

        const env = configPaths.getEnhancedEnv();
        expect(env).not.toHaveProperty('CHROME_CRASHPAD_PIPE_NAME');
        // The app's own Chromium children still need it.
        expect(process.env.CHROME_CRASHPAD_PIPE_NAME).toBe(pipe);
      },
    );
  });
});
