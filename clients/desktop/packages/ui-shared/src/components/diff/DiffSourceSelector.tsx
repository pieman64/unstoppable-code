import type { JSX } from 'react';

/**
 * Diff source selection — which set of changes the diff viewer is currently
 * rendering. Mirrors the desktop `FileDiffSource` union but kept portable so
 * both apps can drive it from the same component.
 */
export type DiffSource = 'uncommitted' | 'committed' | 'combined';

export interface DiffSourceSelectorOption {
  value: DiffSource;
  label: string;
}

export interface DiffSourceSelectorProps {
  /** Currently selected source. */
  value: DiffSource;
  /** Callback fired when the user picks a different source. */
  onChange: (next: DiffSource) => void;
  /** Optional override of the available options. Defaults to all three. */
  options?: DiffSourceSelectorOption[];
  /** Optional override for the wrapper class. */
  className?: string;
  /** Test ID hook for automation. */
  dataTestId?: string;
}

const DEFAULT_OPTIONS: DiffSourceSelectorOption[] = [
  { value: 'uncommitted', label: 'Uncommitted' },
  { value: 'committed', label: 'Committed' },
  { value: 'combined', label: 'Combined' },
];

/**
 * Segmented control for choosing which diff source the viewer should render.
 * Pure display; caller owns dispatch and option list.
 */
export function DiffSourceSelector({
  value,
  onChange,
  options,
  className,
  dataTestId,
}: DiffSourceSelectorProps): JSX.Element {
  const resolved = options ?? DEFAULT_OPTIONS;
  const wrapperClass = className ?? 'flex overflow-hidden rounded-md border';
  return (
    <div className={wrapperClass} data-testid={dataTestId}>
      {resolved.map((opt, index) => {
        const selected = value === opt.value;
        const dividerClass = index > 0 ? 'border-l' : '';
        const stateClass = selected
          ? 'bg-accent-subtle fg-accent'
          : 'fg-secondary hover:fg-primary';
        return (
          <button
            key={opt.value}
            type="button"
            data-testid={dataTestId ? `${dataTestId}-${opt.value}` : undefined}
            aria-pressed={selected}
            onClick={(): void => onChange(opt.value)}
            className={`px-2.5 py-1 text-2xs transition-colors ${stateClass} ${dividerClass}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
