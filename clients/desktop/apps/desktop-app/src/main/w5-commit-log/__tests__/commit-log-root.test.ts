import fs from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DirectoryFlushError } from '@canopy/core-platform/directory-flush';
import { registerW5Host } from '@canopy/desktop-shared/node/w5-host-cohort';
import { ensureW5DataRoot } from '../commit-log-root';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w5-root-'));
});

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const host = process.platform;

afterEach(() => {
  jest.restoreAllMocks();
  if (platform) Object.defineProperty(process, 'platform', platform);
  rmSync(dir, { recursive: true, force: true });
});

function recordFlushes(): {
  synced: string[];
  sync: (folder: string) => Promise<void>;
} {
  const synced: string[] = [];
  return {
    synced,
    sync: (folder): Promise<void> => {
      synced.push(folder);
      return Promise.resolve();
    },
  };
}

function fakePlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

/**
 * Windows refuses a standard user a read-write handle on folders it cannot
 * write, such as `C:\` and `C:\Users` (CAN-5151 D1).
 */
function refuseReadWriteOpen(refused: (path: string) => boolean): void {
  const open = fs.open;
  jest.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    if (flags === 'r+' && refused(resolve(String(path)))) {
      throw Object.assign(new Error('EPERM: operation not permitted, open'), {
        code: 'EPERM',
        syscall: 'open',
      });
    }
    // POSIX cannot open a folder read-write; its read-only open still flushes.
    const posixFolder =
      host !== 'win32' &&
      flags === 'r+' &&
      (await fs.stat(path).then(
        (stats) => stats.isDirectory(),
        () => false,
      ));
    return open(path, posixFolder ? 'r' : flags, mode);
  });
}

const posixIt = host === 'win32' ? it.skip : it;

/** Without a birth time a recreated folder may reuse its identity (CAN-5153). */
function tmpdirReportsBirthTime(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'w5-root-probe-'));
  try {
    return statSync(probe, { bigint: true }).birthtimeNs !== 0n;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const birthTimeIt = tmpdirReportsBirthTime() ? it : it.skip;

describe('W5 data root (CAN-3805)', () => {
  it('creates a missing root and flushes every folder up to the data root', async () => {
    const data = join(dir, 'data');
    const root = join(data, 'workspaces');
    const { synced, sync } = recordFlushes();
    await ensureW5DataRoot(root, sync, { dataRoot: data });
    expect(statSync(root).isDirectory()).toBe(true);
    expect(synced).toEqual([data, resolve(dir)]);
  });

  // CAN-5153: whoever created them, their entries were never flushed here.
  it("flushes an existing root and data root, the data root's parent last", async () => {
    const data = join(dir, 'data');
    const root = join(data, 'workspaces');
    mkdirSync(root, { recursive: true });
    const { synced, sync } = recordFlushes();
    await ensureW5DataRoot(root, sync, { dataRoot: data });
    expect(synced).toEqual([data, resolve(dir)]);
  });

  // The reviewer's case: registration creates the profile folder on POSIX.
  posixIt(
    "flushes the parent of a data root that host registration created, before the worker's start resolves",
    async () => {
      const home = join(dir, 'home');
      mkdirSync(home);
      const data = join(home, '.canopy');
      await registerW5Host({ dataRoot: data, hostKind: 'electron' });
      expect(statSync(data).isDirectory()).toBe(true);
      const { synced, sync } = recordFlushes();
      await ensureW5DataRoot(join(data, 'workspaces'), sync, {
        dataRoot: data,
        dbFolder: join(data, 'w5'),
      });
      expect(synced).toEqual([data, home, join(data, 'w5')]);
    },
  );

  it('flushes nothing on a later start in the same thread', async () => {
    const data = join(dir, 'data');
    const root = join(data, 'workspaces');
    await ensureW5DataRoot(root, recordFlushes().sync, { dataRoot: data });
    const { synced, sync } = recordFlushes();
    await ensureW5DataRoot(root, sync, { dataRoot: data });
    expect(synced).toEqual([]);
  });

  birthTimeIt(
    'flushes a root again once it was deleted and recreated',
    async () => {
      const data = join(dir, 'data');
      const root = join(data, 'workspaces');
      await ensureW5DataRoot(root, recordFlushes().sync, { dataRoot: data });
      // Past the birth time's tick (a few ms on Linux ext4): a reused inode
      // recreated within it keeps its identity (CAN-5153).
      await new Promise((settle) => setTimeout(settle, 50));
      rmSync(root, { recursive: true });
      const { synced, sync } = recordFlushes();
      await ensureW5DataRoot(root, sync, { dataRoot: data });
      expect(synced).toEqual([data]);
    },
  );

  describe('with the database folder', () => {
    it('covers its entry with the same holder flush, then flushes the folder itself', async () => {
      const data = join(dir, 'data');
      const dbFolder = join(data, 'w5');
      mkdirSync(dbFolder, { recursive: true });
      const { synced, sync } = recordFlushes();
      await ensureW5DataRoot(join(data, 'workspaces'), sync, {
        dataRoot: data,
        dbFolder,
      });
      expect(synced).toEqual([data, resolve(dir), dbFolder]);
    });

    // Not left to SQLite's own folder sync, which Windows SQLite lacks.
    it('flushes the folder itself on every start', async () => {
      const data = join(dir, 'data');
      const dbFolder = join(data, 'w5');
      const options = { dataRoot: data, dbFolder };
      const first = recordFlushes();
      await ensureW5DataRoot(join(data, 'workspaces'), first.sync, options);
      expect(first.synced).toEqual([data, resolve(dir), dbFolder]);
      const second = recordFlushes();
      await ensureW5DataRoot(join(data, 'workspaces'), second.sync, options);
      expect(second.synced).toEqual([dbFolder]);
    });
  });

  // CAN-5153: Windows will not open `C:\Users` or `C:\` read-write.
  it("never flushes above the data root's parent", async () => {
    fakePlatform('win32');
    const above = resolve(dir);
    refuseReadWriteOpen((path) => path !== above && above.startsWith(path));
    await expect(
      ensureW5DataRoot(join(dir, 'data', 'workspaces'), undefined, {
        dataRoot: join(dir, 'data'),
      }),
    ).resolves.toBeUndefined();
  });

  it("fails the start with a typed failure when the data root's parent refuses its flush", async () => {
    fakePlatform('win32');
    const above = resolve(dir);
    refuseReadWriteOpen((path) => path === above);
    const start = ensureW5DataRoot(join(dir, 'workspaces'));
    await expect(start).rejects.toBeInstanceOf(DirectoryFlushError);
    await expect(start).rejects.toMatchObject({ stage: 'open', code: 'EPERM' });
  });

  it('fails the start when a flush fails, so no commit is applied unprotected', async () => {
    const root = join(dir, 'workspaces');
    await expect(
      ensureW5DataRoot(root, () => Promise.reject(new Error('EIO'))),
    ).rejects.toThrow('EIO');
  });

  it('retries a flush an earlier start in this thread left failed', async () => {
    const data = join(dir, 'data');
    const root = join(data, 'workspaces');
    const anchor = resolve(dir);
    const failing = recordFlushes();
    const failAnchor = (folder: string): Promise<void> =>
      folder === anchor
        ? Promise.reject(new Error('EIO'))
        : failing.sync(folder);
    const options = { dataRoot: data };
    await expect(ensureW5DataRoot(root, failAnchor, options)).rejects.toThrow(
      'EIO',
    );
    const retry = recordFlushes();
    await ensureW5DataRoot(root, retry.sync, options);
    expect(retry.synced).toEqual([anchor]);
    const settled = recordFlushes();
    await ensureW5DataRoot(root, settled.sync, options);
    expect(settled.synced).toEqual([]);
  });

  it('flushes on a retry the folders a failed mkdir created', async () => {
    const data = join(dir, 'data');
    const root = join(data, 'workspaces');
    const mkdir = fs.mkdir;
    jest.spyOn(fs, 'mkdir').mockImplementationOnce(async () => {
      await mkdir(data);
      throw Object.assign(new Error('ENOSPC: no space left on device'), {
        code: 'ENOSPC',
      });
    });
    const failed = recordFlushes();
    await expect(
      ensureW5DataRoot(root, failed.sync, { dataRoot: data }),
    ).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(failed.synced).toEqual([]);
    const { synced, sync } = recordFlushes();
    await ensureW5DataRoot(root, sync, { dataRoot: data });
    expect(synced).toEqual([data, resolve(dir)]);
  });

  // A new worker thread starts with no record.
  it('flushes the chain again after a restart', async () => {
    const data = join(dir, 'data');
    const root = join(data, 'workspaces');
    await ensureW5DataRoot(root, recordFlushes().sync, { dataRoot: data });
    let restarted: typeof ensureW5DataRoot | undefined;
    await jest.isolateModulesAsync(async () => {
      restarted = (await import('../commit-log-root')).ensureW5DataRoot;
    });
    if (!restarted) throw new Error('commit-log-root did not load');
    const { synced, sync } = recordFlushes();
    await restarted(root, sync, { dataRoot: data });
    expect(synced).toEqual([data, resolve(dir)]);
  });

  it('refuses a root whose path runs through a file', async () => {
    const file = join(dir, 'file');
    await fs.writeFile(file, '');
    const { synced, sync } = recordFlushes();
    await expect(
      ensureW5DataRoot(join(file, 'workspaces'), sync),
    ).rejects.toThrow(/ENOTDIR|EEXIST/);
    expect(synced).toEqual([]);
  });

  it.each([
    ['root', { dataRoot: 'data' }, 'other'],
    [
      'database folder',
      { dataRoot: 'data', dbFolder: 'w5' },
      'data/workspaces',
    ],
  ])(
    'refuses a %s outside the data root, creating nothing',
    async (_name, relativeOptions, rootName) => {
      const { synced, sync } = recordFlushes();
      await expect(
        ensureW5DataRoot(join(dir, rootName), sync, {
          dataRoot: join(dir, relativeOptions.dataRoot),
          ...('dbFolder' in relativeOptions && {
            dbFolder: join(dir, relativeOptions.dbFolder),
          }),
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(synced).toEqual([]);
      await expect(fs.readdir(dir)).resolves.toEqual([]);
    },
  );
});
