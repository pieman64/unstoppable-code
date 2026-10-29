import { useEffect, useRef, useState, type JSX } from 'react';
import type {
  CreateMemoryReportFailureReason,
  CreateMemoryReportResult,
  MemoryDiagnosticsStatus,
  MemoryReportSummary,
} from '@canopy/desktop-shared/types';
import {
  Button,
  ConfirmDialog,
  LoadingSpinner,
} from '@canopy/ui-shared/components';
import { formatMemoryBytes } from '@/components/resource-diagnostics/format';
import { useSettingsButtonSize } from '@/hooks/useSettingsButtonSize';
import { brandText } from '@/lib/brand';
import { pt } from '@/lib/platform-text';
import { uiText } from '@/lib/ui-text';
import { SettingsRow, SettingsSubRow } from './SettingsLayout';

const CREATE_REPORT_FAILURE_COPY: Record<
  CreateMemoryReportFailureReason,
  string
> = {
  disabled:
    "Couldn't create the report because memory diagnostics are off. Turn on Memory diagnostics and try again.",
  'in-progress':
    "Couldn't start a report because another one is still being saved. Wait for it to finish, then try again.",
  'insufficient-disk':
    "Couldn't create the report because there isn't enough free disk space. Free up some space and try again.",
  failed: "Couldn't create the memory report. Try again.",
};

type MemoryReportResultState =
  | {
      readonly type: 'failure';
      readonly reason: CreateMemoryReportFailureReason;
    }
  | { readonly type: 'reveal-failure' }
  | null;

interface MemoryReportRowProps {
  readonly enabled: boolean;
  /**
   * The switch's save has not committed yet. Main applies the preference to
   * the service on commit, so a report requested sooner would be refused.
   */
  readonly saving?: boolean;
}

function formatReportEstimate(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  if (seconds < 2) {
    return 'about 1 second';
  }
  if (seconds < 60) {
    return `about ${Math.round(seconds)} seconds`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? 'about 1 minute' : `about ${minutes} minutes`;
}

function formatReportDate(createdAt: string): string | null {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function reportDescription(report: MemoryReportSummary): string {
  const size = formatMemoryBytes(report.totalBytes);
  const formattedDate = formatReportDate(report.createdAt);
  return formattedDate ? `${size}, saved ${formattedDate}` : size;
}

export function MemoryReportRow({
  enabled,
  saving = false,
}: MemoryReportRowProps): JSX.Element {
  const buttonSize = useSettingsButtonSize();
  const mountedRef = useRef(false);
  const initialStatusPromiseRef =
    useRef<Promise<MemoryDiagnosticsStatus> | null>(null);
  const [lastReport, setLastReport] = useState<MemoryReportSummary | null>(
    null,
  );
  const [initialStatusLoading, setInitialStatusLoading] = useState(true);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [creatingReport, setCreatingReport] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    readonly estimate: string | null;
  } | null>(null);
  const [result, setResult] = useState<MemoryReportResultState>(null);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    let statusPromise = initialStatusPromiseRef.current;
    if (statusPromise === null) {
      statusPromise = window.api.memoryDiagnostics.getStatus();
      initialStatusPromiseRef.current = statusPromise;
    }

    void statusPromise
      .then((status) => {
        if (active) {
          setLastReport(status.lastReport);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) {
          setInitialStatusLoading(false);
        }
      });

    return (): void => {
      active = false;
      mountedRef.current = false;
    };
  }, []);

  async function checkStatusBeforeCreate(): Promise<void> {
    setResult(null);
    setCheckingStatus(true);
    try {
      const status = await window.api.memoryDiagnostics.getStatus();
      if (!mountedRef.current) {
        return;
      }
      if (status.reportInProgress) {
        setResult({ type: 'failure', reason: 'in-progress' });
        return;
      }
      if (!status.enabled) {
        setResult({ type: 'failure', reason: 'disabled' });
        return;
      }
      setConfirmation({
        estimate: formatReportEstimate(status.estimatedReportSeconds),
      });
    } catch {
      if (mountedRef.current) {
        setConfirmation({ estimate: null });
      }
    } finally {
      if (mountedRef.current) {
        setCheckingStatus(false);
      }
    }
  }

  async function createReport(): Promise<void> {
    try {
      const response: CreateMemoryReportResult =
        await window.api.memoryDiagnostics.createReport();
      if (!mountedRef.current) {
        return;
      }
      if (response.ok) {
        setLastReport(response.report);
        setResult(null);
      } else {
        setResult({ type: 'failure', reason: response.reason });
      }
    } catch {
      if (mountedRef.current) {
        setResult({ type: 'failure', reason: 'failed' });
      }
    } finally {
      if (mountedRef.current) {
        setCreatingReport(false);
      }
    }
  }

  async function revealReport(reportId: string): Promise<void> {
    try {
      const revealed =
        await window.api.memoryDiagnostics.revealReport(reportId);
      if (mountedRef.current) {
        setResult(revealed ? null : { type: 'reveal-failure' });
      }
    } catch {
      if (mountedRef.current) {
        setResult({ type: 'reveal-failure' });
      }
    }
  }

  const createButtonDisabled =
    !enabled ||
    saving ||
    initialStatusLoading ||
    checkingStatus ||
    creatingReport;
  const description = enabled
    ? `Saves a snapshot of ${brandText.appName}'s memory use to help find memory problems`
    : 'Turn on Memory diagnostics to create a report';
  const failureMessage =
    result?.type === 'failure'
      ? CREATE_REPORT_FAILURE_COPY[result.reason]
      : null;
  const revealFailureMessage =
    result?.type === 'reveal-failure'
      ? "Couldn't show the report. It may have been moved or deleted."
      : null;
  const dialogMessage =
    confirmation?.estimate === null
      ? `${brandText.appName} will stop responding until the report is saved. Reports can contain chat and file content, so share them only with people you trust.`
      : confirmation
        ? `${brandText.appName} will stop responding for ${confirmation.estimate} while it saves the report. Reports can contain chat and file content, so share them only with people you trust.`
        : '';

  return (
    <>
      <SettingsRow
        label="Create memory report"
        description={description}
        control={
          <Button
            size={buttonSize}
            variant="secondary"
            disabled={createButtonDisabled}
            aria-busy={creatingReport}
            data-testid="settings-create-memory-report"
            onClick={() => {
              void checkStatusBeforeCreate();
            }}
          >
            {creatingReport ? (
              <LoadingSpinner className="shrink-0" decorative />
            ) : null}
            {creatingReport ? 'Creating report…' : 'Create report'}
          </Button>
        }
      >
        {failureMessage ? (
          <SettingsSubRow
            label="Report not created"
            dataTestId="settings-memory-report-result"
          >
            <div className="text-xs fg-destructive" role="alert">
              {failureMessage}
            </div>
          </SettingsSubRow>
        ) : lastReport ? (
          <SettingsSubRow
            label={
              lastReport.kind === 'auto'
                ? 'Last automatic snapshot'
                : 'Last report'
            }
            description={revealFailureMessage ?? reportDescription(lastReport)}
            dataTestId="settings-memory-report-result"
            control={
              <Button
                size={buttonSize}
                variant="secondary"
                data-testid="settings-memory-report-reveal"
                onClick={() => {
                  void revealReport(lastReport.reportId);
                }}
              >
                {pt(uiText.fileManager.showItem)}
              </Button>
            }
          />
        ) : null}
      </SettingsRow>
      {confirmation ? (
        <ConfirmDialog
          title="Create a memory report?"
          message={dialogMessage}
          confirmLabel="Create report"
          confirmTestId="settings-memory-report-confirm"
          dataTestId="settings-memory-report-dialog"
          focusCancel
          onConfirm={() => {
            setConfirmation(null);
            setCreatingReport(true);
            void createReport();
          }}
          onCancel={() => {
            setConfirmation(null);
          }}
        />
      ) : null}
    </>
  );
}
