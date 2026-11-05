import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  WORKER_AGENT_HELPER_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
  type WorkerAgentHelperRunResult,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../../runtime/dispatcher';
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
import { LocalWorkerExecution, OperationService } from '../../../operations';
import { OperationLedger } from '../../../operations/ledger';
import {
  CORE_HELPER_RUN_KIND,
  CoreHelperRuns,
  createWorkerAgentHelperHandlers,
  type CoreHelperRunRequest,
  type HelperExecutionWorker,
} from '..';

const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'test-core',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: ['worker.agent.execute'],
};
const instructions = WORKER_AGENT_HELPER_INSTRUCTION_DEFINITIONS;
const definitions = { queries: {}, instructions, streams: {} };
interface Composition {
  transport: LocalWorkerTransport;
  close(): void;
}
function compose(
  kind: 'direct' | 'bundled',
  worker: HelperExecutionWorker,
): Composition {
  const receipts = createWorkerExecutorReceipts(instructions);
  const handlers = createWorkerAgentHelperHandlers(worker);
  const dispatcher = createCanopyDispatcher({
    profile: kind === 'direct' ? 'core+worker' : 'worker',
    definitions,
    handlers: {
      queries: {},
      instructions: receipts.wrap(handlers.instructions),
      streams: {},
    },
  });
  if (kind === 'direct')
    return {
      transport: createDirectLocalWorkerTransport({
        dispatcher,
        instructions,
        caller,
        receipts,
      }),
      close: () => void dispatcher.shutdown(),
    };
  const binding = createInProcessWorkerBinding({
    dispatcher,
    definitions,
    caller,
    pair: serializingWorkerPair(),
    receipts,
  });
  return {
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
  runs: CoreHelperRuns;
} {
  const operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  const localWorker = new LocalWorkerExecution({
    operations,
    transport: composition.transport,
  });
  return {
    operations,
    localWorker,
    runs: new CoreHelperRuns({ operations, localWorker }),
  };
}
function request(): CoreHelperRunRequest {
  return {
    params: {
      helperRunId: 'run',
      kind: 'chat_summary',
      scope: { workspaceId: 'ws', worktreeId: 'wt' },
      model: 'model',
    },
    origin: { kind: 'client', sourceId: 'test' },
    owner: { kind: 'system', id: 'test' },
  };
}
const digest = { present: true, sha256: `sha256:${'a'.repeat(64)}`, bytes: 4 };
function succeeded(): WorkerAgentHelperRunResult {
  return {
    helperRunId: 'run',
    kind: 'chat_summary',
    status: 'succeeded',
    usage: { inputTokens: 3 },
    result: digest,
  };
}
function deferred(): { promise: Promise<void>; resolve(): void } {
  let done = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { promise, resolve: () => done() };
}
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
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helper-runs-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.each(['direct', 'bundled'] as const)(
  'helper runs over the %s local worker',
  (kind) => {
    it('records the helper run and its dispatch before the worker runs it', async () => {
      const worker: HelperExecutionWorker = {
        run: async () => {
          const { items } = await h.operations.list({ limit: 10 });
          const parent = items.find(
            (item) => item.kind === CORE_HELPER_RUN_KIND,
          );
          expect(parent).toMatchObject({ status: 'running' });
          if (!parent) throw new Error('No parent');
          const [delegation] = await h.localWorker.listDelegations(
            parent.operationId,
          );
          expect(delegation).toMatchObject({
            targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
          });
          expect(
            items.find((item) => item.kind === 'worker.agent.helper.run'),
          ).toMatchObject({
            status: 'running',
            parentOperationId: parent.operationId,
          });
          return succeeded();
        },
      };
      const composition = compose(kind, worker);
      const h = core(composition, join(root, 'ledger.sqlite'));
      try {
        const outcome = await h.runs.run(request());
        expect(outcome.status).toBe('succeeded');
        expect(await h.operations.get(outcome.operationId)).toMatchObject({
          status: 'completed',
          outcome: { result: digest, usage: { inputTokens: 3 } },
        });
      } finally {
        h.operations.close();
        composition.close();
      }
    });

    it('cancelling the run aborts the worker run and keeps its usage', async () => {
      const started = deferred();
      const composition = compose(kind, {
        run: async (params, signal) => {
          started.resolve();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else
              signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return {
            helperRunId: params.helperRunId,
            kind: params.kind,
            status: 'cancelled',
            usage: { inputTokens: 5 },
          };
        },
      });
      const h = core(composition, join(root, 'ledger.sqlite'));
      try {
        const running = h.runs.run(request());
        await started.promise;
        const [parent] = (
          await h.operations.list({ kinds: [CORE_HELPER_RUN_KIND], limit: 10 })
        ).items;
        if (!parent) throw new Error('No parent');
        await h.operations.cancel(parent.operationId, {
          reason: 'Stop',
          requestedBy: 'another-client',
        });
        expect(await running).toMatchObject({
          status: 'cancelled',
          usage: { inputTokens: 5 },
        });
        expect(await h.operations.get(parent.operationId)).toMatchObject({
          status: 'cancelled',
        });
        const [delegation] = await h.localWorker.listDelegations(
          parent.operationId,
        );
        if (!delegation) throw new Error('No dispatch');
        expect(
          await h.operations.get(delegation.childOperationId),
        ).toMatchObject({
          status: 'cancelled',
          outcome: { usage: { inputTokens: 5 } },
        });
      } finally {
        h.operations.close();
        composition.close();
      }
    });

    it('records a failed helper with the portable error and its usage', async () => {
      const composition = compose(kind, {
        run: () =>
          Promise.resolve({
            helperRunId: 'run',
            kind: 'chat_summary',
            status: 'failed',
            error: {
              code: 'worker.agent.helperFailed',
              message: 'The helper model call failed.',
            },
            usage: { inputTokens: 7 },
          }),
      });
      const h = core(composition, join(root, 'ledger.sqlite'));
      try {
        const result = await h.runs.run(request());
        expect(result).toMatchObject({
          status: 'failed',
          usage: { inputTokens: 7 },
        });
        const parent = await h.operations.get(result.operationId);
        expect(parent?.error).toEqual({
          kind: 'internal',
          code: 'worker.agent.helperFailed',
          message: 'The helper model call failed.',
          retry: { kind: 'never' },
        });
        const [delegation] = await h.localWorker.listDelegations(
          result.operationId,
        );
        if (!delegation) throw new Error('No dispatch');
        const child = await h.operations.get(delegation.childOperationId);
        expect(child).toMatchObject({ outcome: { usage: { inputTokens: 7 } } });
        expect(JSON.stringify([parent, child])).not.toContain(
          'provider secret',
        );
      } finally {
        h.operations.close();
        composition.close();
      }
    });

    it('reconciles an unfinished helper run as lost after a restart', async () => {
      const started = deferred();
      const finish = deferred();
      const run = jest.fn(async (): Promise<WorkerAgentHelperRunResult> => {
        started.resolve();
        await finish.promise;
        return succeeded();
      });
      const first = compose(kind, { run });
      const before = core(first, join(root, 'ledger.sqlite'));
      const running = before.runs.run(request());
      await started.promise;
      const [parent] = (
        await before.operations.list({
          kinds: [CORE_HELPER_RUN_KIND],
          limit: 10,
        })
      ).items;
      if (!parent) throw new Error('No parent');
      before.operations.close();
      const second = compose(kind, { run });
      const after = core(second, join(root, 'ledger.sqlite'));
      try {
        await after.operations.whenReconciled();
        expect(await after.operations.get(parent.operationId)).toMatchObject({
          status: 'failed',
          error: { code: 'core.operation.interrupted' },
          restart: { class: 'lost', disposition: 'lost' },
        });
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        finish.resolve();
        await running.catch(() => undefined);
        after.operations.close();
        first.close();
        second.close();
      }
    });

    it('writes identical records over the direct and serialized bindings', async () => {
      const records: unknown[] = [];
      for (const binding of ['direct', 'bundled'] as const) {
        const composition = compose(binding, {
          run: () => Promise.resolve(succeeded()),
        });
        const h = core(composition, join(root, `${kind}-${binding}.sqlite`));
        try {
          const result = await h.runs.run(request());
          const delegations = await h.localWorker.listDelegations(
            result.operationId,
          );
          const ledger = await h.operations.ready();
          records.push(
            normalized({
              parent: await h.operations.get(result.operationId),
              delegations,
              children: delegations.map((entry) =>
                ledger.get(entry.childOperationId),
              ),
            }),
          );
        } finally {
          h.operations.close();
          composition.close();
        }
      }
      expect(records[0]).toEqual(records[1]);
    });
  },
);
