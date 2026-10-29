import { type ChangeEvent, type JSX } from 'react';
import type { EnvironmentDefinition } from '@canopy/desktop-shared/types';

export interface EnvironmentRuntimeSelectOption {
  /**
   * Stable id stored in the underlying assignment. Use `null` for the
   * "global default" sentinel (workspace surfaces) so the parent can omit
   * the runtime key from the saved assignment.
   */
  id: string | null;
  label: string;
}

interface EnvironmentRuntimeSelectProps {
  /** All environments the user can pick from. Already in display order. */
  environments: ReadonlyArray<EnvironmentDefinition>;
  /** Optional `null`-valued option appended at the top — e.g. "Global default". */
  fallbackOption?: EnvironmentRuntimeSelectOption;
  /** Currently selected id. `null` selects the fallback (when provided). */
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
  testId?: string;
  ariaLabel?: string;
}

const FALLBACK_VALUE = '__fallback__';

/**
 * Generic environment selector used by both the global runtime defaults
 * widget in Settings → Environments and the workspace Environment tab. The
 * `fallbackOption` keeps the workspace surface from inventing a sentinel
 * id — `null` cleanly maps to "remove this key from the assignment."
 */
export function EnvironmentRuntimeSelect({
  environments,
  fallbackOption,
  value,
  onChange,
  disabled,
  testId,
  ariaLabel,
}: EnvironmentRuntimeSelectProps): JSX.Element {
  const selected =
    value === null && fallbackOption ? FALLBACK_VALUE : (value ?? '');

  const handleChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = event.target.value;
    if (next === FALLBACK_VALUE) {
      onChange(null);
      return;
    }
    onChange(next.length > 0 ? next : null);
  };

  return (
    <select
      value={selected}
      onChange={handleChange}
      disabled={disabled === true}
      aria-label={ariaLabel}
      data-testid={testId}
      className="focus-ring w-full rounded-md border bg-base px-2 py-1.5 text-s fg-primary disabled:cursor-not-allowed disabled:opacity-50"
    >
      {fallbackOption && (
        <option value={FALLBACK_VALUE}>{fallbackOption.label}</option>
      )}
      {environments.map((environment) => (
        <option key={environment.id} value={environment.id}>
          {environment.name}
          {environment.isDefault ? ' (default)' : ''}
        </option>
      ))}
    </select>
  );
}
