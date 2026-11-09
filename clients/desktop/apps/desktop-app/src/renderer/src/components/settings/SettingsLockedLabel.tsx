import type { JSX } from 'react';
import { Badge } from '@canopy/ui-shared/components';
import { Lock } from '@canopy/ui-shared/icons/AppIcons';

/**
 * A settings row's label with the inline lock beside it when an organization
 * policy, not the member, sets the row's value ("Turned off by Acme",
 * "Required by Acme"). Shared by every locked row on the Privacy page (Usage
 * data and Activity sharing), so the reason is visible without hovering and
 * reads the same wherever it appears. The label and badge share one line and
 * wrap together on a narrow column.
 */
export function SettingsLockedLabel({
  label,
  reason,
  dataTestId,
}: {
  readonly label: string;
  readonly reason: string | null;
  readonly dataTestId?: string;
}): JSX.Element {
  if (!reason) {
    return <>{label}</>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{label}</span>
      <Badge icon={Lock} muted data-testid={dataTestId}>
        {reason}
      </Badge>
    </span>
  );
}
