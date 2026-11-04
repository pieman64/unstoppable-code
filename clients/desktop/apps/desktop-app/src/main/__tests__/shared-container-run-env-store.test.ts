import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { isRecord } from '../lib/type-guards';
import { writeFileAtomically } from '../lib/atomic-file';
import {
  projectSharedContainerRunEnvironment,
  readSharedContainerRunEnvironment,
  writeSharedContainerRunEnvironment,
  removeSharedContainerRunEnvironment,
} from '../shared-containers/run-env-store';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(() => Promise.resolve()),
  readFile: jest.fn(),
  writeFile: jest.fn(() => Promise.resolve()),
  rename: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/atomic-file', () => ({ writeFileAtomically: jest.fn() }));
jest.mock('../lib/paths', () => ({
  getSharedContainerRunEnvFilePath: (): string => '/mock/run-env.json',
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
let mockBackend = 'gnome_libsecret';
const mockAvailable = jest.fn(() => true);
const mockEncrypt = jest.fn((text: string) => Buffer.from(`enc:${text}`));
const mockDecrypt = jest.fn((data: Buffer) =>
  data.toString('utf8').replace(/^enc:/, ''),
);
let mockSecretServiceState: 'secure' | 'unavailable' | 'locked' = 'secure';
jest.mock('../lib/linux-secret-service', () => ({
  getLinuxSecretServiceState: (): 'secure' | 'unavailable' | 'locked' =>
    mockSecretServiceState,
}));
jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): 'linux' => 'linux',
}));
jest.mock('electron', () => ({
  app: { isReady: (): boolean => true },
  safeStorage: {
    isEncryptionAvailable: mockAvailable,
    getSelectedStorageBackend: (): string => mockBackend,
    encryptString: mockEncrypt,
    decryptString: mockDecrypt,
  },
}));

let payload: string | null = null;
const readMock = jest.mocked(readFile);
const writeMock = jest.mocked(writeFileAtomically);
const originalEntries = [{ key: 'TOKEN', value: 'original', secret: true }];
function stored(
  containers: Record<string, string> = {
    first: Buffer.from(`enc:${JSON.stringify(originalEntries)}`).toString(
      'base64',
    ),
  },
): string {
  return JSON.stringify({ version: 1, containers });
}
function persistedContainers(): Record<string, string> {
  const parsed: unknown = JSON.parse(payload ?? '{}');
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !isRecord(parsed.containers)
  ) {
    throw new Error('Expected persisted container fixture');
  }
  const entries: Array<[string, string]> = [];
  for (const [id, encrypted] of Object.entries(parsed.containers)) {
    if (typeof encrypted !== 'string')
      throw new Error('Expected encrypted string');
    entries.push([id, encrypted]);
  }
  return Object.fromEntries(entries);
}
function expectNoWrite(): void {
  expect(writeMock).not.toHaveBeenCalled();
  expect(writeFile).not.toHaveBeenCalled();
  expect(rename).not.toHaveBeenCalled();
}
beforeEach(() => {
  mockSecretServiceState = 'secure';
  jest.clearAllMocks();
  mockBackend = 'gnome_libsecret';
  mockAvailable.mockReturnValue(true);
  mockSecretServiceState = 'secure';
  mockEncrypt.mockImplementation((text) => Buffer.from(`enc:${text}`));
  mockDecrypt.mockImplementation((data) =>
    data.toString('utf8').replace(/^enc:/, ''),
  );
  payload = null;
  readMock.mockImplementation(() =>
    payload === null
      ? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      : Promise.resolve(payload),
  );
  writeMock.mockImplementation((_path, data): Promise<void> => {
    payload =
      typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    return Promise.resolve();
  });
});

it('returns [] only for missing stores or valid missing container records', async () => {
  expect(await readSharedContainerRunEnvironment('first')).toEqual([]);
  payload = stored();
  expect(await readSharedContainerRunEnvironment('other')).toEqual([]);
  expect(await readSharedContainerRunEnvironment('../bad')).toEqual([]);
  expectNoWrite();
});
it('writes normalized encrypted values atomically with owner-only permissions', async () => {
  const entries = Array.from({ length: 70 }, (_, index) => ({
    key: `KEY_${index}`,
    value: `${index}`,
  }));
  const result = await writeSharedContainerRunEnvironment('first', entries);
  expect(result).toHaveLength(64);
  expect(writeMock).toHaveBeenCalledWith(
    '/mock/run-env.json',
    expect.any(String),
    { encoding: 'utf8', mode: 0o600 },
  );
  expect(writeFile).not.toHaveBeenCalled();
  expect(rename).not.toHaveBeenCalled();
  expect(await readSharedContainerRunEnvironment('first')).toEqual(
    entries.slice(0, 64),
  );
  // The echo names each stored value; it never carries one (CAN-4411).
  expect(result).toEqual(
    projectSharedContainerRunEnvironment('first', entries.slice(0, 64)),
  );
  expect(result.every((entry) => typeof entry.value === 'object')).toBe(true);
});
it('keeps stored values the echo names and refuses references from elsewhere', async () => {
  payload = stored();
  const [kept] = projectSharedContainerRunEnvironment('first', originalEntries);
  const echo = await writeSharedContainerRunEnvironment('first', [
    kept,
    { key: 'ADDED', value: 'new' },
  ]);
  expect(JSON.stringify(echo)).not.toContain('original');
  expect(await readSharedContainerRunEnvironment('first')).toEqual([
    { key: 'TOKEN', value: 'original', secret: true },
    { key: 'ADDED', value: 'new' },
  ]);
  const before = payload;
  // The same slot in another container is a different reference.
  const [foreign] = projectSharedContainerRunEnvironment('second', [
    { key: 'TOKEN', value: 'x' },
  ]);
  await expect(
    writeSharedContainerRunEnvironment('first', [foreign]),
  ).rejects.toMatchObject({ code: 'stored_secret_unknown' });
  expect(payload).toBe(before);
});
it('replaces an undecryptable record when the save keeps nothing', async () => {
  payload = stored();
  mockDecrypt.mockImplementation(() => {
    throw new Error('wrong key');
  });
  await writeSharedContainerRunEnvironment('first', [
    { key: 'TOKEN', value: 'fresh' },
  ]);
  mockDecrypt.mockImplementation((data) =>
    data.toString('utf8').replace(/^enc:/, ''),
  );
  expect(await readSharedContainerRunEnvironment('first')).toEqual([
    { key: 'TOKEN', value: 'fresh' },
  ]);
});
it.each([
  ['unknown', false, 'unavailable'],
  ['gnome_libsecret', false, 'locked'],
] as const)(
  'refuses %s and retains all ciphertext',
  async (backend, available, state) => {
    payload = stored();
    const previous = payload;
    mockBackend = backend;
    mockAvailable.mockReturnValue(available);
    mockSecretServiceState = state === 'locked' ? 'locked' : 'secure';
    await expect(
      writeSharedContainerRunEnvironment('other', []),
    ).rejects.toMatchObject({ code: 'SECURE_STORAGE_WRITE_REFUSED', state });
    expect(payload).toBe(previous);
    expect(mockEncrypt).not.toHaveBeenCalled();
    expectNoWrite();
  },
);
it('retains existing ciphertext while libsecret is unavailable', async () => {
  payload = stored();
  mockBackend = 'unknown';
  mockAvailable.mockReturnValue(false);
  mockSecretServiceState = 'secure';
  const previous = payload;
  await expect(
    readSharedContainerRunEnvironment('first'),
  ).rejects.toMatchObject({
    code: 'SECURE_STORAGE_READ_UNAVAILABLE',
    state: 'unavailable',
  });
  expect(payload).toBe(previous);
  expectNoWrite();
});
it('reports typed failure and recovers on the same record after unlocking', async () => {
  payload = stored();
  const previous = payload;
  mockAvailable.mockReturnValue(false);
  mockSecretServiceState = 'locked';
  await expect(
    readSharedContainerRunEnvironment('first'),
  ).rejects.toMatchObject({
    code: 'SECURE_STORAGE_READ_UNAVAILABLE',
    state: 'locked',
  });
  expect(payload).toBe(previous);
  expectNoWrite();
  mockAvailable.mockReturnValue(true);
  mockSecretServiceState = 'secure';
  expect(await readSharedContainerRunEnvironment('first')).toEqual(
    originalEntries,
  );
});
it('retains unreadable ciphertext and unrelated containers after decrypt failure', async () => {
  payload = stored({ first: 'ciphertext', unrelated: 'unchanged' });
  const previous = payload;
  mockDecrypt.mockImplementation(() => {
    throw new Error('private diagnostic');
  });
  await expect(
    readSharedContainerRunEnvironment('first'),
  ).rejects.toMatchObject({ code: 'SECURE_STORAGE_DECRYPT_FAILED' });
  expect(payload).toBe(previous);
  expectNoWrite();
});
it.each([
  '{bad json',
  JSON.stringify({ version: 2, containers: {} }),
  JSON.stringify({ version: 1, containers: { first: 42 } }),
])('does not replace or remove from malformed store %s', async (broken) => {
  payload = broken;
  await expect(
    writeSharedContainerRunEnvironment('other', []),
  ).rejects.toThrow();
  await expect(removeSharedContainerRunEnvironment('first')).rejects.toThrow();
  expect(payload).toBe(broken);
  expectNoWrite();
});
it('never turns filesystem errors into absent records during mutation', async () => {
  readMock.mockRejectedValue(
    Object.assign(new Error('denied'), { code: 'EACCES' }),
  );
  await expect(writeSharedContainerRunEnvironment('other', [])).rejects.toThrow(
    'denied',
  );
  await expect(removeSharedContainerRunEnvironment('first')).rejects.toThrow(
    'denied',
  );
  expectNoWrite();
});
it('retains old contents after encryption fails and lets the queue recover', async () => {
  payload = stored({ first: 'ciphertext', unrelated: 'unchanged' });
  const previous = payload;
  mockEncrypt.mockImplementationOnce(() => {
    throw new Error('private diagnostic');
  });
  await expect(
    writeSharedContainerRunEnvironment('second', []),
  ).rejects.toMatchObject({ code: 'SECURE_STORAGE_ENCRYPT_FAILED' });
  expect(payload).toBe(previous);
  expectNoWrite();
  await writeSharedContainerRunEnvironment('second', []);
  expect(persistedContainers()).toMatchObject({
    first: 'ciphertext',
    unrelated: 'unchanged',
  });
});
it('preserves queued unrelated writes and explicitly removes only one container while locked', async () => {
  await Promise.all([
    writeSharedContainerRunEnvironment('first', originalEntries),
    writeSharedContainerRunEnvironment('second', []),
  ]);
  const second = persistedContainers().second;
  mockAvailable.mockReturnValue(false);
  mockSecretServiceState = 'locked';
  await removeSharedContainerRunEnvironment('first');
  expect(persistedContainers()).toEqual({ second });
});
it('rejects invalid write IDs without reading or persisting', () => {
  expect(() => writeSharedContainerRunEnvironment('../bad', [])).toThrow(
    'Invalid shared-container id',
  );
  expect(readMock).not.toHaveBeenCalled();
  expectNoWrite();
});

it('rechecks write permission after asynchronous directory preparation', async () => {
  payload = stored();
  const previous = payload;
  jest.mocked(mkdir).mockImplementationOnce((): Promise<undefined> => {
    mockBackend = 'unknown';
    mockAvailable.mockReturnValue(false);
    mockSecretServiceState = 'secure';
    return Promise.resolve(undefined);
  });
  await expect(
    writeSharedContainerRunEnvironment('second', []),
  ).rejects.toMatchObject({ code: 'SECURE_STORAGE_WRITE_REFUSED' });
  expect(payload).toBe(previous);
  expectNoWrite();
});

it('retains valid prototype-like container IDs and ignores inherited properties as missing', async () => {
  const encrypted = Buffer.from(
    `enc:${JSON.stringify(originalEntries)}`,
  ).toString('base64');
  payload = stored({ ['__proto__']: encrypted, constructor: encrypted });
  expect(await readSharedContainerRunEnvironment('__proto__')).toEqual(
    originalEntries,
  );
  expect(await readSharedContainerRunEnvironment('toString')).toEqual([]);
  await writeSharedContainerRunEnvironment('second', []);
  expect(persistedContainers()).toMatchObject({
    ['__proto__']: encrypted,
    constructor: encrypted,
  });
  writeMock.mockClear();
  await removeSharedContainerRunEnvironment('toString');
  expect(writeMock).not.toHaveBeenCalled();
});
