// CAN-5086: a pipeline start's host-local launch rides the CAN-5496
// `_execution` member, and only `worker.pipeline.execution.start` accepts it.
import {
  CANOPY_HOST_EXECUTION_MEMBER,
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_LAUNCH_SNAPSHOT_MAX_BYTES,
  WorkerPipelineHostLaunchSchema,
  WORKER_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
  type CanopyHostExecution,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionStartParams,
  type WorkerPipelineHostLaunch,
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
  grants: ['worker.git.read', 'worker.pipeline.write'],
};
const canary = 'secret-canary-launch-5086';
const pipelineLaunch: WorkerPipelineHostLaunch = {
  pipeline: { name: 'p', on: 'dispatch', jobs: { j: { steps: [] } } },
  cwd: '/work/tree',
  bundledActionsDir: '/app/resources/actions',
  repoPath: '/work/tree',
  env: { STEP_VALUE: 'from-launch' },
  secretEnv: { TOKEN: canary },
  inputs: { name: 'value' },
  nodeProcess: { command: '/app/node', env: { ELECTRON_RUN_AS_NODE: '1' } },
};
const execution: CanopyHostExecution = {
  childEnvironment: { PATH: '/usr/bin' },
  pipelineLaunch,
};
const params: WorkerPipelineExecutionStartParams = {
  executionId: 'run',
  pipelineId: 'pipeline',
  definitionSource: 'inline',
  runScope: 'worktree',
  workspaceId: 'workspace',
  worktreeId: 'worktree',
  owner: 'personal',
  initiationSource: 'user',
};
const projection: WorkerPipelineExecution = {
  executionId: 'run',
  pipelineId: 'pipeline',
  name: 'p',
  status: 'running',
  runScope: 'worktree',
  definitionSource: 'inline',
  owner: 'personal',
  workspaceId: 'workspace',
  worktreeId: 'worktree',
  parentExecutionId: null,
  startedAt: '2026-11-05T00:00:00.000Z',
  completedAt: null,
  pendingPauseCount: 0,
  error: null,
};
const definitions = {
  queries: {
    'worker.git.branch.list':
      WORKER_QUERY_DEFINITIONS['worker.git.branch.list'],
  },
  instructions: {
    'worker.pipeline.execution.start':
      WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
        'worker.pipeline.execution.start'
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
        'worker.pipeline.execution.start': (startParams, context) => {
          seen.push({ params: startParams, context });
          return { execution: projection };
        },
      },
      streams: {},
    },
  });
}

describe('host-local pipeline launches', () => {
  it('only worker.pipeline.execution.start accepts a pipeline launch', async () => {
    const seen: Array<{ params: unknown; context: CanopyHandlerContext }> = [];
    const dispatcher = dispatcherWith(seen);
    await expect(
      dispatcher.query(
        'worker.git.branch.list',
        {
          scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
          repository: { kind: 'checkout' },
        },
        { caller, execution },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });

    await dispatcher.instruction('worker.pipeline.execution.start', params, {
      caller,
      metadata: { idempotencyKey: 'run' },
      execution,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].context.execution?.pipelineLaunch).toEqual(pipelineLaunch);
    expect(seen[0].params).not.toHaveProperty(CANOPY_HOST_EXECUTION_MEMBER);
    await dispatcher.shutdown();
  });

  it('a pipeline launch crosses the bundled worker binding and stays out of params', async () => {
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
      await binding.instruction('worker.pipeline.execution.start', params, {
        metadata: { idempotencyKey: 'run' },
        execution,
      });
      expect(seen).toHaveLength(1);
      expect(seen[0].context.execution?.pipelineLaunch).toEqual(pipelineLaunch);
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
      expect(
        JSON.stringify(
          framed.map((message) =>
            'result' in message ? message.result : null,
          ),
        ),
      ).not.toContain(canary);
    } finally {
      binding.close();
      await dispatcher.shutdown();
    }
  });

  // Coordinator ruling: the snapshot is bounded as a whole, not per value.
  it('admits a pipeline snapshot up to 2 MiB and refuses a larger one', () => {
    const withRun = (length: number): WorkerPipelineHostLaunch => ({
      ...pipelineLaunch,
      pipeline: {
        name: 'p',
        on: 'dispatch',
        jobs: { j: { steps: [{ run: 'x'.repeat(length) }] } },
      },
    });
    expect(
      WorkerPipelineHostLaunchSchema.safeParse(withRun(100_000)).success,
    ).toBe(true);
    expect(
      WorkerPipelineHostLaunchSchema.safeParse(
        withRun(WORKER_PIPELINE_LAUNCH_SNAPSHOT_MAX_BYTES),
      ).success,
    ).toBe(false);
  });

  it('admits Windows drive paths and refuses UNC, device and relative ones (CAN-5091)', () => {
    const at = (cwd: string): boolean =>
      WorkerPipelineHostLaunchSchema.safeParse({ ...pipelineLaunch, cwd })
        .success;
    expect(at('C:\\Users\\me\\worktree')).toBe(true);
    expect(at('d:/work/tree')).toBe(true);
    expect(at('\\\\server\\share\\tree')).toBe(false);
    expect(at('\\\\?\\C:\\tree')).toBe(false);
    expect(at('//server/share/tree')).toBe(false);
    expect(at('//?/C:/tree')).toBe(false);
    expect(at('/\\server\\share')).toBe(false);
    expect(at('work\\tree')).toBe(false);
    expect(at('C:tree')).toBe(false);
  });
});
