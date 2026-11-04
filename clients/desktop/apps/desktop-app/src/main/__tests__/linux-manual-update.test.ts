import { BRAND } from '@canopy/brand/current';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectLinuxInstallSource,
  installedLinuxPackageArchitecture,
  type LinuxInstallRoots,
} from '../updater/linux-manual-update';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));
const mockedExecFile = jest.mocked(execFile);
const originalArch = process.arch;
const originalAppImage = process.env.APPIMAGE;
const originalAppDir = process.env.APPDIR;
const packageName = `${BRAND.cliName}-desktop`;

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

describe('Linux install source detection', () => {
  let root: string;
  let roots: Required<LinuxInstallRoots>;
  let ownedPath: string;

  async function writeDpkgList(lines: string[]): Promise<void> {
    await mkdir(roots.dpkgInfoDir, { recursive: true });
    await writeFile(
      join(roots.dpkgInfoDir, `${packageName}.list`),
      `${lines.join('\n')}\n`,
    );
  }

  async function writePacmanEntry(
    directory: string,
    desc: string,
    files: string[],
  ): Promise<void> {
    const entry = join(roots.pacmanLocalDir, directory);
    await mkdir(entry, { recursive: true });
    await writeFile(join(entry, 'desc'), desc);
    await writeFile(
      join(entry, 'files'),
      `%FILES%\n${files.join('\n')}\n\n%BACKUP%\n`,
    );
  }

  function pacmanDesc(name: string, version: string): string {
    return `%NAME%\n${name}\n\n%VERSION%\n${version}\n\n%ARCH%\nx86_64\n\n`;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    Object.defineProperty(process, 'arch', { value: 'x64' });
    delete process.env.APPIMAGE;
    delete process.env.APPDIR;
    root = await mkdtemp(join(tmpdir(), 'can-5103-install-'));
    const appDir = join(root, 'opt', packageName);
    await mkdir(appDir, { recursive: true });
    const execPath = join(appDir, packageName);
    await writeFile(execPath, '');
    roots = {
      dpkgInfoDir: join(root, 'dpkg', 'info'),
      pacmanLocalDir: join(root, 'pacman', 'local'),
      execPath,
    };
    await mkdir(roots.pacmanLocalDir, { recursive: true });
    await writeFile(join(roots.pacmanLocalDir, 'ALPM_DB_VERSION'), '9\n');
    ownedPath = (await realpath(execPath)).slice(1);
  });

  afterEach(async () => {
    Object.defineProperty(process, 'arch', { value: originalArch });
    if (originalAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = originalAppImage;
    if (originalAppDir === undefined) delete process.env.APPDIR;
    else process.env.APPDIR = originalAppDir;
    await rm(root, { recursive: true, force: true });
  });

  it('recognises the active executable in the brand dpkg ownership list', async () => {
    await writeDpkgList(['/.', roots.execPath]);
    await expect(detectLinuxInstallSource(roots)).resolves.toEqual({
      kind: 'deb',
      packageName,
    });
  });

  it('prefers dpkg ownership over a pacman record for the same executable', async () => {
    await writeDpkgList([roots.execPath]);
    await writePacmanEntry(
      `${packageName}-1.2.0-1`,
      pacmanDesc(packageName, '1.2.0-1'),
      [ownedPath],
    );
    await expect(detectLinuxInstallSource(roots)).resolves.toMatchObject({
      kind: 'deb',
    });
  });

  it('rejects an executable that dpkg does not own', async () => {
    await writeDpkgList([`/other/${packageName}`]);
    await expect(detectLinuxInstallSource(roots)).resolves.toEqual({
      kind: 'unknown',
    });
  });

  it('recognises a pacman install by exact name and owned executable', async () => {
    await writePacmanEntry(
      `${packageName}-1.2.0-1`,
      pacmanDesc(packageName, '1.2.0-1'),
      ['opt/', `opt/${packageName}/`, ownedPath],
    );
    await expect(detectLinuxInstallSource(roots)).resolves.toEqual({
      kind: 'pacman',
      packageName,
      version: '1.2.0-1',
    });
  });

  it('ignores packages that only share the name prefix', async () => {
    for (const name of [`${packageName}-bin`, `${packageName}-keyring`])
      await writePacmanEntry(`${name}-1.2.0-1`, pacmanDesc(name, '1.2.0-1'), [
        ownedPath,
      ]);
    await expect(detectLinuxInstallSource(roots)).resolves.toEqual({
      kind: 'unknown',
    });
  });

  it('finds the real package beside a prefix-collision package', async () => {
    await writePacmanEntry(
      `${packageName}-bin-9.0.0-1`,
      pacmanDesc(`${packageName}-bin`, '9.0.0-1'),
      [ownedPath],
    );
    await writePacmanEntry(
      `${packageName}-1.2.0-1`,
      pacmanDesc(packageName, '1.2.0-1'),
      [ownedPath],
    );
    await expect(detectLinuxInstallSource(roots)).resolves.toMatchObject({
      kind: 'pacman',
      version: '1.2.0-1',
    });
  });

  it('rejects a pacman package that does not list the executable', async () => {
    await writePacmanEntry(
      `${packageName}-1.2.0-1`,
      pacmanDesc(packageName, '1.2.0-1'),
      [`opt/${packageName}/other`, `/${ownedPath}`],
    );
    await expect(detectLinuxInstallSource(roots)).resolves.toEqual({
      kind: 'unknown',
    });
  });

  it.each([
    { shape: 'missing name', desc: '%VERSION%\n1.2.0-1\n\n' },
    { shape: 'missing version', desc: `%NAME%\n${packageName}\n\n` },
    { shape: 'binary noise', desc: '\u0000\u0001garbage' },
  ])('fails closed on a corrupt desc ($shape)', async ({ desc }) => {
    await writePacmanEntry(`${packageName}-1.2.0-1`, desc, [ownedPath]);
    await expect(detectLinuxInstallSource(roots)).resolves.toEqual({
      kind: 'unknown',
    });
  });

  it('fails closed when a pacman record cannot be read', async () => {
    await mkdir(join(roots.pacmanLocalDir, `${packageName}-1.2.0-1`, 'desc'), {
      recursive: true,
    });
    await expect(detectLinuxInstallSource(roots)).resolves.toEqual({
      kind: 'unknown',
    });
  });

  it('reports unknown when no package database exists', async () => {
    await expect(
      detectLinuxInstallSource({
        ...roots,
        pacmanLocalDir: join(root, 'missing'),
      }),
    ).resolves.toEqual({ kind: 'unknown' });
  });

  it.each(['APPIMAGE', 'APPDIR'])(
    'reports an AppImage for %s without trusting package records',
    async (name) => {
      await writeDpkgList([roots.execPath]);
      process.env[name] = '/untrusted';
      await expect(detectLinuxInstallSource(roots)).resolves.toEqual({
        kind: 'appimage',
      });
    },
  );

  it.each(['ia32', 'arm', 'riscv64'])('rejects %s', async (arch) => {
    Object.defineProperty(process, 'arch', { value: arch });
    await writeDpkgList([roots.execPath]);
    await expect(detectLinuxInstallSource(roots)).resolves.toEqual({
      kind: 'unknown',
    });
  });
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
