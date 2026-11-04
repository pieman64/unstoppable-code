import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  WORKER_SCRIPT_INSTRUCTION_DEFINITIONS,
  WORKER_SCRIPT_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
  type WorkerScriptDescriptor,
  type WorkerScriptExecuteParams,
} from '@canopy/protocol/canopy-core';
import { MAX_SCRIPT_TIMEOUT_SECONDS } from '@canopy/protocol/scripts';

import { createCanopyDispatcher } from '../../../../runtime/dispatcher';
import type { CanopyDispatcher } from '../../../../runtime/types';
import {
  createInProcessWorkerBinding,
  localWorkerTransportOf,
} from '../../../../runtime/in-process-worker-binding';
import {
  createDirectLocalWorkerTransport,
  type LocalWorkerTransport,
} from '../../../../runtime/local-worker-transport';
import { createWorkerExecutorReceipts } from '../../../../runtime/worker-executor-receipts';
import { serializingWorkerPair } from '../../../../runtime/__tests__/serializing-worker-pair';
import {
  LocalWorkerExecution,
  OperationService,
  fingerprintExecutionSecret,
} from '../../../operations';
import { OperationLedger } from '../../../operations/ledger';
import {
  CORE_SCRIPT_RUN_KIND,
  CoreScriptRuns,
  ScriptExecutionWorker,
  createWorkerScriptHandlers,
  type CoreScriptRunRequest,
  type ScriptChildProcess,
  type ScriptExecutionPlace,
  type ScriptExecutionWorkerHost,
  type ScriptSpawnOptions,
  type ScriptTerminalPort,
} from '..';
import type {
  TerminalCreateRequest,
  WorkerTerminalEventListener,
} from '../../../terminal';
import {
  TERMINAL_USER_CLOSE_SIGNAL,
  type TerminalSession,
} from '@canopy/protocol/terminal';

const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'test-core',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: ['worker.script.execute', 'worker.script.read'],
};
const instructions = WORKER_SCRIPT_INSTRUCTION_DEFINITIONS;
const definitions = {
  queries: WORKER_SCRIPT_QUERY_DEFINITIONS,
  instructions,
  streams: {},
};
const script: WorkerScriptDescriptor = {
  scriptKey: 'project:setup',
  scriptName: 'setup',
  label: 'Setup',
  command: 'echo one',
  lifecycle: 'setup',
  target: 'project',
};

let root: string;

function nodeSpawn(
  command: string,
  args: string[],
  options: ScriptSpawnOptions,
): ScriptChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: options.detached,
  });
  return {
    get pid(): number | undefined {
      return child.pid;
    },
    stdout: {
      onData: (listener): void => void child.stdout.on('data', listener),
      destroy: (): void => {
        child.stdout.destroy();
      },
    },
    stderr: {
      onData: (listener): void => void child.stderr.on('data', listener),
      destroy: (): void => {
        child.stderr.destroy();
      },
    },
    onError: (listener): void => void child.on('error', listener),
    onClose: (listener): void => void child.on('close', listener),
    killGroup: (signal): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Already gone.
      }
    },
  };
}

function testHost(): ScriptExecutionWorkerHost {
  const kill = (pid: number | undefined, signal: NodeJS.Signals): void => {
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  };
  return {
    authorityId: 'authority',
    targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
    platform: () => 'linux',
    findExecutable: () => null,
    windowsGitBash: () => null,
    cmdCommandLine: (path) => path,
    loginShell: () => undefined,
    comSpec: () => undefined,
    prepareLaunch: (command, args) => ({ command, args }),
    lowerPriority: () => undefined,
    spawn: nodeSpawn,
    drainOwnedProcess: (pid): Promise<void> => {
      kill(pid, 'SIGKILL');
      return Promise.resolve();
    },
    logPaths: {
      runDir: (projectId, worktreeId) =>
        join(root, 'runs', projectId, worktreeId),
      fileStem: (scriptKey) => scriptKey.replace(/[^a-z0-9]+/g, '-'),
    },
    logFiles: {
      writeFileAtomically: (path, text): Promise<void> => {
        writeFileSync(`${path}.tmp`, text);
        renameSync(`${path}.tmp`, path);
        return Promise.resolve();
      },
    },
    resolvePlace: () =>
      Promise.resolve({
        cwd: join(root, 'checkout'),
        // No profile is read: HOME is an empty directory.
        env: { PATH: process.env.PATH ?? '', HOME: join(root, 'home') },
      }),
  };
}

interface Composition {
  worker: ScriptExecutionWorker;
  dispatcher: CanopyDispatcher<
    typeof WORKER_SCRIPT_QUERY_DEFINITIONS,
    typeof WORKER_SCRIPT_INSTRUCTION_DEFINITIONS,
    Record<never, never>
  >;
  transport: LocalWorkerTransport;
  close(): void;
}

/** Electron main's direct call and the daemon's bundled binding. */
function compose(
  kind: 'direct' | 'bundled',
  host: ScriptExecutionWorkerHost = testHost(),
): Composition {
  const worker = new ScriptExecutionWorker(host);
  const handlers = createWorkerScriptHandlers(worker);
  const receipts = createWorkerExecutorReceipts(instructions);
  const workerHandlers = {
    queries: handlers.queries,
    instructions: receipts.wrap(handlers.instructions),
    streams: {},
  };
  const dispatcher = createCanopyDispatcher({
    profile: kind === 'direct' ? 'core+worker' : 'worker',
    definitions,
    handlers: workerHandlers,
  });
  if (kind === 'direct')
    return {
      worker,
      dispatcher,
      transport: createDirectLocalWorkerTransport({
        dispatcher,
        instructions,
        caller,
        receipts,
      }),
      close: () => void dispatcher.shutdown(),
    };
  const pair = serializingWorkerPair();
  const binding = createInProcessWorkerBinding({
    dispatcher,
    definitions,
    caller,
    pair,
    receipts,
  });
  return {
    worker,
    dispatcher,
    transport: localWorkerTransportOf(binding, instructions),
    close: (): void => {
      binding.close();
      void dispatcher.shutdown();
    },
  };
}

function core(
  composition: Composition,
  ledgerPath: string,
): {
  operations: OperationService;
  localWorker: LocalWorkerExecution;
  runs: CoreScriptRuns;
} {
  const operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  const localWorker = new LocalWorkerExecution({
    operations,
    transport: composition.transport,
  });
  const runs = new CoreScriptRuns({
    operations,
    localWorker,
    observe: (id, observer): (() => void) =>
      composition.worker.observe(id, observer),
  });
  return { operations, localWorker, runs };
}

function request(
  command: string,
  overrides: Partial<WorkerScriptExecuteParams> = {},
): CoreScriptRunRequest {
  return {
    params: {
      scope: { workspaceId: 'ws', worktreeId: 'wt' },
      context: { kind: 'project' },
      command,
      shellStartup: 'login',
      timeoutMs: null,
      priority: 'normal',
      record: { script, invocation: 'manual-run' },
      ...overrides,
    },
    origin: { kind: 'client', sourceId: 'test' },
    owner: { kind: 'system', id: 'test' },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'worker-scripts-'));
  mkdirSync(join(root, 'checkout'));
  mkdirSync(join(root, 'home'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

it('keeps the protocol timeout ceiling with the script model', () => {
  expect(
    instructions['worker.script.execute'].params.safeParse({
      ...request('true').params,
      executionId: 'run',
      timeoutMs: MAX_SCRIPT_TIMEOUT_SECONDS * 1000 + 1,
    }).success,
  ).toBe(false);
});

describe.each(['direct', 'bundled'] as const)(
  'script runs over the %s local worker',
  (kind) => {
    it('records the run and its dispatch, and serves its bounded log', async () => {
      const composition = compose(kind);
      const { operations, localWorker, runs } = core(
        composition,
        join(root, 'ledger.sqlite'),
      );
      try {
        const lines: string[] = [];
        const outcome = await runs.run(
          {
            ...request('echo one; echo two >&2; exit 3'),
            secrets: [
              { name: 'TOKEN', fingerprint: fingerprintExecutionSecret('v') },
            ],
          },
          { observer: { onLines: (batch) => lines.push(...batch) } },
        );

        expect(outcome).toMatchObject({
          status: 'completed',
          result: {
            status: 'failed',
            exitCode: 3,
            timedOut: false,
            recorded: true,
          },
        });
        expect(lines).toEqual(['one', 'two']);
        const parent = await operations.get(outcome.operationId);
        expect(parent).toMatchObject({
          kind: CORE_SCRIPT_RUN_KIND,
          status: 'completed',
          outcome: { status: 'failed', exitCode: 3 },
        });
        const [delegation] = await localWorker.listDelegations(
          outcome.operationId,
        );
        if (!delegation) throw new Error('The run was not dispatched.');
        expect(delegation).toMatchObject({
          targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
          operation: { name: 'worker.script.execute', idempotency: 'keyed' },
          idempotencyKey: outcome.executionId,
          secrets: [{ name: 'TOKEN' }],
        });
        expect(JSON.stringify(delegation)).not.toContain('"v"');
        expect(await operations.get(delegation.childOperationId)).toMatchObject(
          {
            kind: 'worker.script.execute',
            status: 'completed',
            parentOperationId: outcome.operationId,
          },
        );

        const read = await composition.dispatcher.query(
          'worker.script.execution.get',
          {
            scope: { workspaceId: 'ws', worktreeId: 'wt' },
            scriptKey: script.scriptKey,
            tailLines: 1,
          },
          { caller },
        );
        expect(read.run).toMatchObject({
          execution: {
            executionId: outcome.executionId,
            status: 'failed',
            exitCode: 3,
          },
          lines: ['two'],
        });
      } finally {
        operations.close();
        composition.close();
      }
    });

    it('stops the process when any caller cancels the run', async () => {
      const composition = compose(kind);
      const { operations, runs } = core(
        composition,
        join(root, 'ledger.sqlite'),
      );
      try {
        let started!: () => void;
        const processStarted = new Promise<void>((resolve) => {
          started = resolve;
        });
        const running = runs.run(request('sleep 30'), {
          observer: { onProcessStarted: () => started() },
        });
        await processStarted;
        const [parent] = (
          await operations.list({ kinds: [CORE_SCRIPT_RUN_KIND], limit: 10 })
        ).items;
        await operations.cancel(parent.operationId, {
          reason: 'test',
          requestedBy: 'another-client',
        });
        const outcome = await running;

        expect(outcome).toMatchObject({ status: 'cancelled' });
        expect(await operations.get(outcome.operationId)).toMatchObject({
          status: 'cancelled',
        });
        const { run } = await composition.worker.get({
          scope: { workspaceId: 'ws', worktreeId: 'wt' },
          scriptKey: script.scriptKey,
        });
        expect(run?.execution).toMatchObject({
          status: 'cancelled',
          exitCode: null,
        });
      } finally {
        operations.close();
        composition.close();
      }
    }, 15_000);
  },
);

it('stops a script key through worker.script.execution.cancel', async () => {
  const composition = compose('direct');
  const { operations, runs } = core(composition, join(root, 'ledger.sqlite'));
  try {
    let started!: () => void;
    const processStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const running = runs.run(request('sleep 30'), {
      observer: { onProcessStarted: () => started() },
    });
    await processStarted;
    const cancelled = await composition.dispatcher.instruction(
      'worker.script.execution.cancel',
      {
        scope: { workspaceId: 'ws', worktreeId: 'wt' },
        scriptKey: script.scriptKey,
      },
      { caller, metadata: { idempotencyKey: 'stop-1' } },
    );
    const outcome = await running;

    expect(cancelled.stopped).toEqual([
      expect.objectContaining({
        executionId: outcome.executionId,
        status: 'cancelled',
      }),
    ]);
    expect(outcome.status).toBe('cancelled');
  } finally {
    operations.close();
    composition.close();
  }
}, 15_000);

it('fails a timed-out run without an exit code', async () => {
  const composition = compose('direct');
  const { operations, runs } = core(composition, join(root, 'ledger.sqlite'));
  try {
    const outcome = await runs.run(request('sleep 30', { timeoutMs: 200 }));
    expect(outcome).toMatchObject({
      status: 'completed',
      result: { status: 'failed', timedOut: true },
    });
  } finally {
    operations.close();
    composition.close();
  }
}, 15_000);

it('reports a run a restart interrupted as lost, in its log and its records', async () => {
  const ledgerPath = join(root, 'ledger.sqlite');
  const first = compose('direct');
  const before = core(first, ledgerPath);
  let started!: () => void;
  const processStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const running = before.runs.run(request('sleep 30'), {
    observer: { onProcessStarted: () => started() },
  });
  await processStarted;
  const [parent] = (
    await before.operations.list({ kinds: [CORE_SCRIPT_RUN_KIND], limit: 10 })
  ).items;
  // The process ends without reaching the ledger: the restart finds both
  // operations unfinished.
  before.operations.close();

  const second = compose('direct');
  const after = core(second, ledgerPath);
  try {
    await after.operations.whenReconciled();
    expect(await after.operations.get(parent.operationId)).toMatchObject({
      status: 'failed',
      restart: { class: 'lost', disposition: 'lost' },
    });
    const { run } = await second.worker.get({
      scope: { workspaceId: 'ws', worktreeId: 'wt' },
      scriptKey: script.scriptKey,
    });
    expect(run?.execution).toMatchObject({
      executionId: parent.scope.executionId,
      status: 'lost',
      exitCode: null,
    });
  } finally {
    first.worker.registry.stopAll();
    await running.catch(() => undefined);
    after.operations.close();
    first.close();
    second.close();
  }
}, 15_000);

it('replays a keyed run instead of running the script again', async () => {
  const composition = compose('direct');
  try {
    const params = {
      ...request('echo run >> runs.txt').params,
      executionId: 'run-1',
    };
    const options = {
      caller,
      metadata: { idempotencyKey: 'key-1' },
    };
    const first = await composition.dispatcher.instruction(
      'worker.script.execute',
      params,
      options,
    );
    const again = await composition.dispatcher.instruction(
      'worker.script.execute',
      params,
      options,
    );

    expect(again).toEqual(first);
    expect(readFileSync(join(root, 'checkout', 'runs.txt'), 'utf8')).toBe(
      'run\n',
    );
    await expect(
      composition.dispatcher.instruction(
        'worker.script.execute',
        { ...params, command: 'true' },
        options,
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.script.idempotencyKeyReused' },
    });
  } finally {
    composition.close();
  }
});

it('leaves no running log when the host refuses a start', async () => {
  const worker = new ScriptExecutionWorker({
    ...testHost(),
    assertStartAllowed: (): void => {
      throw new Error('The worktree is being archived.');
    },
  });
  await expect(
    worker.execute({ ...request('true').params, executionId: 'run-1' }),
  ).rejects.toThrow('The worktree is being archived.');
  expect(
    (
      await worker.get({
        scope: { workspaceId: 'ws', worktreeId: 'wt' },
        scriptKey: script.scriptKey,
      })
    ).run,
  ).toBeNull();
});

it('buffers no lines for a gate that only reads raw output', async () => {
  const composition = compose('direct');
  const { operations, runs } = core(composition, join(root, 'ledger.sqlite'));
  try {
    const chunks: string[] = [];
    const observer = {
      onData: (chunk: Buffer): void => {
        chunks.push(chunk.toString('utf8'));
      },
    };
    const outcome = await runs.run(
      request('printf gate-output', { record: undefined }),
      { observer },
    );
    expect(outcome).toMatchObject({
      status: 'completed',
      result: { status: 'success', recorded: false },
    });
    expect(chunks.join('')).toBe('gate-output');
  } finally {
    operations.close();
    composition.close();
  }
});

it('cancels a run stopped while it is starting, before spawning it', async () => {
  const host = testHost();
  let release!: () => void;
  const placed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = new ScriptExecutionWorker({
    ...host,
    resolvePlace: async (scope, context): Promise<ScriptExecutionPlace> => {
      await placed;
      return host.resolvePlace(scope, context);
    },
  });
  const running = worker.execute({
    ...request('echo spawned > spawned.txt').params,
    executionId: 'run-1',
  });
  const cancelling = worker.cancel({
    scope: { workspaceId: 'ws', worktreeId: 'wt' },
    scriptKey: script.scriptKey,
  });
  release();

  expect(await running).toMatchObject({
    status: 'cancelled',
    exitCode: null,
  });
  expect((await cancelling).stopped).toEqual([
    expect.objectContaining({ executionId: 'run-1', status: 'cancelled' }),
  ]);
  expect(() => readFileSync(join(root, 'checkout', 'spawned.txt'))).toThrow();
  const { run } = await worker.get({
    scope: { workspaceId: 'ws', worktreeId: 'wt' },
    scriptKey: script.scriptKey,
  });
  expect(run?.execution.status).toBe('cancelled');
});

it('records a run cancelled before its dispatch as cancelled', async () => {
  const composition = compose('direct');
  const { operations, runs } = core(composition, join(root, 'ledger.sqlite'));
  try {
    const stop = new AbortController();
    stop.abort();
    const outcome = await runs.run(request('echo spawned > spawned.txt'), {
      signal: stop.signal,
    });

    expect(outcome.status).toBe('cancelled');
    expect(await operations.get(outcome.operationId)).toMatchObject({
      status: 'cancelled',
    });
    expect(() => readFileSync(join(root, 'checkout', 'spawned.txt'))).toThrow();
  } finally {
    operations.close();
    composition.close();
  }
});

it('stops a script key whose run has not reached the worker yet', async () => {
  const composition = compose('direct');
  const { operations, runs } = core(composition, join(root, 'ledger.sqlite'));
  try {
    const running = runs.run(request('echo spawned > spawned.txt'), {
      observer: {},
    });
    const stopped = await runs.cancelInFlight({
      workspaceId: 'ws',
      worktreeId: 'wt',
      scriptKey: script.scriptKey,
    });
    const outcome = await running;

    expect(outcome.status).toBe('cancelled');
    expect(stopped).toEqual([outcome]);
    expect(await operations.get(outcome.operationId)).toMatchObject({
      status: 'cancelled',
    });
    expect(() => readFileSync(join(root, 'checkout', 'spawned.txt'))).toThrow();
  } finally {
    operations.close();
    composition.close();
  }
});

/** The worker's terminals, as the terminal engine's port exposes them. */
function fakeTerminals(): ScriptTerminalPort & {
  created: TerminalCreateRequest[];
  killed: string[];
  output(terminalId: string, data: string | Uint8Array): void;
  exit(terminalId: string, exitCode: number, signal?: string): void;
} {
  const listeners = new Set<WorkerTerminalEventListener>();
  const emit: WorkerTerminalEventListener = (event) =>
    listeners.forEach((listener) => listener(event));
  const created: TerminalCreateRequest[] = [];
  const killed: string[] = [];
  const scope = (
    terminalId: string,
  ): { projectId: string; worktreeId: string; terminalId: string } => ({
    projectId: 'ws',
    worktreeId: 'wt',
    terminalId,
  });
  let seq = 0;
  return {
    created,
    killed,
    create: (request): TerminalSession => {
      created.push(request);
      return {
        id: `terminal-${created.length}`,
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        shell: request.managedCommand?.executable ?? '/bin/bash',
        shellBasename: 'bash',
        cwd: request.cwd ?? '',
        createdAt: Date.now(),
        kind: 'script',
      };
    },
    kill: (terminalId): void => {
      killed.push(terminalId);
      emit({
        type: 'exit',
        payload: { ...scope(terminalId), exitCode: 0, signal: 'SIGHUP' },
      });
    },
    release: () => Promise.resolve(),
    lowerPriority: () => undefined,
    addEventListener: (listener) => {
      listeners.add(listener);
      return (): void => void listeners.delete(listener);
    },
    output: (terminalId, data): void => {
      const bytes =
        typeof data === 'string' ? new TextEncoder().encode(data) : data;
      seq += bytes.length;
      emit({
        type: 'output',
        payload: { ...scope(terminalId), data: bytes, seq },
      });
    },
    exit: (terminalId, exitCode, signal): void =>
      emit({
        type: 'exit',
        payload: { ...scope(terminalId), exitCode, signal: signal ?? null },
      }),
  };
}

describe('terminal-backed runs (CAN-5082)', () => {
  const terminal = { terminal: {} };

  it('records the run and its dispatch, and runs it in a worker terminal with exactly its place', async () => {
    const terminals = fakeTerminals();
    const registerProcess = jest.fn(() => undefined);
    const composition = compose('bundled', {
      ...testHost(),
      registerProcess,
      revealTerminal: (tracking): boolean =>
        tracking.invocation === 'manual-run',
      terminals: () => Promise.resolve(terminals),
      resolvePlace: () =>
        Promise.resolve({ cwd: '/run-copy/repo', env: { ONLY: 'declared' } }),
    });
    const { operations, localWorker, runs } = core(
      composition,
      join(root, 'ledger.sqlite'),
    );
    try {
      let started!: () => void;
      const processStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const lines: string[] = [];
      const running = runs.run(request('read answer', terminal), {
        observer: {
          onProcessStarted: () => started(),
          onLines: (batch) => lines.push(...batch),
        },
      });
      await processStarted;
      expect(terminals.created).toMatchObject([
        {
          projectId: 'ws',
          worktreeId: 'wt',
          cwd: '/run-copy/repo',
          environment: { ONLY: 'declared' },
          managedCommand: {
            args: ['-l', '-c', 'read answer'],
            env: { ONLY: 'declared' },
            title: 'Setup',
            kind: 'script',
            focusOnSpawn: true,
          },
        },
      ]);
      terminals.output('terminal-1', 'one\ntwo\n');
      terminals.exit('terminal-1', 0);
      const outcome = await running;

      expect(outcome).toMatchObject({
        status: 'completed',
        result: { status: 'success', exitCode: 0, recorded: true },
      });
      expect(lines).toEqual(['one', 'two']);
      // The terminal holds the run's execution lease; no script lease.
      expect(registerProcess).not.toHaveBeenCalled();
      const [delegation] = await localWorker.listDelegations(
        outcome.operationId,
      );
      expect(delegation).toMatchObject({
        targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
        operation: { name: 'worker.script.execute' },
      });
      const { run } = await composition.worker.get({
        scope: { workspaceId: 'ws', worktreeId: 'wt' },
        scriptKey: script.scriptKey,
        tailLines: 5,
      });
      expect(run).toMatchObject({
        execution: { status: 'success', exitCode: 0 },
        lines: ['one', 'two'],
      });
    } finally {
      operations.close();
      composition.close();
    }
  });

  it('kills the terminal when any caller cancels the run, and treats a user close as cancelled', async () => {
    const terminals = fakeTerminals();
    const composition = compose('direct', {
      ...testHost(),
      terminals: () => Promise.resolve(terminals),
    });
    const { operations, runs } = core(composition, join(root, 'ledger.sqlite'));
    try {
      let started!: () => void;
      let processStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const cancelled = runs.run(request('read answer', terminal), {
        observer: { onProcessStarted: () => started() },
      });
      await processStarted;
      const [parent] = (
        await operations.list({ kinds: [CORE_SCRIPT_RUN_KIND], limit: 10 })
      ).items;
      await operations.cancel(parent.operationId, {
        reason: 'test',
        requestedBy: 'another-client',
      });
      expect(await cancelled).toMatchObject({ status: 'cancelled' });
      expect(terminals.killed).toEqual(['terminal-1']);

      processStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const closed = runs.run(request('read answer', terminal), {
        observer: { onProcessStarted: () => started() },
      });
      await processStarted;
      terminals.exit('terminal-2', 0, TERMINAL_USER_CLOSE_SIGNAL);
      expect(await closed).toMatchObject({ status: 'cancelled' });
      const { run } = await composition.worker.get({
        scope: { workspaceId: 'ws', worktreeId: 'wt' },
        scriptKey: script.scriptKey,
      });
      expect(run?.execution).toMatchObject({
        status: 'cancelled',
        exitCode: null,
      });
    } finally {
      operations.close();
      composition.close();
    }
  });

  it('keeps a character split across two terminal chunks whole', async () => {
    const terminals = fakeTerminals();
    const worker = new ScriptExecutionWorker({
      ...testHost(),
      terminals: (): Promise<ScriptTerminalPort> => Promise.resolve(terminals),
    });
    const lines: string[] = [];
    const unobserve = worker.observe('run-1', {
      onLines: (batch) => lines.push(...batch),
      onProcessStarted: () => {
        const bytes = new TextEncoder().encode('caf\u00e9\n');
        terminals.output('terminal-1', bytes.subarray(0, 4));
        terminals.output('terminal-1', bytes.subarray(4));
        terminals.exit('terminal-1', 0);
      },
    });
    const result = await worker.execute({
      ...request('read answer', terminal).params,
      executionId: 'run-1',
    });
    unobserve();
    expect(result).toMatchObject({ status: 'success', outputBytes: 6 });
    expect(lines).toEqual(['caf\u00e9']);
  });

  it('closes the run log as failed when the terminals cannot be loaded', async () => {
    const worker = new ScriptExecutionWorker({
      ...testHost(),
      terminals: (): Promise<ScriptTerminalPort> =>
        Promise.reject(new Error('No terminal backend.')),
    });
    await expect(
      worker.execute({
        ...request('read answer', terminal).params,
        executionId: 'run-1',
      }),
    ).rejects.toThrow('No terminal backend.');
    const { run } = await worker.get({
      scope: { workspaceId: 'ws', worktreeId: 'wt' },
      scriptKey: script.scriptKey,
      tailLines: 5,
    });
    expect(run).toMatchObject({
      execution: { executionId: 'run-1', status: 'failed', exitCode: 1 },
      lines: ['No terminal backend.'],
    });
  });

  it('refuses a terminal run on a worker without terminals, before logging it', async () => {
    const worker = new ScriptExecutionWorker(testHost());
    await expect(
      worker.execute({
        ...request('read answer', terminal).params,
        executionId: 'run-1',
      }),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    expect(
      (
        await worker.get({
          scope: { workspaceId: 'ws', worktreeId: 'wt' },
          scriptKey: script.scriptKey,
        })
      ).run,
    ).toBeNull();
  });
});
