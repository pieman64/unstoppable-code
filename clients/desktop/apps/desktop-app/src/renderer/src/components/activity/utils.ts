import type {
  ExecutionSummary,
  JobResult,
  PipelineAdvisorHealthStatus,
} from '@canopy/execution-engine/types/pipeline';
import {
  runStatusGlyphState,
  statusBadgeTone,
  type BadgeTone,
  type StatusGlyphState,
} from '@canopy/ui-shared/lib';

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

/** A pipeline status pill: the shared Badge tone, quiet for work not started. */
export interface PipelineStatusBadge {
  readonly tone: BadgeTone;
  readonly muted: boolean;
}

/**
 * Execution or job status → the shared status-badge tone, the same mapping
 * the shared run rows use (`statusBadgeTone`): running is info, success is
 * success, failure is danger, paused and cancelled are neutral. Work that
 * has not started (pending, queued) or never ran (skipped) is muted.
 */
export function pipelineStatusBadge(
  status: PipelineExecutionStatus | JobResult['status'],
): PipelineStatusBadge {
  switch (status) {
    case 'running':
    case 'restarting':
      return { tone: statusBadgeTone('active'), muted: false };
    case 'success':
      return { tone: statusBadgeTone('success'), muted: false };
    case 'failure':
      return { tone: statusBadgeTone('failed'), muted: false };
    case 'cancelled':
    case 'paused':
      return { tone: statusBadgeTone('paused'), muted: false };
    default:
      return { tone: statusBadgeTone('paused'), muted: true };
  }
}

/**
 * Execution, job or step status → its StatusGlyph state. Every status the
 * pipeline types allow has a glyph; anything else reads as queued.
 */
export function pipelineStatusGlyphState(
  status: PipelineExecutionStatus | JobResult['status'],
): StatusGlyphState {
  return runStatusGlyphState(status) ?? 'queued';
}

/** Advisor health → the Badge tone shown in the report and the header. */
export function advisorHealthBadgeTone(
  status: PipelineAdvisorHealthStatus,
): BadgeTone {
  switch (status) {
    case 'healthy':
    case 'complete':
      return 'success';
    case 'watch':
      return 'info';
    case 'degraded':
      return 'warning';
    case 'blocked':
      return 'danger';
    case 'unknown':
    default:
      return 'neutral';
  }
}
