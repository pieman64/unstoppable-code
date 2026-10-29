'use client';

import { useId, useState, type JSX } from 'react';
import type { CostSource } from '@canopy/protocol/cost-view';
import {
  USAGE_DISCLOSURE_INK_CLASS,
  USAGE_DISCLOSURE_ROW_CLASS,
  UsageDisclosureChevron,
} from '../UsageIndicator';
import { CostLegend } from './CostLegend';
import { CostSplitBar } from './CostSplitBar';
import { costSourceSegments, formatCostTotal } from './cost-format';

/** The chat's stored cost row (`core.cost.chat.get`, detail `summary`). */
export interface UsageCostPreview {
  readonly usd: number;
  readonly notPricedCount: number;
  readonly bySource: Readonly<Record<CostSource, number>>;
}

/**
 * The chat's cost in the Usage popover: a disclosure like the Context row,
 * its source bar drawn closed and its list shown when opened. A host with a
 * cost read path passes it as the popover's `costPreview`; the popover itself
 * imports no cost code.
 */
export function UsageCostPreviewRow({
  preview,
}: {
  readonly preview: UsageCostPreview;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const segments = costSourceSegments(preview.bySource);
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={(): void => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={detailsId}
        data-testid="usage-indicator-cost"
        className={`${USAGE_DISCLOSURE_ROW_CLASS} items-center justify-between gap-3`}
      >
        <span className="whitespace-nowrap fg-primary">Cost</span>
        <span
          className={`flex items-center gap-1 whitespace-nowrap tabular-nums ${USAGE_DISCLOSURE_INK_CLASS}`}
        >
          {formatCostTotal(preview)}
          <UsageDisclosureChevron open={open} />
        </span>
      </button>
      <CostSplitBar segments={segments} label="Cost by source" size="summary" />
      {open ? (
        <div id={detailsId}>
          <CostLegend
            layout="list"
            showShare
            segments={segments}
            testId="usage-indicator-cost-breakdown"
          />
        </div>
      ) : null}
    </div>
  );
}
