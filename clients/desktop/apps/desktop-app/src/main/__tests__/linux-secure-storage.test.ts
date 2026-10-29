import { configureLinuxSecureStorage } from '../lib/secure-storage-policy';

const appendSwitch = jest.fn();
const mockSetUsePlainTextEncryption = jest.fn();
const commandLine = { appendSwitch };
const mockStorage: Record<string, unknown> = {};
jest.mock('electron', () => ({
  get safeStorage(): Record<string, unknown> {
    return mockStorage;
  },
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockStorage.setUsePlainTextEncryption = mockSetUsePlainTextEncryption;
});

test('pins libsecret and disables plaintext before any native probe', () => {
  configureLinuxSecureStorage(commandLine, {
    platform: 'linux',
    isTestHarness: false,
  });
  expect(appendSwitch).toHaveBeenCalledTimes(1);
  expect(appendSwitch).toHaveBeenCalledWith(
    'password-store',
    'gnome-libsecret',
  );
  expect(mockSetUsePlainTextEncryption).toHaveBeenCalledTimes(1);
  expect(mockSetUsePlainTextEncryption).toHaveBeenCalledWith(false);
});

test.each(['darwin', 'win32', null] as const)(
  '%s does not change native configuration',
  (platform) => {
    configureLinuxSecureStorage(commandLine, {
      platform,
      isTestHarness: false,
    });
    expect(appendSwitch).not.toHaveBeenCalled();
    expect(mockSetUsePlainTextEncryption).not.toHaveBeenCalled();
  },
);

test('production ignores a password-store environment override', () => {
  configureLinuxSecureStorage(commandLine, {
    platform: 'linux',
    isTestHarness: false,
    passwordStoreOverride: 'basic',
  });
  expect(appendSwitch).toHaveBeenCalledWith(
    'password-store',
    'gnome-libsecret',
  );
  expect(mockSetUsePlainTextEncryption).toHaveBeenCalledWith(false);
});

test('test harness accepts an explicit libsecret override', () => {
  configureLinuxSecureStorage(commandLine, {
    platform: 'linux',
    isTestHarness: true,
    passwordStoreOverride: 'gnome-libsecret',
  });
  expect(appendSwitch).toHaveBeenCalledWith(
    'password-store',
    'gnome-libsecret',
  );
  expect(mockSetUsePlainTextEncryption).toHaveBeenCalledWith(false);
});

test.each(['basic', 'basic_text', 'kwallet6', 'unknown', '', '--no-sandbox'])(
  'test harness rejects override %p before configuration',
  (passwordStoreOverride) => {
    expect(() =>
      configureLinuxSecureStorage(commandLine, {
        platform: 'linux',
        isTestHarness: true,
        passwordStoreOverride,
      }),
    ).toThrow('CANOPY_LINUX_PASSWORD_STORE must be gnome-libsecret');
    expect(appendSwitch).not.toHaveBeenCalled();
    expect(mockSetUsePlainTextEncryption).not.toHaveBeenCalled();
  },
);

test.each([undefined, null, false, 'not-a-function'])(
  'missing native startup API %p fails closed',
  (setter) => {
    mockStorage.setUsePlainTextEncryption = setter;
    expect(() =>
      configureLinuxSecureStorage(commandLine, {
        platform: 'linux',
        isTestHarness: false,
      }),
    ).toThrow('Secure storage write refused: encryption unavailable.');
    expect(mockSetUsePlainTextEncryption).not.toHaveBeenCalled();
  },
);

test('native startup errors abort configuration instead of allowing fallback', () => {
  const failure = new Error('native startup failure');
  mockSetUsePlainTextEncryption.mockImplementationOnce(() => {
    throw failure;
  });
  expect(() =>
    configureLinuxSecureStorage(commandLine, {
      platform: 'linux',
      isTestHarness: false,
    }),
  ).toThrow(failure);
});
