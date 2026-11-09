import type { JSX } from 'react';
import { BackIcon } from '../../icons/AppIcons';
import { SidebarNavRow } from '../SidebarNavRow';

export interface SettingsBackButtonProps {
  /** Names the list it returns to, such as "Environments". */
  readonly label: string;
  readonly onClick: () => void;
  readonly dataTestId?: string;
}

/**
 * The way back from a drill-in Settings page (one item of a list) to its
 * list, on its own line above the page title and named for the list. It is
 * the Settings rail's Back row (`SidebarNavRow`, secondary tone): no fill at
 * rest, the hover fill only, as wide as its label. It hangs into the page
 * margin by the row's 8px inset, so the arrow's left edge lines up with the
 * title's.
 */
export function SettingsBackButton({
  label,
  onClick,
  dataTestId,
}: SettingsBackButtonProps): JSX.Element {
  return (
    <div className="-ml-2 flex w-fit">
      <SidebarNavRow
        onClick={onClick}
        data-testid={dataTestId}
        className="text-left"
        tone="secondary"
        icon={<BackIcon size={16} />}
      >
        {label}
      </SidebarNavRow>
    </div>
  );
}
