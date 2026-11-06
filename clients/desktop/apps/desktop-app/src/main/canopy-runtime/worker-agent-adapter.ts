import {
  createWorkerAgentHelperHandlers,
  type HelperExecutionWorker,
  type WorkerAgentHelperHandlers,
} from '@canopy/core-runtime/node/agent/helpers';
import {
  createWorkerAgentRunHandlers,
  type SubagentExecutionWorker,
  type TurnEventSink,
  type TurnExecutionWorker,
  type WorkerAgentRunHandlers,
} from '@canopy/core-runtime/node/agent/turns';

export type WorkerAgentAdapter = {
  instructions: WorkerAgentHelperHandlers['instructions'] &
    WorkerAgentRunHandlers['instructions'];
};

// The helper and agent-run hosts import back into this runtime, so load them
// at dispatch.
export function createWorkerAgentAdapter(options: {
  loadHelpers?: () => Promise<HelperExecutionWorker>;
  loadRuns?: () => Promise<{
    turns: TurnExecutionWorker;
    subagents: SubagentExecutionWorker;
  }>;
  sinkFor: (turnRunId: string) => TurnEventSink | null;
}): WorkerAgentAdapter {
  const loadHelpers =
    options.loadHelpers ??
    (async (): Promise<HelperExecutionWorker> =>
      (await import('../helper-runs/helper-worker-host')).desktopHelperWorker);
  const loadRuns =
    options.loadRuns ??
    (async (): Promise<{
      turns: TurnExecutionWorker;
      subagents: SubagentExecutionWorker;
    }> => {
      const host = await import('../agent-runs/turn-worker-host');
      return {
        turns: host.desktopTurnWorker,
        subagents: host.desktopSubagentWorker,
      };
    });
  let loadingHelpers: Promise<WorkerAgentHelperHandlers> | undefined;
  let loadingRuns: Promise<WorkerAgentRunHandlers> | undefined;
  const helpers = (): Promise<WorkerAgentHelperHandlers> =>
    (loadingHelpers ??= loadHelpers().then(createWorkerAgentHelperHandlers));
  const runs = (): Promise<WorkerAgentRunHandlers> =>
    (loadingRuns ??= loadRuns().then(({ turns, subagents }) =>
      createWorkerAgentRunHandlers({
        turns,
        subagents,
        sinkFor: options.sinkFor,
      }),
    ));
  return {
    instructions: {
      'worker.agent.helper.run': async (params, context) =>
        (await helpers()).instructions['worker.agent.helper.run'](
          params,
          context,
        ),
      'worker.agent.turn.run': async (params, context) =>
        (await runs()).instructions['worker.agent.turn.run'](params, context),
      'worker.agent.subagent.run': async (params, context) =>
        (await runs()).instructions['worker.agent.subagent.run'](
          params,
          context,
        ),
    },
  };
}
