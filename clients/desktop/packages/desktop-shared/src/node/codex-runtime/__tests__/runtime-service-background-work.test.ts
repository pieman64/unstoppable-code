import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type * as NodeChildProcess from 'node:child_process';

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

import type { CodexCapabilityStore } from '../capability-store';
import { resetCanonicalCodexHomeForTests } from '../canonical-state';
import { CodexAppServerConnection } from '../connection';
import {
  createCodexRuntimeService,
  type CodexInteractiveOwner,
} from '../runtime-service';

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

async function createThread(proc: MockChildProcess): Promise<{
  service: ReturnType<typeof createCodexRuntimeService>;
  handle: Awaited<
    ReturnType<ReturnType<typeof createCodexRuntimeService>['startThread']>
  >;
  owner: CodexInteractiveOwner;
}> {
  const rootOwnerRegistrations = jest.spyOn(
    CodexAppServerConnection.prototype,
    'registerRootThread',
  );
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
  await flush();
  // Ambient MCP exclusion reads the effective config before thread/start.
  const read = collectClientMessages(proc).find(
    (message) => message.method === 'config/read',
  );
  if (!read) throw new Error('expected config/read request');
  emitServerMessage(proc, { id: read.id, result: { config: {} } });
  await flush();
  const start = collectClientMessages(proc).find(
    (message) => message.method === 'thread/start',
  );
  if (!start) throw new Error('expected thread/start request');
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
  const owner =
    rootOwnerRegistrations.mock.calls[
      rootOwnerRegistrations.mock.calls.length - 1
    ]?.[1];
  rootOwnerRegistrations.mockRestore();
  if (!owner) throw new Error('expected runtime-owned root thread owner');
  return { service, handle, owner };
}

describe('Codex runtime background work ownership', () => {
  let proc: MockChildProcess;

  beforeEach(() => {
    jest.clearAllMocks();
    resetCanonicalCodexHomeForTests();
    proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
  });

  afterEach(() => {
    resetCanonicalCodexHomeForTests();
  });

  it('observes raw frames when no root turn is active', async () => {
    const { service, owner } = await createThread(proc);

    try {
      expect(typeof owner.hasLiveBackgroundWork).toBe('function');
      expect(owner.hasLiveBackgroundWork?.()).toBe(false);

      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'already-finished-turn',
          item: {
            id: 'background-terminal',
            type: 'commandExecution',
            processId: 'terminal-process',
            status: 'inProgress',
          },
        },
      });
      await flush();
      expect(owner.hasLiveBackgroundWork?.()).toBe(true);

      emitServerMessage(proc, {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'already-finished-turn',
          item: {
            id: 'background-terminal',
            type: 'commandExecution',
            processId: 'terminal-process',
            status: 'completed',
          },
        },
      });
      await flush();
      expect(owner.hasLiveBackgroundWork?.()).toBe(false);
    } finally {
      await service.shutdown();
    }
  });

  it('retires the registry epoch on the existing process-loss hook', async () => {
    const { service, owner } = await createThread(proc);

    try {
      emitServerMessage(proc, {
        method: 'thread/started',
        params: {
          thread: {
            id: 'child-thread',
            source: { subAgent: { parentThreadId: 'thread-1' } },
            status: { type: 'running' },
          },
        },
      });
      await flush();
      expect(owner.hasLiveBackgroundWork?.()).toBe(true);

      owner.markProcessFailed();
      expect(owner.hasLiveBackgroundWork?.()).toBe(false);
    } finally {
      await service.shutdown();
    }
  });

  it.each(['unsubscribe', 'delete'] as const)(
    'retires and stops observing late frames after thread %s',
    async (teardown) => {
      const { service, handle, owner } = await createThread(proc);
      try {
        emitServerMessage(proc, {
          method: 'thread/started',
          params: {
            thread: {
              id: 'child-thread',
              source: { subAgent: { parentThreadId: 'thread-1' } },
              status: { type: 'running' },
            },
          },
        });
        await flush();
        expect(owner.hasLiveBackgroundWork?.()).toBe(true);

        const teardownPromise = handle[teardown]();
        await flush();
        const request = collectClientMessages(proc).find(
          (message) => message.method === `thread/${teardown}`,
        );
        if (!request) throw new Error(`expected thread/${teardown} request`);
        emitServerMessage(proc, { id: request.id, result: {} });
        await teardownPromise;

        const lateParams = {
          thread: {
            id: 'late-child-thread',
            source: { subAgent: { parentThreadId: 'thread-1' } },
            status: { type: 'running' },
          },
        };
        await owner.handleConnectionNotification('thread/started', {
          method: 'thread/started',
          params: lateParams,
        });
        expect(owner.hasLiveBackgroundWork?.()).toBe(false);
      } finally {
        await service.shutdown();
      }
    },
  );

  it('observes late root notifications without emitting runtime events after turn completion', async () => {
    const { service, handle, owner } = await createThread(proc);
    const events: string[] = [];
    const outcome = handle.runTurn({
      input: [{ type: 'text', text: 'run', text_elements: [] }],
      onEvent: (event) => {
        events.push(event.method);
      },
    });

    try {
      await flush();
      const start = collectClientMessages(proc).find(
        (message) => message.method === 'turn/start',
      );
      if (!start) throw new Error('expected turn/start request');
      emitServerMessage(proc, {
        id: start.id,
        result: {
          turn: { id: 'turn-1', status: 'inProgress', items: [], error: null },
        },
      });
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', items: [], error: null },
        },
      });
      await expect(outcome).resolves.toMatchObject({ status: 'completed' });
      const eventCountAfterCompletion = events.length;
      const params = {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'post-root-item',
          type: 'commandExecution',
          processId: 'post-root-process',
          status: 'inProgress',
        },
      };
      emitServerMessage(proc, { method: 'item/started', params });
      await flush();

      expect(owner.hasLiveBackgroundWork?.()).toBe(true);
      expect(events).toHaveLength(eventCountAfterCompletion);
    } finally {
      await outcome.catch(() => undefined);
      await service.shutdown();
    }
  });

  it('tracks child and terminal work after root settlement', async () => {
    const { service, handle, owner } = await createThread(proc);
    const events: string[] = [];
    const outcome = handle.runTurn({
      input: [{ type: 'text', text: 'run', text_elements: [] }],
      onEvent: (event) => {
        events.push(event.method);
      },
    });

    try {
      await flush();
      const start = collectClientMessages(proc).find(
        (message) => message.method === 'turn/start',
      );
      if (!start) throw new Error('expected turn/start request');
      emitServerMessage(proc, {
        id: start.id,
        result: {
          turn: {
            id: 'root-turn',
            status: 'inProgress',
            items: [],
            error: null,
          },
        },
      });
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'root-turn',
            status: 'completed',
            items: [],
            error: null,
          },
        },
      });
      await expect(outcome).resolves.toMatchObject({ status: 'completed' });
      expect(owner.hasLiveBackgroundWork?.()).toBe(false);
      const eventCountAfterRootSettlement = events.length;

      emitServerMessage(proc, {
        method: 'thread/started',
        params: {
          thread: {
            id: 'child-thread',
            source: { subAgent: { parentThreadId: 'thread-1' } },
            status: { type: 'running' },
          },
        },
      });
      await flush();
      expect(owner.hasLiveBackgroundWork?.()).toBe(true);
      expect(events).toHaveLength(eventCountAfterRootSettlement);

      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'child-thread',
          turnId: 'child-turn',
          item: {
            id: 'terminal-item',
            type: 'commandExecution',
            processId: 'terminal-process',
            status: 'inProgress',
          },
        },
      });
      await flush();
      expect(owner.hasLiveBackgroundWork?.()).toBe(true);
      expect(events).toHaveLength(eventCountAfterRootSettlement);

      emitServerMessage(proc, {
        method: 'thread/status/changed',
        params: {
          threadId: 'child-thread',
          status: { type: 'idle' },
        },
      });
      await flush();
      expect(owner.hasLiveBackgroundWork?.()).toBe(true);

      emitServerMessage(proc, {
        method: 'item/completed',
        params: {
          threadId: 'child-thread',
          turnId: 'child-turn',
          item: {
            id: 'terminal-item',
            type: 'commandExecution',
            processId: 'terminal-process',
            status: 'completed',
          },
        },
      });
      await flush();

      expect(owner.hasLiveBackgroundWork?.()).toBe(false);
      expect(events).toHaveLength(eventCountAfterRootSettlement);
    } finally {
      await service.shutdown();
      await outcome.catch(() => undefined);
    }
  });
});
