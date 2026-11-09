import { useEffect, useState } from 'react';
import type {
  ExecutionState,
  ExecutionSummary,
  PipelineAdvisorReport,
  PipelineAdvisorSnapshot,
} from '@canopy/execution-engine/types/pipeline';
import { isPipelineExecutionActiveStatus } from './utils';

const ADVISOR_ETA_TICK_MS = 30_000;

export function usePipelineAdvisorEtaNow(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      return;
    }

    setNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, ADVISOR_ETA_TICK_MS);

    return (): void => {
      window.clearInterval(intervalId);
    };
  }, [active]);

  return nowMs;
}

export function formatAdvisorRemainingSeconds(
  remainingSeconds: number,
): string {
  const total = Math.max(0, Math.round(remainingSeconds));
  if (total < 60) {
    return 'ETA <1m';
  }
  const minutes = Math.round(total / 60);
  if (minutes < 60) {
    return `ETA ~${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (remMinutes === 0) {
    return `ETA ~${hours}h`;
  }
  return `ETA ~${hours}h ${String(remMinutes).padStart(2, '0')}m`;
}

function formatAdvisorAbsoluteEta(expectedCompletionAt: string): string | null {
  const date = new Date(expectedCompletionAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `ETA ${time}`;
}

function getElapsedSecondsSinceReport(
  report: PipelineAdvisorReport,
  currentTimeMs: number,
): number | null {
  const generatedAtMs = new Date(report.generatedAt).getTime();
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(currentTimeMs)) {
    return null;
  }
  return Math.max(0, (currentTimeMs - generatedAtMs) / 1000);
}

function getDynamicRemainingSeconds(
  report: PipelineAdvisorReport,
  currentTimeMs: number | undefined,
): number | null {
  const eta = report.eta;
  if (typeof currentTimeMs !== 'number') {
    return null;
  }
  if (
    typeof eta.remainingSeconds === 'number' &&
    Number.isFinite(eta.remainingSeconds)
  ) {
    const elapsedSeconds = getElapsedSecondsSinceReport(report, currentTimeMs);
    if (elapsedSeconds === null) {
      return eta.remainingSeconds;
    }
    return Math.max(0, eta.remainingSeconds - elapsedSeconds);
  }
  if (typeof eta.expectedCompletionAt === 'string') {
    const expectedCompletionMs = new Date(eta.expectedCompletionAt).getTime();
    if (Number.isFinite(expectedCompletionMs)) {
      return Math.max(0, (expectedCompletionMs - currentTimeMs) / 1000);
    }
  }
  return null;
}

export function formatAdvisorReportEta(
  report: PipelineAdvisorReport,
  currentTimeMs?: number,
): string {
  const eta = report.eta;
  if (eta.status === 'complete') {
    return 'Complete';
  }
  if (eta.status === 'unknown') {
    return 'ETA unknown';
  }

  const dynamicRemainingSeconds = getDynamicRemainingSeconds(
    report,
    currentTimeMs,
  );
  if (dynamicRemainingSeconds !== null) {
    return formatAdvisorRemainingSeconds(dynamicRemainingSeconds);
  }

  if (
    typeof eta.remainingSeconds === 'number' &&
    Number.isFinite(eta.remainingSeconds)
  ) {
    return formatAdvisorRemainingSeconds(eta.remainingSeconds);
  }
  if (typeof eta.expectedCompletionAt === 'string') {
    const formatted = formatAdvisorAbsoluteEta(eta.expectedCompletionAt);
    if (formatted) {
      return formatted;
    }
  }
  return 'ETA unknown';
}

/**
 * Render the compact ETA/status string for an advisor snapshot.
 */
export function formatAdvisorEta(
  snapshot?: PipelineAdvisorSnapshot,
  pipelineStatus?: ExecutionSummary['status'],
  currentTimeMs = Date.now(),
): string | null {
  if (!snapshot) {
    return null;
  }
  const report = snapshot.latestReport;
  const terminalPipeline =
    pipelineStatus !== undefined &&
    !isPipelineExecutionActiveStatus(pipelineStatus);
  const activeRetryAdvisor =
    !terminalPipeline &&
    (snapshot.status === 'starting' || snapshot.status === 'running') &&
    report?.eta.status === 'complete';
  if (activeRetryAdvisor) {
    return snapshot.status === 'running'
      ? 'Advisor running'
      : 'Advisor starting';
  }
  if (!report) {
    if (advisorErrorIsStale(snapshot) || snapshot.status === 'failed') {
      return 'Update failed';
    }
    if (snapshot.status === 'running') {
      return 'Advisor running';
    }
    if (snapshot.status === 'starting' && !terminalPipeline) {
      return 'Advisor starting';
    }
    return 'Advisor pending';
  }
  if (terminalPipeline && report.eta.status !== 'complete') {
    return 'Pending';
  }
  return formatAdvisorReportEta(report, currentTimeMs);
}

export function formatAdvisorEtaForModal(
  snapshot?: PipelineAdvisorSnapshot,
  pipelineStatus?: ExecutionState['status'],
  currentTimeMs = Date.now(),
): string {
  if (!snapshot) {
    return 'No advisor';
  }
  const terminalPipeline =
    pipelineStatus !== undefined &&
    !isPipelineExecutionActiveStatus(pipelineStatus);
  const activeRetryAdvisor =
    !terminalPipeline &&
    (snapshot.status === 'starting' || snapshot.status === 'running') &&
    snapshot.latestReport?.eta.status === 'complete';
  if (activeRetryAdvisor) {
    return snapshot.status === 'running'
      ? 'Advisor running'
      : 'Advisor starting';
  }
  if (
    snapshot.lastError &&
    (!snapshot.latestReport ||
      new Date(snapshot.lastError.at).getTime() >
        new Date(snapshot.latestReport.generatedAt).getTime())
  ) {
    return 'Update failed';
  }
  const report = snapshot.latestReport;
  if (!report) {
    if (snapshot.status === 'running') {
      return 'Advisor running';
    }
    if (snapshot.status === 'starting' && !terminalPipeline) {
      return 'Advisor starting';
    }
    return 'Advisor pending';
  }
  if (terminalPipeline && report.eta.status !== 'complete') {
    return 'Pending';
  }
  return formatAdvisorReportEta(report, currentTimeMs);
}

/**
 * Returns true when the advisor's `lastError` has not been superseded by a
 * later successful report.
 */
export function advisorErrorIsStale(
  snapshot: PipelineAdvisorSnapshot,
): boolean {
  if (!snapshot.lastError) {
    return false;
  }
  const errorTime = new Date(snapshot.lastError.at).getTime();
  const report = snapshot.latestReport;
  if (!report) {
    return true;
  }
  const reportTime = new Date(report.generatedAt).getTime();
  if (Number.isNaN(errorTime) || Number.isNaN(reportTime)) {
    return true;
  }
  return errorTime > reportTime;
}
