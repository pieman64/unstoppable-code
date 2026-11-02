import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type * as NodeChildProcess from 'node:child_process';
import {
  chatInputDeliveryFailure,
  chatInputRefusal,
  type ChatInputDeliveryFailureCode,
  type ChatInputRefusalCode,
} from '@canopy/protocol/portal/input-delivery';

const spawnMock = jest.fn<
  MockChildProcess,
  [string, readonly string[], NodeChildProcess.SpawnOptions]
>();

jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof NodeChildProcess>('node:child_process'),
  get spawn(): typeof spawnMock {
    return spawnMock;
  },
}));

jest.mock('../../../pipelines/config-paths', () => ({
  getBundledCanopyCliPath: jest.fn(() => '/mock/canopy'),
  getCanopyCliDevLaunchArgs: jest.fn(() => undefined),
  getBundledCodexBinaryPath: jest.fn(() => '/mock/codex'),
  getEnhancedEnv: jest.fn(() => ({ ...process.env })),
}));

import type { CodexCapabilityStore } from '../capability-store';
import { resetCanonicalCodexHomeForTests } from '../canonical-state';
import { createCodexRuntimeService } from '../runtime-service';

class MockChildProcess extends EventEmitter {
  pid = 4288;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill = jest.fn().mockImplementation((signal?: NodeJS.Signals): boolean => {
    const nextSignal = signal ?? 'SIGTERM';
    this.killed = true;
    this.signalCode = nextSignal;
    this.emit('exit', null, nextSignal);
    return true;
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function emitServerMessage(proc: MockChildProcess, payload: unknown): void {
  proc.stdout.write(`${JSON.stringify(payload)}\n`);
}

function collectClientMessages(
  proc: MockChildProcess,
): Array<Record<string, unknown>> {
  const raw: unknown = proc.stdin.read();
  const text =
    typeof raw === 'string'
      ? raw
      : raw instanceof Buffer
        ? raw.toString('utf8')
        : '';
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForClientRequest(
  proc: MockChildProcess,
  method: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const request = collectClientMessages(proc).find(
      (message) => message.method === method,
    );
    if (request) return request;
    await flush();
  }
  throw new Error(`expected ${method} request`);
}

function capabilityStoreStub(): CodexCapabilityStore {
  return {
    publishSelectedRoots: jest.fn().mockResolvedValue({
      roots: [],
      rootContentIds: [],
    }),
    readLease: jest.fn().mockResolvedValue(null),
    writeLease: jest.fn().mockResolvedValue(undefined),
    releaseLease: jest.fn().mockResolvedValue(undefined),
  } as unknown as CodexCapabilityStore;
}

type RuntimeService = ReturnType<typeof createCodexRuntimeService>;
type ThreadHandle = Awaited<ReturnType<RuntimeService['startThread']>>;

/** Starts a thread with an in-progress `turn-1`. */
async function startActiveTurn(proc: MockChildProcess): Promise<{
  service: RuntimeService;
  handle: ThreadHandle;
  outcome: Promise<unknown>;
}> {
  const service = createCodexRuntimeService({
    capabilityStore: capabilityStoreStub(),
  });
  const handlePromise = service.startThread({
    params: {
      cwd: '/tmp/repo',
      selectedCapabilityRoots: [],
      experimentalRawEvents: false,
    },
    capabilitySnapshotId: 'snapshot',
  });
  await flush();
  emitServerMessage(proc, {
    id: 1,
    result: { userAgent: 'test', codexHome: '/tmp/.codex' },
  });
  // Ambient MCP exclusion reads the effective config before thread/start.
  const read = await waitForClientRequest(proc, 'config/read');
  emitServerMessage(proc, { id: read.id, result: { config: {} } });
  const start = await waitForClientRequest(proc, 'thread/start');
  emitServerMessage(proc, {
    id: start.id,
    result: {
      thread: {
        id: 'thread-1',
        preview: '',
        ephemeral: false,
        modelProvider: 'openai',
        createdAt: 0,
        updatedAt: 0,
        status: { type: 'idle' },
        path: null,
        cwd: '/tmp/repo',
        cliVersion: 'test',
        source: 'appServer',
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
      },
      model: 'test',
      modelProvider: 'openai',
      cwd: '/tmp/repo',
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly' },
      reasoningEffort: null,
    },
  });
  const handle = await handlePromise;
  const outcome = handle.runTurn({
    input: [{ type: 'text', text: 'run', text_elements: [] }],
  });
  // Teardown settles the turn; a failed assertion must not leak a rejection.
  void outcome.catch(() => undefined);
  const turnStart = await waitForClientRequest(proc, 'turn/start');
  emitServerMessage(proc, {
    id: turnStart.id,
    result: {
      turn: { id: 'turn-1', status: 'inProgress', items: [], error: null },
    },
  });
  await flush();
  return { service, handle, outcome };
}

// Codex 0.159.0 `turn/steer` refusals; provenance in steer-refusal.ts.
const steerRefusals: ReadonlyArray<[string, ChatInputRefusalCode]> = [
  ['no active turn to steer', 'no-active-turn'],
  ['expected active turn id `turn-1` but found `turn-2`', 'turn-id-mismatch'],
  ['cannot steer a compact turn', 'compact-turn'],
  ['cannot steer a review turn', 'review-turn'],
  ['active turn uses a different output schema', 'output-schema-mismatch'],
  ['expectedTurnId must not be empty', 'empty-expected-turn-id'],
  ['input must not be empty', 'empty-input'],
  ['Server is draining; retry after reconnecting', 'not-steerable'],
  ['thread not found: thread-1', 'not-steerable'],
];

function unconfirmed(
  attemptId: string,
  code: ChatInputDeliveryFailureCode,
): unknown {
  return {
    kind: 'unknown',
    attemptId,
    reason:
      'Delivery was not confirmed. This message will not be resent automatically.',
    failure: chatInputDeliveryFailure(code),
  };
}

describe('RuntimeThreadHandle steering', () => {
  let proc: MockChildProcess;

  beforeEach(() => {
    jest.clearAllMocks();
    resetCanonicalCodexHomeForTests();
    proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
  });

  afterEach(() => {
    jest.useRealTimers();
    resetCanonicalCodexHomeForTests();
  });

  it.each(steerRefusals)(
    'rejects a refused steer for ordinary delivery: %s',
    async (message, code) => {
      const { service, handle } = await startActiveTurn(proc);
      try {
        const steering = handle.submitSteeringInput('steer', 'refused');
        const steer = await waitForClientRequest(proc, 'turn/steer');
        expect(steer.params).toMatchObject({
          expectedTurnId: 'turn-1',
          clientUserMessageId: 'refused',
        });
        emitServerMessage(proc, {
          id: steer.id,
          error: { code: -32600, message },
        });
        await expect(steering).resolves.toEqual({
          kind: 'rejected',
          attemptId: 'refused',
          reason: 'The active turn no longer accepts steering',
          fallback: 'ordinary',
          refusal: chatInputRefusal(code),
        });
      } finally {
        await service.shutdown();
      }
    },
  );

  it('rejects a steer without an active turn as not steerable', async () => {
    const { service, handle } = await startActiveTurn(proc);
    try {
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', items: [], error: null },
        },
      });
      await flush();
      await expect(
        handle.submitSteeringInput('steer', 'idle'),
      ).resolves.toEqual({
        kind: 'rejected',
        attemptId: 'idle',
        reason: 'The active turn no longer accepts steering',
        fallback: 'ordinary',
        refusal: chatInputRefusal('not-steerable'),
      });
    } finally {
      await service.shutdown();
    }
  });

  it('rejects a steer for a different expected turn as a turn-id mismatch', async () => {
    const { service, handle } = await startActiveTurn(proc);
    try {
      await expect(
        handle.submitSteeringInput('steer', 'stale', 'turn-0'),
      ).resolves.toEqual({
        kind: 'rejected',
        attemptId: 'stale',
        reason: 'The active turn no longer accepts steering',
        fallback: 'ordinary',
        refusal: chatInputRefusal('turn-id-mismatch'),
      });
      expect(
        collectClientMessages(proc).some(
          (message) => message.method === 'turn/steer',
        ),
      ).toBe(false);
    } finally {
      await service.shutdown();
    }
  });

  it('reports a novel steer error as an unconfirmed transport error', async () => {
    const { service, handle } = await startActiveTurn(proc);
    try {
      const steering = handle.submitSteeringInput('steer', 'novel');
      const steer = await waitForClientRequest(proc, 'turn/steer');
      emitServerMessage(proc, {
        id: steer.id,
        error: { code: -32603, message: 'failed to steer turn: agent died' },
      });
      await expect(steering).resolves.toEqual(
        unconfirmed('novel', 'transport-error'),
      );
    } finally {
      await service.shutdown();
    }
  });

  it('reports a steer request timeout as an unconfirmed steer timeout', async () => {
    const { service, handle } = await startActiveTurn(proc);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const steering = handle.submitSteeringInput('steer', 'slow');
      await waitForClientRequest(proc, 'turn/steer');
      await jest.advanceTimersByTimeAsync(30_000);
      await expect(steering).resolves.toEqual(
        unconfirmed('slow', 'steer-timeout'),
      );
    } finally {
      jest.useRealTimers();
      await service.shutdown();
    }
  });

  it('reports a process exit during a steer as an unconfirmed process exit', async () => {
    const { service, handle } = await startActiveTurn(proc);
    spawnMock.mockReturnValue(new MockChildProcess());
    try {
      const steering = handle.submitSteeringInput('steer', 'exited');
      await waitForClientRequest(proc, 'turn/steer');
      proc.emit('exit', 0, null);
      await expect(steering).resolves.toEqual(
        unconfirmed('exited', 'process-exit'),
      );
    } finally {
      await service.shutdown();
    }
  });
});
