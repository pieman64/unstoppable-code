import { useEffect, useRef, useState, type JSX } from 'react';
import type { MemoryDiagnosticsStatus } from '@canopy/desktop-shared/types';
import { Button, LoadingSpinner } from '@canopy/ui-shared/components';
import { describeMemoryReport } from '@/components/resource-diagnostics/format';
import { brandText } from '@/lib/brand';
import { pt } from '@/lib/platform-text';
import { uiText } from '@/lib/ui-text';
import { useMemoryReportStore } from '@/stores/memoryReportStore';
import { SettingsRow, SettingsSubRow } from './SettingsLayout';

interface MemoryReportRowProps {
  readonly enabled: boolean;
  /**
   * The switch's save has not committed yet. Main applies the preference to
   * the service on commit, so a report requested sooner would be refused.
   */
  readonly saving?: boolean;
}

/**
 * Starts a report through the shared flow, whose confirmation and progress
 * overlay are mounted at the app root, and shows the newest report.
 */
export function MemoryReportRow({
  enabled,
  saving = false,
}: MemoryReportRowProps): JSX.Element {
  const mountedRef = useRef(false);
  const initialStatusPromiseRef =
    useRef<Promise<MemoryDiagnosticsStatus> | null>(null);
  const lastReport = useMemoryReportStore((state) => state.lastReport);
  const setLastReport = useMemoryReportStore((state) => state.setLastReport);
  const reportBusy = useMemoryReportStore(
    (state) => state.checking || state.flow.phase !== 'idle',
  );
  const creatingReport = useMemoryReportStore(
    (state) => state.flow.phase === 'generating',
  );
  const requestReport = useMemoryReportStore((state) => state.request);
  const revealReport = useMemoryReportStore((state) => state.reveal);
  const [initialStatusLoading, setInitialStatusLoading] = useState(true);
  const [revealFailed, setRevealFailed] = useState(false);

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
  }, [setLastReport]);

  useEffect(() => {
    setRevealFailed(false);
  }, [lastReport]);

  const createButtonDisabled =
    !enabled || saving || initialStatusLoading || reportBusy;
  const description = enabled
    ? `Saves a snapshot of ${brandText.appName}'s memory use to help find memory problems`
    : 'Turn on Memory diagnostics to create a report';

  return (
    <SettingsRow
      label="Create memory report"
      description={description}
      control={
        <Button
          size="compact"
          variant="secondary"
          disabled={createButtonDisabled}
          aria-busy={creatingReport}
          data-testid="settings-create-memory-report"
          onClick={() => {
            void requestReport();
          }}
        >
          {creatingReport ? (
            <LoadingSpinner className="shrink-0" decorative />
          ) : null}
          {creatingReport ? 'Creating report…' : 'Create report'}
        </Button>
      }
    >
      {lastReport ? (
        <SettingsSubRow
          label={
            lastReport.kind === 'auto'
              ? 'Last automatic snapshot'
              : 'Last report'
          }
          description={
            revealFailed
              ? "Couldn't show the report. It may have been moved or deleted."
              : describeMemoryReport(lastReport)
          }
          dataTestId="settings-memory-report-result"
          control={
            <Button
              size="compact"
              variant="secondary"
              data-testid="settings-memory-report-reveal"
              onClick={() => {
                void revealReport(lastReport.reportId).then((revealed) => {
                  if (mountedRef.current) setRevealFailed(!revealed);
                });
              }}
            >
              {pt(uiText.fileManager.showItem)}
            </Button>
          }
        />
      ) : null}
    </SettingsRow>
  );
}
