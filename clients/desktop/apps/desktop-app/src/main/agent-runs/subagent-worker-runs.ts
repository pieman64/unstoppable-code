import type {
  AgentRunnerAdapter,
  DelegatedEventSink,
  NativeRunHandle,
} from '@canopy/desktop-shared/node/delegation';
import { beginSubagentRun, type SubagentRunHandle } from './subagent-runs';

interface StartedRun {
  readonly handle: SubagentRunHandle;
  /** Whether the runner confirmed a stop; pending while one is in flight. */
  stopped: Promise<boolean> | boolean;
  /** The runner's terminal event status, once it emitted one. */
  readonly terminal: { status?: string };
}

function closedOutcome(
  stopped: boolean,
  terminalStatus: string | undefined,
): 'completed' | 'failed' | 'cancelled' {
  if (stopped || terminalStatus === 'cancelled') return 'cancelled';
  return terminalStatus === 'failed' || terminalStatus === 'deadline_exceeded'
    ? 'failed'
    : 'completed';
}

/** Wrap one registered runner so each started generation is a core.agent.subagent.run on the local worker (D13). */
export function withSubagentWorkerRuns(
  adapter: AgentRunnerAdapter,
  deps: { begin?: typeof beginSubagentRun } = {},
): AgentRunnerAdapter {
  const begin = deps.begin ?? beginSubagentRun;
  const started = new Map<string, StartedRun>();
  const wrapped: AgentRunnerAdapter = {
    harnessId: adapter.harnessId,
    runtimeKind: adapter.runtimeKind,
    adapterVersion: adapter.adapterVersion,
    canRun: (route) => adapter.canRun(route),
    start: async (request, sink): Promise<NativeRunHandle> => {
      const { parent } = request;
      const handle = await begin({
        delegationId: request.delegationId,
        runGeneration: request.runGeneration,
        harnessId: adapter.harnessId,
        scope: {
          workspaceId: parent.projectId,
          worktreeId: parent.worktreeId,
          chatId: parent.chatId,
        },
        parentTurnId:
          parent.parentDelegationId === undefined
            ? parent.userMessageId
            : undefined,
        parentDelegation:
          parent.parentDelegationId !== undefined &&
          parent.parentRunGeneration !== undefined
            ? {
                delegationId: parent.parentDelegationId,
                runGeneration: parent.parentRunGeneration,
              }
            : undefined,
      });
      const terminal: StartedRun['terminal'] = {};
      const observed: DelegatedEventSink = (event) => {
        if (event.event.type === 'terminal')
          terminal.status = event.event.status;
        return sink(event);
      };
      let native: NativeRunHandle;
      try {
        native = await handle.execute(() => adapter.start(request, observed));
      } catch (error) {
        handle.settle('failed');
        throw error;
      }
      started.set(native.runId, { handle, stopped: false, terminal });
      return native;
    },
    stop: async (native, reason) => {
      const run = started.get(native.runId);
      // Deferred so the pending stop is recorded before the runner can close.
      const receipt = Promise.resolve().then(() =>
        adapter.stop(native, reason),
      );
      if (run) {
        const previous = run.stopped;
        run.stopped = receipt.then(
          async ({ stopped }) => stopped || (await previous),
          () => previous,
        );
      }
      return receipt;
    },
    close: async (native): Promise<void> => {
      const run = started.get(native.runId);
      started.delete(native.runId);
      if (!run) return adapter.close(native);
      try {
        await run.handle.execute(() => adapter.close(native));
      } catch (error) {
        run.handle.settle('failed');
        throw error;
      }
      // Cleanup can close the run while a stop is pending (its terminal
      // arrived first): settle by the stop's receipt without waiting on it
      // here, since a runner's stop may itself wait for cleanup.
      void Promise.resolve(run.stopped).then((stopped) =>
        run.handle.settle(closedOutcome(stopped, run.terminal.status)),
      );
    },
  };
  const steer = adapter.steer?.bind(adapter);
  if (steer) wrapped.steer = steer;
  return wrapped;
}
