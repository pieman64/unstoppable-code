/**
 * Broadcast a pipeline lifecycle event through the same Electron channel used
 * by the production pipeline execution broadcaster.
 */
export async function injectPipelineExecutionEvent(
  electronApp,
  { state, type = 'execution.updated', timestamp = new Date().toISOString() },
) {
  await electronApp.evaluate(
    (_, event) => {
      const ingest = globalThis.__CANOPY_E2E_INGEST_PIPELINE_EVENT__;
      if (typeof ingest !== 'function')
        throw new Error('Pipeline E2E ingress is unavailable');
      ingest(event);
    },
    {
      type,
      executionId: state.id,
      timestamp,
      state,
    },
  );
}

/** Build the retry states emitted for one persisted failed execution. */
export function buildSuccessfulRetryStates(failedState) {
  const withJobStatus = (status) =>
    Object.fromEntries(
      Object.entries(failedState.jobs).map(([jobId, job]) => [
        jobId,
        {
          ...job,
          status,
          steps: Object.fromEntries(
            Object.entries(job.steps).map(([stepId, step]) => [
              stepId,
              { ...step, status },
            ]),
          ),
        },
      ]),
    );

  const running = {
    ...failedState,
    status: 'running',
    started_at: '2026-04-10T12:07:00.000Z',
    completed_at: undefined,
    jobs: withJobStatus('running'),
  };
  const success = {
    ...running,
    status: 'success',
    completed_at: '2026-04-10T12:08:00.000Z',
    jobs: withJobStatus('success'),
  };

  return { running, success };
}
