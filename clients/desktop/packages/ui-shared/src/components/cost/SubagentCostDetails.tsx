import type { JSX } from 'react';
import type { CostAttributedItem } from '@canopy/protocol/cost-view';
import { formatTokenCount } from '../../lib/format-usage';
import { HeaderActionButton } from '../HeaderActionButton';
import { CostObservedTotal } from './CostObservedTotal';
import { ProxyAccountNames } from './ProxyAccounts';
import {
  COST_BILLING_LABELS,
  formatCostAmount,
  isCostItemPending,
  unpricedCostItemLabel,
} from './cost-format';

export interface SubagentCostDetailsProps {
  /** The subagent's or delegate's cost row (`core.cost.chat.get` with a `subagentId`). */
  readonly item: CostAttributedItem;
  /** Opens the root chat's Session breakdown; omit to hide the action. */
  readonly onOpenSessionBreakdown?: () => void;
  readonly testId?: string;
}

function paidByLabel(item: CostAttributedItem): string {
  const label = COST_BILLING_LABELS[item.billingBasis];
  if (isCostItemPending(item)) return label;
  if (item.costStatus === 'not_priced') return `${label}, not priced`;
  // The proxy reports no price, so its amount is always an estimate.
  if (
    item.costStatus === 'estimated' ||
    item.costStatus === 'partial' ||
    item.billingBasis === 'account_proxy'
  ) {
    return `${label}, estimated at API prices`;
  }
  return label;
}

function DetailRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): JSX.Element {
  return (
    <>
      <dt className="fg-tertiary">{label}</dt>
      <dd className="min-w-0 break-words tabular-nums fg-primary">{value}</dd>
    </>
  );
}

/** Pure display details for one subagent or managed delegation cost row. */
export function SubagentCostDetails({
  item,
  onOpenSessionBreakdown,
  testId = 'subagent-cost-details',
}: SubagentCostDetailsProps): JSX.Element {
  const totalTokens = item.totalTokens;
  const amountLabel =
    item.usd === undefined
      ? unpricedCostItemLabel(item)
      : formatCostAmount(item.usd);

  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-2">
      <CostObservedTotal
        size="inline"
        amountLabel={amountLabel}
        testId={`${testId}-total`}
      />
      {item.inclusion === 'included' ? (
        <p data-testid={`${testId}-included`} className="text-xs fg-tertiary">
          Part of the cost of the chat turn that started it.
        </p>
      ) : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        {totalTokens === undefined ? (
          <>
            <DetailRow
              label="Input"
              value={formatTokenCount(item.tokens.input)}
            />
            <DetailRow
              label="Output"
              value={formatTokenCount(item.tokens.output)}
            />
            <DetailRow
              label="Cache read"
              value={formatTokenCount(item.tokens.cacheReadInputTokens)}
            />
          </>
        ) : (
          <DetailRow label="Tokens" value={formatTokenCount(totalTokens)} />
        )}
        <DetailRow label="Paid by" value={paidByLabel(item)} />
        {item.proxyAccounts !== undefined && item.proxyAccounts.length > 0 ? (
          <>
            <dt className="fg-tertiary">Account</dt>
            <dd className="flex min-w-0 fg-primary">
              <ProxyAccountNames
                accounts={item.proxyAccounts}
                testId={`${testId}-account`}
              />
            </dd>
          </>
        ) : null}
        {item.kind === 'delegation' && item.runCount !== undefined ? (
          <DetailRow
            label="Runs"
            value={`${item.runCount} ${item.runCount === 1 ? 'run' : 'runs'}`}
          />
        ) : null}
      </dl>
      {onOpenSessionBreakdown ? (
        <div>
          <HeaderActionButton
            type="button"
            tone="neutral"
            data-testid={`${testId}-open-breakdown`}
            onClick={onOpenSessionBreakdown}
          >
            Session breakdown
          </HeaderActionButton>
        </div>
      ) : null}
    </div>
  );
}
