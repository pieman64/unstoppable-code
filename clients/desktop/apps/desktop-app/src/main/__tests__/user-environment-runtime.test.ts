import type * as UserEnvironmentRuntimeModule from '../lib/user-environment-runtime';
import type {
  PersistedEnvironmentConfigFile,
  ResolveEnvironmentRequest,
} from '@canopy/desktop-shared/types';

type UserEnvironmentInjector = (
  context?: ResolveEnvironmentRequest,
) => Record<string, string>;

const mockReadFileSync = jest.fn();
const mockStatSync = jest.fn();
const mockRegisterUserEnvironmentInjector = jest.fn<
  void,
  [UserEnvironmentInjector]
>();
const mockReadEnvironmentConfig = jest.fn();

jest.mock('node:fs', () => ({
  get readFileSync(): typeof mockReadFileSync {
    return mockReadFileSync;
  },
  get statSync(): typeof mockStatSync {
    return mockStatSync;
  },
}));

jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getEnvironmentConfigFilePath: jest.fn(() => '/mock/environments.json'),
  getInternalLegacySharedEnvironmentConfigFilePath: jest.fn(
    (): string | null => null,
  ),
  getLegacyEnvironmentConfigFilePath: jest.fn(
    () => '/mock/userData/environments.json',
  ),
  getUserEnvironmentFilePath: jest.fn(() => '/mock/user-environment.json'),
}));

jest.mock('../pipelines/config-paths', () => ({
  get registerUserEnvironmentInjector(): typeof mockRegisterUserEnvironmentInjector {
    return mockRegisterUserEnvironmentInjector;
  },
}));

let mockBackend = 'gnome_libsecret';
const mockAvailable = jest.fn(() => true);
const mockDecrypt = jest.fn((encrypted: Buffer) => encrypted.toString('utf8'));
jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): 'linux' => 'linux',
}));
jest.mock('electron', () => ({
  app: { isReady: (): boolean => true },
  safeStorage: {
    get isEncryptionAvailable(): typeof mockAvailable {
      return mockAvailable;
    },
    get decryptString(): typeof mockDecrypt {
      return mockDecrypt;
    },
    encryptString: jest.fn(),
    getSelectedStorageBackend: (): string => mockBackend,
  },
}));

jest.mock('../lib/user-environment-store', () => ({
  get readEnvironmentConfig(): typeof mockReadEnvironmentConfig {
    return mockReadEnvironmentConfig;
  },
}));

import { getInternalLegacySharedEnvironmentConfigFilePath } from '@canopy/desktop-shared/canopy-paths';
import {
  initializeUserEnvironmentRuntime,
  invalidateUserEnvironmentInjectionCache,
  resolveCodexRuntimeEnvironmentProfile,
} from '../lib/user-environment-runtime';

function missingFileError(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('ENOENT');
  error.code = 'ENOENT';
  return error;
}

function accessError(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('EACCES');
  error.code = 'EACCES';
  return error;
}

function persistedConfigFixture(
  variableKey: string,
): PersistedEnvironmentConfigFile {
  return {
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
          plaintextVariables: [{ key: variableKey, value: '1' }],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      globalRuntimes: {
        canopy: 'default-overall',
        agent: 'default-overall',
        pipeline: 'default-overall',
      },
      workspaceAssignments: [],
    },
  };
}

function persistedConfig(variableKey: string): string {
  return JSON.stringify(persistedConfigFixture(variableKey));
}

describe('user environment runtime', () => {
  let injector: UserEnvironmentInjector;

  beforeAll(() => {
    mockReadEnvironmentConfig.mockRejectedValue(
      new Error('skip async preload'),
    );
    initializeUserEnvironmentRuntime();
    const registered = mockRegisterUserEnvironmentInjector.mock.calls[0]?.[0];
    if (!registered) {
      throw new Error('Expected user environment injector registration');
    }
    injector = registered;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    invalidateUserEnvironmentInjectionCache();
    jest
      .mocked(getInternalLegacySharedEnvironmentConfigFilePath)
      .mockReturnValue(null);
    mockBackend = 'gnome_libsecret';
    mockAvailable.mockReturnValue(true);
    mockDecrypt.mockImplementation((encrypted) => encrypted.toString('utf8'));
  });

  function encryptedConfig(): string {
    const parsed = persistedConfigFixture('SECRET');
    const environment = parsed.data.environments[0];
    if (!environment) throw new Error('Expected environment fixture');
    environment.encryptedVariables = Buffer.from(
      JSON.stringify(environment.plaintextVariables),
    ).toString('base64');
    delete environment.plaintextVariables;
    return JSON.stringify(parsed);
  }
  it('omits cached encrypted values while locked and retries unchanged mtime', () => {
    mockStatSync.mockReturnValue({ mtimeMs: 3 });
    mockReadFileSync.mockReturnValue(encryptedConfig());
    expect(injector()).toEqual({ SECRET: '1' });
    mockAvailable.mockReturnValue(false);
    expect(injector()).toEqual({});
    mockAvailable.mockReturnValue(true);
    expect(injector()).toEqual({ SECRET: '1' });
  });
  it('does not install empty data as an authoritative cache on decrypt failure', () => {
    mockStatSync.mockReturnValue({ mtimeMs: 3 });
    mockReadFileSync.mockReturnValue(encryptedConfig());
    mockDecrypt.mockImplementationOnce(() => {
      throw new Error('cannot decrypt');
    });
    expect(injector()).toEqual({});
    expect(injector()).toEqual({ SECRET: '1' });
  });
  it('reloads cached encrypted values when backend identity changes', () => {
    mockStatSync.mockReturnValue({ mtimeMs: 3 });
    mockReadFileSync.mockReturnValue(encryptedConfig());
    expect(injector()).toEqual({ SECRET: '1' });
    mockBackend = 'unknown';
    mockAvailable.mockReturnValue(false);
    expect(injector()).toEqual({});
    mockBackend = 'gnome_libsecret';
    mockAvailable.mockReturnValue(true);
    expect(injector()).toEqual({ SECRET: '1' });
  });
  it('keeps plaintext values readable without encryption availability', () => {
    mockStatSync.mockReturnValue({ mtimeMs: 3 });
    mockReadFileSync.mockReturnValue(persistedConfig('PLAIN'));
    mockAvailable.mockReturnValue(false);
    expect(injector()).toEqual({ PLAIN: '1' });
    expect(injector()).toEqual({ PLAIN: '1' });
    expect(mockAvailable).not.toHaveBeenCalled();
  });

  it('warms startup through the synchronous reader with encrypted-cache metadata', async () => {
    mockStatSync.mockReturnValue({ mtimeMs: 3 });
    mockReadFileSync.mockReturnValue(encryptedConfig());
    mockReadEnvironmentConfig.mockResolvedValue({
      data: persistedConfigFixture('ASYNC_ONLY'),
      encryptionAvailable: true,
    });
    jest.isolateModules(() => {
      const runtime = jest.requireActual<typeof UserEnvironmentRuntimeModule>(
        '../lib/user-environment-runtime',
      );
      runtime.initializeUserEnvironmentRuntime();
    });
    await Promise.resolve();
    await Promise.resolve();
    const warmedInjector =
      mockRegisterUserEnvironmentInjector.mock.calls[0]?.[0];
    if (!warmedInjector) throw new Error('Expected warmed injector');
    expect(warmedInjector()).toEqual({ SECRET: '1' });
    mockAvailable.mockReturnValue(false);
    expect(warmedInjector()).toEqual({});
    mockReadEnvironmentConfig.mockRejectedValue(
      new Error('skip async preload'),
    );
  });

  it('keeps readable internal legacy ciphertext available when migration writes are deferred', () => {
    jest
      .mocked(getInternalLegacySharedEnvironmentConfigFilePath)
      .mockReturnValue('/mock/stable/environments.json');
    mockDecrypt.mockImplementationOnce((raw: Buffer) => {
      mockAvailable.mockReturnValue(false);
      return raw.toString('utf8');
    });
    mockStatSync.mockImplementation((path) => {
      if (path === '/mock/stable/environments.json') return { mtimeMs: 3 };
      throw missingFileError();
    });
    mockReadFileSync.mockImplementation((path) => {
      if (path === '/mock/stable/environments.json') return encryptedConfig();
      throw missingFileError();
    });
    expect(injector()).toEqual({ SECRET: '1' });
    mockAvailable.mockReturnValue(false);
    expect(injector()).toEqual({});
    mockAvailable.mockReturnValue(true);
    expect(injector()).toEqual({ SECRET: '1' });
  });

  it('falls back to the legacy config only when the secure config is missing', () => {
    mockStatSync.mockImplementation((path) => {
      if (path === '/mock/environments.json') {
        throw missingFileError();
      }
      return { mtimeMs: 2 };
    });
    mockReadFileSync.mockImplementation((path) => {
      if (path === '/mock/environments.json') {
        throw missingFileError();
      }
      return persistedConfig('LEGACY_SYNC');
    });

    expect(injector({ runtime: 'canopy' })).toEqual({ LEGACY_SYNC: '1' });
    expect(mockReadFileSync).toHaveBeenCalledWith(
      '/mock/userData/environments.json',
      'utf8',
    );
  });

  it('does not use stale legacy config when the secure config is unreadable', () => {
    mockStatSync.mockImplementation((path) => {
      if (path === '/mock/environments.json') {
        throw accessError();
      }
      return { mtimeMs: 2 };
    });
    mockReadFileSync.mockImplementation((path) => {
      if (path === '/mock/environments.json') {
        throw accessError();
      }
      return persistedConfig('STALE_LEGACY');
    });

    expect(injector({ runtime: 'canopy' })).toEqual({});
    expect(mockReadFileSync).not.toHaveBeenCalledWith(
      '/mock/userData/environments.json',
      'utf8',
    );
  });

  it('reuses parsed config and refreshes immediately after explicit invalidation', () => {
    mockStatSync.mockReturnValue({ mtimeMs: 3 });
    mockReadFileSync.mockReturnValue(persistedConfig('FIRST_VALUE'));

    expect(injector({ runtime: 'canopy' })).toEqual({ FIRST_VALUE: '1' });
    expect(injector({ runtime: 'canopy' })).toEqual({ FIRST_VALUE: '1' });
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
    expect(mockStatSync).toHaveBeenCalledTimes(1);

    mockReadFileSync.mockReturnValue(persistedConfig('REFRESHED_VALUE'));
    invalidateUserEnvironmentInjectionCache();

    expect(injector({ runtime: 'canopy' })).toEqual({
      REFRESHED_VALUE: '1',
    });
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
    expect(mockStatSync).toHaveBeenCalledTimes(2);
  });

  it('detects an out-of-band config edit after the mtime safety interval', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    mockStatSync.mockReturnValue({ mtimeMs: 3 });
    mockReadFileSync.mockReturnValue(persistedConfig('INITIAL_VALUE'));

    expect(injector({ runtime: 'canopy' })).toEqual({ INITIAL_VALUE: '1' });

    mockStatSync.mockReturnValue({ mtimeMs: 4 });
    mockReadFileSync.mockReturnValue(persistedConfig('EXTERNAL_VALUE'));
    now.mockReturnValue(11_001);

    expect(injector({ runtime: 'canopy' })).toEqual({ EXTERNAL_VALUE: '1' });
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('builds an immutable Codex profile from the assigned project environment', () => {
    mockStatSync.mockReturnValue({ mtimeMs: 3 });
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        version: 2,
        data: {
          environments: [
            {
              id: 'agent-parent',
              name: 'Agent Parent',
              parentId: null,
              uiMode: 'key-value',
              plaintextVariables: [{ key: 'INHERITED_VALUE', value: 'parent' }],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
            {
              id: 'workspace-agent',
              name: 'Workspace Agent',
              parentId: 'agent-parent',
              uiMode: 'key-value',
              plaintextVariables: [
                { key: 'WORKSPACE_VALUE', value: 'enabled' },
                { key: 'WORKSPACE_SECRET', value: 'sensitive', secret: true },
              ],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          globalRuntimes: {},
          workspaceAssignments: [
            {
              workspaceId: 'workspace-1',
              runtimes: { agent: 'workspace-agent' },
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      }),
    );

    const profile = resolveCodexRuntimeEnvironmentProfile({
      runtime: 'agent',
      workspaceId: 'workspace-1',
    });

    expect(profile.environment).toEqual({
      INHERITED_VALUE: 'parent',
      WORKSPACE_VALUE: 'enabled',
      WORKSPACE_SECRET: 'sensitive',
    });
    expect(profile.logicalWorkspaceEnvironmentId).toBe('agent:workspace-agent');
    expect(profile.secretVersionFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
