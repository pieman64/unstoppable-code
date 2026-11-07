// CAN-5095: only worker.pipeline.hostRequest.respond accepts pipeline owner
// values in its host-local _execution member.
import {
  WORKER_GIT_QUERY_DEFINITIONS,
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
  type CanopyHostExecution,
} from '@canopy/protocol/canopy-core';

import { createCanopyDispatcher } from '../dispatcher';
import type { CanopyDispatcher } from '../types';

const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'test-core',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: ['worker.pipeline.host', 'worker.pipeline.write', 'worker.git.read'],
};

const execution: CanopyHostExecution = {
  childEnvironment: {},
  pipelineOwnerValues: {
    requestId: 'owner-1',
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/codex-gateway/route' },
    codexConfig: { model_provider: 'canopy' },
  },
};

const queries = {
  'worker.git.branch.list':
    WORKER_GIT_QUERY_DEFINITIONS['worker.git.branch.list'],
};
const instructions = {
  'worker.pipeline.execution.start':
    WORKER_PIPELINE_INSTRUCTION_DEFINITIONS['worker.pipeline.execution.start'],
  'worker.pipeline.hostRequest.respond':
    WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
      'worker.pipeline.hostRequest.respond'
    ],
};

function compose(
  seen: (context: CanopyHostExecution | undefined) => void,
): CanopyDispatcher<typeof queries, typeof instructions, Record<never, never>> {
  const never = (): never => {
    throw new Error('The handler must not run.');
  };
  return createCanopyDispatcher({
    profile: 'core+worker',
    definitions: { queries, instructions, streams: {} },
    handlers: {
      queries: { 'worker.git.branch.list': never },
      instructions: {
        'worker.pipeline.execution.start': never,
        'worker.pipeline.hostRequest.respond': (
          { executionId, requestId },
          context,
        ) => {
          seen(context.execution);
          return Promise.resolve({
            executionId,
            requestId,
            outcome: 'applied' as const,
            settledAt: new Date().toISOString(),
          });
        },
      },
      streams: {},
    },
  });
}

describe('host execution pipeline owner values', () => {
  it('only worker.pipeline.hostRequest.respond accepts pipeline owner values', async () => {
    let received: CanopyHostExecution | undefined;
    const dispatcher = compose((value) => {
      received = value;
    });
    await expect(
      dispatcher.instruction(
        'worker.pipeline.execution.start',
        {
          executionId: 'execution-1',
          pipelineId: 'pipeline',
          definitionSource: 'inline',
          runScope: 'global',
          workspaceId: null,
          worktreeId: null,
          owner: 'personal',
          initiationSource: 'user',
        },
        {
          caller,
          metadata: { idempotencyKey: 'start-1' },
          execution,
        },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    await expect(
      dispatcher.query(
        'worker.git.branch.list',
        {
          scope: { workspaceId: 'workspace-1', worktreeId: 'worktree-1' },
          repository: { kind: 'checkout' },
        },
        { caller, execution },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });

    await expect(
      dispatcher.instruction(
        'worker.pipeline.hostRequest.respond',
        {
          executionId: 'execution-1',
          requestId: 'owner-1',
          result: { status: 'owner', value: { kind: 'model.release' } },
        },
        { caller, metadata: {}, execution },
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
    expect(received?.pipelineOwnerValues).toEqual(
      execution.pipelineOwnerValues,
    );
    await dispatcher.shutdown();
  });
});
