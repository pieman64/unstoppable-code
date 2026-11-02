import * as fs from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileDelegationStorage, PrivateDelegationRecordFile } from '../storage';
import {
  DELEGATION_LIFETIME_BASELINE_FILE_NAME,
  readDelegationLifetimeBaseline,
  writeDelegationLifetimeBaseline,
} from '../lifetime-baseline';

jest.mock('node:fs/promises', () => {
  const actual: typeof FsPromises = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    open: jest.fn(actual.open),
    rm: jest.fn(actual.rm),
  };
});

const mockedOpen = jest.mocked(fs.open);
const mockedRm = jest.mocked(fs.rm);
const realOpen = jest.requireActual<typeof FsPromises>('node:fs/promises').open;
const realRm = jest.requireActual<typeof FsPromises>('node:fs/promises').rm;

describe('private delegation lifetime baseline', () => {
  let directory: string;
  let storage: FileDelegationStorage;

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'delegation-lifetime-baseline-'),
    );
    storage = new FileDelegationStorage(path.join(directory, 'delegation'));
  });

  afterEach(async () => {
    mockedOpen.mockImplementation(realOpen);
    mockedRm.mockImplementation(realRm);
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function writeRawBaseline(value: unknown): Promise<void> {
    await storage.prepareDirectory();
    const contents = JSON.stringify(value);
    if (typeof contents !== 'string') throw new Error('Expected JSON baseline');
    await fs.writeFile(
      path.join(storageDirectory(), DELEGATION_LIFETIME_BASELINE_FILE_NAME),
      contents,
      { mode: 0o600 },
    );
  }

  function storageDirectory(): string {
    return path.join(directory, 'delegation');
  }

  async function readOnlyBaseline(): Promise<unknown> {
    const module = await import('../lifetime-baseline');
    const read = Reflect.get(module, 'readDelegationLifetimeBaselineReadOnly');
    if (typeof read === 'function') return read(storage);
    try {
      return {
        kind: 'available',
        baseline: await readDelegationLifetimeBaseline(storage),
      };
    } catch {
      return { kind: 'unavailable', reason: 'unreadable' };
    }
  }

  it('reads a missing dormant baseline without creating its directory', async () => {
    expect(await readOnlyBaseline()).toEqual({
      kind: 'available',
      baseline: 0,
    });
    await expect(fs.stat(storageDirectory())).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reports an invalid read-only baseline as unreadable, never zero', async () => {
    await writeRawBaseline({ version: 2, baseline: 0 });
    expect(await readOnlyBaseline()).toEqual({
      kind: 'unavailable',
      reason: 'unreadable',
    });
  });

  function baselineFilePath(): string {
    return path.join(
      storageDirectory(),
      DELEGATION_LIFETIME_BASELINE_FILE_NAME,
    );
  }

  it('reads an absent or pending-only baseline as zero', async () => {
    expect(
      await readDelegationLifetimeBaseline(
        new FileDelegationStorage(storageDirectory()),
      ),
    ).toBe(0);
    await storage.prepareDirectory();
    await fs.writeFile(
      path.join(storageDirectory(), 'orphan.pending'),
      '{"version":1,"baseline":42}',
      { mode: 0o600 },
    );
    expect(
      await readDelegationLifetimeBaseline(
        new FileDelegationStorage(storageDirectory()),
      ),
    ).toBe(0);
  });

  it('writes a strict version-one DTO using the private atomic file path', async () => {
    await writeRawBaseline({ version: 1, baseline: 3 });
    expect(
      await readDelegationLifetimeBaseline(
        new FileDelegationStorage(storageDirectory()),
      ),
    ).toBe(3);
    expect(await writeDelegationLifetimeBaseline(storage, 42)).toEqual({
      outcome: 'written',
    });
    expect(await fs.readFile(baselineFilePath(), 'utf8')).toBe(
      '{"version":1,"baseline":42}',
    );
    expect(
      await readDelegationLifetimeBaseline(
        new FileDelegationStorage(storageDirectory()),
      ),
    ).toBe(42);
    if (process.platform !== 'win32') {
      const stat = await fs.stat(baselineFilePath());
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('rejects malformed, future-version, extra-field and unsafe DTO values', async () => {
    const invalidValues: unknown[] = [
      { version: 2, baseline: 0 },
      { version: 1, baseline: -1 },
      { version: 1, baseline: 1.5 },
      { version: 1, baseline: Number.MAX_SAFE_INTEGER + 1 },
      { version: 1, baseline: 0, extra: true },
      null,
    ];
    for (const value of invalidValues) {
      await writeRawBaseline(value);
      await expect(readDelegationLifetimeBaseline(storage)).rejects.toThrow();
      await fs.unlink(baselineFilePath());
    }
    await expect(
      writeDelegationLifetimeBaseline(storage, Number.MAX_SAFE_INTEGER + 1),
    ).rejects.toThrow();
  });

  it('uses storage private-file checks to reject a symlink baseline', async () => {
    if (process.platform === 'win32') return;
    const target = path.join(directory, 'outside.json');
    await fs.writeFile(target, '{"version":1,"baseline":5}', {
      mode: 0o600,
    });
    await storage.prepareDirectory();
    await fs.symlink(target, baselineFilePath());
    await expect(readDelegationLifetimeBaseline(storage)).rejects.toThrow();
  });

  it('rejects a baseline with public mode bits or a second hard link', async () => {
    if (process.platform === 'win32') return;
    await writeRawBaseline({ version: 1, baseline: 5 });
    await fs.chmod(baselineFilePath(), 0o644);
    await expect(readDelegationLifetimeBaseline(storage)).rejects.toThrow(
      'Invalid private delegation record',
    );

    await fs.unlink(baselineFilePath());
    await writeRawBaseline({ version: 1, baseline: 5 });
    await fs.link(baselineFilePath(), path.join(directory, 'baseline-link'));
    await expect(readDelegationLifetimeBaseline(storage)).rejects.toThrow(
      'Invalid private delegation record',
    );
  });

  it('rejects a symlinked storage directory', async () => {
    if (process.platform === 'win32') return;
    const target = path.join(directory, 'target-directory');
    const link = path.join(directory, 'delegation-link');
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, link);
    await expect(
      readDelegationLifetimeBaseline(new FileDelegationStorage(link)),
    ).rejects.toThrow('Delegation storage directory is not private');
  });

  it('returns not_written before rename and preserves the previous file', async () => {
    await writeRawBaseline({ version: 1, baseline: 3 });
    const previousContents = await fs.readFile(baselineFilePath(), 'utf8');
    const failure = new Error('injected temporary-file open failure');
    mockedOpen.mockRejectedValueOnce(failure);

    const result = await writeDelegationLifetimeBaseline(storage, 4);

    expect(result).toEqual({ outcome: 'not_written', error: failure });
    expect(await fs.readFile(baselineFilePath(), 'utf8')).toBe(
      previousContents,
    );
  });

  it('returns uncertain after the rename when directory sync cannot start', async () => {
    await writeRawBaseline({ version: 1, baseline: 4 });
    const failure = new Error('injected directory sync open failure');
    mockedOpen.mockImplementationOnce(realOpen).mockRejectedValueOnce(failure);

    const result = await writeDelegationLifetimeBaseline(storage, 5);

    expect(result).toEqual({ outcome: 'uncertain', error: failure });
    expect(await fs.readFile(baselineFilePath(), 'utf8')).toBe(
      '{"version":1,"baseline":5}',
    );
    expect(
      await readDelegationLifetimeBaseline(
        new FileDelegationStorage(storageDirectory()),
      ),
    ).toBe(5);
  });

  it('returns uncertain when the directory sync rejects after replacement', async () => {
    await writeRawBaseline({ version: 1, baseline: 4 });
    const directoryHandle = await realOpen(storageDirectory(), 'r');
    const failure = new Error('injected directory sync failure');
    const sync = jest
      .spyOn(directoryHandle, 'sync')
      .mockRejectedValueOnce(failure);
    mockedOpen
      .mockImplementationOnce(realOpen)
      .mockResolvedValueOnce(directoryHandle);

    try {
      const result = await writeDelegationLifetimeBaseline(storage, 8);
      expect(result).toEqual({ outcome: 'uncertain', error: failure });
      expect(await fs.readFile(baselineFilePath(), 'utf8')).toBe(
        '{"version":1,"baseline":8}',
      );
      expect(
        await readDelegationLifetimeBaseline(
          new FileDelegationStorage(storageDirectory()),
        ),
      ).toBe(8);
    } finally {
      sync.mockRestore();
    }
  });

  it('returns uncertain when the post-rename directory close fails', async () => {
    await writeRawBaseline({ version: 1, baseline: 4 });
    const directoryHandle = await realOpen(storageDirectory(), 'r');
    const failure = new Error('injected directory close failure');
    const close = jest
      .spyOn(directoryHandle, 'close')
      .mockRejectedValueOnce(failure);
    mockedOpen
      .mockImplementationOnce(realOpen)
      .mockResolvedValueOnce(directoryHandle);

    try {
      const result = await writeDelegationLifetimeBaseline(storage, 6);
      expect(result).toEqual({ outcome: 'uncertain', error: failure });
      expect(await fs.readFile(baselineFilePath(), 'utf8')).toBe(
        '{"version":1,"baseline":6}',
      );
      expect(
        await readDelegationLifetimeBaseline(
          new FileDelegationStorage(storageDirectory()),
        ),
      ).toBe(6);
    } finally {
      close.mockRestore();
      await directoryHandle.close();
    }
  });

  it('returns uncertain when temporary cleanup fails after replacement', async () => {
    await writeRawBaseline({ version: 1, baseline: 4 });
    const failure = new Error('injected pending-file cleanup failure');
    mockedRm.mockRejectedValueOnce(failure);

    const result = await writeDelegationLifetimeBaseline(storage, 7);

    expect(result).toEqual({ outcome: 'uncertain', error: failure });
    expect(await fs.readFile(baselineFilePath(), 'utf8')).toBe(
      '{"version":1,"baseline":7}',
    );
  });

  it('keeps legacy commit consumers on the throwing API', async () => {
    const failure = new Error('injected temporary-file open failure');
    mockedOpen.mockRejectedValueOnce(failure);
    const record = new PrivateDelegationRecordFile(
      DELEGATION_LIFETIME_BASELINE_FILE_NAME,
      Buffer.from('{"version":1,"baseline":8}', 'utf8'),
    );

    await expect(storage.commit(record)).rejects.toBe(failure);
  });
});
