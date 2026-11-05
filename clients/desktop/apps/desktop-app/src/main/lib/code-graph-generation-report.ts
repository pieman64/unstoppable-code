import type { WorkerCodeGraphGenerationReport } from '@canopy/protocol/canopy-core';
import { recordCodeGraphBuildDiagnostic } from './code-graph-build-diagnostics';
import {
  failCodeGraphGenerationTelemetry,
  startCodeGraphGenerationTelemetry,
  succeedCodeGraphGenerationTelemetry,
  type CodeGraphGenerationTelemetryHandle,
} from './code-graph-telemetry';

/**
 * Records one worktree generation's report: its Datadog generation operation
 * and its local build diagnostic, with this app's consent and bundled
 * telemetry configuration. Electron main's own generations pass the handle
 * they started; a generation the daemon ran (CAN-5627) is recorded when its
 * answer arrives, with the daemon's measured duration.
 */
export function recordCodeGraphGenerationReport(input: {
  projectId: string;
  worktreeId: string;
  report: WorkerCodeGraphGenerationReport;
  telemetry?: CodeGraphGenerationTelemetryHandle;
}): void {
  const { projectId, worktreeId, report } = input;
  const telemetry =
    input.telemetry ??
    startCodeGraphGenerationTelemetry({
      operationSeed: `${projectId}/${worktreeId}`,
      scope: 'worktree',
      trigger: report.trigger,
    });
  if (report.repositoryCount !== null)
    telemetry.context.repository_count = report.repositoryCount;
  // A generation Electron main ran keeps its handle's own clock.
  const measured: [] | [number] =
    input.telemetry === undefined ? [report.totalMs] : [];
  if (report.failure === null)
    succeedCodeGraphGenerationTelemetry(
      telemetry,
      report.telemetry,
      ...measured,
    );
  else failCodeGraphGenerationTelemetry(telemetry, report.failure, ...measured);
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
