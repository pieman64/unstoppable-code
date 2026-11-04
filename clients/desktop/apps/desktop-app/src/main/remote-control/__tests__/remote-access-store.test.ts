import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as atomicFile from '../../lib/atomic-file';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WritableSafeStorage } from '../../lib/safe-storage';
import { getSecretStoragePolicy } from '../../lib/secure-storage-policy';
import { generateDeviceKeyPair } from '../crypto/device-key';
import {
  RemoteAccessStore,
  RemoteIdentityUnavailableError,
  type PairedDevice,
} from '../remote-access-store';

jest.mock('node:fs/promises', () => {
  const actual: typeof fsPromises = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    readFile: jest.fn(actual.readFile),
    mkdir: jest.fn(actual.mkdir),
  };
});

jest.mock('../../lib/atomic-file', () => {
  const actual: typeof atomicFile = jest.requireActual('../../lib/atomic-file');
  return {
    ...actual,
    writeFileAtomically: jest.fn(actual.writeFileAtomically),
  };
});

const writeMock = jest.mocked(atomicFile.writeFileAtomically);
const realWrite: typeof atomicFile.writeFileAtomically = jest.requireActual<
  typeof atomicFile
>('../../lib/atomic-file').writeFileAtomically;
const readFileMock = jest.mocked(fsPromises.readFile);
const realReadFile: typeof fsPromises.readFile =
  jest.requireActual<typeof fsPromises>('node:fs/promises').readFile;

let mockPlatform: 'darwin' | 'win32' | 'linux' | null = 'darwin';
let mockBackend = 'gnome_libsecret';
let mockStorage: WritableSafeStorage | null = null;
jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): typeof mockPlatform => mockPlatform,
}));
jest.mock('electron', () => ({
  app: { isReady: (): boolean => true },
  get safeStorage():
    | (WritableSafeStorage & { getSelectedStorageBackend: () => string })
    | null {
    return (
      mockStorage && {
        ...mockStorage,
        getSelectedStorageBackend: (): string => mockBackend,
      }
    );
  },
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../../lib/linux-secret-service', () => ({
  getLinuxSecretServiceState: (): 'secure' => 'secure',
}));
beforeEach(() => {
  mockPlatform = 'darwin';
  mockBackend = 'gnome_libsecret';
  mockStorage = null;
  writeMock.mockClear();
});
const availableStorage: WritableSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`enc:${text}`),
  decryptString: (data) => data.toString('utf8').replace(/^enc:/, ''),
};

const dirs: string[] = [];

function createStore(safeStorage: WritableSafeStorage | null = null): {
  store: RemoteAccessStore;
  identityPath: string;
  settingsPath: string;
} {
  mockStorage = safeStorage;
  const dir = mkdtempSync(join(tmpdir(), 'remote-access-store-'));
  dirs.push(dir);
  const identityPath = join(dir, 'identity.key');
  const settingsPath = join(dir, 'remote-control.json');
  return {
    store: new RemoteAccessStore({
      settingsPath,
      identityPath,
      secretStorage: getSecretStoragePolicy(),
    }),
    identityPath,
    settingsPath,
  };
}

function pairedDevice(name: string): PairedDevice {
  const keyPair = generateDeviceKeyPair();
  return {
    deviceId: keyPair.deviceId,
    name,
    platform: 'darwin',
    publicKey: keyPair.publicKey,
    pairedAt: new Date(0).toISOString(),
  };
}

/** A keychain that is locked: it reports encryption as unavailable. */
const lockedKeychain: WritableSafeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('locked');
  },
  decryptString: () => {
    throw new Error('locked');
  },
};

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('RemoteAccessStore', () => {
  it('keeps every one of several concurrent updates', async () => {
    const { store, settingsPath } = createStore();
    const first = pairedDevice('first');
    const second = pairedDevice('second');
    await Promise.all([
      store.update((current) => ({
        ...current,
        pairedHosts: [...current.pairedHosts, first],
      })),
      store.update((current) => ({
        ...current,
        pairedControllers: [...current.pairedControllers, second],
      })),
      store.update((current) => ({ ...current, allowIncoming: true })),
    ]);
    const saved: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(saved).toEqual(
      expect.objectContaining({
        allowIncoming: true,
        pairedHosts: [first],
        pairedControllers: [second],
      }),
    );
  });

  it('lets a later update see a revocation made by an earlier one', async () => {
    const { store } = createStore();
    const controller = pairedDevice('controller');
    await store.update((current) => ({
      ...current,
      pairedControllers: [controller],
    }));
    const [, renamed] = await Promise.all([
      store.update((current) => ({ ...current, pairedControllers: [] })),
      store.update((current) => ({
        ...current,
        pairedControllers: current.pairedControllers.map((device) => ({
          ...device,
          name: 'renamed',
        })),
      })),
    ]);
    expect(renamed.pairedControllers).toEqual([]);
  });

  it('never lets a slow first read undo a committed change', async () => {
    const { store, settingsPath } = createStore();
    writeFileSync(
      settingsPath,
      JSON.stringify({
        version: 1,
        allowIncoming: true,
        pairedHosts: [],
        pairedControllers: [],
      }),
    );
    let releaseRead = (): void => undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    readFileMock.mockImplementationOnce(
      async (...args: Parameters<typeof fsPromises.readFile>) => {
        // Reads the file as it is now, but answers late.
        const contents = await realReadFile(...args);
        await readGate;
        return contents;
      },
    );
    const slowRead = store.read();
    const revoked = store.update((current) => ({
      ...current,
      allowIncoming: false,
    }));
    // Let the update commit first if it can, then finish the slow read.
    await Promise.race([
      revoked,
      new Promise((resolve) => setTimeout(resolve, 50)),
    ]);
    releaseRead();
    await Promise.all([slowRead, revoked]);
    expect(store.peek()?.allowIncoming).toBe(false);
    expect((await store.read()).allowIncoming).toBe(false);
  });

  it('grants a new pairing only once it is saved', async () => {
    const { store } = createStore();
    const controller = pairedDevice('controller');
    writeMock.mockRejectedValueOnce(new Error('Disk full.'));
    await expect(
      store.update((current) => ({
        ...current,
        allowIncoming: true,
        pairedControllers: [controller],
      })),
    ).rejects.toThrow('Disk full.');
    expect(store.peek()?.allowIncoming).toBe(false);
    expect(store.peek()?.pairedControllers).toEqual([]);
  });

  it('keeps a revocation in effect even when saving it fails', async () => {
    const { store } = createStore();
    const controller = pairedDevice('controller');
    await store.update((current) => ({
      ...current,
      allowIncoming: true,
      pairedControllers: [controller],
    }));
    writeMock.mockRejectedValueOnce(new Error('Disk full.'));
    await expect(
      store.update((current) => ({
        ...current,
        allowIncoming: false,
        pairedControllers: [],
      })),
    ).rejects.toThrow('Disk full.');
    expect(store.peek()?.allowIncoming).toBe(false);
    expect(store.peek()?.pairedControllers).toEqual([]);
  });

  it('becomes idle once every queued update has finished, failed ones included', async () => {
    const { store, settingsPath } = createStore();
    const controller = pairedDevice('controller');
    let releaseWrite = (): void => undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    writeMock.mockRejectedValueOnce(new Error('Disk full.'));
    writeMock.mockImplementationOnce(async (...args) => {
      await writeGate;
      return realWrite(...args);
    });
    const failed = store.update((current) => ({
      ...current,
      allowIncoming: true,
    }));
    const saved = store.update((current) => ({
      ...current,
      pairedControllers: [controller],
    }));
    let idle = false;
    const idling = store.whenIdle().then(() => {
      idle = true;
    });
    await expect(failed).rejects.toThrow('Disk full.');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(idle).toBe(false);
    releaseWrite();
    await idling;
    await expect(saved).resolves.toEqual(
      expect.objectContaining({ pairedControllers: [controller] }),
    );
    const onDisk: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(onDisk).toEqual(
      expect.objectContaining({
        allowIncoming: false,
        pairedControllers: [controller],
      }),
    );
  });

  it('creates a key once and reads it back', async () => {
    const { store, identityPath } = createStore();
    const [first, again] = await Promise.all([
      store.identity(),
      store.identity(),
    ]);
    expect(again.deviceId).toBe(first.deviceId);
    const reopened = new RemoteAccessStore({
      settingsPath: join(identityPath, '..', 'remote-control.json'),
      identityPath,
      secretStorage: getSecretStoragePolicy(),
    });
    expect((await reopened.identity()).deviceId).toBe(first.deviceId);
  });

  it('never replaces a key it cannot decrypt', async () => {
    const { store, identityPath } = createStore(lockedKeychain);
    const original = 'safe-storage:ZW5jcnlwdGVk\n';
    writeFileSync(identityPath, original);
    await expect(store.identity()).rejects.toBeInstanceOf(
      RemoteIdentityUnavailableError,
    );
    expect(readFileSync(identityPath, 'utf8')).toBe(original);
  });

  it('never replaces a key file it does not understand', async () => {
    const { store, identityPath } = createStore();
    writeFileSync(identityPath, 'garbage\n');
    await expect(store.identity()).rejects.toBeInstanceOf(
      RemoteIdentityUnavailableError,
    );
    expect(readFileSync(identityPath, 'utf8')).toBe('garbage\n');
  });
});

describe('remote identity policy retention', () => {
  it.each(['unknown', 'gnome_libsecret'])(
    'refuses new Linux identity on %s without writing pkcs8',
    async (backend) => {
      mockPlatform = 'linux';
      mockBackend = backend;
      const { store } = createStore(lockedKeychain);
      await expect(store.identity()).rejects.toMatchObject({
        code: 'SECURE_STORAGE_WRITE_REFUSED',
      });
      expect(writeMock).not.toHaveBeenCalled();
    },
  );
  it('refuses new Linux identity with no storage instead of creating plaintext', async () => {
    mockPlatform = 'linux';
    const { store } = createStore();
    await expect(store.identity()).rejects.toMatchObject({
      code: 'SECURE_STORAGE_WRITE_REFUSED',
    });
    expect(writeMock).not.toHaveBeenCalled();
  });
  it('retains encrypted identity and retries on the same store after unlock', async () => {
    const {
      store: initial,
      identityPath,
      settingsPath,
    } = createStore(availableStorage);
    const originalIdentity = await initial.identity();
    const original = readFileSync(identityPath, 'utf8');
    mockStorage = lockedKeychain;
    const reopened = new RemoteAccessStore({
      identityPath,
      settingsPath,
      secretStorage: getSecretStoragePolicy(),
    });
    await expect(reopened.identity()).rejects.toMatchObject({
      secureStorageFailure: { code: 'SECURE_STORAGE_READ_UNAVAILABLE' },
    });
    expect(readFileSync(identityPath, 'utf8')).toBe(original);
    mockStorage = availableStorage;
    expect((await reopened.identity()).deviceId).toBe(
      originalIdentity.deviceId,
    );
    expect(readFileSync(identityPath, 'utf8')).toBe(original);
  });
  it('does not fall back after native availability probing fails', async () => {
    const { store } = createStore({
      ...availableStorage,
      isEncryptionAvailable: () => {
        throw new Error('private diagnostic');
      },
    });
    await expect(store.identity()).rejects.toMatchObject({
      code: 'SECURE_STORAGE_PROBE_FAILED',
    });
    expect(writeMock).not.toHaveBeenCalled();
  });
});

it('rechecks encrypted identity permission after asynchronous directory preparation', async () => {
  mockPlatform = 'linux';
  const { store } = createStore(availableStorage);
  const realMkdir =
    jest.requireActual<typeof fsPromises>('node:fs/promises').mkdir;
  const mkdirMock = jest.mocked(fsPromises.mkdir);
  mkdirMock.mockImplementationOnce(async (...args) => {
    const result = await realMkdir(...args);
    mockStorage = lockedKeychain;
    return result;
  });
  await expect(store.identity()).rejects.toMatchObject({
    code: 'SECURE_STORAGE_WRITE_REFUSED',
  });
  expect(writeMock).not.toHaveBeenCalled();
});

it.each(['darwin', 'win32'] as const)(
  'keeps the explicit unavailable plaintext fallback on %s',
  async (platform) => {
    mockPlatform = platform;
    const { store, identityPath } = createStore(lockedKeychain);
    const identity = await store.identity();
    expect(readFileSync(identityPath, 'utf8')).toMatch(/^pkcs8:/);
    const reopened = new RemoteAccessStore({
      identityPath,
      settingsPath: join(identityPath, '..', 'remote-control.json'),
      secretStorage: getSecretStoragePolicy(),
    });
    expect((await reopened.identity()).deviceId).toBe(identity.deviceId);
  },
);
it('reads existing pkcs8 identities on Linux without a keyring', async () => {
  const { store, identityPath } = createStore();
  const identity = await store.identity();
  const original = readFileSync(identityPath, 'utf8');
  mockPlatform = 'linux';
  const reopened = new RemoteAccessStore({
    identityPath,
    settingsPath: join(identityPath, '..', 'remote-control.json'),
    secretStorage: getSecretStoragePolicy(),
  });
  expect((await reopened.identity()).deviceId).toBe(identity.deviceId);
  expect(readFileSync(identityPath, 'utf8')).toBe(original);
});
it('does not create plaintext identities on unsupported platforms', async () => {
  mockPlatform = null;
  const { store } = createStore(availableStorage);
  await expect(store.identity()).rejects.toMatchObject({
    code: 'SECURE_STORAGE_WRITE_REFUSED',
    state: 'unavailable',
  });
  expect(writeMock).not.toHaveBeenCalled();
});
it('retains encrypted identity on libsecret decryption failure and recovers without replacement', async () => {
  const {
    store: initial,
    identityPath,
    settingsPath,
  } = createStore(availableStorage);
  const identity = await initial.identity();
  const original = readFileSync(identityPath, 'utf8');
  mockPlatform = 'linux';
  mockBackend = 'gnome_libsecret';
  mockStorage = {
    ...availableStorage,
    decryptString: (): never => {
      throw new Error('private diagnostic');
    },
  };
  const reopened = new RemoteAccessStore({
    identityPath,
    settingsPath,
    secretStorage: getSecretStoragePolicy(),
  });
  await expect(reopened.identity()).rejects.toMatchObject({
    secureStorageFailure: {
      code: 'SECURE_STORAGE_DECRYPT_FAILED',
      backend: 'gnome_libsecret',
    },
  });
  expect(readFileSync(identityPath, 'utf8')).toBe(original);
  mockBackend = 'gnome_libsecret';
  mockStorage = availableStorage;
  expect((await reopened.identity()).deviceId).toBe(identity.deviceId);
  expect(readFileSync(identityPath, 'utf8')).toBe(original);
});
