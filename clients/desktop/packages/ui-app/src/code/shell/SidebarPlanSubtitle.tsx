import type { HTMLAttributes, JSX } from 'react';

/**
 * The account row's plan line, shared by the desktop sidebar and the web
 * portal so both paint the same thing: muted text under the name, a small
 * outlined pill only while a trial is active, and a skeleton that reserves the
 * line while entitlements load. Hosts map their own plan source onto it
 * (desktop's subscription hook, web's billing chrome).
 */
export interface SidebarPlanSubtitleProps {
  /** Plan display name; `null` with `loading` false renders nothing. */
  readonly label: string | null;
  readonly trial?: boolean;
  readonly loading?: boolean;
}

const PLAN_PILL_CLASS_NAME =
  'inline-flex h-4 shrink-0 items-center rounded-full ring-[length:var(--border-hairline)] ring-inset ring-line-accent px-1.5 text-3xs font-medium leading-none fg-accent';

/**
 * The small outlined accent pill this row uses, as a primitive.
 *
 * Extracted so a surface that needs the same chip around DIFFERENT copy — the
 * web account menu puts the trial countdown in one — reuses the treatment
 * instead of copying the class list and drifting from it.
 *
 * Accessibility is the CALLER's call, which is why `aria-hidden` is not baked
 * in: {@link SidebarTrialPill} hides itself because "Trial" merely restates
 * what the row's own accessible label already says, while a pill carrying the
 * days remaining is information found nowhere else and must stay readable.
 */
export function SidebarPlanPill({
  className = '',
  ...props
}: HTMLAttributes<HTMLSpanElement>): JSX.Element {
  return (
    <span
      className={`${PLAN_PILL_CLASS_NAME}${className ? ` ${className}` : ''}`}
      {...props}
    />
  );
}

export function SidebarTrialPill(): JSX.Element {
  return (
    <SidebarPlanPill
      aria-hidden="true"
      data-testid="sidebar-subscription-trial-pill"
    >
      Trial
    </SidebarPlanPill>
  );
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
      {!loading && trial ? <SidebarTrialPill /> : null}
    </span>
  );
}
