import { ChildProcess, type ExecFileOptions } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupWindowsUpdateTempFiles,
  createWindowsUpdateVerifier,
} from '../updater/windows-update';
import { drainOwnedProcess } from '../lib/process-kill';

type Complete = (error: Error | null, stdout: string, stderr: string) => void;
type ExecArguments = [string, string[], ExecFileOptions, Complete];
const mockExecFile = jest.fn<ChildProcess, ExecArguments>();
let mockCacheRoot = '';
jest.mock('electron-updater/out/ElectronAppAdapter', () => ({
  ElectronAppAdapter: class {
    get baseCachePath(): string {
      return mockCacheRoot;
    }
  },
}));
jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof ChildProcessModule>('node:child_process'),
  execFile: (...args: ExecArguments): ChildProcess => mockExecFile(...args),
}));
jest.mock('../lib/process-kill', () => ({ drainOwnedProcess: jest.fn() }));
jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getEnhancedEnv: (): NodeJS.ProcessEnv => ({
    PSModulePath: 'broken',
    PsModulePath: 'also broken',
  }),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessInfo: jest.fn(),
  logMainProcessWarn: jest.fn(),
  logMainProcessError: jest.fn(),
}));

const file = "C:\\Users\\Zoë O'Brien\\temp-setup.exe";
const validData = {
  Status: 0,
  Path: file,
  Subject: 'CN=Example Corporation,O=Example Corporation,C=US',
};
const valid = JSON.stringify(validData);

describe('Windows update temporary installer cleanup', () => {
  beforeEach(async () => {
    mockCacheRoot = await mkdtemp(join(tmpdir(), 'can-4188-cleanup-'));
  });
  afterEach(async () => {
    await rm(mockCacheRoot, { recursive: true, force: true });
  });

  it('removes numbered and ordinary partial installers while preserving cached updates and other entries', async () => {
    const pending = join(mockCacheRoot, 'test-updater', 'pending');
    await mkdir(pending, { recursive: true });
    for (const name of [
      'temp-setup.exe',
      '0-temp-setup.exe',
      '12-temp-other.EXE',
      'setup.exe',
      'update-info.json',
      'current.blockmap',
      'temp-not-an-installer.txt',
    ]) {
      await writeFile(join(pending, name), name);
    }
    await mkdir(join(pending, 'temp-directory.exe'));
    await writeFile(
      join(pending, 'temp-directory.exe', 'owned-by-something-else'),
      'keep',
    );
    await cleanupWindowsUpdateTempFiles({
      configOnDisk: {
        value: Promise.resolve({ updaterCacheDirName: 'test-updater' }),
      },
    });
    expect((await readdir(pending)).sort()).toEqual([
      'current.blockmap',
      'setup.exe',
      'temp-directory.exe',
      'temp-not-an-installer.txt',
      'update-info.json',
    ]);
    expect(
      await readFile(
        join(pending, 'temp-directory.exe', 'owned-by-something-else'),
        'utf8',
      ),
    ).toBe('keep');
  });

  it('accepts an empty cache and refuses a configuration that escapes the updater directory', async () => {
    await expect(
      cleanupWindowsUpdateTempFiles({
        configOnDisk: { value: { updaterCacheDirName: 'test-updater' } },
      }),
    ).resolves.toBeUndefined();
    await expect(
      cleanupWindowsUpdateTempFiles({
        configOnDisk: { value: { updaterCacheDirName: '../other' } },
      }),
    ).rejects.toMatchObject({ code: 'ERR_UPDATER_TEMP_CLEANUP_FAILED' });
  });
});

describe('Windows update signature verification', () => {
  let complete: Complete;
  let child: ChildProcess;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    child = new ChildProcess();
    Object.defineProperty(child, 'pid', { value: 42 });
    mockExecFile.mockImplementation(
      (_exe: string, _args: string[], _options: object, callback: Complete) => {
        complete = callback;
        return child;
      },
    );
  });
  afterEach(() => jest.useRealTimers());

  it('allows a valid check to take over 40 seconds and preserves safe path quoting', async () => {
    const verify = createWindowsUpdateVerifier();
    const result = verify(['Example Corporation'], file);
    await jest.advanceTimersByTimeAsync(40_500);
    expect(drainOwnedProcess).not.toHaveBeenCalled();
    const [, args, options] = mockExecFile.mock.calls[0];
    expect(options).toMatchObject({
      shell: false,
      windowsHide: true,
      env: { PSModulePath: '' },
    });
    expect(options.env?.PsModulePath).toBeUndefined();
    expect(
      Buffer.from(args[args.length - 1], 'base64').toString('utf16le'),
    ).toContain("Zoë O''Brien");
    complete(null, valid, '');
    await expect(result).resolves.toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('awaits tree cleanup before retrying and reports a final timeout after one retry', async () => {
    let releaseCleanup: (() => void) | undefined;
    jest.mocked(drainOwnedProcess).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    );
    const verify = createWindowsUpdateVerifier({ timeoutMs: 120_000 });
    const result = verify(['Example Corporation'], file);
    const rejected = expect(result).rejects.toMatchObject({
      code: 'ERR_UPDATER_SIGNATURE_TIMEOUT',
    });
    await jest.advanceTimersByTimeAsync(120_000);
    expect(drainOwnedProcess).toHaveBeenCalledWith(42, expect.any(Function));
    complete(new Error('killed'), '', '');
    await jest.advanceTimersByTimeAsync(0);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    releaseCleanup?.();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    jest.mocked(drainOwnedProcess).mockImplementationOnce(() => {
      complete(new Error('killed again'), '', '');
      return Promise.resolve();
    });
    await jest.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('can succeed on the one bounded timeout retry', async () => {
    jest.mocked(drainOwnedProcess).mockImplementationOnce(() => {
      complete(new Error('killed'), '', '');
      return Promise.resolve();
    });
    const result = createWindowsUpdateVerifier({ timeoutMs: 1_000 })(
      ['Example Corporation'],
      file,
    );
    await jest.advanceTimersByTimeAsync(1_000);
    complete(null, valid, '');
    await expect(result).resolves.toBeNull();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it('awaits direct reader termination and never retries a failed tree cleanup', async () => {
    jest
      .mocked(drainOwnedProcess)
      .mockRejectedValueOnce(new Error('taskkill failed'));
    const kill = jest.spyOn(child, 'kill').mockImplementation(() => {
      complete(new Error('reader killed'), '', '');
      child.emit('close', null, 'SIGKILL');
      return true;
    });
    const result = createWindowsUpdateVerifier({ timeoutMs: 1_000 })(
      ['Example Corporation'],
      file,
    );
    const rejected = expect(result).rejects.toMatchObject({
      code: 'ERR_UPDATER_SIGNATURE_CHECK_FAILED',
    });
    await jest.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    { ...validData, Status: 2 },
    { ...validData, Path: 'C:\\other.exe' },
    { ...validData, Subject: 'CN=Another Publisher' },
    { ...validData, Subject: null },
    { Status: 0 },
  ])(
    'rejects an invalid signature, path, publisher or response without retrying',
    async (data) => {
      const result = createWindowsUpdateVerifier()(
        ['Example Corporation'],
        file,
      );
      complete(null, JSON.stringify(data), '');
      expect(await result).not.toBeNull();
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    },
  );

  it('matches every configured distinguished-name attribute', async () => {
    const result = createWindowsUpdateVerifier()(
      ['CN=Example Corporation,O=Other Company'],
      file,
    );
    complete(null, valid, '');
    expect(await result).toContain('unexpected publisher');
  });

  it.each(['not json', ''])(
    'fails closed on malformed output without retrying',
    async (output) => {
      const result = createWindowsUpdateVerifier()(
        ['Example Corporation'],
        file,
      );
      const rejected = expect(result).rejects.toMatchObject({
        code: 'ERR_UPDATER_SIGNATURE_CHECK_FAILED',
      });
      complete(null, output, '');
      await rejected;
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    },
  );

  it('fails closed on PowerShell failure without a capability-probe bypass', async () => {
    const result = createWindowsUpdateVerifier()(['Example Corporation'], file);
    const rejected = expect(result).rejects.toMatchObject({
      code: 'ERR_UPDATER_SIGNATURE_CHECK_FAILED',
    });
    complete(new Error('PowerShell unavailable'), '', '');
    await rejected;
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });
});
