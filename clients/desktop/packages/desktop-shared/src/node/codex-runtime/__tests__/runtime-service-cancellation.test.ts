import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type * as NodeChildProcess from 'node:child_process';

const spawnMock = jest.fn<
  MockChildProcess,
  [string, readonly string[], NodeChildProcess.SpawnOptions]
>();

jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof NodeChildProcess>('node:child_process'),
  spawn: spawnMock,
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

import { CodexCapabilityStore } from '../capability-store';
import { resetCanonicalCodexHomeForTests } from '../canonical-state';
import { CodexAppServerConnection } from '../connection';
import { createCodexRuntimeService } from '../runtime-service';
import type { CodexRunTurnRequest } from '../thread-handle';
import type { CodexRuntimeEvent } from '../thread-handle';
import type { CodexHostToolPolicy } from '../thread-handle';
import type { DynamicToolCallParams } from '../generated/v2/DynamicToolCallParams';
import type { DynamicToolCallResponse } from '../generated/v2/DynamicToolCallResponse';
import type { CodexSpawnProfileRequest } from '../profile';

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

/** Thread start and resume first read the effective config for ambient MCP servers. */
async function waitForClientMessage(
  proc: MockChildProcess,
  method: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000;
  do {
    await flush();
    const message = collectClientMessages(proc).find(
      (candidate) => candidate.method === method,
    );
    if (message) return message;
  } while (Date.now() < deadline);
  throw new Error(`expected ${method} request`);
}

async function answerConfigRead(proc: MockChildProcess): Promise<void> {
  const read = await waitForClientMessage(proc, 'config/read');
  emitServerMessage(proc, { id: read.id, result: { config: {} } });
  await flush();
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

async function createThread(
  proc: MockChildProcess,
  profile?: CodexSpawnProfileRequest,
): Promise<{
  startParams: unknown;
  service: ReturnType<typeof createCodexRuntimeService>;
  handle: Awaited<
    ReturnType<ReturnType<typeof createCodexRuntimeService>['startThread']>
  >;
}> {
  const service = createCodexRuntimeService({
    capabilityStore: capabilityStoreStub(),
  });
  const handlePromise = service.startThread({
    profile,
    params: {
      cwd: '/tmp/repo',
      selectedCapabilityRoots: [],
      experimentalRawEvents: false,
    },
    capabilitySnapshotId: 'snapshot',
  });
  const initialize = await waitForClientMessage(proc, 'initialize');
  emitServerMessage(proc, {
    id: initialize.id,
    result: { userAgent: 'test', codexHome: '/tmp/.codex' },
  });
  await answerConfigRead(proc);
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
  return { service, handle: await handlePromise, startParams: start.params };
}

function threadStartResult(id: string): Record<string, unknown> {
  return {
    thread: {
      id,
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
  };
}

/** A second thread on the same service, so on the same pooled app-server. */
async function startPeerThread(
  proc: MockChildProcess,
  service: ReturnType<typeof createCodexRuntimeService>,
  threadId: string,
): Promise<
  Awaited<
    ReturnType<ReturnType<typeof createCodexRuntimeService>['startThread']>
  >
> {
  const handlePromise = service.startThread({
    params: {
      cwd: '/tmp/repo',
      selectedCapabilityRoots: [],
      experimentalRawEvents: false,
    },
    capabilitySnapshotId: 'snapshot',
  });
  await flush();
  await answerConfigRead(proc);
  const start = collectClientMessages(proc).find(
    (message) => message.method === 'thread/start',
  );
  if (!start) throw new Error('expected peer thread/start request');
  emitServerMessage(proc, {
    id: start.id,
    result: threadStartResult(threadId),
  });
  return handlePromise;
}

/** Answers the newest turn/start request with an in-progress turn. */
function acceptTurnStart(proc: MockChildProcess, turnId: string): void {
  const start = collectClientMessages(proc).find(
    (message) => message.method === 'turn/start',
  );
  if (!start) throw new Error(`expected turn/start request for ${turnId}`);
  emitServerMessage(proc, {
    id: start.id,
    result: {
      turn: { id: turnId, status: 'inProgress', items: [], error: null },
    },
  });
}

describe('RuntimeThreadHandle cancellation', () => {
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

  for (const beforeResponse of [false, true]) {
    it(`settles an owned non-retrying quota error ${beforeResponse ? 'before' : 'after'} the turn/start response without turn/completed`, async () => {
      const { service, handle } = await createThread(proc);
      collectClientMessages(proc);
      let releaseAdmission = (): void => undefined;
      const admission = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      const outcome = handle.runTurn({
        input: [{ type: 'text', text: 'run', text_elements: [] }],
        onEvent: (event) =>
          event.method === 'error' &&
          event.params.willRetry === false &&
          event.params.threadId === 'thread-1'
            ? admission
            : undefined,
      });
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      try {
        await flush();
        const start = collectClientMessages(proc).find(
          (message) => message.method === 'turn/start',
        );
        if (!start) throw new Error('expected turn/start request');
        const respond = (): void =>
          emitServerMessage(proc, {
            id: start.id,
            result: {
              turn: {
                id: 'quota-turn',
                status: 'inProgress',
                items: [],
                error: null,
              },
            },
          });
        if (!beforeResponse) {
          respond();
          await flush();
        }
        const error = {
          message: "You've hit your usage limit.",
          codexErrorInfo: 'usageLimitExceeded',
          additionalDetails: null,
          misalignment: null,
        };
        emitServerMessage(proc, {
          method: 'error',
          params: {
            threadId: 'thread-1',
            turnId: 'quota-turn',
            willRetry: true,
            error,
          },
        });
        emitServerMessage(proc, {
          method: 'error',
          params: {
            threadId: 'thread-1',
            turnId: 'foreign-turn',
            willRetry: false,
            error,
          },
        });
        await flush();
        expect(settled).toBe(false);
        emitServerMessage(proc, {
          method: 'error',
          params: {
            threadId: 'thread-1',
            turnId: 'quota-turn',
            willRetry: false,
            error,
          },
        });
        if (beforeResponse) respond();
        await flush();
        expect(settled).toBe(false);
        releaseAdmission();
        await flush();
        expect(settled).toBe(true);
        await expect(outcome).resolves.toMatchObject({
          status: 'failed',
          turnId: 'quota-turn',
          error: error.message,
          errorInfo: 'usageLimitExceeded',
        });
      } finally {
        releaseAdmission();
        emitServerMessage(proc, {
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: {
              id: 'quota-turn',
              status: 'failed',
              items: [],
              error: null,
            },
          },
        });
        await outcome;
        await service.shutdown();
      }
    });
  }

  it('waits for terminal route admission before reporting a completed thread turn', async () => {
    const { service, handle } = await createThread(proc);
    collectClientMessages(proc);
    let releaseAdmission = (): void => undefined;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const outcome = handle.runTurn({
      input: [{ type: 'text', text: 'run', text_elements: [] }],
      onEvent: (event) =>
        event.method === 'turn/completed' ? admission : undefined,
    });
    let settled = false;
    void outcome.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
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
      await flush();
      expect(settled).toBe(false);
      releaseAdmission();
      await expect(outcome).resolves.toMatchObject({ status: 'completed' });
    } finally {
      releaseAdmission();
      await outcome.catch(() => undefined);
      await service.shutdown();
    }
  });

  it('reports a failed turn error with its classification', async () => {
    const { service, handle } = await createThread(proc);
    collectClientMessages(proc);
    const outcome = handle.runTurn({
      input: [{ type: 'text', text: 'run', text_elements: [] }],
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
          turn: {
            id: 'turn-1',
            status: 'failed',
            items: [],
            error: {
              message: 'Your session expired. Please sign in again.',
              codexErrorInfo: 'unauthorized',
              additionalDetails: null,
              misalignment: null,
            },
          },
        },
      });
      await expect(outcome).resolves.toMatchObject({
        status: 'failed',
        error: 'Your session expired. Please sign in again.',
        errorInfo: 'unauthorized',
      });
    } finally {
      await outcome.catch(() => undefined);
      await service.shutdown();
    }
  });

  it('preserves an explicit empty capability selection on the native thread request', async () => {
    const { service, startParams } = await createThread(proc);
    try {
      expect(startParams).toHaveProperty('selectedCapabilityRoots', []);
    } finally {
      await service.shutdown();
    }
  });

  it('lets a turn/start response and peer RPC pass an early held terminal, then rejects on admission failure', async () => {
    const { service, handle } = await createThread(proc);
    collectClientMessages(proc);
    let rejectAdmission: (error: Error) => void = () => undefined;
    const admission = new Promise<void>((_resolve, reject) => {
      rejectAdmission = reject;
    });
    // Unchanged runtimes may ignore the callback receipt entirely.
    void admission.catch(() => undefined);
    const outcome = handle.runTurn({
      input: [{ type: 'text', text: 'run', text_elements: [] }],
      onEvent: (event) =>
        event.method === 'turn/completed' ? admission : undefined,
    });
    let settled = false;
    void outcome.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await flush();
      const start = collectClientMessages(proc).find(
        (message) => message.method === 'turn/start',
      );
      if (!start) throw new Error('expected turn/start request');
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', items: [], error: null },
        },
      });
      emitServerMessage(proc, {
        id: start.id,
        result: {
          turn: { id: 'turn-1', status: 'inProgress', items: [], error: null },
        },
      });
      const peer = service.admin().request('account/read', {
        refreshToken: false,
      });
      await flush();
      const peerRequest = collectClientMessages(proc).find(
        (message) => message.method === 'account/read',
      );
      if (!peerRequest) throw new Error('expected peer account/read request');
      emitServerMessage(proc, {
        id: peerRequest.id,
        result: { account: null },
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          peer,
          new Promise<void>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error('peer response blocked by early terminal')),
              1000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      expect(settled).toBe(false);
      rejectAdmission(new Error('terminal admission failed'));
      await expect(outcome).resolves.toMatchObject({
        status: 'failed',
        error: 'terminal admission failed',
      });
    } finally {
      rejectAdmission(new Error('test cleanup'));
      await outcome.catch(() => undefined);
      await service.shutdown();
    }
  });

  it('carries the restricted environment policy through the shared service and pool', async () => {
    const profile = {
      environmentPolicy: 'restricted' as const,
      includeCanopySecrets: false,
    };
    const { service } = await createThread(proc, profile);
    try {
      expect(
        spawnMock.mock.calls[spawnMock.mock.calls.length - 1]?.[2]?.env?.PATH,
      ).toBe('');
    } finally {
      await service.shutdown();
    }
  });

  it.each(['abort', 'process-exit'] as const)(
    'settles %s while early terminal route admission remains held',
    async (failure) => {
      const { service, handle } = await createThread(proc);
      collectClientMessages(proc);
      const controller = new AbortController();
      let releaseAdmission = (): void => undefined;
      const admission = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      const outcome = handle.runTurn({
        input: [{ type: 'text', text: 'run', text_elements: [] }],
        signal: controller.signal,
        onEvent: (event) =>
          event.method === 'turn/completed' ? admission : undefined,
      });
      let settled = false;
      void outcome.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await flush();
        const start = collectClientMessages(proc).find(
          (message) => message.method === 'turn/start',
        );
        if (!start) throw new Error('expected turn/start request');
        emitServerMessage(proc, {
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: 'turn-1', status: 'completed', items: [], error: null },
          },
        });
        emitServerMessage(proc, {
          id: start.id,
          result: {
            turn: {
              id: 'turn-1',
              status: 'inProgress',
              items: [],
              error: null,
            },
          },
        });
        await flush();
        expect(settled).toBe(false);
        if (failure === 'abort') {
          controller.abort();
          await flush();
          const interrupt = collectClientMessages(proc).find(
            (message) => message.method === 'turn/interrupt',
          );
          if (!interrupt) throw new Error('expected turn/interrupt request');
          emitServerMessage(proc, {
            id: interrupt.id,
            error: { code: -32000, message: 'interrupt failed' },
          });
          let retry: Record<string, unknown> | undefined;
          for (let attempt = 0; attempt < 100; attempt += 1) {
            retry = collectClientMessages(proc).filter(
              (message) => message.method === 'turn/interrupt',
            )[0];
            if (retry) break;
            await flush();
          }
          if (!retry) throw new Error('expected second turn/interrupt attempt');
          emitServerMessage(proc, {
            id: retry.id,
            error: { code: -32000, message: 'retry interrupt failed' },
          });
        } else {
          proc.emit('exit', 1, null);
        }
        await flush();
        await flush();
        expect(settled).toBe(true);
      } finally {
        proc.emit('exit', 1, null);
        releaseAdmission();
        await service.shutdown();
      }
    },
  );

  async function startHostToolTurn(
    policy?: CodexHostToolPolicy,
    nativeApprovalPolicy?: CodexRunTurnRequest['nativeApprovalPolicy'],
  ): Promise<{
    service: ReturnType<typeof createCodexRuntimeService>;
    outcome: ReturnType<
      Awaited<ReturnType<typeof createThread>>['handle']['runTurn']
    >;
    handle: Awaited<ReturnType<typeof createThread>>['handle'];
  }> {
    const { service, handle } = await createThread(proc);
    collectClientMessages(proc);
    const outcome = handle.runTurn({
      input: [{ type: 'text', text: 'Read a file', text_elements: [] }],
      hostToolPolicy: policy,
      nativeApprovalPolicy,
    });
    await flush();
    const start = collectClientMessages(proc).find(
      (message) => message.method === 'turn/start',
    );
    if (!start) throw new Error('Expected turn/start');
    expect(start.params).not.toHaveProperty('hostToolPolicy');
    expect(start.params).not.toHaveProperty('nativeApprovalPolicy');
    emitServerMessage(proc, {
      id: start.id,
      result: {
        turn: {
          id: 'turn-host-tools',
          status: 'inProgress',
          items: [],
          error: null,
        },
      },
    });
    await flush();
    return { service, handle, outcome };
  }

  function hostToolCall(
    overrides: Partial<DynamicToolCallParams> = {},
  ): DynamicToolCallParams {
    return {
      threadId: 'thread-1',
      turnId: 'turn-host-tools',
      callId: 'call-read',
      namespace: null,
      tool: 'host_read',
      arguments: { path: 'README.md' },
      ...overrides,
    };
  }

  async function finishHostToolTurn(
    service: ReturnType<typeof createCodexRuntimeService>,
  ): Promise<void> {
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-host-tools',
          status: 'completed',
          items: [],
          error: null,
        },
      },
    });
    await flush();
    await service.shutdown();
  }

  it.each(['accept', 'throw', 'absent'] as const)(
    'routes native approval through the host policy: %s',
    async (decision) => {
      const policy = jest.fn(() =>
        decision === 'throw'
          ? Promise.reject(new Error('policy unavailable'))
          : Promise.resolve({ decision: 'accept' }),
      );
      const { service, outcome } = await startHostToolTurn(
        undefined,
        decision === 'absent' ? undefined : policy,
      );
      emitServerMessage(proc, {
        id: 'native-approval',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-host-tools',
          itemId: 'edit-1',
        },
      });
      await flush();
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'native-approval',
        result: { decision: decision === 'accept' ? 'accept' : 'decline' },
      });
      expect(policy).toHaveBeenCalledTimes(decision === 'absent' ? 0 : 1);
      await finishHostToolTurn(service);
      await outcome;
    },
  );

  it('discards a native approval that resolves after its turn ends', async () => {
    let release: ((value: Record<string, unknown>) => void) | undefined;
    const policy = jest.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          release = resolve;
        }),
    );
    const { service, outcome } = await startHostToolTurn(undefined, policy);
    emitServerMessage(proc, {
      id: 'late-approval',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-host-tools',
        itemId: 'edit-1',
      },
    });
    await flush();
    expect(policy).toHaveBeenCalledTimes(1);
    await finishHostToolTurn(service);
    await outcome;
    collectClientMessages(proc);
    if (!release) throw new Error('Expected pending approval resolver');
    release({ decision: 'accept' });
    await flush();
    expect(collectClientMessages(proc)).not.toContainEqual({
      id: 'late-approval',
      result: { decision: 'accept' },
    });
  });

  it('executes an explicitly approved host tool with exact call ownership', async () => {
    const response: DynamicToolCallResponse = {
      success: true,
      contentItems: [{ type: 'inputText', text: 'bounded file text' }],
    };
    const execute = jest.fn(
      (): Promise<DynamicToolCallResponse> => Promise.resolve(response),
    );
    const authorize = jest.fn((): Promise<boolean> => Promise.resolve(true));
    const { service, outcome } = await startHostToolTurn({
      allowedTools: [{ namespace: null, tool: 'host_read' }],
      authorize,
      execute,
    });
    try {
      emitServerMessage(proc, {
        id: 700,
        method: 'item/tool/call',
        params: hostToolCall(),
      });
      await flush();
      expect(authorize).toHaveBeenCalledWith(
        hostToolCall(),
        expect.any(AbortSignal),
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect(collectClientMessages(proc)).toContainEqual({
        id: 700,
        result: response,
      });
    } finally {
      await finishHostToolTurn(service);
      await outcome;
    }
  });

  it.each([
    'missing-policy',
    'denied',
    'foreign-turn',
    'unselected-tool',
    'foreign-namespace',
  ])('fails closed for host tool %s', async (failure) => {
    const execute = jest.fn(
      (): Promise<DynamicToolCallResponse> =>
        Promise.resolve({
          success: true,
          contentItems: [],
        }),
    );
    const { service, outcome } = await startHostToolTurn(
      failure === 'missing-policy'
        ? undefined
        : {
            allowedTools: [{ namespace: null, tool: 'host_read' }],
            authorize: (): Promise<boolean> =>
              Promise.resolve(failure !== 'denied'),
            execute,
          },
    );
    try {
      emitServerMessage(proc, {
        id: 701,
        method: 'item/tool/call',
        params: hostToolCall({
          ...(failure === 'foreign-turn' ? { turnId: 'other-turn' } : {}),
          ...(failure === 'unselected-tool' ? { tool: 'shell' } : {}),
          ...(failure === 'foreign-namespace' ? { namespace: 'external' } : {}),
        }),
      });
      await flush();
      expect(execute).not.toHaveBeenCalled();
      expect(
        collectClientMessages(proc).filter((message) => message.id === 701),
      ).toMatchObject([{ id: 701, result: { success: false } }]);
    } finally {
      await finishHostToolTurn(service);
      await outcome;
    }
  });

  it('deduplicates retried host calls by call id without reauthorizing or reexecuting', async () => {
    const execute = jest.fn(
      (): Promise<DynamicToolCallResponse> =>
        Promise.resolve({
          success: true,
          contentItems: [],
        }),
    );
    const authorize = jest.fn((): Promise<boolean> => Promise.resolve(true));
    const { service, outcome } = await startHostToolTurn({
      allowedTools: [{ namespace: null, tool: 'host_read' }],
      authorize,
      execute,
    });
    try {
      emitServerMessage(proc, {
        id: 702,
        method: 'item/tool/call',
        params: hostToolCall(),
      });
      emitServerMessage(proc, {
        id: 703,
        method: 'item/tool/call',
        params: hostToolCall(),
      });
      await flush();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(
        collectClientMessages(proc).filter(
          (message) => message.id === 702 || message.id === 703,
        ),
      ).toHaveLength(2);
    } finally {
      await finishHostToolTurn(service);
      await outcome;
    }
  });

  it('aborts a blocked host callback and cannot send its late success after interrupt', async () => {
    let callbackSignal: AbortSignal | undefined;
    let finishCallback:
      | ((response: DynamicToolCallResponse) => void)
      | undefined;
    const { service, handle, outcome } = await startHostToolTurn({
      allowedTools: [{ namespace: null, tool: 'host_read' }],
      authorize: (): Promise<boolean> => Promise.resolve(true),
      execute: (_call, signal): Promise<DynamicToolCallResponse> => {
        callbackSignal = signal;
        return new Promise((resolve) => {
          finishCallback = resolve;
        });
      },
    });
    try {
      emitServerMessage(proc, {
        id: 704,
        method: 'item/tool/call',
        params: hostToolCall(),
      });
      await flush();
      expect(callbackSignal).toBeDefined();
      const interrupt = handle.interrupt();
      await flush();
      const sent = collectClientMessages(proc);
      const request = sent.find(
        (message) => message.method === 'turn/interrupt',
      );
      if (!request) throw new Error('Expected interrupt request');
      emitServerMessage(proc, { id: request.id, result: {} });
      await interrupt;
      expect(callbackSignal?.aborted).toBe(true);
      finishCallback?.({ success: true, contentItems: [] });
      await flush();
      expect(
        [...sent, ...collectClientMessages(proc)].filter(
          (message) => message.id === 704,
        ),
      ).toMatchObject([{ result: { success: false } }]);
    } finally {
      finishCallback?.({ success: false, contentItems: [] });
      await finishHostToolTurn(service);
      await outcome;
    }
  });

  it('revokes callback authority when the owning turn completes', async () => {
    let signal: AbortSignal | undefined;
    let settle: ((response: DynamicToolCallResponse) => void) | undefined;
    const execute = jest.fn(
      (
        _call: DynamicToolCallParams,
        current: AbortSignal,
      ): Promise<DynamicToolCallResponse> => {
        signal = current;
        return new Promise((resolve) => {
          settle = resolve;
        });
      },
    );
    const { service, outcome } = await startHostToolTurn({
      allowedTools: [{ namespace: null, tool: 'host_read' }],
      authorize: (): Promise<boolean> => Promise.resolve(true),
      execute,
    });
    try {
      emitServerMessage(proc, {
        id: 705,
        method: 'item/tool/call',
        params: hostToolCall(),
      });
      await flush();
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-host-tools',
            status: 'completed',
            items: [],
            error: null,
          },
        },
      });
      await outcome;
      expect(signal?.aborted).toBe(true);
      settle?.({ success: true, contentItems: [] });
      emitServerMessage(proc, {
        id: 706,
        method: 'item/tool/call',
        params: hostToolCall({ callId: 'late' }),
      });
      await flush();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(
        collectClientMessages(proc).filter(
          (message) => message.id === 705 || message.id === 706,
        ),
      ).toMatchObject([
        { id: 705, result: { success: false } },
        { id: 706, result: { success: false } },
      ]);
    } finally {
      settle?.({ success: false, contentItems: [] });
      await service.shutdown();
    }
  });

  it('shuts down with a blocked host authorization without leaving its owner active', async () => {
    let signal: AbortSignal | undefined;
    let approve: ((approved: boolean) => void) | undefined;
    const execute = jest.fn(
      (): Promise<DynamicToolCallResponse> =>
        Promise.resolve({ success: true, contentItems: [] }),
    );
    const { service, outcome } = await startHostToolTurn({
      allowedTools: [{ namespace: null, tool: 'host_read' }],
      authorize: (_call, current): Promise<boolean> => {
        signal = current;
        return new Promise((resolve) => {
          approve = resolve;
        });
      },
      execute,
    });
    try {
      emitServerMessage(proc, {
        id: 707,
        method: 'item/tool/call',
        params: hostToolCall(),
      });
      await flush();
      expect(signal).toBeDefined();
      await service.shutdown();
      expect(signal?.aborted).toBe(true);
      approve?.(true);
      expect((await outcome).status).not.toBe('completed');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      approve?.(false);
      await service.shutdown();
    }
  });

  it.each(['start', 'resume'] as const)(
    'allows shared-runtime %s with a failed MCP and retains its lease',
    async (operation) => {
      const store = capabilityStoreStub();
      const writeLease = jest.spyOn(store, 'writeLease');
      const service = createCodexRuntimeService({ capabilityStore: store });
      const params = {
        cwd: '/tmp/repo',
        config: {
          mcp_servers: {
            broken: { url: 'http://127.0.0.1/mcp', required: true },
          },
        },
      };
      const request =
        operation === 'start'
          ? service.startThread({
              params: { ...params, experimentalRawEvents: false },
              capabilitySnapshotId: 'snapshot',
            })
          : service.resumeThread({
              params: { ...params, threadId: 'thread-1' },
              capabilitySnapshotId: 'snapshot',
            });
      void request.catch(() => {});
      try {
        await flush();
        const initialize = collectClientMessages(proc).find(
          (item) => item.method === 'initialize',
        );
        expect(initialize).toBeDefined();
        emitServerMessage(proc, {
          id: initialize?.id,
          result: { userAgent: 'test', codexHome: '/tmp/.codex' },
        });
        await answerConfigRead(proc);
        const message = collectClientMessages(proc).find(
          (item) => item.method === `thread/${operation}`,
        );
        expect(message).toBeDefined();
        emitServerMessage(proc, {
          id: message?.id,
          result: { thread: { id: 'thread-1' } },
        });
        emitServerMessage(proc, {
          method: 'mcpServer/startupStatus/updated',
          params: {
            threadId: 'thread-1',
            name: 'broken',
            status: 'failed',
            error: 'HTTP 503',
            failureReason: 'serverInitializationFailed',
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 125));
        // Acknowledge the old failure cleanup so red reports the MCP error, not an RPC timeout.
        const cleanup = collectClientMessages(proc).find(
          (item) =>
            item.method === 'thread/delete' ||
            item.method === 'thread/unsubscribe',
        );
        if (cleanup) emitServerMessage(proc, { id: cleanup.id, result: {} });
        await expect(request).resolves.toBeDefined();
        expect(writeLease).toHaveBeenCalledWith(
          expect.objectContaining({
            threadId: 'thread-1',
            snapshotId: 'snapshot',
          }),
        );
        expect(cleanup).toBeUndefined();
        expect(message).toMatchObject({
          params: { config: { mcp_servers: { broken: { required: false } } } },
        });
      } finally {
        await service.shutdown();
      }
    },
  );

  it('restarts the owner process when abort races a pending turn/start', async () => {
    const { service, handle } = await createThread(proc);
    collectClientMessages(proc);
    const abortController = new AbortController();
    const outcomePromise = handle.runTurn({
      input: [{ type: 'text', text: 'run', text_elements: [] }],
      signal: abortController.signal,
    });
    await flush();
    expect(
      collectClientMessages(proc).some(
        (message) => message.method === 'turn/start',
      ),
    ).toBe(true);

    abortController.abort();
    const outcome = await outcomePromise;

    expect(outcome.status).toBe('interrupted');
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    await service.shutdown();
  });

  it('revokes provisional resume ownership when lease persistence fails', async () => {
    const capabilityStore = new CodexCapabilityStore(
      '/tmp/codex-runtime-resume-rollback-test',
    );
    jest.spyOn(capabilityStore, 'readLease').mockResolvedValue(null);
    jest
      .spyOn(capabilityStore, 'writeLease')
      .mockRejectedValue(new Error('lease write failed'));
    const unregisterThread = jest.spyOn(
      CodexAppServerConnection.prototype,
      'unregisterThread',
    );
    const service = createCodexRuntimeService({ capabilityStore });

    const resumePromise = service.resumeThread({
      params: {
        threadId: 'thread-resumed',
        cwd: '/tmp/repo',
      },
      capabilitySnapshotId: 'snapshot',
    });
    const resumeRejection =
      expect(resumePromise).rejects.toThrow('lease write failed');
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await answerConfigRead(proc);
    const resume = collectClientMessages(proc).find(
      (message) => message.method === 'thread/resume',
    );
    if (!resume) throw new Error('expected thread/resume request');
    emitServerMessage(proc, {
      id: resume.id,
      result: {
        thread: {
          id: 'thread-resumed',
        },
      },
    });
    await flush();
    const unsubscribe = collectClientMessages(proc).find(
      (message) => message.method === 'thread/unsubscribe',
    );
    if (!unsubscribe) throw new Error('expected thread/unsubscribe request');
    expect(unsubscribe.params).toEqual({ threadId: 'thread-resumed' });
    emitServerMessage(proc, { id: unsubscribe.id, result: {} });

    await resumeRejection;
    expect(unregisterThread).toHaveBeenCalledWith(
      'thread-resumed',
      expect.anything(),
    );
    await service.shutdown();
    unregisterThread.mockRestore();
  });

  it('revokes provisional fork ownership before deleting a failed fork', async () => {
    const capabilityStore = new CodexCapabilityStore(
      '/tmp/codex-runtime-fork-rollback-test',
    );
    jest.spyOn(capabilityStore, 'readLease').mockResolvedValue(null);
    jest
      .spyOn(capabilityStore, 'writeLease')
      .mockRejectedValue(new Error('lease write failed'));
    const unregisterThread = jest.spyOn(
      CodexAppServerConnection.prototype,
      'unregisterThread',
    );
    const service = createCodexRuntimeService({ capabilityStore });

    const forkPromise = service.forkThread({
      params: {
        threadId: 'thread-source',
        cwd: '/tmp/repo',
      },
      capabilitySnapshotId: 'snapshot',
    });
    const forkRejection =
      expect(forkPromise).rejects.toThrow('lease write failed');
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await flush();
    const fork = collectClientMessages(proc).find(
      (message) => message.method === 'thread/fork',
    );
    if (!fork) throw new Error('expected thread/fork request');
    emitServerMessage(proc, {
      id: fork.id,
      result: {
        thread: {
          id: 'thread-forked',
        },
      },
    });
    await flush();
    const deleteRequest = collectClientMessages(proc).find(
      (message) => message.method === 'thread/delete',
    );
    if (!deleteRequest) throw new Error('expected thread/delete request');
    emitServerMessage(proc, { id: deleteRequest.id, result: {} });

    await forkRejection;
    expect(unregisterThread).toHaveBeenCalledWith(
      'thread-forked',
      expect.anything(),
    );
    await service.shutdown();
    unregisterThread.mockRestore();
  });

  it('restarts after an ambiguous turn/start timeout', async () => {
    const { service, handle } = await createThread(proc);
    collectClientMessages(proc);

    const outcome = await handle.runTurn({
      input: [{ type: 'text', text: 'run', text_elements: [] }],
      startupTimeoutMs: 10,
    });

    expect(outcome.status).toBe('interrupted');
    expect(outcome.error).toContain('did not respond to turn/start');
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    await service.shutdown();
  });

  it('marks an unanswered turn/start on the failed outcome', async () => {
    const { service, handle } = await createThread(proc);
    collectClientMessages(proc);

    const outcome = await handle.runTurn({
      input: [{ type: 'text', text: 'run', text_elements: [] }],
      startupTimeoutMs: 10,
    });

    expect(outcome.transportFailure).toEqual({
      codex_error_code: 'app_server_request_timeout',
      codex_error_method: 'turn/start',
    });
    await service.shutdown();
  });

  it('keeps the shared-restart marker on a bystander turn outcome', async () => {
    const { service, handle: bystander } = await createThread(proc);
    collectClientMessages(proc);
    const stoppingPromise = service.startThread({
      params: {
        cwd: '/tmp/repo',
        selectedCapabilityRoots: [],
        experimentalRawEvents: false,
      },
      capabilitySnapshotId: 'snapshot',
    });
    await answerConfigRead(proc);
    const secondStart = collectClientMessages(proc).find(
      (message) => message.method === 'thread/start',
    );
    if (!secondStart) throw new Error('expected second thread/start');
    emitServerMessage(proc, {
      id: secondStart.id,
      result: { thread: { id: 'thread-2', turns: [] } },
    });
    const stopping = await stoppingPromise;

    const bystanderOutcome = bystander.runTurn({
      input: [{ type: 'text', text: 'keep working', text_elements: [] }],
    });
    await flush();
    const bystanderTurn = collectClientMessages(proc).find(
      (message) => message.method === 'turn/start',
    );
    if (!bystanderTurn) throw new Error('expected bystander turn/start');
    emitServerMessage(proc, {
      id: bystanderTurn.id,
      result: {
        turn: { id: 'turn-a', items: [], status: 'inProgress', error: null },
      },
    });
    await flush();

    const controller = new AbortController();
    const stoppingOutcome = stopping.runTurn({
      input: [{ type: 'text', text: 'stop me', text_elements: [] }],
      signal: controller.signal,
    });
    await flush();
    const stoppingTurn = collectClientMessages(proc).find(
      (message) => message.method === 'turn/start',
    );
    if (!stoppingTurn) throw new Error('expected stopping turn/start');
    emitServerMessage(proc, {
      id: stoppingTurn.id,
      result: {
        turn: { id: 'turn-b', items: [], status: 'inProgress', error: null },
      },
    });
    await flush();

    // Both bounded interrupt attempts fail, so the shared worker is stopped.
    controller.abort();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await flush();
      const interrupt = collectClientMessages(proc).find(
        (message) => message.method === 'turn/interrupt',
      );
      if (!interrupt) throw new Error('expected turn/interrupt');
      emitServerMessage(proc, {
        id: interrupt.id,
        error: { code: -32000, message: 'interrupt unavailable' },
      });
    }

    const outcome = await bystanderOutcome;
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(outcome.status).toBe('failed');
    expect(outcome.transportFailure).toEqual({
      codex_error_code: 'app_server_shared_restart',
    });
    await stoppingOutcome;
    await service.shutdown();
  });

  it('settles a total timeout when interrupt is acknowledged without a terminal event', async () => {
    const { service, handle } = await createThread(proc);
    collectClientMessages(proc);
    jest.useFakeTimers();
    try {
      const outcomePromise = handle.runTurn({
        input: [{ type: 'text', text: 'run', text_elements: [] }],
        totalTimeoutMs: 10,
      });
      await jest.advanceTimersByTimeAsync(0);
      const start = collectClientMessages(proc).find(
        (message) => message.method === 'turn/start',
      );
      if (!start) throw new Error('expected turn/start request');
      emitServerMessage(proc, {
        id: start.id,
        result: {
          turn: {
            id: 'turn-1',
            status: 'inProgress',
            items: [],
            error: null,
          },
        },
      });
      await jest.advanceTimersByTimeAsync(10);
      const interrupt = collectClientMessages(proc).find(
        (message) => message.method === 'turn/interrupt',
      );
      if (!interrupt) throw new Error('expected turn/interrupt request');
      emitServerMessage(proc, { id: interrupt.id, result: {} });
      await jest.advanceTimersByTimeAsync(5_000);

      await expect(outcomePromise).resolves.toMatchObject({
        status: 'interrupted',
        error:
          'Codex turn did not emit a terminal notification after interrupt',
      });
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      jest.useRealTimers();
      await service.shutdown();
    }
  });

  it('fans account notifications out to registered admin listeners', async () => {
    const { service } = await createThread(proc);
    const accountListener = jest.fn();
    const rateLimitsListener = jest.fn();
    service.admin().onAccountUpdated(accountListener);
    service.admin().onRateLimitsUpdated(rateLimitsListener);

    emitServerMessage(proc, {
      method: 'account/updated',
      params: {
        authMode: 'chatgpt',
        planType: 'team',
      },
    });
    await flush();

    emitServerMessage(proc, {
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'default',
          limitName: null,
          primary: null,
          secondary: null,
          credits: null,
          individualLimit: null,
          planType: null,
          rateLimitReachedType: null,
        },
      },
    });
    await flush();

    expect(accountListener).toHaveBeenCalledWith({
      authMode: 'chatgpt',
      planType: 'team',
    });
    expect(rateLimitsListener).toHaveBeenCalledWith({
      rateLimits: {
        limitId: 'default',
        limitName: null,
        primary: null,
        secondary: null,
        credits: null,
        individualLimit: null,
        planType: null,
        rateLimitReachedType: null,
      },
    });
    emitServerMessage(proc, {
      method: 'account/updated',
      params: { authMode: 'not-a-real-mode', planType: 'team' },
    });
    await flush();
    expect(accountListener).toHaveBeenCalledTimes(1);
    await service.shutdown();
  });

  it('registers spawned subagent threads for later notification routing', async () => {
    const { service, handle } = await createThread(proc);
    collectClientMessages(proc);
    const onEvent = jest.fn<void, [CodexRuntimeEvent]>();
    const outcomePromise = handle.runTurn({
      input: [{ type: 'text', text: 'run', text_elements: [] }],
      onEvent,
    });
    await flush();
    const start = collectClientMessages(proc).find(
      (message) => message.method === 'turn/start',
    );
    if (!start) throw new Error('expected turn/start request');
    emitServerMessage(proc, {
      id: start.id,
      result: {
        turn: {
          id: 'turn-1',
          status: 'inProgress',
          items: [],
          error: null,
        },
      },
    });
    emitServerMessage(proc, {
      method: 'thread/started',
      params: {
        thread: {
          id: 'thread-child',
          source: {
            subAgent: {
              parentThreadId: 'thread-1',
            },
          },
        },
      },
    });
    emitServerMessage(proc, {
      method: 'item/started',
      params: {
        threadId: 'thread-child',
        turnId: 'child-turn',
        item: { id: 'child-item', type: 'agentMessage', text: 'working' },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/started',
      params: {
        threadId: 'thread-child',
        turn: {
          id: 'child-turn',
          status: 'inProgress',
          items: [],
          error: null,
        },
      },
    });
    emitServerMessage(proc, {
      method: 'item/completed',
      params: {
        threadId: 'thread-child',
        turnId: 'child-turn',
        item: {
          id: 'child-item',
          type: 'agentMessage',
          text: 'child result',
        },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-child',
        turn: {
          id: 'child-turn',
          status: 'completed',
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
          id: 'stale-root-turn',
          status: 'completed',
          items: [],
          error: null,
        },
      },
    });
    await flush();
    const settled = jest.fn();
    void outcomePromise.then(settled);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    emitServerMessage(proc, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'root-item',
          type: 'agentMessage',
          text: 'root result',
        },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: [],
          error: null,
        },
      },
    });

    await expect(outcomePromise).resolves.toMatchObject({
      status: 'completed',
      turnId: 'turn-1',
      finalText: 'root result',
    });
    expect(
      onEvent.mock.calls.some(
        ([event]) =>
          event.method === 'item/started' &&
          event.params.threadId === 'thread-child',
      ),
    ).toBe(true);
    await service.shutdown();
  });

  it('returns protocol-shaped declines for runtime MCP elicitations', async () => {
    const { service } = await createThread(proc);
    collectClientMessages(proc);

    emitServerMessage(proc, {
      id: 'mcp-elicitation',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        serverName: 'github',
        mode: 'form',
        message: 'Provide input',
        requestedSchema: {},
      },
    });
    await flush();

    expect(collectClientMessages(proc)).toContainEqual({
      id: 'mcp-elicitation',
      result: { action: 'decline', content: null, _meta: null },
    });
    await service.shutdown();
  });

  it('admits a unique selected MCP call without an ID and declines an approval resolved after cancellation', async () => {
    const { service, handle } = await createThread(proc);
    collectClientMessages(proc);
    const abortController = new AbortController();
    const approval: {
      resolve?: (result: {
        approved: boolean;
        externalMutation: boolean;
      }) => void;
    } = {};
    const lateApproval = new Promise<{
      approved: boolean;
      externalMutation: boolean;
    }>((resolve) => {
      approval.resolve = resolve;
    });
    const evaluate = jest.fn().mockReturnValue({
      approved: true,
      externalMutation: true,
    });
    evaluate.mockReturnValueOnce({ approved: true, externalMutation: true });
    evaluate.mockReturnValueOnce(lateApproval);
    const outcome = handle.runTurn({
      input: [
        { type: 'text', text: 'Call review_evidence', text_elements: [] },
      ],
      signal: abortController.signal,
      mcpElicitationPolicy: {
        allowExternalMutation: true,
        evaluate,
      },
    });
    await flush();
    const start = collectClientMessages(proc).find(
      (message) => message.method === 'turn/start',
    );
    if (!start) throw new Error('Expected turn/start');
    emitServerMessage(proc, {
      id: start.id,
      result: {
        turn: { id: 'turn-mcp', status: 'inProgress', items: [], error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-mcp', status: 'inProgress', items: [], error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-mcp',
        item: {
          id: 'mcp-call-1',
          type: 'mcpToolCall',
          server: 'selected-review',
          tool: 'review_evidence',
          arguments: {},
        },
      },
    });
    emitServerMessage(proc, {
      id: 'mcp-approval',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-mcp',
        serverName: 'selected-review',
        mode: 'form',
        _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: {} },
        message: 'Approve review_evidence',
        requestedSchema: {},
      },
    });
    await flush();

    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'selected-review',
        toolName: 'review_evidence',
        normalizedArguments: '{}',
      }),
    );
    expect(collectClientMessages(proc)).toContainEqual({
      id: 'mcp-approval',
      result: { action: 'accept', content: null, _meta: null },
    });
    emitServerMessage(proc, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-mcp',
        item: { id: 'mcp-call-1', type: 'mcpToolCall' },
      },
    });
    emitServerMessage(proc, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-mcp',
        item: {
          id: 'mcp-call-2',
          type: 'mcpToolCall',
          server: 'selected-review',
          tool: 'review_evidence',
          arguments: {},
        },
      },
    });
    emitServerMessage(proc, {
      id: 'late-mcp-approval',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-mcp',
        serverName: 'selected-review',
        mode: 'form',
        _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: {} },
      },
    });
    await flush();
    abortController.abort();
    await flush();
    const interrupt = collectClientMessages(proc).find(
      (message) => message.method === 'turn/interrupt',
    );
    if (!interrupt) throw new Error('Expected turn/interrupt');
    emitServerMessage(proc, { id: interrupt.id, result: {} });
    if (!approval.resolve)
      throw new Error('Expected pending approval resolver');
    approval.resolve({ approved: true, externalMutation: true });
    await flush();
    expect(collectClientMessages(proc)).toContainEqual({
      id: 'late-mcp-approval',
      result: { action: 'decline', content: null, _meta: null },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-mcp', status: 'interrupted', items: [], error: null },
      },
    });
    await expect(outcome).resolves.toMatchObject({ status: 'interrupted' });
    await service.shutdown();
  });

  it('declines ambiguous, forged and completed MCP approvals while preserving explicit call IDs', async () => {
    const { service, handle } = await createThread(proc);
    collectClientMessages(proc);
    const evaluate = jest.fn().mockReturnValue({
      approved: true,
      externalMutation: true,
    });
    const outcome = handle.runTurn({
      input: [{ type: 'text', text: 'Call MCP', text_elements: [] }],
      mcpElicitationPolicy: { allowExternalMutation: true, evaluate },
    });
    await flush();
    const start = collectClientMessages(proc).find(
      (message) => message.method === 'turn/start',
    );
    if (!start) throw new Error('Expected turn/start');
    emitServerMessage(proc, {
      id: start.id,
      result: {
        turn: { id: 'turn-mcp', status: 'inProgress', items: [], error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-mcp', status: 'inProgress', items: [], error: null },
      },
    });
    for (const id of ['mcp-call-1', 'mcp-call-2'])
      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-mcp',
          item: {
            id,
            type: 'mcpToolCall',
            server: 'selected-review',
            tool: 'review_evidence',
            arguments: {},
          },
        },
      });
    await flush();
    const request = (id: string, meta: Record<string, unknown> = {}): void =>
      emitServerMessage(proc, {
        id,
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-mcp',
          serverName: 'selected-review',
          mode: 'form',
          _meta: {
            codex_approval_kind: 'mcp_tool_call',
            tool_params: {},
            ...meta,
          },
        },
      });

    request('ambiguous');
    request('forged-id', { codex_mcp_tool_call_id: 'missing-call' });
    request('malformed-name', {
      codex_mcp_tool_call_id: 'mcp-call-1',
      tool_name: 42,
    });
    request('explicit-id', { codex_mcp_tool_call_id: 'mcp-call-1' });
    await flush();
    expect(collectClientMessages(proc)).toEqual(
      expect.arrayContaining([
        {
          id: 'ambiguous',
          result: { action: 'decline', content: null, _meta: null },
        },
        {
          id: 'forged-id',
          result: { action: 'decline', content: null, _meta: null },
        },
        {
          id: 'malformed-name',
          result: { action: 'decline', content: null, _meta: null },
        },
        {
          id: 'explicit-id',
          result: { action: 'accept', content: null, _meta: null },
        },
      ]),
    );
    expect(evaluate).toHaveBeenCalledTimes(1);

    emitServerMessage(proc, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-mcp',
        item: { id: 'mcp-call-2', type: 'mcpToolCall' },
      },
    });
    request('unique-after-completion');
    await flush();
    expect(collectClientMessages(proc)).toContainEqual({
      id: 'unique-after-completion',
      result: { action: 'accept', content: null, _meta: null },
    });

    emitServerMessage(proc, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-mcp',
        item: { id: 'mcp-call-1', type: 'mcpToolCall' },
      },
    });
    request('completed-call');
    await flush();
    expect(collectClientMessages(proc)).toContainEqual({
      id: 'completed-call',
      result: { action: 'decline', content: null, _meta: null },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-mcp', status: 'completed', items: [], error: null },
      },
    });
    await expect(outcome).resolves.toMatchObject({ status: 'completed' });
    await service.shutdown();
  });

  it('returns a JSON-RPC error for runtime request-user-input approvals', async () => {
    const { service } = await createThread(proc);
    collectClientMessages(proc);

    emitServerMessage(proc, {
      id: 'request-user-input-approval',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        itemId: 'mcp-call-1',
        questions: [
          {
            id: 'mcp_tool_call_approval_mcp-call-1',
            header: 'Approve app tool call?',
            question: 'Allow this tool call?',
            isOther: false,
            isSecret: false,
            options: [],
          },
        ],
      },
    });
    await flush();

    expect(collectClientMessages(proc)).toContainEqual({
      id: 'request-user-input-approval',
      error: {
        code: -32000,
        message: 'User input is unavailable for this runtime policy',
      },
    });
    await service.shutdown();
  });

  describe('terminal deadline while the shared pipe is backlogged', () => {
    /** One mebibyte agent-message delta for `threadId`. */
    function largeDelta(
      threadId: string,
      turnId: string,
      index: number,
    ): Record<string, unknown> {
      return {
        method: 'item/agentMessage/delta',
        params: {
          threadId,
          turnId,
          itemId: `item-${String(index)}`,
          delta: 'x'.repeat(1024 * 1024),
        },
      };
    }

    async function interruptBehindPeerBacklog(): Promise<{
      service: ReturnType<typeof createCodexRuntimeService>;
      outcome: ReturnType<
        Awaited<ReturnType<typeof startPeerThread>>['runTurn']
      >;
      peerOutcome: ReturnType<
        Awaited<ReturnType<typeof startPeerThread>>['runTurn']
      >;
      releasePeer: () => void;
    }> {
      const { service, handle } = await createThread(proc);
      collectClientMessages(proc);
      const peer = await startPeerThread(proc, service, 'thread-peer');
      jest.useFakeTimers();
      // The peer chat's durable commits are slow: its first event holds its
      // lane, so its later frames queue on the shared pipe.
      let releasePeer = (): void => undefined;
      const peerAdmission = new Promise<void>((resolve) => {
        releasePeer = resolve;
      });
      const peerOutcome = peer.runTurn({
        input: [{ type: 'text', text: 'peer', text_elements: [] }],
        onEvent: () => peerAdmission,
      });
      await jest.advanceTimersByTimeAsync(0);
      acceptTurnStart(proc, 'turn-peer');
      await jest.advanceTimersByTimeAsync(0);

      const outcome = handle.runTurn({
        input: [{ type: 'text', text: 'helper', text_elements: [] }],
        totalTimeoutMs: 10,
      });
      await jest.advanceTimersByTimeAsync(0);
      acceptTurnStart(proc, 'turn-1');
      await jest.advanceTimersByTimeAsync(0);
      emitServerMessage(proc, largeDelta('thread-peer', 'turn-peer', 0));
      await jest.advanceTimersByTimeAsync(10);
      const interrupt = collectClientMessages(proc).find(
        (message) => message.method === 'turn/interrupt',
      );
      if (!interrupt) throw new Error('expected turn/interrupt request');
      emitServerMessage(proc, { id: interrupt.id, result: {} });
      await jest.advanceTimersByTimeAsync(0);
      // Nine more mebibytes for the held peer pause the shared stdout at the
      // 8 MiB retained-frame cap.
      for (let index = 1; index <= 9; index += 1)
        emitServerMessage(proc, largeDelta('thread-peer', 'turn-peer', index));
      await jest.advanceTimersByTimeAsync(0);
      // Codex has finished the interrupted turn; its terminal frame waits in
      // the paused pipe behind the peer's backlog.
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-1',
            status: 'interrupted',
            items: [],
            error: null,
          },
        },
      });
      await jest.advanceTimersByTimeAsync(0);
      return { service, outcome, peerOutcome, releasePeer };
    }

    afterEach(() => {
      jest.useRealTimers();
    });

    it('does not restart the shared worker while the terminal frame waits behind a peer backlog', async () => {
      const { service, outcome, peerOutcome, releasePeer } =
        await interruptBehindPeerBacklog();
      try {
        await jest.advanceTimersByTimeAsync(30_000);
        expect(proc.kill).not.toHaveBeenCalled();

        releasePeer();
        await jest.advanceTimersByTimeAsync(0);
        await expect(outcome).resolves.toMatchObject({
          status: 'interrupted',
        });
        expect(proc.kill).not.toHaveBeenCalled();
      } finally {
        releasePeer();
        acceptPeerCompletion();
        await jest.advanceTimersByTimeAsync(0);
        await peerOutcome.catch(() => undefined);
        await service.shutdown();
      }

      function acceptPeerCompletion(): void {
        emitServerMessage(proc, {
          method: 'turn/completed',
          params: {
            threadId: 'thread-peer',
            turn: {
              id: 'turn-peer',
              status: 'completed',
              items: [],
              error: null,
            },
          },
        });
      }
    });

    it('still restarts once the backlog outlasts the bounded extension', async () => {
      const { service, outcome, peerOutcome, releasePeer } =
        await interruptBehindPeerBacklog();
      try {
        await jest.advanceTimersByTimeAsync(5 * 60_000 + 5_000);
        await expect(outcome).resolves.toMatchObject({
          status: 'interrupted',
          error:
            'Codex turn did not emit a terminal notification after interrupt',
        });
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      } finally {
        releasePeer();
        await jest.advanceTimersByTimeAsync(0);
        await peerOutcome.catch(() => undefined);
        await service.shutdown();
      }
    });
  });
});
