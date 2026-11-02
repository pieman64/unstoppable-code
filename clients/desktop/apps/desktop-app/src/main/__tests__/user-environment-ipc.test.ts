const mockReadUserEnvironment = jest.fn();
const mockWriteUserEnvironment = jest.fn();
const mockReadEnvironmentConfig = jest.fn();
const mockWriteEnvironmentConfig = jest.fn();
const mockInitializeUserEnvironmentRuntime = jest.fn();
const mockInvalidateUserEnvironmentInjectionCache = jest.fn();
const mockDestroySessionsByProvider = jest.fn();
const mockHandleUserEnvironmentChanged = jest.fn();
const mockRevokeDelegationLifecycle = jest.fn();
const mockHasDelegationLifecycle = jest.fn(() => false);

jest.mock('../agents/delegation/lifecycle', () => ({
  get hasDelegationLifecycle(): typeof mockHasDelegationLifecycle {
    return mockHasDelegationLifecycle;
  },
  get revokeDelegationLifecycle(): typeof mockRevokeDelegationLifecycle {
    return mockRevokeDelegationLifecycle;
  },
}));

jest.mock('../lib/user-environment-store', () => ({
  get readEnvironmentConfig(): typeof mockReadEnvironmentConfig {
    return mockReadEnvironmentConfig;
  },
  get readUserEnvironment(): typeof mockReadUserEnvironment {
    return mockReadUserEnvironment;
  },
  get writeEnvironmentConfig(): typeof mockWriteEnvironmentConfig {
    return mockWriteEnvironmentConfig;
  },
  get writeUserEnvironment(): typeof mockWriteUserEnvironment {
    return mockWriteUserEnvironment;
  },
}));

jest.mock('../lib/user-environment-runtime', () => ({
  get initializeUserEnvironmentRuntime(): typeof mockInitializeUserEnvironmentRuntime {
    return mockInitializeUserEnvironmentRuntime;
  },
  get invalidateUserEnvironmentInjectionCache(): typeof mockInvalidateUserEnvironmentInjectionCache {
    return mockInvalidateUserEnvironmentInjectionCache;
  },
}));

jest.mock('../agents/session-manager', () => ({
  get destroySessionsByProvider(): typeof mockDestroySessionsByProvider {
    return mockDestroySessionsByProvider;
  },
}));

jest.mock('../ollama', () => ({
  getOllamaService: jest.fn(() => ({
    get handleUserEnvironmentChanged(): typeof mockHandleUserEnvironmentChanged {
      return mockHandleUserEnvironmentChanged;
    },
  })),
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

import {
  IPC_CHANNELS,
  type EnvironmentConfigData,
  type UserEnvironmentData,
} from '@canopy/desktop-shared/types';
import { createDefaultEnvironmentConfig } from '@canopy/desktop-shared/lib/user-environment';
import { registerUserEnvironmentHandlers } from '../ipc/user-environment';
import { registerIpcHandler } from '../ipc/register';
import { SecureStorageOperationError } from '../lib/secure-storage-policy';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);

function getRegisteredHandler(
  channel: string,
): (...args: unknown[]) => unknown {
  const handler = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  )?.[1];
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler as (...args: unknown[]) => unknown;
}

describe('user environment IPC', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasDelegationLifecycle.mockReturnValue(false);
    mockRevokeDelegationLifecycle.mockResolvedValue(undefined);
    mockReadUserEnvironment.mockResolvedValue({
      data: { uiMode: 'key-value', variables: [] },
      encryptionAvailable: true,
    });
    mockWriteUserEnvironment.mockResolvedValue({
      data: { uiMode: 'key-value', variables: [] },
      encryptionAvailable: true,
    });
    const defaultConfig = createDefaultEnvironmentConfig(
      '2026-05-29T00:00:00.000Z',
    );
    mockReadEnvironmentConfig.mockResolvedValue({
      data: defaultConfig,
      encryptionAvailable: true,
    });
    mockWriteEnvironmentConfig.mockResolvedValue({
      data: defaultConfig,
      encryptionAvailable: true,
    });
    mockDestroySessionsByProvider.mockResolvedValue(undefined);
    mockHandleUserEnvironmentChanged.mockResolvedValue(undefined);
  });

  it('registers the runtime injector before exposing load/save handlers', () => {
    registerUserEnvironmentHandlers();

    expect(mockInitializeUserEnvironmentRuntime).toHaveBeenCalledTimes(1);
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.userEnvironmentLoad,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.userEnvironmentSave,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.environmentConfigLoad,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.environmentConfigSave,
      expect.any(Function),
    );
  });

  it('refreshes Ollama processes after saving user environment variables', async () => {
    registerUserEnvironmentHandlers();
    const handler = getRegisteredHandler(IPC_CHANNELS.userEnvironmentSave);
    const data: UserEnvironmentData = {
      uiMode: 'key-value',
      variables: [{ key: 'CUSTOM_OLLAMA_ENV', value: 'enabled' }],
    };

    await handler({}, data);

    expect(mockWriteUserEnvironment).toHaveBeenCalledWith(data);
    expect(mockInvalidateUserEnvironmentInjectionCache).toHaveBeenCalledTimes(
      1,
    );
    expect(mockDestroySessionsByProvider).toHaveBeenCalledWith('ollama');
    expect(mockHandleUserEnvironmentChanged).toHaveBeenCalledTimes(1);
  });

  it('refreshes Ollama processes after saving environment config assignments', async () => {
    registerUserEnvironmentHandlers();
    const handler = getRegisteredHandler(IPC_CHANNELS.environmentConfigSave);
    const data: EnvironmentConfigData = createDefaultEnvironmentConfig(
      '2026-05-29T00:00:00.000Z',
    );

    await handler({}, data);

    expect(mockWriteEnvironmentConfig).toHaveBeenCalledWith(data);
    expect(mockInvalidateUserEnvironmentInjectionCache).toHaveBeenCalledTimes(
      1,
    );
    expect(mockDestroySessionsByProvider).toHaveBeenCalledWith('ollama');
    expect(mockHandleUserEnvironmentChanged).toHaveBeenCalledTimes(1);
  });

  it.each(['sessions', 'runtime'])(
    'reports a committed config as saved when %s refresh fails',
    async (stage) => {
      const data = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
      const result = { data, encryptionAvailable: true };
      mockWriteEnvironmentConfig.mockResolvedValueOnce(result);
      if (stage === 'sessions')
        mockDestroySessionsByProvider.mockRejectedValueOnce(
          new Error('refresh failed'),
        );
      else
        mockHandleUserEnvironmentChanged.mockRejectedValueOnce(
          new Error('refresh failed'),
        );
      registerUserEnvironmentHandlers();
      const handler = getRegisteredHandler(IPC_CHANNELS.environmentConfigSave);
      await expect(handler({}, data)).resolves.toEqual(result);
      expect(mockWriteEnvironmentConfig).toHaveBeenCalledTimes(1);
    },
  );

  it('returns a structured error when environment config save validation fails', async () => {
    mockWriteEnvironmentConfig.mockRejectedValueOnce(new Error('bad config'));
    registerUserEnvironmentHandlers();
    const handler = getRegisteredHandler(IPC_CHANNELS.environmentConfigSave);

    await expect(
      handler({}, createDefaultEnvironmentConfig('now')),
    ).resolves.toEqual({
      ok: false,
      error: 'bad config',
    });
    expect(mockInvalidateUserEnvironmentInjectionCache).not.toHaveBeenCalled();
    expect(mockDestroySessionsByProvider).not.toHaveBeenCalled();
    expect(mockHandleUserEnvironmentChanged).not.toHaveBeenCalled();
  });

  it.each([
    IPC_CHANNELS.userEnvironmentSave,
    IPC_CHANNELS.environmentConfigSave,
  ])(
    'revokes active delegated routes after a successful environment save (%s)',
    async (channel) => {
      mockHasDelegationLifecycle.mockReturnValue(true);
      registerUserEnvironmentHandlers();
      await getRegisteredHandler(channel)(
        {},
        channel === IPC_CHANNELS.userEnvironmentSave
          ? { uiMode: 'key-value', variables: [] }
          : createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z'),
      );
      expect(mockRevokeDelegationLifecycle).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    IPC_CHANNELS.userEnvironmentSave,
    IPC_CHANNELS.environmentConfigSave,
  ])(
    'still refreshes Ollama when delegation revocation fails (%s)',
    async (channel) => {
      mockHasDelegationLifecycle.mockReturnValue(true);
      mockRevokeDelegationLifecycle.mockRejectedValueOnce(
        new Error('revocation failed'),
      );
      registerUserEnvironmentHandlers();

      const result = await getRegisteredHandler(channel)(
        {},
        channel === IPC_CHANNELS.userEnvironmentSave
          ? { uiMode: 'key-value', variables: [] }
          : createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z'),
      );

      expect(result).toMatchObject({ encryptionAvailable: true });
      expect(mockDestroySessionsByProvider).toHaveBeenCalledWith('ollama');
      expect(mockHandleUserEnvironmentChanged).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'SECURE_STORAGE_READ_UNAVAILABLE',
    'SECURE_STORAGE_DECRYPT_FAILED',
    'SECURE_STORAGE_PROBE_FAILED',
  ] as const)(
    'returns a data-free environment read failure and permits recovery (%s)',
    async (code) => {
      const secureStorageFailure = {
        version: 1,
        code,
        operation: code === 'SECURE_STORAGE_PROBE_FAILED' ? 'probe' : 'read',
        state: 'locked',
        backend: 'gnome_libsecret',
        retryable: true,
      } as const;
      mockReadEnvironmentConfig.mockRejectedValueOnce(
        new SecureStorageOperationError(secureStorageFailure),
      );
      registerUserEnvironmentHandlers();
      const handler = getRegisteredHandler(IPC_CHANNELS.environmentConfigLoad);
      const result = await handler({});
      expect(result).toEqual({
        ok: false,
        error: "Couldn't read saved environment values.",
        secureStorageFailure,
      });
      expect(result).not.toHaveProperty('data');
      const restored = await handler({});
      expect(restored).toHaveProperty('encryptionAvailable', true);
      expect(restored).toHaveProperty('data');
      expect(mockWriteEnvironmentConfig).not.toHaveBeenCalled();
      expect(
        mockInvalidateUserEnvironmentInjectionCache,
      ).not.toHaveBeenCalled();
    },
  );

  it('does not serialize native or filesystem diagnostics in environment read errors', async () => {
    mockReadEnvironmentConfig.mockRejectedValueOnce(
      new Error('sensitive path or native secret diagnostic'),
    );
    registerUserEnvironmentHandlers();
    await expect(
      getRegisteredHandler(IPC_CHANNELS.environmentConfigLoad)({}),
    ).resolves.toEqual({
      ok: false,
      error: "Couldn't read saved environment values.",
    });
  });

  it('returns safe storage metadata without successful-save side effects', async () => {
    const secureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_DECRYPT_FAILED',
      operation: 'read',
      state: 'locked',
      backend: 'gnome_libsecret',
      retryable: true,
    } as const;
    mockHasDelegationLifecycle.mockReturnValue(true);
    mockWriteEnvironmentConfig.mockRejectedValueOnce(
      new SecureStorageOperationError(secureStorageFailure),
    );
    registerUserEnvironmentHandlers();
    await expect(
      getRegisteredHandler(IPC_CHANNELS.environmentConfigSave)(
        {},
        createDefaultEnvironmentConfig('now'),
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'Secure storage decryption failed',
      secureStorageFailure,
    });
    expect(mockInvalidateUserEnvironmentInjectionCache).not.toHaveBeenCalled();
    expect(mockDestroySessionsByProvider).not.toHaveBeenCalled();
    expect(mockHandleUserEnvironmentChanged).not.toHaveBeenCalled();
    expect(mockRevokeDelegationLifecycle).not.toHaveBeenCalled();
  });
});
