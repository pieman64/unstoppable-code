import type {
  ExecutionSummary,
  JobResult,
} from '@canopy/desktop-shared/types/pipeline';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';

type PipelineExecutionStatus = ExecutionSummary['status'];

// Background-process status helpers moved verbatim to @canopy/ui-shared so
// the shared section body and desktop consumers share one implementation.
export {
  getBackgroundProcessStatusClassName as getStatusClassName,
  isTerminalBackgroundProcessStatus as isTerminalStatus,
} from '@canopy/ui-shared/lib';

export function isPipelineExecutionActiveStatus(
  status: PipelineExecutionStatus,
): boolean {
  return status === 'pending' || status === 'running' || status === 'paused';
}

export function getPipelineExecutionStatusBadgeClassName(
  status: PipelineExecutionStatus,
): string {
  switch (status) {
    case 'running':
      return `${OPERATIONAL_STATUS_COLORS.active.backgroundBadge} ${OPERATIONAL_STATUS_COLORS.active.foreground}`;
    case 'success':
      return `${OPERATIONAL_STATUS_COLORS.success.backgroundBadge} ${OPERATIONAL_STATUS_COLORS.success.foreground}`;
    case 'failure':
      return `${OPERATIONAL_STATUS_COLORS.failed.backgroundBadge} ${OPERATIONAL_STATUS_COLORS.failed.foreground}`;
    case 'cancelled':
    case 'paused':
      return `${OPERATIONAL_STATUS_COLORS.paused.backgroundBadge} ${OPERATIONAL_STATUS_COLORS.paused.foreground}`;
    default:
      return `${OPERATIONAL_STATUS_COLORS.paused.backgroundSubtle} ${OPERATIONAL_STATUS_COLORS.paused.foregroundMuted}`;
  }
}

export function getPipelineExecutionMutedStatusBadgeClassName(
  status: PipelineExecutionStatus,
): string {
  switch (status) {
    case 'success':
      return `${OPERATIONAL_STATUS_COLORS.success.backgroundQuiet} ${OPERATIONAL_STATUS_COLORS.success.foregroundQuiet}`;
    case 'failure':
      return `${OPERATIONAL_STATUS_COLORS.failed.backgroundQuiet} ${OPERATIONAL_STATUS_COLORS.failed.foregroundQuiet}`;
    case 'cancelled':
      return `${OPERATIONAL_STATUS_COLORS.paused.backgroundQuiet} ${OPERATIONAL_STATUS_COLORS.paused.foregroundQuiet}`;
    default:
      return `${OPERATIONAL_STATUS_COLORS.paused.backgroundQuiet} ${OPERATIONAL_STATUS_COLORS.paused.foregroundQuiet}`;
  }
}

export function getPipelineJobStatusBadgeClassName(
  status: JobResult['status'],
): string {
  switch (status) {
    case 'running':
    case 'restarting':
      return `${OPERATIONAL_STATUS_COLORS.active.backgroundBadge} ${OPERATIONAL_STATUS_COLORS.active.foreground}`;
    case 'success':
      return `${OPERATIONAL_STATUS_COLORS.success.backgroundBadge} ${OPERATIONAL_STATUS_COLORS.success.foreground}`;
    case 'failure':
      return `${OPERATIONAL_STATUS_COLORS.failed.backgroundBadge} ${OPERATIONAL_STATUS_COLORS.failed.foreground}`;
    case 'cancelled':
    case 'paused':
      return `${OPERATIONAL_STATUS_COLORS.paused.backgroundBadge} ${OPERATIONAL_STATUS_COLORS.paused.foreground}`;
    case 'skipped':
      return `${OPERATIONAL_STATUS_COLORS.paused.backgroundQuiet} ${OPERATIONAL_STATUS_COLORS.paused.foregroundQuiet}`;
    default:
      return `${OPERATIONAL_STATUS_COLORS.paused.backgroundSubtle} ${OPERATIONAL_STATUS_COLORS.paused.foregroundMuted}`;
  }
}

/**
 * Fill for a job or step status dot. A dot has no text for a tinted badge
 * background to sit behind, so it takes the solid status role, matching the
 * run card's job dots (`DagProgressBar`) the run was opened from; skipped
 * and cancelled work fades back.
 */
export function getPipelineJobStatusDotClassName(
  status: JobResult['status'],
): string {
  switch (status) {
    case 'running':
    case 'restarting':
      return OPERATIONAL_STATUS_COLORS.active.background;
    case 'success':
      return OPERATIONAL_STATUS_COLORS.success.background;
    case 'failure':
      return OPERATIONAL_STATUS_COLORS.failed.background;
    case 'cancelled':
      return `${OPERATIONAL_STATUS_COLORS.paused.background} opacity-60`;
    case 'skipped':
      return `${OPERATIONAL_STATUS_COLORS.paused.background} opacity-40`;
    default:
      return OPERATIONAL_STATUS_COLORS.paused.background;
  }
}
