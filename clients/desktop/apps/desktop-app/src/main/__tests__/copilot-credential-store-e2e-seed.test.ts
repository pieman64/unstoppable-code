import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface SafeStorageMock {
  isEncryptionAvailable: jest.Mock<boolean, []>;
  encryptString: jest.Mock<Buffer, [string]>;
  decryptString: jest.Mock<string, [Buffer]>;
}
const safeStorageMock: SafeStorageMock = {
  isEncryptionAvailable: jest.fn((): boolean => true),
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
jest.mock('../lib/e2e-gate', () => ({ isE2eBuild: (): boolean => true }));

import {
  clearCopilotCredential,
  readCopilotCredential,
} from '../copilot/credential-store';

describe('Copilot credential E2E seed', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copilot-credential-seed-'));
    process.env.CANOPY_E2E_COPILOT_CREDENTIAL = JSON.stringify({
      version: 1,
      clientId: 'Iv23test',
      host: 'https://github.com',
      login: 'seeded',
      id: '7',
      accessToken: 'ghu_seeded',
      accessTokenExpiresAt: '2026-10-05T00:00:00.000Z',
      refreshToken: 'ghr_seeded',
      refreshTokenExpiresAt: '2027-04-01T00:00:00.000Z',
    });
  });
  afterEach(async () => {
    delete process.env.CANOPY_E2E_COPILOT_CREDENTIAL;
    await rm(root, { recursive: true, force: true });
  });

  it('seeds the grant once, then honours a later sign-out', async () => {
    await expect(readCopilotCredential()).resolves.toMatchObject({
      status: 'present',
      credential: { login: 'seeded' },
    });
    await clearCopilotCredential();
    await expect(readCopilotCredential()).resolves.toEqual({
      status: 'absent',
    });
  });
});
