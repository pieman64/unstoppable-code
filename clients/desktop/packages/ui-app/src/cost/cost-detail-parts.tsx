import type { JSX, ReactNode } from 'react';
import type { CostTotals } from '@canopy/protocol/cost-view';
import {
  CostLegend,
  CostSplitBar,
  costBillingSegments,
} from '@canopy/ui-shared/components/cost';

export interface CostDetailSectionProps {
  readonly title: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
  readonly testId?: string;
}

/** A sentence-case section heading with an optional tabular value. */
export function CostDetailSection({
  title,
  aside,
  children,
  testId,
}: CostDetailSectionProps): JSX.Element {
  return (
    <section data-testid={testId} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium fg-primary">{title}</h3>
        {aside !== undefined ? (
          <span className="shrink-0 text-right text-xs tabular-nums fg-secondary">
            {aside}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export interface CostValueRowProps {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
}

/** A compact definition-list row for a labeled cost or usage value. */
export function CostValueRow({
  label,
  value,
  note,
}: CostValueRowProps): JSX.Element {
  return (
    <div className="flex items-baseline gap-3 text-xs">
      <dt className="fg-secondary">{label}</dt>
      {note !== undefined ? (
        <span className="tabular-nums fg-tertiary">{note}</span>
      ) : null}
      <dd className="ml-auto tabular-nums fg-primary">{value}</dd>
    </div>
  );
}

/**
 * The shared estimate qualification for plan-covered and AI Credits usage,
 * and account proxy usage when there is some.
 */
export function CostEstimateNote({
  includesAccountProxy = false,
}: {
  readonly includesAccountProxy?: boolean;
} = {}): JSX.Element {
  return (
    <p className="text-xs fg-tertiary">
      {includesAccountProxy
        ? 'Subscription, AI Credits and account proxy amounts are estimates at API prices, not charges.'
        : 'Subscription and AI Credits amounts are estimates at API prices, not charges.'}
    </p>
  );
}

type CostBillingSectionProps =
  | {
      readonly totals: Pick<CostTotals, 'byBilling'>;
      readonly label: string;
    }
  | {
      readonly byBilling: CostTotals['byBilling'];
      readonly label: string;
    };

/** The shared billing split and its API-price estimate note. */
export function CostBillingSection(
  props: CostBillingSectionProps,
): JSX.Element {
  const byBilling =
    'totals' in props ? props.totals.byBilling : props.byBilling;
  const segments = costBillingSegments(byBilling);

  return (
    <CostDetailSection title="How it was paid">
      <CostSplitBar segments={segments} label={props.label} size="summary" />
      <CostLegend segments={segments} showShare />
      <CostEstimateNote includesAccountProxy={byBilling.account_proxy > 0} />
    </CostDetailSection>
  );
}
