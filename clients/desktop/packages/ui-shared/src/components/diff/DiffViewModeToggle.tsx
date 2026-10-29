import type { JSX } from 'react';
import { DiffToggle } from './DiffToggle';

/**
 * Supported diff view modes. Mirrors the desktop `ViewMode` union but is
 * intentionally portable so the web portal can use it directly.
 */
export type DiffViewMode = 'unified' | 'split';

export interface DiffViewModeToggleProps {
  /** Currently selected view mode. */
  value: DiffViewMode;
  /** Callback fired when the user picks a different mode. */
  onChange: (next: DiffViewMode) => void;
  /** Optional override for the wrapper class. */
  className?: string;
  /** Test ID hook for automation. */
  dataTestId?: string;
}

const MODES: { value: DiffViewMode; label: string }[] = [
  { value: 'unified', label: 'Unified' },
  { value: 'split', label: 'Split' },
];

/**
 * Pill-shaped two-button toggle for switching between unified and split diff
 * view modes. Pure display: parent owns the dispatch.
 */
export function DiffViewModeToggle({
  value,
  onChange,
  className,
  dataTestId,
}: DiffViewModeToggleProps): JSX.Element {
  return (
    <DiffToggle
      value={value}
      onChange={onChange}
      options={MODES}
      className={className}
      dataTestId={dataTestId}
    />
  );
}
