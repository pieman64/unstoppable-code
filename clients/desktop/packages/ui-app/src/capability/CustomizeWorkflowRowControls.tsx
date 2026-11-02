import type { JSX } from 'react';
import {
  TableActionButton,
  ToggleSwitch,
  Tooltip,
} from '@canopy/ui-shared/components';
import { PlayIcon } from '@canopy/ui-shared/icons/AppIcons';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib';
import type { CustomizeWorkflowAvailability } from './customizeWorkflowActions';

export interface CustomizeWorkflowRowControlsProps {
  readonly entry: UnifiedPluginEntry;
  readonly availability: CustomizeWorkflowAvailability;
  /** An action on this row is in flight; every control is disabled. */
  readonly busy: boolean;
  readonly onRun: () => void;
  readonly onToggle: () => void;
}

/**
 * A Customize Workflows row's inline control (CAN-4845): an automation's
 * on/off switch or a pipeline's Run, in the aligned status slot.
 */
export function CustomizeWorkflowRowControls({
  entry,
  availability,
  busy,
  onRun,
  onToggle,
}: CustomizeWorkflowRowControlsProps): JSX.Element | null {
  const enabled = entry.workflow?.enabled;
  let control: JSX.Element | null = null;
  if (entry.kind === 'automation' && enabled !== undefined) {
    control = (
      // The accessible name says the state; the tooltip says what a press does.
      <Tooltip
        label={
          availability.toggle.available
            ? enabled
              ? 'Turn off'
              : 'Turn on'
            : (availability.toggle.reason ?? '')
        }
      >
        <ToggleSwitch
          checked={enabled}
          disabled={busy || !availability.toggle.available}
          label={`${entry.name} is ${enabled ? 'on' : 'off'}`}
          dataTestId={`customize-workflow-toggle-${entry.id}`}
          size="sm"
          onChange={onToggle}
        />
      </Tooltip>
    );
  } else if (entry.kind === 'pipeline' && entry.workflow !== undefined) {
    control = (
      <TableActionButton
        label={
          availability.run.available
            ? `Run ${entry.name}`
            : (availability.run.reason ?? `Run ${entry.name}`)
        }
        disabled={busy || !availability.run.available}
        testId={`customize-workflow-run-${entry.id}`}
        onClick={onRun}
      >
        <PlayIcon width={14} height={14} aria-hidden="true" />
      </TableActionButton>
    );
  }
  if (control === null) return null;
  return (
    <span
      data-testid="customize-row-status-slot"
      className="flex w-36 shrink-0 justify-end"
    >
      {control}
    </span>
  );
}
