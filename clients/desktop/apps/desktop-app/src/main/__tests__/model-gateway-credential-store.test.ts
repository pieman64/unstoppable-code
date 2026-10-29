jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn((): Promise<void> => Promise.resolve()),
  readFile: jest.fn(),
  rm: jest.fn((): Promise<void> => Promise.resolve()),
}));
jest.mock('../lib/atomic-file', () => ({ writeFileAtomically: jest.fn() }));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getModelGatewayCredentialStorePath: (): string => '/mock/model-gateway.json',
  getInternalLegacySharedModelGatewayCredentialStorePath: (): string | null =>
    mockSharedLegacyPath,
  getLegacyModelGatewayCredentialStorePath: (): string =>
    '/legacy/model-gateway.json',
}));

const mockReadCanopyCloudAccountWithStatus = jest.fn<Promise<unknown>, []>();
const mockLoadCanopyCloudAccount = jest.fn<Promise<unknown>, []>();
jest.mock('../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: (): Promise<unknown> =>
    mockReadCanopyCloudAccountWithStatus(),
}));

interface MockSafeStorage {
  backend: string;
  available: boolean;
  isEncryptionAvailable: jest.Mock<boolean, []>;
  encryptString: jest.Mock<Buffer, [string]>;
  decryptString: jest.Mock<string, [Buffer]>;
}

const storage: MockSafeStorage = {
  backend: 'gnome_libsecret',
  available: true,
  isEncryptionAvailable: jest.fn(() => storage.available),
  encryptString: jest.fn((value: string) => Buffer.from(`encrypted:${value}`)),
  decryptString: jest.fn((value: Buffer) =>
    value.toString('utf8').replace(/^encrypted:/, ''),
  ),
};
jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): string => 'linux',
}));
jest.mock('electron', () => ({
  app: { isReady: (): boolean => true },
  safeStorage: {
    isEncryptionAvailable: (): boolean => storage.isEncryptionAvailable(),
    getSelectedStorageBackend: (): string => storage.backend,
    encryptString: (text: string): Buffer => storage.encryptString(text),
    decryptString: (data: Buffer): string => storage.decryptString(data),
  },
}));

import { readFile, rm } from 'node:fs/promises';
import { writeFileAtomically } from '../lib/atomic-file';
import {
  GatewayCredentialStorageUnavailableError,
  loadModelGatewayCredential,
  markModelGatewayCredentialRejected,
  resetModelGatewayCredentialStoreForTests,
  saveModelGatewayCredential,
} from '../lib/model-gateway-credential-store';

let payload: string | null;
let mockSharedLegacyPath: string | null = null;
const otherFiles = new Map<string, Buffer>();
const currentPath = '/mock/model-gateway.json';
const legacyPath = '/legacy/model-gateway.json';
const sharedLegacyPath = '/shared-legacy/model-gateway.json';

// Entirely synthetic ownerless data; preserve whitespace and unknown fields.
const versionOneBytes = Buffer.from(
  ' { "version": 1, "records": { "org-1": { "encryptedApiKeyBase64": "ZmFrZQ==", "unknown": "retain me" } }, "extra": true }\n',
);

function backups(): Array<[string, Buffer]> {
  const retained: Array<[string, Buffer]> = [];
  otherFiles.forEach((bytes: Buffer, path: string) => {
    if (path.startsWith(`${currentPath}.v1-backup-`))
      retained.push([path, bytes]);
  });
  return retained;
}

function seedVersionOne(sourcePath: string): void {
  if (sourcePath === currentPath) payload = versionOneBytes.toString('utf8');
  else otherFiles.set(sourcePath, Buffer.from(versionOneBytes));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(writeFileAtomically).mockReset();
  resetModelGatewayCredentialStoreForTests();
  storage.available = true;
  storage.backend = 'gnome_libsecret';
  mockReadCanopyCloudAccountWithStatus.mockImplementation(async () => ({
    status: 'ok',
    entry: await mockLoadCanopyCloudAccount(),
  }));
  payload = null;
  mockSharedLegacyPath = null;
  otherFiles.clear();
  mockLoadCanopyCloudAccount.mockResolvedValue({
    account: { id: 'account-1' },
    enforcedSettings: [
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        policies: [{ kind: 'model-gateway' }],
      },
    ],
  });
  jest.mocked(readFile).mockImplementation((path, options) => {
    if (typeof path !== 'string')
      return Promise.reject(new Error('Expected a synthetic string path'));
    let bytes = otherFiles.get(path);
    if (path === currentPath && payload !== null) bytes = Buffer.from(payload);
    if (!bytes)
      return Promise.reject(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    return Promise.resolve(options === 'utf8' ? bytes.toString('utf8') : bytes);
  });
  jest
    .mocked(writeFileAtomically)
    .mockImplementation((path, contents, options) => {
      if (
        options?.overwrite === false &&
        (path === currentPath ? payload !== null : otherFiles.has(path))
      )
        return Promise.reject(
          Object.assign(new Error('exists'), { code: 'EEXIST' }),
        );
      if (path === currentPath) payload = String(contents);
      else otherFiles.set(path, Buffer.from(contents));
      return Promise.resolve();
    });
  jest.mocked(rm).mockImplementation((path) => {
    otherFiles.delete(String(path));
    return Promise.resolve();
  });
});

it('quarantines a saved key from another Canopy account on the same device', async () => {
  await saveModelGatewayCredential({
    organizationId: 'org-1',
    apiKey: 'sk-account-one',
    baseUrlAtSave: 'https://gateway.acme.test',
  });

  mockLoadCanopyCloudAccount.mockResolvedValue({
    account: { id: 'account-2' },
    enforcedSettings: [
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        policies: [{ kind: 'model-gateway' }],
      },
    ],
  });
  await expect(loadModelGatewayCredential('org-1')).resolves.toBeNull();

  mockLoadCanopyCloudAccount.mockResolvedValue({
    account: { id: 'account-1' },
    enforcedSettings: [
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        policies: [{ kind: 'model-gateway' }],
      },
    ],
  });
  await expect(loadModelGatewayCredential('org-1')).resolves.toMatchObject({
    apiKey: 'sk-account-one',
  });
});

it('refuses access when the organization is not in the current account policy', async () => {
  mockLoadCanopyCloudAccount.mockResolvedValue({
    account: { id: 'account-1' },
    enforcedSettings: [],
  });

  await expect(loadModelGatewayCredential('org-1')).resolves.toBeNull();
  await expect(
    saveModelGatewayCredential({
      organizationId: 'org-1',
      apiKey: 'sk-secret',
      baseUrlAtSave: 'https://gateway.acme.test',
    }),
  ).rejects.toThrow('current account');
});

it('round-trips a key encrypted while leaving routing metadata readable', async () => {
  await saveModelGatewayCredential({
    organizationId: 'org-1',
    apiKey: 'sk-secret',
    baseUrlAtSave: 'https://gateway.acme.test',
    lastValidatedAt: '2026-09-08T00:00:00.000Z',
  });

  expect(payload).toContain('org-1');
  expect(payload).toContain('https://gateway.acme.test');
  expect(payload).not.toContain('sk-secret"');
  await expect(loadModelGatewayCredential('org-1')).resolves.toMatchObject({
    apiKey: 'sk-secret',
    baseUrlAtSave: 'https://gateway.acme.test',
  });
});

it('persists a runtime gateway rejection without replacing the saved key', async () => {
  await saveModelGatewayCredential({
    organizationId: 'org-1',
    apiKey: 'sk-secret',
    baseUrlAtSave: 'https://gateway.acme.test',
  });

  await expect(
    markModelGatewayCredentialRejected('org-1', 'Gateway returned HTTP 401.'),
  ).resolves.toBe(true);
  await expect(loadModelGatewayCredential('org-1')).resolves.toMatchObject({
    apiKey: 'sk-secret',
    baseUrlAtSave: 'https://gateway.acme.test',
    lastError: 'Gateway returned HTTP 401.',
  });
});

it('ignores a late runtime rejection from an older credential generation', async () => {
  await saveModelGatewayCredential({
    organizationId: 'org-1',
    apiKey: 'sk-current',
    baseUrlAtSave: 'https://gateway.acme.test',
  });

  await expect(
    markModelGatewayCredentialRejected(
      'org-1',
      'Gateway returned HTTP 401.',
      'older-generation',
    ),
  ).resolves.toBe(false);
  await expect(loadModelGatewayCredential('org-1')).resolves.toMatchObject({
    apiKey: 'sk-current',
    lastError: undefined,
  });
});

it('throws instead of writing plaintext when secure storage is unavailable', async () => {
  storage.available = false;
  await expect(
    saveModelGatewayCredential({
      organizationId: 'org-1',
      apiKey: 'sk-secret',
      baseUrlAtSave: 'https://gateway.acme.test',
    }),
  ).rejects.toBeInstanceOf(GatewayCredentialStorageUnavailableError);
  expect(writeFileAtomically).not.toHaveBeenCalled();
});

it('does not treat a corrupt current store as empty', async () => {
  payload = '{not-json';

  await expect(loadModelGatewayCredential('org-1')).rejects.toThrow();
  expect(writeFileAtomically).not.toHaveBeenCalled();
});

it('rejects decrypt failure and retains the key for recovery', async () => {
  await saveModelGatewayCredential({
    organizationId: 'org-1',
    apiKey: 'old',
    baseUrlAtSave: 'https://gateway.test',
  });
  const before = payload;
  jest.mocked(writeFileAtomically).mockClear();
  storage.decryptString.mockImplementationOnce(() => {
    throw new Error('native diagnostic');
  });
  await expect(loadModelGatewayCredential('org-1')).rejects.toThrow();
  expect(payload).toBe(before);
  expect(writeFileAtomically).not.toHaveBeenCalled();
  await expect(loadModelGatewayCredential('org-1')).resolves.toMatchObject({
    apiKey: 'old',
  });
});

it.each(['{invalid', JSON.stringify({ version: 99, records: {} })])(
  'retains unreadable gateway files on mutation: %s',
  async (raw) => {
    payload = raw;
    await expect(
      saveModelGatewayCredential({
        organizationId: 'org-1',
        apiKey: 'new',
        baseUrlAtSave: 'https://gateway.test',
      }),
    ).rejects.toThrow();
    expect(payload).toBe(raw);
    expect(writeFileAtomically).not.toHaveBeenCalled();
  },
);

it('does not overwrite a gateway file after I/O failure', async () => {
  jest
    .mocked(readFile)
    .mockRejectedValueOnce(
      Object.assign(new Error('cannot read'), { code: 'EACCES' }),
    );
  await expect(
    saveModelGatewayCredential({
      organizationId: 'org-1',
      apiKey: 'new',
      baseUrlAtSave: 'https://gateway.test',
    }),
  ).rejects.toThrow('cannot read');
  expect(writeFileAtomically).not.toHaveBeenCalled();
});

it('keeps ownerless version-1 reads isolated without rewriting the old file', async () => {
  payload = JSON.stringify({ version: 1, records: { old: 'ownerless' } });
  const before = payload;
  await expect(loadModelGatewayCredential('org-1')).resolves.toBeNull();
  expect(payload).toBe(before);
  expect(writeFileAtomically).not.toHaveBeenCalled();
});

it('preserves cloud-owner storage failures rather than treating them as missing credentials', async () => {
  const secureStorageFailure = {
    version: 1,
    code: 'SECURE_STORAGE_DECRYPT_FAILED',
    operation: 'read',
    state: 'locked',
    backend: 'gnome_libsecret',
    retryable: true,
  } as const;
  const error = Object.assign(new Error('Secure storage decryption failed'), {
    secureStorageFailure,
  });
  mockReadCanopyCloudAccountWithStatus.mockResolvedValue({
    status: 'unavailable',
    error,
    secureStorageFailure,
  });
  await expect(loadModelGatewayCredential('org-1')).rejects.toMatchObject({
    secureStorageFailure,
  });
  expect(writeFileAtomically).not.toHaveBeenCalled();
});

it.each(['unknown', 'gnome_libsecret'])(
  'allows explicit key removal without encrypting on %s',
  async (backend) => {
    await saveModelGatewayCredential({
      organizationId: 'org-1',
      apiKey: 'old',
      baseUrlAtSave: 'https://gateway.test',
    });
    storage.encryptString.mockClear();
    storage.backend = backend;
    storage.available = false;
    await expect(
      saveModelGatewayCredential({
        organizationId: 'org-1',
        apiKey: '  ',
        baseUrlAtSave: 'https://gateway.test',
      }),
    ).resolves.toBeUndefined();
    expect(storage.encryptString).not.toHaveBeenCalled();
    await expect(loadModelGatewayCredential('org-1')).resolves.toBeNull();
  },
);

describe('ownerless version-1 recovery', () => {
  it.each([currentPath, legacyPath, sharedLegacyPath])(
    'keeps a runtime rejection read-only for ownerless v1 at %s',
    async (sourcePath) => {
      if (sourcePath === sharedLegacyPath)
        mockSharedLegacyPath = sharedLegacyPath;
      seedVersionOne(sourcePath);
      await expect(
        markModelGatewayCredentialRejected('org-1', 'Synthetic rejection'),
      ).resolves.toBe(false);
      expect(backups()).toEqual([]);
      expect(writeFileAtomically).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
      if (sourcePath === currentPath)
        expect(payload).toBe(versionOneBytes.toString('utf8'));
      else expect(otherFiles.get(sourcePath)).toEqual(versionOneBytes);
    },
  );
  it.each([
    [currentPath, 'save'],
    [currentPath, 'clear'],
    [legacyPath, 'save'],
    [legacyPath, 'clear'],
    [sharedLegacyPath, 'save'],
    [sharedLegacyPath, 'clear'],
  ])(
    'backs up %s losslessly before %s and retains the backup',
    async (sourcePath, operation) => {
      if (sourcePath === sharedLegacyPath)
        mockSharedLegacyPath = sharedLegacyPath;
      seedVersionOne(sourcePath);
      await expect(loadModelGatewayCredential('org-1')).resolves.toBeNull();
      expect(backups()).toEqual([]);
      expect(writeFileAtomically).not.toHaveBeenCalled();
      storage.decryptString.mockClear();

      await expect(
        saveModelGatewayCredential({
          organizationId: 'org-1',
          apiKey: operation === 'save' ? 'synthetic-new-key' : '  ',
          baseUrlAtSave: 'https://gateway.example.test',
        }),
      ).resolves.toBeUndefined();

      expect(backups()).toHaveLength(1);
      const backup = backups()[0];
      expect(backup?.[1]).toEqual(versionOneBytes);
      expect(writeFileAtomically).toHaveBeenNthCalledWith(
        1,
        expect.stringMatching(/^\/mock\/model-gateway\.json\.v1-backup-/),
        versionOneBytes,
        { mode: 0o600, overwrite: false, durable: true },
      );
      expect(writeFileAtomically).toHaveBeenNthCalledWith(
        2,
        currentPath,
        expect.any(String),
        { mode: 0o600, encoding: 'utf8' },
      );
      expect(payload).toContain('"version": 2');
      expect(payload).not.toContain('ownerlessLegacy');
      expect(payload).not.toContain('retain me');
      expect(storage.decryptString).not.toHaveBeenCalled();
      if (operation === 'save') {
        await expect(
          loadModelGatewayCredential('org-1'),
        ).resolves.toMatchObject({
          apiKey: 'synthetic-new-key',
        });
      } else {
        await expect(loadModelGatewayCredential('org-1')).resolves.toBeNull();
        expect(storage.encryptString).not.toHaveBeenCalled();
      }
      if (sourcePath === sharedLegacyPath)
        expect(otherFiles.get(sharedLegacyPath)).toEqual(versionOneBytes);

      // Later mutations never rewrite or remove the recovery copy.
      await saveModelGatewayCredential({
        organizationId: 'org-1',
        apiKey: '',
        baseUrlAtSave: 'https://gateway.example.test',
      });
      expect(backups()).toEqual([backup]);
      for (const [removedPath] of jest.mocked(rm).mock.calls)
        expect(String(removedPath)).not.toContain('.v1-backup-');
    },
  );

  it.each(['save', 'clear'])(
    'blocks %s on backup failure, then permits retry',
    async (operation) => {
      seedVersionOne(currentPath);
      jest
        .mocked(writeFileAtomically)
        .mockRejectedValueOnce(new Error('backup denied'));
      const input = {
        organizationId: 'org-1',
        apiKey: operation === 'save' ? 'synthetic-new-key' : '',
        baseUrlAtSave: 'https://gateway.example.test',
      };
      await expect(saveModelGatewayCredential(input)).rejects.toThrow(
        'backup denied',
      );
      expect(payload).toBe(versionOneBytes.toString('utf8'));
      expect(writeFileAtomically).toHaveBeenCalledTimes(1);
      expect(writeFileAtomically).not.toHaveBeenCalledWith(
        currentPath,
        expect.anything(),
        expect.anything(),
      );
      expect(rm).not.toHaveBeenCalled();
      expect(backups()).toEqual([]);

      await expect(saveModelGatewayCredential(input)).resolves.toBeUndefined();
      expect(backups()).toHaveLength(1);
      expect(backups()[0]?.[1]).toEqual(versionOneBytes);
    },
  );

  it('preserves original bytes rather than a UTF-8 reserialization', async () => {
    const original = Buffer.concat([
      Buffer.from('{"version":1,"unknown":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]);
    otherFiles.set(legacyPath, original);
    await saveModelGatewayCredential({
      organizationId: 'org-1',
      apiKey: '',
      baseUrlAtSave: 'https://gateway.example.test',
    });
    expect(backups()[0]?.[1]).toEqual(original);
  });

  it('retains earlier backups when replacing another v1 file', async () => {
    const previousPath = `${currentPath}.v1-backup-earlier`;
    const previousBytes = Buffer.from('synthetic earlier backup');
    otherFiles.set(previousPath, previousBytes);
    seedVersionOne(currentPath);
    await saveModelGatewayCredential({
      organizationId: 'org-1',
      apiKey: '',
      baseUrlAtSave: 'https://gateway.example.test',
    });
    expect(otherFiles.get(previousPath)).toEqual(previousBytes);
    expect(backups()).toHaveLength(2);
    expect(backups().some(([, bytes]) => bytes.equals(versionOneBytes))).toBe(
      true,
    );
  });

  it('retains the backup and original when the v2 write fails', async () => {
    seedVersionOne(currentPath);
    const write = jest.mocked(writeFileAtomically).getMockImplementation();
    jest
      .mocked(writeFileAtomically)
      .mockImplementation((path, bytes, options) => {
        if (path === currentPath) return Promise.reject(new Error('v2 denied'));
        if (!write) throw new Error('Missing write fixture');
        return write(path, bytes, options);
      });
    await expect(
      saveModelGatewayCredential({
        organizationId: 'org-1',
        apiKey: 'synthetic-new-key',
        baseUrlAtSave: 'https://gateway.example.test',
      }),
    ).rejects.toThrow('v2 denied');
    expect(payload).toBe(versionOneBytes.toString('utf8'));
    expect(backups()).toHaveLength(1);
    expect(backups()[0]?.[1]).toEqual(versionOneBytes);
    expect(rm).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'gnome_libsecret'])(
    'permits backed-up clear without encryption on %s',
    async (backend) => {
      seedVersionOne(currentPath);
      storage.backend = backend;
      storage.available = false;
      await expect(
        saveModelGatewayCredential({
          organizationId: 'org-1',
          apiKey: '',
          baseUrlAtSave: 'https://gateway.example.test',
        }),
      ).resolves.toBeUndefined();
      expect(backups()[0]?.[1]).toEqual(versionOneBytes);
      expect(storage.encryptString).not.toHaveBeenCalled();
      expect(storage.decryptString).not.toHaveBeenCalled();
    },
  );

  it('does not back up or replace v1 without current owner authorization', async () => {
    seedVersionOne(currentPath);
    mockLoadCanopyCloudAccount.mockResolvedValue({
      account: { id: 'account-1' },
      enforcedSettings: [],
    });
    await expect(
      saveModelGatewayCredential({
        organizationId: 'org-1',
        apiKey: '',
        baseUrlAtSave: 'https://gateway.example.test',
      }),
    ).rejects.toThrow('current account');
    expect(payload).toBe(versionOneBytes.toString('utf8'));
    expect(writeFileAtomically).not.toHaveBeenCalled();
  });

  it('does not back up or replace v1 when secure storage refuses a new key', async () => {
    seedVersionOne(currentPath);
    storage.backend = 'unknown';
    storage.available = false;
    await expect(
      saveModelGatewayCredential({
        organizationId: 'org-1',
        apiKey: 'synthetic-new-key',
        baseUrlAtSave: 'https://gateway.example.test',
      }),
    ).rejects.toBeInstanceOf(GatewayCredentialStorageUnavailableError);
    expect(payload).toBe(versionOneBytes.toString('utf8'));
    expect(writeFileAtomically).not.toHaveBeenCalled();
  });

  it('serializes backup and replacement before the next mutation reads', async () => {
    seedVersionOne(currentPath);
    const write = jest.mocked(writeFileAtomically).getMockImplementation();
    let releaseBackup: () => void = () => {
      throw new Error('Backup not started');
    };
    let backupStarted: () => void = () => {
      throw new Error('Missing start fixture');
    };
    const started = new Promise<void>((resolve) => {
      backupStarted = resolve;
    });
    jest
      .mocked(writeFileAtomically)
      .mockImplementationOnce(async (path, bytes, options) => {
        backupStarted();
        await new Promise<void>((resolve) => {
          releaseBackup = resolve;
        });
        if (!write) throw new Error('Missing write fixture');
        await write(path, bytes, options);
      });
    const first = saveModelGatewayCredential({
      organizationId: 'org-1',
      apiKey: 'synthetic-first',
      baseUrlAtSave: 'https://gateway.example.test',
    });
    // Attach rejection handling immediately, including during the red run.
    const completed = expect(
      Promise.all([
        first,
        saveModelGatewayCredential({
          organizationId: 'org-1',
          apiKey: 'synthetic-second',
          baseUrlAtSave: 'https://gateway.example.test',
        }),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    await Promise.race([started, completed]);
    expect(writeFileAtomically).toHaveBeenCalledTimes(1);
    expect(
      jest.mocked(readFile).mock.calls.filter(([path]) => path === currentPath),
    ).toHaveLength(1);
    expect(payload).toBe(versionOneBytes.toString('utf8'));
    releaseBackup();
    await completed;
    expect(backups()).toHaveLength(1);
    await expect(loadModelGatewayCredential('org-1')).resolves.toMatchObject({
      apiKey: 'synthetic-second',
    });
  });
});

it('ignores wrong-identity internal shared gateway data without altering the source', async () => {
  mockSharedLegacyPath = sharedLegacyPath;
  const foreignBytes = Buffer.from(
    JSON.stringify({
      version: 2,
      records: {
        '["foreign-account","org-1"]': {
          accountId: 'foreign-account',
          organizationId: 'org-1',
          encryptedApiKeyBase64: Buffer.from(
            'synthetic-foreign-ciphertext',
          ).toString('base64'),
          baseUrlAtSave: 'https://gateway.example.test',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      },
    }),
  );
  otherFiles.set(sharedLegacyPath, foreignBytes);
  storage.decryptString.mockImplementationOnce(() => {
    throw new Error('synthetic wrong identity');
  });
  await expect(loadModelGatewayCredential('org-1')).resolves.toBeNull();
  expect(otherFiles.get(sharedLegacyPath)).toEqual(foreignBytes);
  expect(payload).toBeNull();
  expect(writeFileAtomically).not.toHaveBeenCalled();
  expect(rm).not.toHaveBeenCalled();
});
