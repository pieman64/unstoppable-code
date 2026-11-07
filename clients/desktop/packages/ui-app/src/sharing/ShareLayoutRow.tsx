import type { JSX } from 'react';
import { Button, ToggleSwitch } from '@canopy/ui-shared/components';
import { Surface } from '@canopy/ui-shared/components';

export interface ShareLayoutRowProps {
  /** Whether receivers open to the publisher's layout. */
  enabled: boolean;
  /** A save is in flight: the switch and the action are disabled. */
  saving: boolean;
  /** The row's label, and the switch's accessible name. */
  label: string;
  /**
   * Label of the "update the saved layout" action. Omitted when there is no
   * saved layout to update, which hides the action.
   */
  updateLabel?: string;
  onToggle: (next: boolean) => void;
  onUpdate: () => void;
  /** Test id for the row. The switch and action derive theirs from it. */
  testId?: string;
}

/**
 * The share dialog's "open to my layout" row: a switch, and the action that
 * replaces the saved layout with the layout on screen.
 *
 * Pure display. The host owns the copy and the save, so this row never
 * decides what a layout is or when it was saved.
 */
export function ShareLayoutRow({
  enabled,
  saving,
  label,
  updateLabel,
  onToggle,
  onUpdate,
  testId,
}: ShareLayoutRowProps): JSX.Element {
  const childTestId = (suffix: string): string | undefined =>
    testId ? `${testId}-${suffix}` : undefined;
  return (
    <Surface variant="outline" data-testid={testId}>
      <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs fg-secondary">
        <span className="fg-primary">{label}</span>
        <div className="flex items-center gap-3">
          {enabled && updateLabel !== undefined && (
            <Button
              variant="link"
              disabled={saving}
              onClick={onUpdate}
              data-testid={childTestId('update')}
            >
              {updateLabel}
            </Button>
          )}
          <ToggleSwitch
            checked={enabled}
            disabled={saving}
            label={label}
            onChange={onToggle}
            size="sm"
            dataTestId={childTestId('switch')}
          />
        </div>
      </div>
    </Surface>
  );
}
