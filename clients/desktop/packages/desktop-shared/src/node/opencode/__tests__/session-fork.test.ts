import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import type * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openCodeCapabilityDigest,
  saveOpenCodeCapabilitySnapshot,
  readOpenCodeCapabilityBinding,
} from '../capability-snapshot';

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof fileSystem>('node:fs/promises');
  return { ...actual, writeFile: jest.fn(actual.writeFile) };
});

interface Snapshot {
  info: {
    id: string;
    location: { directory: string };
    time: { created: number };
    fork?: { sessionID: string };
    metadata?: Record<string, unknown>;
    permissions?: unknown[];
    revert?: unknown;
  };
  messages: Record<string, unknown>[];
}
const mockSessions = new Map<string, Snapshot>();
const mockClose = jest.fn(() => Promise.resolve());
const mockLoad = jest.fn(() => Promise.resolve({}));
let mockCorrupt = false;
let mockReused = false;
let mockFailMove = false;
let mockAfterFork: (() => Promise<void>) | undefined;
let mockRuntimeStarts = 0;
let mockMetadataError: Error | undefined;
let mockCleanupMetadataError: Error | undefined;
const mockManage = jest.fn((id: string, operation: string): Promise<void> => {
  if (id === 'source') throw new Error('source mutation');
  if (operation === 'remove') mockSessions.delete(id);
  else {
    if (mockFailMove) throw new Error('move failed');
    const fork = mockSessions.get(id);
    if (!fork) throw new Error('missing fork');
    fork.info.location.directory = destinationCwd;
  }
  return Promise.resolve();
});
const mockStart = jest.fn(
  (options: {
    signal: AbortSignal;
    inferenceRoute?: OpenCodeInferenceRoute;
  }) => {
    const cleanup = mockRuntimeStarts++ > 0;
    return Promise.resolve({
      client: {
        loadSession: mockLoad,
        forkSession: jest.fn(async (_params: unknown, signal?: AbortSignal) => {
          if (mockReused) return { sessionId: 'source' };
          const source = mockSessions.get('source');
          if (!source) throw new Error('missing source');
          const fork = structuredClone(source);
          fork.info = {
            ...fork.info,
            id: 'fork',
            time: { created: Date.now() },
            fork: { sessionID: 'source' },
          };
          fork.messages = fork.messages
            .filter(
              (message) =>
                message.type !== 'assistant' ||
                (message.time &&
                  typeof message.time === 'object' &&
                  'completed' in message.time),
            )
            .map((message) => ({
              ...message,
              id: `fork-${String(message.id)}`,
            }));
          if (mockCorrupt) fork.messages[0].text = 'lost context';
          mockSessions.set('fork', fork);
          await mockAfterFork?.();
          // The real owner closes on abort, and ACP rejects cancelled responses.
          options.signal.throwIfAborted();
          signal?.throwIfAborted();
          return { sessionId: 'fork' };
        }),
      },
      readMetadata: (pathname: string): Promise<unknown> => {
        options.signal.throwIfAborted();
        if (cleanup && mockCleanupMetadataError) throw mockCleanupMetadataError;
        if (pathname === '/sessions/fork' && mockMetadataError) {
          const error = mockMetadataError;
          mockMetadataError = undefined;
          throw error;
        }
        const id = decodeURIComponent(pathname.split('/')[2]);
        const snapshot = mockSessions.get(id);
        return Promise.resolve(
          structuredClone(
            pathname.endsWith('/context')
              ? { data: snapshot?.messages }
              : snapshot?.info,
          ),
        );
      },
      manageFork: mockManage,
      close: mockClose,
    });
  },
);
jest.mock('../runtime', () => ({
  get startOpenCodeRuntime(): typeof mockStart {
    return mockStart;
  },
}));
import {
  forkOpenCodeSession,
  discardOpenCodeSessionFork,
} from '../session-fork';
import {
  prepareOpenCodeInferenceRoute,
  type OpenCodeInferenceRoute,
} from '../inference-route';

let root: string;
let sourceProfile: string;
let destinationProfile: string;
let destinationCwd: string;
async function bind(contextDigest = 'original'): Promise<void> {
  await saveOpenCodeCapabilitySnapshot(
    sourceProfile,
    'source',
    {
      version: 1,
      runtime: {},
      files: {},
      mcp: [],
      contextDigest,
      providerSettingsDigest: 'original',
    },
    undefined,
    AbortSignal.timeout(5000),
  );
}
function options(): Parameters<typeof forkOpenCodeSession>[0] {
  return {
    platform: 'darwin',
    executable: 'fixture',
    env: { OPENCODE_DB: join(root, 'native.db') },
    signal: AbortSignal.timeout(5000),
    source: { profileDir: sourceProfile, cwd: root, sessionId: 'source' },
    destination: { profileDir: destinationProfile, cwd: destinationCwd },
  };
}
beforeEach(async () => {
  jest.clearAllMocks();
  mockSessions.clear();
  mockCorrupt = false;
  mockReused = false;
  mockFailMove = false;
  mockAfterFork = undefined;
  mockMetadataError = undefined;
  mockCleanupMetadataError = undefined;
  mockRuntimeStarts = 0;
  root = await realpath(await mkdtemp(join(tmpdir(), 'opencode-fork-')));
  sourceProfile = join(root, 'source-profile');
  destinationProfile = join(root, 'destination-profile');
  destinationCwd = join(root, 'worktree');
  await mkdir(sourceProfile);
  await mkdir(destinationCwd);
  // V2 has no private profile database or copied native credentials.
  await writeFile(join(root, 'native.db'), 'native credential database');
  mockSessions.set('source', {
    info: { id: 'source', location: { directory: root }, time: { created: 1 } },
    messages: [
      {
        id: 'message',
        type: 'system',
        text: 'HIDDEN CONTEXT',
        time: { created: 1 },
      },
    ],
  });
  await bind();
});
afterEach(async () => {
  jest.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
it.each(['darwin', 'win32', 'linux'] as const)(
  'uses the native v2 fork and move on %s without copying credentials',
  async (platform) => {
    const original = structuredClone(mockSessions.get('source'));
    const result = await forkOpenCodeSession({ ...options(), platform });
    expect(result.sessionId).toBe('fork');
    expect(mockSessions.get('source')).toEqual(original);
    expect(mockManage).toHaveBeenCalledWith('fork', 'move');
    expect(mockSessions.get('fork')?.messages[0]).toMatchObject({
      text: 'HIDDEN CONTEXT',
    });
    expect(await readFile(join(root, 'native.db'), 'utf8')).toBe(
      'native credential database',
    );
    expect(await readdir(destinationProfile)).not.toContain('opencode.db');
    expect(
      await readOpenCodeCapabilityBinding(destinationProfile, 'fork'),
    ).toMatchObject({ digest: result.binding.digest });
  },
);
it('same-directory forks require no move and retain additional directory grants', async () => {
  const source = mockSessions.get('source');
  if (!source) throw new Error('missing source');
  source.info.metadata = {
    'opencode.acp.additionalDirectories': [destinationCwd],
  };
  source.info.permissions = [
    {
      action: 'external_directory',
      resource: join(destinationCwd, '*'),
      effect: 'allow',
    },
  ];
  await forkOpenCodeSession({
    ...options(),
    destination: { profileDir: destinationProfile, cwd: root },
  });
  expect(mockLoad).toHaveBeenCalledWith(
    expect.objectContaining({ additionalDirectories: [destinationCwd] }),
  );
  expect(mockManage).not.toHaveBeenCalled();
});
it('rejects source grants that native attach would rewrite before attaching', async () => {
  const source = mockSessions.get('source');
  if (!source) throw new Error('missing source');
  source.info.metadata = {
    'opencode.acp.additionalDirectories': [destinationCwd],
  };
  source.info.permissions = [];
  await expect(forkOpenCodeSession(options())).rejects.toThrow(
    'cannot be preserved',
  );
  expect(mockLoad).not.toHaveBeenCalled();
  expect(mockSessions.size).toBe(1);
});
it('copies settled native context while the originating assistant is still running', async () => {
  mockSessions.get('source')?.messages.push({
    id: 'active',
    type: 'assistant',
    time: { created: 2 },
    content: [],
  });
  await forkOpenCodeSession(options());
  expect(mockSessions.get('fork')?.messages).toHaveLength(1);
});
it('rejects corrupt context and removes only the newly created native fork', async () => {
  mockCorrupt = true;
  await expect(forkOpenCodeSession(options())).rejects.toThrow(
    'native fork context',
  );
  expect(mockManage).toHaveBeenCalledWith('fork', 'remove');
  expect(mockSessions.has('source')).toBe(true);
  expect(await readdir(root)).not.toContain('destination-profile');
});
it('never removes the source when the provider reuses its ID', async () => {
  mockReused = true;
  await expect(forkOpenCodeSession(options())).rejects.toThrow('independent');
  expect(mockManage).not.toHaveBeenCalled();
});
it('cleans up a failed native move without deleting the source', async () => {
  mockFailMove = true;
  await expect(forkOpenCodeSession(options())).rejects.toThrow('move failed');
  expect([...mockSessions.keys()]).toEqual(['source']);
});
it.each([false, true])(
  'removes an unpublished fork when its receipt write fails, cancelled=%s',
  async (cancelled) => {
    const original = structuredClone(mockSessions.get('source'));
    const controller = new AbortController();
    const writeError = Object.assign(new Error('receipt disk full'), {
      code: 'ENOSPC',
    });
    jest.mocked(writeFile).mockImplementationOnce(() => {
      if (cancelled) controller.abort();
      return Promise.reject(writeError);
    });

    await expect(
      forkOpenCodeSession({ ...options(), signal: controller.signal }),
    ).rejects.toBe(writeError);

    expect([...mockSessions.keys()]).toEqual(['source']);
    expect(mockSessions.get('source')).toEqual(original);
    expect(await readdir(root)).not.toContain('destination-profile');
    expect(mockClose).toHaveBeenCalledTimes(cancelled ? 2 : 1);
    if (cancelled) {
      const forkScope: unknown = expect.objectContaining({
        sourceSessionId: 'source',
        forkSessionId: 'fork',
      });
      const signal: unknown = expect.objectContaining({ aborted: false });
      expect(mockStart).toHaveBeenLastCalledWith(
        expect.objectContaining({ forkScope, signal }),
      );
    }
  },
);
it('reports rollback errors and retains private recovery information', async () => {
  const controller = new AbortController();
  const writeError = new Error('receipt disk full');
  const cleanupError = new Error('native remove failed');
  jest.mocked(writeFile).mockImplementationOnce(() => {
    controller.abort();
    return Promise.reject(writeError);
  });
  mockManage.mockRejectedValueOnce(cleanupError);

  await expect(
    forkOpenCodeSession({ ...options(), signal: controller.signal }),
  ).rejects.toMatchObject({
    cause: writeError,
    errors: [writeError, cleanupError],
  });

  expect(mockSessions.has('source')).toBe(true);
  expect(mockSessions.has('fork')).toBe(true);
  expect(await readdir(destinationProfile)).toContain(
    'native-fork-recovery.json',
  );
  expect(mockClose).toHaveBeenCalledTimes(2);
});
it('uses the live owner when disk failure prevents another runtime from starting', async () => {
  const startRuntime = mockStart.getMockImplementation();
  if (!startRuntime) throw new Error('missing runtime fixture');
  const writeError = new Error('receipt disk full');
  jest.mocked(writeFile).mockImplementationOnce(() => {
    mockStart.mockRejectedValueOnce(new Error('runtime files disk full'));
    return Promise.reject(writeError);
  });

  try {
    await expect(forkOpenCodeSession(options())).rejects.toBe(writeError);
    expect([...mockSessions.keys()]).toEqual(['source']);
    expect(await readdir(root)).not.toContain('destination-profile');
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledTimes(1);
  } finally {
    mockStart.mockReset().mockImplementation(startRuntime);
  }
});
it('rejects a capability history race and discards the fresh fork', async () => {
  mockAfterFork = async (): Promise<void> => {
    await bind('changed');
  };
  await expect(forkOpenCodeSession(options())).rejects.toThrow();
  expect([...mockSessions.keys()]).toEqual(['source']);
});
it('preserves an existing destination and never starts on cancellation', async () => {
  await mkdir(destinationProfile);
  await writeFile(join(destinationProfile, 'keep'), 'keep');
  await expect(forkOpenCodeSession(options())).rejects.toThrow(
    'already exists',
  );
  expect(mockStart).not.toHaveBeenCalled();
  await expect(
    forkOpenCodeSession({ ...options(), signal: AbortSignal.abort() }),
  ).rejects.toThrow();
  expect(await readFile(join(destinationProfile, 'keep'), 'utf8')).toBe('keep');
});
it('cleanup refuses an unrelated identity and removes the exact unpublished fork', async () => {
  await forkOpenCodeSession(options());
  await expect(
    discardOpenCodeSessionFork({
      ...options(),
      profileDir: destinationProfile,
      cwd: destinationCwd,
      sessionId: 'source',
    }),
  ).rejects.toThrow('match');
  await discardOpenCodeSessionFork({
    ...options(),
    profileDir: destinationProfile,
    cwd: destinationCwd,
    sessionId: 'fork',
  });
  expect([...mockSessions.keys()]).toEqual(['source']);
});

it('retains the native response long enough to roll back cancellation during creation', async () => {
  const controller = new AbortController();
  const failure = new Error('stopped after native creation');
  const original = structuredClone(mockSessions.get('source'));
  const publish = jest.fn();
  mockAfterFork = async (): Promise<void> => {
    controller.abort(failure);
    await Promise.resolve();
  };
  await expect(
    forkOpenCodeSession({ ...options(), signal: controller.signal, publish }),
  ).rejects.toBe(failure);
  expect([...mockSessions.keys()]).toEqual(['source']);
  expect(mockSessions.get('source')).toEqual(original);
  expect(publish).not.toHaveBeenCalled();
  expect(await readdir(root)).not.toContain('destination-profile');
});

it('retains recovery information when native creation loses its response', async () => {
  const failure = new Error('connection lost after native creation');
  mockAfterFork = (): Promise<void> => Promise.reject(failure);
  await expect(forkOpenCodeSession(options())).rejects.toMatchObject({
    cause: failure,
    recovery: { ownershipVerified: false, creationOutcome: 'unknown' },
  });
  expect(mockManage).not.toHaveBeenCalled();
  expect([...mockSessions.keys()]).toEqual(['source', 'fork']);
  const recovery: unknown = JSON.parse(
    await readFile(
      join(destinationProfile, 'native-fork-recovery.json'),
      'utf8',
    ),
  );
  expect(recovery).toMatchObject({
    sourceSessionId: 'source',
    creationOutcome: 'unknown',
    ownershipVerified: false,
  });
  expect(await readdir(destinationProfile)).not.toContain('native-fork.json');
});

it('bounds cancellation while the native fork response is missing', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  const controller = new AbortController();
  let started = (): void => {};
  const creationStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  mockAfterFork = async (): Promise<void> => {
    const creatorSignal = mockStart.mock.calls[0]?.[0].signal;
    if (!creatorSignal) throw new Error('missing creator');
    started();
    await new Promise<void>((_resolve, reject) => {
      creatorSignal.addEventListener(
        'abort',
        () => {
          const reason: unknown = creatorSignal.reason;
          reject(
            reason instanceof Error ? reason : new Error('creator closed'),
          );
        },
        {
          once: true,
        },
      );
    });
  };
  try {
    const stopped = new Error('user stopped creation');
    const settled = expect(
      forkOpenCodeSession({ ...options(), signal: controller.signal }),
    ).rejects.toMatchObject({
      cause: stopped,
      recovery: { creationOutcome: 'unknown', ownershipVerified: false },
    });
    await creationStarted;
    controller.abort(stopped);
    await jest.advanceTimersByTimeAsync(29_999);
    expect(mockStart.mock.calls[0]?.[0].signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await settled;
    expect(mockStart.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(mockManage).not.toHaveBeenCalled();
    expect(await readdir(destinationProfile)).toContain(
      'native-fork-recovery.json',
    );
  } finally {
    jest.useRealTimers();
  }
});

function managedRoute(
  protocol: OpenCodeInferenceRoute['protocol'] = 'openai-responses',
): OpenCodeInferenceRoute {
  return {
    bindingKey: 'a'.repeat(64),
    protocol,
    baseUrl: `http://127.0.0.1:54321/codex-gateway/${'b'.repeat(48)}`,
    model: {
      id: 'provider/model',
      contextWindow: 128000,
      outputLimit: 16384,
      supportsVision: false,
    },
  };
}
async function bindManagedSource(route: OpenCodeInferenceRoute): Promise<void> {
  await saveOpenCodeCapabilitySnapshot(
    sourceProfile,
    'source',
    {
      version: 1,
      runtime: {},
      files: {},
      mcp: [],
      contextDigest: 'original',
      providerSettingsDigest: 'original',
      inferenceRouteDigest: prepareOpenCodeInferenceRoute(route).identityDigest,
    },
    undefined,
    AbortSignal.timeout(5000),
  );
}
it.each<OpenCodeInferenceRoute['protocol']>([
  'anthropic-messages',
  'openai-responses',
])(
  'retains %s managed context through a rotated broker lease',
  async (protocol) => {
    const original = managedRoute(protocol);
    await bindManagedSource(original);
    const inferenceRoute = {
      ...original,
      baseUrl: `http://127.0.0.1:54322/codex-gateway/${'c'.repeat(48)}`,
    };
    const request = { ...options(), inferenceRoute };
    const forked = await forkOpenCodeSession(request);
    expect(forked.binding).toMatchObject({
      version: 2,
      inferenceRouteDigest:
        prepareOpenCodeInferenceRoute(original).identityDigest,
    });
    for (const [runtime] of mockStart.mock.calls)
      expect(runtime.inferenceRoute).toEqual({
        ...inferenceRoute,
        headers: {},
      });
    expect(mockSessions.get('fork')?.messages[0]).toMatchObject({
      text: 'HIDDEN CONTEXT',
    });
    expect(mockSessions.get('source')?.messages[0]).toMatchObject({
      text: 'HIDDEN CONTEXT',
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
  },
);
it.each(['missing', 'changed', 'native-source'])(
  'rejects %s inference identity before reading native context or reserving the destination',
  async (kind) => {
    const original = managedRoute();
    if (kind !== 'native-source') await bindManagedSource(original);
    const inferenceRoute =
      kind === 'missing'
        ? undefined
        : {
            ...original,
            bindingKey:
              kind === 'changed' ? 'd'.repeat(64) : original.bindingKey,
          };
    const request = { ...options(), inferenceRoute };
    await expect(forkOpenCodeSession(request)).rejects.toThrow(
      'inference route',
    );
    expect(mockStart).not.toHaveBeenCalled();
    expect(await readdir(root)).not.toContain('destination-profile');
  },
);

it.each(['funding', 'model', 'missing'])(
  'refuses changed %s selection authority before a managed fork',
  async (change) => {
    const original = {
      ...managedRoute(),
      selection: { modelId: 'logical-model', fundingKey: 'f'.repeat(64) },
    };
    const snapshot = {
      version: 1 as const,
      runtime: {},
      files: {},
      mcp: [],
      contextDigest: 'original',
      providerSettingsDigest: 'original',
      inferenceRouteDigest:
        prepareOpenCodeInferenceRoute(original).identityDigest,
      inferenceSelection: {
        modelId: original.selection.modelId,
        fundingDigest: openCodeCapabilityDigest({
          version: 1,
          fundingKey: original.selection.fundingKey,
        }),
      },
    };
    await saveOpenCodeCapabilitySnapshot(
      sourceProfile,
      'source',
      snapshot,
      undefined,
      AbortSignal.timeout(5000),
    );
    const inferenceRoute = {
      ...original,
      selection:
        change === 'missing'
          ? undefined
          : {
              modelId:
                change === 'model'
                  ? 'different-logical-model'
                  : original.selection.modelId,
              fundingKey:
                change === 'funding'
                  ? 'd'.repeat(64)
                  : original.selection.fundingKey,
            },
    };
    await expect(
      forkOpenCodeSession({ ...options(), inferenceRoute }),
    ).rejects.toThrow('inference route');
    expect(mockStart).not.toHaveBeenCalled();
    expect(await readdir(root)).not.toContain('destination-profile');
  },
);

it.each([
  { boundary: 'native-return', cancelled: false },
  { boundary: 'native-return', cancelled: true },
  { boundary: 'receipt', cancelled: false },
  { boundary: 'receipt', cancelled: true },
  { boundary: 'host-publication', cancelled: false },
  { boundary: 'host-publication', cancelled: true },
])(
  'removes only its owned fork after $boundary failure, cancelled=$cancelled',
  async ({ boundary, cancelled }) => {
    const controller = new AbortController();
    const failure = new Error('interrupted fork publication');
    const original = structuredClone(mockSessions.get('source'));
    const actualWrite =
      jest.requireActual<typeof fileSystem>('node:fs/promises').writeFile;
    const fail = (): void => {
      if (cancelled) controller.abort(failure);
      else throw failure;
    };
    if (boundary === 'native-return') {
      mockAfterFork = (): Promise<void> => {
        if (cancelled) controller.abort(failure);
        else mockMetadataError = failure;
        return Promise.resolve();
      };
    } else if (boundary === 'receipt') {
      jest.mocked(writeFile).mockImplementationOnce(async (...args) => {
        await actualWrite(...args);
        fail();
      });
    }
    await expect(
      forkOpenCodeSession({
        ...options(),
        signal: controller.signal,
        publish: async () => {
          await writeFile(
            join(destinationProfile, 'host-session.json'),
            'published',
          );
          if (boundary === 'host-publication') fail();
        },
      }),
    ).rejects.toBe(failure);
    expect([...mockSessions.keys()]).toEqual(['source']);
    expect(mockSessions.get('source')).toEqual(original);
    expect(await readdir(root)).not.toContain('destination-profile');
    if (boundary === 'native-return' || cancelled) {
      expect(mockStart).toHaveBeenCalledTimes(2);
      const cleanupSignal = mockStart.mock.calls[1]?.[0].signal;
      expect(cleanupSignal?.aborted).toBe(false);
      expect(cleanupSignal).not.toBe(controller.signal);
    }
  },
);

it.each(['startup', 'metadata', 'recovery-write'] as const)(
  'preserves an unverified candidate and recovery information if bounded %s fails',
  async (stage) => {
    const controller = new AbortController();
    const failure = new Error('cancelled before verification');
    const cleanupError = new Error('metadata unavailable');
    const recoveryWriteError = new Error('recovery write failed');
    if (stage !== 'startup') mockCleanupMetadataError = cleanupError;
    mockAfterFork = (): Promise<void> => {
      if (stage === 'startup') mockStart.mockRejectedValueOnce(cleanupError);
      if (stage === 'recovery-write')
        jest.mocked(writeFile).mockRejectedValueOnce(recoveryWriteError);
      controller.abort(failure);
      return Promise.resolve();
    };
    await expect(
      forkOpenCodeSession({ ...options(), signal: controller.signal }),
    ).rejects.toMatchObject({
      cause: failure,
      errors:
        stage === 'recovery-write'
          ? [failure, cleanupError, recoveryWriteError]
          : [failure, cleanupError],
      recovery: {
        profileDir: destinationProfile,
        candidateSessionId: 'fork',
        ownershipVerified: false,
      },
    });
    expect(mockManage).not.toHaveBeenCalled();
    expect([...mockSessions.keys()]).toEqual(['source', 'fork']);
    if (stage !== 'recovery-write') {
      const recovery: unknown = JSON.parse(
        await readFile(
          join(destinationProfile, 'native-fork-recovery.json'),
          'utf8',
        ),
      );
      expect(recovery).toMatchObject({
        sourceSessionId: 'source',
        candidateSessionId: 'fork',
        ownershipVerified: false,
      });
    } else {
      expect(await readdir(root)).toContain('destination-profile');
    }
    expect(await readdir(destinationProfile)).not.toContain('native-fork.json');
    await expect(
      discardOpenCodeSessionFork({
        ...options(),
        profileDir: destinationProfile,
        cwd: destinationCwd,
        sessionId: 'fork',
      }),
    ).rejects.toThrow();
    expect(mockManage).not.toHaveBeenCalled();
  },
);

it.each(['source', 'unrelated', 'old', 'foreign-directory'] as const)(
  'never removes a returned %s candidate during recovery',
  async (kind) => {
    const controller = new AbortController();
    const failure = new Error('cancelled before verification');
    if (kind === 'source') mockReused = true;
    else
      mockAfterFork = (): Promise<void> => {
        const fork = mockSessions.get('fork');
        if (!fork) throw new Error('missing fork');
        if (kind === 'unrelated')
          fork.info.fork = { sessionID: 'unrelated-parent' };
        if (kind === 'old') fork.info.time.created = 1;
        if (kind === 'foreign-directory')
          fork.info.location.directory = join(root, 'foreign');
        controller.abort(failure);
        return Promise.resolve();
      };
    await expect(
      forkOpenCodeSession({ ...options(), signal: controller.signal }),
    ).rejects.toThrow();
    expect(mockManage).not.toHaveBeenCalled();
    expect(mockSessions.has('source')).toBe(true);
    if (kind !== 'source') expect(mockSessions.has('fork')).toBe(true);
  },
);
