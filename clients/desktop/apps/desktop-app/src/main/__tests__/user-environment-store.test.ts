jest.mock('node:fs/promises', () => ({
  chmod: jest.fn(() => Promise.resolve()),
  mkdir: jest.fn(() => Promise.resolve()),
  readFile: jest.fn(),
  unlink: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/atomic-file', () => ({
  writeFileAtomically: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getEnvironmentConfigFilePath: jest.fn(() => '/mock/environments.json'),
  getInternalLegacySharedEnvironmentConfigFilePath: jest.fn(() => null),
  getLegacyEnvironmentConfigFilePath: jest.fn(
    () => '/mock/userData/environments.json',
  ),
  getUserEnvironmentFilePath: jest.fn(() => '/mock/user-environment.json'),
}));

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
    (text: string): Buffer => Buffer.from(`enc:${text}`, 'utf8'),
  ),
  decryptString: jest.fn((encrypted: Buffer): string =>
    encrypted.toString('utf8').replace(/^enc:/, ''),
  ),
};

let mockBackend = 'gnome_libsecret';
const mockSecretServiceState = jest.fn<'secure' | 'unavailable' | 'locked', []>(
  () => 'secure',
);
jest.mock('../lib/linux-secret-service', () => ({
  getLinuxSecretServiceState: (): 'secure' | 'unavailable' | 'locked' =>
    mockSecretServiceState(),
}));
jest.mock('../lib/linux-safe-storage-recovery', () => ({
  probeLinuxSafeStorageRecovery: (): boolean => false,
}));
jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): 'linux' => 'linux',
}));
jest.mock('electron', () => ({
  app: { isReady: (): boolean => true },
  safeStorage: {
    encryptionAvailable: true,
    get isEncryptionAvailable(): typeof safeStorageMock.isEncryptionAvailable {
      return safeStorageMock.isEncryptionAvailable;
    },
    get encryptString(): typeof safeStorageMock.encryptString {
      return safeStorageMock.encryptString;
    },
    get decryptString(): typeof safeStorageMock.decryptString {
      return safeStorageMock.decryptString;
    },
    getSelectedStorageBackend: (): string => mockBackend,
  },
}));

import { chmod, mkdir, readFile, unlink } from 'node:fs/promises';
import { writeFileAtomically } from '../lib/atomic-file';
import { SafeStorageWriteError } from '../lib/safe-storage';
import { getSecureStorageFailure } from '../lib/secure-storage-policy';
import { getInternalLegacySharedEnvironmentConfigFilePath } from '@canopy/desktop-shared/canopy-paths';
import type {
  EnvironmentConfigData,
  UserEnvironmentData,
} from '@canopy/desktop-shared/types';
import {
  createDefaultEnvironmentConfig,
  normalizeUserEnvironmentEntries,
} from '@canopy/desktop-shared/lib/user-environment';
import {
  readEnvironmentConfig,
  readEnvironmentConfigView,
  writeEnvironmentConfig,
} from '../lib/user-environment-store';
import { storedSecretRef } from '../lib/stored-secrets';

const OVERALL = 'default-overall';

// The Overall environment through the version-2 API, as the retired
// version-1 IPC wrappers exposed it.
async function readUserEnvironment(): Promise<{
  data: UserEnvironmentData;
  encryptionAvailable: boolean;
}> {
  const result = await readEnvironmentConfig();
  const overall = result.data.environments.find(
    (environment) => environment.id === OVERALL,
  );
  return {
    data: {
      uiMode: overall?.uiMode ?? 'key-value',
      variables: overall?.variables ?? [],
    },
    encryptionAvailable: result.encryptionAvailable,
  };
}

function withOverall(
  data: EnvironmentConfigData,
  next: UserEnvironmentData,
): EnvironmentConfigData {
  return {
    ...data,
    environments: data.environments.map((environment) =>
      environment.id === OVERALL
        ? {
            ...environment,
            uiMode: next.uiMode,
            variables: normalizeUserEnvironmentEntries(next.variables),
          }
        : environment,
    ),
  };
}

async function writeUserEnvironment(
  next: UserEnvironmentData,
): Promise<{ encryptionAvailable: boolean }> {
  const { data } = await readEnvironmentConfig();
  return writeEnvironmentConfig(withOverall(data, next));
}

const readFileMock = jest.mocked(readFile);
const writeFileMock = jest.mocked(writeFileAtomically);
const chmodMock = jest.mocked(chmod);
const mkdirMock = jest.mocked(mkdir);
const unlinkMock = jest.mocked(unlink);
const internalLegacyPathMock = jest.mocked(
  getInternalLegacySharedEnvironmentConfigFilePath,
);

let environmentPayload: string | null = null;
let legacyPayload: string | null = null;
let internalLegacyPayload: string | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  safeStorageMock.encryptionAvailable = true;
  mockBackend = 'gnome_libsecret';
  mockSecretServiceState.mockReturnValue('secure');
  safeStorageMock.isEncryptionAvailable.mockImplementation(
    () => safeStorageMock.encryptionAvailable,
  );
  safeStorageMock.decryptString.mockImplementation((encrypted) =>
    encrypted.toString('utf8').replace(/^enc:/, ''),
  );
  safeStorageMock.encryptString.mockImplementation(
    (text: string): Buffer => Buffer.from(`enc:${text}`, 'utf8'),
  );
  environmentPayload = null;
  legacyPayload = null;
  internalLegacyPayload = null;
  internalLegacyPathMock.mockReturnValue(null);
  readFileMock.mockImplementation((path) => {
    const payload =
      path === '/mock/environments.json'
        ? environmentPayload
        : path === '/mock/stable/environments.json'
          ? internalLegacyPayload
          : legacyPayload;
    if (payload === null) {
      const error: NodeJS.ErrnoException = new Error('ENOENT');
      error.code = 'ENOENT';
      return Promise.reject(error);
    }
    return Promise.resolve(payload);
  });
  writeFileMock.mockImplementation(
    (path: string, content: string | Uint8Array): Promise<void> => {
      if (path === '/mock/environments.json') {
        environmentPayload = typeof content === 'string' ? content : '';
      }
      return Promise.resolve();
    },
  );
  unlinkMock.mockImplementation((path) => {
    if (path === '/mock/userData/environments.json') {
      legacyPayload = null;
    }
    return Promise.resolve();
  });
});

describe('user-environment-store', () => {
  it('re-encrypts a readable former shared production environment file', async () => {
    internalLegacyPathMock.mockReturnValue('/mock/stable/environments.json');
    safeStorageMock.encryptString.mockImplementation(
      (text: string): Buffer => Buffer.from(`internal:${text}`, 'utf8'),
    );
    internalLegacyPayload = JSON.stringify({
      version: 2,
      data: {
        environments: [
          {
            id: 'default-overall',
            name: 'Overall',
            parentId: null,
            isDefault: true,
            defaultKind: 'overall',
            uiMode: 'key-value',
            encryptedVariables: Buffer.from(
              'enc:[{"key":"SECRET","value":"legacy"}]',
            ).toString('base64'),
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        globalRuntimes: {
          canopy: 'default-canopy',
          agent: 'default-agent',
          pipeline: 'default-pipeline',
        },
        workspaceAssignments: [],
      },
    });

    const result = await readEnvironmentConfig();

    expect(result.data.environments[0]?.variables).toEqual([
      { key: 'SECRET', value: 'legacy' },
    ]);
    expect(writeFileMock).toHaveBeenCalledWith(
      '/mock/environments.json',
      expect.any(String),
      { encoding: 'utf8', mode: 0o600, overwrite: false },
    );
    expect(environmentPayload).toContain(
      Buffer.from('internal:[{"key":"SECRET","value":"legacy"}]').toString(
        'base64',
      ),
    );
    expect(environmentPayload).not.toContain(
      Buffer.from('enc:[{"key":"SECRET","value":"legacy"}]').toString('base64'),
    );
    expect(internalLegacyPayload).not.toBeNull();
  });

  it.each(['invalid-data', 'native-decrypt'])(
    'skips a former shared environment file with %s variables',
    async (failure) => {
      internalLegacyPathMock.mockReturnValue('/mock/stable/environments.json');
      internalLegacyPayload = JSON.stringify({
        version: 2,
        data: {
          environments: [
            {
              id: 'default-overall',
              name: 'Overall',
              parentId: null,
              isDefault: true,
              defaultKind: 'overall',
              uiMode: 'key-value',
              encryptedVariables: Buffer.from('foreign').toString('base64'),
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          globalRuntimes: {
            canopy: 'default-canopy',
            agent: 'default-agent',
            pipeline: 'default-pipeline',
          },
          workspaceAssignments: [],
        },
      });

      if (failure === 'native-decrypt') {
        safeStorageMock.decryptString.mockImplementation(() => {
          throw new Error('wrong identity');
        });
      }
      const result = await readEnvironmentConfig();

      expect(result.data.environments[0]?.variables).toEqual([]);
      expect(writeFileMock).not.toHaveBeenCalled();
      expect(internalLegacyPayload).not.toBeNull();
    },
  );

  it('retries an encrypted former shared environment file when secure storage becomes available', async () => {
    internalLegacyPathMock.mockReturnValue('/mock/stable/environments.json');
    internalLegacyPayload = JSON.stringify({
      version: 2,
      data: {
        environments: [
          {
            id: 'default-overall',
            name: 'Overall',
            parentId: null,
            isDefault: true,
            defaultKind: 'overall',
            uiMode: 'key-value',
            encryptedVariables: Buffer.from(
              'enc:[{"key":"SECRET","value":"legacy"}]',
            ).toString('base64'),
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        globalRuntimes: {
          canopy: 'default-canopy',
          agent: 'default-agent',
          pipeline: 'default-pipeline',
        },
        workspaceAssignments: [],
      },
    });
    safeStorageMock.encryptionAvailable = false;

    await expect(readEnvironmentConfig()).rejects.toThrow(
      'OS encryption unavailable',
    );
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(internalLegacyPayload).not.toBeNull();

    safeStorageMock.encryptionAvailable = true;
    const result = await readEnvironmentConfig();

    expect(result.data.environments[0]?.variables).toEqual([
      { key: 'SECRET', value: 'legacy' },
    ]);
    expect(writeFileMock).toHaveBeenCalledWith(
      '/mock/environments.json',
      expect.any(String),
      { encoding: 'utf8', mode: 0o600, overwrite: false },
    );
    expect(internalLegacyPayload).not.toBeNull();
  });

  it('returns empty data when the file does not exist', async () => {
    const result = await readUserEnvironment();
    expect(result.data).toEqual({ uiMode: 'key-value', variables: [] });
    expect(result.encryptionAvailable).toBe(true);
  });

  it('writes encrypted variables when safeStorage is available', async () => {
    const result = await writeUserEnvironment({
      uiMode: 'key-value',
      variables: [
        { key: 'FOO', value: 'bar' },
        { key: 'API_TOKEN', value: 'sekret' },
      ],
    });

    expect(result.encryptionAvailable).toBe(true);
    expect(safeStorageMock.encryptString).toHaveBeenCalledTimes(4);
    expect(environmentPayload).not.toContain('sekret');
    const parsed = JSON.parse(environmentPayload ?? '{}') as {
      version: unknown;
      data: { environments: Array<Record<string, unknown>> };
    };
    expect(parsed.version).toBe(2);
    const overall = parsed.data.environments.find(
      (environment) => environment.id === 'default-overall',
    );
    expect(overall?.uiMode).toBe('key-value');
    expect(typeof overall?.encryptedVariables).toBe('string');
    expect(overall?.plaintextVariables).toBeUndefined();
  });

  it('round-trips encrypted variables via read', async () => {
    await writeUserEnvironment({
      uiMode: 'bulk',
      variables: [{ key: 'TOKEN', value: 'sekret' }],
    });
    const result = await readUserEnvironment();
    expect(result.data).toEqual({
      uiMode: 'bulk',
      variables: [{ key: 'TOKEN', value: 'sekret' }],
    });
    expect(safeStorageMock.decryptString).toHaveBeenCalledTimes(4);
  });

  it('falls back to plaintext when safeStorage is unavailable', async () => {
    safeStorageMock.encryptionAvailable = false;
    const result = await writeUserEnvironment({
      uiMode: 'key-value',
      variables: [{ key: 'FOO', value: 'bar' }],
    });

    expect(result.encryptionAvailable).toBe(false);
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
    const parsed = JSON.parse(environmentPayload ?? '{}') as {
      version: unknown;
      data: { environments: Array<Record<string, unknown>> };
    };
    expect(parsed.version).toBe(2);
    const overall = parsed.data.environments.find(
      (environment) => environment.id === 'default-overall',
    );
    expect(overall?.uiMode).toBe('key-value');
    expect(overall?.plaintextVariables).toEqual([{ key: 'FOO', value: 'bar' }]);
    expect(overall?.encryptedVariables).toBeUndefined();
  });

  it('writes the environment file with restrictive permissions', async () => {
    safeStorageMock.encryptionAvailable = false;
    await writeUserEnvironment({
      uiMode: 'key-value',
      variables: [{ key: 'FOO', value: 'bar' }],
    });

    expect(mkdirMock).toHaveBeenCalledWith('/mock', {
      recursive: true,
      mode: 0o700,
    });
    expect(writeFileMock).toHaveBeenCalledWith(
      '/mock/environments.json',
      expect.any(String),
      { encoding: 'utf8', mode: 0o600 },
    );
    expect(chmodMock).toHaveBeenCalledWith('/mock', 0o700);
    expect(chmodMock).toHaveBeenCalledWith('/mock/environments.json', 0o600);
  });

  it('does not replace the previous environment file when atomic rename fails', async () => {
    environmentPayload = JSON.stringify({
      version: 2,
      data: {
        environments: [],
        globalRuntimes: {
          canopy: 'default-canopy',
          agent: 'default-agent',
          pipeline: 'default-pipeline',
        },
        workspaceAssignments: [],
      },
    });
    const previousPayload = environmentPayload;
    writeFileMock.mockRejectedValueOnce(new Error('rename failed'));

    const next = (await readEnvironmentConfig()).data;
    next.environments = next.environments.map((environment) =>
      environment.id === 'default-overall'
        ? { ...environment, variables: [{ key: 'NEW_VALUE', value: '1' }] }
        : environment,
    );

    await expect(writeEnvironmentConfig(next)).rejects.toThrow('rename failed');
    expect(environmentPayload).toBe(previousPayload);
  });

  it('round-trips plaintext variables via read', async () => {
    safeStorageMock.encryptionAvailable = false;
    await writeUserEnvironment({
      uiMode: 'key-value',
      variables: [{ key: 'FOO', value: 'bar' }],
    });
    const result = await readUserEnvironment();
    expect(result.data).toEqual({
      uiMode: 'key-value',
      variables: [{ key: 'FOO', value: 'bar' }],
    });
    expect(result.encryptionAvailable).toBe(false);
  });

  it('migrates legacy `variables` field on read', async () => {
    legacyPayload = JSON.stringify({
      version: 1,
      data: {
        uiMode: 'key-value',
        variables: [{ key: 'LEGACY', value: '1' }],
      },
    });
    const result = await readUserEnvironment();
    expect(result.data.variables).toEqual([{ key: 'LEGACY', value: '1' }]);
  });

  it('persists migrated legacy version-1 variables without deleting the legacy file', async () => {
    legacyPayload = JSON.stringify({
      version: 1,
      data: {
        uiMode: 'bulk',
        variables: [{ key: 'LEGACY', value: '1' }],
      },
    });

    const result = await readEnvironmentConfig();

    expect(
      result.data.environments.find(
        (environment) => environment.id === 'default-overall',
      )?.variables,
    ).toEqual([{ key: 'LEGACY', value: '1' }]);
    expect(environmentPayload).not.toBeNull();
    expect(writeFileMock).toHaveBeenCalled();
    expect(legacyPayload).not.toBeNull();
  });

  it('removes legacy version-2 environments.json after successful migration', async () => {
    legacyPayload = JSON.stringify({
      version: 2,
      data: {
        environments: [
          {
            id: 'default-overall',
            name: 'Overall',
            parentId: null,
            isDefault: true,
            defaultKind: 'overall',
            uiMode: 'key-value',
            plaintextVariables: [{ key: 'LEGACY_V2', value: '1' }],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        globalRuntimes: {
          canopy: 'default-canopy',
          agent: 'default-agent',
          pipeline: 'default-pipeline',
        },
        workspaceAssignments: [],
      },
    });

    const result = await readEnvironmentConfig();

    expect(
      result.data.environments.find(
        (environment) => environment.id === 'default-overall',
      )?.variables,
    ).toEqual([{ key: 'LEGACY_V2', value: '1' }]);
    expect(environmentPayload).not.toBeNull();
    expect(unlinkMock).toHaveBeenCalledWith('/mock/userData/environments.json');
    expect(legacyPayload).toBeNull();
  });

  it('retries legacy migration when writing environments.json fails', async () => {
    legacyPayload = JSON.stringify({
      version: 1,
      data: {
        uiMode: 'key-value',
        variables: [{ key: 'RETRY_ME', value: '1' }],
      },
    });
    writeFileMock.mockRejectedValueOnce(new Error('rename failed'));

    const first = await readEnvironmentConfig();

    expect(
      first.data.environments.find(
        (environment) => environment.id === 'default-overall',
      )?.variables,
    ).toEqual([{ key: 'RETRY_ME', value: '1' }]);
    expect(environmentPayload).toBeNull();

    const second = await readEnvironmentConfig();

    expect(writeFileMock).toHaveBeenCalledTimes(2);
    expect(environmentPayload).not.toBeNull();
    expect(
      second.data.environments.find(
        (environment) => environment.id === 'default-overall',
      )?.variables,
    ).toEqual([{ key: 'RETRY_ME', value: '1' }]);
  });

  it('does not persist an empty migration when encrypted legacy variables cannot be decrypted', async () => {
    const encrypted = Buffer.from(
      `enc:${JSON.stringify([{ key: 'SECRET', value: '1' }])}`,
      'utf8',
    ).toString('base64');
    legacyPayload = JSON.stringify({
      version: 1,
      data: {
        uiMode: 'bulk',
        encrypted,
      },
    });
    safeStorageMock.encryptionAvailable = false;

    await expect(readEnvironmentConfig()).rejects.toThrow(
      'OS encryption unavailable',
    );
    expect(environmentPayload).toBeNull();
    expect(writeFileMock).not.toHaveBeenCalled();

    safeStorageMock.encryptionAvailable = true;
    const second = await readEnvironmentConfig();

    expect(
      second.data.environments.find(
        (environment) => environment.id === 'default-overall',
      )?.variables,
    ).toEqual([{ key: 'SECRET', value: '1' }]);
    expect(environmentPayload).not.toBeNull();
  });

  it('rejects saving over undecryptable legacy variables before version-2 migration', async () => {
    const encrypted = Buffer.from(
      `enc:${JSON.stringify([{ key: 'SECRET', value: '1' }])}`,
      'utf8',
    ).toString('base64');
    legacyPayload = JSON.stringify({
      version: 1,
      data: {
        uiMode: 'bulk',
        encrypted,
      },
    });
    safeStorageMock.encryptionAvailable = false;

    await expect(
      writeEnvironmentConfig({
        version: 2,
        environments: [],
        globalRuntimes: {
          canopy: 'default-canopy',
          agent: 'default-agent',
          pipeline: 'default-pipeline',
        },
        workspaceAssignments: [],
      }),
    ).rejects.toThrow('OS encryption unavailable');
    expect(environmentPayload).toBeNull();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('rejects encrypted version-2 config when variables cannot be decrypted', async () => {
    const encryptedVariables = Buffer.from(
      `enc:${JSON.stringify([{ key: 'SECRET', value: '1' }])}`,
      'utf8',
    ).toString('base64');
    environmentPayload = JSON.stringify({
      version: 2,
      data: {
        environments: [
          {
            id: 'default-overall',
            name: 'Overall',
            parentId: null,
            isDefault: true,
            defaultKind: 'overall',
            uiMode: 'key-value',
            encryptedVariables,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        globalRuntimes: {
          canopy: 'default-canopy',
          agent: 'default-agent',
          pipeline: 'default-pipeline',
        },
        workspaceAssignments: [],
      },
    });
    const previousPayload = environmentPayload;
    safeStorageMock.encryptionAvailable = false;

    await expect(readEnvironmentConfig()).rejects.toThrow(
      'OS encryption unavailable',
    );
    await expect(
      writeEnvironmentConfig({
        version: 2,
        environments: [],
        globalRuntimes: {
          canopy: 'default-canopy',
          agent: 'default-agent',
          pipeline: 'default-pipeline',
        },
        workspaceAssignments: [],
      }),
    ).rejects.toThrow('OS encryption unavailable');
    expect(environmentPayload).toBe(previousPayload);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('loads the full version-2 environment config', async () => {
    await writeUserEnvironment({
      uiMode: 'bulk',
      variables: [{ key: 'FOO', value: 'bar' }],
    });

    const result = await readEnvironmentConfig();
    expect(result.data.version).toBe(2);
    expect(result.data.globalRuntimes).toMatchObject({
      canopy: 'default-canopy',
      agent: 'default-agent',
      pipeline: 'default-pipeline',
    });
    expect(
      result.data.environments.find(
        (environment) => environment.id === 'default-overall',
      )?.variables,
    ).toEqual([{ key: 'FOO', value: 'bar' }]);
  });

  it('allows deleting a currently assigned environment when the same payload clears its assignment', async () => {
    const current = (await readEnvironmentConfig()).data;
    const assignedEnvironment = {
      id: 'assigned',
      name: 'Assigned',
      parentId: null,
      isDefault: false,
      uiMode: 'key-value' as const,
      variables: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await writeEnvironmentConfig({
      ...current,
      environments: [...current.environments, assignedEnvironment],
      workspaceAssignments: [
        {
          workspaceId: 'workspace-1',
          runtimes: { agent: 'assigned' },
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const result = await writeEnvironmentConfig({
      ...current,
      workspaceAssignments: [],
    });

    expect(
      result.data.environments.find(
        (environment) => environment.id === 'assigned',
      ),
    ).toBeUndefined();
    expect(result.data.workspaceAssignments).toEqual([]);
  });

  it('rejects deleting an environment that remains assigned in the next payload', async () => {
    const current = (await readEnvironmentConfig()).data;
    const assignedEnvironment = {
      id: 'assigned',
      name: 'Assigned',
      parentId: null,
      isDefault: false,
      uiMode: 'key-value' as const,
      variables: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const assignment = {
      workspaceId: 'workspace-1',
      runtimes: { agent: 'assigned' },
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await writeEnvironmentConfig({
      ...current,
      environments: [...current.environments, assignedEnvironment],
      workspaceAssignments: [assignment],
    });
    const previousPayload = environmentPayload;

    await expect(
      writeEnvironmentConfig({
        ...current,
        workspaceAssignments: [assignment],
      }),
    ).rejects.toThrow(
      'Assigned environments cannot be deleted. Remove its runtime assignments first.',
    );
    expect(environmentPayload).toBe(previousPayload);
  });

  it('fails closed when the current file is corrupt JSON', async () => {
    environmentPayload = '{not json';
    await expect(readUserEnvironment()).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe('environment secure policy retention', () => {
  it.each(['locked', 'unavailable'] as const)(
    'refuses a new value save when the live provider is %s despite native availability',
    async (state) => {
      // Confirm the native parent while the provider is healthy, with no ciphertext yet.
      const next = (await readEnvironmentConfig()).data;
      expect(safeStorageMock.isEncryptionAvailable).toHaveReturnedWith(true);
      next.environments = next.environments.map((environment) => ({
        ...environment,
        variables: [{ key: 'TOKEN', value: 'private', secret: true }],
      }));
      mockSecretServiceState.mockReturnValue(state);

      // Availability is a nonthrowing display value, not authorization to save plaintext.
      await expect(readEnvironmentConfig()).resolves.toMatchObject({
        encryptionAvailable: false,
      });
      const error = await writeEnvironmentConfig(next).catch(
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(SafeStorageWriteError);
      expect(getSecureStorageFailure(error)).toMatchObject({
        code: 'SECURE_STORAGE_WRITE_REFUSED',
        operation: 'write',
        state,
        backend: 'gnome_libsecret',
        retryable: true,
      });
      expect(safeStorageMock.encryptionAvailable).toBe(true);
      expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
      expect(writeFileMock).not.toHaveBeenCalled();
      expect(environmentPayload).toBeNull();

      mockSecretServiceState.mockReturnValue('secure');
      await expect(writeEnvironmentConfig(next)).resolves.toMatchObject({
        encryptionAvailable: true,
      });
      expect(environmentPayload).not.toContain('plaintextVariables');
      expect(environmentPayload).not.toContain('private');
    },
  );

  it('preserves ciphertext when a provider probe fails between reading and staging the atomic save', async () => {
    const initial = (await readEnvironmentConfig()).data;
    initial.environments = initial.environments.map((environment) => ({
      ...environment,
      variables: [{ key: 'TOKEN', value: environment.id, secret: true }],
    }));
    // The reply carries stored-secret references (CAN-4411); saving it back
    // keeps the values, and the ciphertext is of the stored plaintext.
    const next = (await writeEnvironmentConfig(initial)).data;
    const stored = (await readEnvironmentConfig()).data;
    const previous = environmentPayload;
    expect(previous).toContain('encryptedVariables');
    expect(previous).not.toContain('plaintextVariables');
    const lastCiphertext = `enc:${JSON.stringify(stored.environments.at(-1)?.variables)}`;
    writeFileMock.mockClear();
    safeStorageMock.encryptString.mockClear();
    safeStorageMock.decryptString.mockImplementation((encrypted) => {
      const ciphertext = encrypted.toString('utf8');
      // The last record was readable; the subsequent live write observation fails.
      if (ciphertext === lastCiphertext) {
        mockSecretServiceState.mockReturnValue('unavailable');
      }
      return ciphertext.replace(/^enc:/, '');
    });

    const error = await writeEnvironmentConfig(next).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(SafeStorageWriteError);
    expect(getSecureStorageFailure(error)).toMatchObject({
      code: 'SECURE_STORAGE_WRITE_REFUSED',
      operation: 'write',
      state: 'unavailable',
      backend: 'gnome_libsecret',
      retryable: true,
    });
    expect(safeStorageMock.encryptionAvailable).toBe(true);
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(environmentPayload).toBe(previous);
    expect(environmentPayload).not.toContain('plaintextVariables');

    mockSecretServiceState.mockReturnValue('secure');
    safeStorageMock.decryptString.mockImplementation((encrypted) =>
      encrypted.toString('utf8').replace(/^enc:/, ''),
    );
    await expect(writeEnvironmentConfig(next)).resolves.toMatchObject({
      encryptionAvailable: true,
    });
    expect((await readEnvironmentConfig()).data.environments).toEqual(
      stored.environments,
    );
    expect(environmentPayload).not.toContain('plaintextVariables');
  });

  it.each(['unknown', 'gnome_libsecret'])(
    'refuses %s becoming unavailable during encryption without plaintext fallback',
    async (backend) => {
      safeStorageMock.isEncryptionAvailable.mockImplementationOnce(() => {
        mockBackend = backend;
        safeStorageMock.encryptionAvailable = false;
        return true;
      });
      await expect(
        writeEnvironmentConfig(
          withOverall(createDefaultEnvironmentConfig('now'), {
            uiMode: 'bulk',
            variables: [{ key: 'TOKEN', value: 'private' }],
          }),
        ),
      ).rejects.toMatchObject({ code: 'SECURE_STORAGE_WRITE_REFUSED' });
      expect(environmentPayload).toBeNull();
      expect(writeFileMock).not.toHaveBeenCalled();
      expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
    },
  );

  it('retains the entire old file when second-field encryption fails', async () => {
    await writeUserEnvironment({
      uiMode: 'bulk',
      variables: [{ key: 'TOKEN', value: 'original' }],
    });
    const previous = environmentPayload;
    writeFileMock.mockClear();
    safeStorageMock.encryptString
      .mockImplementationOnce((text) => Buffer.from(`enc:${text}`))
      .mockImplementationOnce(() => {
        throw new Error('private native diagnostic');
      });
    await expect(
      writeUserEnvironment({
        uiMode: 'bulk',
        variables: [{ key: 'TOKEN', value: 'new' }],
      }),
    ).rejects.toMatchObject({ code: 'SECURE_STORAGE_ENCRYPT_FAILED' });
    expect(environmentPayload).toBe(previous);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('never downgrades after an availability probe exception', async () => {
    safeStorageMock.isEncryptionAvailable.mockImplementation(() => {
      throw new Error('private probe diagnostic');
    });
    await expect(
      writeUserEnvironment({ uiMode: 'bulk', variables: [] }),
    ).rejects.toMatchObject({ code: 'SECURE_STORAGE_PROBE_FAILED' });
    expect(environmentPayload).toBeNull();
  });

  it('retains historical ciphertext while libsecret is unavailable and refuses replacement', async () => {
    await writeUserEnvironment({
      uiMode: 'bulk',
      variables: [{ key: 'TOKEN', value: 'original' }],
    });
    const previous = environmentPayload;
    mockBackend = 'unknown';
    safeStorageMock.encryptionAvailable = false;
    await expect(readUserEnvironment()).rejects.toMatchObject({
      secureStorageFailure: {
        code: 'SECURE_STORAGE_READ_UNAVAILABLE',
        state: 'unavailable',
      },
    });
    await expect(
      writeUserEnvironment({ uiMode: 'bulk', variables: [] }),
    ).rejects.toMatchObject({
      secureStorageFailure: { code: 'SECURE_STORAGE_READ_UNAVAILABLE' },
    });
    expect(environmentPayload).toBe(previous);
  });

  it('retains encrypted current config and carries typed metadata on read failure', async () => {
    await writeUserEnvironment({
      uiMode: 'bulk',
      variables: [{ key: 'TOKEN', value: 'original' }],
    });
    const previous = environmentPayload;
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error('private diagnostic');
    });
    await expect(readEnvironmentConfig()).rejects.toMatchObject({
      secureStorageFailure: {
        code: 'SECURE_STORAGE_DECRYPT_FAILED',
        operation: 'read',
      },
    });
    expect(environmentPayload).toBe(previous);
    await expect(
      writeUserEnvironment({ uiMode: 'bulk', variables: [] }),
    ).rejects.toMatchObject({
      secureStorageFailure: {
        code: 'SECURE_STORAGE_DECRYPT_FAILED',
        operation: 'read',
      },
    });
    expect(environmentPayload).toBe(previous);
    safeStorageMock.decryptString.mockImplementation((encrypted) =>
      encrypted.toString('utf8').replace(/^enc:/, ''),
    );
    await expect(readUserEnvironment()).resolves.toMatchObject({
      data: { variables: [{ key: 'TOKEN', value: 'original' }] },
    });
    expect(environmentPayload).toBe(previous);
  });
});

describe('stored-secret environment replies (CAN-4411)', () => {
  const SECRET = 'sk-live-private-value';

  async function seed(): Promise<void> {
    await writeUserEnvironment({
      uiMode: 'key-value',
      variables: [
        { key: 'API_TOKEN', value: SECRET, secret: true },
        { key: 'LOG_LEVEL', value: 'debug' },
      ],
    });
  }

  async function overallView(): Promise<
    Awaited<ReturnType<typeof readEnvironmentConfigView>>['data']
  > {
    return (await readEnvironmentConfigView()).data;
  }

  function overallVariables(
    data: Awaited<ReturnType<typeof overallView>>,
  ): Awaited<
    ReturnType<typeof overallView>
  >['environments'][number]['variables'] {
    return (
      data.environments.find((environment) => environment.id === OVERALL)
        ?.variables ?? []
    );
  }

  it('replies with stored-secret values for secret entries and text for the rest', async () => {
    await seed();
    const view = await overallView();
    expect(JSON.stringify(view)).not.toContain(SECRET);
    const [token, level] = overallVariables(view);
    expect(token).toEqual({
      key: 'API_TOKEN',
      secret: true,
      value: {
        kind: 'stored-secret',
        ref: storedSecretRef('environment', 'config', `${OVERALL}/API_TOKEN`),
      },
    });
    expect(level).toEqual({ key: 'LOG_LEVEL', value: 'debug' });
    // Stable across reads, so the renderer can compare and round-trip it.
    expect(overallVariables(await overallView())[0]).toEqual(token);
  });

  it('keeps a stored secret the save echoes back, including under a new key', async () => {
    await seed();
    const view = await overallView();
    const [token] = overallVariables(view);
    const saved = await writeEnvironmentConfig({
      ...view,
      environments: view.environments.map((environment) =>
        environment.id === OVERALL
          ? {
              ...environment,
              variables: [{ ...token, key: 'RENAMED_TOKEN' }],
            }
          : environment,
      ),
    });
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect((await readUserEnvironment()).data.variables).toEqual([
      { key: 'RENAMED_TOKEN', value: SECRET, secret: true },
    ]);
  });

  it('refuses to unmark a kept secret, which would reveal it on the next load', async () => {
    await seed();
    const before = environmentPayload;
    const view = await overallView();
    const [token] = overallVariables(view);
    await expect(
      writeEnvironmentConfig({
        ...view,
        environments: view.environments.map((environment) =>
          environment.id === OVERALL
            ? {
                ...environment,
                variables: [{ key: 'API_TOKEN', value: token.value }],
              }
            : environment,
        ),
      }),
    ).rejects.toMatchObject({ code: 'stored_secret_reveal' });
    expect(environmentPayload).toBe(before);
  });

  it('refuses a reference that names no stored secret, writing nothing', async () => {
    await seed();
    const before = environmentPayload;
    const view = await overallView();
    await expect(
      writeEnvironmentConfig({
        ...view,
        environments: view.environments.map((environment) =>
          environment.id === OVERALL
            ? {
                ...environment,
                variables: [
                  {
                    key: 'API_TOKEN',
                    secret: true,
                    value: { kind: 'stored-secret', ref: 'ssr1_forged' },
                  },
                ],
              }
            : environment,
        ),
      }),
    ).rejects.toMatchObject({ code: 'stored_secret_unknown' });
    expect(environmentPayload).toBe(before);
  });

  it('cannot keep a value that was never marked secret', async () => {
    await seed();
    const view = await overallView();
    const unmarked = await readEnvironmentConfig();
    // A reference derived for the plain entry's slot is not honoured.
    await expect(
      writeEnvironmentConfig({
        ...unmarked.data,
        environments: view.environments.map((environment) =>
          environment.id === OVERALL
            ? {
                ...environment,
                variables: [
                  {
                    key: 'LEAK',
                    secret: true,
                    value: {
                      kind: 'stored-secret',
                      ref: storedSecretRef(
                        'environment',
                        'config',
                        `${OVERALL}/LOG_LEVEL`,
                      ),
                    },
                  },
                ],
              }
            : environment,
        ),
      }),
    ).rejects.toMatchObject({ code: 'stored_secret_unknown' });
  });
});
