import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { safeStorage } from 'electron';

jest.mock('node:fs/promises');
let mockSecretServiceState: 'secure' | 'unavailable' | 'locked' = 'secure';
jest.mock('../lib/linux-secret-service', () => ({
  getLinuxSecretServiceState: (): 'secure' | 'unavailable' | 'locked' =>
    mockSecretServiceState,
}));
jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): string => 'linux',
}));
jest.mock('electron', () => ({
  app: { isReady: (): boolean => true },
  safeStorage: {
    getSelectedStorageBackend: jest.fn(() => 'gnome_libsecret'),
    isEncryptionAvailable: jest.fn(),
    encryptString: jest.fn(),
    decryptString: jest.fn(),
  },
}));
jest.mock('../lib/atomic-file', () => ({
  writeFileAtomically: jest.fn(),
}));
const mockPurgeReplicas = jest.fn((): Promise<void> => Promise.resolve());
jest.mock('../shared-containers/reconciliation-service', () => ({
  getSharedContainerReconciliationService: (): {
    withReplicaPurgeFence: (
      operation: () => Promise<unknown>,
    ) => Promise<unknown>;
  } => ({
    withReplicaPurgeFence: async (
      operation: () => Promise<unknown>,
    ): Promise<unknown> => {
      await mockPurgeReplicas();
      return operation();
    },
  }),
}));
jest.mock('../lib/paths', () => ({
  getCanopyCloudAccountFilePath: jest.fn(
    () => '/mock/userData/canopy-cloud-account.enc',
  ),
  getLegacyCanopyCloudAccountFilePath: jest.fn(
    () => '/mock/userData/secure/canopy-cloud-account.enc',
  ),
  getInternalLegacySharedCanopyCloudAccountFilePath: jest.fn(
    () => '/mock/stable-secure/canopy-cloud-account.enc',
  ),
}));
jest.mock('../canopy-cloud/config', () => ({
  CanopyCloudConfigError: class CanopyCloudConfigError extends Error {},
  getCanopyCloudBaseUrl: jest.fn(() => 'https://cloud.example.test'),
}));

const mockLogMainProcessWarn = jest.fn();
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: (message: string, context?: unknown): void => {
    mockLogMainProcessWarn(message, context);
  },
}));

import {
  clearCanopyCloudAccount,
  clearCanopyCloudAccountUnlessGuest,
  invalidateCanopyCloudAccountCache,
  loadCanopyCloudAccount,
  mergeCanopyCloudAccountCapabilities,
  readCanopyCloudAccountWithStatus,
  resetUnreadableCanopyCloudAccount,
  getCanopyCloudCredentials,
  isCanopyCloudAccountReadDegraded,
  isCanopyCloudStorageAvailable,
  loadCanopyCloudAccountPublicState,
  peekCanopyCloudAccount,
  saveCanopyCloudAccount,
  saveManualCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
  toPublicCanopyCloudAccountState,
} from '../lib/canopy-cloud-account-store';
import { writeFileAtomically } from '../lib/atomic-file';

const MEMORY_ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMORY_ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const mockedReadFile = jest.mocked(readFile);
const mockedMkdir = jest.mocked(mkdir);
const mockedRm = jest.mocked(rm);
const mockedAccess = jest.mocked(access);
const mockedRename = jest.mocked(rename);
const mockedWriteFileAtomically = jest.mocked(writeFileAtomically);

/* eslint-disable @typescript-eslint/unbound-method */
const mockedIsEncryptionAvailable = jest.mocked(
  safeStorage.isEncryptionAvailable,
);
const mockedBackend = jest.mocked(safeStorage.getSelectedStorageBackend);
const mockedEncryptString = jest.mocked(safeStorage.encryptString);
const mockedDecryptString = jest.mocked(safeStorage.decryptString);
/* eslint-enable @typescript-eslint/unbound-method */

const account = {
  id: 'account-1',
  name: 'Cloud Admin',
  email: 'admin@example.test',
  role: 'ADMIN' as const,
};

const withReplicaPurgeFence = async <T>(
  operation: () => Promise<T>,
): Promise<T> => {
  await mockPurgeReplicas();
  return operation();
};

describe('safe credential storage diagnostics', () => {
  it('projects only policy metadata even when no cloud account exists', () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockSecretServiceState = 'secure';
    mockedBackend.mockReturnValue('gnome_libsecret');
    expect(toPublicCanopyCloudAccountState(null)).toMatchObject({
      secureStorageStatus: {
        version: 1,
        state: 'secure',
        backend: 'gnome_libsecret',
        writeAvailable: true,
      },
    });
  });
});

describe('Canopy Cloud account store', () => {
  beforeEach(() => {
    mockSecretServiceState = 'secure';
    jest.clearAllMocks();
    invalidateCanopyCloudAccountCache();
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockedBackend.mockReturnValue('gnome_libsecret');
    mockedEncryptString.mockImplementation((text: string) =>
      Buffer.from(text, 'utf8'),
    );
    mockedDecryptString.mockImplementation((encrypted: Buffer) =>
      encrypted.toString('utf8'),
    );
    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFileAtomically.mockResolvedValue(undefined);
    mockedRm.mockResolvedValue(undefined);
    mockedAccess.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    mockedRename.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps the Personal UUID separate from visible organizations and removes it on replacement', async () => {
    const base = {
      apiKey: 'csk_personal',
      capabilities: [],
      account,
      organizations: [],
      createdAt: '2026-10-05T00:00:00Z',
      updatedAt: '2026-10-05T00:00:00Z',
    };
    const saved = await saveCanopyCloudAccount({
      ...base,
      personalOrganizationId: MEMORY_ORG_A.toUpperCase(),
    });
    expect(saved.personalOrganizationId).toBe(MEMORY_ORG_A);
    expect(toPublicCanopyCloudAccountState(saved)).toMatchObject({
      personalOrganizationId: MEMORY_ORG_A,
      organizations: [],
    });
    const refreshed = await saveCanopyCloudAccount(base);
    expect(refreshed.personalOrganizationId).toBeUndefined();
    expect(toPublicCanopyCloudAccountState(refreshed)).not.toHaveProperty(
      'personalOrganizationId',
    );
    const malformed = await saveCanopyCloudAccount({
      ...base,
      personalOrganizationId: 'not-a-uuid',
    });
    expect(malformed.personalOrganizationId).toBeUndefined();
  });
  it('normalizes legacy saved credentials to manual API-key metadata', async () => {
    mockedReadFile.mockResolvedValueOnce(
      Buffer.from(
        JSON.stringify({
          apiKey: 'csk_legacy',
          capabilities: ['portal-v1'],
          account,
          createdAt: '2026-05-27T10:00:00.000Z',
          updatedAt: '2026-05-27T10:00:00.000Z',
        }),
        'utf8',
      ),
    );

    await expect(loadCanopyCloudAccount()).resolves.toMatchObject({
      apiKey: 'csk_legacy',
      authMode: 'api_key',
      credentialSource: 'manual',
      capabilities: ['portal-v1'],
      account,
    });
  });

  it('retains ciphertext and replicas if storage locks during native decrypt in recovery', async () => {
    const bytes = Buffer.from('retained-ciphertext');
    mockedReadFile.mockResolvedValue(bytes);
    mockedDecryptString.mockImplementation(() => {
      mockedIsEncryptionAvailable.mockReturnValue(false);
      mockSecretServiceState = 'locked';
      throw new Error('native secret diagnostic');
    });
    const listener = jest.fn();
    const unsubscribe = subscribeCanopyCloudAccountChanges(listener);
    try {
      await expect(
        resetUnreadableCanopyCloudAccount(withReplicaPurgeFence),
      ).rejects.toMatchObject({
        code: 'SECURE_STORAGE_DECRYPT_FAILED',
      });
      expect(mockedRename).not.toHaveBeenCalled();
      expect(mockPurgeReplicas).not.toHaveBeenCalled();
      expect(mockedRm).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it.each(['gnome_libsecret', 'unknown'] as const)(
    'retains historical ciphertext while %s is unavailable for reads and writes',
    async (backend) => {
      const entry = {
        apiKey: 'csk_retained',
        capabilities: [],
        account,
        createdAt: '2026-10-13',
        updatedAt: '2026-10-13',
      };
      mockedReadFile.mockResolvedValue(Buffer.from(JSON.stringify(entry)));
      mockedBackend.mockReturnValue(backend);
      mockedIsEncryptionAvailable.mockReturnValue(false);
      mockSecretServiceState =
        backend === 'gnome_libsecret' ? 'locked' : 'secure';
      expect(isCanopyCloudStorageAvailable()).toBe(false);
      await expect(readCanopyCloudAccountWithStatus()).resolves.toMatchObject({
        status: 'unavailable',
        secureStorageFailure: {
          code: 'SECURE_STORAGE_READ_UNAVAILABLE',
          state: backend === 'gnome_libsecret' ? 'locked' : 'unavailable',
        },
      });
      await expect(saveCanopyCloudAccount(entry)).rejects.toMatchObject({
        secureStorageFailure: { code: 'SECURE_STORAGE_WRITE_REFUSED' },
      });
      expect(mockedEncryptString).not.toHaveBeenCalled();
      expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
      expect(mockedRm).not.toHaveBeenCalled();
    },
  );

  it('revalidates cached success across backend changes and recovers without changing file bytes', async () => {
    const entry = {
      apiKey: 'csk_retained',
      capabilities: [],
      account,
      createdAt: '2026-10-13',
      updatedAt: '2026-10-13',
    };
    const bytes = Buffer.from(JSON.stringify(entry));
    mockedReadFile.mockResolvedValue(bytes);
    await expect(loadCanopyCloudAccount()).resolves.toMatchObject({
      apiKey: entry.apiKey,
    });
    mockedBackend.mockReturnValue('unknown');
    mockedIsEncryptionAvailable.mockReturnValue(false);
    mockSecretServiceState = 'secure';
    await expect(loadCanopyCloudAccountPublicState()).resolves.toMatchObject({
      read: 'unavailable',
      secureStorageFailure: {
        code: 'SECURE_STORAGE_READ_UNAVAILABLE',
        state: 'unavailable',
      },
    });
    expect(peekCanopyCloudAccount()).toMatchObject({ apiKey: entry.apiKey });
    // Unavailable native storage fails before rereading the encrypted file.
    expect(mockedReadFile).toHaveBeenCalledTimes(1);
    mockedBackend.mockReturnValue('gnome_libsecret');
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockSecretServiceState = 'secure';
    await expect(loadCanopyCloudAccount()).resolves.toMatchObject({
      apiKey: entry.apiKey,
    });
    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
  });

  it('retains cached success across a lock and retries a decrypt failure on the same backend', async () => {
    const entry = {
      apiKey: 'csk_retained',
      capabilities: [],
      account,
      createdAt: '2026-10-13',
      updatedAt: '2026-10-13',
    };
    mockedReadFile.mockResolvedValue(Buffer.from(JSON.stringify(entry)));
    await loadCanopyCloudAccount();
    mockedIsEncryptionAvailable.mockReturnValue(false);
    mockSecretServiceState = 'locked';
    await expect(readCanopyCloudAccountWithStatus()).resolves.toMatchObject({
      status: 'unavailable',
      secureStorageFailure: { state: 'locked' },
    });
    expect(peekCanopyCloudAccount()).toMatchObject({ apiKey: entry.apiKey });
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockSecretServiceState = 'secure';
    mockedDecryptString.mockImplementationOnce(() => {
      throw new Error('temporary failure');
    });
    await expect(
      readCanopyCloudAccountWithStatus({ cache: false }),
    ).resolves.toMatchObject({ status: 'error' });
    await expect(
      readCanopyCloudAccountWithStatus({ cache: false }),
    ).resolves.toMatchObject({ status: 'ok', entry: { apiKey: entry.apiKey } });
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('returns decoded legacy credentials with deferred write metadata and retries without a cache delay', async () => {
    const entry = {
      apiKey: 'csk_legacy',
      capabilities: [],
      account,
      createdAt: '2026-10-13',
      updatedAt: '2026-10-13',
    };
    mockedReadFile.mockImplementation((filePath) =>
      filePath === '/mock/stable-secure/canopy-cloud-account.enc'
        ? Promise.resolve(Buffer.from(JSON.stringify(entry)))
        : Promise.reject(
            Object.assign(new Error('missing'), { code: 'ENOENT' }),
          ),
    );
    mockedDecryptString.mockImplementationOnce((raw: Buffer) => {
      mockedIsEncryptionAvailable.mockReturnValue(false);
      mockSecretServiceState = 'locked';
      return raw.toString('utf8');
    });
    await expect(readCanopyCloudAccountWithStatus()).resolves.toMatchObject({
      status: 'ok',
      entry: { apiKey: entry.apiKey },
      migrationWriteFailure: {
        code: 'SECURE_STORAGE_WRITE_REFUSED',
        state: 'locked',
      },
    });
    expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockSecretServiceState = 'secure';
    await expect(readCanopyCloudAccountWithStatus()).resolves.toMatchObject({
      status: 'ok',
      entry: { apiKey: entry.apiKey },
    });
    expect(mockedWriteFileAtomically).toHaveBeenCalledTimes(1);
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('rechecks write permission after asynchronous preparation without cache or notifications', async () => {
    const entry = {
      apiKey: 'csk_new',
      capabilities: [],
      account,
      createdAt: '2026-10-13',
      updatedAt: '2026-10-13',
    };
    mockedMkdir.mockImplementationOnce(() => {
      mockedIsEncryptionAvailable.mockReturnValue(false);
      mockSecretServiceState = 'locked';
      return Promise.resolve(undefined);
    });
    const listener = jest.fn();
    const unsubscribe = subscribeCanopyCloudAccountChanges(listener);
    try {
      await expect(saveCanopyCloudAccount(entry)).rejects.toMatchObject({
        secureStorageFailure: { code: 'SECURE_STORAGE_WRITE_REFUSED' },
      });
      expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
      expect(mockedRm).not.toHaveBeenCalled();
      expect(peekCanopyCloudAccount()).toBeNull();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('distinguishes an unavailable keychain from signed out', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(false);
    mockSecretServiceState = 'locked';
    await expect(readCanopyCloudAccountWithStatus()).resolves.toMatchObject({
      status: 'unavailable',
      secureStorageFailure: { code: 'SECURE_STORAGE_READ_UNAVAILABLE' },
    });
    expect(mockedReadFile).not.toHaveBeenCalled();
  });

  it('surfaces readable-backend decrypt failures as public read errors with nonretryable metadata', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('encrypted'));
    const failure = new Error('decrypt failed at /Users/private/account.enc');
    mockedDecryptString.mockImplementation(() => {
      throw failure;
    });

    await expect(readCanopyCloudAccountWithStatus()).resolves.toMatchObject({
      status: 'error',
      secureStorageFailure: {
        version: 1,
        code: 'SECURE_STORAGE_DECRYPT_FAILED',
        operation: 'read',
        state: 'secure',
        backend: 'gnome_libsecret',
        retryable: false,
      },
    });
    await expect(loadCanopyCloudAccountPublicState()).resolves.toMatchObject({
      read: 'error',
      hasApiKey: false,
      storageAvailable: true,
      secureStorageFailure: {
        version: 1,
        code: 'SECURE_STORAGE_DECRYPT_FAILED',
        operation: 'read',
        state: 'secure',
        backend: 'gnome_libsecret',
        retryable: false,
      },
    });
    await expect(loadCanopyCloudAccount()).resolves.toBeNull();
    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
    expect(JSON.stringify(mockLogMainProcessWarn.mock.calls)).not.toContain(
      '/Users/private',
    );
  });

  it('keeps a lock during native decrypt publicly unavailable and retryable', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('encrypted'));
    mockedDecryptString.mockImplementation(() => {
      mockedIsEncryptionAvailable.mockReturnValue(false);
      mockSecretServiceState = 'locked';
      throw new Error('locked');
    });

    await expect(loadCanopyCloudAccountPublicState()).resolves.toMatchObject({
      read: 'unavailable',
      storageAvailable: false,
      secureStorageFailure: {
        code: 'SECURE_STORAGE_DECRYPT_FAILED',
        state: 'locked',
        retryable: true,
      },
    });
    expect(mockedRename).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
  });

  it('surfaces a malformed stored account through the status reader', async () => {
    mockedReadFile.mockResolvedValue(
      Buffer.from(JSON.stringify({ apiKey: 42 }), 'utf8'),
    );

    const result = await readCanopyCloudAccountWithStatus();
    expect(result).toMatchObject({ status: 'error' });
    expect(result.status === 'error' ? result.error : null).toBeInstanceOf(
      Error,
    );
    await expect(loadCanopyCloudAccount()).resolves.toBeNull();
  });

  it('migrates a readable former production credential into the isolated destination', async () => {
    const legacyBytes = Buffer.from('legacy-ciphertext');
    mockedReadFile
      .mockRejectedValueOnce(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      )
      .mockResolvedValueOnce(legacyBytes);
    mockedDecryptString.mockReturnValueOnce(
      JSON.stringify({
        apiKey: 'csk_legacy',
        capabilities: [],
        account,
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:00:00.000Z',
      }),
    );
    mockedEncryptString.mockReturnValueOnce(Buffer.from('internal-ciphertext'));

    await expect(loadCanopyCloudAccount()).resolves.toMatchObject({
      apiKey: 'csk_legacy',
    });
    expect(mockedWriteFileAtomically).toHaveBeenCalledWith(
      '/mock/userData/canopy-cloud-account.enc',
      Buffer.from('internal-ciphertext'),
      { mode: 0o600, overwrite: false },
    );
    expect(mockedRm).not.toHaveBeenCalledWith(
      '/mock/stable-secure/canopy-cloud-account.enc',
      expect.anything(),
    );
  });

  it('does not cache absence after invalid decrypted shared legacy data', async () => {
    const valid = {
      apiKey: 'csk_restored',
      capabilities: [],
      account,
      createdAt: '2026-10-13',
      updatedAt: '2026-10-13',
    };
    let decoded = JSON.stringify({ apiKey: 42 });
    mockedReadFile.mockImplementation((filePath) =>
      filePath === '/mock/stable-secure/canopy-cloud-account.enc'
        ? Promise.resolve(Buffer.from(decoded))
        : Promise.reject(
            Object.assign(new Error('missing'), { code: 'ENOENT' }),
          ),
    );
    await expect(readCanopyCloudAccountWithStatus()).resolves.toMatchObject({
      status: 'error',
    });
    expect(mockedReadFile).toHaveBeenCalledTimes(2);
    expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
    decoded = JSON.stringify(valid);
    await expect(readCanopyCloudAccountWithStatus()).resolves.toMatchObject({
      status: 'ok',
      entry: { apiKey: valid.apiKey },
    });
    expect(mockedWriteFileAtomically).toHaveBeenCalledTimes(1);
  });

  it('retains an unreadable former production credential and treats the store as empty', async () => {
    mockedReadFile
      .mockRejectedValueOnce(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      )
      .mockResolvedValueOnce(Buffer.from('foreign'))
      .mockRejectedValueOnce(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      )
      .mockResolvedValueOnce(Buffer.from('foreign'));
    mockedDecryptString.mockImplementation(() => {
      throw new Error('wrong identity');
    });

    await expect(readCanopyCloudAccountWithStatus()).resolves.toMatchObject({
      status: 'ok',
      entry: null,
    });
    await expect(readCanopyCloudAccountWithStatus()).resolves.toMatchObject({
      status: 'ok',
      entry: null,
    });
    expect(mockedReadFile).toHaveBeenCalledTimes(4);
    expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('backs up and resets authoritative ciphertext when native decrypt throws', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('unreadable-ciphertext'));
    mockedDecryptString.mockImplementation(() => {
      throw new Error('wrong identity');
    });

    await expect(
      resetUnreadableCanopyCloudAccount(withReplicaPurgeFence),
    ).resolves.toMatchObject({
      status: 'reset',
      account: { hasApiKey: false },
    });
    expect(mockedRename).toHaveBeenCalledWith(
      '/mock/userData/canopy-cloud-account.enc',
      expect.stringMatching(/canopy-cloud-account\.enc\.bak-/),
    );
    expect(mockPurgeReplicas).toHaveBeenCalledTimes(1);
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('does not reset when storage locks during native decrypt', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('saved-ciphertext'));
    mockedDecryptString.mockImplementation(() => {
      mockedIsEncryptionAvailable.mockReturnValue(false);
      mockSecretServiceState = 'locked';
      throw new Error('locked');
    });

    await expect(
      resetUnreadableCanopyCloudAccount(withReplicaPurgeFence),
    ).rejects.toMatchObject({
      secureStorageFailure: { state: 'locked', retryable: true },
    });
    expect(mockedRename).not.toHaveBeenCalled();
    expect(mockPurgeReplicas).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it.each(['manual', 'oauth'] as const)(
    'allows a %s credential save after explicit reset of a native decrypt failure',
    async (mode) => {
      const unreadable = Buffer.from('unreadable-ciphertext');
      let authoritativeBytes: typeof unreadable | null = unreadable;
      mockedReadFile.mockImplementation((filePath) =>
        filePath === '/mock/userData/canopy-cloud-account.enc' &&
        authoritativeBytes
          ? Promise.resolve(authoritativeBytes)
          : Promise.reject(
              Object.assign(new Error('missing'), { code: 'ENOENT' }),
            ),
      );
      mockedDecryptString.mockImplementation((bytes) => {
        if (bytes.equals(unreadable)) throw new Error('wrong identity');
        return bytes.toString('utf8');
      });
      mockedRename.mockImplementation((): Promise<void> => {
        authoritativeBytes = null;
        return Promise.resolve();
      });
      mockedWriteFileAtomically.mockImplementation((_path, data) => {
        authoritativeBytes = Buffer.from(data);
        return Promise.resolve();
      });

      await expect(loadCanopyCloudAccountPublicState()).resolves.toMatchObject({
        read: 'error',
        secureStorageFailure: {
          code: 'SECURE_STORAGE_DECRYPT_FAILED',
          retryable: false,
        },
      });
      await expect(
        resetUnreadableCanopyCloudAccount(withReplicaPurgeFence),
      ).resolves.toMatchObject({
        status: 'reset',
        account: { read: 'ok', hasApiKey: false },
      });
      const replacement: Parameters<typeof saveCanopyCloudAccount>[0] = {
        apiKey: 'csk_replacement',
        authMode: mode === 'manual' ? 'api_key' : 'oauth',
        credentialSource: mode === 'manual' ? 'manual' : 'oauth_desktop',
        capabilities: [],
        account,
        createdAt: '2026-10-13',
        updatedAt: '2026-10-13',
      };
      const saved =
        mode === 'manual'
          ? await saveManualCanopyCloudAccount(replacement, null)
          : await saveCanopyCloudAccount(replacement);
      expect(saved).toMatchObject(
        mode === 'manual'
          ? { status: 'saved', entry: replacement, previousAccount: null }
          : replacement,
      );
      invalidateCanopyCloudAccountCache();
      await expect(loadCanopyCloudAccountPublicState()).resolves.toMatchObject({
        read: 'ok',
        hasApiKey: true,
        authMode: replacement.authMode,
        credentialSource: replacement.credentialSource,
      });
      expect(mockedRename).toHaveBeenCalledTimes(1);
      expect(mockPurgeReplicas).toHaveBeenCalledTimes(1);
      expect(mockedWriteFileAtomically).toHaveBeenCalledTimes(1);
    },
  );

  it('backs up and resets successfully decrypted but invalid authoritative data', async () => {
    const unreadable = Buffer.from('unreadable-ciphertext');
    mockedReadFile.mockResolvedValue(unreadable);
    mockedDecryptString.mockReturnValue(JSON.stringify({ apiKey: 42 }));

    const result = await resetUnreadableCanopyCloudAccount(
      withReplicaPurgeFence,
    );

    expect(result).toMatchObject({
      status: 'reset',
      account: { read: 'ok', hasApiKey: false },
    });
    expect(result.status).toBe('reset');
    if (result.status === 'reset') {
      expect(result.backupFileName).toMatch(
        /^canopy-cloud-account\.enc\.bak-\d{8}-\d{6}-\d{3}Z-[a-f0-9]{16}$/,
      );
    }
    expect(mockPurgeReplicas).toHaveBeenCalledTimes(1);
    expect(mockedRename).toHaveBeenCalledWith(
      '/mock/userData/canopy-cloud-account.enc',
      expect.stringMatching(
        /^\/mock\/userData\/canopy-cloud-account\.enc\.bak-/,
      ),
    );
  });

  it('backs up invalid decrypted authoritative legacy data when the current path is absent', async () => {
    const unreadable = Buffer.from('unreadable-legacy-ciphertext');
    mockedReadFile
      .mockRejectedValueOnce(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      )
      .mockResolvedValueOnce(unreadable);
    mockedDecryptString.mockReturnValue(JSON.stringify({ apiKey: 42 }));

    const result = await resetUnreadableCanopyCloudAccount(
      withReplicaPurgeFence,
    );

    expect(result).toMatchObject({
      status: 'reset',
      account: { read: 'ok', hasApiKey: false },
    });
    expect(mockPurgeReplicas).toHaveBeenCalledTimes(1);
    expect(mockedRename).toHaveBeenCalledWith(
      '/mock/userData/secure/canopy-cloud-account.enc',
      expect.stringMatching(
        /^\/mock\/userData\/secure\/canopy-cloud-account\.enc\.bak-/,
      ),
    );
  });

  it('returns not-needed without mutation when the authoritative credential is readable', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('readable'));
    mockedDecryptString.mockReturnValue(
      JSON.stringify({
        apiKey: 'csk_current',
        capabilities: [],
        account,
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:00:00.000Z',
      }),
    );

    await expect(
      resetUnreadableCanopyCloudAccount(withReplicaPurgeFence),
    ).resolves.toMatchObject({
      status: 'not-needed',
      account: { read: 'ok', hasApiKey: true },
    });
    expect(mockPurgeReplicas).not.toHaveBeenCalled();
    expect(mockedRename).not.toHaveBeenCalled();
  });

  it('returns not-needed without mutation when the authoritative credential is absent', async () => {
    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );

    await expect(
      resetUnreadableCanopyCloudAccount(withReplicaPurgeFence),
    ).resolves.toMatchObject({
      status: 'not-needed',
      account: { read: 'ok', hasApiKey: false },
    });
    expect(mockPurgeReplicas).not.toHaveBeenCalled();
    expect(mockedRename).not.toHaveBeenCalled();
  });

  it('publishes signed-out state after recovery and surfaces subscriber failure', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('unreadable'));
    mockedDecryptString.mockReturnValue(JSON.stringify({ apiKey: 42 }));
    const observingListener = jest.fn();
    const unsubscribeObserving =
      subscribeCanopyCloudAccountChanges(observingListener);
    const unsubscribeFailing = subscribeCanopyCloudAccountChanges(() => {
      throw new Error('subscriber failed');
    });

    await expect(
      resetUnreadableCanopyCloudAccount(withReplicaPurgeFence),
    ).rejects.toThrow('subscriber failed');

    expect(mockedRename).toHaveBeenCalledTimes(1);
    expect(observingListener).toHaveBeenCalledWith(null);
    await expect(loadCanopyCloudAccount()).resolves.toBeNull();
    unsubscribeObserving();
    unsubscribeFailing();
  });

  it('retries backup-name collisions without overwriting an existing backup', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('unreadable'));
    mockedDecryptString.mockReturnValue(JSON.stringify({ apiKey: 42 }));
    mockedAccess
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );

    await resetUnreadableCanopyCloudAccount(withReplicaPurgeFence);

    expect(mockedAccess).toHaveBeenCalledTimes(2);
    const firstCandidate = mockedAccess.mock.calls[0]?.[0];
    const secondCandidate = mockedAccess.mock.calls[1]?.[0];
    expect(secondCandidate).not.toBe(firstCandidate);
    expect(mockedRename).toHaveBeenCalledWith(
      '/mock/userData/canopy-cloud-account.enc',
      secondCandidate,
    );
  });

  it('returns not-needed on a second recovery request', async () => {
    const unreadable = Buffer.from('unreadable');
    let authoritativeBytes: typeof unreadable | null = unreadable;
    mockedReadFile.mockImplementation(() =>
      authoritativeBytes
        ? Promise.resolve(authoritativeBytes)
        : Promise.reject(
            Object.assign(new Error('missing'), { code: 'ENOENT' }),
          ),
    );
    mockedDecryptString.mockReturnValue(JSON.stringify({ apiKey: 42 }));
    mockedRename.mockImplementation((): Promise<void> => {
      authoritativeBytes = null;
      return Promise.resolve();
    });

    await expect(
      resetUnreadableCanopyCloudAccount(withReplicaPurgeFence),
    ).resolves.toMatchObject({ status: 'reset' });
    await expect(
      resetUnreadableCanopyCloudAccount(withReplicaPurgeFence),
    ).resolves.toMatchObject({ status: 'not-needed' });

    expect(mockedRename).toHaveBeenCalledTimes(1);
    expect(mockPurgeReplicas).toHaveBeenCalledTimes(1);
  });

  it('does not remove a readable credential saved while recovery waits for the lock', async () => {
    let releaseWrite!: () => void;
    const unreadable = Buffer.from('unreadable');
    let authoritativeBytes: typeof unreadable | null = unreadable;
    mockedReadFile.mockImplementation(() =>
      authoritativeBytes
        ? Promise.resolve(authoritativeBytes)
        : Promise.reject(
            Object.assign(new Error('missing'), { code: 'ENOENT' }),
          ),
    );
    mockedDecryptString.mockImplementation((bytes) => bytes.toString('utf8'));
    mockedWriteFileAtomically.mockImplementationOnce(
      (_path, data) =>
        new Promise<void>((resolve) => {
          releaseWrite = (): void => {
            authoritativeBytes = Buffer.from(data);
            resolve();
          };
        }),
    );
    const replacement = {
      apiKey: 'csk_replacement',
      capabilities: [],
      account,
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
    };

    const saving = saveCanopyCloudAccount(replacement);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    const recovery = resetUnreadableCanopyCloudAccount(withReplicaPurgeFence);
    releaseWrite();

    await saving;
    await expect(recovery).resolves.toMatchObject({
      status: 'not-needed',
      account: { read: 'ok', hasApiKey: true },
    });
    expect(mockedRename).not.toHaveBeenCalled();
    expect(mockPurgeReplicas).not.toHaveBeenCalled();
  });

  it('does not mutate when secure storage is unavailable during reset', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(false);
    mockSecretServiceState = 'locked';

    await expect(
      resetUnreadableCanopyCloudAccount(withReplicaPurgeFence),
    ).rejects.toMatchObject({ code: 'SECURE_STORAGE_READ_UNAVAILABLE' });
    expect(mockedRename).not.toHaveBeenCalled();
    expect(mockPurgeReplicas).not.toHaveBeenCalled();
  });

  it('does not rename the credential when replica purge fails', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('unreadable'));
    mockedDecryptString.mockReturnValue(JSON.stringify({ apiKey: 42 }));
    mockPurgeReplicas.mockRejectedValueOnce(new Error('purge failed'));

    await expect(
      resetUnreadableCanopyCloudAccount(withReplicaPurgeFence),
    ).rejects.toThrow('purge failed');
    expect(mockedRename).not.toHaveBeenCalled();
  });

  it('does not let a guard-only read overwrite another caller read status', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(false);
    mockSecretServiceState = 'locked';
    await expect(loadCanopyCloudAccount()).resolves.toBeNull();
    expect(isCanopyCloudAccountReadDegraded()).toBe(true);

    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockSecretServiceState = 'secure';
    await expect(clearCanopyCloudAccountUnlessGuest()).resolves.toMatchObject({
      status: 'cleared',
    });

    expect(isCanopyCloudAccountReadDegraded()).toBe(true);
  });

  it('persists OAuth desktop metadata and keeps it out of public state', async () => {
    const saved = await saveCanopyCloudAccount({
      apiKey: 'csk_oauth',
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      serverApiKeyId: 'key-1',
      memorySearchOrganizationExternalId: MEMORY_ORG_A,
      memorySearchOrganizationExternalIds: [MEMORY_ORG_A, MEMORY_ORG_B],
      capabilities: ['portal-v1'],
      account,
      organizations: [],
      teams: [],
      createdAt: '2026-06-01T19:00:00.000Z',
      updatedAt: '2026-06-01T19:00:00.000Z',
    });

    expect(mockedWriteFileAtomically).toHaveBeenCalledWith(
      '/mock/userData/canopy-cloud-account.enc',
      expect.any(Buffer),
      { mode: 0o600 },
    );
    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/userData/secure/canopy-cloud-account.enc',
      { force: true },
    );
    expect(JSON.parse(mockedEncryptString.mock.calls[0][0])).toMatchObject({
      apiKey: 'csk_oauth',
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      serverApiKeyId: 'key-1',
    });

    const publicState = toPublicCanopyCloudAccountState(saved);
    expect(publicState).toMatchObject({
      hasApiKey: true,
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      serverApiKeyId: 'key-1',
      memorySearchOrganizationExternalId: MEMORY_ORG_A,
      memorySearchOrganizationExternalIds: [MEMORY_ORG_A, MEMORY_ORG_B],
      account,
    });
    await expect(getCanopyCloudCredentials()).resolves.toMatchObject({
      memorySearchOrganizationExternalIds: [MEMORY_ORG_A, MEMORY_ORG_B],
    });
    expect(publicState).not.toHaveProperty('apiKey');
  });

  // CAN-3457: an entry cached by an older desktop has only the deprecated
  // single org. It loads as a one-entry list, never as "every org".
  it('reads a cached single memory org as a one-entry list', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('encrypted'));
    mockedDecryptString.mockReturnValue(
      JSON.stringify({
        apiKey: 'csk_cached',
        capabilities: ['memorySearch'],
        memorySearchOrganizationExternalId: MEMORY_ORG_B.toUpperCase(),
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:00:00.000Z',
      }),
    );

    await expect(getCanopyCloudCredentials()).resolves.toMatchObject({
      memorySearchOrganizationExternalIds: [MEMORY_ORG_B],
    });
  });

  it('drops malformed cached memory orgs', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('encrypted'));
    mockedDecryptString.mockReturnValue(
      JSON.stringify({
        apiKey: 'csk_cached',
        capabilities: ['memorySearch'],
        memorySearchOrganizationExternalIds: ['org-1', MEMORY_ORG_A],
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:00:00.000Z',
      }),
    );

    const credentials = await getCanopyCloudCredentials();
    expect(credentials.memorySearchOrganizationExternalIds).toEqual([
      MEMORY_ORG_A,
    ]);
  });

  it('reports no memory orgs when none are cached', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('encrypted'));
    mockedDecryptString.mockReturnValue(
      JSON.stringify({
        apiKey: 'csk_cached',
        capabilities: [],
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:00:00.000Z',
      }),
    );

    const credentials = await getCanopyCloudCredentials();
    expect(credentials.memorySearchOrganizationExternalIds).toEqual([]);
  });

  it('preserves unavailable telemetry enforcement across normalization and clears it only with a fresh snapshot', async () => {
    const saved = await saveCanopyCloudAccount({
      apiKey: 'key',
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: [],
      account,
      organizations: [],
      teams: [],
      createdAt: '2026-10-05T12:00:00.000Z',
      updatedAt: '2026-10-05T12:00:00.000Z',
    });
    expect(
      toPublicCanopyCloudAccountState(saved).telemetryEnforcementUnavailable,
    ).toBe(true);
    const fresh = await saveCanopyCloudAccount({
      ...saved,
      enforcedSettings: [],
      telemetryEnforcementUnavailable: false,
    });
    expect(
      toPublicCanopyCloudAccountState(fresh).telemetryEnforcementUnavailable,
    ).not.toBe(true);
  });

  it('persists degraded gateway enforcement in public account state', async () => {
    const saved = await saveCanopyCloudAccount({
      apiKey: 'csk_oauth',
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: ['portal-v1'],
      account,
      organizations: [],
      teams: [],
      enforcedSettings: [],
      modelGatewayEnforcementUnavailable: true,
      createdAt: '2026-06-01T19:00:00.000Z',
      updatedAt: '2026-06-01T19:00:00.000Z',
    });

    expect(JSON.parse(mockedEncryptString.mock.calls[0][0])).toMatchObject({
      modelGatewayEnforcementUnavailable: true,
    });
    expect(toPublicCanopyCloudAccountState(saved)).toMatchObject({
      modelGatewayEnforcementUnavailable: true,
    });
  });

  it('keeps a valid organization role and drops an invalid one on save', async () => {
    const saved = await saveCanopyCloudAccount({
      apiKey: 'csk_roles',
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: ['organizations-v1'],
      account,
      organizations: [
        {
          id: 'org-1',
          name: 'Acme',
          role: 'ADMIN',
          createdAt: '2026-09-10T00:00:00.000Z',
          updatedAt: '2026-09-10T00:00:00.000Z',
        },
      ],
      teams: [],
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    });

    expect(saved.organizations).toEqual([
      expect.objectContaining({ id: 'org-1', role: 'ADMIN' }),
    ]);
    expect(
      toPublicCanopyCloudAccountState(saved).organizations?.[0]?.role,
    ).toBe('ADMIN');
  });

  it('persists guest credential source and auth mode', async () => {
    const saved = await saveCanopyCloudAccount({
      apiKey: 'csk_guest',
      authMode: 'guest',
      credentialSource: 'guest',
      serverApiKeyId: 'guest-key-1',
      capabilities: ['portal-v1'],
      account,
      organizations: [],
      teams: [],
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
    });

    expect(JSON.parse(mockedEncryptString.mock.calls[0][0])).toMatchObject({
      apiKey: 'csk_guest',
      authMode: 'guest',
      credentialSource: 'guest',
    });

    const publicState = toPublicCanopyCloudAccountState(saved);
    expect(publicState).toMatchObject({
      hasApiKey: true,
      authMode: 'guest',
      credentialSource: 'guest',
    });
  });

  it('does not let a delayed guest save replace a newer real credential', async () => {
    const realAccount = await saveCanopyCloudAccount({
      apiKey: 'csk_real',
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: ['portal-v1'],
      account,
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:01.000Z',
    });

    const delayedGuestSave = await saveCanopyCloudAccount({
      apiKey: 'csk_guest_from_slow_network',
      authMode: 'guest',
      credentialSource: 'guest',
      capabilities: ['portal-v1'],
      account: { ...account, id: 'guest-account' },
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:02.000Z',
    });

    expect(delayedGuestSave).toEqual(realAccount);
    await expect(loadCanopyCloudAccount()).resolves.toEqual(realAccount);
    expect(mockedWriteFileAtomically).toHaveBeenCalledTimes(1);
  });

  it('fails a guest save closed when the current account cannot be decrypted', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('encrypted'));
    const failure = new Error('decrypt failed');
    mockedDecryptString.mockImplementation(() => {
      throw failure;
    });

    await expect(
      saveCanopyCloudAccount({
        apiKey: 'csk_guest',
        authMode: 'guest',
        credentialSource: 'guest',
        capabilities: ['portal-v1'],
        account,
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({
      secureStorageFailure: { code: 'SECURE_STORAGE_DECRYPT_FAILED' },
    });
    expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
  });

  it('fails a manual save closed when the current account cannot be decrypted', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('encrypted'));
    const failure = new Error('decrypt failed');
    mockedDecryptString.mockImplementation(() => {
      throw failure;
    });

    await expect(
      saveManualCanopyCloudAccount(
        {
          apiKey: 'csk_manual',
          authMode: 'api_key',
          credentialSource: 'manual',
          capabilities: ['portal-v1'],
          account,
          createdAt: '2026-07-06T00:00:00.000Z',
          updatedAt: '2026-07-06T00:00:00.000Z',
        },
        null,
      ),
    ).rejects.toMatchObject({
      secureStorageFailure: { code: 'SECURE_STORAGE_DECRYPT_FAILED' },
    });
    expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
  });

  it('fails a guarded clear closed when secure storage is unavailable', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(false);
    mockSecretServiceState = 'locked';

    await expect(clearCanopyCloudAccountUnlessGuest()).rejects.toMatchObject({
      secureStorageFailure: { code: 'SECURE_STORAGE_READ_UNAVAILABLE' },
    });
    expect(mockedRm).not.toHaveBeenCalledWith(
      '/mock/userData/canopy-cloud-account.enc',
      { force: true },
    );
  });

  it('serializes manual saves behind an in-flight guest mint and protects the guest', async () => {
    let finishGuestWrite!: () => void;
    mockedWriteFileAtomically.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishGuestWrite = resolve;
        }),
    );
    const guestSave = saveCanopyCloudAccount({
      apiKey: 'csk_guest',
      authMode: 'guest',
      credentialSource: 'guest',
      capabilities: ['portal-v1'],
      account,
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
    });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(mockedWriteFileAtomically).toHaveBeenCalledTimes(1);

    const manualSave = saveManualCanopyCloudAccount(
      {
        apiKey: 'csk_manual',
        authMode: 'api_key',
        credentialSource: 'manual',
        capabilities: ['portal-v1'],
        account,
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:01.000Z',
      },
      null,
    );
    finishGuestWrite();

    await guestSave;
    await expect(manualSave).resolves.toMatchObject({
      status: 'guest-protected',
      account: { credentialSource: 'guest' },
    });
    expect(mockedWriteFileAtomically).toHaveBeenCalledTimes(1);
  });

  it('rejects a manual save when OAuth changed the credential after validation began', async () => {
    const oauthAccount = await saveCanopyCloudAccount({
      apiKey: 'csk_oauth_newer',
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      serverApiKeyId: 'oauth-key-newer',
      capabilities: ['portal-v1'],
      account,
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:01.000Z',
    });

    const result = await saveManualCanopyCloudAccount(
      {
        apiKey: 'csk_manual_stale',
        authMode: 'api_key',
        credentialSource: 'manual',
        capabilities: ['portal-v1'],
        account,
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:02.000Z',
      },
      null,
    );

    expect(result).toEqual({ status: 'superseded', account: oauthAccount });
    await expect(loadCanopyCloudAccount()).resolves.toEqual(oauthAccount);
    expect(mockedWriteFileAtomically).toHaveBeenCalledTimes(1);
  });

  it('does not let a capability merge restore an account replaced while the merge queued', async () => {
    const previous = await saveCanopyCloudAccount({
      apiKey: 'csk_previous',
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: [],
      account,
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
    });
    let releaseReplacement!: () => void;
    mockedWriteFileAtomically.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseReplacement = resolve;
        }),
    );
    const replacement = saveCanopyCloudAccount({
      ...previous,
      apiKey: 'csk_replacement',
      account: { ...account, id: 'account-2' },
      updatedAt: '2026-07-06T00:00:01.000Z',
    });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    const merging = Reflect.apply(mergeCanopyCloudAccountCapabilities, null, [
      ['shared-containers-v1'],
      previous.apiKey,
    ]);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    releaseReplacement();

    const savedReplacement = await replacement;
    await merging;
    await expect(loadCanopyCloudAccount()).resolves.toEqual(savedReplacement);
    expect(mockedWriteFileAtomically).toHaveBeenCalledTimes(2);
  });

  it('does not let a capability merge restore an account cleared while the merge queued', async () => {
    const previous = await saveCanopyCloudAccount({
      apiKey: 'csk_previous',
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: [],
      account,
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
    });
    mockedReadFile.mockResolvedValue(
      Buffer.from(JSON.stringify(previous), 'utf8'),
    );
    let releaseClear!: () => void;
    mockedRm.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseClear = resolve;
        }),
    );
    const clearing = clearCanopyCloudAccount();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    const merging = Reflect.apply(mergeCanopyCloudAccountCapabilities, null, [
      ['shared-containers-v1'],
      previous.apiKey,
    ]);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    releaseClear();

    await clearing;
    await merging;
    await expect(loadCanopyCloudAccount()).resolves.toBeNull();
    expect(mockedWriteFileAtomically).toHaveBeenCalledTimes(1);
  });

  it('serializes a guarded clear behind an in-flight guest mint and preserves the guest', async () => {
    let finishGuestWrite!: () => void;
    mockedWriteFileAtomically.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishGuestWrite = resolve;
        }),
    );
    const guestSave = saveCanopyCloudAccount({
      apiKey: 'csk_guest',
      authMode: 'guest',
      credentialSource: 'guest',
      capabilities: ['portal-v1'],
      account,
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
    });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    const clear = clearCanopyCloudAccountUnlessGuest();
    finishGuestWrite();

    await guestSave;
    await expect(clear).resolves.toMatchObject({
      status: 'guest-protected',
      account: { credentialSource: 'guest' },
    });
    expect(mockedRm).not.toHaveBeenCalledWith(
      '/mock/userData/canopy-cloud-account.enc',
      { force: true },
    );
  });

  it('times out a queued account operation without running it after the holder releases', async () => {
    jest.useFakeTimers();
    let finishWrite!: () => void;
    mockedWriteFileAtomically.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const save = saveCanopyCloudAccount({
      apiKey: 'csk_slow',
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: [],
      account,
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
    });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    const queuedClear = clearCanopyCloudAccount().then(
      () => 'resolved',
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );
    jest.advanceTimersByTime(30_000);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    const laterSave = saveCanopyCloudAccount({
      apiKey: 'csk_after_timeout',
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: [],
      account,
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:01.000Z',
    });
    finishWrite();
    await save;
    await laterSave;

    await expect(queuedClear).resolves.toContain(
      'Timed out waiting for another account operation',
    );
    expect(mockedRm).not.toHaveBeenCalledWith(
      '/mock/userData/canopy-cloud-account.enc',
      { force: true },
    );
    expect(mockedWriteFileAtomically).toHaveBeenCalledTimes(2);
  });

  it('normalizes a persisted guest credential on read', async () => {
    invalidateCanopyCloudAccountCache();
    mockedReadFile.mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          apiKey: 'csk_guest',
          authMode: 'guest',
          credentialSource: 'guest',
          capabilities: ['portal-v1'],
          account,
          createdAt: '2026-07-06T00:00:00.000Z',
          updatedAt: '2026-07-06T00:00:00.000Z',
        }),
        'utf8',
      ),
    );

    await expect(loadCanopyCloudAccount()).resolves.toMatchObject({
      authMode: 'guest',
      credentialSource: 'guest',
    });
  });

  it('parses the account image when it is a string', async () => {
    invalidateCanopyCloudAccountCache();
    mockedReadFile.mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          apiKey: 'csk_image',
          capabilities: ['portal-v1'],
          account: {
            ...account,
            image: 'https://cdn.example.com/avatar.png',
          },
          createdAt: '2026-07-06T00:00:00.000Z',
          updatedAt: '2026-07-06T00:00:00.000Z',
        }),
        'utf8',
      ),
    );

    const loaded = await loadCanopyCloudAccount();
    expect(loaded?.account?.image).toBe('https://cdn.example.com/avatar.png');
  });

  it('drops the account image when it is absent or not a string', async () => {
    invalidateCanopyCloudAccountCache();
    mockedReadFile.mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          apiKey: 'csk_no_image',
          capabilities: ['portal-v1'],
          account: { ...account, image: 42 },
          createdAt: '2026-07-06T00:00:00.000Z',
          updatedAt: '2026-07-06T00:00:00.000Z',
        }),
        'utf8',
      ),
    );

    const loaded = await loadCanopyCloudAccount();
    expect(loaded?.account).not.toHaveProperty('image');
  });

  it('drops the account image when it is an empty or whitespace-only string', async () => {
    invalidateCanopyCloudAccountCache();
    mockedReadFile.mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          apiKey: 'csk_blank_image',
          capabilities: ['portal-v1'],
          account: { ...account, image: '   ' },
          createdAt: '2026-07-06T00:00:00.000Z',
          updatedAt: '2026-07-06T00:00:00.000Z',
        }),
        'utf8',
      ),
    );

    const loaded = await loadCanopyCloudAccount();
    expect(loaded?.account).not.toHaveProperty('image');
  });

  it('does not announce a cleared account after filesystem refusal', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeCanopyCloudAccountChanges(listener);
    mockedRm.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    );
    try {
      await expect(clearCanopyCloudAccount()).rejects.toMatchObject({
        code: 'EACCES',
      });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('retains the canonical account and notification state when legacy deletion is refused', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeCanopyCloudAccountChanges(listener);
    mockedRm.mockImplementation((path) => {
      if (path === '/mock/userData/secure/canopy-cloud-account.enc') {
        return Promise.reject(
          Object.assign(new Error('denied'), { code: 'EACCES' }),
        );
      }
      return Promise.resolve();
    });
    try {
      await expect(clearCanopyCloudAccount()).rejects.toMatchObject({
        code: 'EACCES',
      });
      expect(mockedRm).toHaveBeenCalledWith(
        '/mock/userData/secure/canopy-cloud-account.enc',
        { force: true },
      );
      expect(mockedRm).not.toHaveBeenCalledWith(
        '/mock/userData/canopy-cloud-account.enc',
        { force: true },
      );
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('clears the encrypted account file and cache', async () => {
    await clearCanopyCloudAccount();

    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/userData/canopy-cloud-account.enc',
      { force: true },
    );
    await expect(loadCanopyCloudAccount()).resolves.toBeNull();
  });

  it('notifies subscribers after account saves and clears', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeCanopyCloudAccountChanges(listener);

    const saved = await saveCanopyCloudAccount({
      apiKey: 'csk_oauth',
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: [],
      account,
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
    });
    await clearCanopyCloudAccount();

    expect(listener).toHaveBeenNthCalledWith(1, saved);
    expect(listener).toHaveBeenNthCalledWith(2, null);

    unsubscribe();
    await clearCanopyCloudAccount();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('logs primary encrypted account file removal failures', async () => {
    mockedRm.mockResolvedValueOnce(undefined).mockRejectedValueOnce(
      Object.assign(new Error('denied at /Users/private/account.enc'), {
        code: 'EACCES',
      }),
    );

    await expect(clearCanopyCloudAccount()).rejects.toMatchObject({
      code: 'EACCES',
    });

    expect(mockLogMainProcessWarn).toHaveBeenCalledWith(
      '[canopy-cloud-account-store] Failed to remove account file:',
      { reason: 'Error' },
    );
    expect(JSON.stringify(mockLogMainProcessWarn.mock.calls)).not.toContain(
      '/Users/private',
    );
    expect(mockedRm).toHaveBeenNthCalledWith(
      1,
      '/mock/userData/secure/canopy-cloud-account.enc',
      { force: true },
    );
    expect(mockedRm).toHaveBeenNthCalledWith(
      2,
      '/mock/userData/canopy-cloud-account.enc',
      { force: true },
    );
  });
});
