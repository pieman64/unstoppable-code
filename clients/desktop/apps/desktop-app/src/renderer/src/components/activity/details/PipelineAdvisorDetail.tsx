import { useEffect, useState, type JSX } from 'react';
import { Stack, EmptyStateRow, Surface } from '@canopy/ui-shared/components';
import { formatTimingTimestamp } from '@/lib/pipelineTiming';
import type {
  ExecutionState,
  PipelineAdvisorReport,
  PipelineAdvisorSnapshot,
} from '@canopy/execution-engine/types/pipeline';
import { AgentAssistantIcon } from '@canopy/ui-shared/icons';
import { LoadingSpinner } from '../../shared/loading/spinners/LoadingSpinner';
import { RefreshSpinner } from '../../shared/loading/spinners/RefreshSpinner';
import {
  formatAdvisorEtaForModal,
  formatAdvisorReportEta as formatDynamicAdvisorReportEta,
  usePipelineAdvisorEtaNow,
} from '../PipelineAdvisorEta';
import { PipelineAdvisorMarkdownText } from '../PipelineAdvisorMarkdown';
import {
  advisorHealthBadgeTone,
  isPipelineExecutionActiveStatus,
} from '../utils';
import { SettingsSelect, Tooltip } from '@canopy/ui-shared';
import { Badge, Button, type BadgeTone } from '@canopy/ui-shared/components';

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
      ? 'Try workflow advisor again'
      : 'Run workflow advisor';
  return (
    <Button
      size="compact"
      disabled={running}
      onClick={onRun}
      data-testid="pipeline-detail-run-advisor"
    >
      <AgentAssistantIcon size="sm" className="fg-info" aria-hidden="true" />
      <span>{label}</span>
    </Button>
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
    ? 'Re-run Workflow Advisor'
    : 'Refresh Workflow Advisor';
  return (
    <Tooltip label={refreshLabel}>
      {showLabel ? (
        <Button
          size="compact"
          onClick={onRun}
          aria-label={refreshLabel}
          data-testid="pipeline-detail-refresh-advisor"
        >
          <RefreshSpinner size="sm" />
          <span>Refresh</span>
        </Button>
      ) : (
        <Button
          size="compact"
          iconOnly
          onClick={onRun}
          aria-label={refreshLabel}
          data-testid="pipeline-detail-refresh-advisor"
        >
          <RefreshSpinner size="sm" />
        </Button>
      )}
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
      <AgentAssistantIcon size="sm" className="fg-info" aria-hidden="true" />
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
      <div className="self-start">
        <AdvisorRunButton snapshot={snapshot} running={running} onRun={onRun} />
      </div>
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
  return (
    <div className="self-start">
      <AdvisorRefreshButton pipelineStatus={pipelineStatus} onRun={onRun} />
    </div>
  );
}

function severityBadgeTone(
  severity: 'info' | 'warning' | 'critical',
): BadgeTone {
  switch (severity) {
    case 'critical':
      return 'danger';
    case 'warning':
      return 'warning';
    case 'info':
    default:
      return 'info';
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
    <Stack gap="item">
      <div className="flex flex-wrap items-center gap-2">
        {hideHealthBadge ? null : (
          <Badge tone={advisorHealthBadgeTone(report.health.status)}>
            {report.health.status}
          </Badge>
        )}
        {report.eta.status !== 'complete' ? (
          <Badge>{formatDynamicAdvisorReportEta(report)}</Badge>
        ) : null}
        <span className="inline-flex items-center gap-1.5 text-2xs fg-secondary">
          Generated {formatTimingTimestamp(report.generatedAt)}
          {showHistorySelector ? (
            <SettingsSelect
              width="fit"
              aria-label="Workflow Advisor report history"
              data-testid="pipeline-advisor-report-selector"
              value={selectedReportValue}
              onValueChange={(next) => onReportSelectionChange?.(next)}
              options={reportHistory.map((historyReport, index) => ({
                value:
                  index === reportHistory.length - 1
                    ? ADVISOR_LATEST_REPORT_VALUE
                    : getAdvisorReportSelectValue(historyReport),
                label: getAdvisorReportHistoryLabel({
                  report: historyReport,
                  index,
                  total: reportHistory.length,
                  startedAt,
                }),
              }))}
            />
          ) : null}
        </span>
      </div>
      <Stack gap="tight">
        <div className="text-3xs font-medium fg-secondary/70">Health</div>
        <div className="text-s fg-primary/85">
          <PipelineAdvisorMarkdownText>
            {report.health.summary}
          </PipelineAdvisorMarkdownText>
        </div>
      </Stack>
      <Stack gap="tight">
        <div className="text-3xs font-medium fg-secondary/70">Evidence</div>
        {evidence.length === 0 ? (
          <p className="text-s fg-secondary">No evidence recorded.</p>
        ) : (
          <ul className="flex flex-col list-disc pl-5 text-s fg-primary/85 gap-0.5">
            {evidence.map((entry, index) => (
              <li key={index} className="break-words">
                <PipelineAdvisorMarkdownText>
                  {entry}
                </PipelineAdvisorMarkdownText>
              </li>
            ))}
          </ul>
        )}
      </Stack>
      <Stack gap="tight">
        <div className="text-3xs font-medium fg-secondary/70">
          Inefficiencies
        </div>
        {inefficiencies.length === 0 ? (
          <p className="text-s fg-secondary">No inefficiencies flagged.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {inefficiencies.map((item, index) => (
              <Surface
                as="li"
                variant="group"
                size="small"
                key={`${item.title}-${index}`}
              >
                <div className="flex flex-col px-3 py-2 gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={severityBadgeTone(item.severity)}>
                      {severityLabelForModal(item.severity)}
                    </Badge>
                    <PipelineAdvisorMarkdownText className="text-s font-medium fg-primary/85">
                      {item.title}
                    </PipelineAdvisorMarkdownText>
                  </div>
                  <div className="text-s fg-primary/80">
                    <PipelineAdvisorMarkdownText>
                      {item.evidence}
                    </PipelineAdvisorMarkdownText>
                  </div>
                  {item.recommendation && (
                    <div className="text-s fg-primary/70">
                      <span>Recommendation: </span>
                      <PipelineAdvisorMarkdownText>
                        {item.recommendation}
                      </PipelineAdvisorMarkdownText>
                    </div>
                  )}
                </div>
              </Surface>
            ))}
          </ul>
        )}
      </Stack>
      <Stack gap="tight">
        <div className="text-3xs font-medium fg-secondary/70">Summary</div>
        <div className="text-s fg-primary/85">
          <PipelineAdvisorMarkdownText>
            {report.summary}
          </PipelineAdvisorMarkdownText>
        </div>
      </Stack>
      <Stack gap="tight">
        <div className="text-3xs font-medium fg-secondary/70">
          Recommendations
        </div>
        {recommendations.length === 0 ? (
          <p className="text-s fg-secondary">No recommendations.</p>
        ) : (
          <ul className="flex flex-col list-disc pl-5 text-s fg-primary/85 gap-0.5">
            {recommendations.map((entry, index) => (
              <li key={index} className="break-words">
                <PipelineAdvisorMarkdownText>
                  {entry}
                </PipelineAdvisorMarkdownText>
              </li>
            ))}
          </ul>
        )}
      </Stack>
    </Stack>
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
      <Stack gap="inline">
        <EmptyStateRow title="No advisor update is available yet." />
        {onRun ? (
          <AdvisorActionControl
            pipelineStatus={pipelineStatus}
            running={running}
            onRun={onRun}
          />
        ) : null}
        {startError ? <AdvisorStartErrorMessage message={startError} /> : null}
      </Stack>
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
      <Stack gap="inline">
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
      </Stack>
    );
  }
  if (!report) {
    return (
      <Stack gap="inline">
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
      </Stack>
    );
  }
  return (
    <Stack gap="item">
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
    </Stack>
  );
}

function AdvisorStartErrorMessage({
  message,
}: {
  message: string;
}): JSX.Element {
  return (
    <p className="text-s fg-warning">
      Failed to start Workflow Advisor: {message}
    </p>
  );
}
