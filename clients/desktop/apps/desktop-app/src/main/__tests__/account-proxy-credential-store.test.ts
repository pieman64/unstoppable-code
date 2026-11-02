let payload: string | null = null;

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn((): Promise<void> => Promise.resolve()),
  readFile: jest.fn(
    (): Promise<string> =>
      payload === null
        ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        : Promise.resolve(payload),
  ),
}));
jest.mock('../lib/atomic-file', () => ({
  writeFileAtomically: jest.fn((_path: string, data: string): Promise<void> => {
    payload = data;
    return Promise.resolve();
  }),
}));
jest.mock('../lib/paths', () => ({
  getAccountProxyCredentialStorePath: (): string =>
    '/mock/account-proxy-credentials.json',
}));
const nativeStorage = {
  isEncryptionAvailable: jest.fn((): boolean => true),
  getSelectedStorageBackend: jest.fn((): string => 'gnome_libsecret'),
  encryptString: jest.fn(
    (value: string): Buffer => Buffer.from(`encrypted:${value}`),
  ),
  decryptString: jest.fn((value: Buffer): string =>
    value.toString('utf8').replace(/^encrypted:/, ''),
  ),
};
jest.mock('electron', () => ({
  app: { isReady: (): boolean => true },
  get safeStorage(): typeof nativeStorage {
    return nativeStorage;
  },
}));

import {
  loadAccountProxyCredentials,
  markAccountProxyKeyRejected,
  resetAccountProxyCredentialStoreForTests,
  saveAccountProxyCredentials,
} from '../lib/account-proxy-credential-store';

beforeEach(() => {
  payload = null;
  nativeStorage.isEncryptionAvailable.mockReturnValue(true);
  jest.clearAllMocks();
  nativeStorage.encryptString.mockImplementation((value) =>
    Buffer.from(`encrypted:${value}`),
  );
  nativeStorage.decryptString.mockImplementation((value) =>
    value.toString().replace(/^encrypted:/, ''),
  );
  resetAccountProxyCredentialStoreForTests();
});

describe('account proxy credential store', () => {
  it('keeps a rejection with the key it belongs to until a key is saved', async () => {
    await saveAccountProxyCredentials('connection-1', {
      managementKey: 'mk-old',
      clientKey: 'canopy-device',
    });
    await markAccountProxyKeyRejected(
      'connection-1',
      { code: 'unauthorized', at: 1 },
      'mk-old',
    );
    await expect(loadAccountProxyCredentials('connection-1')).resolves.toEqual({
      managementKey: 'mk-old',
      clientKey: 'canopy-device',
      keyRejection: { code: 'unauthorized', at: 1 },
    });
    await saveAccountProxyCredentials('connection-1', {
      managementKey: 'mk-new',
      clientKey: null,
    });
    await expect(
      loadAccountProxyCredentials('connection-1'),
    ).resolves.toMatchObject({ managementKey: 'mk-new', keyRejection: null });
  });

  it('never marks a replacement key with the old key rejection', async () => {
    await saveAccountProxyCredentials('connection-1', {
      managementKey: 'mk-new',
      clientKey: null,
    });
    await markAccountProxyKeyRejected(
      'connection-1',
      { code: 'unauthorized', at: 1 },
      'mk-old',
    );
    await expect(
      loadAccountProxyCredentials('connection-1'),
    ).resolves.toMatchObject({ managementKey: 'mk-new', keyRejection: null });
  });
});

it.each(['{bad-json', JSON.stringify({ version: 99, records: {} })])(
  'retains an unreadable existing store on save: %s',
  async (raw) => {
    payload = raw;
    await expect(
      saveAccountProxyCredentials('connection-1', {
        managementKey: 'new',
        clientKey: null,
      }),
    ).rejects.toThrow();
    expect(payload).toBe(raw);
  },
);

it('rejects a bound-key decrypt failure without committing rejection metadata', async () => {
  await saveAccountProxyCredentials('one', {
    managementKey: 'old',
    clientKey: 'client',
  });
  const before = payload;
  nativeStorage.decryptString.mockImplementationOnce(() => {
    throw new Error('native diagnostic');
  });
  await expect(
    markAccountProxyKeyRejected('one', { code: 'blocked', at: 1 }, 'old'),
  ).rejects.toMatchObject({
    secureStorageFailure: { code: 'SECURE_STORAGE_DECRYPT_FAILED' },
  });
  expect(payload).toBe(before);
  await expect(loadAccountProxyCredentials('one')).resolves.toMatchObject({
    managementKey: 'old',
    keyRejection: null,
  });
});

it('retains the complete store when the second encrypted field fails', async () => {
  await saveAccountProxyCredentials('one', {
    managementKey: 'old',
    clientKey: 'old-client',
  });
  await saveAccountProxyCredentials('other', {
    managementKey: 'unrelated',
    clientKey: null,
  });
  const before = payload;
  nativeStorage.encryptString
    .mockImplementationOnce((text) => Buffer.from(text))
    .mockImplementationOnce(() => {
      throw new Error('native diagnostic');
    });
  await expect(
    saveAccountProxyCredentials('one', {
      managementKey: 'new',
      clientKey: 'new-client',
    }),
  ).rejects.toMatchObject({
    secureStorageFailure: { code: 'SECURE_STORAGE_ENCRYPT_FAILED' },
  });
  expect(payload).toBe(before);
});
