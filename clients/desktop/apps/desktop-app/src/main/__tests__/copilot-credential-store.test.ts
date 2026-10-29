import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

import {
  clearCopilotCredential,
  isCopilotCredentialStorageAvailable,
  readCopilotCredential,
  saveCopilotCredential,
  type CopilotCredential,
} from '../copilot/credential-store';

const credential: CopilotCredential = {
  version: 1,
  clientId: 'Iv23test',
  host: 'https://github.com',
  login: 'octocat',
  id: '1',
  accessToken: 'ghu_access',
  accessTokenExpiresAt: '2026-10-05T00:00:00.000Z',
  refreshToken: 'ghr_refresh',
  refreshTokenExpiresAt: '2027-04-01T00:00:00.000Z',
};

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
    await saveCopilotCredential(credential);
    const raw = await readFile(join(root, 'copilot-account.enc'));
    // The fake encryptor keeps the payload visible; what matters is that the
    // file holds exactly the encryptor's output, never the raw JSON.
    expect(raw.toString('utf8').startsWith('encrypted:')).toBe(true);
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith(
      JSON.stringify(credential),
    );
    await expect(readCopilotCredential()).resolves.toEqual({
      status: 'present',
      credential,
    });
  });

  it('refuses to save without encryption and reports unavailable', async () => {
    safeStorageMock.encryptionAvailable = false;
    expect(isCopilotCredentialStorageAvailable()).toBe(false);
    await expect(saveCopilotCredential(credential)).rejects.toThrow(
      "Couldn't store the Copilot sign-in on this device.",
    );
  });

  it('reports unreadable, and keeps the file, when decryption fails', async () => {
    await saveCopilotCredential(credential);
    safeStorageMock.decryptString.mockImplementationOnce(() => {
      throw new Error('keychain locked');
    });
    await expect(readCopilotCredential()).resolves.toMatchObject({
      status: 'unreadable',
      secureStorageFailure: { code: 'SECURE_STORAGE_DECRYPT_FAILED' },
    });
    await expect(
      readFile(join(root, 'copilot-account.enc')),
    ).resolves.toBeDefined();
  });

  it('treats a decrypted payload with the wrong shape as unreadable', async () => {
    await writeFile(
      join(root, 'copilot-account.enc'),
      Buffer.from('encrypted:{"version":1,"login":"x"}'),
    );
    await expect(readCopilotCredential()).resolves.toEqual({
      status: 'unreadable',
    });
  });

  it('clears the credential and tolerates a missing file', async () => {
    await saveCopilotCredential(credential);
    await clearCopilotCredential();
    await expect(readCopilotCredential()).resolves.toEqual({
      status: 'absent',
    });
    await expect(clearCopilotCredential()).resolves.toBeUndefined();
  });
  it('retains a credential and exposes typed metadata on refused saves', async () => {
    await saveCopilotCredential(credential);
    const before = await readFile(join(root, 'copilot-account.enc'));
    safeStorageMock.encryptionAvailable = false;
    await expect(
      saveCopilotCredential({ ...credential, accessToken: 'replacement' }),
    ).rejects.toMatchObject({
      message: "Couldn't store the Copilot sign-in on this device.",
      secureStorageFailure: { code: 'SECURE_STORAGE_WRITE_REFUSED' },
    });
    await expect(readCopilotCredential()).resolves.toMatchObject({
      status: 'unreadable',
      secureStorageFailure: { code: 'SECURE_STORAGE_READ_UNAVAILABLE' },
    });
    expect(await readFile(join(root, 'copilot-account.enc'))).toEqual(before);
    safeStorageMock.encryptionAvailable = true;
    await expect(readCopilotCredential()).resolves.toMatchObject({
      status: 'present',
      credential,
    });
  });
});
