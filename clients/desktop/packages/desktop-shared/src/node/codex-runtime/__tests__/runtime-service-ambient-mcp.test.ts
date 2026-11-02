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

// Fake PIDs must never reach the host's process-group signal path.
jest.mock('../../lib/process-kill', () => ({
  killChildProcessGroup: (
    child: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
  ): void => {
    child.kill(signal);
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
import { CODEX_APP_SERVER_THREAD_LOAD_BUDGET } from '../connection';
import {
  createCodexRuntimeService,
  type CodexInteractiveOwner,
} from '../runtime-service';

class MockChildProcess extends EventEmitter {
  pid = 4311;
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

type ClientMessage = Record<string, unknown>;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class AppServerScript {
  readonly sent: ClientMessage[] = [];

  constructor(private readonly proc: MockChildProcess) {}

  private drain(): void {
    const raw: unknown = this.proc.stdin.read();
    const text =
      typeof raw === 'string'
        ? raw
        : raw instanceof Buffer
          ? raw.toString('utf8')
          : '';
    for (const line of text.split('\n')) {
      if (line.trim()) this.sent.push(JSON.parse(line) as ClientMessage);
    }
  }

  async next(method: string): Promise<ClientMessage> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      this.drain();
      const match = this.sent.find(
        (message) => message.method === method && !answered.has(message),
      );
      if (match) {
        answered.add(match);
        return match;
      }
      await flush();
    }
    throw new Error(
      `Expected ${method}; saw ${this.sent.map((m) => String(m.method)).join(', ')}`,
    );
  }

  respond(message: ClientMessage, result: unknown): void {
    this.proc.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
  }

  notify(method: string, params: unknown): void {
    this.proc.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  fail(message: ClientMessage, error: string): void {
    this.proc.stdout.write(
      `${JSON.stringify({ id: message.id, error: { code: -32600, message: error } })}\n`,
    );
  }

  async initialize(): Promise<void> {
    this.respond(await this.next('initialize'), {
      userAgent: 'test',
      codexHome: '/tmp/.codex',
    });
  }

  methods(): string[] {
    this.drain();
    return this.sent.map((message) => String(message.method ?? message.id));
  }
}

const answered = new WeakSet<ClientMessage>();

const AMBIENT_CONFIG = {
  config: {
    model: 'gpt',
    mcp_servers: {
      telegram: { command: 'npx', args: ['telegram-mcp'] },
      node_repl: { command: '/opt/node_repl' },
      off: { command: '/opt/off', enabled: false },
    },
  },
  origins: {},
  layers: null,
};

function threadPayload(id: string, ephemeral = false): unknown {
  return {
    thread: {
      id,
      preview: '',
      ephemeral,
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
  };
}

function capabilityStoreStub(
  releaseLease = jest.fn().mockResolvedValue(undefined),
): CodexCapabilityStore {
  return {
    publishSelectedRoots: jest.fn().mockResolvedValue({
      roots: [],
      rootContentIds: [],
    }),
    readLease: jest.fn().mockResolvedValue(null),
    writeLease: jest.fn().mockResolvedValue(undefined),
    releaseLease,
  } as unknown as CodexCapabilityStore;
}

function interactiveOwner(): CodexInteractiveOwner {
  return {
    hasActiveTurn: (): boolean => false,
    getActiveTurnInterruptTarget: (): null => null,
    cancelPendingTurnStart: (): void => {},
    rejectActiveTurn: (): void => {},
    markProcessSuspended: (): void => {},
    markProcessFailed: (): void => {},
    handleConnectionNotification: (): void => {},
    handleRequestUserInput: async (): Promise<void> => {},
    handleDynamicToolCall: async (): Promise<void> => {},
    handleApprovalRequest: async (): Promise<void> => {},
    handleMcpElicitation: async (): Promise<void> => {},
  };
}

describe('Codex runtime ambient MCP isolation', () => {
  let proc: MockChildProcess;
  let script: AppServerScript;

  beforeEach(() => {
    jest.clearAllMocks();
    resetCanonicalCodexHomeForTests();
    proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    script = new AppServerScript(proc);
  });

  afterEach(() => {
    resetCanonicalCodexHomeForTests();
  });

  it('disables ambient servers when starting a thread with no selected servers', async () => {
    const service = createCodexRuntimeService({
      capabilityStore: capabilityStoreStub(),
    });
    try {
      const handlePromise = service.startThread({
        params: {
          cwd: '/tmp/repo',
          selectedCapabilityRoots: [],
          experimentalRawEvents: false,
          config: { mcp_servers: {} },
        },
        capabilitySnapshotId: 'snapshot',
      });
      handlePromise.catch(() => undefined);
      await script.initialize();
      const configRead = await script.next('config/read');
      expect(configRead.params).toEqual({ cwd: '/tmp/repo' });
      script.respond(configRead, AMBIENT_CONFIG);
      const start = await script.next('thread/start');
      expect(start.params).toHaveProperty('config', {
        mcp_servers: {
          telegram: { enabled: false },
          node_repl: { enabled: false },
        },
      });
      script.respond(start, threadPayload('thread-1'));
      await handlePromise;
    } finally {
      await service.shutdown();
    }
  });

  it('keeps selected servers and disables ambient ones when resuming', async () => {
    const service = createCodexRuntimeService({
      capabilityStore: capabilityStoreStub(),
    });
    try {
      const handlePromise = service.resumeThread({
        params: {
          threadId: 'thread-1',
          cwd: '/tmp/repo',
          config: {
            mcp_servers: { chosen: { url: 'http://127.0.0.1/chosen' } },
          },
        },
        capabilitySnapshotId: 'snapshot',
      });
      handlePromise.catch(() => undefined);
      await script.initialize();
      script.respond(await script.next('config/read'), AMBIENT_CONFIG);
      const resume = await script.next('thread/resume');
      expect(resume.params).toHaveProperty('config', {
        mcp_servers: {
          chosen: { url: 'http://127.0.0.1/chosen', required: false },
          telegram: { enabled: false },
          node_repl: { enabled: false },
        },
      });
      script.respond(resume, threadPayload('thread-1'));
      script.notify('mcpServer/startupStatus/updated', {
        threadId: 'thread-1',
        name: 'chosen',
        status: 'ready',
      });
      await handlePromise;
    } finally {
      await service.shutdown();
    }
  });

  it('writes other interactive requests in call order with synchronous sends', async () => {
    const service = createCodexRuntimeService({
      capabilityStore: capabilityStoreStub(),
    });
    const transport = service.attachInteractiveClient({
      owner: interactiveOwner(),
    });
    try {
      const ready = transport.ensureInitialized();
      await script.initialize();
      await ready;
      const interrupt = transport.request('turn/interrupt', {
        threadId: 'thread-1',
        turnId: 'turn-1',
      });
      interrupt.catch(() => undefined);
      transport.send({ id: 'approval-1', result: { decision: 'decline' } });
      await flush();
      expect(script.methods().slice(-2)).toEqual([
        'turn/interrupt',
        'approval-1',
      ]);
    } finally {
      transport.release();
      await service.shutdown();
    }
  });

  it('disables ambient servers for interactive thread starts', async () => {
    const service = createCodexRuntimeService({
      capabilityStore: capabilityStoreStub(),
    });
    const transport = service.attachInteractiveClient({
      owner: interactiveOwner(),
    });
    try {
      const startPromise = transport.request('thread/start', {
        cwd: '/tmp/chat',
        config: {
          mcp_servers: { chosen: { command: '/opt/chosen' } },
        },
      });
      startPromise.catch(() => undefined);
      await script.initialize();
      const configRead = await script.next('config/read');
      expect(configRead.params).toEqual({ cwd: '/tmp/chat' });
      script.respond(configRead, AMBIENT_CONFIG);
      const start = await script.next('thread/start');
      expect(start.params).toHaveProperty('config', {
        mcp_servers: {
          chosen: { command: '/opt/chosen' },
          telegram: { enabled: false },
          node_repl: { enabled: false },
        },
      });
      script.respond(start, threadPayload('thread-2'));
      await startPromise;
      expect(script.methods()).toEqual([
        'initialize',
        'initialized',
        'config/read',
        'thread/start',
      ]);
    } finally {
      transport.release();
      await service.shutdown();
    }
  });

  it('unsubscribes an ephemeral thread instead of attempting a delete', async () => {
    const releaseLease = jest.fn().mockResolvedValue(undefined);
    const service = createCodexRuntimeService({
      capabilityStore: capabilityStoreStub(releaseLease),
    });
    try {
      const handlePromise = service.startThread({
        params: {
          cwd: '/tmp/repo',
          selectedCapabilityRoots: [],
          experimentalRawEvents: false,
          ephemeral: true,
        },
        capabilitySnapshotId: 'snapshot',
        capabilityLeaseKind: 'ephemeral',
      });
      handlePromise.catch(() => undefined);
      await script.initialize();
      script.respond(await script.next('config/read'), { config: {} });
      script.respond(
        await script.next('thread/start'),
        threadPayload('thread-e', true),
      );
      const handle = await handlePromise;
      const deleted = handle.delete();
      script.respond(await script.next('thread/unsubscribe'), {
        status: 'unsubscribed',
      });
      await deleted;
      expect(script.methods()).not.toContain('thread/delete');
      expect(releaseLease).toHaveBeenCalledWith('thread-e');
    } finally {
      await service.shutdown();
    }
  });

  it('still unsubscribes a persisted thread whose delete fails', async () => {
    const service = createCodexRuntimeService({
      capabilityStore: capabilityStoreStub(),
    });
    try {
      const handlePromise = service.startThread({
        params: {
          cwd: '/tmp/repo',
          selectedCapabilityRoots: [],
          experimentalRawEvents: false,
        },
        capabilitySnapshotId: 'snapshot',
      });
      handlePromise.catch(() => undefined);
      await script.initialize();
      script.respond(await script.next('config/read'), { config: {} });
      script.respond(await script.next('thread/start'), threadPayload('p-1'));
      const handle = await handlePromise;
      const deleted = handle.delete();
      script.fail(await script.next('thread/delete'), 'rollout is locked');
      script.respond(await script.next('thread/unsubscribe'), {
        status: 'unsubscribed',
      });
      await expect(deleted).rejects.toThrow('rollout is locked');
    } finally {
      await service.shutdown();
    }
  });

  it('keeps the worker for an open shared-runtime thread past the thread budget', async () => {
    const service = createCodexRuntimeService({
      capabilityStore: capabilityStoreStub(),
    });
    let nextThread = 0;
    const startEphemeral = async (): Promise<
      Awaited<ReturnType<typeof service.startThread>>
    > => {
      const threadId = `budget-${nextThread++}`;
      const handlePromise = service.startThread({
        params: {
          cwd: '/tmp/repo',
          selectedCapabilityRoots: [],
          experimentalRawEvents: false,
          ephemeral: true,
        },
        capabilitySnapshotId: 'snapshot',
        capabilityLeaseKind: 'ephemeral',
      });
      handlePromise.catch(() => undefined);
      if (threadId === 'budget-0') await script.initialize();
      script.respond(await script.next('config/read'), { config: {} });
      script.respond(
        await script.next('thread/start'),
        threadPayload(threadId, true),
      );
      return handlePromise;
    };
    const release = async (
      handle: Awaited<ReturnType<typeof service.startThread>>,
    ): Promise<void> => {
      const deleted = handle.delete();
      script.respond(await script.next('thread/unsubscribe'), {
        status: 'unsubscribed',
      });
      await deleted;
      await flush();
    };
    try {
      // A structured helper keeps its handle across retries and awaits;
      // its ephemeral thread cannot be restored on a replacement worker.
      const retained = await startEphemeral();
      for (
        let index = 1;
        index < CODEX_APP_SERVER_THREAD_LOAD_BUDGET;
        index++
      ) {
        await release(await startEphemeral());
      }
      expect(proc.kill).not.toHaveBeenCalled();

      await release(retained);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      await service.shutdown();
    }
  });
});
