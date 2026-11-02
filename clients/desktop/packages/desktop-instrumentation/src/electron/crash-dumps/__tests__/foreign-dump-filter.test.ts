import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  createForeignCrashDumpFilter,
  isInsideAppRoot,
  resolveAppRoot,
  type ForeignCrashDumpFilterOptions,
} from '../foreign-dump-filter';

type ExecutableReader = NonNullable<
  ForeignCrashDumpFilterOptions['readExecutablePath']
>;
type ExecutableReaderResult = Awaited<ReturnType<ExecutableReader>>;

interface DumpFixture {
  readonly crashDumpsDir: string;
  readonly filePath: string;
}

const originalWorkingDirectory = process.cwd();
let tempDirectories: string[] = [];

function successfulReader(executablePath: string): ExecutableReader {
  return (): Promise<ExecutableReaderResult> =>
    Promise.resolve({ status: 'ok', executablePath });
}

function createFilter(
  crashDumpsDir: string,
  appExePath: string,
  platform: NodeJS.Platform,
  readExecutablePath: ExecutableReader,
): (filePath: string) => Promise<'process' | 'discard'> {
  return createForeignCrashDumpFilter({
    getCrashDumpsDir: () => crashDumpsDir,
    getExePath: () => appExePath,
    platform,
    readExecutablePath,
  });
}

async function createDumpFixture(
  ...subdirectories: string[]
): Promise<DumpFixture> {
  const crashDumpsDir = await mkdtemp(
    path.join(tmpdir(), 'foreign-dump-filter-'),
  );
  tempDirectories.push(crashDumpsDir);
  const directory = path.join(crashDumpsDir, ...subdirectories);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, 'dump.dmp');
  await writeFile(filePath, 'synthetic dump');
  return { crashDumpsDir, filePath };
}

async function createWin32DumpFixture(
  directoryName: string = 'reports',
): Promise<DumpFixture> {
  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), 'foreign-dump-filter-win32-'),
  );
  tempDirectories.push(tempDirectory);

  if (process.platform === 'win32') {
    const crashDumpsDir = path.win32.join(tempDirectory, 'Crashpad');
    const filePath = path.win32.join(crashDumpsDir, directoryName, 'dump.dmp');
    await mkdir(path.win32.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'synthetic dump');
    const driveRoot = path.win32.parse(crashDumpsDir).root;
    const caseVariantCrashDumpsDir = `${driveRoot.toLowerCase()}${crashDumpsDir.slice(driveRoot.length)}`;
    return { crashDumpsDir: caseVariantCrashDumpsDir, filePath };
  }

  process.chdir(tempDirectory);
  const crashDumpsDir = 'C:\\Crashpad';
  const filePath = path.win32.join(crashDumpsDir, directoryName, 'dump.dmp');
  await writeFile(filePath, 'synthetic dump');
  return { crashDumpsDir, filePath };
}

beforeEach(() => {
  tempDirectories = [];
  process.chdir(originalWorkingDirectory);
});

afterEach(async () => {
  process.chdir(originalWorkingDirectory);
  await Promise.all(
    tempDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('createForeignCrashDumpFilter', () => {
  it('discards foreign node dumps from pending and completed directories', async () => {
    const appExePath = '/Applications/Canopy.app/Contents/MacOS/Canopy';
    const pending = await createDumpFixture('pending');
    const completed = await createDumpFixture('completed');

    expect(
      await createFilter(
        pending.crashDumpsDir,
        appExePath,
        'darwin',
        successfulReader('/usr/local/bin/node'),
      )(pending.filePath),
    ).toBe('discard');
    expect(
      await createFilter(
        completed.crashDumpsDir,
        appExePath,
        'darwin',
        successfulReader('/usr/local/bin/node'),
      )(completed.filePath),
    ).toBe('discard');
  });

  it('discards foreign node dumps from Windows reports directories', async () => {
    const fixture = await createWin32DumpFixture();
    const filter = createFilter(
      fixture.crashDumpsDir,
      'c:\\Program Files\\Canopy\\Canopy.exe',
      'win32',
      successfulReader('D:\\Users\\user\\AppData\\Local\\node.exe'),
    );

    expect(await filter(fixture.filePath)).toBe('discard');
  });

  it('discards a foreign Windows node.exe when the drive-letter case differs', async () => {
    const fixture = await createWin32DumpFixture();
    const filter = createFilter(
      fixture.crashDumpsDir,
      'c:\\Program Files\\Canopy\\Canopy.exe',
      'win32',
      successfulReader('C:\\Users\\user\\AppData\\Local\\node.exe'),
    );

    expect(await filter(fixture.filePath)).toBe('discard');
  });

  it('discards a foreign Windows node at a UNC path', async () => {
    const fixture = await createWin32DumpFixture();
    const filter = createFilter(
      fixture.crashDumpsDir,
      'C:\\Program Files\\Canopy\\Canopy.exe',
      'win32',
      successfulReader('\\\\server\\share\\tools\\node'),
    );

    expect(await filter(fixture.filePath)).toBe('discard');
  });

  it('keeps dumps under Crashpad new because they may still be written', async () => {
    const fixture = await createDumpFixture('NEW');
    const reader = jest.fn(successfulReader('/usr/local/bin/node'));
    const filter = createFilter(
      fixture.crashDumpsDir,
      '/Applications/Canopy.app/Contents/MacOS/Canopy',
      'darwin',
      reader,
    );

    expect(await filter(fixture.filePath)).toBe('process');
    expect(reader).not.toHaveBeenCalled();
  });

  it('compares Windows new paths case-insensitively', async () => {
    const fixture = await createWin32DumpFixture('NEW');
    const reader = jest.fn(successfulReader('D:\\Users\\user\\node.exe'));
    const filter = createFilter(
      fixture.crashDumpsDir,
      'C:\\Program Files\\Canopy\\Canopy.exe',
      'win32',
      reader,
    );

    expect(await filter(fixture.filePath)).toBe('process');
    expect(reader).not.toHaveBeenCalled();
  });

  it('keeps the Canopy executable and bundled node paths', async () => {
    const fixture = await createDumpFixture('pending');
    const appExePath = '/Applications/Canopy.app/Contents/MacOS/Canopy';
    const filterFor = (
      executablePath: string,
    ): ReturnType<typeof createForeignCrashDumpFilter> =>
      createFilter(
        fixture.crashDumpsDir,
        appExePath,
        'darwin',
        successfulReader(executablePath),
      );

    expect(await filterFor(appExePath)(fixture.filePath)).toBe('process');
    expect(
      await filterFor('/Applications/Canopy.app/Contents/Resources/node')(
        fixture.filePath,
      ),
    ).toBe('process');
  });

  it.each([
    '/Applications/Canopy-old.app/Contents/Resources/bin/node',
    '/Applications/Other.app/Contents/MacOS/node',
  ])('keeps node executables with an app bundle component: %s', async (exe) => {
    const fixture = await createDumpFixture('pending');
    const filter = createFilter(
      fixture.crashDumpsDir,
      '/Applications/Canopy.app/Contents/MacOS/Canopy',
      'darwin',
      successfulReader(exe),
    );

    expect(await filter(fixture.filePath)).toBe('process');
  });

  it('keeps a macOS helper app node executable under Contents/Frameworks', async () => {
    const fixture = await createDumpFixture('pending');
    const filter = createFilter(
      fixture.crashDumpsDir,
      '/Applications/Canopy.app/Contents/MacOS/Canopy',
      'darwin',
      successfulReader(
        '/Applications/Canopy.app/Contents/Frameworks/Helper.app/Contents/MacOS/node',
      ),
    );

    expect(await filter(fixture.filePath)).toBe('process');
  });

  it('keeps a Windows executable path containing an 8.3 short-name component', async () => {
    const fixture = await createWin32DumpFixture();
    const filter = createFilter(
      fixture.crashDumpsDir,
      'C:\\Program Files\\Canopy\\Canopy.exe',
      'win32',
      successfulReader('C:\\PROGRA~1\\Canopy\\node.exe'),
    );

    expect(await filter(fixture.filePath)).toBe('process');
  });

  it('keeps a foreign python3 executable', async () => {
    const fixture = await createDumpFixture('pending');
    const filter = createFilter(
      fixture.crashDumpsDir,
      '/Applications/Canopy.app/Contents/MacOS/Canopy',
      'darwin',
      successfulReader('/usr/bin/python3'),
    );

    expect(await filter(fixture.filePath)).toBe('process');
  });

  it('keeps a dump when its reader returns a relative executable path', async () => {
    const fixture = await createDumpFixture('pending');
    const filter = createFilter(
      fixture.crashDumpsDir,
      '/Applications/Canopy.app/Contents/MacOS/Canopy',
      'darwin',
      successfulReader('usr/local/bin/node'),
    );

    expect(await filter(fixture.filePath)).toBe('process');
  });

  it('keeps dumps for drive-relative, rooted, and extended Windows executable paths', async () => {
    const fixture = await createWin32DumpFixture();
    const executablePaths = [
      'C:foo',
      '\\foo',
      '\\\\?\\C:\\Program Files\\Canopy\\node.exe',
      '\\\\.\\C:\\Program Files\\Canopy\\node.exe',
    ];

    for (const executablePath of executablePaths) {
      const filter = createFilter(
        fixture.crashDumpsDir,
        'C:\\Program Files\\Canopy\\Canopy.exe',
        'win32',
        successfulReader(executablePath),
      );
      expect(await filter(fixture.filePath)).toBe('process');
    }
  });

  it('keeps a symlinked dump', async () => {
    const fixture = await createDumpFixture('pending');
    const targetPath = path.join(fixture.crashDumpsDir, 'target.dmp');
    await writeFile(targetPath, 'synthetic dump');
    await rm(fixture.filePath);
    await symlink(targetPath, fixture.filePath);
    const filter = createFilter(
      fixture.crashDumpsDir,
      '/Applications/Canopy.app/Contents/MacOS/Canopy',
      'darwin',
      successfulReader('/usr/local/bin/node'),
    );

    expect((await lstat(fixture.filePath)).isSymbolicLink()).toBe(true);
    expect(await filter(fixture.filePath)).toBe('process');
  });

  it('keeps a dump outside the Crashpad directory', async () => {
    const fixture = await createDumpFixture('pending');
    const outsideFilePath = path.join(
      path.dirname(fixture.crashDumpsDir),
      'outside-crashpad.dmp',
    );
    const filter = createFilter(
      fixture.crashDumpsDir,
      '/Applications/Canopy.app/Contents/MacOS/Canopy',
      'darwin',
      successfulReader('/usr/local/bin/node'),
    );

    expect(await filter(outsideFilePath)).toBe('process');
  });

  it('keeps a dump when the reader reports it as unreadable', async () => {
    const fixture = await createDumpFixture('pending');
    const unreadableReader: ExecutableReader = () =>
      Promise.resolve({ status: 'unreadable' });
    const filter = createFilter(
      fixture.crashDumpsDir,
      '/Applications/Canopy.app/Contents/MacOS/Canopy',
      'darwin',
      unreadableReader,
    );

    expect(await filter(fixture.filePath)).toBe('process');
  });

  it('keeps a dump when the reader throws', async () => {
    const fixture = await createDumpFixture('pending');
    const throwingReader: ExecutableReader = () =>
      Promise.reject(new Error('synthetic reader failure'));
    const filter = createFilter(
      fixture.crashDumpsDir,
      '/Applications/Canopy.app/Contents/MacOS/Canopy',
      'darwin',
      throwingReader,
    );

    await expect(filter(fixture.filePath)).resolves.toBe('process');
  });

  it('keeps a dump when the executable path getter throws', async () => {
    const fixture = await createDumpFixture('pending');
    const filter = createForeignCrashDumpFilter({
      getCrashDumpsDir: () => fixture.crashDumpsDir,
      getExePath: () => {
        throw new Error('synthetic exe path failure');
      },
      platform: 'darwin',
      readExecutablePath: successfulReader('/usr/local/bin/node'),
    });

    await expect(filter(fixture.filePath)).resolves.toBe('process');
  });

  it('keeps a dump when the Crashpad directory getter throws', async () => {
    const fixture = await createDumpFixture('pending');
    const filter = createForeignCrashDumpFilter({
      getCrashDumpsDir: () => {
        throw new Error('synthetic Crashpad path failure');
      },
      getExePath: () => '/Applications/Canopy.app/Contents/MacOS/Canopy',
      platform: 'darwin',
      readExecutablePath: successfulReader('/usr/local/bin/node'),
    });

    await expect(filter(fixture.filePath)).resolves.toBe('process');
  });

  it('resolves Crashpad and executable paths lazily and only once', async () => {
    const fixture = await createDumpFixture('pending');
    const secondFilePath = path.join(
      fixture.crashDumpsDir,
      'completed',
      'second.dmp',
    );
    await mkdir(path.dirname(secondFilePath), { recursive: true });
    await writeFile(secondFilePath, 'synthetic dump');
    const getCrashDumpsDir = jest.fn(() => fixture.crashDumpsDir);
    const getExePath = jest.fn(
      () => '/Applications/Canopy.app/Contents/MacOS/Canopy',
    );
    const filter = createForeignCrashDumpFilter({
      getCrashDumpsDir,
      getExePath,
      platform: 'darwin',
      readExecutablePath: successfulReader('/usr/local/bin/node'),
    });

    expect(getCrashDumpsDir).not.toHaveBeenCalled();
    expect(getExePath).not.toHaveBeenCalled();
    expect(await filter(fixture.filePath)).toBe('discard');
    expect(await filter(secondFilePath)).toBe('discard');
    expect(getCrashDumpsDir).toHaveBeenCalledTimes(1);
    expect(getExePath).toHaveBeenCalledTimes(1);
  });

  it('does not log while filtering dumps', async () => {
    const fixture = await createDumpFixture('pending');
    const methods = ['debug', 'info', 'log', 'warn', 'error'] as const;
    const spies = methods.map((method) =>
      jest.spyOn(console, method).mockImplementation((): void => undefined),
    );
    const filter = createFilter(
      fixture.crashDumpsDir,
      '/Applications/Canopy.app/Contents/MacOS/Canopy',
      'darwin',
      successfulReader('/usr/local/bin/node'),
    );

    try {
      expect(await filter(fixture.filePath)).toBe('discard');
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});

describe('app root paths', () => {
  it('resolves the nearest macOS app bundle ancestor case-insensitively', () => {
    expect(
      resolveAppRoot(
        '/Applications/Canopy.APP/Contents/MacOS/Canopy',
        'darwin',
      ),
    ).toBe('/Applications/Canopy.APP');
    expect(resolveAppRoot('/usr/local/bin/node', 'darwin')).toBe(
      '/usr/local/bin',
    );
    expect(
      resolveAppRoot('C:\\Program Files\\Canopy\\Canopy.exe', 'win32'),
    ).toBe('C:\\Program Files\\Canopy');
  });

  it('treats a ..cache component as inside, not as a parent traversal', () => {
    expect(isInsideAppRoot('/tmp/app/..cache/node', '/tmp/app', 'linux')).toBe(
      true,
    );
    expect(isInsideAppRoot('/tmp/outside/node', '/tmp/app', 'linux')).toBe(
      false,
    );
  });
});
