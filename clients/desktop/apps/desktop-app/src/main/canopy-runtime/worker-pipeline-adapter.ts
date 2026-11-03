import {
  createWorkerPipelineHandlers,
  createWorkerPipelineHostRequestHandlers,
  PipelineHostRequestBroker,
  type PipelineExecutionWorker,
  type WorkerPipelineHandlers,
  type WorkerPipelineHostRequestHandlers,
} from '@canopy/core-runtime/node/pipeline';

/*
 * Registers `worker.pipeline.execution.*` on the desktop dispatcher
 * (CAN-4140) over this process's local pipeline worker. The worker loads on
 * the first pipeline call, because its host modules import back into the
 * runtime.
 */

export interface WorkerPipelineAdapter {
  queries: WorkerPipelineHandlers['queries'];
  instructions: WorkerPipelineHandlers['instructions'] &
    WorkerPipelineHostRequestHandlers['instructions'];
  streams: WorkerPipelineHandlers['streams'] &
    WorkerPipelineHostRequestHandlers['streams'];
  /** The loaded worker, for core's run records; `null` before the first call. */
  loaded(): PipelineExecutionWorker | null;
  /** The worker's host step requests, which core settles. */
  readonly hostRequests: PipelineHostRequestBroker;
}

export function createWorkerPipelineAdapter(
  load: () => Promise<PipelineExecutionWorker> = async () =>
    (await import('../pipelines/pipeline-worker-host')).desktopPipelineWorker,
): WorkerPipelineAdapter {
  const hostRequests = new PipelineHostRequestBroker();
  const host = createWorkerPipelineHostRequestHandlers(hostRequests);
  let worker: PipelineExecutionWorker | null = null;
  let loading: Promise<WorkerPipelineHandlers> | undefined;
  const handlers = (): Promise<WorkerPipelineHandlers> =>
    (loading ??= load().then((loadedWorker) => {
      worker = loadedWorker;
      return createWorkerPipelineHandlers(loadedWorker);
    }));
  return {
    queries: {
      'worker.pipeline.execution.get': async (params, context) =>
        (await handlers()).queries['worker.pipeline.execution.get'](
          params,
          context,
        ),
    },
    instructions: {
      'worker.pipeline.execution.start': async (params, context) =>
        (await handlers()).instructions['worker.pipeline.execution.start'](
          params,
          context,
        ),
      'worker.pipeline.execution.cancel': async (params, context) =>
        (await handlers()).instructions['worker.pipeline.execution.cancel'](
          params,
          context,
        ),
      'worker.pipeline.hostRequest.respond':
        host.instructions['worker.pipeline.hostRequest.respond'],
    },
    streams: {
      'worker.pipeline.execution.events': async (params, context, sink) =>
        (await handlers()).streams['worker.pipeline.execution.events'](
          params,
          context,
          sink,
        ),
      'worker.pipeline.hostRequests':
        host.streams['worker.pipeline.hostRequests'],
    },
    loaded: () => worker,
    hostRequests,
  };
}
