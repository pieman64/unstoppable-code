import type { JSX } from 'react';
import {
  BillingHistoryTable,
  Button,
  DelayedLoadingPlaceholder,
  Skeleton,
  type BillingHistoryCharge,
} from '@canopy/ui-shared/components';

/**
 * Loading states for the billing cards whose titles are already on screen
 * while their figures load. Each renders the card body's own markup with
 * sample figures inside `Skeleton`, so skullet measures it into bars and the
 * loaded body replaces the skeleton in place. The card's own chrome holds
 * the shape, so there is no second border. The samples never show: skullet
 * draws over them, unseen and inert. The bodies' live parts (payment slots,
 * the payment-area handoff) need services a skeleton must not reach, so the
 * samples repeat their markup rather than mounting them.
 */

const noop = (): void => undefined;

const sampleDate = (iso: string): string => iso.slice(0, 10);

const SAMPLE_PLAN = {
  description: 'Your plan and next payment.',
  nextBilling: 'Next billing: $20.00 on 2027-01-01',
} as const;

const SAMPLE_CREDITS = {
  balance: '1,250 credits',
  used: '300 credits used this month',
} as const;

const SAMPLE_CHARGES: BillingHistoryCharge[] = [
  {
    id: 'sample-charge-1',
    kind: 'SUBSCRIPTION',
    status: 'SUCCEEDED',
    amountUsd: 20,
    description: 'Subscription',
    cardBrand: 'visa',
    cardLast4: '4242',
    createdAt: '2027-01-01T00:00:00.000Z',
  },
  {
    id: 'sample-charge-2',
    kind: 'CREDITS',
    status: 'SUCCEEDED',
    amountUsd: 10,
    description: 'Credits',
    cardBrand: 'visa',
    cardLast4: '4242',
    createdAt: '2026-12-01T00:00:00.000Z',
  },
];

/** What a billing card's body holds once loaded. */
export type BillingCardBody = 'plan' | 'credits';

function SampleBody({ body }: { readonly body: BillingCardBody }): JSX.Element {
  if (body === 'plan') {
    return (
      <div className="flex flex-col gap-2 pt-1">
        <p className="text-xs fg-secondary">{SAMPLE_PLAN.description}</p>
        <p className="text-s fg-secondary">{SAMPLE_PLAN.nextBilling}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-lg font-semibold fg-primary">
            {SAMPLE_CREDITS.balance}
          </p>
        </div>
        <Button size="compact" variant="secondary" onClick={noop}>
          Buy credits
        </Button>
      </div>
      <p className="text-xs fg-secondary">{SAMPLE_CREDITS.used}</p>
    </div>
  );
}

/**
 * The body of a billing card while its figures load: the plan's description
 * and next-billing lines below the plan heading, or the credits balance, its
 * top-up button and the usage line. Announces "Loading" to assistive
 * technology only, and shows only after the shared delay.
 */
export function BillingCardBodySkeleton({
  body,
}: {
  readonly body: BillingCardBody;
}): JSX.Element {
  return (
    <DelayedLoadingPlaceholder>
      <Skeleton loading testId="settings-skeleton-card-body">
        <SampleBody body={body} />
      </Skeleton>
    </DelayedLoadingPlaceholder>
  );
}

/** The transactions table while the first page of charges loads. */
export function BillingTransactionsSkeleton(): JSX.Element {
  return (
    <DelayedLoadingPlaceholder>
      <Skeleton
        loading
        label="Loading transactions"
        testId="settings-skeleton-table"
      >
        <div className="flex flex-col gap-2">
          <p className="text-s font-medium fg-primary">Transactions</p>
          <BillingHistoryTable
            charges={SAMPLE_CHARGES}
            formatDate={sampleDate}
          />
        </div>
      </Skeleton>
    </DelayedLoadingPlaceholder>
  );
}
