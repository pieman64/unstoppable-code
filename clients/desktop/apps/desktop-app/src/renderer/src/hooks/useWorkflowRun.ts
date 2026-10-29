import { useEffect, useState } from 'react';
import type { WorkflowRunState } from '@canopy/desktop-shared/types';

const POLL_INTERVAL_MS = 2_000;
const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'canceled',
  'stopped',
]);

function isTerminalRunStatus(status: string | undefined): boolean {
  return status ? TERMINAL_STATUSES.has(status.toLowerCase()) : false;
}

interface WorkflowRunHookState {
  identity: string | null;
  run: WorkflowRunState | null;
  loading: boolean;
}

/**
 * Load a workflow run-state JSON via IPC and poll while it is non-terminal.
 * Returns the latest `WorkflowRunState` plus a first-load `loading` flag.
 */
export function useWorkflowRun(
  transcriptDir: string | undefined,
  runId: string | undefined,
  /** Hint from the background process: stop polling once Canopy marks it done. */
  processStatusTerminal: boolean,
): { run: WorkflowRunState | null; loading: boolean } {
  const identity = transcriptDir && runId ? `${transcriptDir}\0${runId}` : null;
  const [state, setState] = useState<WorkflowRunHookState>({
    identity: null,
    run: null,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    if (!identity || !transcriptDir || !runId) {
      setState({ identity: null, run: null, loading: false });
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    setState((current) =>
      current.identity === identity
        ? current
        : { identity, run: null, loading: true },
    );

    const tick = async (): Promise<void> => {
      try {
        const next = await window.api.activity.readWorkflowRun({
          transcriptDir,
          runId,
        });
        if (cancelled) return;
        setState((current) => ({
          identity,
          run: next ?? (current.identity === identity ? current.run : null),
          loading: false,
        }));
        const done = processStatusTerminal || isTerminalRunStatus(next?.status);
        if (!done && !cancelled) {
          timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
        }
      } catch {
        if (!cancelled) {
          setState((current) => ({
            identity,
            run: current.identity === identity ? current.run : null,
            loading: false,
          }));
        }
      }
    };

    void tick();

    return (): void => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [identity, transcriptDir, runId, processStatusTerminal]);

  if (state.identity !== identity) {
    return { run: null, loading: Boolean(identity) };
  }

  return { run: state.run, loading: state.loading };
}
