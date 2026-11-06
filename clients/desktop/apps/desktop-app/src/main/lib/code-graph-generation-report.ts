import type { WorkerCodeGraphGenerationReport } from '@canopy/protocol/canopy-core';
import { recordCodeGraphBuildDiagnostic } from './code-graph-build-diagnostics';

/**
 * Records one worktree generation's report as its local build diagnostic.
 * Electron main's own generations record it when they settle; a generation
 * the daemon ran (CAN-5627) is recorded when its answer arrives.
 */
export function recordCodeGraphGenerationReport(input: {
  projectId: string;
  worktreeId: string;
  report: WorkerCodeGraphGenerationReport;
}): void {
  const { projectId, worktreeId, report } = input;
  recordCodeGraphBuildDiagnostic({
    projectId,
    worktreeId,
    detail: {
      scope: 'worktree',
      trigger: report.trigger,
      ...report.diagnostic,
    },
  });
}
