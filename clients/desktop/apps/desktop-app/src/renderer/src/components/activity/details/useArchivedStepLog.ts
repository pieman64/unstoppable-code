import { useEffect, useState } from 'react';
import type { ArchivedPipelineSource } from './pipelineDetailTypes';

export interface ArchivedStepLogIdentity {
  executionId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  iteration: number;
  recovery?: number;
  logFilePath?: string;
}

export interface ArchivedStepLogView {
  loading: boolean;
  lines: string[];
}

const IDLE_VIEW: ArchivedStepLogView = Object.freeze({
  loading: false,
  lines: [],
});

function identityKey(identity: ArchivedStepLogIdentity): string {
  return [
    identity.executionId,
    identity.jobId,
    identity.stepId,
    String(identity.attempt),
    String(identity.iteration),
    identity.recovery === undefined ? '' : String(identity.recovery),
    identity.logFilePath ?? '',
  ].join('\0');
}

/**
 * Reads one archived step log through the container-scoped archive transport.
 * The archive is immutable, so the log is read once per step identity and
 * never follows live output. Live runs use `useStepLogInterest` instead; an
 * archived detail must never reach `window.pipelines.readStepLog`.
 */
export function useArchivedStepLog(
  source: ArchivedPipelineSource | undefined,
  identity: ArchivedStepLogIdentity | null,
): ArchivedStepLogView {
  const key =
    source !== undefined && identity !== null
      ? `${source.projectId}\0${source.containerId}\0${identityKey(identity)}`
      : null;
  const [loaded, setLoaded] = useState<{ key: string; lines: string[] } | null>(
    null,
  );

  const projectId = source?.projectId;
  const containerId = source?.containerId;
  const executionId = identity?.executionId;
  const jobId = identity?.jobId;
  const stepId = identity?.stepId;
  const attempt = identity?.attempt;
  const iteration = identity?.iteration;
  const recovery = identity?.recovery;
  const logFilePath = identity?.logFilePath;

  useEffect(() => {
    if (
      key === null ||
      projectId === undefined ||
      containerId === undefined ||
      executionId === undefined ||
      jobId === undefined ||
      stepId === undefined
    ) {
      return undefined;
    }
    let cancelled = false;
    void window.api.archivedContainers
      .readExecutionStepLog({
        projectId,
        containerId,
        executionId,
        jobId,
        stepId,
        attempt,
        iteration,
        recovery,
        logFilePath,
      })
      .then((response) => {
        if (!cancelled) setLoaded({ key, lines: response.lines });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key, lines: [] });
      });
    return (): void => {
      cancelled = true;
    };
  }, [
    attempt,
    containerId,
    executionId,
    iteration,
    jobId,
    key,
    logFilePath,
    projectId,
    recovery,
    stepId,
  ]);

  if (key === null) return IDLE_VIEW;
  if (loaded?.key !== key) return { loading: true, lines: [] };
  return { loading: false, lines: loaded.lines };
}
