import { createPipelineObservabilityFeed } from '../pipeline-feed';

describe('createPipelineObservabilityFeed', () => {
  it('syncs each execution event state and forwards step output', () => {
    const calls: string[] = [];
    const feed = createPipelineObservabilityFeed<{ id: string }>({
      syncPipelineExecutionState: (state) => calls.push(`sync:${state.id}`),
      observePipelineOutput: (event) =>
        calls.push(`output:${event.stepId}:${event.data}`),
    });

    feed.onExecutionEvent({ state: { id: 'exec-1' } });
    feed.onStepOutput({
      executionId: 'exec-1',
      jobId: 'job',
      stepId: 'step',
      attempt: 1,
      data: 'line\n',
    });
    feed.onExecutionEvent({ state: { id: 'exec-1' } });

    expect(calls).toEqual(['sync:exec-1', 'output:step:line\n', 'sync:exec-1']);
  });
});
