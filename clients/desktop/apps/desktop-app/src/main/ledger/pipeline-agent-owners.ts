import {
  isSameLedgerGlobalOwner,
  type LedgerContainer,
} from '@canopy/protocol/canopy-core';

/*
 * Paused pipeline agents as Ledger owner candidates (phase 08). The pipeline
 * host records an agent when its attempt pauses on a recovery checkpoint the
 * same agent session resumes, retires it once a saved resume consumes that
 * checkpoint, and retires an execution's agents before it is cancelled. The
 * Ledger reads the record to offer the agents as owners and takes an
 * execution's admission fence from its eligibility check through its commit,
 * so a picker opened before a resume cannot assign the agent new work after
 * it. Records live in memory only: after a restart no paused agent is offered
 * until one pauses again. This module imports nothing from pipelines or the
 * Ledger service, so both can depend on it.
 */

/** A paused pipeline agent that its recovery checkpoint can resume. */
export interface LedgerPausedPipelineAgent {
  /** The agent session: the actor's host key. */
  readonly agentSessionId: string;
  readonly displayName: string;
  readonly executionId: string;
  /** The physical job, step and attempt the agent paused in. */
  readonly jobId: string;
  readonly stepId: string;
  readonly attempt: number;
  /** The Ledger container of the execution's worktree. */
  readonly container: LedgerContainer;
  /**
   * The Ledger incarnation the agent paused in. A global (workflow) Ledger
   * is one per account, so when it is recorded its agents are offered only
   * in that incarnation.
   */
  readonly containerCreatedAt?: string;
  /** The recovery checkpoint the agent resumes from. */
  readonly checkpointId: string;
  /** The execution's lifecycle generation when the agent paused. */
  readonly executionGeneration: number;
  /** Orders owner candidates; null when unknown. */
  readonly pausedAt: string | null;
}

/** What the Ledger needs from the paused-agent record. */
export interface LedgerPipelineAgentSource {
  /** The container's paused agents, in the incarnation when one is given. */
  list(
    container: LedgerContainer,
    containerCreatedAt?: string,
  ): readonly LedgerPausedPipelineAgent[];
  /** A paused agent by its agent session, or undefined. */
  find(agentSessionId: string): LedgerPausedPipelineAgent | undefined;
  /** Runs `fn` under the execution's lifecycle admission fence. */
  withAdmission<T>(executionId: string, fn: () => Promise<T>): Promise<T>;
}

function sameContainer(left: LedgerContainer, right: LedgerContainer): boolean {
  switch (left.kind) {
    case 'code_worktree':
      return (
        right.kind === 'code_worktree' &&
        left.workspaceId === right.workspaceId &&
        left.worktreeId === right.worktreeId
      );
    case 'cowork_entry':
      return (
        right.kind === 'cowork_entry' &&
        left.workspaceId === right.workspaceId &&
        left.entryId === right.entryId
      );
    case 'advisor_entry':
      return right.kind === 'advisor_entry' && left.entryId === right.entryId;
    case 'global':
      return (
        right.kind === 'global' &&
        isSameLedgerGlobalOwner(left.owner, right.owner)
      );
  }
}

/**
 * The paused-agent record. Each execution has a lifecycle generation, bumped
 * by every pause, resume and cancellation, and an admission fence that owner
 * commits and those lifecycle changes share.
 */
export class LedgerPipelineAgentOwners implements LedgerPipelineAgentSource {
  private readonly paused = new Map<string, LedgerPausedPipelineAgent>();
  private readonly generations = new Map<string, number>();
  private readonly fences = new Map<string, Promise<void>>();

  /** The execution's current lifecycle generation. */
  generation(executionId: string): number {
    return this.generations.get(executionId) ?? 0;
  }

  /**
   * Records an agent paused on a checkpoint its session resumes, at a new
   * generation of its execution.
   */
  notePaused(
    agent: Omit<LedgerPausedPipelineAgent, 'executionGeneration'>,
  ): void {
    const executionGeneration = this.bump(agent.executionId);
    this.paused.set(agent.agentSessionId, { ...agent, executionGeneration });
  }

  /** The agent runs again, so it is no longer an assignable paused agent. */
  noteRunning(agentSessionId: string): void {
    this.paused.delete(agentSessionId);
  }

  /**
   * The execution resumed some checkpoints (all when `checkpointIds` is
   * omitted) or was cancelled. Their agents stop being assignable, and every
   * token issued for any of its agents goes stale: agents still paused are
   * kept at the new generation, so a refreshed picker offers them again.
   */
  retireExecution(
    executionId: string,
    checkpointIds?: readonly string[],
  ): void {
    const executionGeneration = this.bump(executionId);
    this.paused.forEach((agent, agentSessionId): void => {
      if (agent.executionId !== executionId) return;
      if (
        checkpointIds === undefined ||
        checkpointIds.includes(agent.checkpointId)
      ) {
        this.paused.delete(agentSessionId);
      } else {
        this.paused.set(agentSessionId, { ...agent, executionGeneration });
      }
    });
  }

  /** The executions with a recorded paused agent. */
  pausedExecutionIds(): Set<string> {
    return new Set(
      Array.from(this.paused.values(), (agent) => agent.executionId),
    );
  }

  list(
    container: LedgerContainer,
    containerCreatedAt?: string,
  ): LedgerPausedPipelineAgent[] {
    return Array.from(this.paused.values()).filter(
      (agent) =>
        sameContainer(agent.container, container) &&
        // Another account's global Ledger shares its owner, not its agents.
        (container.kind !== 'global' ||
          agent.containerCreatedAt === undefined ||
          agent.containerCreatedAt === containerCreatedAt),
    );
  }

  find(agentSessionId: string): LedgerPausedPipelineAgent | undefined {
    return this.paused.get(agentSessionId);
  }

  async withAdmission<T>(
    executionId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.fences.get(executionId) ?? Promise.resolve();
    let release: () => void = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.fences.set(executionId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.fences.get(executionId) === tail)
        this.fences.delete(executionId);
    }
  }

  private bump(executionId: string): number {
    const next = this.generation(executionId) + 1;
    this.generations.set(executionId, next);
    return next;
  }
}

let defaultOwners: LedgerPipelineAgentOwners | undefined;

/** The app's paused pipeline agents. */
export function getLedgerPipelineAgentOwners(): LedgerPipelineAgentOwners {
  defaultOwners ??= new LedgerPipelineAgentOwners();
  return defaultOwners;
}

/**
 * Called by pipeline lifecycle changes that end an execution's pause: a
 * resume of the given checkpoints (all when omitted) or a cancellation.
 * Takes the execution's admission fence, so an owner commit checking one of
 * its agents finishes first; the fence is uncontended unless a Ledger owner
 * commit holds it.
 */
export function retireLedgerPipelineExecution(
  executionId: string,
  checkpointIds?: readonly string[],
): Promise<void> {
  const owners = getLedgerPipelineAgentOwners();
  return owners.withAdmission(executionId, () => {
    owners.retireExecution(executionId, checkpointIds);
    return Promise.resolve();
  });
}

/**
 * Retires the paused agents of an execution about to be cancelled, then
 * those of the nested pipelines it started, which its cancellation leaves
 * paused. Each retirement takes its execution's admission fence, so it
 * follows any owner commit already checking one of its agents: call this
 * before the cancellation starts. `nestedExecutions` lists the executions an
 * execution started; it is called only while a recorded paused agent remains
 * outside the executions retired so far.
 */
export async function retireLedgerPipelineExecutionTree(
  executionId: string,
  nestedExecutions: (executionId: string) => Promise<readonly string[]>,
): Promise<void> {
  await retireLedgerPipelineExecution(executionId);
  const pending = getLedgerPipelineAgentOwners().pausedExecutionIds();
  pending.delete(executionId);
  const retired = new Set([executionId]);
  const queue = [executionId];
  while (pending.size > 0) {
    const next = queue.shift();
    if (next === undefined) return;
    const nested = await nestedExecutions(next).catch(
      (): readonly string[] => [],
    );
    for (const childId of nested) {
      if (retired.has(childId)) continue;
      retired.add(childId);
      await retireLedgerPipelineExecution(childId);
      pending.delete(childId);
      queue.push(childId);
    }
  }
}
