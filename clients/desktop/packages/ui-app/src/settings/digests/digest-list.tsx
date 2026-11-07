'use client';

import type { JSX } from 'react';
import { Badge } from '@canopy/ui-shared/components';
import { SettingsLink, useSettingsPrivacy } from '../host';
import { joinClassNames } from './digest-class-names';
import {
  cadenceLabel,
  formatCredits,
  formatDigestPeriod,
} from './digest-format';
import { Surface } from '@canopy/ui-shared/components';

export interface DigestListItem {
  externalId: string;
  cadence: string;
  periodStart: string;
  periodEnd: string;
  headline: string | null;
  variant: string;
  /**
   * Prisma `DigestStatus`. Always `READY` for scheduled cadences; on-demand
   * rows also surface while `PENDING`/`GENERATING`/`SKIPPED_EMPTY`/`FAILED` so
   * a user who just requested one can see it exists.
   */
  status: string;
  createdAt: string;
  /**
   * AI credits this report has been billed so far, or null when nothing has
   * been debited yet (not generated, deterministic narrative, or a gateway
   * response that carried no cost). Null renders nothing rather than "0
   * credits", which would read as a claim that the report was free.
   *
   * Cumulative across generation attempts: a report that needed a retry is
   * billed per attempt that reached the gateway, and this is the total.
   */
  billedCredits: number | null;
}

/**
 * Only `READY` rows have a detail page — `getUserDigest`/`getOrgDigest` stay
 * READY-only, so linking a pending row would navigate straight into a 404.
 */
function isReadable(status: string): boolean {
  return status === 'READY';
}

const PENDING_STATUS_COPY: Readonly<Record<string, string>> = {
  PENDING:
    'Queued — starting shortly. We’ll update this page and email you when it’s ready.',
  SKIPPED_EMPTY: 'No activity found in this range.',
  FAILED:
    'We couldn’t generate this digest. Request this range again to retry.',
};

function statusCopy(status: string, createdAt: string): string {
  if (status === 'GENERATING') {
    const ageMs = Date.now() - new Date(createdAt).getTime();
    return ageMs >= 2 * 60 * 1_000
      ? 'Still generating — this is taking longer than usual, but you don’t need to retry. We’ll update this page and email you when it’s ready.'
      : 'Generating your digest…';
  }
  return PENDING_STATUS_COPY[status] ?? 'Not available yet.';
}

interface DigestListProps {
  digests: readonly DigestListItem[];
  /** Path each row links into; the digest's external id is appended. */
  basePath: string;
  /** Copy shown when the subject has no READY digests yet. */
  emptyMessage: string;
}

/**
 * Display-only list of a subject's generated digests. The pages load the rows
 * through the read service; nothing here is interactive beyond navigation.
 * Links go through the host link so desktop keeps them inside Settings.
 */
export function DigestList({
  digests,
  basePath,
  emptyMessage,
}: DigestListProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  if (digests.length === 0) {
    return (
      <Surface variant="raised">
        <p className="p-5 text-s fg-secondary">{emptyMessage}</p>
      </Surface>
    );
  }

  return (
    <ul className="flex flex-col gap-3" data-testid="digest-list">
      {digests.map((digest) => {
        const body = (
          <>
            <div className="flex items-center gap-2 text-xs fg-secondary">
              <span>{cadenceLabel(digest.cadence)}</span>
              <span aria-hidden="true">·</span>
              <span>
                {formatDigestPeriod(digest.periodStart, digest.periodEnd)}
              </span>
              {digest.billedCredits !== null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span
                    data-testid={`digest-list-item-cost-${digest.externalId}`}
                  >
                    {formatCredits(digest.billedCredits)}
                  </span>
                </>
              )}
            </div>
            <p
              className={joinClassNames(
                'mt-1 text-s font-medium fg-primary',
                blockClassName,
              )}
            >
              {digest.headline ?? 'Work digest'}
            </p>
            {digest.variant === 'NUDGE' && (
              <Badge className="mt-2">Quiet period</Badge>
            )}
            {!isReadable(digest.status) && (
              <p className="mt-2 text-xs fg-secondary">
                {statusCopy(digest.status, digest.createdAt)}
              </p>
            )}
          </>
        );
        return (
          <li key={digest.externalId}>
            {isReadable(digest.status) ? (
              <SettingsLink
                href={`${basePath}/${digest.externalId}`}
                data-testid={`digest-list-item-${digest.externalId}`}
                className="block rounded-xl bg-card p-4 shadow-sm transition-colors hover:bg-accent-subtle"
              >
                {body}
              </SettingsLink>
            ) : (
              <div className="opacity-80">
                <Surface
                  variant="raised"
                  padding="default"
                  data-testid={`digest-list-item-${digest.externalId}`}
                  data-digest-status={digest.status}
                >
                  {body}
                </Surface>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
