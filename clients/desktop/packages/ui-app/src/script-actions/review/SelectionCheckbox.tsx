'use client';

import { useEffect, useRef, type JSX } from 'react';
import { Checkbox } from '@canopy/ui-shared/components';
import type { SelectAllState } from './review-model';

export interface SelectionCheckboxProps {
  readonly state: SelectAllState;
  readonly label: string;
  readonly disabled?: boolean;
  readonly onToggle: () => void;
  readonly testId?: string;
}

/**
 * The shared `Checkbox` with a native mixed state for select-all controls.
 * `indeterminate` is a DOM property, so it is set on the input itself, which
 * exposes "mixed" to assistive technology; a dash draws the state.
 */
export function SelectionCheckbox({
  state,
  label,
  disabled = false,
  onToggle,
  testId,
}: SelectionCheckboxProps): JSX.Element {
  const ref = useRef<HTMLInputElement | null>(null);
  const mixed = state === 'some';
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <span className="relative inline-flex">
      <Checkbox
        ref={ref}
        checked={state === 'all'}
        disabled={disabled}
        aria-label={label}
        onChange={onToggle}
        data-testid={testId}
      />
      {mixed ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-1 right-1 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-fg-primary"
        />
      ) : null}
    </span>
  );
}
