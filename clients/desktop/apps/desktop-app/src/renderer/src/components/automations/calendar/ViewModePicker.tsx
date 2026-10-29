import { type JSX } from 'react';
import type { AutomationsViewMode } from './calendarPreferences';

interface ViewModePickerProps {
  viewMode: AutomationsViewMode;
  onChange: (mode: AutomationsViewMode) => void;
}

const OPTIONS: ReadonlyArray<{ value: AutomationsViewMode; label: string }> = [
  { value: 'list', label: 'List' },
  { value: 'calendar', label: 'Calendar' },
];

/**
 * List | Calendar segmented control. Styled like the page's `TabButton` family
 * (sky highlight for the active option), but rendered as a compact pill group.
 */
export function ViewModePicker({
  viewMode,
  onChange,
}: ViewModePickerProps): JSX.Element {
  return (
    <div
      role="group"
      aria-label="View mode"
      className="inline-flex items-center gap-0.5 rounded-md border p-0.5"
    >
      {OPTIONS.map((option) => {
        const active = option.value === viewMode;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            data-testid={`automations-viewmode-${option.value}`}
            onClick={(): void => onChange(option.value)}
            className={`focus-ring rounded px-3 py-1 text-xs font-medium transition ${
              active
                ? 'bg-info-subtle fg-info'
                : 'fg-secondary hover:fg-primary'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
