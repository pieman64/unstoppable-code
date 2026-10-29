interface ApprovedPlanMetaInput {
  reviewStatus: string | null;
  planVersion: number | null;
  implementationStartedAt: string;
}

/**
 * SSR-stable variant of {@link formatPlanDate}.
 *
 * `formatPlanDate` resolves against the ambient locale and time zone, which is
 * correct for client-fetched values but WRONG for a server-rendered one: the
 * server formats in the container's zone (UTC) and the browser re-formats in
 * the user's on hydration, so `2026-08-17T03:00:00Z` renders "Aug 17, 2026" on
 * the server and "Aug 16, 2026" in a US/Pacific browser. That is both a React
 * hydration text mismatch and a date that disagrees with the one the server
 * computed. Pinning locale + zone makes both passes produce the same string.
 */
export function formatPlanDateUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatPlanDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatApprovedPlanMeta(plan: ApprovedPlanMetaInput): string[] {
  const started = formatPlanDate(plan.implementationStartedAt);
  return [
    plan.reviewStatus,
    plan.planVersion !== null ? `v${plan.planVersion}` : null,
    started ? `Started ${started}` : null,
  ].filter((part): part is string => Boolean(part));
}
