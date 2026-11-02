import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  type CanopyCallerDescriptor,
  type CanopyStreamCursor,
  type OperationRecord,
} from '@canopy/protocol/canopy-core';

import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { CanopyOperationError } from '../../../runtime/errors';
import {
  createInProcessWorkerBinding,
  localWorkerTransportOf,
} from '../../../runtime/in-process-worker-binding';
import {
  createDirectLocalWorkerTransport,
  type LocalWorkerTransport,
} from '../../../runtime/local-worker-transport';
import type { CanopyHandlerContext } from '../../../runtime/types';
import { createWorkerExecutorReceipts } from '../../../runtime/worker-executor-receipts';
import { serializingWorkerPair } from '../../../runtime/__tests__/serializing-worker-pair';
import {
  WORKER_EXAMPLE_EFFECT_INSTRUCTIONS,
  WORKER_EXAMPLE_INSTRUCTIONS,
} from '../../../runtime/__tests__/worker-example-definitions';
import {
  LocalWorkerExecution,
  OperationService,
  fingerprintExecutionSecret,
  type LocalWorkerDispatchResult,
} from '..';
import { OperationLedger } from '../ledger';

const WRITE = 'worker.example.write';
const APPEND = 'worker.example.append';
const instructions = {
  [WRITE]: WORKER_EXAMPLE_INSTRUCTIONS[WRITE],
  [APPEND]: WORKER_EXAMPLE_EFFECT_INSTRUCTIONS[APPEND],
};
const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'bundled-core',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: ['worker.example.write'],
};

type Behavior = (
  params: CanopyStreamCursor,
  context: CanopyHandlerContext,
) => Promise<CanopyStreamCursor>;

interface WorkerCall {
  operation: string;
  params: CanopyStreamCursor;
  signal: AbortSignal;
}

/** The worker side: handlers that run the test's behavior and record calls. */
function workerHandlers(
  calls: WorkerCall[],
  behave: Behavior,
): Record<string, (params: unknown, context: CanopyHandlerContext) => unknown> {
  const handler =
    (operation: string) =>
    (params: unknown, context: CanopyHandlerContext): Promise<unknown> => {
      const cursor = WORKER_EXAMPLE_INSTRUCTIONS[WRITE].params.parse(params);
      calls.push({ operation, params: cursor, signal: context.signal });
      return behave(cursor, context);
    };
  return { [WRITE]: handler(WRITE), [APPEND]: handler(APPEND) };
}

type BindingKind = 'direct' | 'bundled';

interface Composition {
  transport: LocalWorkerTransport;
  calls: WorkerCall[];
  disconnect(): void;
  close(): void;
}

/**
 * The two present compositions of the builtin worker: Electron main's single
 * dispatcher called directly, and the daemon's bundled binding over a pair
 * that serializes every envelope.
 */
function compose(kind: BindingKind, behave: Behavior): Composition {
  const calls: WorkerCall[] = [];
  const receipts = createWorkerExecutorReceipts(instructions);
  const handlers = {
    queries: {},
    instructions: receipts.wrap(workerHandlers(calls, behave)),
    streams: {},
  };
  const definitions = { queries: {}, instructions, streams: {} };
  if (kind === 'direct') {
    const dispatcher = createCanopyDispatcher({
      profile: 'core+worker',
      definitions,
      handlers,
    });
    return {
      transport: createDirectLocalWorkerTransport({
        dispatcher,
        instructions,
        caller,
        receipts,
      }),
      calls,
      disconnect: () => undefined,
      close: () => void dispatcher.shutdown(),
    };
  }
  const worker = createCanopyDispatcher({
    profile: 'worker',
    definitions,
    handlers,
  });
  const pair = serializingWorkerPair();
  const binding = createInProcessWorkerBinding({
    dispatcher: worker,
    definitions,
    caller,
    pair,
    receipts,
  });
  return {
    transport: localWorkerTransportOf(binding, instructions),
    calls,
    disconnect: () => pair.client.close(),
    close: (): void => {
      binding.close();
      void worker.shutdown();
    },
  };
}

let dir: string;
let dbPath: string;
let cleanup: Array<() => void>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'local-worker-'));
  dbPath = join(dir, 'operation-ledger.sqlite');
  cleanup = [];
});

afterEach(() => {
  for (const step of cleanup.reverse()) step();
  rmSync(dir, { recursive: true, force: true });
});

const PARENT = 'core.example.run';

interface Harness {
  operations: OperationService;
  execution: LocalWorkerExecution;
  composition: Composition;
  parent(): Promise<OperationRecord>;
}

function harness(kind: BindingKind, behave: Behavior): Harness {
  const operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(dbPath),
  });
  operations.registerDomain({
    domain: 'example',
    kinds: [PARENT],
    restartClass: 'lost',
    cancel: () => Promise.resolve('cancelled'),
  });
  const composition = compose(kind, behave);
  const execution = new LocalWorkerExecution({
    operations,
    transport: composition.transport,
  });
  cleanup.push(() => {
    composition.close();
    operations.close();
  });
  let counter = 0;
  return {
    operations,
    execution,
    composition,
    parent: async (): Promise<OperationRecord> => {
      counter += 1;
      const admitted = await operations.admit({
        kind: PARENT,
        status: 'running',
        origin: { kind: 'client', sourceId: 'window-a' },
        owner: { kind: 'organization', id: 'org-1' },
        scope: { workspaceId: 'alpha', worktreeId: 'main' },
        receipt: {
          caller: 'local-user',
          idempotencyKey: `run-${counter}`,
          fingerprint: 'parameters',
        },
      });
      return admitted.operation;
    },
  };
}

const echo: Behavior = (params) =>
  Promise.resolve({ daemonEpoch: 'result', sequence: params.sequence });

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !check(); attempt += 1)
    await new Promise((resolve) => setImmediate(resolve));
  if (!check()) throw new Error('Timed out waiting.');
}

const params = (sequence: number): CanopyStreamCursor => ({
  daemonEpoch: 'epoch',
  sequence,
});

describe.each<BindingKind>(['direct', 'bundled'])(
  'dispatch over the %s binding',
  (kind) => {
    it('records the resolved local worker before the work starts', async () => {
      let seen: unknown;
      const h = harness(kind, async (cursor, context) => {
        const [delegation] = await h.execution.listDelegations(
          parent.operationId,
        );
        const child = await h.operations.get(delegation.childOperationId);
        seen = { delegation, child };
        return echo(cursor, context);
      });
      const parent = await h.parent();
      const lease = await h.execution.lease();

      const result = await h.execution.dispatch({
        parentOperationId: parent.operationId,
        operation: WRITE,
        params: params(1),
        idempotencyKey: 'step-1',
      });

      expect(seen).toMatchObject({
        delegation: {
          state: 'dispatched',
          parentOperationId: parent.operationId,
          targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
          leaseId: lease.leaseId,
          operation: { name: WRITE, version: 1, idempotency: 'keyed' },
          activation: { delivery: 'inline-parameters' },
        },
        child: {
          kind: WRITE,
          status: 'running',
          parentOperationId: parent.operationId,
          rootOperationId: parent.operationId,
          executionTargetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
          origin: { kind: 'delegation', sourceId: parent.operationId },
          owner: parent.owner,
          scope: {
            ...parent.scope,
            targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
          },
        },
      });
      expect(result).toMatchObject({
        replayed: false,
        result: { daemonEpoch: 'result', sequence: 1 },
        operation: {
          status: 'completed',
          outcome: { daemonEpoch: 'result', sequence: 1 },
          runtimeDelegationId: result.delegation.delegationId,
        },
        delegation: { state: 'completed', resolution: 'reply' },
      });
      expect(lease).toMatchObject({
        targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
        binding: 'in-process',
        signal: 'process_liveness',
        renewAfterMs: null,
        ttlMs: null,
        expiresAt: null,
        releasedAt: null,
      });
      expect(h.composition.calls).toHaveLength(1);
    });

    it('records a worker failure from its reply', async () => {
      const h = harness(kind, () =>
        Promise.reject(
          new CanopyOperationError({
            kind: 'conflict',
            message: 'The example conflicts.',
            retry: { kind: 'never' },
          }),
        ),
      );
      const parent = await h.parent();
      const result = await h.execution.dispatch({
        parentOperationId: parent.operationId,
        operation: WRITE,
        params: params(1),
        idempotencyKey: 'step-1',
      });
      expect(result).toMatchObject({
        operation: {
          status: 'failed',
          error: { kind: 'conflict', message: 'The example conflicts.' },
        },
        delegation: { state: 'failed', resolution: 'reply' },
      });
    });

    it('returns the recorded child to a retry instead of sending it again', async () => {
      const h = harness(kind, echo);
      const parent = await h.parent();
      const request = {
        parentOperationId: parent.operationId,
        operation: WRITE,
        params: params(4),
        idempotencyKey: 'step-1',
      };
      const first = await h.execution.dispatch(request);
      const retry = await h.execution.dispatch(request);
      expect(retry).toMatchObject({
        replayed: true,
        result: { daemonEpoch: 'result', sequence: 4 },
        operation: { operationId: first.operation.operationId },
        delegation: { delegationId: first.delegation.delegationId },
      });
      await expect(
        h.execution.dispatch({ ...request, params: params(5) }),
      ).rejects.toMatchObject({ refusal: 'key-reused' });
      expect(h.composition.calls).toHaveLength(1);
    });

    it('joins a retry that arrives while the first is running', async () => {
      const gate = deferred();
      const h = harness(kind, async (cursor, context) => {
        await gate.promise;
        return echo(cursor, context);
      });
      const parent = await h.parent();
      const request = {
        parentOperationId: parent.operationId,
        operation: WRITE,
        params: params(2),
        idempotencyKey: 'step-1',
      };
      const first = h.execution.dispatch(request);
      await until(() => h.composition.calls.length === 1);
      const retry = h.execution.dispatch(request);
      gate.resolve();
      const [a, b] = await Promise.all([first, retry]);
      expect(b).toMatchObject({
        replayed: true,
        operation: {
          operationId: a.operation.operationId,
          status: 'completed',
        },
      });
      expect(h.composition.calls).toHaveLength(1);
    });

    it('carries a cancellation to the same child only', async () => {
      const gate = deferred();
      const h = harness(kind, async (cursor, context) => {
        await Promise.race([
          gate.promise,
          new Promise<never>((_resolve, reject) =>
            context.signal.addEventListener('abort', () =>
              reject(
                new CanopyOperationError({
                  kind: 'cancelled',
                  message: 'Stopped.',
                  retry: { kind: 'never' },
                }),
              ),
            ),
          ),
        ]);
        return echo(cursor, context);
      });
      const parent = await h.parent();
      const cancelled = h.execution.dispatch({
        parentOperationId: parent.operationId,
        operation: WRITE,
        params: params(1),
        idempotencyKey: 'step-1',
      });
      const sibling = h.execution.dispatch({
        parentOperationId: parent.operationId,
        operation: WRITE,
        params: params(2),
        idempotencyKey: 'step-2',
      });
      await until(() => h.composition.calls.length === 2);
      const [target] = await h.execution.listDelegations(parent.operationId);
      const outcome = await h.operations.cancel(target.childOperationId, {
        reason: 'Stop the first step.',
        requestedBy: 'local-user',
      });
      expect(outcome.outcome).toBe('requested');
      const stopped = await cancelled;
      gate.resolve();
      const finished = await sibling;

      const calls = h.composition.calls;
      expect(
        calls.find((call) => call.params.sequence === 1)?.signal.aborted,
      ).toBe(true);
      expect(
        calls.find((call) => call.params.sequence === 2)?.signal.aborted,
      ).toBe(false);
      expect(stopped).toMatchObject({
        operation: {
          status: 'cancelled',
          cancellation: { reason: 'Stop the first step.' },
        },
        delegation: { state: 'cancelled', resolution: 'executor-receipt' },
      });
      expect(finished.operation.status).toBe('completed');
      expect(calls).toHaveLength(2);
    });

    it('cascades a parent cancellation to its in-flight child', async () => {
      const h = harness(kind, async (cursor, context) => {
        await new Promise<void>((resolve) =>
          context.signal.addEventListener('abort', () => resolve()),
        );
        throw new CanopyOperationError({
          kind: 'cancelled',
          message: 'Stopped.',
          retry: { kind: 'never' },
        });
      });
      const parent = await h.parent();
      const child = h.execution.dispatch({
        parentOperationId: parent.operationId,
        operation: WRITE,
        params: params(1),
        idempotencyKey: 'step-1',
      });
      await until(() => h.composition.calls.length === 1);
      await h.operations.cancel(parent.operationId, {
        reason: 'Stop the run.',
        requestedBy: 'local-user',
      });
      const stopped = await child;
      expect(h.composition.calls[0].signal.aborted).toBe(true);
      expect(stopped.operation).toMatchObject({
        status: 'cancelled',
        cancellation: { reason: 'Stop the run.' },
      });
    });

    it('resolves an unknown reply from the worker receipt without a second attempt', async () => {
      const finished = deferred();
      const h = harness(kind, async (cursor) => {
        // Ignores the cancel: the work completes after the core gave up on it.
        await finished.promise;
        return { daemonEpoch: 'late', sequence: cursor.sequence };
      });
      const parent = await h.parent();
      const pending = h.execution.dispatch({
        parentOperationId: parent.operationId,
        operation: WRITE,
        params: params(7),
        idempotencyKey: 'step-1',
      });
      await until(() => h.composition.calls.length === 1);
      const [delegation] = await h.execution.listDelegations(
        parent.operationId,
      );
      await h.operations.cancel(delegation.childOperationId, {
        reason: 'Stop.',
        requestedBy: 'local-user',
      });
      await until(() => h.composition.calls[0].signal.aborted);
      await expect(
        h.execution.getDelegation(delegation.delegationId),
      ).resolves.toMatchObject({ state: 'reconciling' });
      finished.resolve();
      const result = await pending;
      expect(result).toMatchObject({
        result: { daemonEpoch: 'late', sequence: 7 },
        operation: {
          status: 'completed',
          outcome: { daemonEpoch: 'late', sequence: 7 },
        },
        delegation: { state: 'completed', resolution: 'executor-receipt' },
      });
      expect(h.composition.calls).toHaveLength(1);
    });

    it('records an unkeyed instruction whose reply is lost as unknown', async () => {
      const finished = deferred();
      const h = harness(kind, async (cursor) => {
        await finished.promise;
        return cursor;
      });
      const parent = await h.parent();
      const pending = h.execution.dispatch({
        parentOperationId: parent.operationId,
        operation: APPEND,
        params: params(1),
        idempotencyKey: 'step-1',
      });
      await until(() => h.composition.calls.length === 1);
      const [delegation] = await h.execution.listDelegations(
        parent.operationId,
      );
      expect(delegation.executorKey).toBeNull();
      await h.operations.cancel(delegation.childOperationId, {
        reason: 'Stop.',
        requestedBy: 'local-user',
      });
      const result = await pending;
      finished.resolve();
      expect(result).toMatchObject({
        operation: {
          status: 'failed',
          error: {
            code: 'core.delegation.outcomeUnknown',
            retry: { kind: 'never' },
          },
        },
        delegation: { state: 'failed', resolution: 'unqueryable' },
      });
      expect(h.composition.calls).toHaveLength(1);
    });

    it('records secrets by fingerprint and never stores parameters', async () => {
      const canary = 'canary-secret-value-91d2';
      const h = harness(kind, echo);
      const parent = await h.parent();
      const fingerprint = fingerprintExecutionSecret(canary);
      const result = await h.execution.dispatch({
        parentOperationId: parent.operationId,
        operation: WRITE,
        params: { daemonEpoch: canary, sequence: 3 },
        idempotencyKey: 'step-1',
        secrets: [{ name: 'API_TOKEN', fingerprint }],
      });
      expect(result.delegation.secrets).toEqual([
        { name: 'API_TOKEN', fingerprint },
      ]);
      await expect(
        h.execution.dispatch({
          parentOperationId: parent.operationId,
          operation: WRITE,
          params: params(1),
          idempotencyKey: 'step-2',
          secrets: [{ name: 'API_TOKEN', fingerprint: canary }],
        }),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
      h.operations.close();
      for (const file of readdirSync(dir))
        expect(readFileSync(join(dir, file)).includes(canary)).toBe(false);
    });

    it('refuses an operation the worker does not run without recording it', async () => {
      const h = harness(kind, echo);
      const parent = await h.parent();
      await expect(
        h.execution.dispatch({
          parentOperationId: parent.operationId,
          operation: 'worker.example.unknown',
          params: params(1),
          idempotencyKey: 'step-1',
        }),
      ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
      await expect(
        h.execution.dispatch({
          parentOperationId: parent.operationId,
          operation: WRITE,
          params: { sequence: 'one' },
          idempotencyKey: 'step-1',
        }),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
      await expect(
        h.execution.listDelegations(parent.operationId),
      ).resolves.toEqual([]);
    });

    it('settles an interrupted dispatch as lost after a restart', async () => {
      const h = harness(kind, () => new Promise<never>(() => undefined));
      const parent = await h.parent();
      void h.execution
        .dispatch({
          parentOperationId: parent.operationId,
          operation: WRITE,
          params: params(1),
          idempotencyKey: 'step-1',
        })
        .catch(() => undefined);
      await until(() => h.composition.calls.length === 1);
      const firstLease = await h.execution.lease();
      const [interrupted] = await h.execution.listDelegations(
        parent.operationId,
      );
      h.operations.close();

      const next = harness(kind, echo);
      const lease = await next.execution.lease();
      expect(lease.leaseId).not.toBe(firstLease.leaseId);
      const ledger = await next.operations.ready();
      expect(ledger.getLease(firstLease.leaseId)).toMatchObject({
        releaseReason: 'process-ended',
      });
      expect(
        await next.execution.getDelegation(interrupted.delegationId),
      ).toMatchObject({ state: 'failed', resolution: 'restart' });
      expect(
        await next.operations.get(interrupted.childOperationId),
      ).toMatchObject({
        status: 'failed',
        error: { code: 'core.operation.interrupted' },
        restart: { class: 'lost', disposition: 'lost' },
      });
    });
  },
);

describe('bundled binding loss', () => {
  it('settles a retry that joined a dispatch the worker can no longer answer', async () => {
    const h = harness('bundled', () => new Promise<never>(() => undefined));
    const parent = await h.parent();
    const request = {
      parentOperationId: parent.operationId,
      operation: WRITE,
      params: params(1),
      idempotencyKey: 'step-1',
    };
    const first = h.execution.dispatch(request);
    await until(() => h.composition.calls.length === 1);
    const retry = h.execution.dispatch(request);
    h.composition.disconnect();
    const [a, b] = await Promise.all([first, retry]);
    expect(b).toMatchObject({
      replayed: true,
      operation: { operationId: a.operation.operationId, status: 'running' },
      delegation: { state: 'unreachable' },
    });
    expect(h.composition.calls).toHaveLength(1);
  });

  it('marks the dispatch unreachable and leaves the child for restart', async () => {
    const h = harness('bundled', () => new Promise<never>(() => undefined));
    const parent = await h.parent();
    const pending = h.execution.dispatch({
      parentOperationId: parent.operationId,
      operation: WRITE,
      params: params(1),
      idempotencyKey: 'step-1',
    });
    await until(() => h.composition.calls.length === 1);
    h.composition.disconnect();
    const result = await pending;
    expect(result).toMatchObject({
      operation: { status: 'running' },
      delegation: { state: 'unreachable', resolution: null },
    });
    expect(h.composition.calls).toHaveLength(1);
  });
});

/** Records with run-specific identities and times replaced by placeholders. */
function normalized(value: unknown): unknown {
  const ids = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(value)
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        (match) => {
          if (!ids.has(match)) ids.set(match, `id-${ids.size}`);
          return ids.get(match) ?? match;
        },
      )
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, 'time'),
  );
}

async function scenarios(kind: BindingKind): Promise<unknown> {
  let mode: 'echo' | 'fail' | 'late' = 'echo';
  const late = deferred();
  const h = harness(kind, async (cursor) => {
    if (mode === 'fail')
      throw new CanopyOperationError({
        kind: 'conflict',
        message: 'The example conflicts.',
        retry: { kind: 'never' },
      });
    if (mode === 'late') await late.promise;
    return { daemonEpoch: mode, sequence: cursor.sequence };
  });
  const parent = await h.parent();
  const dispatch = (
    sequence: number,
    operation = WRITE,
  ): Promise<LocalWorkerDispatchResult> =>
    h.execution.dispatch({
      parentOperationId: parent.operationId,
      operation,
      params: params(sequence),
      idempotencyKey: `step-${sequence}`,
      secrets: [
        { name: 'TOKEN', fingerprint: fingerprintExecutionSecret('value') },
      ],
    });
  await dispatch(1);
  await dispatch(1);
  mode = 'fail';
  await dispatch(2);
  mode = 'late';
  const pending = dispatch(3);
  await until(() => h.composition.calls.length === 3);
  const [, , third] = await h.execution.listDelegations(parent.operationId);
  await h.operations.cancel(third.childOperationId, {
    reason: 'Stop.',
    requestedBy: 'local-user',
  });
  late.resolve();
  await pending;
  const ledger = await h.operations.ready();
  const delegations = await h.execution.listDelegations(parent.operationId);
  return normalized({
    target: ledger.getTarget(CANOPY_IN_PROCESS_WORKER_TARGET_ID),
    lease: await h.execution.lease(),
    delegations,
    children: delegations.map((delegation) =>
      ledger.get(delegation.childOperationId),
    ),
    events: delegations.map((delegation) =>
      ledger
        .eventsAfter(0)
        .filter(
          (event) =>
            event.operation.operationId === delegation.childOperationId,
        )
        .map((event) => [event.event, event.previousStatus]),
    ),
    calls: h.composition.calls.map(({ operation, params: cursor }) => ({
      operation,
      cursor,
    })),
  });
}

describe('binding parity', () => {
  it('writes identical records over the direct call and the serialized binding', async () => {
    const direct = await scenarios('direct');
    for (const step of cleanup.reverse()) step();
    cleanup = [];
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'local-worker-'));
    dbPath = join(dir, 'operation-ledger.sqlite');
    const bundled = await scenarios('bundled');
    expect(bundled).toEqual(direct);
    expect(direct).toMatchObject({
      delegations: [
        { state: 'completed', resolution: 'reply' },
        { state: 'failed', resolution: 'reply' },
        { state: 'completed', resolution: 'executor-receipt' },
      ],
    });
  });
});
