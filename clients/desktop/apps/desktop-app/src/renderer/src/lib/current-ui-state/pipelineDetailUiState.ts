import type { AppAdvisorJson } from '@canopy/desktop-shared/types';
import type { PipelineTransientRetryState } from '@canopy/execution-engine/types/pipeline';

interface PipelineDetailStatusReason {
  id: string;
  kind: string;
  code: string;
  source: { job_id: string; step_id: string };
}

interface PipelineDetailSummary {
  pipeline_id: string;
  status: string;
  status_reasons?: readonly PipelineDetailStatusReason[];
}

interface PipelineDetailState {
  pipeline_id: string;
  status: string;
  transient_retry?: PipelineTransientRetryState;
  pending_pauses?: readonly {
    kind: string;
    request?: unknown;
  }[];
  status_reasons?: readonly PipelineDetailStatusReason[];
}

/**
 * Current-UI slice key prefix for shown `pipeline-execution` panels. Each
 * panel reports under its own `${prefix}${ownerKey}::${panelId}` key, so
 * several visible panels never overwrite or clear each other; a hidden panel
 * reports nothing. The snapshot builder aggregates every key with this
 * prefix into `pipelineRunDetails`.
 */
export const PIPELINE_DETAIL_PANEL_UI_STATE_KEY_PREFIX =
  'pipelineRuns.detailPanel.';

/** The current-UI slice the ownerless compatibility modal reports under. */
export const PIPELINE_DETAIL_MODAL_UI_STATE_KEY = 'pipelineRuns.detailModal';

export function pipelineDetailPanelUiStateKey(panelUiKey: string): string {
  return `${PIPELINE_DETAIL_PANEL_UI_STATE_KEY_PREFIX}${panelUiKey}`;
}

export function buildPipelineDetailUiState({
  executionId,
  summary,
  state,
  selectedJobId,
}: {
  executionId: string;
  summary?: PipelineDetailSummary;
  state?: PipelineDetailState;
  selectedJobId?: string;
}): { [key: string]: AppAdvisorJson } {
  const inputRequired = state?.pending_pauses?.some(
    (checkpoint) => checkpoint.kind === 'input' && checkpoint.request,
  );
  const executionStatus = state?.status ?? summary?.status;
  return {
    executionId,
    pipelineId: state?.pipeline_id ?? summary?.pipeline_id ?? '',
    status: executionStatus ?? '',
    selectedJobId: selectedJobId ?? '',
    ...(state
      ? {
          inputRequired: inputRequired === true,
          resumable: executionStatus === 'paused' && inputRequired !== true,
          ...(state.transient_retry
            ? {
                transientRetry: {
                  attempt: state.transient_retry.attempt,
                  maxAttempts: state.transient_retry.maxAttempts,
                  nextRetryAt: state.transient_retry.nextRetryAt,
                  exhausted: state.transient_retry.exhausted,
                },
              }
            : {}),
        }
      : {}),
    resumableStatusReasons: (
      state?.status_reasons ??
      summary?.status_reasons ??
      []
    )
      .filter((reason) => reason.kind !== 'input_required')
      .map((reason) => ({
        id: reason.id,
        kind: reason.kind,
        code: reason.code,
        jobId: reason.source.job_id,
        stepId: reason.source.step_id,
      })),
  };
}
