import { useEffect, useState, type JSX } from 'react';
import { formatTimingTimestamp } from '@/lib/pipelineTiming';
import type {
  ExecutionState,
  PipelineAdvisorHealthStatus,
  PipelineAdvisorReport,
  PipelineAdvisorSnapshot,
} from '@canopy/desktop-shared/types/pipeline';
import { AgentAssistantIcon } from '@canopy/ui-shared/icons';
import { LoadingSpinner } from '../../shared/loading/spinners/LoadingSpinner';
import { RefreshSpinner } from '../../shared/loading/spinners/RefreshSpinner';
import {
  formatAdvisorEtaForModal,
  formatAdvisorReportEta as formatDynamicAdvisorReportEta,
  usePipelineAdvisorEtaNow,
} from '../PipelineAdvisorEta';
import { PipelineAdvisorMarkdownText } from '../PipelineAdvisorMarkdown';
import { isPipelineExecutionActiveStatus } from '../utils';
import { Tooltip } from '@canopy/ui-shared';

// --- Pipeline Advisor helpers -----------------------------------------------

function canStartPipelineAdvisor({
  snapshot,
  pipelineStatus,
}: {
  snapshot?: PipelineAdvisorSnapshot;
  pipelineStatus?: ExecutionState['status'];
}): boolean {
  const terminalPipeline =
    pipelineStatus !== undefined &&
    !isPipelineExecutionActiveStatus(pipelineStatus);
  return (
    !snapshot ||
    (!snapshot.latestReport &&
      snapshot.status !== 'running' &&
      (snapshot.status !== 'starting' || terminalPipeline))
  );
}

function isPipelineAdvisorBusy({
  snapshot,
  running,
}: {
  snapshot?: PipelineAdvisorSnapshot;
  running: boolean;
}): boolean {
  return (
    running || snapshot?.status === 'running' || snapshot?.status === 'starting'
  );
}

function shouldShowAdvisorBusySpinner({
  snapshot,
  pipelineStatus,
  running,
}: {
  snapshot?: PipelineAdvisorSnapshot;
  pipelineStatus?: ExecutionState['status'];
  running: boolean;
}): boolean {
  if (!running && canStartPipelineAdvisor({ snapshot, pipelineStatus })) {
    return false;
  }
  return isPipelineAdvisorBusy({ snapshot, running });
}

function shouldShowAdvisorRefreshButton({
  snapshot,
  pipelineStatus,
  running,
}: {
  snapshot?: PipelineAdvisorSnapshot;
  pipelineStatus?: ExecutionState['status'];
  running: boolean;
}): boolean {
  if (shouldShowAdvisorBusySpinner({ snapshot, pipelineStatus, running })) {
    return false;
  }
  if (canStartPipelineAdvisor({ snapshot, pipelineStatus })) {
    return false;
  }
  return snapshot?.latestReport?.eta.status !== 'complete';
}

function AdvisorRunButton({
  snapshot,
  running,
  onRun,
}: {
  snapshot?: PipelineAdvisorSnapshot;
  running: boolean;
  onRun: () => void;
}): JSX.Element {
  const label = running
    ? 'Starting…'
    : snapshot?.lastError
      ? 'Retry pipeline advisor'
      : 'Run pipeline advisor';
  return (
    <button
      type="button"
      disabled={running}
      onClick={onRun}
      data-testid="pipeline-detail-run-advisor"
      className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-fg-info/20 bg-info-subtle px-2 py-1 text-2xs font-medium fg-primary transition hover:bg-info-subtle/80 disabled:cursor-not-allowed disabled:opacity-55"
    >
      <AgentAssistantIcon className="h-3.5 w-3.5 fg-info" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function AdvisorBusySpinner(): JSX.Element {
  return (
    <span
      className="inline-flex items-center justify-center"
      data-testid="pipeline-detail-advisor-running-spinner"
    >
      <LoadingSpinner tone="active" />
    </span>
  );
}

function AdvisorRefreshButton({
  pipelineStatus,
  onRun,
  showLabel = false,
}: {
  pipelineStatus?: ExecutionState['status'];
  onRun: () => void;
  showLabel?: boolean;
}): JSX.Element {
  const terminalPipeline =
    pipelineStatus !== undefined &&
    !isPipelineExecutionActiveStatus(pipelineStatus);
  const refreshLabel = terminalPipeline
    ? 'Re-run Pipeline Advisor'
    : 'Refresh Pipeline Advisor';
  const className = showLabel
    ? 'focus-ring inline-flex items-center justify-center gap-1.5 rounded-md border border-fg-info/20 bg-info-subtle px-2 py-1 text-2xs font-medium normal-case fg-info transition hover:bg-info-subtle/80'
    : 'focus-ring inline-flex items-center justify-center rounded-md border border-fg-info/20 bg-info-subtle p-1 fg-info transition hover:bg-info-subtle/80';

  return (
    <Tooltip label={refreshLabel}>
      <button
        type="button"
        onClick={onRun}
        aria-label={refreshLabel}
        data-testid="pipeline-detail-refresh-advisor"
        className={className}
      >
        <RefreshSpinner size={12} />
        {showLabel ? <span>Refresh</span> : null}
      </button>
    </Tooltip>
  );
}

export function AdvisorCompactStatus({
  snapshot,
  pipelineStatus,
  running = false,
  onRun,
}: {
  snapshot: PipelineAdvisorSnapshot;
  pipelineStatus?: ExecutionState['status'];
  running?: boolean;
  onRun?: () => void;
}): JSX.Element {
  const etaNowMs = usePipelineAdvisorEtaNow(Boolean(snapshot?.latestReport));
  const advisorBusy = shouldShowAdvisorBusySpinner({
    snapshot,
    pipelineStatus,
    running,
  });
  const showRefresh =
    onRun !== undefined &&
    shouldShowAdvisorRefreshButton({ snapshot, pipelineStatus, running });
  return (
    <span
      className="inline-flex items-center gap-1.5"
      data-testid="pipeline-detail-advisor-eta"
    >
      <AgentAssistantIcon className="h-3.5 w-3.5 fg-info" aria-hidden="true" />
      <span>
        {formatAdvisorEtaForModal(snapshot, pipelineStatus, etaNowMs)}
      </span>
      {advisorBusy ? <AdvisorBusySpinner /> : null}
      {showRefresh ? (
        <AdvisorRefreshButton pipelineStatus={pipelineStatus} onRun={onRun} />
      ) : null}
    </span>
  );
}

export function AdvisorHeaderAction({
  snapshot,
  pipelineStatus,
  running,
  onRun,
}: {
  snapshot?: PipelineAdvisorSnapshot;
  pipelineStatus?: ExecutionState['status'];
  running: boolean;
  onRun: () => void;
}): JSX.Element | null {
  if (shouldShowAdvisorBusySpinner({ snapshot, pipelineStatus, running })) {
    return <AdvisorBusySpinner />;
  }
  if (!shouldShowAdvisorRefreshButton({ snapshot, pipelineStatus, running })) {
    return null;
  }
  return (
    <AdvisorRefreshButton
      pipelineStatus={pipelineStatus}
      onRun={onRun}
      showLabel
    />
  );
}

export function AdvisorActionControl({
  snapshot,
  pipelineStatus,
  running,
  onRun,
}: {
  snapshot?: PipelineAdvisorSnapshot;
  pipelineStatus?: ExecutionState['status'];
  running: boolean;
  onRun: () => void;
}): JSX.Element | null {
  if (canStartPipelineAdvisor({ snapshot, pipelineStatus })) {
    return (
      <AdvisorRunButton snapshot={snapshot} running={running} onRun={onRun} />
    );
  }
  const advisorBusy = isPipelineAdvisorBusy({ snapshot, running });
  if (advisorBusy) {
    return null;
  }
  const latestAdvisorComplete =
    snapshot?.latestReport?.eta.status === 'complete';
  if (latestAdvisorComplete) {
    return null;
  }
  return <AdvisorRefreshButton pipelineStatus={pipelineStatus} onRun={onRun} />;
}

function advisorHealthBadgeClass(status: PipelineAdvisorHealthStatus): string {
  switch (status) {
    case 'healthy':
      return 'bg-success-subtle fg-success-strong';
    case 'watch':
      return 'bg-info-subtle fg-info';
    case 'degraded':
      return 'bg-warning-subtle fg-warning';
    case 'blocked':
      return 'bg-destructive-subtle fg-destructive-strong';
    case 'complete':
      return 'bg-success-subtle fg-success-strong';
    case 'unknown':
    default:
      return 'bg-fg-primary/[0.08] fg-primary/70';
  }
}

/** Pill showing the advisor health status, used in the report and the header. */
export function AdvisorHealthBadge({
  status,
}: {
  status: PipelineAdvisorHealthStatus;
}): JSX.Element {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-3xs font-medium ${advisorHealthBadgeClass(
        status,
      )}`}
    >
      {status}
    </span>
  );
}

function severityClassForModal(
  severity: 'info' | 'warning' | 'critical',
): string {
  switch (severity) {
    case 'critical':
      return 'bg-destructive-subtle fg-destructive-strong';
    case 'warning':
      return 'bg-warning-subtle fg-warning';
    case 'info':
    default:
      return 'bg-info-subtle fg-info';
  }
}

function severityLabelForModal(
  severity: 'info' | 'warning' | 'critical',
): string {
  switch (severity) {
    case 'critical':
      return 'Critical';
    case 'warning':
      return 'Warning';
    case 'info':
    default:
      return 'Info';
  }
}

const ADVISOR_LATEST_REPORT_VALUE = '__latest__';

function getAdvisorReportSelectValue(report: PipelineAdvisorReport): string {
  return `report:${report.reportId}`;
}

function getAdvisorReportHistory(
  snapshot: PipelineAdvisorSnapshot,
): PipelineAdvisorReport[] {
  const reports = [...snapshot.reports];
  if (
    snapshot.latestReport &&
    !reports.some(
      (report) => report.reportId === snapshot.latestReport?.reportId,
    )
  ) {
    reports.push(snapshot.latestReport);
  }

  return reports
    .map((report, index) => ({
      report,
      index,
      generatedAtMs: new Date(report.generatedAt).getTime(),
    }))
    .sort((left, right) => {
      const leftValid = Number.isFinite(left.generatedAtMs);
      const rightValid = Number.isFinite(right.generatedAtMs);
      if (
        leftValid &&
        rightValid &&
        left.generatedAtMs !== right.generatedAtMs
      ) {
        return left.generatedAtMs - right.generatedAtMs;
      }
      if (leftValid !== rightValid) {
        return leftValid ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.report);
}

function formatAdvisorReportHistoryOffset(
  startedAt: string | undefined,
  generatedAt: string,
): string {
  const startedAtMs =
    typeof startedAt === 'string' ? new Date(startedAt).getTime() : NaN;
  const generatedAtMs = new Date(generatedAt).getTime();
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(generatedAtMs)) {
    return '+0h 0m';
  }
  const totalMinutes = Math.max(
    0,
    Math.round((generatedAtMs - startedAtMs) / 60_000),
  );
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `+${minutes}m`;
  }
  return `+${hours}h ${minutes}m`;
}

function getAdvisorReportHistoryLabel(args: {
  report: PipelineAdvisorReport;
  index: number;
  total: number;
  startedAt?: string;
}): string {
  if (args.index === 0) {
    return 'Initial';
  }
  if (args.index === args.total - 1) {
    return 'Latest';
  }
  return formatAdvisorReportHistoryOffset(
    args.startedAt,
    args.report.generatedAt,
  );
}

function AdvisorReportContent({
  report,
  reportHistory = [],
  selectedReportValue = ADVISOR_LATEST_REPORT_VALUE,
  startedAt,
  onReportSelectionChange,
  hideHealthBadge = false,
}: {
  report: PipelineAdvisorReport;
  reportHistory?: PipelineAdvisorReport[];
  selectedReportValue?: string;
  startedAt?: string;
  onReportSelectionChange?: (value: string) => void;
  hideHealthBadge?: boolean;
}): JSX.Element {
  const evidence = report.health.evidence;
  const inefficiencies = report.inefficiencies;
  const recommendations = report.recommendations;
  const showHistorySelector = reportHistory.length > 1;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {hideHealthBadge ? null : (
          <AdvisorHealthBadge status={report.health.status} />
        )}
        {report.eta.status !== 'complete' ? (
          <span className="rounded-full border bg-fg-primary/[0.04] px-2 py-0.5 text-3xs font-medium fg-primary/70">
            {formatDynamicAdvisorReportEta(report)}
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1.5 text-2xs fg-secondary">
          Generated {formatTimingTimestamp(report.generatedAt)}
          {showHistorySelector ? (
            <select
              aria-label="Pipeline Advisor report history"
              data-testid="pipeline-advisor-report-selector"
              value={selectedReportValue}
              onChange={(event) =>
                onReportSelectionChange?.(event.currentTarget.value)
              }
              className="focus-ring rounded border bg-base px-1.5 py-0.5 text-2xs fg-primary"
            >
              {reportHistory.map((historyReport, index) => {
                const isLatest = index === reportHistory.length - 1;
                return (
                  <option
                    key={historyReport.reportId}
                    value={
                      isLatest
                        ? ADVISOR_LATEST_REPORT_VALUE
                        : getAdvisorReportSelectValue(historyReport)
                    }
                  >
                    {getAdvisorReportHistoryLabel({
                      report: historyReport,
                      index,
                      total: reportHistory.length,
                      startedAt,
                    })}
                  </option>
                );
              })}
            </select>
          ) : null}
        </span>
      </div>
      <div>
        <div className="text-3xs font-medium fg-secondary/70">Health</div>
        <div className="mt-1 text-s fg-primary/85">
          <PipelineAdvisorMarkdownText>
            {report.health.summary}
          </PipelineAdvisorMarkdownText>
        </div>
      </div>
      <div>
        <div className="text-3xs font-medium fg-secondary/70">Evidence</div>
        {evidence.length === 0 ? (
          <p className="mt-1 text-s fg-secondary">No evidence recorded.</p>
        ) : (
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-s fg-primary/85">
            {evidence.map((entry, index) => (
              <li key={index} className="break-words">
                <PipelineAdvisorMarkdownText>
                  {entry}
                </PipelineAdvisorMarkdownText>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <div className="text-3xs font-medium fg-secondary/70">
          Inefficiencies
        </div>
        {inefficiencies.length === 0 ? (
          <p className="mt-1 text-s fg-secondary">No inefficiencies flagged.</p>
        ) : (
          <ul className="mt-1 space-y-2">
            {inefficiencies.map((item, index) => (
              <li
                key={`${item.title}-${index}`}
                className="rounded-md border bg-fg-primary/[0.03] px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-3xs font-medium ${severityClassForModal(
                      item.severity,
                    )}`}
                  >
                    {severityLabelForModal(item.severity)}
                  </span>
                  <PipelineAdvisorMarkdownText className="text-s font-medium fg-primary/85">
                    {item.title}
                  </PipelineAdvisorMarkdownText>
                </div>
                <div className="mt-1 text-s fg-primary/80">
                  <PipelineAdvisorMarkdownText>
                    {item.evidence}
                  </PipelineAdvisorMarkdownText>
                </div>
                {item.recommendation && (
                  <div className="mt-1 text-s fg-primary/70">
                    <span>Recommendation: </span>
                    <PipelineAdvisorMarkdownText>
                      {item.recommendation}
                    </PipelineAdvisorMarkdownText>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <div className="text-3xs font-medium fg-secondary/70">Summary</div>
        <div className="mt-1 text-s fg-primary/85">
          <PipelineAdvisorMarkdownText>
            {report.summary}
          </PipelineAdvisorMarkdownText>
        </div>
      </div>
      <div>
        <div className="text-3xs font-medium fg-secondary/70">
          Recommendations
        </div>
        {recommendations.length === 0 ? (
          <p className="mt-1 text-s fg-secondary">No recommendations.</p>
        ) : (
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-s fg-primary/85">
            {recommendations.map((entry, index) => (
              <li key={index} className="break-words">
                <PipelineAdvisorMarkdownText>
                  {entry}
                </PipelineAdvisorMarkdownText>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function AdvisorSection({
  snapshot,
  startedAt,
  pipelineStatus,
  running = false,
  onRun,
  startError,
  hideHealthBadge = false,
}: {
  snapshot?: PipelineAdvisorSnapshot;
  startedAt?: string;
  pipelineStatus?: ExecutionState['status'];
  running?: boolean;
  onRun?: () => void;
  startError?: string | null;
  hideHealthBadge?: boolean;
}): JSX.Element {
  const [selectedReportValue, setSelectedReportValue] = useState<string>(
    ADVISOR_LATEST_REPORT_VALUE,
  );

  useEffect(() => {
    setSelectedReportValue(ADVISOR_LATEST_REPORT_VALUE);
  }, [snapshot?.executionId]);

  if (!snapshot) {
    return (
      <div className="space-y-2">
        <p className="text-s fg-secondary">
          No advisor update is available yet.
        </p>
        {onRun ? (
          <AdvisorActionControl
            pipelineStatus={pipelineStatus}
            running={running}
            onRun={onRun}
          />
        ) : null}
        {startError ? <AdvisorStartErrorMessage message={startError} /> : null}
      </div>
    );
  }
  const reportHistory = getAdvisorReportHistory(snapshot);
  const latestReport =
    reportHistory.length > 0
      ? reportHistory[reportHistory.length - 1]
      : snapshot.latestReport;
  const selectedReport =
    selectedReportValue === ADVISOR_LATEST_REPORT_VALUE
      ? latestReport
      : (reportHistory.find(
          (entry) => getAdvisorReportSelectValue(entry) === selectedReportValue,
        ) ?? latestReport);
  const report = selectedReport;
  const effectiveSelectedReportValue =
    selectedReportValue === ADVISOR_LATEST_REPORT_VALUE ||
    reportHistory.some(
      (entry) => getAdvisorReportSelectValue(entry) === selectedReportValue,
    )
      ? selectedReportValue
      : ADVISOR_LATEST_REPORT_VALUE;
  const error = snapshot.lastError;
  const historyStartedAt = startedAt ?? snapshot.pipelineStartedAt;
  const errorIsStale =
    error !== undefined &&
    (!report ||
      new Date(error.at).getTime() > new Date(report.generatedAt).getTime());
  if (!report && errorIsStale && error) {
    return (
      <div className="space-y-2">
        <p className="text-s fg-warning">
          Advisor update failed: {error.message}
        </p>
        {onRun ? (
          <AdvisorActionControl
            snapshot={snapshot}
            pipelineStatus={pipelineStatus}
            running={running}
            onRun={onRun}
          />
        ) : null}
        {startError ? <AdvisorStartErrorMessage message={startError} /> : null}
      </div>
    );
  }
  if (!report) {
    return (
      <div className="space-y-2">
        <p className="text-s fg-secondary">Advisor update pending.</p>
        {onRun ? (
          <AdvisorActionControl
            snapshot={snapshot}
            pipelineStatus={pipelineStatus}
            running={running}
            onRun={onRun}
          />
        ) : null}
        {startError ? <AdvisorStartErrorMessage message={startError} /> : null}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <AdvisorReportContent
        report={report}
        reportHistory={reportHistory}
        selectedReportValue={effectiveSelectedReportValue}
        startedAt={historyStartedAt}
        onReportSelectionChange={setSelectedReportValue}
        hideHealthBadge={hideHealthBadge}
      />
      {errorIsStale && error ? (
        <p className="text-s fg-warning">
          Advisor update failed: {error.message}
        </p>
      ) : null}
      {startError ? <AdvisorStartErrorMessage message={startError} /> : null}
    </div>
  );
}

function AdvisorStartErrorMessage({
  message,
}: {
  message: string;
}): JSX.Element {
  return (
    <p className="text-s fg-warning">
      Failed to start Pipeline Advisor: {message}
    </p>
  );
}
