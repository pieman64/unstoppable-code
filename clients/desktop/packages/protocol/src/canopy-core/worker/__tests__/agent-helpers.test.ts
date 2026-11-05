import {
  WorkerAgentHelperRunParamsSchema,
  WorkerAgentHelperRunResultSchema,
} from '../agent-helpers';

const params = {
  helperRunId: 'run',
  kind: 'chat_summary',
  scope: {},
  model: 'model',
};

it('refuses helper run params that carry a host path or provider settings', () => {
  expect(WorkerAgentHelperRunParamsSchema.safeParse(params).success).toBe(true);
  for (const extra of [{ repoPath: '/tmp/x' }, { env: {} }, { prompt: 'x' }]) {
    expect(
      WorkerAgentHelperRunParamsSchema.safeParse({ ...params, ...extra })
        .success,
    ).toBe(false);
  }
});

it('keeps usage on every helper run result status', () => {
  for (const result of [
    {
      helperRunId: 'run',
      kind: 'chat_summary',
      status: 'succeeded',
      result: { present: false, sha256: null, bytes: null },
    },
    {
      helperRunId: 'run',
      kind: 'chat_summary',
      status: 'failed',
      error: {
        code: 'worker.agent.helperFailed',
        message: 'The helper model call failed.',
      },
    },
    { helperRunId: 'run', kind: 'chat_summary', status: 'cancelled' },
  ]) {
    expect(WorkerAgentHelperRunResultSchema.safeParse(result).success).toBe(
      false,
    );
    expect(
      WorkerAgentHelperRunResultSchema.safeParse({ ...result, usage: {} })
        .success,
    ).toBe(true);
  }
});
