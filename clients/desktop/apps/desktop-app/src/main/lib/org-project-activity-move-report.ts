import { getObservabilityService } from '../observability';
import { logMainProcessInfo, logMainProcessWarn } from './main-process-logging';
import type { ActivityMoveReport } from './org-project-materialization';

/**
 * Make the answer to a move of a checkout's uploaded activity visible
 * (CAN-3601): every answer goes to the main log, and a refusal or failure is
 * also an app diagnostic, without workspace or project ids.
 */
export function reportActivityMove(report: ActivityMoveReport): void {
  if (report.result === 'answered') {
    logMainProcessInfo('Activity move to the organization answered', {
      projectId: report.projectId,
      outcome: report.outcome,
      transferId: report.transferId,
      counts: report.counts,
    });
    return;
  }
  logMainProcessWarn('Activity move to the organization failed', {
    projectId: report.projectId,
    status: report.status,
    serverCode: report.serverCode,
    error: report.error,
  });
  getObservabilityService().recordAppDiagnostic({
    version: 1,
    timestamp: new Date().toISOString(),
    kind: 'org_project_activity_move_failed',
    reason:
      report.serverCode ??
      (report.status === null ? 'network' : `http_${report.status}`),
    error: report.error,
  });
}
