import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationRecord } from '@canopy/protocol/canopy-core';
import type {
  AgentRunRequest,
  AgentRunnerAdapter,
  DelegationStopReceipt,
} from '@canopy/desktop-shared/node/delegation';
import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from '../../canopy-runtime/core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { request as cursorRequest } from '../../__tests__/helpers/delegation-runner-fixtures/cursor';
import { currentAgentWorkerContext } from '../agent-worker-context';
import { withSubagentWorkerRuns } from '../subagent-worker-runs';
import { beginChatTurnRun } from '../turn-runs';

jest.mock('../../canopy-runtime/chat-turn-stop', () => ({
  stopChatTurnExactly: jest.fn(() => Promise.resolve(null)),
}));

let root: string;
let operations: CoreOperationAdapter;
let runtime: DesktopCanopyDispatcher;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desktop-subagent-runs-'));
  operations = createCoreOperationAdapter({
    ledgerPath: () => join(root, 'ledger.sqlite'),
  });
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    shutdownTimeoutMs: 25,
  });
});
afterEach(async () => {
  await runtime.shutdown();
  rmSync(root, { recursive: true, force: true });
});

function runRequest(
  overrides: {
    delegationId?: string;
    parent?: Partial<AgentRunRequest['parent']>;
  } = {},
): AgentRunRequest {
  const base = cursorRequest({
    cwd: root,
    signal: new AbortController().signal,
  });
  return {
    ...base,
    delegationId: overrides.delegationId ?? base.delegationId,
    parent: { ...base.parent, userMessageId: 'message', ...overrides.parent },
  };
}
function fakeRunner(
  overrides: Partial<AgentRunnerAdapter> = {},
): AgentRunnerAdapter & { contexts: unknown[] } {
  const contexts: unknown[] = [];
  return {
    contexts,
    harnessId: 'cursor',
    runtimeKind: 'cursor-acp',
    adapterVersion: '1',
    canRun: () => Promise.resolve({ available: true }),
    start: (request) => {
      contexts.push(currentAgentWorkerContext());
      return Promise.resolve({ runId: `native-${request.delegationId}` });
    },
    stop: () => Promise.resolve({ stopped: true }),
    close: () => Promise.resolve(),
    ...overrides,
  };
}
async function subagentRuns(): Promise<OperationRecord[]> {
  return (
    await operations.service.list({
      kinds: ['core.agent.subagent.run'],
      limit: 20,
    })
  ).items;
}
async function settledSubagentRuns(count: number): Promise<OperationRecord[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const runs = await subagentRuns();
    if (
      runs.length >= count &&
      runs.every((run) => run.status !== 'running' && run.status !== 'queued')
    )
      return runs;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return subagentRuns();
}

it('a subagent run is a child of its parent turn run', async () => {
  const turn = await beginChatTurnRun({
    scope: { workspaceId: 'project', worktreeId: 'worktree', chatId: 'chat' },
    turnId: 'message',
    eventNamespace: 'initial',
    providerId: 'claude',
    model: null,
    initiationSource: 'user',
  });
  const turnRecord = await turn.execute(async () =>
    (
      await operations.service.list({
        kinds: ['core.chat.turn.run'],
        limit: 5,
      })
    ).items.at(0),
  );
  const runner = fakeRunner();
  const wrapped = withSubagentWorkerRuns(runner);
  const native = await wrapped.start(runRequest(), () => Promise.resolve());
  const [run] = await subagentRuns();
  expect(run).toMatchObject({
    status: 'running',
    parentOperationId: turnRecord?.operationId,
  });
  expect(runner.contexts).toHaveLength(1);
  expect(runner.contexts[0]).toMatchObject({ kind: 'subagent' });
  await wrapped.close(native);
  expect(await settledSubagentRuns(1)).toMatchObject([{ status: 'completed' }]);
  turn.settle('completed');
});

it('a nested subagent run is a child of its parent subagent run', async () => {
  const wrapped = withSubagentWorkerRuns(fakeRunner());
  const parentNative = await wrapped.start(
    runRequest({ delegationId: 'parent' }),
    () => Promise.resolve(),
  );
  const [parentRun] = await subagentRuns();
  const childNative = await wrapped.start(
    runRequest({
      delegationId: 'child',
      parent: { parentDelegationId: 'parent', parentRunGeneration: 1 },
    }),
    () => Promise.resolve(),
  );
  const child = (await subagentRuns()).find(
    (run) => run.operationId !== parentRun?.operationId,
  );
  expect(child?.parentOperationId).toBe(parentRun?.operationId);
  await wrapped.close(childNative);
  await wrapped.close(parentNative);
  await settledSubagentRuns(2);
});

it('a refused start never records a subagent run', async () => {
  withSubagentWorkerRuns(fakeRunner());
  expect(await subagentRuns()).toHaveLength(0);
  const failure = new Error('runner refused');
  const wrapped = withSubagentWorkerRuns(
    fakeRunner({ start: () => Promise.reject(failure) }),
  );
  await expect(
    wrapped.start(runRequest(), () => Promise.resolve()),
  ).rejects.toBe(failure);
  expect(await settledSubagentRuns(1)).toMatchObject([{ status: 'failed' }]);
});

it("close settles the subagent run and keeps the adapter's cleanup result", async () => {
  const statuses = async (count: number): Promise<string[]> =>
    (await settledSubagentRuns(count)).map((run) => run.status).sort();
  const failure = new Error('cleanup failed');
  const failing = withSubagentWorkerRuns(
    fakeRunner({ close: () => Promise.reject(failure) }),
  );
  const first = await failing.start(runRequest({ delegationId: 'a' }), () =>
    Promise.resolve(),
  );
  await expect(failing.close(first)).rejects.toBe(failure);
  expect(await statuses(1)).toEqual(['failed']);
  const passing = withSubagentWorkerRuns(fakeRunner());
  const second = await passing.start(runRequest({ delegationId: 'b' }), () =>
    Promise.resolve(),
  );
  await passing.close(second);
  expect(await statuses(2)).toEqual(['completed', 'failed']);
  const third = await passing.start(runRequest({ delegationId: 'c' }), () =>
    Promise.resolve(),
  );
  expect(await passing.stop(third, 'user_cancelled')).toEqual({
    stopped: true,
  });
  await passing.close(third);
  expect(await statuses(3)).toEqual(['cancelled', 'completed', 'failed']);
});

it('a generation whose terminal event failed settles failed after a clean close', async () => {
  const forwarded: string[] = [];
  const wrapped = withSubagentWorkerRuns(
    fakeRunner({
      start: async (request, sink) => {
        for (const status of ['failed', 'deadline_exceeded'] as const)
          if (request.delegationId === status)
            await sink({
              delegationId: request.delegationId,
              runGeneration: request.runGeneration,
              sequence: 1,
              occurredAt: 0,
              event: { type: 'terminal', status },
            });
        return { runId: `native-${request.delegationId}` };
      },
    }),
  );
  for (const delegationId of ['failed', 'deadline_exceeded']) {
    const native = await wrapped.start(
      runRequest({ delegationId }),
      (event) => {
        forwarded.push(event.event.type);
        return Promise.resolve();
      },
    );
    await wrapped.close(native);
  }
  expect(forwarded).toEqual(['terminal', 'terminal']);
  expect(await settledSubagentRuns(2)).toMatchObject([
    { status: 'failed' },
    { status: 'failed' },
  ]);
});

it('cleanup during a pending stop settles the run by the stop receipt', async () => {
  const failure = new Error('stop failed');
  const outcomes: Array<DelegationStopReceipt | Error> = [
    { stopped: true },
    {
      stopped: false,
      error: {
        code: 'runtime_error',
        message: 'The run already ended.',
        retryable: false,
      },
    },
    failure,
  ];
  const wrapped = withSubagentWorkerRuns({
    ...fakeRunner(),
    // The run's terminal arrives while the stop is pending, so the broker's
    // cleanup closes it before the stop answers.
    stop: async (native) => {
      await wrapped.close(native);
      const outcome = outcomes.shift();
      if (outcome === undefined || outcome instanceof Error) throw failure;
      return outcome;
    },
  });
  for (const delegationId of ['stopped', 'not-stopped', 'stop-failed']) {
    const native = await wrapped.start(runRequest({ delegationId }), () =>
      Promise.resolve(),
    );
    await wrapped.stop(native, 'user_cancelled').catch(() => undefined);
  }
  const statuses = (await settledSubagentRuns(3))
    .map((run) => run.status)
    .sort();
  expect(statuses).toEqual(['cancelled', 'completed', 'completed']);
});
