// CAN-5771: a host step's owner returns host-local values in the
// `_execution.pipelineHostStep` member of worker.pipeline.hostRequest.respond,
// and one table admits each `_execution` member on exactly one operation.
import {
  CANOPY_HOST_EXECUTION_MEMBER,
  CANOPY_HOST_EXECUTION_MEMBER_OPERATIONS,
  CANOPY_PIPELINE_LAUNCH_OPERATION,
  CANOPY_PIPELINE_OWNER_VALUES_OPERATION,
  PIPELINE_HOST_STEP_PATH_OUTPUTS,
  WORKER_GIT_QUERY_DEFINITIONS,
  WORKER_PIPELINE_HOST_PATH_OUTPUTS,
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
  type CanopyHostExecution,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionStartParams,
  type WorkerPipelineHostStepValues,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../dispatcher';
import { createInProcessWorkerBinding } from '../in-process-worker-binding';
import type { CanopyDispatcher, CanopyHandlerContext } from '../types';
import { serializingWorkerPair } from './serializing-worker-pair';

const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'test-core',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: ['worker.pipeline.host', 'worker.pipeline.write', 'worker.git.read'],
};
const canary = '/tmp/host-step-canary-5771';
const pipelineHostStep: WorkerPipelineHostStepValues = {
  pathOutputs: { path: canary },
  timeout: 'none',
};
const launch = {
  pipeline: { name: 'p', on: 'dispatch', jobs: { j: { steps: [] } } },
  cwd: '/work/tree',
  bundledActionsDir: '/app/resources/actions',
  env: {},
  secretEnv: {},
};
const ownerValues = { requestId: 'request-1' };
const startParams: WorkerPipelineExecutionStartParams = {
  executionId: 'execution-1',
  pipelineId: 'pipeline',
  definitionSource: 'inline',
  runScope: 'global',
  workspaceId: null,
  worktreeId: null,
  owner: 'personal',
  initiationSource: 'user',
};
const respondParams = {
  executionId: 'execution-1',
  requestId: 'request-1',
  result: { status: 'success' as const, outputs: { branch: 'b' } },
};
const projection: WorkerPipelineExecution = {
  executionId: 'execution-1',
  pipelineId: 'pipeline',
  name: 'p',
  status: 'running',
  runScope: 'global',
  definitionSource: 'inline',
  owner: 'personal',
  workspaceId: null,
  worktreeId: null,
  parentExecutionId: null,
  startedAt: '2026-11-06T00:00:00.000Z',
  completedAt: null,
  pendingPauseCount: 0,
  error: null,
};

const definitions = {
  queries: {
    'worker.git.branch.list':
      WORKER_GIT_QUERY_DEFINITIONS['worker.git.branch.list'],
  },
  instructions: {
    'worker.pipeline.execution.start':
      WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
        'worker.pipeline.execution.start'
      ],
    'worker.pipeline.hostRequest.respond':
      WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
        'worker.pipeline.hostRequest.respond'
      ],
  },
  streams: {},
};

function dispatcherWith(
  seen: Array<{ params: unknown; context: CanopyHandlerContext }>,
): CanopyDispatcher<
  typeof definitions.queries,
  typeof definitions.instructions,
  typeof definitions.streams
> {
  return createCanopyDispatcher({
    profile: 'worker',
    definitions,
    handlers: {
      queries: {
        'worker.git.branch.list': () => ({
          branches: [],
          defaultBranch: null,
          defaultBranchSource: null,
        }),
      },
      instructions: {
        'worker.pipeline.execution.start': (params, context) => {
          seen.push({ params, context });
          return { execution: projection };
        },
        'worker.pipeline.hostRequest.respond': (params, context) => {
          seen.push({ params, context });
          return {
            executionId: params.executionId,
            requestId: params.requestId,
            outcome: 'applied' as const,
            settledAt: new Date().toISOString(),
          };
        },
      },
      streams: {},
    },
  });
}

describe('host-local host step values (CAN-5771)', () => {
  it('only respond accepts pipelineHostStep, and only start accepts pipelineLaunch', async () => {
    const seen: Array<{ params: unknown; context: CanopyHandlerContext }> = [];
    const dispatcher = dispatcherWith(seen);
    const hostStep: CanopyHostExecution = {
      childEnvironment: {},
      pipelineHostStep,
    };
    await expect(
      dispatcher.instruction('worker.pipeline.execution.start', startParams, {
        caller,
        metadata: { idempotencyKey: 'start-1' },
        execution: hostStep,
      }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'invalid_argument',
        message: 'This operation does not accept host step values.',
      },
    });
    await expect(
      dispatcher.query(
        'worker.git.branch.list',
        {
          scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
          repository: { kind: 'checkout' },
        },
        { caller, execution: hostStep },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    await expect(
      dispatcher.instruction(
        'worker.pipeline.hostRequest.respond',
        respondParams,
        {
          caller,
          metadata: {},
          execution: { childEnvironment: {}, pipelineLaunch: launch },
        },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'invalid_argument',
        message: 'This operation does not accept a pipeline launch.',
      },
    });
    await dispatcher.instruction(
      'worker.pipeline.hostRequest.respond',
      respondParams,
      { caller, metadata: {}, execution: hostStep },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].context.execution?.pipelineHostStep).toEqual(
      pipelineHostStep,
    );
    await dispatcher.shutdown();
  });

  it('refuses each member on every operation but its own, with its own text', async () => {
    const seen: Array<{ params: unknown; context: CanopyHandlerContext }> = [];
    const dispatcher = dispatcherWith(seen);
    const members = {
      pipelineLaunch: launch,
      pipelineOwnerValues: ownerValues,
      pipelineHostStep,
    };
    expect(Object.keys(CANOPY_HOST_EXECUTION_MEMBER_OPERATIONS).sort()).toEqual(
      Object.keys(members).sort(),
    );
    expect(
      CANOPY_HOST_EXECUTION_MEMBER_OPERATIONS.pipelineLaunch.operation,
    ).toBe(CANOPY_PIPELINE_LAUNCH_OPERATION);
    expect(
      CANOPY_HOST_EXECUTION_MEMBER_OPERATIONS.pipelineOwnerValues.operation,
    ).toBe(CANOPY_PIPELINE_OWNER_VALUES_OPERATION);
    const call = (
      operation:
        | 'worker.pipeline.execution.start'
        | 'worker.pipeline.hostRequest.respond',
      execution: CanopyHostExecution,
    ): Promise<unknown> =>
      operation === 'worker.pipeline.execution.start'
        ? dispatcher.instruction(operation, startParams, {
            caller,
            metadata: { idempotencyKey: `start-${seen.length}` },
            execution,
          })
        : dispatcher.instruction(operation, respondParams, {
            caller,
            metadata: {},
            execution,
          });
    for (const [member, value] of Object.entries(members)) {
      const rule = Object.entries(CANOPY_HOST_EXECUTION_MEMBER_OPERATIONS).find(
        ([name]) => name === member,
      )?.[1];
      expect(rule).toBeDefined();
      const execution = Object.fromEntries([
        ['childEnvironment', {}],
        [member, value],
      ]) as CanopyHostExecution;
      for (const operation of [
        'worker.pipeline.execution.start',
        'worker.pipeline.hostRequest.respond',
      ] as const) {
        const before = seen.length;
        if (operation === rule?.operation) {
          await call(operation, execution);
          expect(seen.length).toBe(before + 1);
          expect(
            seen[before].context.execution?.[member as keyof typeof members],
          ).toEqual(value);
        } else {
          await expect(call(operation, execution)).rejects.toMatchObject({
            payload: { kind: 'invalid_argument', message: rule?.refusal },
          });
          expect(seen.length).toBe(before);
        }
      }
    }
    await expect(
      call('worker.pipeline.hostRequest.respond', {
        childEnvironment: {},
        unknownMember: {},
      } as unknown as CanopyHostExecution),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    await dispatcher.shutdown();
  });

  it('pipelineHostStep crosses the bundled worker binding and stays out of params', async () => {
    const seen: Array<{ params: unknown; context: CanopyHandlerContext }> = [];
    const dispatcher = dispatcherWith(seen);
    const pair = serializingWorkerPair();
    const binding = createInProcessWorkerBinding({
      dispatcher,
      definitions,
      caller,
      pair,
    });
    try {
      await binding.instruction(
        'worker.pipeline.hostRequest.respond',
        respondParams,
        {
          metadata: {},
          execution: { childEnvironment: {}, pipelineHostStep },
        },
      );
      expect(seen).toHaveLength(1);
      expect(seen[0].context.execution?.pipelineHostStep).toEqual(
        pipelineHostStep,
      );
      expect(JSON.stringify(seen[0].params)).not.toContain(canary);
      const framed = [
        ...pair.client.send.mock.calls,
        ...pair.server.send.mock.calls,
      ].map(([message]) => message);
      expect(framed.length).toBeGreaterThan(0);
      for (const message of framed) {
        if (!('params' in message) || message.params === undefined) continue;
        const {
          _meta: _ignoredMeta,
          [CANOPY_HOST_EXECUTION_MEMBER]: _ignoredExecution,
          ...operationParams
        } = message.params;
        void _ignoredMeta;
        void _ignoredExecution;
        expect(JSON.stringify(operationParams)).not.toContain(canary);
      }
    } finally {
      binding.close();
      await dispatcher.shutdown();
    }
  });

  it('pipelineHostStep keeps the empty no-file sentinel and refuses a relative path', async () => {
    const seen: Array<{ params: unknown; context: CanopyHandlerContext }> = [];
    const dispatcher = dispatcherWith(seen);
    const sentinels: WorkerPipelineHostStepValues = {
      pathOutputs: {
        setup_log_file: '',
        setup_results_file: '',
        reply_file: '',
      },
      timeout: 'none',
    };
    await dispatcher.instruction(
      'worker.pipeline.hostRequest.respond',
      respondParams,
      {
        caller,
        metadata: {},
        execution: { childEnvironment: {}, pipelineHostStep: sentinels },
      },
    );
    expect(seen[0]?.context.execution?.pipelineHostStep).toEqual(sentinels);
    await expect(
      dispatcher.instruction(
        'worker.pipeline.hostRequest.respond',
        respondParams,
        {
          caller,
          metadata: {},
          execution: {
            childEnvironment: {},
            pipelineHostStep: {
              pathOutputs: { path: 'relative/tree' },
              timeout: 'none',
            },
          },
        },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    await dispatcher.shutdown();
  });

  it('the host-step path outputs match the protocol', () => {
    expect([...PIPELINE_HOST_STEP_PATH_OUTPUTS]).toEqual([
      ...WORKER_PIPELINE_HOST_PATH_OUTPUTS,
    ]);
  });
});
