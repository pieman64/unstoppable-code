import type { JSX } from 'react';
import { SidebarTrialBadge } from '@canopy/ui-shared/components/SidebarTrialBadge';

/**
 * The account row's plan line, shared by the desktop sidebar and the web
 * portal so both paint the same thing: muted text under the name, a small
 * warning badge only while a trial is active (a trial runs out), and a skeleton that reserves the
 * line while entitlements load. Hosts map their own plan source onto it
 * (desktop's subscription hook, web's billing chrome).
 */
export interface SidebarPlanSubtitleProps {
  /** Plan display name; `null` with `loading` false renders nothing. */
  readonly label: string | null;
  readonly trial?: boolean;
  readonly loading?: boolean;
}

/** The accessible plan text, shared with the row's own aria-label. */
export function sidebarPlanLabel(
  label: string,
  trial: boolean | undefined,
): string {
  return `${label} plan${trial ? ', trial active' : ''}`;
}

export function SidebarPlanSubtitle({
  label,
  trial = false,
  loading = false,
}: SidebarPlanSubtitleProps): JSX.Element | null {
  if (!loading && label === null) return null;
  return (
    <span
      data-testid="sidebar-subscription-plan-subtitle"
      aria-busy={loading}
      aria-label={
        loading || label === null
          ? 'Loading account plan'
          : sidebarPlanLabel(label, trial)
      }
      aria-live="polite"
      className="relative mt-0 flex h-4 min-w-0 items-center gap-1.5 text-2xs font-normal leading-4 fg-tertiary"
    >
      {loading || label === null ? (
        <span
          aria-hidden="true"
          data-testid="sidebar-subscription-plan-skeleton"
          className="sidebar-icon-skeleton h-2 w-12 rounded"
        />
      ) : (
        <span
          aria-hidden="true"
          data-testid="sidebar-subscription-plan-tier"
          className="block min-w-0 truncate whitespace-nowrap"
          title={label}
        >
          {label}
        </span>
      )}
      {!loading && trial ? <SidebarTrialBadge /> : null}
    </span>
  );
}
