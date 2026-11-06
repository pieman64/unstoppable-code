import {
  runInAgentWorker,
  runInAgentWorkerSync,
  type AgentWorkerContext,
} from './agent-worker-context';

export class AgentRunClosedError extends Error {
  constructor() {
    super('This agent run has ended.');
    this.name = 'AgentRunClosedError';
  }
}

/**
 * The in-process half of one worker execution (CAN-4115). The host stages it
 * before dispatch; once the `worker.agent.*.run` handler takes it, the host's
 * expressions run in that run's worker context. The portable binding
 * (CAN-4116 onwards) replaces this with worker-side execution.
 */
export class StagedAgentRun {
  private state: 'staged' | 'taken' | 'closed' = 'staged';
  private closedWith: Error | undefined;
  private readonly waiters: Array<{
    resolve(): void;
    reject(error: Error): void;
  }> = [];

  constructor(readonly context: AgentWorkerContext) {}

  get taken(): boolean {
    return this.state === 'taken';
  }

  get closed(): boolean {
    return this.state === 'closed';
  }

  /** Host side: wait until the worker handler has taken the run, then run `fn` inside the worker context. */
  async execute<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.state === 'staged')
      await new Promise<void>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
    if (this.state !== 'taken') throw this.closedError();
    return runInAgentWorker(this.context, fn);
  }

  /** Host side: run `fn` synchronously inside the worker context; throws AgentRunClosedError unless taken and open. */
  executeSync<T>(fn: () => T): T {
    if (this.state !== 'taken') throw this.closedError();
    return runInAgentWorkerSync(this.context, fn);
  }

  /** Worker side: the `worker.agent.*.run` handler took the run; releases waiting `execute` calls. */
  take(): void {
    if (this.state !== 'staged') return;
    this.state = 'taken';
    for (const waiter of this.waiters.splice(0)) waiter.resolve();
  }

  /** Pending and later `execute`/`executeSync` calls reject or throw with `error` (default AgentRunClosedError). */
  close(error?: Error): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.closedWith = error;
    const closed = this.closedError();
    for (const waiter of this.waiters.splice(0)) waiter.reject(closed);
  }

  private closedError(): Error {
    return this.closedWith ?? new AgentRunClosedError();
  }
}

const stagedRuns = new Map<string, StagedAgentRun>();

export function stageAgentRun(run: StagedAgentRun): void {
  if (stagedRuns.has(run.context.runId))
    throw new Error('An agent run is already staged under this id.');
  stagedRuns.set(run.context.runId, run);
}

export function takeStagedAgentRun(runId: string): StagedAgentRun | undefined {
  const run = stagedRuns.get(runId);
  stagedRuns.delete(runId);
  return run;
}

export function discardStagedAgentRun(runId: string): void {
  stagedRuns.delete(runId);
}
