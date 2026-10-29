import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  W5CommitLog,
  fingerprintW5File,
  recoverW5CommitLog,
  testW5Durability,
  type W5DurabilityPort,
} from './fixtures/with-durability';

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return { ...actual, open: jest.fn(actual.open) };
});

const mockedOpen = jest.mocked(fsPromises.open);
const actualOpen =
  jest.requireActual<typeof FsPromises>('node:fs/promises').open;

interface ObservedFileHandle {
  sync: jest.SpyInstance<Promise<void>, []>;
  close: jest.SpyInstance<Promise<void>, []>;
}

function observeFileOpens(
  target: string,
  syncFailure?: Error,
  closeFailure?: Error,
): ObservedFileHandle[] {
  const handles: ObservedFileHandle[] = [];
  mockedOpen.mockImplementation(async (...args) => {
    const handle = await actualOpen(...args);
    if (args[0] === target) {
      const closeFile = handle.close.bind(handle);
      const sync = jest.spyOn(handle, 'sync');
      if (syncFailure) sync.mockRejectedValue(syncFailure);
      const close = jest.spyOn(handle, 'close').mockImplementation(async () => {
        await closeFile();
        if (closeFailure) throw closeFailure;
      });
      handles.push({ sync, close });
    }
    return handle;
  });
  return handles;
}

let dir: string;
let log: W5CommitLog;
let synced: string[];
let written: string[];

// Records what the applier asks of its host, then does it for real, so a
// missing folder still fails its sync as it would on disk.
const durability: W5DurabilityPort = {
  syncDirectory: (folder: string): Promise<void> => {
    synced.push(folder);
    return testW5Durability.syncDirectory(folder);
  },
  writeFileDurably: (path: string, contents: string): Promise<void> => {
    written.push(path);
    return testW5Durability.writeFileDurably(path, contents);
  },
};

beforeEach(() => {
  mockedOpen.mockReset().mockImplementation(actualOpen);
  dir = mkdtempSync(join(tmpdir(), 'w5-durable-'));
  log = W5CommitLog.open(join(dir, 'commit-log.sqlite'));
  synced = [];
  written = [];
});

afterEach(() => {
  log.close();
  rmSync(dir, { recursive: true, force: true });
});

const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

describeOnPosix('W5 commit applier durability (CAN-3805)', () => {
  it('flushes the folder of a removed file before marking the commit applied', async () => {
    const removed = join(dir, 'workspaces', 'gone.json');
    rmSync(join(dir, 'workspaces'), { recursive: true, force: true });
    await fsPromises.mkdir(join(dir, 'workspaces'));
    writeFileSync(removed, 'old');
    log.commit({
      operation: 'core.workspace.delete',
      advance: [{ kind: 'workspaces' }],
      files: [
        {
          path: removed,
          contents: null,
          previousFingerprint: fingerprintW5File('old'),
        },
      ],
      outcome: null,
    });

    await recoverW5CommitLog(log, { root: dir, durability });

    expect(synced).toEqual([join(dir, 'workspaces'), dir]);
    expect(written).toEqual([]);
  });

  it.each([
    ['interrupted write', 'v1', 'v2'],
    ['interrupted empty write', 'v1', ''],
    ['interrupted creation', null, 'v2'],
    ['unchanged read-only dependency', 'v2', 'v2'],
    ['empty read-only dependency', '', ''],
    ['absent dependency', null, null],
  ])(
    'recovers an %s with durable folders',
    async (_label, previous, contents) => {
      const target = join(dir, 'workspaces', 'index.json');
      await fsPromises.mkdir(join(dir, 'workspaces'), { recursive: true });
      if (previous !== null) writeFileSync(target, previous);
      log.commit({
        operation: 'core.workspace.update',
        advance: [{ kind: 'workspaces' }],
        files: [
          {
            path: target,
            contents,
            previousFingerprint: fingerprintW5File(previous),
          },
        ],
        outcome: null,
      });
      if (contents !== null) {
        writeFileSync(target, contents);
        if (previous === contents) chmodSync(target, 0o444);
      }
      const metadata = existsSync(target) ? statSync(target) : null;
      mockedOpen.mockClear();
      const handles = observeFileOpens(target);

      await expect(
        recoverW5CommitLog(log, { root: dir, durability }),
      ).resolves.toMatchObject({ applied: [1], recoveryRequired: [] });

      if (previous !== contents) {
        expect(mockedOpen).toHaveBeenCalledWith(target, 'r+');
        expect(handles).toHaveLength(1);
        for (const handle of handles) {
          expect(handle.sync).toHaveBeenCalledTimes(1);
          expect(handle.close).toHaveBeenCalledTimes(1);
        }
      } else {
        expect(handles).toEqual([]);
      }
      expect(existsSync(target)).toBe(metadata !== null);
      if (contents !== null)
        expect(readFileSync(target, 'utf8')).toBe(contents);
      if (metadata) {
        expect(statSync(target)).toMatchObject({
          ino: metadata.ino,
          mode: metadata.mode,
          mtimeMs: metadata.mtimeMs,
          ctimeMs: metadata.ctimeMs,
        });
      }
      expect(synced).toEqual([join(dir, 'workspaces'), dir]);
      expect(written).toEqual([]);
    },
  );

  it.each(['none', 'file', 'close', 'folder'] as const)(
    'recovers a mixed commit with %s sync failure without skipping durability or journaling',
    async (failure) => {
      const fileFailure = failure === 'file' || failure === 'close';
      const dependency = join(dir, 'a-dependency');
      const installed = join(dir, 'b-installed');
      const pending = join(dir, 'c-pending');
      writeFileSync(dependency, 'unchanged');
      chmodSync(dependency, 0o444);
      writeFileSync(installed, 'desired');
      const result = log.commit({
        operation: 'core.workspace.update',
        advance: [],
        files: [
          {
            path: dependency,
            contents: 'unchanged',
            previousFingerprint: fingerprintW5File('unchanged'),
          },
          {
            path: installed,
            contents: 'desired',
            previousFingerprint: fingerprintW5File('previous'),
          },
          { path: pending, contents: 'new', previousFingerprint: null },
        ],
        outcome: null,
      });
      if (result.status !== 'committed') throw new Error('Expected a commit');
      const handles = observeFileOpens(
        installed,
        failure === 'file' ? new Error('file sync failed') : undefined,
        failure === 'close' ? new Error('file close failed') : undefined,
      );

      await expect(
        recoverW5CommitLog(log, {
          root: dir,
          durability: {
            ...durability,
            syncDirectory: async (folder) => {
              expect(log.listPendingCommits()).toHaveLength(1);
              await durability.syncDirectory(folder);
              if (failure === 'folder') throw new Error('folder sync failed');
            },
          },
        }),
      ).resolves.toMatchObject({
        applied: failure === 'none' ? [result.commitId] : [],
        recoveryRequired: failure === 'none' ? [] : [result.commitId],
      });

      expect(mockedOpen).not.toHaveBeenCalledWith(dependency, 'r+');
      expect(handles).toHaveLength(1);
      for (const handle of handles) {
        expect(handle.sync).toHaveBeenCalledTimes(1);
        expect(handle.close).toHaveBeenCalledTimes(1);
      }
      expect(readFileSync(dependency, 'utf8')).toBe('unchanged');
      expect(readFileSync(installed, 'utf8')).toBe('desired');
      expect(existsSync(pending)).toBe(!fileFailure);
      if (!fileFailure) expect(readFileSync(pending, 'utf8')).toBe('new');
      expect(written).toEqual(fileFailure ? [] : [pending]);
      expect(synced).toEqual(fileFailure ? [] : [dir]);
      expect(log.listPendingCommits()).toEqual([]);
      expect(log.listRecoveryRequiredCommitDiagnostics()).toEqual(
        failure === 'none'
          ? []
          : [
              {
                commitId: result.commitId,
                conflictCount: 0,
                writtenFileCount: fileFailure ? 0 : 1,
                unexpectedFailure: true,
              },
            ],
      );
      log.close();
      log = W5CommitLog.open(join(dir, 'commit-log.sqlite'));
      await expect(
        recoverW5CommitLog(log, { root: dir, durability }),
      ).resolves.toMatchObject({
        applied: [],
        recoveryRequired: failure === 'none' ? [] : [result.commitId],
      });
      expect(written).toEqual(fileFailure ? [] : [pending]);
      expect(synced).toEqual(fileFailure ? [] : [dir]);
    },
  );

  // Windows flushes a file only through a writable handle; whether a folder
  // can be synced is the host's call (atomic-file skips it on Windows).
  it('flushes a file through a writable handle and leaves folders to the port', async () => {
    const target = join(dir, 'w.json');
    writeFileSync(target, 'v1');
    log.commit({
      operation: 'core.workspace.update',
      advance: [],
      files: [
        {
          path: target,
          contents: 'v2',
          previousFingerprint: fingerprintW5File('v1'),
        },
      ],
      outcome: null,
    });
    writeFileSync(target, 'v2');
    mockedOpen.mockClear();

    await recoverW5CommitLog(log, {
      root: dir,
      durability: { ...durability, syncDirectory: noFolderSync },
    });

    expect(mockedOpen).toHaveBeenCalledWith(target, 'r+');
    expect(mockedOpen).not.toHaveBeenCalledWith(expect.anything(), 'r');
    expect(synced).toEqual([dir]);
  });

  it("syncs the nearest existing folder when a removed file's folder is gone too", async () => {
    const folder = join(dir, 'workspaces', 'gone');
    const removed = join(folder, 'workspace.json');
    await fsPromises.mkdir(folder, { recursive: true });
    writeFileSync(removed, 'old');
    log.commit({
      operation: 'core.workspace.delete',
      advance: [],
      files: [
        {
          path: removed,
          contents: null,
          previousFingerprint: fingerprintW5File('old'),
        },
      ],
      outcome: null,
    });
    // The whole folder went before the commit was applied.
    rmSync(folder, { recursive: true, force: true });

    await expect(
      recoverW5CommitLog(log, { root: dir, durability }),
    ).resolves.toMatchObject({
      applied: [1],
      recoveryRequired: [],
    });
    expect(synced).toEqual([folder, join(dir, 'workspaces'), dir]);
  });

  it('syncs every folder up to the root, including one an earlier attempt created', async () => {
    const folder = join(dir, 'workspaces', 'suite');
    const created = join(folder, 'workspace.json');
    log.commit({
      operation: 'core.workspace.create',
      advance: [],
      files: [{ path: created, contents: 'm1', previousFingerprint: null }],
      outcome: null,
    });
    // A crashed attempt created the folder but never synced its entry.
    await fsPromises.mkdir(folder, { recursive: true });

    await recoverW5CommitLog(log, { root: dir, durability });

    expect(written).toEqual([created]);
    expect(synced).toEqual([folder, join(dir, 'workspaces'), dir]);
  });

  it('refuses a file outside the root and flags the commit', async () => {
    const outside = join(dir, '..', 'outside.json');
    log.commit({
      operation: 'core.workspace.create',
      advance: [],
      files: [{ path: outside, contents: 'x', previousFingerprint: null }],
      outcome: null,
    });

    await expect(
      recoverW5CommitLog(log, { root: join(dir, 'workspaces'), durability }),
    ).resolves.toMatchObject({ applied: [], recoveryRequired: [1] });
    expect(written).toEqual([]);
    expect(synced).toEqual([]);
  });
});

function noFolderSync(folder: string): Promise<void> {
  synced.push(folder);
  return Promise.resolve();
}
