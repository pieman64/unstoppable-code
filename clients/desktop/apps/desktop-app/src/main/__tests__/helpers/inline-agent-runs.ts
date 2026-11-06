import type * as AgentWorkerContextModule from '../../agent-runs/agent-worker-context';
import type * as StagedAgentRunModule from '../../agent-runs/staged-agent-run';
import type * as TurnRunsModule from '../../agent-runs/turn-runs';
import type {
  BeginChatTurnRunRequest,
  ChatTurnRunHandle,
} from '../../agent-runs/turn-runs';

export interface RecordedTurnRun {
  request: BeginChatTurnRunRequest;
  executed: number;
  accepted: boolean;
  /** Every envelope the handle would have sent to the core sink, in order. */
  events: Array<{
    kind: 'accepted' | 'transcript' | 'terminal';
    sequence: number;
  }>;
  settledWith: 'completed' | 'failed' | 'cancelled' | null;
  abandoned: boolean;
  /** Test hook: abort the handle's signal. */
  abort(): void;
}

/** Module factory for jest.mock of '../agent-runs/turn-runs' (path relative to the test). */
export function inlineTurnRunsModule(): {
  runs: RecordedTurnRun[];
  beginChatTurnRun: (
    request: BeginChatTurnRunRequest,
  ) => Promise<ChatTurnRunHandle>;
  chatTurnOutcomeOf: typeof TurnRunsModule.chatTurnOutcomeOf;
  TurnWorkerUnavailableError: typeof TurnRunsModule.TurnWorkerUnavailableError;
  emitChatTurnWait: typeof TurnRunsModule.emitChatTurnWait;
} {
  const actual = jest.requireActual<typeof TurnRunsModule>(
    '../../agent-runs/turn-runs',
  );
  const context = jest.requireActual<typeof AgentWorkerContextModule>(
    '../../agent-runs/agent-worker-context',
  );
  const { AgentRunClosedError } = jest.requireActual<
    typeof StagedAgentRunModule
  >('../../agent-runs/staged-agent-run');
  const runs: RecordedTurnRun[] = [];
  return {
    runs,
    chatTurnOutcomeOf: actual.chatTurnOutcomeOf,
    TurnWorkerUnavailableError: actual.TurnWorkerUnavailableError,
    emitChatTurnWait: (): boolean => false,
    beginChatTurnRun: (request) => {
      const controller = new AbortController();
      const worker = {
        kind: 'turn' as const,
        runId: `test-${runs.length + 1}`,
      };
      const run: RecordedTurnRun = {
        request,
        executed: 0,
        accepted: false,
        events: [],
        settledWith: null,
        abandoned: false,
        abort: () => controller.abort(),
      };
      runs.push(run);
      let sequence = 0;
      let observed = false;
      const settle = (outcome: 'completed' | 'failed' | 'cancelled'): void => {
        if (run.settledWith !== null) return;
        run.events.push({ kind: 'terminal', sequence: sequence++ });
        run.settledWith = outcome;
      };
      const handle: ChatTurnRunHandle = {
        turnRunId: worker.runId,
        signal: controller.signal,
        // Like the staged run, a settled run's worker has closed it.
        execute: (fn) => {
          if (run.settledWith !== null)
            return Promise.reject(new AgentRunClosedError());
          run.executed += 1;
          return context.runInAgentWorker(worker, fn);
        },
        executeSync: (fn) => {
          if (run.settledWith !== null) throw new AgentRunClosedError();
          run.executed += 1;
          return context.runInAgentWorkerSync(worker, fn);
        },
        observe: (handler) => {
          if (observed)
            throw new Error('A chat turn run observes one event handler.');
          observed = true;
          return async (data, mark) => {
            run.events.push({ kind: 'transcript', sequence: sequence++ });
            await handler(data, mark);
          };
        },
        accepted: () => {
          if (run.accepted) return;
          run.accepted = true;
          run.events.push({ kind: 'accepted', sequence: sequence++ });
        },
        settle,
        abandon: (error) => {
          if (run.accepted || run.settledWith !== null) return;
          run.abandoned = true;
          settle(error === undefined ? 'cancelled' : 'failed');
        },
      };
      return Promise.resolve(handle);
    },
  };
}
