import { type JSX, useMemo } from 'react';
import {
  entryHasInstalledStatus,
  installedEntryStatusState,
  InstalledItemStatusRow,
  type UnifiedPluginEntry,
} from '@canopy/ui-shared';
import { useDesktopInstalledItemStatuses } from '@/hooks/useDesktopInstalledItemStatuses';

/**
 * The installed-item Status row for a desktop detail page (CAN-4255): status
 * picker, provider notices and Uninstall. Renders nothing for browse-only
 * entries and kinds without an installed status.
 */
export function InstalledEntryStatusSection({
  entry,
  onUninstalled,
  headerOwnsRemoval = false,
  onManageSource,
}: {
  /** Opens the marketplace that owns this item. */
  onManageSource?: () => void;
  entry: Pick<UnifiedPluginEntry, 'state' | 'ref' | 'name' | 'integration'>;
  /** Leaves the detail once the item is gone. */
  onUninstalled: () => void;
  /**
   * The detail's header ⋯ already removes the item (a skill's Delete or
   * Remove), so Status offers no second ⋯ with its own Uninstall.
   */
  headerOwnsRemoval?: boolean;
}): JSX.Element | null {
  const enabled = entryHasInstalledStatus({ ...entry, state: 'installed' });
  const controller = useDesktopInstalledItemStatuses(enabled);
  const state = useMemo(
    () =>
      enabled
        ? installedEntryStatusState(
            entry.ref,
            controller.state,
            entry.integration?.connections,
          )
        : null,
    [enabled, entry.ref, entry.integration, controller.state],
  );
  if (!state || !entryHasInstalledStatus(entry, controller.state)) return null;
  return (
    <InstalledItemStatusRow
      itemName={entry.name}
      state={state}
      pendingKeys={controller.pendingKeys}
      onSetStatus={controller.setStatus}
      onUninstall={headerOwnsRemoval ? undefined : controller.uninstall}
      onUninstalled={onUninstalled}
      onManageSource={onManageSource}
      testId="plugins-entry-detail-status"
    />
  );
}
