import type {
  WorkerAgentHelperRunParams,
  WorkerAgentHelperRunResult,
} from '@canopy/protocol/canopy-core';
import type { CanopyHandlerContext } from '../../../../runtime/types';
import {
  createWorkerAgentHelperHandlers,
  helperLaunchUnavailableError,
} from '..';

const params: WorkerAgentHelperRunParams = {
  helperRunId: 'run',
  kind: 'chat_summary',
  scope: {},
  model: 'model',
};
const context: CanopyHandlerContext = {
  requestId: 'request',
  caller: {
    principalId: 'core',
    clientInstanceId: 'test',
    authorityId: 'authority',
    interfaceKind: 'daemon',
    grants: ['worker.agent.execute'],
  },
  metadata: { idempotencyKey: 'key' },
  signal: new AbortController().signal,
};

it('joins a repeat with the same key and refuses the key with other params', async () => {
  const run = jest.fn(
    (): Promise<WorkerAgentHelperRunResult> =>
      Promise.resolve({
        helperRunId: 'run',
        kind: 'chat_summary',
        status: 'cancelled',
        usage: {},
      }),
  );
  const handler = createWorkerAgentHelperHandlers({ run }).instructions[
    'worker.agent.helper.run'
  ];
  await Promise.all([handler(params, context), handler(params, context)]);
  expect(run).toHaveBeenCalledTimes(1);
  await expect(
    handler({ ...params, model: 'other' }, context),
  ).rejects.toMatchObject({
    payload: { code: 'worker.agent.idempotencyKeyReused' },
  });
});

it('fails a run whose launch is not staged', async () => {
  const handler = createWorkerAgentHelperHandlers({
    run: () => Promise.reject(helperLaunchUnavailableError()),
  }).instructions['worker.agent.helper.run'];
  await expect(handler(params, context)).rejects.toMatchObject({
    payload: {
      kind: 'failed_precondition',
      code: 'worker.agent.helperLaunchUnavailable',
    },
  });
});
