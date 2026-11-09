import type { JSX, ReactNode } from 'react';
import { Button, Surface } from '@canopy/ui-shared/components';
import { DeviceBackendIcon } from '@canopy/ui-shared/icons';

export interface RemoteControlComputerNoticeAction {
  readonly label: string;
  readonly onSelect: () => void;
  readonly testId?: string;
}

export interface RemoteControlComputerNoticeProps {
  readonly title: string;
  readonly body?: ReactNode;
  readonly action?: RemoteControlComputerNoticeAction;
  /** Which state this is, for tests and captures (`offline`, `upgrade`...). */
  readonly state: string;
  readonly testId?: string;
}

/**
 * Why the computer this device controls is not on screen right now, and the
 * one action that helps (offline, too old, pair again, plan). Hosts derive
 * the state from their own transport and pass its copy; the notice draws it
 * the same way everywhere. Sized for a sidebar footer: it explains missing
 * rows without competing with them.
 */
export function RemoteControlComputerNotice({
  title,
  body,
  action,
  state,
  testId = 'remote-control-computer-notice',
}: RemoteControlComputerNoticeProps): JSX.Element {
  return (
    <Surface
      data-testid={testId}
      data-state={state}
      variant="group"
      size="small"
      padding="compact"
      gap="inline"
      role="status"
    >
      <div className="flex items-start gap-2">
        <DeviceBackendIcon className="mt-0.5 shrink-0 fg-secondary" />
        <span className="min-w-0 flex-1 text-s font-medium text-pretty fg-primary">
          {title}
        </span>
      </div>
      {body === undefined ? null : (
        <p className="text-xs text-pretty fg-secondary">{body}</p>
      )}
      {action ? (
        <Button
          variant="primary"
          size="compact"
          onClick={action.onSelect}
          data-testid={action.testId ?? `${testId}-action`}
          className="w-full"
        >
          {action.label}
        </Button>
      ) : null}
    </Surface>
  );
}
