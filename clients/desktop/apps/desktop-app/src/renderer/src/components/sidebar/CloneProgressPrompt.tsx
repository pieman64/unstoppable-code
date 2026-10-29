import { useMemo, type JSX } from 'react';
import { CheckIcon, WarningIcon } from '@canopy/ui-shared/icons/AppIcons';
import { LoadingSpinner } from '@/components/shared/loading';
import { summarizeCloneJobs, useCloneJobsStore } from '@/stores/cloneJobsStore';
import {
  SidebarFooterBanner,
  SidebarFooterBannerIcon,
} from './SidebarFooterBanner';

/**
 * Sidebar pill for Add project clones that outlived the dialog's short
 * foreground window. Opens the clone progress dialog.
 */
export function CloneProgressPrompt(): JSX.Element | null {
  const jobs = useCloneJobsStore((state) => state.jobs);
  const open = useCloneJobsStore((state) => state.open);
  const summary = useMemo(() => summarizeCloneJobs(jobs), [jobs]);
  if (!summary) return null;
  const showPercent = summary.failed === 0 && summary.percent !== null;
  return (
    <SidebarFooterBanner
      testId="clone-progress-sidebar"
      onClick={open}
      ariaLabel={`Open clone progress: ${summary.label}${
        showPercent ? `, ${summary.percent}%` : ''
      }`}
      surface="status"
    >
      {/* The glyph carries the state, as on the update banner; the label
          stays primary and starts on the same edge as every other banner. */}
      <SidebarFooterBannerIcon
        tone={
          summary.failed > 0
            ? 'destructive'
            : summary.running > 0
              ? 'accent'
              : 'secondary'
        }
      >
        {summary.failed > 0 ? (
          <WarningIcon size={16} aria-hidden="true" />
        ) : summary.running > 0 ? (
          <LoadingSpinner tone="accent" />
        ) : (
          <CheckIcon size={16} aria-hidden="true" />
        )}
      </SidebarFooterBannerIcon>
      <span className="min-w-0 flex-1 truncate">{summary.label}</span>
      {showPercent && (
        <span
          data-testid="clone-progress-percent"
          className="text-2xs tabular-nums fg-primary"
        >
          {summary.percent}%
        </span>
      )}
    </SidebarFooterBanner>
  );
}
