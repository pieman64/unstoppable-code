'use client';

import { SettingsSelect } from '@canopy/ui-shared/components';
import { type JSX } from 'react';
import { USAGE_RANGE_OPTIONS } from './useMemberUsage';

interface UsageRangeSelectProps {
  rangeMs: number;
  onChange: (ms: number) => void;
  testId?: string;
}

/** Range dropdown shared by the gated profile usage sections. */
export function UsageRangeSelect({
  rangeMs,
  onChange,
  testId,
}: UsageRangeSelectProps): JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium fg-secondary">
      Range
      <div className="relative inline-flex">
        <SettingsSelect
          value={String(rangeMs)}
          onValueChange={(value) => onChange(Number(value))}
          data-testid={testId}
          options={USAGE_RANGE_OPTIONS.map((option) => ({
            value: String(option.ms),
            label: option.label,
          }))}
        />
      </div>
    </label>
  );
}
