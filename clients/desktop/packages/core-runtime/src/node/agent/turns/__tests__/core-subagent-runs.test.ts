import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKER_AGENT_RUN_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
  type WorkerAgentTurnRunResult,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../../runtime/dispatcher';
import { createDirectLocalWorkerTransport } from '../../../../runtime/local-worker-transport';
import { createWorkerExecutorReceipts } from '../../../../runtime/worker-executor-receipts';
import {
  LocalWorkerExecution,
  OperationLedgerRefusedError,
  OperationService,
} from '../../../operations';
import { OperationLedger } from '../../../operations/ledger';
import {
  CoreChatTurnRuns,
  CoreSubagentRuns,
  createWorkerAgentRunHandlers,
  type CoreSubagentBeginRequest,
} from '..';

const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'test-core',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: ['worker.agent.execute'],
};
const instructions = WORKER_AGENT_RUN_INSTRUCTION_DEFINITIONS;
const scope = { workspaceId: 'ws', worktreeId: 'wt', chatId: 'chat' };

function compose(
  ledgerPath: string,
  onError: (error: unknown, context: string) => void = () => undefined,
): {
  operations: OperationService;
  turns: CoreChatTurnRuns;
  subagents: CoreSubagentRuns;
  finishTurn(result: WorkerAgentTurnRunResult): void;
  close(): void;
} {
  const runsRef: { current: CoreChatTurnRuns | null } = { current: null };
  let finishTurn: (result: WorkerAgentTurnRunResult) => void = () => undefined;
  const receipts = createWorkerExecutorReceipts(instructions);
  const handlers = createWorkerAgentRunHandlers({
    turns: {
      run: () =>
        new Promise((resolve) => {
          finishTurn = resolve;
        }),
    },
    subagents: {
      run: (params) =>
        Promise.resolve({
          subagentRunId: params.subagentRunId,
          status: 'completed',
        }),
    },
    sinkFor: (id) => runsRef.current?.sinkFor(id) ?? null,
  });
  const dispatcher = createCanopyDispatcher({
    profile: 'core+worker',
    definitions: { queries: {}, instructions, streams: {} },
    handlers: {
      queries: {},
      instructions: receipts.wrap(handlers.instructions),
      streams: {},
    },
  });
  const operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  const localWorker = new LocalWorkerExecution({
    operations,
    transport: createDirectLocalWorkerTransport({
      dispatcher,
      instructions,
      caller,
      receipts,
    }),
  });
  const turns = new CoreChatTurnRuns({ operations, localWorker });
  runsRef.current = turns;
  return {
    operations,
    turns,
    subagents: new CoreSubagentRuns({ operations, localWorker, onError }),
    finishTurn: (result) => finishTurn(result),
    close: (): void => {
      operations.close();
      void dispatcher.shutdown();
    },
  };
}
function subagent(parentOperationId: string | null): CoreSubagentBeginRequest {
  return {
    params: {
      subagentRunId: 'sub',
      delegationId: 'delegation',
      runGeneration: 1,
      harnessId: 'local-delegation-claude-v1',
      scope,
    },
    origin: { kind: 'system', sourceId: 'subagent:local-delegation-claude-v1' },
    owner: { kind: 'system', id: 'test' },
    parentOperationId,
  };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'subagent-runs-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

it('a subagent run is a child of its parent turn run', async () => {
  const h = compose(join(root, 'ledger.sqlite'));
  try {
    const turn = await h.turns.begin({
      params: {
        turnRunId: 'run',
        scope,
        turnId: 'message',
        eventNamespace: 'initial',
        providerId: 'claude',
        model: null,
        materializationId: null,
      },
      origin: { kind: 'client', sourceId: 'test' },
      owner: { kind: 'system', id: 'test' },
      transcript: () => Promise.resolve(),
    });
    const parent = h.turns.findLive(scope, 'message');
    expect(parent).toEqual(turn.ref);
    const run = await h.subagents.begin(subagent(parent?.operationId ?? null));
    expect(h.subagents.findLive('delegation', 1)).toEqual(run.ref);
    expect(await h.operations.get(run.ref.operationId)).toMatchObject({
      parentOperationId: turn.ref.operationId,
    });
    expect(await run.settled).toMatchObject({ status: 'completed' });
    expect(h.subagents.findLive('delegation', 1)).toBeNull();
    h.finishTurn({ turnRunId: 'run', eventCount: 0, status: 'completed' });
    await turn.settled;
  } finally {
    h.close();
  }
});

it('a finished lineage parent does not refuse the subagent run', async () => {
  const onError = jest.fn();
  const h = compose(join(root, 'ledger.sqlite'), onError);
  try {
    const { operation: parent } = await h.operations.admit({
      kind: 'core.chat.turn.run',
      status: 'running',
      origin: { kind: 'client', sourceId: 'test' },
      owner: { kind: 'system', id: 'test' },
      scope,
    });
    await h.operations.finish(parent.operationId, { status: 'completed' });
    const run = await h.subagents.begin(subagent(parent.operationId));
    const record = await h.operations.get(run.ref.operationId);
    expect(record?.parentOperationId ?? null).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.anything(),
      'subagent lineage parent finished',
    );
    expect(await run.settled).toMatchObject({ status: 'completed' });
  } finally {
    h.close();
  }
});

it('a stopping lineage parent keeps the subagent run inside its cancellation', async () => {
  const onError = jest.fn();
  const h = compose(join(root, 'ledger.sqlite'), onError);
  try {
    const { operation: parent } = await h.operations.admit({
      kind: 'core.chat.turn.run',
      status: 'running',
      origin: { kind: 'client', sourceId: 'test' },
      owner: { kind: 'system', id: 'test' },
      scope,
    });
    await h.operations.cancel(parent.operationId, {
      reason: 'Stop',
      requestedBy: 'test',
    });
    await expect(
      h.subagents.begin(subagent(parent.operationId)),
    ).rejects.toBeInstanceOf(OperationLedgerRefusedError);
    expect(onError).not.toHaveBeenCalled();
    expect(
      (
        await h.operations.list({
          kinds: ['core.agent.subagent.run'],
          limit: 10,
        })
      ).items,
    ).toHaveLength(0);
    expect(h.subagents.findLive('delegation', 1)).toBeNull();
  } finally {
    h.close();
  }
});
