import { link, open, rename, unlink } from 'node:fs/promises';

jest.mock('node:fs/promises', () => ({
  link: jest.fn(),
  open: jest.fn(),
  rename: jest.fn(),
  unlink: jest.fn(),
}));

import { renameWithRetry, writeFileAtomically } from '../lib/atomic-file';

const linkMock = jest.mocked(link);
const openMock = jest.mocked(open);
const renameMock = jest.mocked(rename);
const unlinkMock = jest.mocked(unlink);

describe('writeFileAtomically', () => {
  const write = jest.fn();
  const chmod = jest.fn();
  const close = jest.fn();
  const sync = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    write.mockResolvedValue(undefined);
    chmod.mockResolvedValue(undefined);
    close.mockResolvedValue(undefined);
    sync.mockResolvedValue(undefined);
    openMock.mockResolvedValue({
      writeFile: write,
      chmod,
      close,
      sync,
    } as never);
    linkMock.mockResolvedValue(undefined);
    renameMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'retries a transient %s without rewriting or removing the destination',
    async (code) => {
      renameMock.mockRejectedValueOnce(
        Object.assign(new Error('locked'), { code }),
      );
      await expect(
        writeFileAtomically('/secure/account.enc', 'new data'),
      ).resolves.toBeUndefined();
      expect(renameMock).toHaveBeenCalledTimes(2);
      expect(write).toHaveBeenCalledTimes(1);
      expect(unlinkMock).not.toHaveBeenCalled();
    },
  );

  it('bounds persistent rename failures and cleans only the temporary file', async () => {
    const error = Object.assign(new Error('locked'), { code: 'EPERM' });
    renameMock.mockRejectedValue(error);
    await expect(
      writeFileAtomically('/secure/account.enc', 'new data'),
    ).rejects.toBe(error);
    expect(renameMock).toHaveBeenCalledTimes(6);
    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).not.toHaveBeenCalledWith('/secure/account.enc');
  });

  it('writes through an exclusive sibling file before replacing the target', async () => {
    await writeFileAtomically('/secure/account.enc', Buffer.from('secret'), {
      mode: 0o600,
    });

    expect(openMock).toHaveBeenCalledWith(
      expect.stringMatching(/^[\\/]secure[\\/]\.account\.enc\..+\.tmp$/),
      'wx',
      0o600,
    );
    expect(write).toHaveBeenCalledWith(Buffer.from('secret'), undefined);
    expect(close).toHaveBeenCalled();
    expect(renameMock).toHaveBeenCalledWith(
      expect.stringMatching(/^[\\/]secure[\\/]\.account\.enc\..+\.tmp$/),
      '/secure/account.enc',
    );
  });

  it('syncs the file before installing it, then its directory, when durable', async () => {
    const order: string[] = [];
    sync.mockImplementation(() => {
      order.push('sync');
      return Promise.resolve();
    });
    renameMock.mockImplementation(() => {
      order.push('rename');
      return Promise.resolve();
    });

    await writeFileAtomically('/data/summaries/wt-1.json', '{}', {
      encoding: 'utf8',
      durable: true,
    });

    expect(order).toEqual(['sync', 'rename', 'sync']);
    // Windows flushes a folder only through a read-write handle (CAN-5151 D1).
    expect(openMock).toHaveBeenLastCalledWith(
      expect.stringMatching(/^[\\/]data[\\/]summaries$/),
      process.platform === 'win32' ? 'r+' : 'r',
    );
  });

  it('reports a durable write whose directory cannot be synced as outcome unknown', async () => {
    // The file syncs; the directory does not.
    sync
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));

    await expect(
      writeFileAtomically('/data/summaries/wt-1.json', '{}', { durable: true }),
    ).rejects.toMatchObject({
      name: 'StorageOutcomeUnknownError',
      stage: 'directory_flush',
      cause: { name: 'DirectoryFlushError', stage: 'flush', code: 'EIO' },
    });
    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('syncs nothing unless durable', async () => {
    await writeFileAtomically('/secure/account.enc', 'data');

    expect(sync).not.toHaveBeenCalled();
  });

  it('preserves the destination and removes the temporary file on write failure', async () => {
    write.mockRejectedValueOnce(new Error('write failed'));

    await expect(
      writeFileAtomically('/secure/account.enc', 'new data', {
        encoding: 'utf8',
      }),
    ).rejects.toThrow('write failed');

    expect(renameMock).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(unlinkMock).toHaveBeenCalledWith(
      expect.stringMatching(/^[\\/]secure[\\/]\.account\.enc\..+\.tmp$/),
    );
  });

  it('installs a complete sibling file only when the destination is absent', async () => {
    await expect(
      writeFileAtomically('/secure/account.enc', Buffer.from('secret'), {
        mode: 0o600,
        overwrite: false,
      }),
    ).resolves.toBeUndefined();

    expect(linkMock).toHaveBeenCalledWith(
      expect.stringMatching(/^[\\/]secure[\\/]\.account\.enc\..+\.tmp$/),
      '/secure/account.enc',
    );
    expect(renameMock).not.toHaveBeenCalled();
    expect(unlinkMock).toHaveBeenCalledWith(
      expect.stringMatching(/^[\\/]secure[\\/]\.account\.enc\..+\.tmp$/),
    );
  });

  it('does not replace a destination that another writer created', async () => {
    linkMock.mockRejectedValueOnce(
      Object.assign(new Error('already exists'), { code: 'EEXIST' }),
    );

    await expect(
      writeFileAtomically('/secure/account.enc', 'legacy', {
        overwrite: false,
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    expect(renameMock).not.toHaveBeenCalled();
    expect(unlinkMock).toHaveBeenCalled();
  });
});

describe('renameWithRetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    renameMock.mockResolvedValue(undefined);
  });

  it('supports a longer caller-specific sharing-violation window', async () => {
    const locked = Object.assign(new Error('still draining'), {
      code: 'EBUSY',
    });
    renameMock
      .mockRejectedValueOnce(locked)
      .mockRejectedValueOnce(locked)
      .mockRejectedValueOnce(locked)
      .mockRejectedValueOnce(locked)
      .mockRejectedValueOnce(locked)
      .mockRejectedValueOnce(locked)
      .mockRejectedValueOnce(locked);

    await expect(
      renameWithRetry('/workspace/live', '/workspace/quarantine', {
        retryDelaysMs: [0, 0, 0, 0, 0, 0, 0],
      }),
    ).resolves.toBeUndefined();
    expect(renameMock).toHaveBeenCalledTimes(8);
  });

  it('rechecks the caller fence after each backoff and aborts without renaming', async () => {
    const locked = Object.assign(new Error('locked'), { code: 'EBUSY' });
    renameMock.mockRejectedValueOnce(locked).mockRejectedValueOnce(locked);
    const superseded = new Error('superseded');
    const beforeRetry = jest
      .fn<void, []>()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw superseded;
      });

    await expect(
      renameWithRetry('/workspace/temp', '/workspace/live', {
        retryDelaysMs: [0, 0, 0],
        beforeRetry,
      }),
    ).rejects.toBe(superseded);
    expect(beforeRetry).toHaveBeenCalledTimes(2);
    expect(renameMock).toHaveBeenCalledTimes(2);
  });

  it('does not run the retry fence when the first attempt succeeds', async () => {
    const beforeRetry = jest.fn<void, []>();
    await renameWithRetry('/workspace/temp', '/workspace/live', {
      beforeRetry,
    });
    expect(beforeRetry).not.toHaveBeenCalled();
    expect(renameMock).toHaveBeenCalledTimes(1);
  });
});
