import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import {
  ChevronDownMediumIcon,
  ChevronTopMediumIcon,
  FolderIcon,
  FolderPlusIcon,
  MinusIcon,
  SettingsIcon,
} from '../icons/AppIcons';
import type { WorktreeMenuItem } from './WorktreeActionsMenu';
import {
  sidebarItemGroupColor,
  type SidebarItemGroupUnitLabel,
} from './SidebarItemGroup';

/** One Move-to row per group, skipping the one the rows are already in. */
function groupDestinations(
  groups: readonly SidebarItemGroup[],
  excludeId: string | undefined,
  onMove: (groupId: string) => void,
): WorktreeMenuItem[] {
  return groups
    .filter((group) => group.id !== excludeId)
    .map(
      (group): WorktreeMenuItem => ({
        key: `sidebar-group-${group.id}`,
        label: group.name,
        icon: (
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: sidebarItemGroupColor(group.color) }}
          />
        ),
        onSelect: (): void => onMove(group.id),
      }),
    );
}

/** Hosts insert this one organizing entry immediately after their Pin action. */
export function sidebarItemGroupRowMenu({
  groups,
  currentGroupId,
  eligible,
  onNewGroup,
  onMove,
  onEdit,
  onToggle,
  onRemove,
}: {
  groups: readonly SidebarItemGroup[];
  currentGroupId?: string;
  unitLabel: SidebarItemGroupUnitLabel;
  /** False for pinned/hidden rows, stack children, placeholders and pinned copies. */
  eligible: boolean;
  onNewGroup: () => void;
  onMove: (groupId: string) => void;
  onEdit: (groupId: string) => void;
  onToggle: (groupId: string) => void;
  onRemove: () => void;
}): WorktreeMenuItem[] {
  if (!eligible) return [];
  const current = groups.find((group) => group.id === currentGroupId);
  const create: WorktreeMenuItem = {
    key: 'sidebar-group-new',
    label: 'New group',
    icon: <FolderPlusIcon />,
    onSelect: onNewGroup,
  };
  const destinations = groupDestinations(groups, current?.id, onMove);
  if (!current && groups.length === 0)
    return [{ ...create, label: 'Add to new group' }];
  const submenu: WorktreeMenuItem[] = current
    ? [
        {
          key: 'sidebar-group-label',
          kind: 'label',
          label: current.name,
          icon: null,
        },
        {
          key: 'sidebar-group-edit',
          label: 'Edit group…',
          icon: <SettingsIcon />,
          onSelect: (): void => onEdit(current.id),
        },
        {
          key: 'sidebar-group-toggle',
          label: current.collapsed ? 'Expand group' : 'Collapse group',
          icon: current.collapsed ? (
            <ChevronDownMediumIcon />
          ) : (
            <ChevronTopMediumIcon />
          ),
          onSelect: (): void => onToggle(current.id),
        },
        {
          key: 'sidebar-group-remove',
          label: 'Remove from group',
          icon: <MinusIcon />,
          onSelect: onRemove,
        },
        {
          key: 'sidebar-group-move-label',
          kind: 'label',
          label: 'Move to',
          icon: null,
          separatorBefore: true,
        },
        ...destinations,
        create,
      ]
    : [
        create,
        ...destinations.map((item, index) => ({
          ...item,
          separatorBefore: index === 0,
        })),
      ];
  return [
    {
      key: 'sidebar-group-organize',
      kind: 'submenu',
      label: current ? 'Group' : 'Add to group',
      icon: current ? (
        <span
          aria-hidden="true"
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: sidebarItemGroupColor(current.color) }}
        />
      ) : (
        <FolderIcon />
      ),
      submenu,
    },
  ];
}

/**
 * A selection's group entry: moves every movable selected row together. Only
 * the moves apply to many rows; Edit and Collapse act on one group and stay
 * on the single row's menu. Keeps the single row's `sidebar-group-organize`
 * key so its trigger and flyout carry the same test ids.
 */
export function sidebarItemGroupBulkMenu({
  groups,
  currentGroupIds,
  onNewGroup,
  onMove,
  onRemove,
}: {
  groups: readonly SidebarItemGroup[];
  /** Each movable selected row's group, `undefined` when ungrouped. */
  currentGroupIds: readonly (string | undefined)[];
  onNewGroup: () => void;
  onMove: (groupId: string) => void;
  onRemove: () => void;
}): WorktreeMenuItem[] {
  if (currentGroupIds.length === 0) return [];
  const [first] = currentGroupIds;
  // Rows that already share a group don't list it as a destination.
  const shared =
    first !== undefined && currentGroupIds.every((id) => id === first)
      ? first
      : undefined;
  const anyGrouped = currentGroupIds.some((id) => id !== undefined);
  const create: WorktreeMenuItem = {
    key: 'sidebar-group-new',
    label: 'New group',
    icon: <FolderPlusIcon />,
    onSelect: onNewGroup,
  };
  if (groups.length === 0 && !anyGrouped) {
    return [{ ...create, label: 'Add to new group' }];
  }
  const destinations = groupDestinations(groups, shared, onMove).map(
    (item, index) => ({ ...item, separatorBefore: index === 0 }),
  );
  const remove: WorktreeMenuItem = {
    key: 'sidebar-group-remove',
    label: 'Remove from group',
    icon: <MinusIcon />,
    onSelect: onRemove,
    separatorBefore: true,
  };
  return [
    {
      key: 'sidebar-group-organize',
      kind: 'submenu',
      label: 'Move to group',
      icon: <FolderIcon />,
      submenu: [create, ...destinations, ...(anyGrouped ? [remove] : [])],
    },
  ];
}
