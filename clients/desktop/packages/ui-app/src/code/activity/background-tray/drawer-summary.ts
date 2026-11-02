import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import type { BackgroundTrayAgent } from './AgentRow';
import {
  isFinishedTrayRun,
  type BackgroundTrayRun,
  type BackgroundTrayRunStatus,
} from './RunRow';

/** The leading dot while nothing runs: the most pressing state first. */
export type DrawerDot =
  | 'needs-input'
  | 'failed'
  | 'cancelled'
  | 'completed'
  | 'succeeded';

export interface DrawerSummary {
  /** One line in priority order; empty when there is nothing to show. */
  readonly text: string;
  readonly running: number;
  /** Agents waiting on an approval: they lead Needs you (D7). */
  readonly approvalAgents: readonly BackgroundTrayAgent[];
  readonly runningAgents: readonly BackgroundTrayAgent[];
  readonly needsInputRuns: readonly BackgroundTrayRun[];
  readonly pausedRuns: readonly BackgroundTrayRun[];
  readonly runningRuns: readonly BackgroundTrayRun[];
  readonly finishedRuns: readonly BackgroundTrayRun[];
  /** The header's leading dot, or null while something runs. */
  readonly dot: DrawerDot | null;
  /** More than one group has work, so the groups get labels. */
  readonly labelled: boolean;
}

/** A run kind's icon's corner dot: one waits on the user, or one failed. */
export function runCornerDot(
  runs: readonly BackgroundTrayRun[],
): 'needs-input' | 'failed' | null {
  if (
    runs.some((run) => run.status === 'needs-input' || run.status === 'paused')
  ) {
    return 'needs-input';
  }
  return runs.some((run) => run.status === 'failed') ? 'failed' : null;
}

/** What the drawer's header and groups show for its live work and runs. */
export function summarizeDrawer(
  live: readonly BackgroundTask[],
  agents: readonly BackgroundTrayAgent[],
  runs: readonly BackgroundTrayRun[],
  unlistedDelegations = 0,
): DrawerSummary {
  const approvalAgents = agents.filter((agent) => agent.status === 'approval');
  const runningAgents = agents.filter((agent) => agent.status !== 'approval');
  const runsWith = (status: BackgroundTrayRunStatus): BackgroundTrayRun[] =>
    runs.filter((run) => run.status === status);
  const needsInputRuns = runsWith('needs-input');
  const pausedRuns = runsWith('paused');
  const runningRuns = runsWith('running');
  const finishedRuns = runs.filter((run) => isFinishedTrayRun(run.status));
  const running =
    live.length +
    runningAgents.length +
    unlistedDelegations +
    runningRuns.length;
  const needsInput = approvalAgents.length + needsInputRuns.length;
  const waiting = needsInput + pausedRuns.length;
  const failed = finishedRuns.some((run) => run.status === 'failed');
  const text = [
    running > 0 ? `${running} running in the background` : null,
    needsInput > 0
      ? `${needsInput} ${needsInput === 1 ? 'needs' : 'need'} input`
      : null,
    pausedRuns.length > 0 ? `${pausedRuns.length} paused` : null,
    finishedRuns.length > 0 ? `${finishedRuns.length} finished` : null,
  ]
    .filter((part) => part !== null)
    .join(' · ');
  const dot: DrawerDot | null =
    running > 0
      ? null
      : waiting > 0
        ? 'needs-input'
        : failed
          ? 'failed'
          : finishedRuns.some((run) => run.status === 'cancelled')
            ? 'cancelled'
            : finishedRuns.some((run) => run.status === 'completed')
              ? 'completed'
              : 'succeeded';
  return {
    text,
    running,
    approvalAgents,
    runningAgents,
    needsInputRuns,
    pausedRuns,
    runningRuns,
    finishedRuns,
    dot,
    labelled:
      [waiting, running, finishedRuns.length].filter((count) => count > 0)
        .length > 1,
  };
}
