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
  const destinations = groups
    .filter((group) => group.id !== current?.id)
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
