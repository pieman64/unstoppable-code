import type {
  BackgroundWorkflowAgentProgress,
  BackgroundWorkflowProgress,
} from '@canopy/ui-app';
import type { WorkflowRunState } from '@canopy/desktop-shared/types';

const POLL_INTERVAL_MS = 2_000;
const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'canceled',
  'stopped',
]);

function agentState(state: string): BackgroundWorkflowAgentProgress['state'] {
  switch (state.toLowerCase()) {
    case 'done':
    case 'completed':
    case 'succeeded':
      return 'done';
    case 'error':
    case 'failed':
      return 'failed';
    case 'queued':
    case 'pending':
      return 'queued';
    default:
      return 'running';
  }
}

/**
 * An agent's phase in `run.phases`, as the run view assigns it: by title,
 * else by index. The live journal numbers phases from 0, a finished run's
 * persisted state from 1, so only the title is reliable.
 */
function agentPhase(
  run: WorkflowRunState,
  agent: WorkflowRunState['agents'][number],
): number | null {
  const byTitle = run.phases.findIndex(
    (phase) => phase.title === agent.phaseTitle,
  );
  if (byTitle >= 0) return byTitle;
  return agent.phaseIndex >= 1 && agent.phaseIndex <= run.phases.length
    ? agent.phaseIndex - 1
    : null;
}

/**
 * A workflow run's state as the background drawer shows it: the phase the
 * running agents are in (else the last one reached) and one line per agent.
 */
export function workflowProgressFromRun(
  run: WorkflowRunState,
): BackgroundWorkflowProgress {
  const agents = run.agents.map(
    (agent): BackgroundWorkflowAgentProgress => ({
      id: agent.agentId || String(agent.index),
      label: agent.label,
      state: agentState(agent.state),
      activity: agent.lastToolSummary ?? null,
    }),
  );
  const running = run.agents.filter(
    (agent, index) => agents[index]?.state === 'running',
  );
  const phaseAgents = running.length > 0 ? running : run.agents;
  const phases = phaseAgents
    .map((agent) => agentPhase(run, agent))
    .filter((index) => index !== null);
  const phaseIndex = phases.length > 0 ? Math.max(...phases) : null;
  const phaseTitle =
    phaseIndex === null
      ? (phaseAgents.find((agent) => agent.phaseTitle)?.phaseTitle ?? null)
      : (run.phases[phaseIndex]?.title ?? null);
  return {
    phaseTitle,
    phaseIndex,
    phaseCount: run.phases.length,
    agents,
  };
}

/**
 * Polls a workflow run's state (the same reader the detail modal's
 * `useWorkflowRun` uses) until it ends or the caller unsubscribes.
 */
export function subscribeWorkflowRunProgress(
  transcriptDir: string,
  runId: string,
  onProgress: (progress: BackgroundWorkflowProgress) => void,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    let done = false;
    try {
      const run = await window.api.activity.readWorkflowRun({
        transcriptDir,
        runId,
      });
      if (cancelled) return;
      if (run) {
        onProgress(workflowProgressFromRun(run));
        done = TERMINAL_RUN_STATUSES.has(run.status.toLowerCase());
      }
    } catch {
      // A failed read keeps the last progress; the next tick tries again.
    }
    if (!cancelled && !done) {
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    }
  };
  void tick();
  return (): void => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
