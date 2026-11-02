import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as AtomicFile from '../lib/atomic-file';

interface SafeStorageMock {
  encryptionAvailable: boolean;
  isEncryptionAvailable: jest.Mock<boolean, []>;
  encryptString: jest.Mock<Buffer, [string]>;
  decryptString: jest.Mock<string, [Buffer]>;
}
const safeStorageMock: SafeStorageMock = {
  encryptionAvailable: true,
  isEncryptionAvailable: jest.fn(
    (): boolean => safeStorageMock.encryptionAvailable,
  ),
  encryptString: jest.fn(
    (text: string): Buffer => Buffer.from(`encrypted:${text}`),
  ),
  decryptString: jest.fn((encrypted: Buffer): string =>
    encrypted.toString('utf8').replace(/^encrypted:/, ''),
  ),
};
let root = '';
jest.mock('electron', () => ({
  app: { isReady: (): boolean => true },
  safeStorage: {
    isEncryptionAvailable: (): boolean =>
      safeStorageMock.isEncryptionAvailable(),
    getSelectedStorageBackend: (): string => 'gnome_libsecret',
    encryptString: (text: string): Buffer =>
      safeStorageMock.encryptString(text),
    decryptString: (data: Buffer): string =>
      safeStorageMock.decryptString(data),
  },
}));
jest.mock('../lib/paths', () => ({
  getCopilotCredentialFilePath: (): string => join(root, 'copilot-account.enc'),
}));
jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => false,
}));
jest.mock('../lib/atomic-file', () => {
  const actual = jest.requireActual<typeof AtomicFile>('../lib/atomic-file');
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      writeFileAtomically: {
        value: jest.fn(actual.writeFileAtomically),
        enumerable: true,
      },
      syncDirectory: {
        value: jest.fn(actual.syncDirectory),
        enumerable: true,
      },
    },
  );
});

import { createCopilotCredentialBroker } from '../copilot/credential-broker';
import {
  clearCopilotCredential,
  createCopilotCredential,
  deleteCopilotCredential,
  isCopilotCredentialStorageAvailable,
  readCopilotCredential,
  replaceCopilotCredential,
  type CopilotCredential,
  type CopilotGrant,
} from '../copilot/credential-store';
import * as atomicFile from '../lib/atomic-file';

const mockWriteFileAtomically = jest.mocked(atomicFile.writeFileAtomically);
const mockSyncDirectory = jest.mocked(atomicFile.syncDirectory);

const grant: CopilotGrant = {
  clientId: 'Iv23test',
  host: 'https://github.com',
  login: 'octocat',
  id: '1',
  accessToken: 'ghu_access',
  accessTokenExpiresAt: '2026-10-05T00:00:00.000Z',
  refreshToken: 'ghr_refresh',
  refreshTokenExpiresAt: '2027-04-01T00:00:00.000Z',
};
const rotated: CopilotGrant = {
  ...grant,
  accessToken: 'ghu_rotated',
  refreshToken: 'ghr_rotated',
};
const ENTRY_ID = /^[0-9a-f]{32}$/;
const filePath = (): string => join(root, 'copilot-account.enc');

/** What an older build wrote: no entry identity. */
async function writeLegacy(record: object): Promise<void> {
  await writeFile(
    filePath(),
    Buffer.from(`encrypted:${JSON.stringify({ version: 1, ...record })}`),
  );
}
async function stored(): Promise<unknown> {
  const raw = await readFile(filePath(), 'utf8');
  return JSON.parse(raw.replace(/^encrypted:/, ''));
}
async function present(): Promise<CopilotCredential> {
  const read = await readCopilotCredential();
  if (read.status !== 'present') throw new Error(`Read ${read.status}`);
  return read.credential;
}
/** The next write's rename lands, then its directory sync fails. */
function failDirectorySyncAfterRename(afterRename?: () => Promise<void>): void {
  const actual = jest.requireActual<typeof AtomicFile>('../lib/atomic-file');
  mockWriteFileAtomically.mockImplementationOnce(
    async (path, data, options) => {
      await actual.writeFileAtomically(path, data, {
        ...options,
        durable: false,
      });
      await afterRename?.();
      throw new Error('EIO: directory sync failed');
    },
  );
}

describe('Copilot credential store', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copilot-credential-'));
    safeStorageMock.encryptionAvailable = true;
    jest.clearAllMocks();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads absent when nothing was saved', async () => {
    await expect(readCopilotCredential()).resolves.toEqual({
      status: 'absent',
    });
  });

  it('round-trips an encrypted credential with an owner-only file', async () => {
    const created = await createCopilotCredential(grant);
    expect(created.entryId).toMatch(ENTRY_ID);
    expect(created).toEqual({
      version: 1,
      ...grant,
      entryId: created.entryId,
      revision: 1,
    });
    const raw = await readFile(filePath());
    // The fake encryptor keeps the payload visible; what matters is that the
    // file holds exactly the encryptor's output, never the raw JSON.
    expect(raw.toString('utf8').startsWith('encrypted:')).toBe(true);
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith(
      JSON.stringify(created),
    );
    await expect(readCopilotCredential()).resolves.toEqual({
      status: 'present',
      credential: created,
    });
  });

  it('saves durably and syncs the directory after a delete', async () => {
    const created = await createCopilotCredential(grant);
    await replaceCopilotCredential(created, rotated);
    expect(mockWriteFileAtomically).toHaveBeenCalledTimes(2);
    for (const [path, , options] of mockWriteFileAtomically.mock.calls) {
      expect(path).toBe(filePath());
      expect(options).toEqual({ mode: 0o600, durable: true });
    }
    await clearCopilotCredential();
    expect(mockSyncDirectory).toHaveBeenCalledWith(root);
    mockSyncDirectory.mockClear();
    const next = await createCopilotCredential(grant);
    await deleteCopilotCredential(next);
    expect(mockSyncDirectory).toHaveBeenCalledWith(root);
  });

  it('keeps the record readable by older builds: version 1 with additive fields', async () => {
    const withUnknownField = { ...grant, unknown: 'dropped' };
    const created = await createCopilotCredential(withUnknownField);
    expect(await stored()).toEqual({
      version: 1,
      ...grant,
      entryId: created.entryId,
      revision: 1,
    });
  });

  it('replaces only the expected revision and bumps it', async () => {
    const created = await createCopilotCredential(grant);
    const written = await replaceCopilotCredential(created, rotated);
    expect(written).toEqual({
      status: 'written',
      credential: {
        version: 1,
        ...rotated,
        entryId: created.entryId,
        revision: 2,
      },
    });
    const before = await readFile(filePath());
    // The revision the caller presented from has already been replaced.
    await expect(
      replaceCopilotCredential(created, { ...grant, accessToken: 'late' }),
    ).resolves.toEqual({ status: 'conflict' });
    await expect(
      replaceCopilotCredential(
        { entryId: 'f'.repeat(32), revision: 2 },
        { ...grant, accessToken: 'other entry' },
      ),
    ).resolves.toEqual({ status: 'conflict' });
    expect(await readFile(filePath())).toEqual(before);
  });

  it('syncs the directory before reporting a retried replacement written that landed before failing', async () => {
    const created = await createCopilotCredential(grant);
    failDirectorySyncAfterRename();
    await expect(replaceCopilotCredential(created, rotated)).rejects.toThrow(
      'EIO',
    );
    await expect(stored()).resolves.toMatchObject({ revision: 2 });
    // Until a directory sync succeeds, the retry is not reported written.
    mockSyncDirectory.mockRejectedValueOnce(
      new Error('EIO: directory sync failed'),
    );
    await expect(replaceCopilotCredential(created, rotated)).rejects.toThrow(
      'EIO',
    );
    mockSyncDirectory.mockClear();
    await expect(replaceCopilotCredential(created, rotated)).resolves.toEqual({
      status: 'written',
      credential: {
        version: 1,
        ...rotated,
        entryId: created.entryId,
        revision: 2,
      },
    });
    expect(mockSyncDirectory).toHaveBeenCalledWith(root);
    expect(mockWriteFileAtomically).toHaveBeenCalledTimes(2);
    // A different successor from the same revision is still a conflict.
    await expect(
      replaceCopilotCredential(created, { ...rotated, refreshToken: 'other' }),
    ).resolves.toEqual({ status: 'conflict' });
  });

  /** The real broker over this store, with the stored access token near expiry. */
  function brokerOverStore(save = replaceCopilotCredential): {
    broker: ReturnType<typeof createCopilotCredentialBroker>;
    refresh: jest.Mock;
  } {
    const now = Date.parse(grant.accessTokenExpiresAt) - 30 * 60 * 1000;
    const refresh = jest.fn(() =>
      Promise.resolve({
        accessToken: 'ghu_rotated',
        accessTokenExpiresAt: new Date(now + 8 * 60 * 60 * 1000).toISOString(),
        refreshToken: 'ghr_rotated',
        refreshTokenExpiresAt: rotated.refreshTokenExpiresAt,
      }),
    );
    const broker = createCopilotCredentialBroker({
      pin: { host: grant.host, login: grant.login },
      read: readCopilotCredential,
      save,
      clear: deleteCopilotCredential,
      refresh,
      now: () => now,
    });
    return { broker, refresh };
  }
  const signal = (): AbortSignal => new AbortController().signal;

  it('lets the broker finish the durable save of a rotation whose directory sync failed', async () => {
    await createCopilotCredential(grant);
    const { broker, refresh } = brokerOverStore();
    failDirectorySyncAfterRename();
    await expect(broker.token(signal())).resolves.toBe('ghu_rotated');
    mockSyncDirectory.mockClear();
    await expect(broker.token(signal())).resolves.toBe('ghu_rotated');
    expect(mockSyncDirectory).toHaveBeenCalledWith(root);
    mockSyncDirectory.mockClear();
    await expect(broker.token(signal())).resolves.toBe('ghu_rotated');
    expect(mockSyncDirectory).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    // Create and the rotation; the repair only syncs the directory.
    expect(mockWriteFileAtomically).toHaveBeenCalledTimes(2);
    await expect(present()).resolves.toMatchObject({
      refreshToken: 'ghr_rotated',
      revision: 2,
    });
  });

  it('repairs a rotation whose directory sync fails while another caller already reads the successor', async () => {
    await createCopilotCredential(grant);
    let saves = 0;
    let secondSaveQueued = (): void => undefined;
    const queued = new Promise<void>((resolve) => {
      secondSaveQueued = resolve;
    });
    const { broker, refresh } = brokerOverStore((from, successor) => {
      saves += 1;
      if (saves === 2) secondSaveQueued();
      return replaceCopilotCredential(from, successor);
    });
    let concurrent: Promise<string> | undefined;
    // The second caller reads the successor and queues its save before the
    // first save's directory sync fails.
    failDirectorySyncAfterRename(async () => {
      concurrent = broker.token(signal());
      await queued;
    });
    await expect(broker.token(signal())).resolves.toBe('ghu_rotated');
    await expect(concurrent).resolves.toBe('ghu_rotated');
    expect(saves).toBe(2);
    expect(mockSyncDirectory).toHaveBeenCalledWith(root);
    mockSyncDirectory.mockClear();
    await expect(broker.token(signal())).resolves.toBe('ghu_rotated');
    expect(mockSyncDirectory).not.toHaveBeenCalled();
    expect(saves).toBe(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(mockWriteFileAtomically).toHaveBeenCalledTimes(2);
  });

  it('settles a cancelled request while the retried save of a landed rotation is blocked', async () => {
    await createCopilotCredential(grant);
    let saves = 0;
    let unblock = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let retryStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      retryStarted = resolve;
    });
    let retry: ReturnType<typeof replaceCopilotCredential> | undefined;
    const { broker, refresh } = brokerOverStore((from, successor) => {
      saves += 1;
      if (saves !== 2) return replaceCopilotCredential(from, successor);
      retryStarted();
      retry = blocked.then(() => replaceCopilotCredential(from, successor));
      return retry;
    });
    failDirectorySyncAfterRename();
    await expect(broker.token(signal())).resolves.toBe('ghu_rotated');
    mockSyncDirectory.mockClear();
    const controller = new AbortController();
    const cancelled = broker.token(controller.signal);
    await started;
    controller.abort(new Error('cancelled'));
    const storageStillBlocked = new Promise<string>((resolve) => {
      setImmediate(() => resolve('storage still blocked'));
    });
    try {
      await expect(
        Promise.race([cancelled, storageStillBlocked]),
      ).rejects.toThrow('cancelled');
    } finally {
      unblock();
    }
    // The retry finishes on its own and is not repeated.
    await expect(retry).resolves.toMatchObject({ status: 'written' });
    expect(mockSyncDirectory).toHaveBeenCalledWith(root);
    await expect(broker.token(signal())).resolves.toBe('ghu_rotated');
    expect(saves).toBe(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite a rotation whose directory sync failed once Disconnect cleared it', async () => {
    await createCopilotCredential(grant);
    const { broker } = brokerOverStore();
    failDirectorySyncAfterRename();
    await expect(broker.token(signal())).resolves.toBe('ghu_rotated');
    await clearCopilotCredential();
    await expect(broker.token(signal())).rejects.toThrow('expired');
    await expect(readCopilotCredential()).resolves.toEqual({
      status: 'absent',
    });
    expect(mockWriteFileAtomically).toHaveBeenCalledTimes(2);
  });

  it('does not recreate a cleared grant on replace', async () => {
    const created = await createCopilotCredential(grant);
    await clearCopilotCredential();
    await expect(replaceCopilotCredential(created, rotated)).resolves.toEqual({
      status: 'conflict',
    });
    await expect(readCopilotCredential()).resolves.toEqual({
      status: 'absent',
    });
  });

  it('T4: a clear racing a rotation save never leaves the rotation stored', async () => {
    for (const clearFirst of [false, true]) {
      const created = await createCopilotCredential(grant);
      const [first, second] = clearFirst
        ? [clearCopilotCredential(), replaceCopilotCredential(created, rotated)]
        : [
            replaceCopilotCredential(created, rotated),
            clearCopilotCredential(),
          ];
      await Promise.all([first, second]);
      await expect(readCopilotCredential()).resolves.toEqual({
        status: 'absent',
      });
    }
  });

  it('T4b: a clear by the rejected revision spares a grant that replaced it', async () => {
    const rejected = await createCopilotCredential(grant);
    const replacement = await createCopilotCredential(rotated);
    await expect(deleteCopilotCredential(rejected)).resolves.toEqual({
      status: 'conflict',
    });
    await expect(readCopilotCredential()).resolves.toEqual({
      status: 'present',
      credential: replacement,
    });
  });

  it('deletes only the expected entry, at the expected revision when given', async () => {
    const created = await createCopilotCredential(grant);
    const written = await replaceCopilotCredential(created, rotated);
    if (written.status !== 'written') throw new Error(written.status);
    await expect(deleteCopilotCredential(created)).resolves.toEqual({
      status: 'conflict',
    });
    await expect(
      deleteCopilotCredential({ entryId: 'f'.repeat(32) }),
    ).resolves.toEqual({ status: 'conflict' });
    await expect(present()).resolves.toEqual(written.credential);
    await expect(deleteCopilotCredential(written.credential)).resolves.toEqual({
      status: 'deleted',
    });
    await expect(readCopilotCredential()).resolves.toEqual({
      status: 'absent',
    });
    await expect(deleteCopilotCredential(written.credential)).resolves.toEqual({
      status: 'conflict',
    });
  });

  it('deletes any revision of an entry when no revision is given', async () => {
    const created = await createCopilotCredential(grant);
    await replaceCopilotCredential(created, rotated);
    await expect(
      deleteCopilotCredential({ entryId: created.entryId }),
    ).resolves.toEqual({ status: 'deleted' });
    await expect(readCopilotCredential()).resolves.toEqual({
      status: 'absent',
    });
  });

  it('mints a new entry on recreate with no revision continuity', async () => {
    const first = await createCopilotCredential(grant);
    await clearCopilotCredential();
    const second = await createCopilotCredential(grant);
    expect(second.entryId).toMatch(ENTRY_ID);
    expect(second.entryId).not.toBe(first.entryId);
    expect(second.revision).toBe(1);
    await expect(replaceCopilotCredential(first, rotated)).resolves.toEqual({
      status: 'conflict',
    });
    await expect(present()).resolves.toEqual(second);
  });

  it('adopts a legacy record once, without changing the grant', async () => {
    await writeLegacy({ ...grant, unknown: 'dropped' });
    const adopted = await present();
    expect(adopted.entryId).toMatch(ENTRY_ID);
    expect(adopted).toEqual({
      version: 1,
      ...grant,
      entryId: adopted.entryId,
      revision: 1,
    });
    expect(await stored()).toEqual(adopted);
    await expect(present()).resolves.toEqual(adopted);
    expect(mockWriteFileAtomically).toHaveBeenCalledTimes(1);
    expect(mockWriteFileAtomically.mock.calls[0]?.[2]).toEqual({
      mode: 0o600,
      durable: true,
    });
    const written = await replaceCopilotCredential(adopted, rotated);
    expect(written).toMatchObject({
      status: 'written',
      credential: { entryId: adopted.entryId, revision: 2 },
    });
  });

  it('gives concurrent first reads of a legacy record one identity', async () => {
    await writeLegacy(grant);
    const reads = await Promise.all([present(), present(), present()]);
    expect(new Set(reads.map((read) => read.entryId)).size).toBe(1);
    expect(mockWriteFileAtomically).toHaveBeenCalledTimes(1);
    expect(await stored()).toEqual(reads[0]);
  });

  it('adopts a record whose identity is malformed as legacy', async () => {
    await writeLegacy({ ...grant, entryId: 'not-hex', revision: 3 });
    const adopted = await present();
    expect(adopted.entryId).toMatch(ENTRY_ID);
    expect(adopted.revision).toBe(1);
  });

  it('keeps one identity for a legacy record it cannot save yet', async () => {
    await writeLegacy(grant);
    const before = await readFile(filePath());
    safeStorageMock.encryptString.mockImplementation(() => {
      throw new Error('native encryption failed');
    });
    try {
      const first = await present();
      await expect(present()).resolves.toEqual(first);
      expect(await readFile(filePath())).toEqual(before);
      // A compare-and-swap against the unsaved adoption still matches it.
      await expect(
        replaceCopilotCredential(first, rotated),
      ).rejects.toMatchObject({
        secureStorageFailure: { code: 'SECURE_STORAGE_ENCRYPT_FAILED' },
      });
      safeStorageMock.encryptString.mockImplementation(
        (text: string): Buffer => Buffer.from(`encrypted:${text}`),
      );
      await expect(present()).resolves.toEqual(first);
      expect(await stored()).toEqual(first);
    } finally {
      safeStorageMock.encryptString.mockImplementation(
        (text: string): Buffer => Buffer.from(`encrypted:${text}`),
      );
    }
  });

  it('does not adopt a legacy record over a grant created after it was read', async () => {
    await writeLegacy(grant);
    const reading = readCopilotCredential();
    const created = await createCopilotCredential(rotated);
    const read = await reading;
    // Adoption re-reads under the store's queue, so it finds the new entry.
    expect(read).toEqual({ status: 'present', credential: created });
    await expect(present()).resolves.toEqual(created);
  });

  it('leaves a create whose directory sync failed installed and deletable by its entry', async () => {
    const previous = await createCopilotCredential(grant);
    failDirectorySyncAfterRename();
    await expect(createCopilotCredential(rotated)).rejects.toThrow(
      'EIO: directory sync failed',
    );
    // Connect finds the entry by the refresh token it just wrote.
    const installed = await present();
    expect(installed).toMatchObject({
      refreshToken: rotated.refreshToken,
      revision: 1,
    });
    expect(installed.entryId).not.toBe(previous.entryId);
    await expect(
      deleteCopilotCredential({ entryId: previous.entryId }),
    ).resolves.toEqual({ status: 'conflict' });
    await expect(
      deleteCopilotCredential({ entryId: installed.entryId }),
    ).resolves.toEqual({ status: 'deleted' });
    await expect(readCopilotCredential()).resolves.toEqual({
      status: 'absent',
    });
  });

  it('refuses to save without encryption and reports unavailable', async () => {
    safeStorageMock.encryptionAvailable = false;
    expect(isCopilotCredentialStorageAvailable()).toBe(false);
    await expect(createCopilotCredential(grant)).rejects.toThrow(
      "Couldn't store the Copilot sign-in on this device.",
    );
  });

  it('reports unreadable, and keeps the file, when decryption fails', async () => {
    await createCopilotCredential(grant);
    safeStorageMock.decryptString.mockImplementationOnce(() => {
      throw new Error('keychain locked');
    });
    await expect(readCopilotCredential()).resolves.toMatchObject({
      status: 'unreadable',
      secureStorageFailure: { code: 'SECURE_STORAGE_DECRYPT_FAILED' },
    });
    await expect(readFile(filePath())).resolves.toBeDefined();
  });

  it('neither replaces nor deletes a grant it cannot read', async () => {
    const created = await createCopilotCredential(grant);
    const before = await readFile(filePath());
    safeStorageMock.encryptionAvailable = false;
    await expect(
      replaceCopilotCredential(created, rotated),
    ).resolves.toMatchObject({
      status: 'unreadable',
      secureStorageFailure: { code: 'SECURE_STORAGE_READ_UNAVAILABLE' },
    });
    await expect(deleteCopilotCredential(created)).resolves.toMatchObject({
      status: 'unreadable',
    });
    expect(await readFile(filePath())).toEqual(before);
  });

  it('treats a decrypted payload with the wrong shape as unreadable', async () => {
    await writeFile(
      filePath(),
      Buffer.from('encrypted:{"version":1,"login":"x"}'),
    );
    await expect(readCopilotCredential()).resolves.toEqual({
      status: 'unreadable',
    });
  });

  it('clears the credential, readable or not, and tolerates a missing file', async () => {
    await createCopilotCredential(grant);
    await clearCopilotCredential();
    await expect(readCopilotCredential()).resolves.toEqual({
      status: 'absent',
    });
    await expect(clearCopilotCredential()).resolves.toBeUndefined();
    await writeFile(filePath(), Buffer.from('not decryptable'));
    await clearCopilotCredential();
    await expect(readCopilotCredential()).resolves.toEqual({
      status: 'absent',
    });
  });

  it('clears when the secure directory was never created', async () => {
    const parent = root;
    root = join(parent, 'never-created');
    try {
      await expect(clearCopilotCredential()).resolves.toBeUndefined();
    } finally {
      root = parent;
    }
  });

  it('retains a credential and exposes typed metadata on refused saves', async () => {
    const created = await createCopilotCredential(grant);
    const before = await readFile(filePath());
    safeStorageMock.encryptionAvailable = false;
    await expect(
      createCopilotCredential({ ...grant, accessToken: 'replacement' }),
    ).rejects.toMatchObject({
      message: "Couldn't store the Copilot sign-in on this device.",
      secureStorageFailure: { code: 'SECURE_STORAGE_WRITE_REFUSED' },
    });
    await expect(readCopilotCredential()).resolves.toMatchObject({
      status: 'unreadable',
      secureStorageFailure: { code: 'SECURE_STORAGE_READ_UNAVAILABLE' },
    });
    expect(await readFile(filePath())).toEqual(before);
    safeStorageMock.encryptionAvailable = true;
    await expect(readCopilotCredential()).resolves.toMatchObject({
      status: 'present',
      credential: created,
    });
  });
});
