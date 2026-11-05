import {
  createWorkerAgentHelperHandlers,
  type HelperExecutionWorker,
  type WorkerAgentHelperHandlers,
} from '@canopy/core-runtime/node/agent/helpers';

export type WorkerAgentHelperAdapter = WorkerAgentHelperHandlers;

// The helper host imports back into this runtime, so load it at dispatch.
export function createWorkerAgentHelperAdapter(
  load: () => Promise<HelperExecutionWorker> = async () =>
    (await import('../helper-runs/helper-worker-host')).desktopHelperWorker,
): WorkerAgentHelperAdapter {
  let loading: Promise<WorkerAgentHelperHandlers> | undefined;
  const handlers = (): Promise<WorkerAgentHelperHandlers> =>
    (loading ??= load().then(createWorkerAgentHelperHandlers));
  return {
    instructions: {
      'worker.agent.helper.run': async (params, context) =>
        (await handlers()).instructions['worker.agent.helper.run'](
          params,
          context,
        ),
    },
  };
}
