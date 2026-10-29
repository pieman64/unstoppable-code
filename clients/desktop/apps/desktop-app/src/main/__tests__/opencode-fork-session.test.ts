import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import type * as fileSystem from 'node:fs/promises';
import type * as sessionFork from '@canopy/desktop-shared/node/opencode/session-fork';
import {
  saveOpenCodeCapabilitySnapshot,
  readOpenCodeCapabilityBinding,
} from '@canopy/desktop-shared/node/opencode/capability-snapshot';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let mockRoot: string;
const mockClose = jest.fn(() => Promise.resolve());
const mockGeneration = jest.fn();
const mockOpen = jest.fn(({ signal }: { signal: AbortSignal }) =>
  Promise.resolve({
    executable: 'verified',
    env: {},
    signal,
    generation: 1,
    close: mockClose,
  }),
);
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof fileSystem>('node:fs/promises');
  return { ...actual, writeFile: jest.fn(actual.writeFile) };
});
const mockTransfer = jest.fn(
  (options: sessionFork.OpenCodeSessionForkOptions) =>
    jest
      .requireActual<
        typeof sessionFork
      >('@canopy/desktop-shared/node/opencode/session-fork')
      .forkOpenCodeSession(options),
);
const mockDiscard = jest.fn(
  (options: Parameters<typeof sessionFork.discardOpenCodeSessionFork>[0]) =>
    jest
      .requireActual<
        typeof sessionFork
      >('@canopy/desktop-shared/node/opencode/session-fork')
      .discardOpenCodeSessionFork(options),
);
jest.mock('@canopy/desktop-shared/node/opencode/session-fork', () => ({
  forkOpenCodeSession: mockTransfer,
  discardOpenCodeSessionFork: mockDiscard,
}));
const mockSessions = new Map<
  string,
  {
    id: string;
    location: { directory: string };
    time: { created: number };
    fork?: { sessionID: string };
  }
>();
let mockDiskFull = false;
let mockRemoveFailure: Error | undefined;
const mockRuntimeWriteError = new Error('runtime configuration disk full');
const mockNativeClose = jest.fn(() => Promise.resolve());
const mockManage = jest.fn((id: string, operation: string): Promise<void> => {
  if (id !== 'native-fork' || operation !== 'remove')
    throw new Error('unexpected native mutation');
  if (mockRemoveFailure) return Promise.reject(mockRemoveFailure);
  mockSessions.delete(id);
  return Promise.resolve();
});
const mockStart = jest.fn(() => {
  if (mockDiskFull) return Promise.reject(mockRuntimeWriteError);
  let closed = false;
  return Promise.resolve({
    client: {
      loadSession: () => Promise.resolve({}),
      forkSession: () => {
        mockSessions.set('native-fork', {
          id: 'native-fork',
          location: { directory: mockRoot },
          time: { created: Date.now() },
          fork: { sessionID: 'source-native' },
        });
        return Promise.resolve({ sessionId: 'native-fork' });
      },
    },
    readMetadata: (path: string) =>
      Promise.resolve(
        structuredClone(
          path.endsWith('/context')
            ? { data: [] }
            : mockSessions.get(path.split('/')[2]),
        ),
      ),
    manageFork: (id: string, operation: string) => {
      if (closed) return Promise.reject(new Error('creator already closed'));
      return mockManage(id, operation);
    },
    close: () => {
      closed = true;
      return mockNativeClose();
    },
  });
});
jest.mock('@canopy/desktop-shared/node/opencode/runtime', () => ({
  startOpenCodeRuntime: mockStart,
}));
jest.mock('../opencode/connection', () => ({
  openManagedOpenCodeRuntime: mockOpen,
  assertOpenCodeConnectionGeneration: mockGeneration,
}));
jest.mock(
  '../opencode/session-profile',
  () => ({
    getOpenCodeSessionProfile: ({ chatId }: { chatId: string }): string =>
      join(mockRoot, chatId),
  }),
  { virtual: true },
);
import {
  forkOpenCodeSessionByIdViaOneShot,
  discardUnpublishedOpenCodeFork,
} from '../opencode/fork-session';

function options(): Parameters<typeof forkOpenCodeSessionByIdViaOneShot>[0] {
  return {
    projectId: 'project',
    worktreeId: 'target',
    chatId: 'fork',
    cwd: mockRoot,
    sourceProjectId: 'project',
    sourceWorktreeId: 'source',
    sourceChatId: 'original',
    sourceCwd: mockRoot,
    sourceSessionId: 'source-native',
  };
}
beforeEach(async () => {
  jest.clearAllMocks();
  jest
    .mocked(writeFile)
    .mockReset()
    .mockImplementation(
      jest.requireActual<typeof fileSystem>('node:fs/promises').writeFile,
    );
  mockDiskFull = false;
  mockRemoveFailure = undefined;
  mockSessions.clear();
  mockRoot = await realpath(
    await mkdtemp(join(tmpdir(), 'opencode-host-fork-')),
  );
  await mkdir(join(mockRoot, 'original'));
  mockSessions.set('source-native', {
    id: 'source-native',
    location: { directory: mockRoot },
    time: { created: 1 },
  });
  await saveOpenCodeCapabilitySnapshot(
    join(mockRoot, 'original'),
    'source-native',
    {
      version: 1,
      runtime: {},
      files: {},
      mcp: [],
      contextDigest: 'original',
      providerSettingsDigest: 'original',
    },
    undefined,
    AbortSignal.timeout(5000),
  );
  await writeFile(
    join(mockRoot, 'original', 'host-session.json'),
    JSON.stringify({ version: 1, sessionId: 'source-native', cwd: mockRoot }),
  );
});
afterEach(async () => {
  await rm(mockRoot, { recursive: true, force: true });
});
it('shares one transfer and durably binds its new native ID before returning', async () => {
  const opts = options();
  await expect(
    Promise.all([
      forkOpenCodeSessionByIdViaOneShot(opts),
      forkOpenCodeSessionByIdViaOneShot(opts),
    ]),
  ).resolves.toEqual(['native-fork', 'native-fork']);
  expect(mockTransfer).toHaveBeenCalledTimes(1);
  expect(mockClose).toHaveBeenCalledTimes(1);
  const binding = await readOpenCodeCapabilityBinding(
    join(mockRoot, 'fork'),
    'native-fork',
  );
  expect(
    JSON.parse(
      await readFile(join(mockRoot, 'fork', 'host-session.json'), 'utf8'),
    ),
  ).toEqual({
    version: 1,
    sessionId: 'native-fork',
    cwd: mockRoot,
    capabilityDigest: binding?.digest,
    resourceGeneration: binding?.generation,
  });
});
it('refuses a mismatched source binding before starting a native runtime', async () => {
  await expect(
    forkOpenCodeSessionByIdViaOneShot({
      ...options(),
      sourceSessionId: 'foreign',
    }),
  ).rejects.toThrow('source');
  expect(mockOpen).not.toHaveBeenCalled();
  expect(mockTransfer).not.toHaveBeenCalled();
});
it('removes its new native session and profile if connection revocation prevents publication', async () => {
  mockGeneration
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => {
      throw new Error('revoked');
    });
  await expect(forkOpenCodeSessionByIdViaOneShot(options())).rejects.toThrow(
    'revoked',
  );
  expect(await readdir(mockRoot)).toEqual(['original']);
  expect(mockManage).toHaveBeenCalledWith('native-fork', 'remove');
  expect(mockClose).toHaveBeenCalledTimes(1);
});

it('discards only its exact unpublished native identity', async () => {
  await forkOpenCodeSessionByIdViaOneShot(options());
  await expect(
    discardUnpublishedOpenCodeFork({ ...options(), sessionId: 'foreign' }),
  ).rejects.toThrow('match');
  expect(await readdir(mockRoot)).toEqual(['fork', 'original']);
  await discardUnpublishedOpenCodeFork({
    ...options(),
    sessionId: 'native-fork',
  });
  expect(await readdir(mockRoot)).toEqual(['original']);
  expect(mockDiscard).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'native-fork' }),
  );
});

it.each([
  { removeFails: false, leaseFails: false },
  { removeFails: true, leaseFails: false },
  { removeFails: true, leaseFails: true },
])(
  'rolls back a host-binding write failure, native removal fails=$removeFails, lease close fails=$leaseFails',
  async ({ removeFails, leaseFails }) => {
    const writeError = Object.assign(new Error('host binding disk full'), {
      code: 'ENOSPC',
    });
    const removeError = new Error('native remove failed');
    const leaseError = new Error('lease close failed');
    if (leaseFails) mockClose.mockRejectedValueOnce(leaseError);
    if (removeFails) mockRemoveFailure = removeError;
    const original = structuredClone(mockSessions.get('source-native'));
    const actualWrite =
      jest.requireActual<typeof fileSystem>('node:fs/promises').writeFile;
    jest.mocked(writeFile).mockImplementation((file, ...args) => {
      if (file === join(mockRoot, 'fork', 'host-session.json')) {
        mockDiskFull = true;
        return Promise.reject(writeError);
      }
      return actualWrite(file, ...args);
    });

    const result = forkOpenCodeSessionByIdViaOneShot(options());
    if (leaseFails) {
      await expect(result).rejects.toMatchObject({
        cause: {
          cause: writeError,
          errors: [writeError, removeError, mockRuntimeWriteError],
        },
        errors: [{ cause: writeError }, leaseError],
      });
    } else if (removeFails) {
      await expect(result).rejects.toMatchObject({
        cause: writeError,
        errors: [writeError, removeError, mockRuntimeWriteError],
      });
    } else {
      await expect(result).rejects.toBe(writeError);
    }
    expect(mockSessions.get('source-native')).toEqual(original);
    expect(mockSessions.has('native-fork')).toBe(removeFails);
    expect(await readdir(mockRoot)).toEqual(
      removeFails ? ['fork', 'original'] : ['original'],
    );
    if (removeFails)
      expect(await readdir(join(mockRoot, 'fork'))).toContain(
        'native-fork-recovery.json',
      );
    expect(mockStart).toHaveBeenCalledTimes(removeFails ? 2 : 1);
    expect(mockNativeClose).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledTimes(1);
  },
);
