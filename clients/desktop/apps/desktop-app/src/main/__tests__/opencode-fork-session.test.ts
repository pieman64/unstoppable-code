import {
  mkdtemp,
  lstat,
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
  get forkOpenCodeSession(): typeof mockTransfer {
    return mockTransfer;
  },
  get discardOpenCodeSessionFork(): typeof mockDiscard {
    return mockDiscard;
  },
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
  get startOpenCodeRuntime(): typeof mockStart {
    return mockStart;
  },
}));
jest.mock('../opencode/connection', () => ({
  get openManagedOpenCodeRuntime(): typeof mockOpen {
    return mockOpen;
  },
  get assertOpenCodeConnectionGeneration(): typeof mockGeneration {
    return mockGeneration;
  },
}));
jest.mock(
  '../opencode/session-profile',
  () => ({
    getOpenCodeSessionProfile: ({ chatId }: { chatId: string }): string =>
      join(mockRoot, chatId),
  }),
  { virtual: true },
);
import type {
  OpenCodeExecutionRuntime,
  openOpenCodeExecutionRuntime,
} from '../opencode/execution-runtime';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  prepareOpenCodeInferenceRoute,
  type OpenCodeInferenceRoute,
} from '@canopy/desktop-shared/node/opencode/inference-route';
const mockRoute: OpenCodeInferenceRoute = {
  bindingKey: 'a'.repeat(64),
  protocol: 'openai-responses',
  baseUrl: `http://127.0.0.1:54321/codex-gateway/${'b'.repeat(48)}`,
  model: {
    id: 'provider/model',
    contextWindow: 128000,
    outputLimit: 16384,
    supportsVision: false,
  },
};
let mockSourceOwner: WorkOwner | undefined;
let mockDestinationOwner: WorkOwner | undefined;
let mockChangedFunding = false;
let mockLeaseController = new AbortController();
const mockExecutionClose = jest.fn(() => Promise.resolve());
const mockExecutionOpen = jest.fn(
  async (
    input: Parameters<typeof openOpenCodeExecutionRuntime>[0],
  ): Promise<OpenCodeExecutionRuntime> => {
    const attribution = await input.attribution();
    if (!attribution.workOwner) throw new Error('work owner unavailable');
    return {
      executable: 'verified',
      env: {},
      providerConfig: {},
      generation: 1,
      runtimeIdentity: { version: '1.18.34', platform: 'darwin-arm64' },
      signal: AbortSignal.any([input.signal, mockLeaseController.signal]),
      close: mockExecutionClose,
      rawModelId: 'canopy-inference/provider/model',
      supportedThinkingLevels: [],
      accountScope: 'ai_credits',
      inferenceFunding: 'ai-credits',
      inferenceRoute: {
        ...mockRoute,
        bindingKey:
          mockChangedFunding && input.workspaceId === 'destination-project'
            ? 'c'.repeat(64)
            : mockRoute.bindingKey,
      },
    };
  },
);
const mockSourceAttribution = jest.fn(() =>
  Promise.resolve({ workOwner: mockSourceOwner, workspaceName: 'Source' }),
);
const mockDestinationNames = jest.fn(() =>
  Promise.resolve({ workspaceName: 'Destination' }),
);
const mockResolveDestinationOwner = jest.fn(() =>
  Promise.resolve(mockDestinationOwner),
);
jest.mock('../opencode/execution-runtime', (): unknown => ({
  openOpenCodeExecutionRuntime: (
    input: Parameters<typeof openOpenCodeExecutionRuntime>[0],
  ) => mockExecutionOpen(input),
}));
jest.mock('../agents/ai-credits-routing', (): unknown => ({
  resolveSessionAiCreditsAttribution: () => mockSourceAttribution(),
  resolveAiCreditsAttribution: () => mockDestinationNames(),
}));
jest.mock('../agents/work-owner', (): unknown => ({
  resolveBackgroundWorkOwner: () => mockResolveDestinationOwner(),
}));
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
  mockGeneration.mockReset();
  mockNativeClose.mockReset().mockResolvedValue();
  mockLeaseController = new AbortController();
  mockExecutionClose.mockReset().mockImplementation(() => {
    mockLeaseController.abort(new Error('lease disposed'));
    return Promise.resolve();
  });
  mockSourceOwner = { kind: 'personal' };
  mockDestinationOwner = { kind: 'personal' };
  mockChangedFunding = false;
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
  ).resolves.toEqual([
    { sessionId: 'native-fork' },
    { sessionId: 'native-fork' },
  ]);
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

it.each<OpenCodeInferenceRoute['protocol']>([
  'anthropic-messages',
  'openai-responses',
])(
  'opens %s forks with source and destination funding authority',
  async (protocol) => {
    mockRoute.protocol = protocol;
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
        inferenceRouteDigest:
          prepareOpenCodeInferenceRoute(mockRoute).identityDigest,
      },
      undefined,
      AbortSignal.timeout(5000),
    );
    const request = {
      ...options(),
      projectId: 'destination-project',
      model: 'gateway-model',
    };
    const result = await forkOpenCodeSessionByIdViaOneShot(request);
    expect(result).toEqual({
      sessionId: 'native-fork',
      executionContext: 'personal',
    });
    expect(mockExecutionOpen).toHaveBeenCalledTimes(2);
    expect(mockExecutionOpen.mock.calls[0]?.[0]).toMatchObject({
      model: 'gateway-model',
      workspaceId: 'project',
    });
    expect(mockExecutionOpen.mock.calls[1]?.[0]).toMatchObject({
      model: 'gateway-model',
      workspaceId: 'destination-project',
      expectedInferenceBindingKey: mockRoute.bindingKey,
    });
    expect(mockTransfer.mock.calls[0]?.[0]).toMatchObject({
      inferenceRoute: mockRoute,
    });
    expect(mockExecutionClose).toHaveBeenCalledTimes(2);
    expect(mockOpen).not.toHaveBeenCalled();
  },
);
it('rejects missing source owner before opening a managed fork', async () => {
  mockSourceOwner = undefined;
  const request = { ...options(), model: 'gateway-model' };
  await expect(forkOpenCodeSessionByIdViaOneShot(request)).rejects.toThrow(
    'work owner',
  );
  expect(mockExecutionOpen).not.toHaveBeenCalled();
  expect(mockTransfer).not.toHaveBeenCalled();
});
it('rejects changed funding before transferring a managed source', async () => {
  mockChangedFunding = true;
  const request = {
    ...options(),
    projectId: 'destination-project',
    model: 'gateway-model',
  };
  await expect(forkOpenCodeSessionByIdViaOneShot(request)).rejects.toThrow(
    'funding',
  );
  expect(mockTransfer).not.toHaveBeenCalled();
  expect(mockExecutionClose).toHaveBeenCalledTimes(2);
  expect(await readdir(mockRoot)).toEqual(['original']);
});
it('releases source authority if destination authority is unavailable', async () => {
  mockDestinationOwner = undefined;
  const request = {
    ...options(),
    projectId: 'destination-project',
    model: 'gateway-model',
  };
  await expect(forkOpenCodeSessionByIdViaOneShot(request)).rejects.toThrow(
    'work owner',
  );
  expect(mockTransfer).not.toHaveBeenCalled();
  expect(await readdir(mockRoot)).toEqual(['original']);
});

it('removes an unpublished fork when runtime cleanup fails', async () => {
  mockClose.mockRejectedValueOnce(new Error('cleanup failed'));
  await expect(forkOpenCodeSessionByIdViaOneShot(options())).rejects.toThrow(
    'cleanup failed',
  );
  expect(await readdir(mockRoot)).toEqual(['original']);
  expect(mockClose).toHaveBeenCalledTimes(1);
});
it('does not coalesce forks that choose different inference sources', async () => {
  const firstRequest = { ...options(), model: 'opencode:fixture%2Fmodel' };
  const first = forkOpenCodeSessionByIdViaOneShot(firstRequest);
  const secondRequest = { ...options(), model: 'gateway-model' };
  await expect(
    forkOpenCodeSessionByIdViaOneShot(secondRequest),
  ).rejects.toThrow('different OpenCode source');
  await first;
  expect(mockTransfer).toHaveBeenCalledTimes(1);
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

it.each([
  {
    authority: 'lease',
    stage: 'native',
    removeFails: false,
    leaseFails: false,
  },
  {
    authority: 'generation',
    stage: 'native',
    removeFails: false,
    leaseFails: false,
  },
  { authority: 'lease', stage: 'native', removeFails: true, leaseFails: false },
  {
    authority: 'generation',
    stage: 'native',
    removeFails: true,
    leaseFails: true,
  },
  {
    authority: 'operation',
    stage: 'lease',
    removeFails: false,
    leaseFails: false,
  },
  {
    authority: 'generation',
    stage: 'lease',
    removeFails: false,
    leaseFails: false,
  },
  {
    authority: 'operation',
    stage: 'lease',
    removeFails: true,
    leaseFails: false,
  },
  {
    authority: 'generation',
    stage: 'lease',
    removeFails: true,
    leaseFails: false,
  },
] as const)(
  'rolls back revoked $authority authority during $stage teardown, removal fails=$removeFails, lease close fails=$leaseFails',
  async ({ authority, stage, removeFails, leaseFails }) => {
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
        inferenceRouteDigest:
          prepareOpenCodeInferenceRoute(mockRoute).identityDigest,
      },
      undefined,
      AbortSignal.timeout(5000),
    );
    let started!: () => void;
    let release!: () => void;
    const closing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    (stage === 'native'
      ? mockNativeClose
      : mockExecutionClose
    ).mockImplementationOnce(async () => {
      started();
      await closed;
    });
    const failure = new Error('fork authority revoked during teardown');
    const removalFailure = new Error('native removal unavailable');
    const leaseFailure = new Error('lease cleanup unavailable');
    if (removeFails) mockRemoveFailure = removalFailure;
    if (leaseFails) mockExecutionClose.mockRejectedValueOnce(leaseFailure);
    const controller = new AbortController();
    const original = structuredClone(mockSessions.get('source-native'));
    const sourceFiles = (
      await readdir(join(mockRoot, 'original'), { recursive: true })
    ).sort();
    const sourceContents = (): Promise<Array<Buffer | string>> =>
      Promise.all(
        sourceFiles.map(async (file) => {
          const path = join(mockRoot, 'original', file);
          return (await lstat(path)).isDirectory()
            ? 'directory'
            : readFile(path);
        }),
      );
    const sourceBytes = await sourceContents();
    const transfer = forkOpenCodeSessionByIdViaOneShot({
      ...options(),
      model: 'gateway-model',
      signal: controller.signal,
    });
    const refused = removeFails
      ? expect(transfer).rejects.toMatchObject({
          cause: leaseFails
            ? { cause: failure, errors: [failure, leaseFailure] }
            : failure,
          errors: [leaseFails ? { cause: failure } : failure, removalFailure],
        })
      : expect(transfer).rejects.toBe(failure);
    await closing;
    if (authority === 'lease') mockLeaseController.abort(failure);
    else if (authority === 'operation') controller.abort(failure);
    else
      mockGeneration.mockImplementation(() => {
        throw failure;
      });
    release();
    await refused;
    expect([...mockSessions.keys()]).toEqual(
      removeFails ? ['source-native', 'native-fork'] : ['source-native'],
    );
    expect(mockSessions.get('source-native')).toEqual(original);
    expect(
      (await readdir(join(mockRoot, 'original'), { recursive: true })).sort(),
    ).toEqual(sourceFiles);
    expect(await sourceContents()).toEqual(sourceBytes);
    expect(await readdir(mockRoot)).toEqual(
      removeFails ? ['fork', 'original'] : ['original'],
    );
    if (removeFails) {
      const receipt: unknown = JSON.parse(
        await readFile(join(mockRoot, 'fork', 'native-fork.json'), 'utf8'),
      );
      expect(receipt).toMatchObject({
        sourceSessionId: 'source-native',
        forkSessionId: 'native-fork',
      });
      expect(
        await readOpenCodeCapabilityBinding(
          join(mockRoot, 'fork'),
          'native-fork',
        ),
      ).toBeDefined();
    }
    expect(mockManage).toHaveBeenCalledWith('native-fork', 'remove');
    expect(mockExecutionClose).toHaveBeenCalledTimes(2);
  },
);
