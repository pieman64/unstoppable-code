import type { ActionMenuItem } from '@canopy/ui-shared/components';
import {
  BuildingIcon,
  DownloadIcon,
  PinIcon,
  SettingsIcon,
  ShareIcon,
} from '@canopy/ui-shared/icons/AppIcons';

type CoworkProjectMenuKey =
  | 'toggle-pin'
  | 'settings'
  | 'share-template'
  | 'import-session'
  | 'move-to-organization';

/**
 * The Cowork project row's command rows: Pin first, as on every sidebar row
 * menu, then the project's own commands. The host closes the menu and hands
 * focus back before running the picked command.
 */
export function coworkProjectMenuItems({
  pinned,
  onTogglePin,
  onOpenSettings,
  onShareTemplate,
  onImportSession,
  onMoveToOrganization,
}: {
  pinned: boolean;
  onTogglePin: (pinned: boolean) => void;
  onOpenSettings: () => void;
  onShareTemplate: () => void;
  onImportSession: () => void;
  onMoveToOrganization?: () => void;
}): ActionMenuItem<CoworkProjectMenuKey>[] {
  const items: ActionMenuItem<CoworkProjectMenuKey>[] = [
    {
      key: 'toggle-pin',
      label: pinned ? 'Unpin' : 'Pin to top',
      icon: <PinIcon />,
      onSelect: (): void => onTogglePin(!pinned),
      testId: 'workspace-toggle-pin-menu-item',
    },
    {
      key: 'settings',
      label: 'Project settings',
      icon: <SettingsIcon />,
      onSelect: onOpenSettings,
      testId: 'workspace-settings-menu-item',
    },
    {
      key: 'share-template',
      label: 'Share template',
      icon: <ShareIcon />,
      onSelect: onShareTemplate,
      testId: 'workspace-share-template-menu-item',
    },
    {
      key: 'import-session',
      label: 'Import session…',
      icon: <DownloadIcon />,
      onSelect: onImportSession,
      testId: 'workspace-import-session-menu-item',
    },
  ];
  if (onMoveToOrganization) {
    items.push({
      key: 'move-to-organization',
      label: 'Move to org…',
      icon: <BuildingIcon size="xl" />,
      onSelect: onMoveToOrganization,
      testId: 'workspace-move-to-organization-menu-item',
    });
  }
  return items;
}
