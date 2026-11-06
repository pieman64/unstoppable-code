import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
  type DelegationRecord,
  type ExecutionSecretBinding,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionStartParams,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import {
  createInProcessWorkerBinding,
  localWorkerTransportOf,
} from '../../../runtime/in-process-worker-binding';
import {
  createDirectLocalWorkerTransport,
  type LocalWorkerTransport,
} from '../../../runtime/local-worker-transport';
import { createWorkerExecutorReceipts } from '../../../runtime/worker-executor-receipts';
import { serializingWorkerPair } from '../../../runtime/__tests__/serializing-worker-pair';
import { LocalWorkerExecution, OperationService } from '../../operations';
import { OperationLedger } from '../../operations/ledger';
import {
  createWorkerPipelineHandlers,
  type PipelineExecutionWorker,
} from '../../pipeline/execution';
import {
  ExecutionSecretGrants,
  executionSecretFingerprints,
  type RedeemedExecutionSecrets,
} from '..';

const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'test-core',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: ['worker.pipeline.write'],
};
const {
  'worker.pipeline.hostRequest.respond': _hostResponse,
  ...instructions
} = WORKER_PIPELINE_INSTRUCTION_DEFINITIONS;
void _hostResponse;
const definitions = { queries: {}, instructions, streams: {} };
interface Composition {
  transport: LocalWorkerTransport;
  close(): void;
}
function compose(
  kind: 'direct' | 'bundled',
  worker: PipelineExecutionWorker,
  secrets: ExecutionSecretGrants,
): Composition {
  const receipts = createWorkerExecutorReceipts(instructions);
  const handlers = createWorkerPipelineHandlers(worker, { secrets });
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
  };
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

const canaries = ['secret-canary-env-7f3a', 'secret-canary-pat-91c2'];
const bindings: ExecutionSecretBinding[] = [
  {
    name: 'KEY',
    source: {
      kind: 'stored-secret',
      family: 'environment',
      record: 'config',
      ref: `ssr1_${'a'.repeat(43)}`,
    },
  },
  {
    name: 'GH_TOKEN',
    source: { kind: 'integration-token', provider: 'github-pat' },
  },
];
const params: WorkerPipelineExecutionStartParams = {
  executionId: 'run',
  pipelineId: 'pipeline',
  definitionSource: 'inline',
  runScope: 'global',
  workspaceId: null,
  worktreeId: null,
  owner: 'personal',
  initiationSource: 'user',
  secrets: bindings,
};
const execution: WorkerPipelineExecution = {
  executionId: 'run',
  pipelineId: 'pipeline',
  name: 'Pipeline',
  status: 'success',
  runScope: 'global',
  definitionSource: 'inline',
  owner: 'personal',
  workspaceId: null,
  worktreeId: null,
  parentExecutionId: null,
  startedAt: '2026-11-05T00:00:00.000Z',
  completedAt: '2026-11-05T00:00:01.000Z',
  pendingPauseCount: 0,
  error: null,
};
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'execution-secret-handoff-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function launch(kind: 'direct' | 'bundled'): Promise<{
  delegation: DelegationRecord;
  received: RedeemedExecutionSecrets[];
  reads: number;
  replayed: boolean;
}> {
  const received: RedeemedExecutionSecrets[] = [];
  const read = jest.fn(() =>
    Promise.resolve(
      canaries.map((value) => ({ status: 'ok' as const, value })),
    ),
  );
  const secrets = new ExecutionSecretGrants({ reader: { read } });
  const worker: PipelineExecutionWorker = {
    start: (_params, _signal, redeemed) => {
      void _params;
      void _signal;
      received.push(redeemed);
      return Promise.resolve(execution);
    },
    control: () => Promise.resolve({ outcome: 'updated', execution }),
    sweep: () => Promise.resolve({ failureCount: 0 }),
    checkpoint: () => Promise.resolve({ checkpointedCount: 0 }),
    get: () => Promise.resolve(execution),
    cancel: () => Promise.resolve(execution),
    observe: () => null,
  };
  const composition = compose(kind, worker, secrets);
  const h = core(composition, join(root, `${kind}.sqlite`));
  try {
    const parent = await h.operations.admit({
      kind: 'core.pipeline.run',
      status: 'running',
      origin: { kind: 'client', sourceId: 'test' },
      owner: { kind: 'system', id: 'test' },
    });
    secrets.stage(
      { operation: 'worker.pipeline.execution.start', key: params.executionId },
      bindings,
    );
    const request = {
      parentOperationId: parent.operation.operationId,
      operation: 'worker.pipeline.execution.start',
      params,
      idempotencyKey: 'run',
      secrets: executionSecretFingerprints(bindings),
    };
    const result = await h.localWorker.dispatch(request);
    expect(result.operation.status).toBe('completed');
    const replay = await h.localWorker.dispatch(request);
    for (const file of readdirSync(root)) {
      const bytes = readFileSync(join(root, file));
      for (const canary of canaries)
        expect(bytes.includes(Buffer.from(canary))).toBe(false);
    }
    return {
      delegation: result.delegation,
      received,
      reads: read.mock.calls.length,
      replayed: replay.replayed,
    };
  } finally {
    h.operations.close();
    composition.close();
  }
}

it('a worker receives exactly the redeemed values for its own dispatch', async () => {
  for (const kind of ['direct', 'bundled'] as const) {
    const result = await launch(kind);
    expect(result.received).toEqual([
      { env: { KEY: canaries[0], GH_TOKEN: canaries[1] } },
    ]);
  }
});
it('records binding fingerprints identically over the direct and bundled bindings', async () => {
  const direct = await launch('direct');
  const bundled = await launch('bundled');
  expect(normalized(direct.delegation)).toEqual(normalized(bundled.delegation));
  expect(direct.delegation.secrets).toEqual(
    executionSecretFingerprints(bindings),
  );
});
it('no secret value reaches the ledger', async () => {
  for (const kind of ['direct', 'bundled'] as const) await launch(kind);
  for (const file of readdirSync(root)) {
    const bytes = readFileSync(join(root, file));
    for (const canary of canaries)
      expect(bytes.includes(Buffer.from(canary))).toBe(false);
  }
});
it('a keyed replay never redeems again', async () => {
  for (const kind of ['direct', 'bundled'] as const) {
    const result = await launch(kind);
    expect(result.reads).toBe(1);
    expect(result.replayed).toBe(true);
    expect(result.received).toHaveLength(1);
  }
});
