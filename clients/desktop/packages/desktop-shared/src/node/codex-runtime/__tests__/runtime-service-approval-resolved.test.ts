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

jest.mock('../../../pipelines/config-paths', () => ({
  getBundledCanopyCliPath: jest.fn(() => '/mock/canopy'),
  getCanopyCliDevLaunchArgs: jest.fn(() => undefined),
  getBundledCodexBinaryPath: jest.fn(() => '/mock/codex'),
  getEnhancedEnv: jest.fn(() => ({ ...process.env })),
}));

import type { CodexCapabilityStore } from '../capability-store';
import { resetCanonicalCodexHomeForTests } from '../canonical-state';
import { createCodexRuntimeService } from '../runtime-service';
import type { CodexRunTurnRequest } from '../thread-handle';

class MockChildProcess extends EventEmitter {
  pid = 4388;
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushMany(count = 12): Promise<void> {
  for (let attempt = 0; attempt < count; attempt += 1) await flush();
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
  if (!start) throw new Error('Expected thread/start');
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
  return { service, handle: await handlePromise };
}

async function startTurn(
  proc: MockChildProcess,
  request: Pick<
    CodexRunTurnRequest,
    'nativeApprovalPolicy' | 'mcpElicitationPolicy' | 'onEvent'
  >,
): Promise<{
  service: ReturnType<typeof createCodexRuntimeService>;
  outcome: ReturnType<
    Awaited<ReturnType<typeof createThread>>['handle']['runTurn']
  >;
}> {
  const { service, handle } = await createThread(proc);
  collectClientMessages(proc);
  const outcome = handle.runTurn({
    input: [{ type: 'text', text: 'Run approval test', text_elements: [] }],
    ...request,
  });
  await flushMany();
  const start = collectClientMessages(proc).find(
    (message) => message.method === 'turn/start',
  );
  if (!start) throw new Error('Expected turn/start');
  emitServerMessage(proc, {
    id: start.id,
    result: {
      turn: { id: 'turn-1', status: 'inProgress', items: [], error: null },
    },
  });
  emitServerMessage(proc, {
    method: 'turn/started',
    params: {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'inProgress', items: [], error: null },
    },
  });
  await flushMany();
  return { service, outcome };
}

async function finishTurn(
  proc: MockChildProcess,
  service: ReturnType<typeof createCodexRuntimeService>,
  outcome: ReturnType<
    Awaited<ReturnType<typeof createThread>>['handle']['runTurn']
  >,
): Promise<void> {
  emitServerMessage(proc, {
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', items: [], error: null },
    },
  });
  await flushMany();
  await outcome;
  await service.shutdown();
}

describe('Codex runtime approval request resolution', () => {
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

  it.each([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
  ])(
    'forwards the request signal to native approval policy and suppresses a resolved %s reply without aborting a concurrent approval',
    async (method) => {
      const policyResults = [
        deferred<Record<string, unknown>>(),
        deferred<Record<string, unknown>>(),
      ];
      const policySignals: Array<AbortSignal | undefined> = [];
      const nativeApprovalPolicy = jest.fn(
        (
          _method: string,
          _request: Record<string, unknown>,
          signal?: AbortSignal,
        ) => {
          policySignals.push(signal);
          const result = policyResults[policySignals.length - 1];
          if (!result) throw new Error('Unexpected additional approval');
          return result.promise;
        },
      );
      const { service, outcome } = await startTurn(proc, {
        nativeApprovalPolicy,
      });
      const requestId = `native-${method}`;
      const concurrentRequestId = `${requestId}-concurrent`;

      try {
        emitServerMessage(proc, {
          id: requestId,
          method,
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'item-1',
          },
        });
        emitServerMessage(proc, {
          id: concurrentRequestId,
          method,
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'item-2',
          },
        });
        await flushMany();

        expect(nativeApprovalPolicy).toHaveBeenCalledTimes(2);
        expect(policySignals).toHaveLength(2);
        expect(policySignals[0]).toBeDefined();
        expect(policySignals[1]).toBeDefined();
        expect(policySignals[0]?.aborted).toBe(false);
        expect(policySignals[1]?.aborted).toBe(false);

        emitServerMessage(proc, {
          method: 'serverRequest/resolved',
          params: { threadId: 'thread-1', requestId: 'unrelated-request' },
        });
        await flushMany();
        expect(policySignals[0]?.aborted).toBe(false);
        expect(policySignals[1]?.aborted).toBe(false);

        emitServerMessage(proc, {
          method: 'serverRequest/resolved',
          params: { threadId: 'thread-1', requestId },
        });
        await flushMany();
        expect(policySignals[0]?.aborted).toBe(true);
        expect(policySignals[1]?.aborted).toBe(false);

        policyResults[0]?.resolve({ decision: 'accept' });
        await flushMany();
        expect(collectClientMessages(proc)).not.toContainEqual(
          expect.objectContaining({ id: requestId }),
        );
        expect(policySignals[1]?.aborted).toBe(false);

        emitServerMessage(proc, {
          method: 'serverRequest/resolved',
          params: { threadId: 'thread-1', requestId: concurrentRequestId },
        });
        await flushMany();
        expect(policySignals[1]?.aborted).toBe(true);
        policyResults[1]?.resolve({ decision: 'accept' });
        await flushMany();
        expect(collectClientMessages(proc)).not.toContainEqual(
          expect.objectContaining({ id: concurrentRequestId }),
        );
      } finally {
        policyResults.forEach((policyResult) =>
          policyResult.resolve({ decision: 'decline' }),
        );
        await finishTurn(proc, service, outcome);
      }
    },
  );

  it('does not start a file-change policy after provider resolution precedes transcript admission', async () => {
    const transcriptHold = deferred<void>();
    const nativeApprovalPolicy = jest.fn(() =>
      Promise.resolve({ decision: 'accept' }),
    );
    const { service, outcome } = await startTurn(proc, {
      nativeApprovalPolicy,
      onEvent: (event) =>
        event.method === 'item/started' ? transcriptHold.promise : undefined,
    });

    try {
      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { id: 'file-change', type: 'fileChange' },
        },
      });
      await flushMany();
      emitServerMessage(proc, {
        id: 'held-file-change',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'file-change',
        },
      });
      await flushMany();
      expect(nativeApprovalPolicy).not.toHaveBeenCalled();

      emitServerMessage(proc, {
        method: 'serverRequest/resolved',
        params: { threadId: 'thread-1', requestId: 'held-file-change' },
      });
      await flushMany();
      transcriptHold.resolve();
      await flushMany();

      expect(nativeApprovalPolicy).not.toHaveBeenCalled();
      expect(collectClientMessages(proc)).not.toContainEqual(
        expect.objectContaining({ id: 'held-file-change' }),
      );
    } finally {
      transcriptHold.resolve();
      await finishTurn(proc, service, outcome);
    }
  });

  it('forwards the MCP request signal and suppresses a resolved elicitation reply', async () => {
    const evaluation = deferred<{
      approved: boolean;
      externalMutation: boolean;
    }>();
    let policySignal: AbortSignal | undefined;
    const evaluate = jest.fn(
      (
        _call: Parameters<
          NonNullable<CodexRunTurnRequest['mcpElicitationPolicy']>['evaluate']
        >[0],
        signal?: AbortSignal,
      ) => {
        policySignal = signal;
        return evaluation.promise;
      },
    );
    const { service, outcome } = await startTurn(proc, {
      mcpElicitationPolicy: {
        allowExternalMutation: true,
        evaluate,
      },
    });

    try {
      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'mcp-call',
            type: 'mcpToolCall',
            server: 'selected-review',
            tool: 'review_evidence',
            arguments: { query: 'readme' },
          },
        },
      });
      await flushMany();
      emitServerMessage(proc, {
        id: 'mcp-approval',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          serverName: 'selected-review',
          mode: 'form',
          _meta: {
            codex_approval_kind: 'mcp_tool_call',
            codex_mcp_tool_call_id: 'mcp-call',
            tool_name: 'review_evidence',
            tool_params: { query: 'readme' },
          },
        },
      });
      await flushMany();

      expect(evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: 'selected-review',
          toolName: 'review_evidence',
        }),
        expect.any(AbortSignal),
      );
      expect(policySignal).toBeDefined();
      expect(policySignal?.aborted).toBe(false);

      emitServerMessage(proc, {
        method: 'serverRequest/resolved',
        params: { threadId: 'thread-1', requestId: 'different-mcp-call' },
      });
      await flushMany();
      expect(policySignal?.aborted).toBe(false);

      emitServerMessage(proc, {
        method: 'serverRequest/resolved',
        params: { threadId: 'thread-1', requestId: 'mcp-approval' },
      });
      await flushMany();
      expect(policySignal?.aborted).toBe(true);

      evaluation.resolve({ approved: true, externalMutation: true });
      await flushMany();
      expect(collectClientMessages(proc)).not.toContainEqual(
        expect.objectContaining({ id: 'mcp-approval' }),
      );
    } finally {
      evaluation.resolve({ approved: false, externalMutation: false });
      await finishTurn(proc, service, outcome);
    }
  });
});
