import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type * as NodeChildProcess from 'node:child_process';
import type * as ProcessKill from '../../lib/process-kill';
import type { CodexAppServerConnectionOwner } from '../connection';

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

jest.mock('../../lib/process-kill', () => ({
  ...jest.requireActual<typeof ProcessKill>('../../lib/process-kill'),
  killChildProcessGroup: jest.fn(
    (
      child: { kill(signal?: NodeJS.Signals): boolean },
      signal?: NodeJS.Signals,
    ): void => {
      child.kill(signal);
    },
  ),
}));

jest.mock('../../../pipelines/config-paths', () => ({
  getBundledCodexBinaryPath: jest.fn(() => '/mock/codex'),
  getEnhancedEnv: jest.fn(() => ({ ...process.env })),
}));

import { CodexAppServerConnection } from '../connection';
import {
  configureCodexRuntimeHostHooks,
  resetCodexRuntimeHostHooksForTests,
  type CodexRuntimeResourceRegistrationHandle,
} from '../host-hooks';

type TestJsonRpcId = number | string;
type PromptHandler = 'approval' | 'requestUserInput' | 'mcpElicitation';

interface PromptCall {
  requestId: TestJsonRpcId;
  request: Record<string, unknown>;
  signal: AbortSignal | undefined;
  method?: string;
}

interface TrackedOwner {
  owner: CodexAppServerConnectionOwner;
  approvalCalls: PromptCall[];
  requestUserInputCalls: PromptCall[];
  mcpElicitationCalls: PromptCall[];
}

class MockChildProcess extends EventEmitter {
  pid = 4292;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  clientOutput = '';
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill = jest.fn().mockImplementation((signal?: NodeJS.Signals): boolean => {
    this.signalCode = signal ?? 'SIGTERM';
    this.emit('exit', null, this.signalCode);
    return true;
  });

  constructor() {
    super();
    this.stdin.on('data', (chunk: unknown) => {
      this.clientOutput += String(chunk);
    });
  }
}

function ownerStub(): TrackedOwner {
  const approvalCalls: PromptCall[] = [];
  const requestUserInputCalls: PromptCall[] = [];
  const mcpElicitationCalls: PromptCall[] = [];
  return {
    owner: {
      hasActiveTurn: () => false,
      getActiveTurnInterruptTarget: () => null,
      cancelPendingTurnStart: jest.fn(),
      rejectActiveTurn: jest.fn(),
      markProcessSuspended: jest.fn(),
      markProcessFailed: jest.fn(),
      handleConnectionNotification: jest.fn(),
      handleRequestUserInput: (
        requestId,
        request,
        signal?: AbortSignal,
      ): Promise<void> => {
        requestUserInputCalls.push({ requestId, request, signal });
        return Promise.resolve();
      },
      handleDynamicToolCall: jest.fn(() => Promise.resolve()),
      handleApprovalRequest: (
        requestId,
        method,
        request,
        signal?: AbortSignal,
      ): Promise<void> => {
        approvalCalls.push({ requestId, method, request, signal });
        return Promise.resolve();
      },
      handleMcpElicitation: (
        requestId,
        request,
        _toolCall,
        _approvalKind,
        signal?: AbortSignal,
      ): Promise<void> => {
        mcpElicitationCalls.push({ requestId, request, signal });
        return Promise.resolve();
      },
    },
    approvalCalls,
    requestUserInputCalls,
    mcpElicitationCalls,
  };
}

function callsFor(owner: TrackedOwner, handler: PromptHandler): PromptCall[] {
  switch (handler) {
    case 'approval':
      return owner.approvalCalls;
    case 'requestUserInput':
      return owner.requestUserInputCalls;
    case 'mcpElicitation':
      return owner.mcpElicitationCalls;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseClientMessage(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) {
    throw new Error('Expected a Codex client protocol message object');
  }
  return parsed;
}

function collectClientMessages(
  proc: MockChildProcess,
): Array<Record<string, unknown>> {
  return proc.clientOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseClientMessage);
}

function repliesFor(
  proc: MockChildProcess,
  requestId: TestJsonRpcId,
): Array<Record<string, unknown>> {
  return collectClientMessages(proc).filter(
    (message) => message.id === requestId,
  );
}

function emitServerMessage(proc: MockChildProcess, payload: unknown): void {
  proc.stdout.write(`${JSON.stringify(payload)}\n`);
}

function resolveServerRequest(
  proc: MockChildProcess,
  threadId: string,
  requestId: TestJsonRpcId,
): void {
  emitServerMessage(proc, {
    method: 'serverRequest/resolved',
    params: { threadId, requestId },
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushMany(count = 12): Promise<void> {
  for (let attempt = 0; attempt < count; attempt += 1) await flush();
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function startConnection(
  owners: Array<[CodexAppServerConnectionOwner, string]>,
): Promise<{ proc: MockChildProcess; connection: CodexAppServerConnection }> {
  const proc = new MockChildProcess();
  spawnMock.mockReturnValue(proc);
  const connection = new CodexAppServerConnection(
    'profile:server-request-resolved',
    undefined,
    undefined,
    { allowOwnerlessStartup: false },
  );
  for (const [owner, threadId] of owners) {
    connection.registerOwner(owner, {});
    connection.registerRootThread(threadId, owner);
  }
  const initialization = connection.ensureInitialized();
  await flush();
  emitServerMessage(proc, {
    id: 1,
    result: { userAgent: 'test', codexHome: '/tmp/.codex' },
  });
  await initialization;
  return { proc, connection };
}

beforeEach(() => {
  spawnMock.mockReset();
  configureCodexRuntimeHostHooks({
    clientInfo: () => ({
      name: 'test-runtime',
      title: 'Test Runtime',
      version: '0.0.0',
    }),
    registerProcess: (): CodexRuntimeResourceRegistrationHandle => ({
      update: (): void => {},
      unregister: (): void => {},
    }),
    registerProcessOwner: (): void => {},
    unregisterProcessOwner: (): void => {},
    recordDiagnostic: (): void => {},
    productDisplayName: () => 'Test Runtime',
  });
});

afterEach(() => {
  resetCodexRuntimeHostHooksForTests();
});

interface PromptScenario {
  name: string;
  method: string;
  params: Record<string, unknown>;
  handler: PromptHandler;
  precedingFrames?: Array<Record<string, unknown>>;
}

const promptScenarios: PromptScenario[] = [
  {
    name: 'command approval',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread', turnId: 'turn', itemId: 'command' },
    handler: 'approval',
  },
  {
    name: 'file-change approval',
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'thread', turnId: 'turn', itemId: 'file-change' },
    handler: 'approval',
  },
  {
    name: 'permissions approval',
    method: 'item/permissions/requestApproval',
    params: { threadId: 'thread', turnId: 'turn', itemId: 'permissions' },
    handler: 'approval',
  },
  {
    name: 'legacy patch approval',
    method: 'applyPatchApproval',
    params: { conversationId: 'thread', turnId: 'turn', itemId: 'patch' },
    handler: 'approval',
  },
  {
    name: 'legacy command approval',
    method: 'execCommandApproval',
    params: { conversationId: 'thread', turnId: 'turn', itemId: 'command' },
    handler: 'approval',
  },
  {
    name: 'fallback MCP approval',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread',
      turnId: 'turn',
      itemId: 'mcp-call',
      questions: [
        {
          id: 'mcp_tool_call_approval_mcp-call',
          header: 'Approve tool call',
          question: 'Allow docs/search?',
          options: [],
        },
      ],
    },
    handler: 'approval',
  },
  {
    name: 'built-in user input question',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread',
      turnId: 'turn',
      itemId: 'question',
      questions: [
        {
          id: 'question-1',
          header: 'Question',
          question: 'Choose an option',
          options: [],
        },
      ],
    },
    handler: 'requestUserInput',
  },
  {
    name: 'genuine MCP elicitation',
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'thread',
      turnId: 'turn',
      serverName: 'docs',
      _meta: { codex_approval_kind: 'elicitation' },
    },
    handler: 'approval',
  },
  {
    name: 'synthesized MCP elicitation',
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'thread',
      turnId: 'turn',
      serverName: 'docs',
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        codex_mcp_tool_call_id: 'mcp-call',
      },
    },
    handler: 'mcpElicitation',
    precedingFrames: [
      {
        method: 'item/started',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          item: {
            id: 'mcp-call',
            type: 'mcpToolCall',
            server: 'docs',
            tool: 'search',
            arguments: { query: 'readme' },
          },
        },
      },
    ],
  },
];

describe('CodexAppServerConnection serverRequest/resolved prompt cancellation', () => {
  it.each(promptScenarios)(
    'passes a request-scoped signal to the $name handler and aborts it when resolved',
    async (scenario) => {
      const tracked = ownerStub();
      const { proc, connection } = await startConnection([
        [tracked.owner, 'thread'],
      ]);
      const requestId = `resolved-${scenario.name}`;
      try {
        for (const frame of scenario.precedingFrames ?? []) {
          emitServerMessage(proc, frame);
        }
        emitServerMessage(proc, {
          id: requestId,
          method: scenario.method,
          params: scenario.params,
        });
        await flushMany();

        const call = callsFor(tracked, scenario.handler).find(
          (candidate) => candidate.requestId === requestId,
        );
        expect(call).toBeDefined();
        expect(call?.signal).toBeDefined();
        expect(call?.signal?.aborted).toBe(false);

        resolveServerRequest(proc, 'thread', requestId);
        await flushMany();

        expect(call?.signal?.aborted).toBe(true);
        expect(repliesFor(proc, requestId)).toEqual([]);
      } finally {
        await connection.terminateForFinalRelease();
      }
    },
  );

  it('does not start a transcript-held prompt handler or reply after provider resolution', async () => {
    const tracked = ownerStub();
    const transcriptHold = deferred();
    tracked.owner.handleConnectionNotification = (
      method,
    ): Promise<void> | undefined =>
      method === 'item/started' ? transcriptHold.promise : undefined;
    const { proc, connection } = await startConnection([
      [tracked.owner, 'thread'],
    ]);
    const requestId = 'held-file-change';
    try {
      emitServerMessage(proc, {
        method: 'item/started',
        params: { threadId: 'thread', turnId: 'turn', item: { id: 'held' } },
      });
      await flushMany();
      emitServerMessage(proc, {
        id: requestId,
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread', turnId: 'turn', itemId: 'file-change' },
      });
      await flushMany();
      expect(tracked.approvalCalls).toEqual([]);

      resolveServerRequest(proc, 'thread', requestId);
      await flushMany();
      expect(tracked.approvalCalls).toEqual([]);
      expect(repliesFor(proc, requestId)).toEqual([]);

      transcriptHold.resolve();
      await flushMany();
      expect(tracked.approvalCalls).toEqual([]);
      expect(repliesFor(proc, requestId)).toEqual([]);
    } finally {
      transcriptHold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('checks the admitted prompt entry identity before starting a deferred handler', async () => {
    const tracked = ownerStub();
    const transcriptHold = deferred();
    tracked.owner.handleConnectionNotification = (
      method,
    ): Promise<void> | undefined =>
      method === 'item/started' ? transcriptHold.promise : undefined;
    const { proc, connection } = await startConnection([
      [tracked.owner, 'thread'],
    ]);
    const requestId = 'reused-file-change';
    try {
      emitServerMessage(proc, {
        method: 'item/started',
        params: { threadId: 'thread', turnId: 'turn', item: { id: 'held' } },
      });
      await flushMany();
      emitServerMessage(proc, {
        id: requestId,
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread', turnId: 'turn', itemId: 'old-item' },
      });
      await flushMany();
      resolveServerRequest(proc, 'thread', requestId);
      await flushMany();
      emitServerMessage(proc, {
        id: requestId,
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread', turnId: 'turn', itemId: 'new-item' },
      });
      await flushMany();

      transcriptHold.resolve();
      await flushMany();

      expect(tracked.approvalCalls).toHaveLength(1);
      expect(tracked.approvalCalls[0]?.request).toMatchObject({
        params: { itemId: 'new-item' },
      });
      expect(repliesFor(proc, requestId)).toEqual([]);
    } finally {
      transcriptHold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('aborts a running handler and prevents it from completing the resolved request', async () => {
    const tracked = ownerStub();
    const { proc, connection } = await startConnection([
      [tracked.owner, 'thread'],
    ]);
    const handlerHold = deferred();
    const signals: Array<AbortSignal | undefined> = [];
    const completionResults: boolean[] = [];
    const requestId = 'running-approval';
    tracked.owner.handleApprovalRequest = async function handleApproval(
      id,
      _method,
      _request,
      signal?: AbortSignal,
    ): Promise<void> {
      signals.push(signal);
      await handlerHold.promise;
      const completed = connection.completePendingServerRequest(
        tracked.owner,
        id,
      );
      completionResults.push(completed);
      if (completed) connection.send({ id, result: { decision: 'accept' } });
    };
    try {
      emitServerMessage(proc, {
        id: requestId,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread', turnId: 'turn', itemId: 'command' },
      });
      await flushMany();
      expect(signals).toHaveLength(1);
      expect(signals[0]).toBeDefined();
      expect(signals[0]?.aborted).toBe(false);

      resolveServerRequest(proc, 'thread', requestId);
      await flushMany();
      expect(signals[0]?.aborted).toBe(true);

      handlerHold.resolve();
      await flushMany();
      expect(completionResults).toEqual([false]);
      expect(repliesFor(proc, requestId)).toEqual([]);
    } finally {
      handlerHold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('leaves matching ids on another owner and unknown threads or ids untouched', async () => {
    const root = ownerStub();
    const peer = ownerStub();
    const { proc, connection } = await startConnection([
      [root.owner, 'root-thread'],
      [peer.owner, 'peer-thread'],
    ]);
    const requestId = 'shared-owner-id';
    try {
      emitServerMessage(proc, {
        id: requestId,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'root-thread',
          turnId: 'root-turn',
          itemId: 'root-command',
        },
      });
      emitServerMessage(proc, {
        id: requestId,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'peer-thread',
          turnId: 'peer-turn',
          itemId: 'peer-command',
        },
      });
      await flushMany();
      const rootSignal = root.approvalCalls[0]?.signal;
      const peerSignal = peer.approvalCalls[0]?.signal;
      expect(rootSignal).toBeDefined();
      expect(peerSignal).toBeDefined();

      resolveServerRequest(proc, 'peer-thread', requestId);
      await flushMany();
      expect(peerSignal?.aborted).toBe(true);
      expect(rootSignal?.aborted).toBe(false);

      resolveServerRequest(proc, 'unknown-thread', requestId);
      resolveServerRequest(proc, 'root-thread', 'unknown-id');
      await flushMany();
      expect(rootSignal?.aborted).toBe(false);

      resolveServerRequest(proc, 'root-thread', requestId);
      await flushMany();
      expect(rootSignal?.aborted).toBe(true);
      expect(repliesFor(proc, requestId)).toEqual([]);
    } finally {
      await connection.terminateForFinalRelease();
    }
  });

  it('does not let a child-thread id collision resolve the root prompt', async () => {
    const tracked = ownerStub();
    const { proc, connection } = await startConnection([
      [tracked.owner, 'root-thread'],
    ]);
    const requestId = 'root-child-collision';
    try {
      connection.registerSubagentThread('child-thread', tracked.owner);
      emitServerMessage(proc, {
        id: requestId,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'root-thread',
          turnId: 'root-turn',
          itemId: 'root-command',
        },
      });
      await flushMany();
      const rootSignal = tracked.approvalCalls[0]?.signal;
      expect(rootSignal).toBeDefined();

      resolveServerRequest(proc, 'child-thread', requestId);
      await flushMany();
      expect(rootSignal?.aborted).toBe(false);

      resolveServerRequest(proc, 'root-thread', requestId);
      await flushMany();
      expect(rootSignal?.aborted).toBe(true);
    } finally {
      await connection.terminateForFinalRelease();
    }
  });

  it('keeps numeric and string request ids distinct', async () => {
    const tracked = ownerStub();
    const { proc, connection } = await startConnection([
      [tracked.owner, 'thread'],
    ]);
    try {
      for (const requestId of [73, '73']) {
        emitServerMessage(proc, {
          id: requestId,
          method: 'item/commandExecution/requestApproval',
          params: { threadId: 'thread', turnId: 'turn', itemId: 'command' },
        });
      }
      await flushMany();
      const numericSignal = tracked.approvalCalls.find(
        (call) => call.requestId === 73,
      )?.signal;
      const stringSignal = tracked.approvalCalls.find(
        (call) => call.requestId === '73',
      )?.signal;
      expect(numericSignal).toBeDefined();
      expect(stringSignal).toBeDefined();

      resolveServerRequest(proc, 'thread', 73);
      await flushMany();
      expect(numericSignal?.aborted).toBe(true);
      expect(stringSignal?.aborted).toBe(false);

      resolveServerRequest(proc, 'thread', '73');
      await flushMany();
      expect(stringSignal?.aborted).toBe(true);
    } finally {
      await connection.terminateForFinalRelease();
    }
  });

  it('does not abort a prompt that the owner already completed', async () => {
    const tracked = ownerStub();
    const { proc, connection } = await startConnection([
      [tracked.owner, 'thread'],
    ]);
    const completed: boolean[] = [];
    tracked.owner.handleApprovalRequest = function completeApproval(
      requestId,
      _method,
      request,
      signal?: AbortSignal,
    ): Promise<void> {
      tracked.approvalCalls.push({ requestId, request, signal });
      completed.push(
        connection.completePendingServerRequest(tracked.owner, requestId),
      );
      return Promise.resolve();
    };
    const requestId = 'already-completed';
    try {
      emitServerMessage(proc, {
        id: requestId,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread', turnId: 'turn', itemId: 'command' },
      });
      await flushMany();
      const signal = tracked.approvalCalls[0]?.signal;
      expect(completed).toEqual([true]);
      expect(signal).toBeDefined();

      resolveServerRequest(proc, 'thread', requestId);
      await flushMany();

      expect(signal?.aborted).toBe(false);
      expect(repliesFor(proc, requestId)).toEqual([]);
    } finally {
      await connection.terminateForFinalRelease();
    }
  });
});
