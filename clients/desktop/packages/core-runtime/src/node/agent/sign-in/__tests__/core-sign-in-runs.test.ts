import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKER_AGENT_SIGN_IN_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
  type WorkerAgentSignInRunParams,
  type WorkerAgentSignInRunResult,
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
  CORE_SIGN_IN_RUN_KIND,
  CoreSignInRuns,
  createWorkerAgentSignInHandlers,
  signInLaunchUnavailableError,
  type CoreSignInRunRequest,
  type SignInExecutionWorker,
} from '..';

const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'test-core',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: ['worker.agent.auth'],
};
const instructions = WORKER_AGENT_SIGN_IN_INSTRUCTION_DEFINITIONS;
const definitions = { queries: {}, instructions, streams: {} };
interface Composition {
  transport: LocalWorkerTransport;
  close(): void;
}
function compose(
  kind: 'direct' | 'bundled',
  worker: SignInExecutionWorker,
): Composition {
  const receipts = createWorkerExecutorReceipts(instructions);
  const handlers = createWorkerAgentSignInHandlers(worker);
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
  runs: CoreSignInRuns;
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
    runs: new CoreSignInRuns({ operations, localWorker }),
  };
}
function request(
  params: Partial<WorkerAgentSignInRunParams> = {},
): CoreSignInRunRequest {
  return {
    params: {
      signInRunId: 'run',
      provider: 'claude',
      method: 'terminal',
      ...params,
    },
    origin: { kind: 'client', sourceId: 'test' },
    owner: { kind: 'system', id: 'test' },
  };
}
function result(
  params: WorkerAgentSignInRunParams,
  status: 'succeeded' | 'cancelled',
): WorkerAgentSignInRunResult {
  return {
    signInRunId: params.signInRunId,
    provider: params.provider,
    credentialEffects: ['claude.darwin.keychain'],
    exitCode: status === 'succeeded' ? 0 : null,
    signal: null,
    status,
  };
}
function deferred(): { promise: Promise<void>; resolve(): void } {
  let done = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { promise, resolve: () => done() };
}
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sign-in-runs-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.each(['direct', 'bundled'] as const)(
  'sign-in runs over the %s local worker',
  (kind) => {
    it('records a parent and child for a succeeded sign-in', async () => {
      const composition = compose(kind, {
        run: (params) => Promise.resolve(result(params, 'succeeded')),
      });
      const h = core(composition, join(root, 'ledger.sqlite'));
      try {
        const outcome = await h.runs.run(request());
        expect(outcome.status).toBe('succeeded');
        expect(await h.operations.get(outcome.operationId)).toMatchObject({
          kind: CORE_SIGN_IN_RUN_KIND,
          status: 'completed',
          outcome: {
            status: 'succeeded',
            credentialEffects: ['claude.darwin.keychain'],
            exitCode: 0,
          },
        });
        const [delegation] = await h.localWorker.listDelegations(
          outcome.operationId,
        );
        if (!delegation) throw new Error('No dispatch');
        expect(
          await h.operations.get(delegation.childOperationId),
        ).toMatchObject({
          kind: 'worker.agent.signIn.run',
          status: 'completed',
          parentOperationId: outcome.operationId,
        });
      } finally {
        h.operations.close();
        composition.close();
      }
    });

    it('maps a failed worker result to the fixed failure payload', async () => {
      const composition = compose(kind, {
        run: (params) =>
          Promise.resolve({
            signInRunId: params.signInRunId,
            provider: params.provider,
            credentialEffects: [],
            exitCode: 1,
            signal: null,
            status: 'failed',
            error: {
              code: 'worker.agent.signInFailed',
              message: 'The provider sign-in did not finish.',
            },
          }),
      });
      const h = core(composition, join(root, 'ledger.sqlite'));
      try {
        const outcome = await h.runs.run(request());
        expect(outcome).toMatchObject({
          status: 'failed',
          result: { exitCode: 1 },
        });
        expect((await h.operations.get(outcome.operationId))?.error).toEqual({
          kind: 'internal',
          code: 'worker.agent.signInFailed',
          message: 'The provider sign-in did not finish.',
          retry: { kind: 'never' },
        });
      } finally {
        h.operations.close();
        composition.close();
      }
    });

    it('cancels the parent and aborts the worker when the caller aborts', async () => {
      const started = deferred();
      let observed = false;
      const composition = compose(kind, {
        run: async (params, signal) => {
          started.resolve();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else
              signal.addEventListener('abort', () => resolve(), { once: true });
          });
          observed = signal.aborted;
          return result(params, 'cancelled');
        },
      });
      const h = core(composition, join(root, 'ledger.sqlite'));
      try {
        const controller = new AbortController();
        const running = h.runs.run(request(), {
          signal: controller.signal,
          cancelledBy: 'test-user',
        });
        await started.promise;
        controller.abort();
        const outcome = await running;
        expect(outcome.status).toBe('cancelled');
        expect(observed).toBe(true);
        expect(await h.operations.get(outcome.operationId)).toMatchObject({
          status: 'cancelled',
        });
        const [delegation] = await h.localWorker.listDelegations(
          outcome.operationId,
        );
        if (!delegation) throw new Error('No dispatch');
        expect(
          await h.operations.get(delegation.childOperationId),
        ).toMatchObject({
          status: 'cancelled',
          outcome: { status: 'cancelled', provider: 'claude' },
        });
      } finally {
        h.operations.close();
        composition.close();
      }
    });

    it('replays a repeated key and refuses changed params', async () => {
      const run = jest.fn((params: WorkerAgentSignInRunParams) =>
        Promise.resolve(result(params, 'succeeded')),
      );
      const composition = compose(kind, { run });
      const dispatch = (params: WorkerAgentSignInRunParams): Promise<unknown> =>
        composition.transport.instruction('worker.agent.signIn.run', params, {
          metadata: { idempotencyKey: 'key' },
          signal: new AbortController().signal,
        });
      try {
        const { params } = request();
        const first = await dispatch(params);
        expect(await dispatch(params)).toEqual(first);
        expect(run).toHaveBeenCalledTimes(1);
        await expect(
          dispatch({ ...params, provider: 'github' }),
        ).rejects.toMatchObject({
          payload: {
            kind: 'conflict',
            code: 'worker.agent.idempotencyKeyReused',
          },
        });
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        composition.close();
      }
    });

    it('refuses a launch that was never staged', async () => {
      const composition = compose(kind, {
        run: () => Promise.reject(signInLaunchUnavailableError()),
      });
      const h = core(composition, join(root, 'ledger.sqlite'));
      try {
        const outcome = await h.runs.run(request());
        expect(outcome).toMatchObject({
          status: 'failed',
          error: { code: 'worker.agent.signInLaunchUnavailable' },
        });
        expect(await h.operations.get(outcome.operationId)).toMatchObject({
          status: 'failed',
          error: { code: 'worker.agent.signInLaunchUnavailable' },
        });
      } finally {
        h.operations.close();
        composition.close();
      }
    });

    it('records no terminal byte', async () => {
      const canary = 'sk-canary-TERMINAL-321';
      const relayed: string[] = [];
      const composition = compose(kind, {
        run: (params) => {
          relayed.push(canary);
          return Promise.resolve(result(params, 'succeeded'));
        },
      });
      const inner = composition.transport;
      const receipts: Promise<unknown>[] = [];
      const transport: LocalWorkerTransport = {
        instructions: inner.instructions,
        instruction: (name, params, options) =>
          inner.instruction(name, params, options),
        receipt: (operation, key) => inner.receipt(operation, key),
        releaseReceipt: (operation, key) => {
          receipts.push(
            inner
              .receipt(operation, key)
              .finally(() => inner.releaseReceipt(operation, key)),
          );
        },
      };
      const h = core(
        { ...composition, transport },
        join(root, 'ledger.sqlite'),
      );
      try {
        const outcome = await h.runs.run(request());
        expect(relayed).toEqual([canary]);
        const delegations = await h.localWorker.listDelegations(
          outcome.operationId,
        );
        const settled = await Promise.all(receipts);
        expect(settled).toHaveLength(1);
        expect(settled[0]).not.toBeNull();
        const records = JSON.stringify({
          operations: await h.operations.list({ limit: 20 }),
          delegations,
          receipts: settled,
          outcome,
        });
        expect(records).not.toContain(canary);
      } finally {
        h.operations.close();
        composition.close();
      }
      for (const file of readdirSync(root)) {
        expect(readFileSync(join(root, file)).includes(canary)).toBe(false);
      }
    });
  },
);
