'use client';

import { FormField, SettingsSelect } from '@canopy/ui-shared/components';
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
    <FormField label="Range">
      {(control) => (
        <div className="relative inline-flex">
          <SettingsSelect
            {...control}
            value={String(rangeMs)}
            onValueChange={(value) => onChange(Number(value))}
            data-testid={testId}
            options={USAGE_RANGE_OPTIONS.map((option) => ({
              value: String(option.ms),
              label: option.label,
            }))}
          />
        </div>
      )}
    </FormField>
  );
}
