import type { JSX } from 'react';
import type { SidebarSortMode } from '@canopy/desktop-shared/types';
import {
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuLabel,
} from '@canopy/ui-shared/components';
import { CheckIcon } from '@canopy/ui-shared/icons/AppIcons';
import { resolveSidebarSortMode } from '@/lib/sidebar-ordering';

/** Labels for the two ordering modes a sidebar section can be in. */
const SORT_MODE_OPTIONS: { mode: SidebarSortMode; label: string }[] = [
  { mode: 'manual', label: 'Manual order' },
  { mode: 'last-updated', label: 'Last updated' },
];

export interface SidebarSortMenuItemsProps {
  /** Current mode for the section; missing resolves to `'manual'`. */
  mode: SidebarSortMode | undefined;
  onSelect: (mode: SidebarSortMode) => void;
  /** Prefix for each item's `data-testid`, e.g. `sidebar-projects-sort`. */
  testIdPrefix: string;
  /** Heading above the choices. Defaults to "Sort by". */
  label?: string;
  /** Render a divider above the group. */
  divider?: boolean;
  /**
   * Render a divider below the group, for menus that lead with it: every
   * section and project menu puts the sort choice first, then its actions.
   */
  dividerAfter?: boolean;
}

/**
 * The "Sort by" group shared by every sidebar section menu (CAN-1074).
 *
 * `Manual order` is the default and keeps drag-and-drop for the section's
 * unpinned rows, so they stay where the user put them. `Last updated` orders
 * those rows by recency instead. Pinned rows are always manually ordered
 * regardless of the choice, so drag-and-drop is never fully retired.
 */
export function SidebarSortMenuItems({
  mode,
  onSelect,
  testIdPrefix,
  label = 'Sort by',
  divider = true,
  dividerAfter = false,
}: SidebarSortMenuItemsProps): JSX.Element {
  const resolved = resolveSidebarSortMode(mode);
  return (
    <>
      {divider && <DropdownMenuDivider />}
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      {SORT_MODE_OPTIONS.map((option) => (
        <DropdownMenuItem
          key={option.mode}
          data-testid={`${testIdPrefix}-${option.mode}`}
          aria-checked={resolved === option.mode}
          role="menuitemradio"
          onClick={(): void => onSelect(option.mode)}
        >
          <DropdownMenuItemIcon>
            {resolved === option.mode ? (
              <CheckIcon className="h-4 w-4" />
            ) : null}
          </DropdownMenuItemIcon>
          <span className="truncate">{option.label}</span>
        </DropdownMenuItem>
      ))}
      {dividerAfter && <DropdownMenuDivider />}
    </>
  );
}

/**
 * The Pin/Unpin entry moved to `@canopy/ui-shared` so the web portal's Chats
 * section offers the same entry (CAN-3053); re-exported for desktop callers.
 */
export {
  SidebarPinMenuItem,
  type SidebarPinMenuItemProps,
} from '@canopy/ui-shared/components';
