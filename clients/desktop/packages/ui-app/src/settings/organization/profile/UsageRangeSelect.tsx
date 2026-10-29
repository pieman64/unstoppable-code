'use client';
import { SettingsControlSelect } from '@canopy/ui-shared/components';

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
        <SettingsControlSelect
          value={String(rangeMs)}
          onChange={(event) => onChange(Number(event.target.value))}
          data-testid={testId}
          fill
        >
          {USAGE_RANGE_OPTIONS.map((option) => (
            <option key={option.ms} value={String(option.ms)}>
              {option.label}
            </option>
          ))}
        </SettingsControlSelect>
      </div>
    </label>
  );
}
