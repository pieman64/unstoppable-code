import { BRAND } from '@canopy/brand/current';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  installedLinuxPackageArchitecture,
  isInstalledLinuxDeb,
} from '../updater/linux-manual-update';

jest.mock('node:fs/promises', () => ({ readFile: jest.fn() }));
jest.mock('node:child_process', () => ({ execFile: jest.fn() }));
const mockedReadFile = jest.mocked(readFile);
const mockedExecFile = jest.mocked(execFile);
const originalArch = process.arch;
const originalAppImage = process.env.APPIMAGE;
const originalAppDir = process.env.APPDIR;

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

function mockDpkg(result: { stdout: string } | { error: Error }): void {
  mockedExecFile.mockImplementation((...args: unknown[]) => {
    const callback = args.find(
      (arg): arg is ExecFileCallback => typeof arg === 'function',
    );
    if ('error' in result) callback?.(result.error, '', '');
    else callback?.(null, result.stdout, '');
    return undefined as never;
  });
}

describe('installed Linux Debian package identity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(process, 'arch', { value: 'x64' });
    delete process.env.APPIMAGE;
    delete process.env.APPDIR;
  });
  afterEach(() => {
    Object.defineProperty(process, 'arch', { value: originalArch });
    if (originalAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = originalAppImage;
    if (originalAppDir === undefined) delete process.env.APPDIR;
    else process.env.APPDIR = originalAppDir;
  });
  it('requires the active executable in the brand dpkg ownership list', async () => {
    mockedReadFile.mockResolvedValue(`${process.execPath}\n`);
    await expect(isInstalledLinuxDeb()).resolves.toBe(true);
    expect(mockedReadFile).toHaveBeenCalledWith(
      `/var/lib/dpkg/info/${BRAND.cliName}-desktop.list`,
      'utf8',
    );
  });
  it('rejects an unowned executable', async () => {
    mockedReadFile.mockResolvedValue('/other/canopy-desktop\n');
    await expect(isInstalledLinuxDeb()).resolves.toBe(false);
  });
  it.each(['ENOENT', 'EACCES', 'EROFS'])(
    'fails closed on %s without writing or elevating',
    async (code) => {
      mockedReadFile.mockRejectedValue(
        Object.assign(new Error(code), { code }),
      );
      await expect(isInstalledLinuxDeb()).resolves.toBe(false);
    },
  );
  it('accepts an owned arm64 package', async () => {
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    mockedReadFile.mockResolvedValue(`${process.execPath}\n`);
    await expect(isInstalledLinuxDeb()).resolves.toBe(true);
  });
  it.each(['ia32', 'arm', 'riscv64'])('rejects %s', async (arch) => {
    Object.defineProperty(process, 'arch', { value: arch });
    await expect(isInstalledLinuxDeb()).resolves.toBe(false);
    expect(mockedReadFile).not.toHaveBeenCalled();
  });
  it.each(['APPIMAGE', 'APPDIR'])(
    'rejects %s without reading ownership',
    async (name) => {
      process.env[name] = '/untrusted';
      await expect(isInstalledLinuxDeb()).resolves.toBe(false);
      expect(mockedReadFile).not.toHaveBeenCalled();
    },
  );
});

describe('installed Linux package architecture', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(process, 'arch', { value: 'x64' });
  });
  afterEach(() => {
    Object.defineProperty(process, 'arch', { value: originalArch });
  });
  it('asks dpkg asynchronously by absolute path with a bounded timeout', async () => {
    mockDpkg({ stdout: 'amd64\n' });
    await expect(installedLinuxPackageArchitecture()).resolves.toBe('x64');
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockedExecFile.mock.calls[0];
    expect(command).toBe('/usr/bin/dpkg');
    expect(args).toEqual(['--print-architecture']);
    expect(options?.timeout).toBeGreaterThan(0);
    expect(options?.timeout).toBeLessThanOrEqual(5_000);
  });
  it.each([
    { reported: 'amd64', host: 'arm64', expected: 'x64' },
    { reported: 'arm64', host: 'x64', expected: 'arm64' },
    { reported: '  arm64 \n', host: 'x64', expected: 'arm64' },
  ])(
    'prefers the dpkg architecture $reported over the $host process',
    async ({ reported, host, expected }) => {
      Object.defineProperty(process, 'arch', { value: host });
      mockDpkg({ stdout: reported });
      await expect(installedLinuxPackageArchitecture()).resolves.toBe(expected);
    },
  );
  it.each(['i386', 'armhf', 'riscv64', 'amd64 arm64', 'x64'])(
    'reports an unsupported dpkg architecture %s without falling back',
    async (reported) => {
      mockDpkg({ stdout: `${reported}\n` });
      await expect(installedLinuxPackageArchitecture()).resolves.toBeNull();
    },
  );
  it.each([
    { host: 'x64', expected: 'x64' },
    { host: 'arm64', expected: 'arm64' },
    { host: 'ia32', expected: null },
  ])(
    'falls back to the $host process when dpkg is unavailable',
    async ({ host, expected }) => {
      Object.defineProperty(process, 'arch', { value: host });
      mockDpkg({
        error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      });
      await expect(installedLinuxPackageArchitecture()).resolves.toBe(expected);
    },
  );
  it('falls back to the process when dpkg prints nothing', async () => {
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    mockDpkg({ stdout: '' });
    await expect(installedLinuxPackageArchitecture()).resolves.toBe('arm64');
  });
});
