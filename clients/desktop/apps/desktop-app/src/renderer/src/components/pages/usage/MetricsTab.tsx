import { type JSX, useEffect, useState } from 'react';
import type { UsageTabSummaryResponse } from '@canopy/desktop-shared/types';
import { ChevronRightIcon, InfoIcon } from '@canopy/ui-shared/icons';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useEarlyAccessTitle } from '@/lib/earlyAccessTitles';
import { RefreshSpinner } from '@/components/shared/loading';
import { ErrorBanner } from '@canopy/ui-shared/components';
import type { TabSpec } from './tab-specs';
import { HeadlineCardRow } from './HeadlineCardRow';
import { MetricsChart } from './MetricsChart';
import { MetricsBreakdownPanel } from './MetricsBreakdownPanel';

interface MetricsTabProps {
  spec: TabSpec;
  retentionDays: number;
}

export function MetricsTab({
  spec,
  retentionDays,
}: MetricsTabProps): JSX.Element {
  const title = useEarlyAccessTitle(spec.title);
  const loadUsageTabSummary = useObservabilityStore(
    (s) => s.loadUsageTabSummary,
  );
  const [summary, setSummary] = useState<UsageTabSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noticeExpanded, setNoticeExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setError(null);
    loadUsageTabSummary({ tab: spec.id })
      .then((response) => {
        if (cancelled) return;
        setSummary(response);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(
          reason instanceof Error ? reason.message : 'Failed to load summary',
        );
      });
    return (): void => {
      cancelled = true;
    };
  }, [spec.id, loadUsageTabSummary]);

  return (
    <section className="space-y-4" data-testid={`usage-metrics-tab-${spec.id}`}>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold fg-primary">{title}</h2>
        {spec.subtitle && (
          <p className="max-w-3xl text-s fg-secondary">{spec.subtitle}</p>
        )}
      </div>
      {spec.notice && (
        <div
          className="rounded-md border bg-muted/40 px-4 py-3 text-s"
          role="note"
        >
          <button
            type="button"
            className="focus-ring flex w-full items-center gap-2 text-left font-medium fg-primary transition-colors hover:fg-primary/80"
            aria-expanded={noticeExpanded}
            aria-controls={`usage-metrics-notice-${spec.id}`}
            onClick={(): void => setNoticeExpanded((expanded) => !expanded)}
          >
            <InfoIcon
              className="h-3.5 w-3.5 shrink-0 fg-secondary"
              aria-hidden="true"
            />
            <span>{spec.notice.title}</span>
            <ChevronRightIcon
              className={`ml-auto h-3 w-3 shrink-0 fg-secondary transition-transform ${
                noticeExpanded ? 'rotate-90' : ''
              }`}
              aria-hidden="true"
            />
          </button>
          {noticeExpanded && (
            <p
              id={`usage-metrics-notice-${spec.id}`}
              className="mt-1 max-w-3xl fg-secondary"
            >
              {spec.notice.body}
            </p>
          )}
        </div>
      )}
      {error && <ErrorBanner error={error} className="" />}
      {summary === null ? (
        <div className="flex items-center gap-2 rounded-xl border bg-card/60 px-4 py-3 text-s fg-secondary">
          <RefreshSpinner spinning size={14} />
          <span>Loading summary…</span>
        </div>
      ) : (
        <HeadlineCardRow specs={spec.cards} summary={summary} />
      )}
      <MetricsChart spec={spec} retentionDays={retentionDays} />
      <MetricsBreakdownPanel spec={spec} />
    </section>
  );
}
