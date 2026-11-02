import { mkdtempSync, rmSync, statSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type * as FsPromises from 'node:fs/promises';
import type * as DirectoryFlush from '@canopy/core-platform/directory-flush';
import { DirectoryFlushError } from '@canopy/core-platform/directory-flush';
import { StorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import {
  createDirectoryDurably,
  writeFileAtomically,
  writeFileAtomicallySync,
} from '../atomic-file';

const mockFlush = jest.fn<Promise<'flushed'>, [string]>();
const mockFlushSync = jest.fn<'flushed', [string]>();
jest.mock('@canopy/core-platform/directory-flush', () => ({
  ...jest.requireActual<typeof DirectoryFlush>(
    '@canopy/core-platform/directory-flush',
  ),
  flushDirectory: (path: string): Promise<'flushed'> => mockFlush(path),
  flushDirectorySync: (path: string): 'flushed' => mockFlushSync(path),
}));

/** Runs after a `mkdir` has created its folders and before it resolves. */
let mockAfterMkdir: ((path: string) => Promise<void>) | null = null;
/** Runs in place of the next `mkdir`, as one that fails partway. */
let mockFailingMkdir: (() => Promise<never>) | null = null;
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    mkdir: async (
      path: string,
      options: { recursive: true },
    ): Promise<string | undefined> => {
      const failing = mockFailingMkdir;
      mockFailingMkdir = null;
      if (failing) return failing();
      const created = await actual.mkdir(path, options);
      await mockAfterMkdir?.(path);
      return created;
    },
  };
});

const flushFailure = Object.assign(new Error('flush failed'), {
  name: 'DirectoryFlushError',
  code: 'EIO',
});

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atomic-durability-'));
  mockFlush.mockReset().mockResolvedValue('flushed');
  mockFlushSync.mockReset().mockReturnValue('flushed');
  mockAfterMkdir = null;
  mockFailingMkdir = null;
});

const noSpace = Object.assign(new Error('ENOSPC: no space left on device'), {
  code: 'ENOSPC',
});

/** A recursive `mkdir` that creates `created`, then fails with ENOSPC. */
function failMkdirAfterCreating(created?: string): void {
  mockFailingMkdir = async (): Promise<never> => {
    if (created !== undefined) await mkdir(created);
    throw noSpace;
  };
}
afterEach(() => rm(root, { recursive: true, force: true }));

/** Without a birth time a recreated folder may reuse its identity (CAN-5153). */
function tmpdirReportsBirthTime(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'atomic-durability-probe-'));
  try {
    return statSync(probe, { bigint: true }).birthtimeNs !== 0n;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const birthTimeIt = tmpdirReportsBirthTime() ? it : it.skip;

it('flushes the parent only after a durable install, and only for durable writes', async () => {
  const target = join(root, 'state.json');
  mockFlush.mockImplementation(async () => {
    expect(await readFile(target, 'utf8')).toBe('durable');
    return 'flushed';
  });
  await writeFileAtomically(target, 'plain');
  writeFileAtomicallySync(target, 'plain-sync');
  expect(mockFlush).not.toHaveBeenCalled();
  expect(mockFlushSync).not.toHaveBeenCalled();

  await writeFileAtomically(target, 'durable', { durable: true });
  expect(mockFlush.mock.calls).toEqual([[root]]);
  writeFileAtomicallySync(target, 'durable-sync', { durable: true });
  expect(mockFlushSync.mock.calls).toEqual([[root]]);
});

it.each([true, false])(
  'reports an installed write whose parent flush fails as outcome unknown (overwrite %s)',
  async (overwrite) => {
    const target = join(root, 'state.json');
    if (overwrite) await writeFile(target, 'previous');
    mockFlush.mockRejectedValueOnce(flushFailure);
    const failure = writeFileAtomically(target, 'next', {
      durable: true,
      overwrite,
    });
    await expect(failure).rejects.toBeInstanceOf(StorageOutcomeUnknownError);
    await expect(failure).rejects.toMatchObject({
      stage: 'directory_flush',
      cause: flushFailure,
    });
    expect(await readFile(target, 'utf8')).toBe('next');
    expect(await readdir(root)).toEqual(['state.json']);
  },
);

it('reports a synchronous install whose parent flush fails as outcome unknown', async () => {
  const target = join(root, 'state.json');
  mockFlushSync.mockImplementationOnce(() => {
    throw flushFailure;
  });
  expect(() =>
    writeFileAtomicallySync(target, 'next', { durable: true }),
  ).toThrow(StorageOutcomeUnknownError);
  expect(await readFile(target, 'utf8')).toBe('next');
});

it('never flushes or reports outcome unknown when the install itself fails', async () => {
  const missingParent = join(root, 'missing', 'state.json');
  await expect(
    writeFileAtomically(missingParent, 'next', { durable: true }),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(mockFlush).not.toHaveBeenCalled();
});

describe('createDirectoryDurably', () => {
  const inRoot = (): { dataRoot: string } => ({ dataRoot: root });

  it("flushes every folder up to the data root, the data root's parent last", async () => {
    const target = join(root, 'a', 'b', 'c');
    mockFlush.mockImplementation(async () => {
      await expect(stat(target)).resolves.toBeDefined();
      return 'flushed';
    });
    await createDirectoryDurably(
      join(root, 'a', 'x', '..', 'b', 'c'),
      inRoot(),
    );
    expect((await stat(target)).isDirectory()).toBe(true);
    expect(mockFlush.mock.calls).toEqual([
      [join(root, 'a', 'b')],
      [join(root, 'a')],
      [root],
      [dirname(root)],
    ]);
  });

  // CAN-5153: the data root that host registration or an earlier run created.
  it('flushes the parent of a data root that already exists', async () => {
    await createDirectoryDurably(root, { dataRoot: root });
    expect(mockFlush.mock.calls).toEqual([[dirname(root)]]);
  });

  // CAN-5151 D1 (Mike, 2026-10-30): Windows refusing the handle fails closed.
  it.each(['EPERM', 'EACCES'])(
    "fails closed when the data root's parent refuses its open with %s",
    async (code) => {
      const refused = new DirectoryFlushError(
        'open',
        Object.assign(new Error(`${code}: open`), { code }),
      );
      mockFlush.mockImplementation((path) =>
        path === dirname(root)
          ? Promise.reject(refused)
          : Promise.resolve('flushed'),
      );
      const write = createDirectoryDurably(join(root, 'a'), inRoot());
      await expect(write).rejects.toBe(refused);
      await expect(write).rejects.toMatchObject({ stage: 'open', code });
      mockFlush.mockClear();
      await expect(
        createDirectoryDurably(join(root, 'a'), inRoot()),
      ).rejects.toBe(refused);
      // Nothing above the data root's parent, and only it is retried.
      expect(mockFlush.mock.calls).toEqual([[dirname(root)]]);
    },
  );

  it('flushes an existing folder once, then nothing on later calls', async () => {
    await mkdir(join(root, 'a'));
    await createDirectoryDurably(join(root, 'a'), inRoot());
    expect(mockFlush.mock.calls).toEqual([[root], [dirname(root)]]);
    mockFlush.mockClear();
    await createDirectoryDurably(join(root, 'a'), inRoot());
    await createDirectoryDurably(root, inRoot());
    expect(mockFlush).not.toHaveBeenCalled();
    await createDirectoryDurably(join(root, 'a', 'b'), inRoot());
    expect(mockFlush.mock.calls).toEqual([[join(root, 'a')]]);
  });

  it('refuses a folder outside the data root, creating nothing', async () => {
    await expect(
      createDirectoryDurably(join(root, 'a'), {
        dataRoot: join(root, 'data'),
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(await readdir(root)).toEqual([]);
    expect(mockFlush).not.toHaveBeenCalled();
  });

  it('rejects with the flush failure and retries it on a later call', async () => {
    mockFlush.mockRejectedValueOnce(flushFailure);
    await expect(
      createDirectoryDurably(join(root, 'a', 'b'), inRoot()),
    ).rejects.toBe(flushFailure);
    mockFlush.mockClear();
    await createDirectoryDurably(join(root, 'a', 'b', 'c'), inRoot());
    expect(mockFlush.mock.calls).toEqual([
      [join(root, 'a', 'b')],
      [join(root, 'a')],
      [root],
      [dirname(root)],
    ]);
    mockFlush.mockClear();
    await createDirectoryDurably(join(root, 'a', 'b'), inRoot());
    expect(mockFlush).not.toHaveBeenCalled();
  });

  it('flushes on a retry the folders a failed mkdir created', async () => {
    failMkdirAfterCreating(join(root, 'a'));
    await expect(
      createDirectoryDurably(join(root, 'a', 'b'), inRoot()),
    ).rejects.toBe(noSpace);
    expect(mockFlush).not.toHaveBeenCalled();
    await createDirectoryDurably(join(root, 'a', 'b'), inRoot());
    expect(mockFlush.mock.calls).toEqual([
      [join(root, 'a')],
      [root],
      [dirname(root)],
    ]);
  });

  birthTimeIt(
    'flushes again a folder that was deleted and recreated',
    async () => {
      await createDirectoryDurably(join(root, 'a'), inRoot());
      // Past the birth time's tick (a few ms on Linux ext4): a reused inode
      // recreated within it keeps its identity (CAN-5153).
      await new Promise((settle) => setTimeout(settle, 50));
      await rm(join(root, 'a'), { recursive: true });
      mockFlush.mockClear();
      await createDirectoryDurably(join(root, 'a'), inRoot());
      expect(mockFlush.mock.calls).toEqual([[root]]);
    },
  );

  it('holds a racing caller until the creating call has flushed', async () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    mockFlush.mockImplementationOnce(async () => {
      reached.resolve();
      await release.promise;
      return 'flushed';
    });
    const creator = createDirectoryDurably(join(root, 'a'), inRoot());
    await reached.promise;
    let racerSettled = false;
    const racer = createDirectoryDurably(join(root, 'a'), inRoot()).then(() => {
      racerSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(racerSettled).toBe(false);
    release.resolve();
    await Promise.all([creator, racer]);
    expect(mockFlush.mock.calls).toEqual([[root], [dirname(root)]]);
  });

  it('holds a caller whose path runs through a folder another call is still creating', async () => {
    const created = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    mockAfterMkdir = async (path): Promise<void> => {
      if (path !== join(root, 'a', 'b')) return;
      created.resolve();
      await release.promise;
    };
    const creator = createDirectoryDurably(join(root, 'a', 'b'), inRoot());
    await created.promise;
    let racerSettled = false;
    const racer = createDirectoryDurably(join(root, 'a', 'c'), inRoot()).then(
      () => {
        racerSettled = true;
      },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(racerSettled).toBe(false);
    release.resolve();
    await Promise.all([creator, racer]);
    expect(mockFlush.mock.calls).toEqual([
      [join(root, 'a')],
      [root],
      [dirname(root)],
      [join(root, 'a')],
    ]);
  });
});
