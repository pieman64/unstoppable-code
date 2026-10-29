import type { JSX } from 'react';

/** Shared pill geometry for independent diff comparison and layout choices. */
export interface DiffToggleProps<Value extends string> {
  value: Value;
  onChange: (next: Value) => void;
  options: ReadonlyArray<{ value: Value; label: string }>;
  className?: string;
  dataTestId?: string;
}

export function DiffToggle<Value extends string>({
  value,
  onChange,
  options,
  className,
  dataTestId,
}: DiffToggleProps<Value>): JSX.Element {
  return (
    <div
      className={
        className ??
        'flex overflow-hidden rounded-md ring-[length:var(--border-hairline)] ring-line-base'
      }
      data-testid={dataTestId}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          data-testid={dataTestId ? `${dataTestId}-${option.value}` : undefined}
          aria-pressed={value === option.value}
          onClick={(): void => onChange(option.value)}
          className={`whitespace-nowrap px-2.5 py-1 text-2xs transition-colors ${
            value === option.value
              ? 'bg-accent-subtle fg-accent'
              : 'fg-secondary hover:fg-primary'
          } ${index > 0 ? 'border-l' : ''}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
