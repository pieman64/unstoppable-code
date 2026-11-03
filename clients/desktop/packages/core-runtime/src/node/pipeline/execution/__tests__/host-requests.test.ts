import {
  WORKER_PIPELINE_GRANTS,
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_STREAM_DEFINITIONS,
  type CanopyCallerDescriptor,
  type WorkerPipelineHostRequest,
} from '@canopy/protocol/canopy-core';

import { createCanopyDispatcher } from '../../../../runtime/dispatcher';
import type { CanopyDispatcher } from '../../../../runtime/types';
import {
  PipelineHostRequestBroker,
  PipelineHostUnavailableError,
  createWorkerPipelineHostRequestHandlers,
  pipelineHostCoreCaller,
  settlePipelineHostRequests,
} from '../host-requests';

const HOST_INSTRUCTIONS = {
  'worker.pipeline.hostRequest.respond':
    WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
      'worker.pipeline.hostRequest.respond'
    ],
};
const HOST_STREAMS = {
  'worker.pipeline.hostRequests':
    WORKER_PIPELINE_STREAM_DEFINITIONS['worker.pipeline.hostRequests'],
};

function request(requestId: string): WorkerPipelineHostRequest {
  return {
    requestId,
    executionId: 'run-1',
    jobId: 'build',
    stepId: 'group',
    childExecutionId: null,
    attempt: 0,
    iteration: 0,
    owner: 'personal',
    deadlineAt: '2026-10-29T00:00:00.000Z',
    request: {
      action: 'move-to-group',
      task: { kind: 'project', projectId: 'project-1', taskId: 'task-1' },
      target: { kind: 'name', name: 'Done' },
    },
  };
}

function compose(): {
  broker: PipelineHostRequestBroker;
  dispatcher: CanopyDispatcher<
    Record<never, never>,
    typeof HOST_INSTRUCTIONS,
    typeof HOST_STREAMS
  >;
} {
  const broker = new PipelineHostRequestBroker();
  const handlers = createWorkerPipelineHostRequestHandlers(broker);
  const dispatcher = createCanopyDispatcher({
    profile: 'core+worker',
    definitions: {
      queries: {},
      instructions: HOST_INSTRUCTIONS,
      streams: HOST_STREAMS,
    },
    handlers: {
      queries: {},
      instructions: handlers.instructions,
      streams: handlers.streams,
    },
  });
  return { broker, dispatcher };
}

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 20));

describe('pipeline host requests', () => {
  it('fails a request no core settles, as a run without a desktop does', async () => {
    const { broker } = compose();
    await expect(
      broker.raise(request('r-1'), new AbortController().signal),
    ).rejects.toBeInstanceOf(PipelineHostUnavailableError);
  });

  it('settles each request through the stream and respond instruction', async () => {
    const { broker, dispatcher } = compose();
    const applied: string[] = [];
    const stop = await settlePipelineHostRequests({
      dispatcher,
      caller: pipelineHostCoreCaller('local-desktop'),
      apply: (raised) => {
        applied.push(raised.requestId);
        return Promise.resolve({
          status: 'success',
          outputs: { group: 'Done' },
        });
      },
    });
    await expect(
      broker.raise(request('r-2'), new AbortController().signal),
    ).resolves.toEqual({ status: 'success', outputs: { group: 'Done' } });
    expect(applied).toEqual(['r-2']);
    stop();
  });

  it('redacts an unexpected host error', async () => {
    const { broker, dispatcher } = compose();
    const errors: unknown[] = [];
    const stop = await settlePipelineHostRequests({
      dispatcher,
      caller: pipelineHostCoreCaller('local-desktop'),
      apply: () => Promise.reject(new Error('/private/path exploded')),
      onError: (error) => errors.push(error),
    });
    await expect(
      broker.raise(request('r-3'), new AbortController().signal),
    ).resolves.toEqual({
      status: 'failure',
      failureReason: null,
      message: 'The host step failed unexpectedly.',
      outputs: {},
    });
    expect(errors).toHaveLength(1);
    stop();
  });

  it('withdraws a request when the executor gives up, and reports a late answer as already settled', async () => {
    const { broker, dispatcher } = compose();
    const stop = broker.subscribe(() => undefined);
    const controller = new AbortController();
    const raised = broker.raise(request('r-4'), controller.signal);
    controller.abort(new Error('deadline'));
    await expect(raised).rejects.toThrow('deadline');
    const respond = (executionId: string): Promise<unknown> =>
      dispatcher.instruction(
        'worker.pipeline.hostRequest.respond',
        {
          executionId,
          requestId: 'r-4',
          result: { status: 'success', outputs: {} },
        },
        { caller: pipelineHostCoreCaller('local-desktop'), metadata: {} },
      );
    await expect(respond('run-1')).resolves.toMatchObject({
      requestId: 'r-4',
      outcome: 'already_settled',
    });
    await expect(respond('run-2')).rejects.toMatchObject({
      payload: { code: 'worker.pipeline.hostRequestNotFound' },
    });
    stop();
  });

  it('settles a request once', async () => {
    const { broker } = compose();
    const stop = broker.subscribe(() => undefined);
    const raised = broker.raise(request('r-7'), new AbortController().signal);
    expect(
      broker.respond('run-1', 'r-7', { status: 'success', outputs: {} }),
    ).toMatchObject({ outcome: 'applied' });
    expect(
      broker.respond('run-1', 'r-7', { status: 'success', outputs: {} }),
    ).toMatchObject({ outcome: 'already_settled' });
    await expect(raised).resolves.toEqual({ status: 'success', outputs: {} });
    stop();
  });

  it('settles a result the boundary refuses as a redacted failure', async () => {
    const { broker, dispatcher } = compose();
    const errors: unknown[] = [];
    const stop = await settlePipelineHostRequests({
      dispatcher,
      caller: pipelineHostCoreCaller('local-desktop'),
      apply: () =>
        Promise.resolve({
          status: 'success',
          outputs: { path: '/Users/someone/worktree' },
        }),
      onError: (error) => errors.push(error),
    });
    await expect(
      broker.raise(request('r-8'), new AbortController().signal),
    ).resolves.toMatchObject({ status: 'failure', failureReason: null });
    expect(errors).toHaveLength(1);
    stop();
  });

  it('hands a core that subscribes late every pending request', async () => {
    const { broker } = compose();
    const first = broker.subscribe(() => undefined);
    const raised = broker.raise(request('r-5'), new AbortController().signal);
    first();
    const seen: string[] = [];
    const second = broker.subscribe((pending) => seen.push(pending.requestId));
    broker.respond('run-1', 'r-5', { status: 'success', outputs: {} });
    await expect(raised).resolves.toEqual({ status: 'success', outputs: {} });
    expect(seen).toEqual(['r-5']);
    second();
  });

  it('refuses a caller without the host grant', async () => {
    const { dispatcher } = compose();
    const renderer: CanopyCallerDescriptor = {
      ...pipelineHostCoreCaller('local-desktop'),
      principalId: 'local-desktop-renderer:main',
      grants: [WORKER_PIPELINE_GRANTS.read, WORKER_PIPELINE_GRANTS.write],
    };
    await expect(
      dispatcher.instruction(
        'worker.pipeline.hostRequest.respond',
        {
          executionId: 'run-1',
          requestId: 'r-6',
          result: { status: 'success', outputs: {} },
        },
        { caller: renderer, metadata: {} },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    await settle();
  });
});
